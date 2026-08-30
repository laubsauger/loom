import type { ReadbackImage } from "../../domain/types/backend.ts";
import type { TextureFormat } from "../../domain/types/node-definition.ts";
import type { ColorSpace } from "../../domain/types/ports.ts";
import { BYTES_PER_PIXEL, clamp01, linearToSrgb, readChannels, srgbToLinear } from "./pixel-format.ts";
import { ExportDiagnosticCode, ExportError, exportDiagnostic } from "./types.ts";

/**
 * Readback bytes to an 8-bit image, with the transfer decision made explicitly.
 *
 * The trap here is silent double-encoding, the same one §V70a calls out for the present blit.
 * A PNG has no way to say "these values are linear", so something has to decide.
 *
 * T375/B47: it used to be decided HERE, from the pixel FORMAT — `rgba8unorm` passed through
 * byte-exact, everything else was sRGB-encoded. That was this module's own private answer to
 * a question §V57 already answers on the texture, and it is why the SAME picture exported as
 * 127 from a `rgba16float` project and 55 from an `rgba8unorm` one. The declared SPACE
 * decides now, and it is required rather than derived:
 *
 *  - `encoded` — the bytes ARE display values (the Output node encoded them, or the format
 *    did). Byte-exact passthrough; encoding again is B47.
 *  - `linear` — the bytes are light. A PNG is a display file, so they are display-encoded.
 *  - `data` — not a colour. Clamped, never transferred (§V56).
 *
 * `transfer` overrides all of it when a caller knows better.
 */
export type TransferMode = "raw" | "srgb";

/**
 * THE transfer for a declared space (§V57). One answer, asked by every export path.
 *
 * Note what it is NOT: "encoded means do nothing". By the time a transfer is applied the
 * plane is LINEAR — `decodeToLinear` has already undone whatever the bytes carried, because
 * a resize has to average in linear or every downscale darkens. So a colour is always
 * display-encoded on the way out, and byte-exactness for an already-encoded capture comes
 * from the PASSTHROUGH path, which skips the round trip entirely rather than cancelling it.
 * `data` is the only thing that is never transferred (§V56).
 */
export function transferForSpace(space: ColorSpace): TransferMode {
  return space === "data" ? "raw" : "srgb";
}

/**
 * True when these READBACK BYTES are display values.
 *
 * Two ways that happens and they are not the same fact: the format applied the transfer on
 * write (`-srgb`), or the graph did and said so (`space: "encoded"` — an Output node's
 * target in an 8-bit or float working format). Both mean "do not encode again", and both
 * mean a RESIZE has to decode first or it averages in the wrong space.
 */
function bytesAreEncoded(format: TextureFormat, space: ColorSpace): boolean {
  return format === "rgba8unorm-srgb" || space === "encoded";
}

