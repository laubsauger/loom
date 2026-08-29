import type { TextureFormat } from "../../domain/types/node-definition.ts";
import type { RenderedFrame } from "./render-harness.ts";

/**
 * Pixel comparison with a STATED tolerance, and the reasoning for the number.
 *
 * Tolerances are not a knob to turn until a test goes green. Three regimes exist and they
 * mean different things:
 *
 *  - `TOLERANCE_EXACT` (0). Same device, same driver, same submitted commands. Any
 *    difference at all is a bug — a stale bind, an un-cleared target, a swap in the wrong
 *    place. Deterministic replay (§V45) and the offscreen-vs-canvas case (§V47) both live
 *    here, and both would be pointless at any other tolerance.
 *
 *  - `TOLERANCE_CROSS_GPU` (1/255 per channel). Two different WebGPU implementations
 *    running the same WGSL. WGSL does not pin fp32 contraction, transcendental accuracy is
 *    specified only to a ULP budget, and texture filtering weights are allowed 8 bits of
 *    precision — so an FMA fused on one backend and not on another, or a `pow` off by a
 *    ULP, lands on a neighbouring 8-bit quantum. One quantum is the smallest difference an
 *    rgba8unorm target can even represent; anything larger is a real disagreement, not
 *    float noise.
 *
 *  - `TOLERANCE_CROSS_GPU_HDR` (2^-10, ~0.001). The same argument in rgba16float, where a
 *    half's relative precision near 1.0 is 2^-10. Expressed as a relative bound because a
 *    fixed absolute epsilon is meaningless across an HDR range.
 *
 * Deliberately absent: a "percentage of pixels allowed to differ" knob. A blur chain that
 * is wrong in one corner is wrong, and a budget of failing pixels is how that gets shipped.
 */

export const TOLERANCE_EXACT = 0;
export const TOLERANCE_CROSS_GPU = 1 / 255;
export const TOLERANCE_CROSS_GPU_HDR = 1 / 1024;

/** IEEE-754 binary16 -> number. Handles subnormals, infinities and NaN. */
export function decodeHalf(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (mantissa + 1024) * 2 ** (exponent - 25);
}

/**
 * Raw target bytes -> component values in the units the format actually carries.
 *
 * unorm formats are normalised to [0,1] so a tolerance means the same thing in both
 * regimes; float formats are passed through, because rescaling HDR would be a lie.
 */
export function decodeComponents(bytes: Uint8Array, format: TextureFormat): Float64Array {
  switch (format) {
    case "rgba8unorm":
    case "rgba8unorm-srgb": {
      const out = new Float64Array(bytes.length);
      for (let i = 0; i < bytes.length; i += 1) out[i] = (bytes[i] ?? 0) / 255;
      return out;
    }
    case "rgba16float": {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const count = Math.floor(bytes.byteLength / 2);
      const out = new Float64Array(count);
      for (let i = 0; i < count; i += 1) out[i] = decodeHalf(view.getUint16(i * 2, true));
      return out;
    }
    case "r32float": {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const count = Math.floor(bytes.byteLength / 4);
      const out = new Float64Array(count);
      for (let i = 0; i < count; i += 1) out[i] = view.getFloat32(i * 4, true);
      return out;
    }
    case "depth24plus":
      throw new Error("depth24plus is not a readable colour format (§V51).");
  }
}

export interface PixelDifference {
  readonly matches: boolean;
  /** Largest absolute component difference anywhere in the image. */
  readonly maxAbsolute: number;
  /** Mean absolute component difference; distinguishes "one bad texel" from "all of it". */
  readonly meanAbsolute: number;
  /** How many components exceeded the tolerance. */
  readonly failingComponents: number;
  readonly totalComponents: number;
  /** Human-readable first offender, for the assertion message. */
  readonly firstFailure?: {
    readonly index: number;
    readonly pixel: number;
    readonly channel: number;
    readonly expected: number;
    readonly actual: number;
  };
  /** Set when the two frames are not even comparable. */
  readonly incompatible?: string;
}

