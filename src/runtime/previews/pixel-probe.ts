import type { TextureFormat } from "../../domain/types/node-definition.ts";
import type { PreviewOutputRef } from "./types.ts";

/**
 * Explicit pixel inspection (T36) — the ONE readback previews are allowed.
 *
 * §V7 keeps previews GPU→GPU and permits readback "for export, inspect or test only". The
 * viewer's "value under the cursor" is exactly the inspect case, so it is allowed — but the
 * shape matters as much as the permission:
 *
 *  - It reads a WINDOW, normally 1x1, not a frame. Pulling 1280x720x8 bytes across the bus to
 *    report four numbers would be the right permission with the wrong implementation.
 *  - It returns a DESCRIPTOR plus bytes (§V60), never a bare `Uint8Array`. A caller cannot
 *    decode 8 bytes without knowing the format and the row stride, and every past bug in this
 *    area has been someone assuming rgba8.
 *  - It is a separate interface from anything the frame loop touches, implemented by the
 *    export module (§V48, track N / T68 / T82). This file declares the shape the viewer
 *    consumes and the decoding the viewer needs; it is imported by NO module on the
 *    scheduling path, which `no-readback.test.ts` asserts.
 */

/** §V60 — a readback is bytes plus everything needed to interpret them. */
export interface ReadbackImage {
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormat;
  /** Bytes per row, which is NOT `width * bytesPerPixel` once the API pads rows. */
  readonly rowStride: number;
  readonly bytes: Uint8Array;
}

export interface PixelWindow {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * What the viewer needs from the export interface. T68 supplies the implementation; this
 * declaration is what lets the viewer be built and tested before it exists.
 */
export interface PixelProbe {
  read(ref: PreviewOutputRef, window: PixelWindow): Promise<ReadbackImage>;
}

/** A decoded pixel, in the project's LINEAR working space (§V56). */
export interface PixelSample {
  readonly x: number;
  readonly y: number;
  readonly rgba: readonly [number, number, number, number];
  readonly format: TextureFormat;
}

export const BYTES_PER_PIXEL: Readonly<Record<TextureFormat, number>> = {
  rgba8unorm: 4,
  "rgba8unorm-srgb": 4,
  rgba16float: 8,
  r32float: 4,
  depth24plus: 4,
};

/** sRGB EOTF. `rgba8unorm-srgb` stores encoded bytes; the working space is linear (§V56). */
function srgbToLinear(value: number): number {
  return value <= 0.04045 ? value / 12.92 : Math.pow((value + 0.055) / 1.055, 2.4);
}

/**
 * IEEE 754 binary16 -> number.
 *
 * Written out rather than routed through a `Float16Array`: that type is too new to assume in
 * the §C baseline, and a wrong half decode is the kind of bug that looks like a rendering
 * problem for a week.
 */
export function decodeHalf(bits: number): number {
  const sign = (bits & 0x8000) === 0 ? 1 : -1;
  const exponent = (bits >> 10) & 0x1f;
  const mantissa = bits & 0x03ff;
  if (exponent === 0) return sign * mantissa * Math.pow(2, -24);
  if (exponent === 0x1f) return mantissa === 0 ? sign * Infinity : Number.NaN;
  return sign * (mantissa + 1024) * Math.pow(2, exponent - 25);
}

/**
 * Decode one pixel out of a readback.
 *
 * Returns `null` rather than throwing for an out-of-range coordinate or a depth format: the
 * caller is a pointer moving across an image, and "the cursor left the picture" is a normal
 * event, not an error.
 */
export function decodePixel(image: ReadbackImage, x: number, y: number): PixelSample | null {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (x < 0 || y < 0 || x >= image.width || y >= image.height) return null;
  if (image.format === "depth24plus") return null;

  const stride = image.rowStride > 0 ? image.rowStride : image.width * BYTES_PER_PIXEL[image.format];
  const offset = y * stride + x * BYTES_PER_PIXEL[image.format];
  const bytes = image.bytes;
  if (offset + BYTES_PER_PIXEL[image.format] > bytes.byteLength) return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  if (image.format === "rgba8unorm" || image.format === "rgba8unorm-srgb") {
    const raw = [0, 1, 2, 3].map((channel) => (bytes[offset + channel] ?? 0) / 255);
    const [r = 0, g = 0, b = 0, a = 0] = raw;
    const decode = image.format === "rgba8unorm-srgb" ? srgbToLinear : (value: number) => value;
    // Alpha is never encoded, in any sRGB variant. Decoding it would be a real, silent error.
    return { x, y, rgba: [decode(r), decode(g), decode(b), a], format: image.format };
  }

  if (image.format === "rgba16float") {
    const channels = [0, 1, 2, 3].map((channel) =>
      decodeHalf(view.getUint16(offset + channel * 2, true)),
    );
    const [r = 0, g = 0, b = 0, a = 0] = channels;
    return { x, y, rgba: [r, g, b, a], format: image.format };
  }

  // r32float carries one channel. Reporting it as grey would be a guess about what the data
  // means; a data texture's green and blue are not zero, they do not exist.
  const value = view.getFloat32(offset, true);
  return { x, y, rgba: [value, 0, 0, 1], format: image.format };
}
