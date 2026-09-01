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
 * Our `vec4f` scratch -> MoveNet's `input`, NHWC int32 in 0..255.
 *
 * Two differences from depth that are easy to carry over wrongly: the layout is
 * INTERLEAVED (NHWC), not planar, and the values are BYTE RANGE integers with no mean or
 * standard deviation applied. Feeding it normalised float would put every channel near
 * zero and the model would confidently find a person-shaped nothing.
 */
export function packPoseInput(texels: Float32Array, side: number): Int32Array {
  const pixels = side * side;
  const out = new Int32Array(pixels * 3);
  for (let i = 0; i < pixels; i += 1) {
    const base = i * 4;
    for (let c = 0; c < 3; c += 1) {
      const value = texels[base + c] ?? 0;
      const byte = Math.round(Math.max(0, Math.min(1, value)) * 255);
      out[i * 3 + c] = byte;
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
 * Half-float rather than 8-bit on purpose — a byte would quantise a joint to about 7
 * pixels at 1080p, which reads as a permanent tremor on every limb. Half gives ~1/2048,
 * comfortably under the model's own jitter.
 */
export function keypointsToTexture(output: Float32Array): Uint8Array {
  const bytes = new Uint8Array(POSE_KEYPOINT_COUNT * 8);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < POSE_KEYPOINT_COUNT; i += 1) {
    // The model's triple is (y, x, score). Reading it as (x, y) mirrors the skeleton
    // through the diagonal — a person who looks plausible and is wrong.
    const y = output[i * 3] ?? 0;
    const x = output[i * 3 + 1] ?? 0;
    const score = output[i * 3 + 2] ?? 0;
    const at = i * 8;
    view.setUint16(at, toHalf(Number.isFinite(x) ? x : 0), true);
    view.setUint16(at + 2, toHalf(Number.isFinite(y) ? y : 0), true);
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
