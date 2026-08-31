import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/compile.ts";
import { CompilerDiagnosticCode } from "../../compiler/diagnostics.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { PassDescriptor } from "../../runtime/backend/plan.ts";

/**
 * T528 — a DANGLING camera name refuses, in every renderer, in the same words.
 *
 * The bug: `renderSurface` and `renderInstances` with `camera: "nope1"` emitted
 * `error:compiler/source-reference-missing` AND STILL EMITTED THEIR PASS, drawing
 * confidently through their inline camera. `render` refused outright. Two nodes, two
 * answers to one question (§V109's shape) — and the permissive half is the dishonest one:
 * a node that reports an error and then renders something plausible teaches people to
 * ignore errors, and the picture it draws is not the picture they asked for (§V147's
 * family). §V288 says the same thing about a map a consumer cannot honour: name it, do
 * not silently use the static.
 *
 * ## The rule, and the case it must NOT break
 *
 * "Refuse whenever no camera arrived" would blank every inline-framed Render Surface in
 * the catalogue. So the rule splits on whether a NAME WAS GIVEN — see
 * `camera-reference.ts`. Both halves are gated here: the dangling name refuses, and the
 * un-named node still draws.
 *
 * ## Enumerated, not listed (§V437)
 *
 * The consumer list comes from the REGISTRY — every definition whose `sourceReferences`
 * feeds a `camera`-kind port — so a fourth camera consumer is covered on the day it is
 * declared. B104's own gate (`camera-wiring.gpu.test.ts`) enumerates the same way and for
 * the same reason; this is the compile-time half, which needs no GPU.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

/** Every node that names a camera through a reference parameter (§V372/§V373). */
function cameraConsumers(): ReadonlyArray<string> {
  const found: string[] = [];
  for (const definition of allNodeDefinitions) {
    for (const reference of definition.sourceReferences ?? []) {
      const port = definition.inputs.find((input) => input.id === reference.input);
      if (port?.type.kind === "camera" && !found.includes(definition.type)) found.push(definition.type);
    }
  }
  return found.sort();
}

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

const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  label,
});

/**
 * `consumer`, fed a 32x32 grid, writing to the output. `cameraName` is what goes in the
 * `camera` PARAMETER: a real camera's name, a name nobody answers to, or nothing at all.
 */
function graphFor(consumer: string, cameraName: string): GraphDocument {
  const shared = [
    node("grid", "pointGrid", { cols: 32, rows: 32 }, "grid1"),
    node("cam", "camera", { eye: [0, 0, 3], lookAt: [0, 0, 0] }, "cam1"),
    node("out", "output", {}, "out1"),
  ];
  const edges: Record<string, unknown> = {
    e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
  };
  const nodes =
    consumer === "render"
      ? [
          ...shared,
          node("geo", "geometry", { mode: "surface" }, "geo1"),
          node("sun", "light", { kind: "directional", direction: [0, 0, -1], intensity: 1 }, "sun1"),
          node("shot", "render", { scenes: "geo1", camera: cameraName, lights: "sun1" }, "shot1"),
        ]
      : [...shared, node("shot", consumer, { camera: cameraName }, "shot1")];
  edges["e1"] =
    consumer === "render"
      ? { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "geo", portId: "points" } }
      : { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "shot", portId: "points" } };
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges,
    groups: {},
  } as never;
}

const compile = (consumer: string, cameraName: string) =>
  compileGraph({ graph: graphFor(consumer, cameraName), settings: SETTINGS, registry, capabilities: CAPABILITIES });

/** The passes this renderer contributed — the thing that must not exist on a refusal. */
const passesOf = (plan: { passes: ReadonlyArray<PassDescriptor> }): ReadonlyArray<PassDescriptor> =>
  plan.passes.filter((pass) => (pass as { nodeId?: string }).nodeId === "shot");

describe("T528 — a dangling camera name refuses, and does not draw anyway", () => {
  it("enumerates the camera consumers from the registry, and there are three", () => {
    // If a fourth lands, every case below runs against it automatically. The count is
    // asserted so that a consumer VANISHING (which would make the sweep vacuous) is loud.
    expect(cameraConsumers()).toEqual(["render", "renderInstances", "renderSurface"]);
  });

  for (const consumer of cameraConsumers()) {
    describe(consumer, () => {
      it("a RESOLVING name draws, with no error — the baseline these assertions need", () => {
        const plan = compile(consumer, "cam1");
        expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
        expect(passesOf(plan).length).toBeGreaterThan(0);
      });

      it("a DANGLING name emits NO pass and says why, naming the name", () => {
        const plan = compile(consumer, "nope1");
        // The half that was the bug: renderSurface and renderInstances drew here.
        expect(passesOf(plan), `${consumer} drew through its inline camera anyway`).toEqual([]);
        const refusal = plan.diagnostics.find((entry) => entry.code === "node.camera.reference");
        expect(refusal?.severity).toBe("error");
        expect(refusal?.message).toContain('"nope1"');
        expect(refusal?.nodeId).toBe("shot");
        // The compiler's own §V369 error stays: the name is missing AND the render refused,
        // which are two true things about one typo.
        expect(plan.diagnostics.some((entry) => entry.code === CompilerDiagnosticCode.sourceReferenceMissing)).toBe(
          true,
        );
      });

      it("names a node that is NOT a camera: the same refusal, not a silent inline fallback", () => {
        // "grid1" exists and publishes a pointset. Nothing camera-shaped reaches the node,
        // so the one check covers this the same way it covers a name nobody answers to.
        const plan = compile(consumer, "grid1");
        expect(passesOf(plan)).toEqual([]);
        expect(plan.diagnostics.some((entry) => entry.code === "node.camera.reference")).toBe(true);
      });
    });
  }

  /**
   * The load-bearing half of the rule. `renderSurface`/`renderInstances` carry an INLINE
   * camera precisely so a points graph can be framed without a camera node, and a rule
   * that refused whenever no camera arrived would blank all of them. `render` has no
   * inline camera and keeps its own, differently-worded refusal.
   */
  it("NO name still frames inline, and still draws — refusing that would be the regression", () => {
    for (const consumer of ["renderSurface", "renderInstances"]) {
      const plan = compile(consumer, "");
      expect(plan.diagnostics.filter((entry) => entry.severity === "error"), consumer).toEqual([]);
      expect(passesOf(plan).length, consumer).toBeGreaterThan(0);
    }
  });

  it("`render` with no name says NO CAMERA IS NAMED — a different fact, and worded as one", () => {
    const plan = compile("render", "");
    expect(passesOf(plan)).toEqual([]);
    const refusal = plan.diagnostics.find((entry) => entry.code === "node.scene.camera");
    expect(refusal?.message).toContain("no camera is named");
    // And the dangling case must NOT reuse that wording — telling someone "no camera is
    // named" while their camera parameter reads `nope1` is the report that sent T500
    // looking in the wrong place.
    const dangling = compile("render", "nope1");
    expect(dangling.diagnostics.some((entry) => entry.code === "node.scene.camera")).toBe(false);
    expect(dangling.diagnostics.some((entry) => entry.code === "node.camera.reference")).toBe(true);
  });
});
