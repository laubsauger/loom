import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { DispatchPassDescriptor, EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import { POSE_INPUT_SIDE, POSE_KEYPOINT_COUNT } from "../../runtime/models/pose-runner.ts";
import { SHARED_SAMPLER_ID, scratchResourceId } from "../../compiler/resources.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { readCompileInputs } from "./compile-context.ts";

/**
 * Pose — human keypoints, inferred (T743, T386, T715).
 *
 * Structurally IDENTICAL to Depth: the same preprocess-into-a-buffer, the same external
 * texture filled from outside the plan, the same acquisition and the same async
 * semantics. That identity is the finding, not a coincidence — it is what shows the seam
 * generalises rather than being a depth-shaped path wearing a general name.
 *
 * ## The output is a 17x1 KEYPOINT TEXTURE, and that is the whole design
 *
 * The catalogue's only CPU-to-GPU route is the media registry, which fills TEXTURES; there
 * is no buffer equivalent, and `external` scratch is texture-only. Rather than add a new
 * resource kind and a new upload route — retiring §V585 across the compiler, the backend
 * contract and the harness to get pose alone — the keypoints ride the existing seam as a
 * tiny texture, and `pointsFromTexture` in Value mode turns them into a real point set.
 *
 * That node is where the generality actually landed: a Depth map through the same node in
 * Grid mode is a live point cloud, which is worth more than either node by itself.
 *
 * ## rgba16float, one texel per joint
 *
 * R and G are the joint's x and y across the frame, B is confidence, A is 1. Half-float
 * because a byte would quantise a joint to about seven pixels at 1080p — a permanent
 * tremor on every limb. §V427's `textureLoad` is nearest and unfiltered, which is exactly
 * right here: interpolating between the left wrist and the right ear is not a joint.
 *
 * ## With no model it publishes zero confidence, and that is not a placeholder
 *
 * It is byte-for-byte what the model emits when nobody is in shot, so every point parks
 * out of frame and nothing draws. The no-model state and the no-person state are the same
 * state — which is why nothing downstream needs a special case, and why a canonical
 * T-pose would have been a lie (§V147). The honest cost, unlike Depth's invisible no-op:
 * a pose-driven document VISIBLY loses its pose-driven parts, so the unavailable notice
 * is load-bearing here in a way it is not for Depth.
 */

export const POSE_INPUT_KEY = "modelInput";
export const POSE_RESULT_KEY = "modelResult";

const POSE_PREPROCESS_WGSL = `struct PoseParams { side: f32 };

@group(0) @binding(0) var<uniform> params: PoseParams;
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

const POSE_BLIT_WGSL = `@group(0) @binding(0) var poseSampler: sampler;
@group(0) @binding(1) var poseTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(poseTexture, poseSampler, uv, 0.0);
}`;

const WORKGROUPS = Math.ceil(POSE_INPUT_SIDE / 8);

export const poseNode: NodeDefinition = {
  type: "pose",
  version: 1,
  title: "Pose",
  category: "filter",
  description:
    "Finds a person's 17 body keypoints — nose, eyes, ears, shoulders, elbows, wrists, hips, knees, ankles — using MoveNet running in the browser. Its output is a 17x1 keypoint map, one texel per joint: red and green are the joint's position across the frame, blue is how sure the model is. Feed it to Points From Texture in Value mode to turn the joints into points that geometry and instancing can follow. The model downloads once per machine on first use, with your consent; until then, and whenever nobody is in shot, every joint reads zero confidence and nothing is drawn.",
  tags: ["pose", "ml", "inference", "keypoints", "points", "body"],
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Keypoints", type: RGBA_TEXTURE }],
  parameters: {
    model: {
      type: "enum",
      label: "Model",
      default: "accurate",
      options: [
        { value: "accurate", label: "Accurate (9 MB)" },
        { value: "fast", label: "Small download (2.5 MB)" },
      ],
      description:
        "Both are MoveNet SinglePose Lightning; the 8-bit variant is a quarter of the download and is NOT faster — measured on the CPU path it is roughly three times slower. Pick it to save the download, not to save time. Separate downloads, so switching asks before it spends anything.",
    },
  },
  /**
   * FIXED, and deliberately not `inherit`. The output is a data map with one texel per
   * joint, not a picture — resampling it to the source's resolution would smear seventeen
   * measurements across a million texels and invite someone to composite it.
   */
  resolutionPolicy: { kind: "fixed", width: POSE_KEYPOINT_COUNT, height: 1 },
  formatPolicy: { kind: "fixed", format: "rgba16float" },
  compile(context): CompiledNodeDescription {
    const { nodeId, inputs, outputs } = readCompileInputs(context);
    const source = inputs["input"];
    const target = outputs["out"];
    // §V585: unwired compiles to nothing, so placing a Pose node downloads nothing.
    if (source === undefined || target === undefined) return { passes: [] };

    const preprocess: DispatchPassDescriptor = {
      kind: "dispatch",
      id: `${nodeId}:preprocess`,
      shader: POSE_PREPROCESS_WGSL,
      entryPoint: "main",
      workgroups: [WORKGROUPS, WORKGROUPS, 1],
      buffers: [{ binding: "modelInput", resourceId: scratchResourceId(nodeId, POSE_INPUT_KEY) }],
      textures: [{ binding: "sourceTexture", resourceId: source.resource, sampled: "unfiltered" }],
      uniforms: { side: POSE_INPUT_SIDE },
      uniformBinding: "params",
      nodeId,
    };

    const blit: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:result`,
      shader: POSE_BLIT_WGSL,
      target,
      samplers: [{ binding: "poseSampler", resourceId: SHARED_SAMPLER_ID }],
      textures: [{ binding: "poseTexture", resourceId: scratchResourceId(nodeId, POSE_RESULT_KEY) }],
      nodeId,
    };

    return {
      passes: [preprocess, blit],
      scratch: [
        {
          key: POSE_INPUT_KEY,
          kind: "buffer",
          stride: 16,
          capacity: POSE_INPUT_SIDE * POSE_INPUT_SIDE,
        },
        {
          key: POSE_RESULT_KEY,
          kind: "external",
          sourceId: inferenceSourceIdFor(nodeId),
          format: "rgba16float",
        },
      ],
    };
  },
};
