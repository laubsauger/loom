import { scratchResourceId } from "../../compiler/resources.ts";
import { RGBA_TEXTURE } from "../../nodes/definitions/common-ports.ts";
import { readCompileInputs } from "../../nodes/definitions/compile-context.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor, EffectPassDescriptor } from "../../runtime/backend/plan.ts";

/**
 * Phase 4's depth node with the model taken out (T715/T384, §V585).
 *
 * It exists so the SEAM can be gated before any model ships: the compiled shape, the
 * resource kinds, the pruning behaviour and the harness feed are identical whether the
 * middle is Depth Anything or nothing at all. Shared by the compile-level splice test and
 * the Dawn gate so the two cannot drift into testing different nodes.
 *
 * Deliberately NOT registered in the shipped catalogue: it is passed through the harness's
 * `nodes` extension, so no user ever sees it and `NODE_REPRODUCIBILITY` is not asked to
 * classify a node that does not exist for documents.
 */

/** The model's input side length. Small on purpose: the readback is bytes, not megabytes. */
export const INPUT_SIDE = 256;
export const INPUT_KEY = "modelInput";
export const RESULT_KEY = "modelResult";

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
 * §V585: it must NOT declare `sink: true`. Analyze does, because its entire product is a
 * published channel and nothing downstream consumes a texture from it. An inference node
 * has a real texture output, so ordinary pruning applies — which is what makes a
 * DISCONNECTED model node cost zero and, later, download nothing.
 */
export const inferenceStandIn: NodeDefinition = {
  type: "inferenceStandIn",
  version: 1,
  title: "Inference Stand-In",
  category: "filter",
  description:
    "T715 Phase 0's compile-shape stand-in: resamples its input into a model-input buffer and blits whatever the CPU half uploaded back. No model, no download.",
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
