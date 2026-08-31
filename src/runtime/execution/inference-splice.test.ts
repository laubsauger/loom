import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { readCompileInputs } from "../../nodes/definitions/compile-context.ts";
import { RGBA_TEXTURE } from "../../nodes/definitions/common-ports.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { inferenceSourceIdFor } from "./inference-sources.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor, EffectPassDescriptor } from "../backend/plan.ts";

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

/** The model's input side length. Small on purpose: the readback is bytes, not megabytes. */
const INPUT_SIDE = 256;
const INPUT_KEY = "modelInput";
const RESULT_KEY = "modelResult";

const PREPROCESS_WGSL = `struct P { side: f32 };
@group(0) @binding(0) var<uniform> params: P;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> modelInput: array<vec4f>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let side = u32(params.side);
  if (gid.x >= side || gid.y >= side) { return; }
  let dims = vec2i(textureDimensions(sourceTexture, 0));
  let uv = (vec2f(f32(gid.x), f32(gid.y)) + 0.5) / params.side;
  let texel = clamp(vec2i(uv * vec2f(dims)), vec2i(0), dims - vec2i(1));
  modelInput[gid.y * side + gid.x] = textureLoad(sourceTexture, texel, 0);
}`;

const RESULT_BLIT_WGSL = `@group(0) @binding(0) var resultSampler: sampler;
@group(0) @binding(1) var resultTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(resultTexture, resultSampler, uv, 0.0);
}`;

/**
 * The Phase 4 shape, with the model removed.
 *
 * §V585: it must NOT declare `sink: true`. Analyze does, because its entire product is a
 * published channel and nothing downstream consumes a texture from it. An inference node
 * has a real texture output, so ordinary pruning applies — and that is what makes a
 * DISCONNECTED model node cost zero and, later, download nothing.
 */
const inferenceStandIn: NodeDefinition = {
  type: "inferenceStandIn",
  version: 1,
  title: "Inference Stand-In",
  category: "filter",
  description:
    "Phase 0's compile-shape stand-in: resamples its input into a model-input buffer and blits whatever the CPU half uploaded back. No model, no download.",
  tags: ["test"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {},
  resolutionPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, outputs } = readCompileInputs(context);
    const source = inputs["input"];
    const target = outputs["out"];
    if (source === undefined || target === undefined) return { passes: [] };

    // IN — analyze's route, just bigger: a compute pass writes an ordinary scratch
    // BUFFER the CPU half reads with `backend.readBuffer` between frames.
    const preprocess: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:preprocess`,
      shader: PREPROCESS_WGSL,
      entryPoint: "main",
      workgroups: [INPUT_SIDE / 8, INPUT_SIDE / 8, 1],
      buffers: [{ binding: "modelInput", resourceId: scratchResourceId(nodeId, INPUT_KEY) }],
      textures: [{ binding: "sourceTexture", resourceId: source.resource, sampled: "unfiltered" }],
      uniforms: { side: INPUT_SIDE },
      uniformBinding: "params",
      nodeId,
    };

    // OUT — media's route: an `external` texture someone else fills, blitted to the port.
    const blit: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:result`,
      shader: RESULT_BLIT_WGSL,
      target,
      samplers: [{ binding: "resultSampler", resourceId: "sampler:linear" }],
      textures: [{ binding: "resultTexture", resourceId: scratchResourceId(nodeId, RESULT_KEY) }],
      nodeId,
    };

    return {
      passes: [preprocess, blit],
      scratch: [
        { key: INPUT_KEY, kind: "buffer", stride: 16, capacity: INPUT_SIDE * INPUT_SIDE },
        {
          key: RESULT_KEY,
          kind: "external",
          sourceId: inferenceSourceIdFor(nodeId),
          format: "rgba8unorm",
        },
      ],
    };
  },
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
