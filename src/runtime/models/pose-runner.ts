/**
 * MoveNet SinglePose Lightning, run through onnxruntime-web (T743, T386).
 *
 * The conversions live here as pure functions for the same reason depth's do: they are
 * where pose silently goes wrong, and every mistake yields a skeleton that looks like a
 * skeleton. MoveNet's output is ordered `(y, x, score)` — transposed against every
 * instinct — and its input is `int32` in 0..255, not normalised float. Neither error
 * throws; both produce a confident, wrong person.
 */

/** COCO order, from the model's own `config.json` id2label. The graph shows these names. */
export const POSE_KEYPOINTS = [
  "nose", "left_eye", "right_eye", "left_ear", "right_ear",
  "left_shoulder", "right_shoulder", "left_elbow", "right_elbow",
  "left_wrist", "right_wrist", "left_hip", "right_hip",
  "left_knee", "right_knee", "left_ankle", "right_ankle",
] as const;

export const POSE_KEYPOINT_COUNT = POSE_KEYPOINTS.length;
/** SinglePose LIGHTNING is 192; Thunder would be 256. Not a tunable — the graph is fixed. */
export const POSE_INPUT_SIDE = 192;

/**
 * The model's REAL input signature, read from the model rather than from its documentation.
 *
 * Measured 2026-09-01 by loading the pinned weights under onnxruntime-web:
 *
 *   pixel_values: uint8  [batch_size, 192, 192, 4]
 *   keypoints:    float32 [1, 1, 17, 3]
 *
 * This is NOT what MoveNet's upstream card describes — the TensorFlow original takes
 * `int32 [1,192,192,3]`, and that is what the first version of this file packed. The web
 * export takes UNSIGNED BYTES and FOUR channels. ORT refuses the mismatch outright
 * ("Unexpected input data type. Actual: (tensor(int32)), expected: (tensor(uint8))"), so
 * pose could never have produced a single result — a whole node that cannot run, shipped
 * green, because every gate around it stopped at the model's edge.
 *
 * The shape lives here as one constant and the packer derives from it, so the two cannot
 * drift apart again.
 */
export const POSE_INPUT_DTYPE = "uint8" as const;
export const POSE_INPUT_CHANNELS = 4;

/**
 * Our `vec4f` scratch -> MoveNet's `pixel_values`, NHWC uint8 in 0..255.
 *
 * Two differences from depth that are easy to carry over wrongly: the layout is
 * INTERLEAVED (NHWC), not planar, and the values are BYTE RANGE with no mean or standard
 * deviation applied. Feeding it normalised float would put every channel near zero and the
 * model would confidently find a person-shaped nothing.
 */
export function packPoseInput(texels: Float32Array, side: number): Uint8Array {
  const pixels = side * side;
  const out = new Uint8Array(pixels * POSE_INPUT_CHANNELS);
  for (let i = 0; i < pixels; i += 1) {
    const base = i * 4;
    for (let c = 0; c < POSE_INPUT_CHANNELS; c += 1) {
      const value = texels[base + c] ?? 0;
      out[i * POSE_INPUT_CHANNELS + c] = Math.round(Math.max(0, Math.min(1, value)) * 255);
    }
  }
  return out;
}

/** IEEE-754 binary16. Written out because a wrong exponent here is a silent misplacement. */
export function toHalf(value: number): number {
  const buffer = new DataView(new ArrayBuffer(4));
  buffer.setFloat32(0, value, true);
  const bits = buffer.getUint32(0, true);
  const sign = (bits >>> 16) & 0x8000;
  let exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (mantissa === 0 ? 0 : 0x200); // Inf / NaN
  exponent = exponent - 127 + 15;
  if (exponent >= 0x1f) return sign | 0x7c00; // overflow -> Inf
  if (exponent <= 0) {
    if (exponent < -10) return sign; // underflow -> zero
    mantissa = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | (mantissa >>> 13);
  }
  return sign | (exponent << 10) | (mantissa >>> 13);
}

/**
 * MoveNet's `(y, x, score)` triples -> a 17x1 `rgba16float` texture, one texel per joint.
 *
 * R and G are the keypoint's x and y NORMALISED ACROSS THE FRAME, B is confidence, A is
 * 1. `pointsFromTexture` in Value mode reads exactly this: texel i is point i, by index.
 *
 * T992 — UN-LETTERBOXED here, and this is the letterbox's other half: the preprocess
 * fits the picture into the model square with bars (T974's rule, the seam's shared
 * WGSL), so the model reports joints in LETTERBOXED uv, and a joint at model uv `m` is
 * at frame uv `(m - 0.5) / occ + 0.5` — `occOf` from depth-runner is the WGSL's
 * float64 twin, one formula on both ends. Shipping the letterbox WITHOUT this half
 * would put every joint off by the bar width, plausibly (the dangerous kind, §T992),
 * which is why the two halves land in one change and the source size rides the run
 * request to reach this encoder at all.
 *
 * Joints the model parks in the bars (numerically possible on a noisy frame) clamp to
 * the frame edge rather than leaving [0, 1] — an off-frame joint would park its point
 * at a coordinate `pointsFromTexture` would still draw.
 *
 * Half-float rather than 8-bit on purpose — a byte would quantise a joint to about 7
 * pixels at 1080p, which reads as a permanent tremor on every limb. Half gives ~1/2048,
 * comfortably under the model's own jitter.
 */
export function keypointsToTexture(
  output: Float32Array,
  sourceWidth: number,
  sourceHeight: number,
): Uint8Array {
  const aspect = sourceWidth / Math.max(sourceHeight, 1);
  const [occX, occY] = aspect >= 1 ? [1, 1 / aspect] : [aspect, 1];
  const unbox = (value: number, occ: number): number =>
    Math.min(1, Math.max(0, (value - 0.5) / occ + 0.5));
  const bytes = new Uint8Array(POSE_KEYPOINT_COUNT * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < POSE_KEYPOINT_COUNT; i += 1) {
    // The model's triple is (y, x, score). Reading it as (x, y) mirrors the skeleton
    // through the diagonal — a person who looks plausible and is wrong.
    const y = output[i * 3] ?? 0;
    const x = output[i * 3 + 1] ?? 0;
    const score = output[i * 3 + 2] ?? 0;
    const at = i * 8;
    view.setUint16(at, toHalf(Number.isFinite(x) ? unbox(x, occX) : 0), true);
    view.setUint16(at + 2, toHalf(Number.isFinite(y) ? unbox(y, occY) : 0), true);
    view.setUint16(at + 4, toHalf(Number.isFinite(score) ? score : 0), true);
    view.setUint16(at + 6, toHalf(1), true);
  }
  return bytes;
}

/**
 * The identity: every joint at zero CONFIDENCE.
 *
 * Not an invented pose — it is byte-for-byte the state the model itself produces when
 * nobody is in shot, so `pointsFromTexture` parks every point and nothing is drawn. That
 * is why the no-model path needs no special case: it reuses a state pose must handle
 * anyway. A canonical T-pose here would be a person who is not there (§V147).
 */
export function neutralPose(): Uint8Array {
  const bytes = new Uint8Array(POSE_KEYPOINT_COUNT * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < POSE_KEYPOINT_COUNT; i += 1) view.setUint16(i * 8 + 6, toHalf(1), true);
  return bytes;
}
