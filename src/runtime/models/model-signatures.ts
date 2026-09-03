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

export const MODEL_SIGNATURES: readonly ModelSignature[] = [
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
];

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
