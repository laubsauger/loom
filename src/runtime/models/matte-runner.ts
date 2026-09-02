/**
 * T957 — MODNet person matting: the packer and the encoder, mirrored between the main
 * thread and the worker exactly as depth's are.
 *
 * PROVENANCE (§B148's rule — written from the weights and the reference code, never the
 * model card alone): the ONNX is Xenova/modnet @ fa2fa546052fba4c08921230a26cc69a333fca12
 * (Apache-2.0, the same onnx-community conversion family as the shipped depth model).
 * The signature — float32 NCHW, symbolic height/width — was read from the real file by
 * `extract-model-signatures.ts`. The normalisation (x − 0.5) / 0.5 per channel is
 * MODNet's own reference inference (ZHKKKe/MODNet, `inference.py`), not a guess.
 *
 * NAMING, deliberately: this is a person MATTE — a soft alpha from a segmentation model.
 * The compositing `mask` node is a different thing (it applies a channel as alpha) and
 * the two stay verbally distinct everywhere (§T957); a matte is what you feed a mask.
 */

/** MODNet's reference inference resizes to multiples of 32; 512 is the sweet spot the
 *  repo itself uses for portraits. Symbolic graph, so other multiples remain legal. */
export const MATTE_INPUT_SIDE = 512;

/**
 * Letterboxed (T974's rule, applied at birth rather than retrofitted): the source
 * occupies the largest centred aspect-true region of the model square, edges replicated
 * outside it. `occOf` in depth-runner.ts is the shared formula; the GPU preprocess for
 * the matte node uses the same expression in WGSL.
 */
export function packMatteInput(texels: Float32Array, side: number): Float32Array {
  const pixels = side * side;
  const out = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i += 1) {
    const base = i * 4;
    for (let c = 0; c < 3; c += 1) {
      const value = texels[base + c] ?? 0;
      out[c * pixels + i] = (value - 0.5) / 0.5;
    }
  }
  return out;
}

/**
 * The model's soft alpha → r32float texels (T959's float lesson pre-applied: no byte
 * rounding anywhere between the model and the GPU), read back through the same
 * letterbox band the preprocess wrote (T974), returned as a byte view over the float
 * buffer exactly as depth does.
 */
export function matteToFloats(
  matte: Float32Array,
  side: number,
  width: number,
  height: number,
): Uint8Array {
  const aspect = width / Math.max(height, 1);
  const [occX, occY] = aspect >= 1 ? [1, 1 / aspect] : [aspect, 1];
  const floats = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const u = ((x + 0.5) / width - 0.5) * occX + 0.5;
      const v = ((y + 0.5) / height - 0.5) * occY + 0.5;
      const sx = Math.min(side - 1, Math.max(0, Math.floor(u * side)));
      const sy = Math.min(side - 1, Math.max(0, Math.floor(v * side)));
      const raw = matte[sy * side + sx];
      floats[y * width + x] = raw !== undefined && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0;
    }
  }
  return new Uint8Array(floats.buffer);
}

/**
 * The identity a Matte node publishes with no model, and its MEANING is the point:
 * ZERO everywhere — "nobody is here". A masked composite shows nothing of the subject
 * layer, the document renders, and the no-model state and the empty-frame state are the
 * same picture (§T715, pose's own precedent).
 */
export function neutralMatte(width: number, height: number): Uint8Array {
  return new Uint8Array(new Float32Array(width * height).buffer);
}

/**
 * T957 — the temporal EMA, the worker-local half. MODNet is per-frame and its edges
 * flicker; the recurrent models that fix this properly are blocked (§T981: the seam is
 * single-tensor; RVM is GPL besides). An exponential moving average over the matte —
 * kept per session in the worker, the SAME state slot §T981's design would use — buys
 * temporal stability at a stated cost: edges lag a fast-moving subject by a few frames.
 * `alpha` is the blend toward the NEW frame; 1 disables smoothing.
 */
export function smoothMatte(
  previous: Float32Array | undefined,
  next: Float32Array,
  alpha: number,
): Float32Array {
  if (previous === undefined || previous.length !== next.length || alpha >= 1) return next;
  const a = Math.min(1, Math.max(0.05, alpha));
  for (let i = 0; i < next.length; i += 1) {
    next[i] = previous[i]! + (next[i]! - previous[i]!) * a;
  }
  return next;
}
