/**
 * What the shipped weight files ACTUALLY declare (§V742, §B148).
 *
 * ## Extracted, never typed
 *
 * Every row here was read out of the real `.onnx` at its pinned revision by
 * `extract-model-signatures.ts` on 2026-09-01. That matters more than it looks: Pose
 * shipped unable to produce a single result because its packer was written from the model
 * CARD — MoveNet's TensorFlow original takes `int32` with three channels — while the WEB
 * export takes `uint8` with four. ONNX Runtime refuses the mismatch outright, so the node
 * could never have run, and thirty-two green tests said otherwise.
 *
 * The reason they said otherwise is the part worth keeping: every fake in the suite agreed
 * with the PACKER, because a hermetic gate never meets the artifact it stands in for. A
 * hand-written fixture here would have inherited the same wrong assumption and changed
 * nothing. §V743: for a third-party binary the FILE is the contract and the prose is a
 * hint — and the docblock should say which one was consulted.
 *
 * ## What this buys, and what it does not
 *
 * The always-on gate catches a PACKER that disagrees with the recorded signature, and a
 * recorded signature left stale after a revision bump. What it cannot catch on its own is
 * a signature that was wrong when recorded — which is why it is generated rather than
 * written, and why `model-signatures.test.ts` re-reads the real weights when they are
 * present and asserts these rows still match.
 */

export interface ModelSignature {
  readonly modelId: string;
  /** The PICTURE input — `inputs[0]`, and the only one every model here has. */
  readonly input: { readonly name: string; readonly type: string; readonly shape: readonly string[] };
  /**
   * `outputs[0]`, VERBATIM from the artefact — which for RVM is `fgr`, the colour
   * foreground, and is NOT the matte. This field records what the file declares first; it
   * is deliberately not "the useful one", because the moment those two were assumed equal
   * is §V861 (see `outputs` below).
   */
  readonly output: { readonly name: string; readonly type: string };
  /**
   * ═════════════════════════════════════════════════════════════════════════════════
   * §V861 — EVERY declared name, because index 0 is not the answer for every model
   * ═════════════════════════════════════════════════════════════════════════════════
   *
   * The six models above this line are one-in-one-out, so `inputNames[0]` and
   * `outputNames[0]` were the whole contract and the worker read them by index. RVM is
   * six-in and six-out, and its `outputNames[0]` is `fgr` — a three-channel COLOUR image.
   * The matte node wants `pha`, at index 1.
   *
   * The failure that makes this worth a field: an index read hands the matte encoder a
   * colour plane AT PLAUSIBLE DIMENSIONS. `matteToFloats` walks `[side*side]` of whatever
   * it is given, so `fgr`'s red channel resamples into a picture-shaped result with no
   * crash, no shape error and no NaN — a wrong picture that looks like a picture. Nothing
   * downstream can tell.
   *
   * So the worker selects its picture BY NAME from a declaration table, and these lists
   * are what that table is checked against: a declared picture name that is not among the
   * artefact's own outputs is a typo the suite catches instead of the screen.
   */
  readonly inputs: readonly string[];
  readonly outputs: readonly string[];
}

