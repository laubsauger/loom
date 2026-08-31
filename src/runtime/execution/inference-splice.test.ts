import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import {
  INPUT_KEY,
  INPUT_SIDE,
  RESULT_KEY,
  inferenceStandIn,
} from "../../tests/fixtures/inference-stand-in.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";

/**
 * THE SPLICE, against the real compiler (T715/T384, §V585).
 *
 * §V585's claim is that an inference node needs NO new resource kind and NO new GPU→CPU
 * route, because it is `analyze`'s input half and `webcam`'s output half in one node. That
 * is a claim about the COMPILER, and it is worth exactly nothing until the real compiler
 * has accepted a node that declares both. So this compiles one.
 *
 * The node here is a stand-in for Phase 4's depth node and deliberately has no model: the
 * point is the SHAPE the compiler materializes, which is identical whether the middle is
 * Depth Anything or the pseudo-inference the seam's own tests use. Zero bytes downloaded.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const registry = createNodeRegistry([...allNodeDefinitions, inferenceStandIn]).view();
const compile = (graph: GraphDocument) => compileGraph({ graph, settings, registry, capabilities });

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}): GraphNode {
  const definitionVersion = registry.get(type)?.version ?? 1;
  return { id, type, definitionVersion, position: { x: 0, y: 0 }, parameters };
}

function edge(id: string, from: [string, string], to: [string, string]) {
  return { id, source: { nodeId: from[0], portId: from[1] }, target: { nodeId: to[0], portId: to[1] } };
}

/** Noise -> inference -> Output: the smallest graph that exercises both halves. */
function graphWithInference(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      noise: node("noise", "noise", { type: "simplex2d", period: 0.2 }),
      infer: node("infer", "inferenceStandIn"),
      out: node("out", "output"),
    },
    edges: {
      e1: edge("e1", ["noise", "out"], ["infer", "input"]),
      e2: edge("e2", ["infer", "out"], ["out", "input"]),
    },
    groups: {},
  };
}

describe("an inference node compiles as analyze-in plus media-out", () => {
  it("compiles with no errors through the real compiler", () => {
    const plan = compile(graphWithInference());
    const errors = plan.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
  });

  it("materializes BOTH halves — a storage buffer in, an external texture out", () => {
    const plan = compile(graphWithInference());

    const input = plan.resources.find((r) => r.id === scratchResourceId("infer", INPUT_KEY));
    const result = plan.resources.find((r) => r.id === scratchResourceId("infer", RESULT_KEY));

    // §V585's claim, as an assertion: no new resource kind was needed for either half.
    expect(input?.kind).toBe("buffer");
    expect(result?.kind).toBe("externalTexture");
  });

  it("keys the result texture on the inference namespace, not the media one", () => {
    // The harness registers a synthetic TEST CARD for every `media:` source. An inference
    // result must not collect one — its stand-in is a recorded inference. If these
    // namespaces ever merge, a depth node in a Dawn gate silently renders diagonal bars.
    const plan = compile(graphWithInference());
    const result = plan.resources.find((r) => r.id === scratchResourceId("infer", RESULT_KEY));

    expect((result as { sourceId?: string } | undefined)?.sourceId).toBe("infer:infer");
    expect((result as { sourceId?: string } | undefined)?.sourceId).not.toMatch(/^media:/);
  });

  it("sizes the model-input buffer to the model, not to the output resolution", () => {
    // The readback is the thing V184 forbids stalling on, so its size is the model's
    // input, fixed and small — not 1280x720. A buffer that tracked the output would put
    // 3.7MB through `readBuffer` per frame for a model that wanted 256KB.
    const plan = compile(graphWithInference());
    const input = plan.resources.find((r) => r.id === scratchResourceId("infer", INPUT_KEY)) as
      | { stride?: number; capacity?: number }
      | undefined;

    expect(input?.stride).toBe(16);
    expect(input?.capacity).toBe(INPUT_SIDE * INPUT_SIDE);
    // 1 MB per readback, fixed — not the 3.7 MB an output-sized buffer would cost.
    expect((input?.stride ?? 0) * (input?.capacity ?? 0)).toBe(1_048_576);
  });

  it("PRUNES a disconnected inference node, so an unused model costs nothing", () => {
    // §V585 is explicit that an inference node must not be a sink. This is why: a model
    // node dropped on the canvas and left unwired must compile to no passes — which is
    // what will later mean it downloads nothing (T383).
    const graph = graphWithInference();
    const orphaned: GraphDocument = {
      ...graph,
      nodes: { ...graph.nodes, lonely: node("lonely", "inferenceStandIn") },
    };

    const plan = compile(orphaned);

    expect(plan.order).not.toContain("lonely");
    expect(plan.resources.find((r) => r.id === scratchResourceId("lonely", RESULT_KEY))).toBeUndefined();
  });

  it("orders the preprocess before the blit, and the whole node after its source", () => {
    const plan = compile(graphWithInference());
    expect(plan.order.indexOf("noise")).toBeLessThan(plan.order.indexOf("infer"));
    expect(plan.order.indexOf("infer")).toBeLessThan(plan.order.indexOf("out"));
  });
});
