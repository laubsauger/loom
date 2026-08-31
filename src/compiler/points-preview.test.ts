import { describe, expect, it } from "vitest";

import { compileGraph } from "./index.ts";
import { pointsPreviewResourceId } from "./resources.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import type { DrawPassDescriptor } from "../runtime/backend/plan.ts";
import type { ResolvedOutput } from "./types.ts";

/**
 * T373 (§V85): a node whose output is a POINTSET previews as its own splat.
 *
 * The user's report, three times over: `torus1` (and `swarm1`, and every other point
 * generator) showed an empty body while the renderer downstream showed the shape. The
 * fix is keyed on the port KIND in one place — the compiler synthesizes the splat pass
 * for any watched pointset output — so every present and future point producer is
 * covered by construction (§V316, §V319), and OFF stays free because the synthesis is
 * gated on the same preview-sink set that gates texture materialization (§V297, §V309).
 *
 * T563 moved the synthesis OUT of the main plan: the draw pass now travels on the
 * output row's `synthesis` field, and the PREVIEW PROGRAM owns the target it renders
 * into — sized to the granted tile, rebuilt outside the frame, refreshed on the preview
 * cadence whether or not the transport runs. The main plan carries neither the pass nor
 * the target, and these tests assert that absence as hard as they assert the presence.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

function graphOf(nodes: Array<{ id: string; type: string }>): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(
      nodes.map((node) => [
        node.id,
        { id: node.id, type: node.type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      ]),
    ),
    edges: {},
    groups: {},
  } as never;
}

function compileWithSinks(graph: GraphDocument, sinks: Array<{ nodeId: string; portId: string }>) {
  return compileGraph({
    graph,
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
    sinks: sinks.map((sink) => ({ ...sink, kind: "preview" as const })),
  } as never);
}

const outputFor = (
  outputs: ReadonlyArray<ResolvedOutput>,
  nodeId: string,
  portId = "out",
): ResolvedOutput | undefined =>
  outputs.find((entry) => entry.nodeId === nodeId && entry.portId === portId);

const previewPassFor = (
  outputs: ReadonlyArray<ResolvedOutput>,
  nodeId: string,
  portId = "out",
): DrawPassDescriptor | undefined =>
  outputFor(outputs, nodeId, portId)?.synthesis?.passes.find(
    (pass) => pass.id === `${nodeId}#pointsPreview:${portId}`,
  );

describe("a watched point generator previews as its own splat (T373, §V85, T563)", () => {
  it("synthesizes one draw pass on the OUTPUT ROW, and nothing in the main plan", () => {
    const compiled = compileWithSinks(graphOf([{ id: "torus", type: "pointTorus" }]), [
      { nodeId: "torus", portId: "out" },
    ]);
    expect(compiled.ok).toBe(true);

    // T563 — the absence half, asserted as hard as the presence: the splat's target and
    // pass do NOT live in the main plan. The measured T502 failure (E16 at 4× zoom,
    // paused: preview black until playback resumed) was exactly this pass living where
    // the transport gates execution.
    expect(compiled.resources.some((resource) => resource.id === pointsPreviewResourceId("torus", "out"))).toBe(false);
    expect(compiled.passes.some((pass) => pass.id.includes("#pointsPreview"))).toBe(false);

    // The outputs projection carries a bindable TARGET row for the pointset port — the
    // id the preview program will create at the granted tile size — plus the synthesis.
    const output = outputFor(compiled.outputs, "torus");
    expect(output?.resourceKind).toBe("target");
    expect(output?.resourceId).toBe(pointsPreviewResourceId("torus", "out"));
    // The NOMINAL size the request path reads for aspect; the real edge is the tile's.
    // Square HERE because this fixture's project is 64x64 — T663 makes the short edge the
    // project's, and `preview-resolution.test.ts` is where that relationship is pinned.
    expect(output?.size).toEqual([384, 384]);
    expect(output?.format).toBe("rgba8unorm");
    expect(output?.synthesis?.depth).toBe(false);

    const pass = previewPassFor(compiled.outputs, "torus");
    expect(pass).toBeDefined();
    expect(pass?.kind).toBe("draw");
    expect(pass?.target).toBe(pointsPreviewResourceId("torus", "out"));
    // The producer's own position pair — bound on the READ half: the preview program
    // runs BETWEEN main frames, after the swap landed the latest state there (T563;
    // §V168's this-frame half governs in-plan consumers only).
    const capacityResource = compiled.resources.find(
      (resource) => resource.kind === "bufferPair" && resource.id === pass?.buffers?.[0]?.resourceId,
    ) as { capacity?: number } | undefined;
    expect(capacityResource).toBeDefined();
    expect(pass?.buffers?.[0]?.half).toBe("read");
    // Uncounted set: a literal instance count equal to the pair's capacity.
    expect(pass?.instances).toBe(capacityResource?.capacity);
    // The camera is a VALUE on the pass (§V5) — T379's viewer camera drives it later
    // without a structure change.
    expect(Array.isArray(pass?.uniforms?.["viewProjection"])).toBe(true);
    // T561: the stock framing's basis rides the synthesis, so the inspection orbit
    // reproduces it at identity and re-cameras exactly this pass.
    const orbit = outputFor(compiled.outputs, "torus")?.synthesis?.orbit;
    expect(orbit?.eye).toEqual([1.7, 1.2, 2.4]);
    expect(orbit?.lookAt).toEqual([0, 0, 0]);
    expect(orbit?.passIds).toEqual(["torus#pointsPreview:out"]);
  });

  it("an UNWATCHED pointset output synthesizes nothing — off costs zero (§V297, §V309)", () => {
    // Preview sink on a different node: the generator is kept alive by nothing, and even
    // with the generator watched by no sink there must be no splat.
    const graph = graphOf([
      { id: "torus", type: "pointTorus" },
      { id: "flat", type: "noise" },
    ]);
    const compiled = compileWithSinks(graph, [{ nodeId: "flat", portId: "out" }]);
    expect(compiled.resources.some((resource) => resource.id.startsWith("preview:points:"))).toBe(false);
    expect(compiled.passes.some((pass) => pass.id.includes("#pointsPreview"))).toBe(false);
    // The projection keeps the marker row (or prunes the node entirely) — never a
    // half-made preview target, and no synthesis either.
    const output = outputFor(compiled.outputs, "torus");
    expect(output?.resourceKind ?? "pointset").toBe("pointset");
    expect(output?.synthesis).toBeUndefined();
  });

  it("two watched generators get two disjoint previews (§V321)", () => {
    const compiled = compileWithSinks(
      graphOf([
        { id: "a", type: "pointTorus" },
        { id: "b", type: "pointSphere" },
      ]),
      [
        { nodeId: "a", portId: "out" },
        { nodeId: "b", portId: "out" },
      ],
    );
    expect(compiled.ok).toBe(true);
    for (const nodeId of ["a", "b"]) {
      expect(outputFor(compiled.outputs, nodeId)?.resourceId).toBe(pointsPreviewResourceId(nodeId, "out"));
      const pass = previewPassFor(compiled.outputs, nodeId);
      expect(pass?.buffers?.[0]?.resourceId).toContain(`:${nodeId}:`);
    }
  });

  it("a COUNTED pointset gets the count-gated shader, so dead capacity never splats", () => {
    const compiled = compileWithSinks(graphOf([{ id: "sim", type: "pointKernelAdvanced" }]), [
      { nodeId: "sim", portId: "out" },
    ]);
    expect(compiled.ok).toBe(true);
    const pass = previewPassFor(compiled.outputs, "sim");
    expect(pass).toBeDefined();
    // The gate is IN the shader (§V219-style degenerate collapse), driven by the live
    // count the lifecycle keeps on the GPU — no readback, no indirect-args plumbing.
    expect(pass?.shader).toContain("counts");
    expect(pass?.shader).toContain("instance >= counts[0u]");
    const countsBinding = pass?.buffers?.find((binding) => binding.binding === "counts");
    expect(countsBinding).toBeDefined();
  });

  it("an uncounted generator's shader carries NO count gate — the option is real, both ways", () => {
    const compiled = compileWithSinks(graphOf([{ id: "torus", type: "pointTorus" }]), [
      { nodeId: "torus", portId: "out" },
    ]);
    const pass = previewPassFor(compiled.outputs, "torus");
    expect(pass?.shader).not.toContain("counts");
  });
});

describe("every pointset-producing definition is covered by construction (§V316, §V319)", () => {
  it("each registry definition with a pointset output synthesizes a preview when watched", () => {
    const producers = registry
      .list()
      // T607: a PASSTHROUGH is a wire, never a producer — it splices away and its
      // preview is its producer's, via the §V130 alias. The boundary In/Out points
      // nodes are the first pointset-typed wires; a watched unfed wire compiles clean
      // and honestly shows nothing, which is not the silent-empty-body defect this
      // sweep exists to catch.
      .filter((definition) => definition.passthrough === undefined)
      .filter((definition) => definition.outputs.some((port) => port.type.kind === "pointset"));
    // Non-vacuity: the catalogue really has point producers.
    expect(producers.length).toBeGreaterThan(5);

    for (const definition of producers) {
      const portId = definition.outputs.find((port) => port.type.kind === "pointset")?.id as string;
      const compiled = compileWithSinks(graphOf([{ id: "n1", type: definition.type }]), [
        { nodeId: "n1", portId },
      ]);
      const pass = previewPassFor(compiled.outputs, "n1", portId);
      // A definition that needs an INPUT to publish its pointset cannot compile alone —
      // that is fine, but then it must have failed loudly, never compiled clean with a
      // silent empty body (§V320's cousin: absence must be an error, not a quiet miss).
      if (pass === undefined) {
        expect(
          compiled.diagnostics.some((diagnostic) => diagnostic.severity === "error"),
          `"${definition.type}" compiled clean but synthesized no preview`,
        ).toBe(true);
      }
    }
  });
});
