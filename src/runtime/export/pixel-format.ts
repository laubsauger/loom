import type { TextureFormat } from "../../domain/types/node-definition.ts";
import { BYTES_PER_PIXEL, decodeHalf } from "../previews/pixel-probe.ts";

/**
 * Pixel-format arithmetic for readback bytes.
 *
 * `BYTES_PER_PIXEL` and `decodeHalf` are re-exported from the preview track's pixel probe
 * rather than reimplemented. Two half-float decoders in one codebase is a real hazard: a
 * wrong subnormal or a wrong NaN encoding looks like a rendering bug for a week, and nothing
 * would ever compare the two implementations. Re-exporting also gives this module one place
 * to change if that file moves.
 */
export { BYTES_PER_PIXEL, decodeHalf };

/** Formats whose bytes carry colour. `depth24plus` is readable but not an image. */
export function isColorFormat(format: TextureFormat): boolean {
  return format !== "depth24plus";
}

/** sRGB EOTF — encoded byte value to linear working space (§V56). */
export function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/** sRGB OETF — linear working space to a display-encoded value. */
export function linearToSrgb(value: number): number {
  // NaN and ±Infinity are real values in an HDR buffer. They must land on a byte, and
  // silently producing NaN here would write a zero via a route nobody can read in the code.
  if (!Number.isFinite(value)) return value > 0 ? 1 : 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value <= 0.0031308 ? value * 12.92 : 1.055 * Math.pow(value, 1 / 2.4) - 0.055;
}

export function clamp01(value: number): number {
  // NaN must land somewhere; 0 is the only choice that cannot brighten an image into a lie.
  if (!Number.isFinite(value)) return value > 0 ? 1 : 0;
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Reads one pixel's four channels out of readback bytes, in the format's OWN space.
 *
 * "Own space" matters: `rgba8unorm-srgb` bytes are encoded and are returned encoded here.
 * Converting them would make the byte-exact PNG passthrough impossible to state honestly.
 * `decodeToLinear` is the layer that applies the transfer function.
 */
export function readChannels(
  bytes: Uint8Array,
  view: DataView,
  offset: number,
  format: TextureFormat,
  out: Float32Array,
): void {
  switch (format) {
    case "rgba8unorm":
    case "rgba8unorm-srgb":
      out[0] = (bytes[offset] ?? 0) / 255;
      out[1] = (bytes[offset + 1] ?? 0) / 255;
      out[2] = (bytes[offset + 2] ?? 0) / 255;
      out[3] = (bytes[offset + 3] ?? 0) / 255;
      return;
    case "rgba16float":
      out[0] = decodeHalf(view.getUint16(offset, true));
      out[1] = decodeHalf(view.getUint16(offset + 2, true));
      out[2] = decodeHalf(view.getUint16(offset + 4, true));
      out[3] = decodeHalf(view.getUint16(offset + 6, true));
      return;
    case "r32float": {
      // One channel. Green and blue are reported as 0 because they DO NOT EXIST (§V57) —
      // an image encoder that wants a visible grey replicates R itself, and says so.
      const value = view.getFloat32(offset, true);
      out[0] = value;
      out[1] = 0;
      out[2] = 0;
      out[3] = 1;
      return;
    }
    case "depth24plus":
      out[0] = 0;
      out[1] = 0;
      out[2] = 0;
      out[3] = 1;
      return;
  }
}