/** RGBA float image in the format's own space, one Float32 per channel, tightly packed. */
export interface Plane {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` values, row-major, RGBA. */
  readonly rgba: Float32Array;
  /** The format the plane came from, so an encoder can still make format-aware choices. */
  readonly format: TextureFormat;
}

export interface Rgba8Image {
  readonly width: number;
  readonly height: number;
  /** `width * height * 4` bytes, tightly packed, straight (non-premultiplied) alpha. */
  readonly data: Uint8Array;
}

function refuseDepth(format: TextureFormat): void {
  if (format === "depth24plus") {
    throw new ExportError(
      exportDiagnostic(
        "error",
        ExportDiagnosticCode.unsupportedFormat,
        "depth24plus cannot be encoded as an image. Depth is not a colour, and inventing one " +
          "would make a picture that lies about the buffer.",
      ),
    );
  }
}

/**
 * Decode readback bytes into a linear-working-space plane (§V56).
 *
 * Honours `rowStride` rather than assuming `width * bytesPerPixel` — a padded stride is where
 * naive readers break, and the failure (every row after the first shifted) reads as a
 * rendering bug rather than as a decoding bug.
 */
export function decodeToLinear(image: ReadbackImage, space: ColorSpace): Plane {
  refuseDepth(image.format);
  const bytesPerPixel = BYTES_PER_PIXEL[image.format];
  const rgba = new Float32Array(image.width * image.height * 4);
  const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
  const channels = new Float32Array(4);
  const encoded = bytesAreEncoded(image.format, space);

  for (let y = 0; y < image.height; y += 1) {
    const rowStart = y * image.rowStride;
    for (let x = 0; x < image.width; x += 1) {
      readChannels(image.bytes, view, rowStart + x * bytesPerPixel, image.format, channels);
      const out = (y * image.width + x) * 4;
      // Alpha is never encoded, in any sRGB variant. Decoding it is a real, silent error.
      rgba[out] = encoded ? srgbToLinear(channels[0] ?? 0) : (channels[0] ?? 0);
      rgba[out + 1] = encoded ? srgbToLinear(channels[1] ?? 0) : (channels[1] ?? 0);
      rgba[out + 2] = encoded ? srgbToLinear(channels[2] ?? 0) : (channels[2] ?? 0);
      rgba[out + 3] = channels[3] ?? 1;
    }
  }
  return { width: image.width, height: image.height, rgba, format: image.format };
}

/**
 * Box-average downscale. Upscaling is refused by returning the plane unchanged: an export
 * that invents pixels is not a capture of anything.
 */
export function resizePlane(plane: Plane, width: number, height: number): Plane {
  if (width >= plane.width && height >= plane.height) return plane;
  const target = Math.max(1, Math.trunc(width));
  const targetHeight = Math.max(1, Math.trunc(height));
  const rgba = new Float32Array(target * targetHeight * 4);

  for (let y = 0; y < targetHeight; y += 1) {
    const y0 = Math.floor((y * plane.height) / targetHeight);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * plane.height) / targetHeight));
    for (let x = 0; x < target; x += 1) {
      const x0 = Math.floor((x * plane.width) / target);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * plane.width) / target));
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let count = 0;
      for (let sy = y0; sy < y1; sy += 1) {
        for (let sx = x0; sx < x1; sx += 1) {
          const source = (sy * plane.width + sx) * 4;
          r += plane.rgba[source] ?? 0;
          g += plane.rgba[source + 1] ?? 0;
          b += plane.rgba[source + 2] ?? 0;
          a += plane.rgba[source + 3] ?? 0;
          count += 1;
        }
      }
      const out = (y * target + x) * 4;
      // Averaging happens in LINEAR space, which is the whole reason `decodeToLinear` runs
      // first: averaging sRGB bytes darkens every downscale by a visible amount.
      rgba[out] = r / count;
      rgba[out + 1] = g / count;
      rgba[out + 2] = b / count;
      rgba[out + 3] = a / count;
    }
  }
  return { width: target, height: targetHeight, rgba, format: plane.format };
}

/** Fits `width`x`height` inside the bound, preserving aspect. Never upscales. */
export function boundedSize(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
): readonly [number, number] {
  const scale = Math.min(1, maxWidth / width, maxHeight / height);
  if (scale >= 1) return [width, height];
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))];
}

export function encodePlaneToRgba8(plane: Plane, transfer: TransferMode): Rgba8Image {
  const encode = transfer === "srgb" ? linearToSrgb : clamp01;
  const data = new Uint8Array(plane.width * plane.height * 4);
  // r32float has one channel; replicating R across RGB is a DISPLAY choice made here and
  // nowhere else, so a caller reading raw values (decodePixel) still sees the honest zeroes.
  const replicate = plane.format === "r32float";

  for (let index = 0; index < plane.width * plane.height; index += 1) {
    const source = index * 4;
    const red = encode(plane.rgba[source] ?? 0);
    const green = replicate ? red : encode(plane.rgba[source + 1] ?? 0);
    const blue = replicate ? red : encode(plane.rgba[source + 2] ?? 0);
    data[source] = Math.round(red * 255);
    data[source + 1] = Math.round(green * 255);
    data[source + 2] = Math.round(blue * 255);
    data[source + 3] = Math.round(clamp01(plane.rgba[source + 3] ?? 1) * 255);
  }
  return { width: plane.width, height: plane.height, data };
}

/**
 * Byte-exact copy of an 8-bit readback, unpadding rows.
 *
 * Exists so the common screenshot case makes no claim it cannot keep: an `rgba8unorm` capture
 * with no resize comes out of the PNG bit-identical to what the GPU produced. Routing it
 * through decode-and-re-encode would be within a rounding error, which is not the same thing
 * as within zero, and "close enough" is not a property a test can assert.
 */
function passthroughRgba8(image: ReadbackImage): Rgba8Image {
  const data = new Uint8Array(image.width * image.height * 4);
  const rowBytes = image.width * 4;
  for (let y = 0; y < image.height; y += 1) {
    const start = y * image.rowStride;
    data.set(image.bytes.subarray(start, start + rowBytes), y * rowBytes);
  }
  return { width: image.width, height: image.height, data };
}

export interface ToRgba8Options {
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  /**
   * The DECLARED space of what was read (§V57). Required, not defaulted: a default is how
   * B47 happened — every consumer quietly assuming, and three of them assuming differently.
   */
  readonly space: ColorSpace;
  /** Overrides `transferForSpace` when a caller genuinely knows better. */
  readonly transfer?: TransferMode;
}

/**
 * Readback bytes to an 8-bit RGBA image at EXACTLY `width`x`height`.
 *
 * The exact form exists for recording: a video encoder is configured once with a frame size
 * and every frame after that must match it to the pixel. Deriving the size per frame from an
 * aspect-preserving bound would let a rounding difference produce one odd frame, which the
 * encoder rejects halfway through a take.
 */
export function toRgba8At(
  image: ReadbackImage,
  width: number,
  height: number,
  options: Pick<ToRgba8Options, "space" | "transfer">,
): Rgba8Image {
  refuseDepth(image.format);
  const transfer = options.transfer ?? transferForSpace(options.space);
  const eightBit = image.format === "rgba8unorm" || image.format === "rgba8unorm-srgb";
  const unchanged = width === image.width && height === image.height;
  // Byte-exact only when the bytes ARE what the file should hold: 8 bits, no resize,
  // display values already, and no caller asking for something else on top.
  if (
    eightBit &&
    unchanged &&
    options.transfer === undefined &&
    bytesAreEncoded(image.format, options.space)
  ) {
    return passthroughRgba8(image);
  }
  return encodePlaneToRgba8(
    resizePlane(decodeToLinear(image, options.space), width, height),
    transfer,
  );
}

/** Readback bytes to an 8-bit RGBA image, optionally bounded in size (aspect preserved). */
export function toRgba8(image: ReadbackImage, options: ToRgba8Options): Rgba8Image {
  const [width, height] = boundedSize(
    image.width,
    image.height,
    options.maxWidth ?? image.width,
    options.maxHeight ?? image.height,
  );
  return toRgba8At(image, width, height, options);
}
