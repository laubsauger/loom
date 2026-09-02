import type { EnumParameter, ParameterSchema } from "../../domain/types/parameters.ts";
import type { ModelDescriptor } from "../../runtime/models/model-acquisition.ts";

/**
 * §V827 — WHAT EVERY MODEL-RUNNING NODE OWES, the schema-side half, shared by
 * construction (the owner: "make it a rule that these things expose all the relevant
 * bits as we did for depth. We can't just swallow that — it will be needed anyway").
 *
 * Depth built these five obligations by hand (§T965/§T978); pose repeated depth's
 * omissions and earned §T985; the matte is the third instance and the moment the seam
 * exists. What lives here is what a SCHEMA can promise:
 *
 *   (1) the artefact and its cost, named IN the control that chooses it — the enum
 *       labels carry the measured megabytes and the licence rides the description;
 *   (5) the reset pulse — §T978's recovery gesture, session-scoped, weights kept.
 *
 * Obligations (2) what-actually-ran and (3) what-it-cost are MEASUREMENTS, published by
 * the inference runtime through the node-info readouts — a schema that claimed them
 * would be §T381's echo bug by construction, so they are deliberately not here.
 * Obligation (4), per-artefact knobs, stays in each node's `parametersFor` because it
 * is per-model by nature (§T965's signature-driven Input Size is the worked example);
 * this module only guarantees it a consistent home beside (1) and (5).
 *
 * Depth and pose still carry their own hand-built versions of (1) and (5); migrating
 * them onto this seam is the inference track's half of §V827 (their files, their
 * in-flight arc). The matte ships on the seam from day one.
 */

/** MB with one decimal, from the measured byte count — the number the consent moment shows. */
function megabytes(bytes: number): string {
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

/**
 * (1) The model chooser: every option names its artefact AND its download, and the
 * description states the licence — the facts a user weighs at the moment of choosing.
 */
export function inferenceModelSchema(
  models: readonly ModelDescriptor[],
  options: { readonly label?: string; readonly what: string },
): EnumParameter {
  /*
   * Returns `EnumParameter`, not the `ParameterSchema[string]` union, and the narrowing
   * is what the FIRST MIGRATION needed rather than a preference (T965's depth node).
   *
   * Depth carries §V813 legacy stored values — looms shipped holding `accurate`/`fast`
   * before the chooser stored model ids — so its adoption has to EXTEND the option list
   * rather than take it whole. Through the union that read is impossible: `.options`
   * exists on one member. A seam a second adopter has to cast its way into is a seam that
   * will be forked instead of reused, which is the outcome §V827 exists to prevent.
   */
  const first = models[0];
  return {
    type: "enum",
    label: options.label ?? "Model",
    compileTime: true,
    default: first?.id ?? "",
    options: models.map((model) => ({
      value: model.id,
      label: `${model.label.replace(/ \(.*\)$/, "")} (${megabytes(model.bytes)})`,
    })),
    description:
      `${options.what} ` +
      `Downloaded once per machine on first use, with your consent — the size in each ` +
      `option is the download it commits you to. ` +
      `Licence: ${[...new Set(models.map((model) => model.license))].join(", ")}.`,
  };
}

/**
 * (5) §T978's recovery gesture, word for word in scope: resets the SESSION — worker,
 * provider ladder, published result, any run in flight — and never the cached weights.
 */
export function inferenceResetSchema(): ParameterSchema[string] {
  return {
    type: "pulse",
    label: "Reset",
    group: "Model",
    fires: "runtime.resetInference",
    input: { nodeIds: ["$node"] },
    description:
      "Restarts inference from a clean state: the worker thread, the model session, the " +
      "execution-provider ladder, the published result and any run in flight. The node " +
      "goes back to publishing its neutral output and computes a fresh first result. " +
      "THE DOWNLOADED MODEL IS KEPT — this never re-downloads, and never spends anything. " +
      "The thread is shared, so any other model node in the document restarts with it.",
  } as ParameterSchema[string];
}

/**
 * The T974 letterbox preprocess, parameterised only by its buffer binding — the WGSL
 * every image-input model node shares, so the aspect rule cannot be re-derived wrong.
 * `occOf` in depth-runner.ts is this formula's float64 twin.
 */
export function letterboxPreprocessWgsl(): string {
  return `struct PreprocessParams { side: f32 };

@group(0) @binding(0) var<uniform> params: PreprocessParams;
@group(0) @binding(1) var sourceTexture: texture_2d<f32>;
@group(0) @binding(2) var<storage, read_write> modelInput: array<vec4f>;

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let side = u32(params.side);
  if (gid.x >= side || gid.y >= side) { return; }
  let dims = vec2i(textureDimensions(sourceTexture, 0));
  let uv = (vec2f(f32(gid.x), f32(gid.y)) + 0.5) / params.side;
  /* T974 — LETTERBOX, not squeeze: uniform scale, centred, edges replicated. The model
     sees real perspective and the read-back samples only the occupied band. */
  let dimsF = vec2f(dims);
  let aspect = dimsF.x / max(dimsF.y, 1.0);
  let occ = select(vec2f(aspect, 1.0), vec2f(1.0, 1.0 / aspect), aspect >= 1.0);
  let sourceUv = (uv - vec2f(0.5)) / occ + vec2f(0.5);
  let texel = clamp(vec2i(sourceUv * dimsF), vec2i(0), dims - vec2i(1));
  modelInput[gid.y * side + gid.x] = textureLoad(sourceTexture, texel, 0);
}`;
}
