import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { ParameterSchema } from "../../domain/types/parameters.ts";
import type { DispatchPassDescriptor, EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import { POSE_INPUT_SIDE, POSE_KEYPOINT_COUNT } from "../../runtime/models/pose-runner.ts";
import { SHARED_SAMPLER_ID, scratchResourceId } from "../../compiler/resources.ts";
import type { ModelDescriptor } from "../../runtime/models/model-acquisition.ts";
import { POSE_ACCURATE, POSE_LIVE, POSE_MODELS } from "../../runtime/models/model-catalogue.ts";
import { inferenceModelSchema, inferenceResetSchema, letterboxPreprocessWgsl } from "./inference-node.ts";
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

/*
 * T992 — LETTERBOXED, both halves at once, because either half alone is worse than
 * neither (the row's own ruling). The preprocess is §V827's shared
 * `letterboxPreprocessWgsl` — the same fit depth uses, T974's rule — and the other half
 * is in `keypointsToTexture`: the model reports joints in letterboxed uv, and the
 * encoder maps them back onto the picture with `occOf`, fed by the run request's
 * sourceWidth/sourceHeight (the protocol field this change added — pose's output is the
 * fixed 17×1 keypoint map, so the picture's aspect could never be recovered from the
 * output size the way depth's inherit policy recovers it). A squeezed frame degraded
 * MoveNet plausibly and silently; a letterbox without the un-letterbox would have put
 * every joint off by the bar width, equally plausibly.
 */
const POSE_BLIT_WGSL = `@group(0) @binding(0) var poseSampler: sampler;
@group(0) @binding(1) var poseTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(poseTexture, poseSampler, uv, 0.0);
}`;

const WORKGROUPS = Math.ceil(POSE_INPUT_SIDE / 8);

const POSE_MODEL_SCHEMA = inferenceModelSchema(POSE_MODELS, {
  what:
    "Which MoveNet build runs. The 8-bit variant is a quarter of the download and is NOT " +
    "faster — measured on the CPU path it is roughly three times slower — so pick it to " +
    "save the download, never to save time.",
});

/** The pre-§V827 stored spellings, and the descriptor each one still means (§V813). */
const POSE_LEGACY_MODEL_VALUES: ReadonlyArray<{ value: string; descriptor: ModelDescriptor }> = [
  { value: "accurate", descriptor: POSE_ACCURATE },
  { value: "fast", descriptor: POSE_LIVE },
];

/**
 * The chooser, plus the legacy row the DOCUMENT IN HAND is standing on — and only that
 * one (depth's shape exactly).
 *
 * Offering both legacy values to everyone would show four rows for two models, at two
 * different sizes, because the old labels were hand-written and the new ones are measured.
 * A migration shim must be invisible to everyone it is not migrating.
 */
function poseModelParameter(stored: Readonly<Record<string, unknown>>): ParameterSchema[string] {
  const legacy = POSE_LEGACY_MODEL_VALUES.filter((entry) => entry.value === stored["model"]).map(
    (entry) => {
      const twin = POSE_MODEL_SCHEMA.options.find((option) => option.value === entry.descriptor.id);
      return { value: entry.value, label: `${twin?.label ?? entry.descriptor.label} — as saved` };
    },
  );
  return { ...POSE_MODEL_SCHEMA, options: [...POSE_MODEL_SCHEMA.options, ...legacy] };
}

function poseParameters(stored: Readonly<Record<string, unknown>>): ParameterSchema {
  return { model: poseModelParameter(stored), reset: inferenceResetSchema() };
}

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
  /**
   * §V827's OBLIGATIONS (1) AND (5), taken from the shared seam (T957, §T985).
   *
   * Pose shipped with depth's omissions and earned §T985 for it: an opaque chooser
   * (`Accurate (9 MB)` named neither the model nor the licence, and the megabytes were
   * hand-written beside a byte count the catalogue already measures) and no recovery
   * gesture at all. Both are now one function call each, so the next model node inherits
   * them rather than repeating the omission a third time.
   *
   * §V813, exactly as depth: `accurate`/`fast` are what documents written before the
   * chooser hold, so they stay in the OPTION LIST and not merely in the parser — an enum
   * whose stored value is missing from its own options resolves to the default, which
   * would silently move a document onto the 9 MB model it did not choose.
   */
  /** The STATIC fallback: the palette and a fresh drop, on the default model. */
  parameters: poseParameters({}),
  /** PER-INSTANCE, for the one thing that varies: which legacy spelling this node holds. */
  parametersFor(stored) {
    return poseParameters(stored);
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
      shader: letterboxPreprocessWgsl(),
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