const EXTRACTED_ROWS: readonly ModelSignature[] = [
  // Extracted from Large FP16 at 1fa1591 on 2026-10-09. IO stays float32.
  {
    modelId: "depth-anything-v2-large-fp16",
    input: { name: "pixel_values", type: "float32", shape: ["batch_size", "3", "height", "width"] },
    output: { name: "predicted_depth", type: "float32" },
    inputs: ["pixel_values"], outputs: ["predicted_depth"],
  },
  // Extracted from Large Q4F16 at 1fa1591 on 2026-10-09. IO stays float32.
  {
    modelId: "depth-anything-v2-large-q4f16",
    input: { name: "pixel_values", type: "float32", shape: ["batch_size", "3", "height", "width"] },
    output: { name: "predicted_depth", type: "float32" },
    inputs: ["pixel_values"], outputs: ["predicted_depth"],
  },
  // Extracted from the hash-pinned TopFormer artifact; native logits are 150 × 64 × 64.
  {
    modelId: "topformer-ade20k",
    input: { name: "input", type: "float32", shape: ["1", "3", "512", "512"] },
    output: { name: "output", type: "float32" },
    inputs: ["input"], outputs: ["output"],
  },
  // Extracted from BiRefNet Lite at 173d635 on 2026-10-08; output_image is logits.
  {
    modelId: "birefnet-lite-dynamic",
    input: { name: "input_image", type: "float32", shape: ["1", "3", "h", "w"] },
    output: { name: "output_image", type: "float32" },
    inputs: ["input_image"],
    outputs: ["output_image"],
  },
  // Extracted from ORMBG Q8 at 034e2d8 on 2026-10-08; raw alphas are probabilities.
  {
    modelId: "ormbg-quantized",
    input: { name: "pixel_values", type: "float32", shape: ["1", "3", "1024", "1024"] },
    output: { name: "alphas", type: "float32" },
    inputs: ["pixel_values"],
    outputs: ["alphas"],
  },
  {
    modelId: "depth-anything-v2-small",
    input: { name: "pixel_values", type: "float32", shape: ["batch_size", "3", "height", "width"] },
    output: { name: "predicted_depth", type: "float32" },
    inputs: ["pixel_values"],
    outputs: ["predicted_depth"],
  },
  {
    modelId: "depth-anything-v2-small-q4f16",
    input: { name: "pixel_values", type: "float32", shape: ["batch_size", "3", "height", "width"] },
    output: { name: "predicted_depth", type: "float32" },
    inputs: ["pixel_values"],
    outputs: ["predicted_depth"],
  },
  {
    modelId: "movenet-lightning",
    input: { name: "pixel_values", type: "uint8", shape: ["batch_size", "192", "192", "4"] },
    output: { name: "keypoints", type: "float32" },
    inputs: ["pixel_values"],
    outputs: ["keypoints"],
  },
  {
    modelId: "movenet-lightning-int8",
    input: { name: "pixel_values", type: "uint8", shape: ["batch_size", "192", "192", "4"] },
    output: { name: "keypoints", type: "float32" },
    inputs: ["pixel_values"],
    outputs: ["keypoints"],
  },
  {
    modelId: "modnet-photographic",
    input: { name: "input", type: "float32", shape: ["batch_size", "3", "height", "width"] },
    output: { name: "output", type: "float32" },
    inputs: ["input"],
    outputs: ["output"],
  },
  {
    modelId: "modnet-photographic-quantized",
    input: { name: "input", type: "float32", shape: ["batch_size", "3", "height", "width"] },
    output: { name: "output", type: "float32" },
    inputs: ["input"],
    outputs: ["output"],
  },
  /*
   * T1040 — read out of `rvm_mobilenetv3_fp32.onnx` (14,975,696 bytes, sha256 88d4531…)
   * on 2026-09-03 with `extract-model-signatures.ts`'s own routine, printed verbatim:
   *
   *   INPUTS   src [batch_size,3,height,width]   r1i r2i r3i r4i [batch_size,channels,height,width]
   *            downsample_ratio [1]
   *   OUTPUTS  fgr [batch_size,3,height,width]   pha [batch_size,1,height,width]
   *            r1o [_,16,_,_]  r2o [_,20,_,_]  r3o [_,40,_,_]  r4o [_,64,_,_]
   *
   * `output` below is `outputs[0]` as the file declares it — `fgr` — and the matte plan
   * names `pha` instead. That disagreement is not a mistake in either place; it is the
   * whole of §V861 written down where both halves can be seen at once.
   */
  {
    modelId: "rvm-mobilenetv3",
    input: { name: "src", type: "float32", shape: ["batch_size", "3", "height", "width"] },
    output: { name: "fgr", type: "float32" },
    inputs: ["src", "r1i", "r2i", "r3i", "r4i", "downsample_ratio"],
    outputs: ["fgr", "pha", "r1o", "r2o", "r3o", "r4o"],
  },
  /*
   * T1816b — Depth Pro 2, extracted 2026-11-21 by `extract-model-signatures.ts` from the
   * hash-verified files at the catalogue's revisions. STATIC 480×640 (no symbolic axis, so
   * the node offers no Input Size). The streaming build's cache tensors are fed back by
   * name: `present_<x>` becomes `past_<x>` on the next run.
   */
  {
    modelId: "depthpro2-s-stream4-fp16",
    input: { name: "pixel_values", type: "float32", shape: ["1", "3", "480", "640"] },
    output: { name: "depth_meters", type: "float32" },
    inputs: ["pixel_values", "f_px", "past_filled", "past_keys_5", "past_values_5", "past_prefixes_5", "past_keys_7", "past_values_7", "past_prefixes_7", "past_keys_9", "past_values_9", "past_prefixes_9", "past_keys_11", "past_values_11", "past_prefixes_11"],
    outputs: ["depth_meters", "present_filled", "present_keys_5", "present_values_5", "present_prefixes_5", "present_keys_7", "present_values_7", "present_prefixes_7", "present_keys_9", "present_values_9", "present_prefixes_9", "present_keys_11", "present_values_11", "present_prefixes_11"],
  },
  // The FP32 stream: the same names, float32 caches.
  {
    modelId: "depthpro2-s-stream4-fp32",
    input: { name: "pixel_values", type: "float32", shape: ["1", "3", "480", "640"] },
    output: { name: "depth_meters", type: "float32" },
    inputs: ["pixel_values", "f_px", "past_filled", "past_keys_5", "past_values_5", "past_prefixes_5", "past_keys_7", "past_values_7", "past_prefixes_7", "past_keys_9", "past_values_9", "past_prefixes_9", "past_keys_11", "past_values_11", "past_prefixes_11"],
    outputs: ["depth_meters", "present_filled", "present_keys_5", "present_values_5", "present_prefixes_5", "present_keys_7", "present_values_7", "present_prefixes_7", "present_keys_9", "present_values_9", "present_prefixes_9", "present_keys_11", "present_values_11", "present_prefixes_11"],
  },
  {
    modelId: "depthpro2-s-fp32",
    input: { name: "pixel_values", type: "float32", shape: ["1", "3", "480", "640"] },
    output: { name: "depth_meters", type: "float32" },
    inputs: ["pixel_values", "f_px"],
    outputs: ["depth_meters"],
  },
  {
    modelId: "depthpro2-b-fp16",
    input: { name: "pixel_values", type: "float32", shape: ["1", "3", "480", "640"] },
    output: { name: "depth_meters", type: "float32" },
    inputs: ["pixel_values", "f_px"],
    outputs: ["depth_meters"],
  },
  /*
   * The 16:9 builds, extracted the same day from `onnx/384x672/`: every name identical to
   * the 4:3 build beside it, the box 384×672. Written through `wideBox` so the identity is
   * visible; the re-read in `model-signatures.test.ts` still checks each against its file.
   */
];

export const MODEL_SIGNATURES: readonly ModelSignature[] = [
  ...EXTRACTED_ROWS,
  ...["depthpro2-s-stream4-fp32", "depthpro2-s-stream4-fp16", "depthpro2-s-fp32", "depthpro2-b-fp16"].map(wideBox),
];

/** The 4:3 row's names at Depth Pro 2's 16:9 box. */
function wideBox(modelId: string): ModelSignature {
  const square = EXTRACTED_ROWS.find((row) => row.modelId === modelId)!;
  return { ...square, modelId: `${modelId}-672x384`, input: { ...square.input, shape: ["1", "3", "384", "672"] } };
}

export function signatureFor(modelId: string): ModelSignature | undefined {
  return MODEL_SIGNATURES.find((signature) => signature.modelId === modelId);
}

/** The channel count a packer must emit per pixel, from the model's own trailing axis. */
export function declaredChannels(signature: ModelSignature): number {
  const { shape } = signature.input;
  // NHWC (pose): channels are last. NCHW (depth): channels are axis 1.
  const last = Number(shape[shape.length - 1]);
  const second = Number(shape[1]);
  return Number.isFinite(last) && last <= 4 ? last : second;
}
