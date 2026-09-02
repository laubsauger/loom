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
  readonly input: { readonly name: string; readonly type: string; readonly shape: readonly string[] };
  readonly output: { readonly name: string; readonly type: string };
}

export const MODEL_SIGNATURES: readonly ModelSignature[] = [
  {
    modelId: "depth-anything-v2-small",
    input: { name: "pixel_values", type: "float32", shape: ["batch_size", "3", "height", "width"] },
    output: { name: "predicted_depth", type: "float32" },
  },
  {
    modelId: "depth-anything-v2-small-q4f16",
    input: { name: "pixel_values", type: "float32", shape: ["batch_size", "3", "height", "width"] },
    output: { name: "predicted_depth", type: "float32" },
  },
  {
    modelId: "movenet-lightning",
    input: { name: "pixel_values", type: "uint8", shape: ["batch_size", "192", "192", "4"] },
    output: { name: "keypoints", type: "float32" },
  },
  {
    modelId: "movenet-lightning-int8",
    input: { name: "pixel_values", type: "uint8", shape: ["batch_size", "192", "192", "4"] },
    output: { name: "keypoints", type: "float32" },
  },
  {
    modelId: "modnet-photographic",
    input: { name: "input", type: "float32", shape: ["batch_size", "3", "height", "width"] },
    output: { name: "output", type: "float32" },
  },
  {
    modelId: "modnet-photographic-quantized",
    input: { name: "input", type: "float32", shape: ["batch_size", "3", "height", "width"] },
    output: { name: "output", type: "float32" },
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
