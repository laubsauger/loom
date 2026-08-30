import { describe, expect, it } from "vitest";

import { compileGraph } from "./index.ts";
import { pointsPreviewResourceId } from "./resources.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import type { DrawPassDescriptor } from "../runtime/backend/plan.ts";

/**
 * T373 (§V85): a node whose output is a POINTSET previews as its own splat.
 *
 * The user's report, three times over: `torus1` (and `swarm1`, and every other point
 * generator) showed an empty body while the renderer downstream showed the shape. The
 * fix is keyed on the port KIND in one place — the compiler synthesizes the splat pass
 * for any watched pointset output — so every present and future point producer is
 * covered by construction (§V316, §V319), and OFF stays free because the synthesis is
 * gated on the same preview-sink set that gates texture materialization (§V297, §V309).
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

const previewPassFor = (passes: ReadonlyArray<unknown>, nodeId: string): DrawPassDescriptor | undefined =>
  passes.find(
    (pass): pass is DrawPassDescriptor =>
      (pass as { id?: string }).id === `${nodeId}#pointsPreview:out`,
  );

describe("a watched point generator previews as its own splat (T373, §V85)", () => {
  it("synthesizes one square target and one draw pass reading the position pair", () => {
    const compiled = compileWithSinks(graphOf([{ id: "torus", type: "pointTorus" }]), [
      { nodeId: "torus", portId: "out" },
    ]);
    expect(compiled.ok).toBe(true);

    const target = compiled.resources.find((resource) => resource.id === pointsPreviewResourceId("torus", "out"));
    expect(target).toBeDefined();
    expect(target?.kind).toBe("target");
    // Square, sized from the project's preview edge — the tile's own framing (§V85),
    // never the downstream renderer's.
    expect((target as unknown as { size: [number, number] }).size).toEqual([192, 192]);
    expect((target as unknown as { format: string }).format).toBe("rgba8unorm");

    const pass = previewPassFor(compiled.passes, "torus");
    expect(pass).toBeDefined();
    expect(pass?.kind).toBe("draw");
    expect(pass?.target).toBe(pointsPreviewResourceId("torus", "out"));
    // The producer's own position pair, the half holding THIS frame's data (§V168).
    const capacityResource = compiled.resources.find(
      (resource) => resource.kind === "bufferPair" && resource.id === pass?.buffers?.[0]?.resourceId,
    ) as { capacity?: number } | undefined;
    expect(capacityResource).toBeDefined();
    expect(pass?.buffers?.[0]?.half).toBe("write");
    // Uncounted set: a literal instance count equal to the pair's capacity.
    expect(pass?.instances).toBe(capacityResource?.capacity);
    // The camera is a VALUE on the pass (§V5) — T379's viewer camera drives it later
    // without a structure change.
    expect(Array.isArray(pass?.uniforms?.["viewProjection"])).toBe(true);

    // The outputs projection now carries a bindable TARGET for the pointset port, which
    // is what the preview system's request path reads.
    const output = compiled.outputs.find((entry) => entry.nodeId === "torus" && entry.portId === "out");
    expect(output?.resourceKind).toBe("target");
    expect(output?.resourceId).toBe(pointsPreviewResourceId("torus", "out"));
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
    // half-made preview target.
    const output = compiled.outputs.find((entry) => entry.nodeId === "torus");
    expect(output?.resourceKind ?? "pointset").toBe("pointset");
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
      expect(compiled.resources.some((resource) => resource.id === pointsPreviewResourceId(nodeId, "out"))).toBe(true);
      const pass = previewPassFor(compiled.passes, nodeId);
      expect(pass?.buffers?.[0]?.resourceId).toContain(`:${nodeId}:`);
    }
  });

  it("a COUNTED pointset gets the count-gated shader, so dead capacity never splats", () => {
    const compiled = compileWithSinks(graphOf([{ id: "sim", type: "pointKernelAdvanced" }]), [
      { nodeId: "sim", portId: "out" },
    ]);
    expect(compiled.ok).toBe(true);
    const pass = previewPassFor(compiled.passes, "sim");
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
    const pass = previewPassFor(compiled.passes, "torus");
    expect(pass?.shader).not.toContain("counts");
  });
});

describe("every pointset-producing definition is covered by construction (§V316, §V319)", () => {
  it("each registry definition with a pointset output synthesizes a preview when watched", () => {
    const producers = registry
      .list()
      .filter((definition) => definition.outputs.some((port) => port.type.kind === "pointset"));
    // Non-vacuity: the catalogue really has point producers.
    expect(producers.length).toBeGreaterThan(5);

    for (const definition of producers) {
      const portId = definition.outputs.find((port) => port.type.kind === "pointset")?.id as string;
      const compiled = compileWithSinks(graphOf([{ id: "n1", type: definition.type }]), [
        { nodeId: "n1", portId },
      ]);
      const pass = compiled.passes.find((entry) => entry.id === `n1#pointsPreview:${portId}`);
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
