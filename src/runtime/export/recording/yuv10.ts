import type { ReadbackImage } from "../../../domain/types/backend.ts";
import type { ColorSpace } from "../../../domain/types/ports.ts";
import { BYTES_PER_PIXEL, clamp01, decodeHalf, linearToSrgb } from "../pixel-format.ts";
import { ExportDiagnosticCode, ExportError, exportDiagnostic } from "../types.ts";
import type { I420P10Image, Yuv10ColorSpace } from "./types.ts";

/**
 * Full-precision Output pixels to 10-bit 4:2:0 planes (T1741b).
 *
 * The 8-bit recording path captures the presentation canvas, and that canvas is 8-bit, so
 * no amount of encoder configuration puts more than 256 levels per channel into the file.
 * This is the 10-bit path's source instead: the Output target read back through the export
 * interface (§V48) in its own float format and converted here, on the CPU, into the
 * `I420P10` layout WebCodecs takes (10-bit codes in 16-bit samples).
 *
 * The conversion is BT.709, limited range, and its result says so in `colorSpace`, which the
 * encoder writes into the bitstream:
 *
 *   Y' = 0.2126 R' + 0.7152 G' + 0.0722 B'      Y  = 64  + 876 Y'
 *   Cb = (B' - Y') / 1.8556                      Cb = 512 + 896 Cb
 *   Cr = (R' - Y') / 1.5748                      Cr = 512 + 896 Cr
 *
 * R'G'B' are display-encoded values, exactly what the 8-bit path writes as bytes: an
 * `encoded` Output is taken as it is, a `linear` one is sRGB-encoded, `data` is clamped
 * (`transferForSpace`'s rule). Their transfer is sRGB, and the stream is tagged
 * `iec61966-2-1` because that is what the values carry. Chroma is the average of each
 * 2x2 block.
 *
 * An 8-bit Output is REFUSED, not converted: its codes would land on every fourth 10-bit
 * value and band exactly like the H.264 file, under a 10-bit label.
 */

export const YUV10_COLOR_SPACE: Yuv10ColorSpace = {
  primaries: "bt709",
  transfer: "iec61966-2-1",
  matrix: "bt709",
  fullRange: false,
};

const KR = 0.2126;
const KG = 0.7152;
const KB = 0.0722;
const CB_SCALE = 1.8556;
const CR_SCALE = 1.5748;

function refuse(message: string): ExportError {
  return new ExportError(exportDiagnostic("error", ExportDiagnosticCode.unsupportedFormat, message));
}

/** Half bits to the display-encoded value a colour channel carries, per declared space. */
const halfTables = new Map<ColorSpace, Float32Array>();
function halfTable(space: ColorSpace): Float32Array {
  const existing = halfTables.get(space);
  if (existing !== undefined) return existing;
  const table = new Float32Array(65_536);
  for (let bits = 0; bits < table.length; bits += 1) {
    const value = decodeHalf(bits);
    table[bits] = space === "linear" ? linearToSrgb(value) : clamp01(value);
  }
  halfTables.set(space, table);
  return table;
}

function encodedOf(value: number, space: ColorSpace): number {
  return space === "linear" ? linearToSrgb(value) : clamp01(value);
}

export function toI420P10(image: ReadbackImage, space: ColorSpace): I420P10Image {
  const { width, height, format } = image;
  if (format !== "rgba16float" && format !== "r32float") {
    throw refuse(
      `A 10-bit video frame needs an Output with more than 8 bits per channel; this one is ${format}.`,
    );
  }
  if (width % 2 !== 0 || height % 2 !== 0 || width === 0 || height === 0) {
    throw refuse(`A 4:2:0 video frame needs an even width and height; this Output is ${width}x${height}.`);
  }
  const bytesPerPixel = BYTES_PER_PIXEL[format];
  if (image.rowStride < width * bytesPerPixel || image.bytes.length < image.rowStride * (height - 1) + width * bytesPerPixel) {
    throw refuse(`The ${width}x${height} ${format} readback is shorter than its rows.`);
  }

  const chromaWidth = width / 2;
  const chromaHeight = height / 2;
  const lumaSize = width * height;
  const chromaSize = chromaWidth * chromaHeight;
  const data = new Uint16Array(lumaSize + 2 * chromaSize);
  const view = new DataView(image.bytes.buffer, image.bytes.byteOffset, image.bytes.byteLength);
  const table = format === "rgba16float" ? halfTable(space) : null;

  for (let blockY = 0; blockY < chromaHeight; blockY += 1) {
    for (let blockX = 0; blockX < chromaWidth; blockX += 1) {
      let sumR = 0;
      let sumG = 0;
      let sumB = 0;
      for (let corner = 0; corner < 4; corner += 1) {
        const x = blockX * 2 + (corner & 1);
        const y = blockY * 2 + (corner >> 1);
        const at = y * image.rowStride + x * bytesPerPixel;
        let red: number;
        let green: number;
        let blue: number;
        if (table !== null) {
          red = table[view.getUint16(at, true)]!;
          green = table[view.getUint16(at + 2, true)]!;
          blue = table[view.getUint16(at + 4, true)]!;
        } else {
          // r32float is one channel; a visible grey replicates it, as the PNG path does.
          red = encodedOf(view.getFloat32(at, true), space);
          green = red;
          blue = red;
        }
        sumR += red;
        sumG += green;
        sumB += blue;
        const luma = KR * red + KG * green + KB * blue;
        data[y * width + x] = Math.round(64 + 876 * luma);
      }
      const red = sumR / 4;
      const green = sumG / 4;
      const blue = sumB / 4;
      const luma = KR * red + KG * green + KB * blue;
      const chroma = blockY * chromaWidth + blockX;
      data[lumaSize + chroma] = Math.round(512 + (896 * (blue - luma)) / CB_SCALE);
      data[lumaSize + chromaSize + chroma] = Math.round(512 + (896 * (red - luma)) / CR_SCALE);
    }
  }
  return { width, height, data, colorSpace: YUV10_COLOR_SPACE };
}