export function compareFrames(
  expected: RenderedFrame,
  actual: RenderedFrame,
  tolerance: number,
): PixelDifference {
  const empty = {
    matches: false,
    maxAbsolute: Number.POSITIVE_INFINITY,
    meanAbsolute: Number.POSITIVE_INFINITY,
    failingComponents: 0,
    totalComponents: 0,
  } as const;

  if (expected.format !== actual.format) {
    return { ...empty, incompatible: `format ${expected.format} vs ${actual.format}` };
  }
  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      ...empty,
      incompatible: `size ${expected.width}x${expected.height} vs ${actual.width}x${actual.height}`,
    };
  }
  if (expected.bytes.byteLength !== actual.bytes.byteLength) {
    return {
      ...empty,
      incompatible: `byte length ${expected.bytes.byteLength} vs ${actual.bytes.byteLength}`,
    };
  }

  const a = decodeComponents(expected.bytes, expected.format);
  const b = decodeComponents(actual.bytes, actual.format);

  let maxAbsolute = 0;
  let sum = 0;
  let failing = 0;
  let firstFailure: PixelDifference["firstFailure"];

  for (let i = 0; i < a.length; i += 1) {
    const lhs = a[i] ?? 0;
    const rhs = b[i] ?? 0;
    const diff = Math.abs(lhs - rhs);
    sum += diff;
    if (diff > maxAbsolute) maxAbsolute = diff;
    if (diff > tolerance) {
      failing += 1;
      firstFailure ??= {
        index: i,
        pixel: Math.floor(i / 4),
        channel: i % 4,
        expected: lhs,
        actual: rhs,
      };
    }
  }

  return {
    matches: failing === 0,
    maxAbsolute,
    meanAbsolute: a.length === 0 ? 0 : sum / a.length,
    failingComponents: failing,
    totalComponents: a.length,
    ...(firstFailure === undefined ? {} : { firstFailure }),
  };
}

/** A message worth reading when a comparison fails, instead of "expected true to be false". */
export function describeDifference(label: string, difference: PixelDifference): string {
  if (difference.incompatible !== undefined) {
    return `${label}: frames are not comparable (${difference.incompatible}).`;
  }
  const first = difference.firstFailure;
  const where =
    first === undefined
      ? ""
      : ` First at pixel ${first.pixel} channel ${first.channel}: ` +
        `expected ${first.expected.toFixed(6)}, got ${first.actual.toFixed(6)}.`;
  return (
    `${label}: ${difference.failingComponents}/${difference.totalComponents} components ` +
    `outside tolerance. max=${difference.maxAbsolute.toFixed(6)} ` +
    `mean=${difference.meanAbsolute.toFixed(6)}.${where}`
  );
}

/** Component values of one pixel, for a spot assertion that says what it is checking. */
export function pixelAt(frame: RenderedFrame, x: number, y: number): ReadonlyArray<number> {
  const components = decodeComponents(frame.bytes, frame.format);
  const perPixel = frame.format === "r32float" ? 1 : 4;
  const base = (y * frame.width + x) * perPixel;
  const out: number[] = [];
  for (let c = 0; c < perPixel; c += 1) out.push(components[base + c] ?? Number.NaN);
  return out;
}

/**
 * A stable, compact digest of an image.
 *
 * Reference snapshots are stored as digests plus a handful of probe pixels rather than as
 * committed PNGs: a binary blob in the tree cannot be reviewed, and the moment it fails on
 * someone's laptop the reflex is to re-record it. A digest plus named probes forces the
 * question "did the picture change, and where" to be answered in the diff.
 *
 * FNV-1a over the raw bytes: no crypto dependency, and collisions are irrelevant here
 * because the digest never guards a security boundary.
 */
export function imageDigest(frame: RenderedFrame): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < frame.bytes.length; i += 1) {
    hash ^= frame.bytes[i] ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${frame.width}x${frame.height}:${frame.format}:${hash.toString(16).padStart(8, "0")}`;
}
