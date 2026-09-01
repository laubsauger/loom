import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor, EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import { SHARED_SAMPLER_ID, scratchResourceId } from "../../compiler/resources.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";

/**
 * Depth — a monocular depth map, inferred (T385, T715, §V585, §V586).
 *
 * ## It is analyze's input half and webcam's output half, in one node
 *
 * `compileGraph` is synchronous and pure, so nothing here awaits. The GPU work is two
 * ordinary passes and the model runs outside the plan entirely:
 *
 *   IN   `depth:preprocess` resamples the source into an ordinary scratch BUFFER at the
 *        model's input size. `createInferenceSources` reads it with `backend.readBuffer`
 *        between frames — analyze's §V48 route, just bigger.
 *   OUT  the result arrives as an `external` texture through the media registry, blitted
 *        to the output port — webcam's route exactly.
 *
 * No new resource kind and no new GPU→CPU route, which is §V585's whole claim.
 *
 * ## What it publishes before the model exists, and why that is the point
 *
 * A 94 MB model is not downloaded because a node was placed, so a fresh Depth node has no
 * result and renders its IDENTITY FALLBACK: flat mid-grey. That is not a placeholder
 * colour picked to look neutral — `displace` defines 0.5 as "no displacement" already
 * (`filters.ts:173`), so a Depth feeding a Displace on a machine with no model composes
 * to a no-op and the document renders as though the node were not there.
 *
 * That is the owner's constraint made structural: an unavailable model degrades the RATE,
 * never the CONTRACT. The node always exists, always publishes RGBA, and a document using
 * it opens anywhere. What it must never be is SILENT about it — the acquisition state is
 * a problems-pane row and the staleness is on the telemetry channel, because one is a
 * persistent decision and the other changes every frame.
 *
 * ## Not a sink
 *
 * §V585: unlike Analyze, this has a real texture output, so ordinary pruning applies. An
 * unwired Depth node compiles to no passes, declares no resources and downloads nothing.
 */

/**
 * Depth Anything V2 is a ViT with a patch size of 14, and 518 = 37 x 14 is the size it
 * was exported at. Not a tunable: a different side means a different graph input and the
 * session refuses it.
 */
export const DEPTH_INPUT_SIDE = 518;
export const DEPTH_INPUT_KEY = "modelInput";
export const DEPTH_RESULT_KEY = "modelResult";

/**
 * Resample into the model's input, on the GPU.
 *
 * Doing this here rather than on the CPU is the reason we need no image library: the
 * expensive part of preprocessing is the resize, the GPU is already holding the pixels,
 * and what crosses to the CPU is the model's actual input rather than a full-resolution
 * frame. `vec4f` per texel so the runner receives floats and converts nothing.
 */
const DEPTH_PREPROCESS_WGSL = `struct DepthParams { side: f32 };

@group(0) @binding(0) var<uniform> params: DepthParams;
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

const DEPTH_BLIT_WGSL = `@group(0) @binding(0) var depthSampler: sampler;
@group(0) @binding(1) var depthTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(depthTexture, depthSampler, uv, 0.0);
}`;

const WORKGROUPS = Math.ceil(DEPTH_INPUT_SIDE / 8);

export const depthNode: NodeDefinition = {
  type: "depth",
  version: 1,
  title: "Depth",
  category: "filter",
  description:
    "Estimates a depth map from an image — near is bright, far is dark — using Depth Anything V2 running in the browser. The model is downloaded once per machine on first use, with your consent and a progress readout, and is never bundled. Until it is available the node publishes flat mid-grey, which Displace reads as no displacement, so a document using Depth opens and renders on a machine that cannot run it. Results arrive at the model's own rate rather than once per frame: live playback shows the most recent one and reports its age, while an offline render waits for each frame so a take reproduces.",
  tags: ["depth", "ml", "inference", "3d", "displace"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    model: {
      type: "enum",
      label: "Model",
      default: "accurate",
      options: [
        { value: "accurate", label: "Accurate (94 MB)" },
        { value: "fast", label: "Fast (18 MB)" },
      ],
      description:
        "Which weights to use. Accurate is the full-precision model; Fast is a 4-bit variant that downloads in a fifth of the bytes and infers quicker at some cost in detail. They are separate downloads, so switching asks before it spends anything.",
    },
  },
  /**
   * The OUTPUT follows the input's shape, not the model's. The model works at 518x518
   * whatever the picture is; the depth map is then sampled back up to the source's
   * resolution, so a Depth in a chain behaves like every other filter and a downstream
   * Displace lines up with the image it is displacing.
   */
  resolutionPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, outputs } = readCompileInputs(context);
    const source = inputs["input"];
    const target = outputs["out"];
    // No input or nothing consuming the output: compile to nothing. §V585 — an unwired
    // model node costs zero and, crucially, downloads nothing.
    if (source === undefined || target === undefined) return { passes: [] };

    const preprocess: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:preprocess`,
      shader: DEPTH_PREPROCESS_WGSL,
      entryPoint: "main",
      workgroups: [WORKGROUPS, WORKGROUPS, 1],
      buffers: [{ binding: "modelInput", resourceId: scratchResourceId(nodeId, DEPTH_INPUT_KEY) }],
      textures: [{ binding: "sourceTexture", resourceId: source.resource, sampled: "unfiltered" }],
      uniforms: { side: DEPTH_INPUT_SIDE },
      uniformBinding: "params",
      nodeId,
    };

    const blit: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:result`,
      shader: DEPTH_BLIT_WGSL,
      target,
      samplers: [{ binding: "depthSampler", resourceId: SHARED_SAMPLER_ID }],
      textures: [{ binding: "depthTexture", resourceId: scratchResourceId(nodeId, DEPTH_RESULT_KEY) }],
      nodeId,
    };

    return {
      passes: [preprocess, blit],
      scratch: [
        {
          key: DEPTH_INPUT_KEY,
          kind: "buffer",
          stride: 16,
          capacity: DEPTH_INPUT_SIDE * DEPTH_INPUT_SIDE,
        },
        {
          key: DEPTH_RESULT_KEY,
          kind: "external",
          sourceId: inferenceSourceIdFor(nodeId),
          // Linear, NOT srgb: a depth map is a measurement, not a picture, and decoding
          // it through a transfer function would bend the distances (§V56's family).
          format: "rgba8unorm",
        },
      ],
    };
  },
};
