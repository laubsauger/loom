import { describe, expect, it } from "vitest";

import type { ReadbackImage } from "../../../domain/types/backend.ts";
import { ExportError } from "../types.ts";
import { YUV10_COLOR_SPACE, toI420P10 } from "./yuv10.ts";

/**
 * T1741b — the 10-bit path's source. The property that matters is that 10-bit codes come
 * out of values 8 bits cannot tell apart: if this conversion quantised to bytes anywhere,
 * the HEVC file would band exactly like the H.264 one and nothing else would notice.
 * Every expected code below is derived from BT.709 limited range by hand.
 */

/** IEEE binary16 bits for a value exactly representable in half precision. */
function halfBits(value: number): number {
  if (value === 0) return 0;
  const exponent = Math.floor(Math.log2(value));
  const mantissa = Math.round((value / 2 ** exponent - 1) * 1024);
  return ((exponent + 15) << 10) | mantissa;
}

/** An rgba16float readback with padded rows, filled per pixel. */
function halfImage(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number],
  padding = 24,
): ReadbackImage {
  const rowStride = width * 8 + padding;
  const bytes = new Uint8Array(rowStride * height);
  const view = new DataView(bytes.buffer);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const [r, g, b] = pixel(x, y);
      const at = y * rowStride + x * 8;
      view.setUint16(at, halfBits(r), true);
      view.setUint16(at + 2, halfBits(g), true);
      view.setUint16(at + 4, halfBits(b), true);
      view.setUint16(at + 6, halfBits(1), true);
    }
    // Garbage in the padding: a reader that ignores rowStride reads it as pixels.
    bytes.fill(0x7b, y * rowStride + width * 8, (y + 1) * rowStride);
  }
  return { width, height, format: "rgba16float", rowStride, bytes };
}

function planes(image: { width: number; height: number; data: Uint16Array }) {
  const luma = image.width * image.height;
  const chroma = luma / 4;
  return {
    y: Array.from(image.data.subarray(0, luma)),
    u: Array.from(image.data.subarray(luma, luma + chroma)),
    v: Array.from(image.data.subarray(luma + chroma)),
  };
}

describe("BT.709 limited range, 10-bit", () => {
  it("puts black at 64, white at 940 and grey on neutral chroma 512", () => {
    const black = planes(toI420P10(halfImage(2, 2, () => [0, 0, 0]), "encoded"));
    expect(black).toEqual({ y: [64, 64, 64, 64], u: [512], v: [512] });
    const white = planes(toI420P10(halfImage(2, 2, () => [1, 1, 1]), "encoded"));
    expect(white).toEqual({ y: [940, 940, 940, 940], u: [512], v: [512] });
  });

  it("puts a primary where the BT.709 matrix does", () => {
    // Red: Y' = 0.2126 → 64 + 876·0.2126 = 250.24; Cb = −0.2126/1.8556 → 512 − 102.65 = 409.35;
    // Cr = 0.7874/1.5748 = 0.5 → 512 + 448 = 960.
    expect(planes(toI420P10(halfImage(2, 2, () => [1, 0, 0]), "encoded"))).toEqual({
      y: [250, 250, 250, 250], u: [409], v: [960],
    });
  });

  it("averages chroma over each 2x2 block and keeps luma per pixel", () => {
    // Left column red, right column blue. Y per pixel; the block's chroma is the mean colour
    // (0.5, 0, 0.5): Y' = 0.1424, Cb = 0.3576/1.8556 → 684.67, Cr = 0.3576/1.5748 → 715.46.
    const image = toI420P10(halfImage(2, 2, (x) => (x === 0 ? [1, 0, 0] : [0, 0, 1])), "encoded");
    // Blue: Y' = 0.0722 → 64 + 63.25 = 127.25.
    expect(planes(image)).toEqual({ y: [250, 127, 250, 127], u: [685], v: [715] });
  });

  it("tags the planes with the colour space they were computed in", () => {
    const image = toI420P10(halfImage(2, 2, () => [0, 0, 0]), "encoded");
    expect(image.colorSpace).toEqual({ primaries: "bt709", transfer: "iec61966-2-1", matrix: "bt709", fullRange: false });
    expect(image.colorSpace).toBe(YUV10_COLOR_SPACE);
  });
});

describe("it carries more than 8 bits", () => {
  it("gives distinct 10-bit codes to grey levels that share one 8-bit code", () => {
    // 0.25, 0.25 + 1/1024, 0.25 + 2/1024, 0.25 + 3/1024: all four are exact in binary16 and
    // all round to byte 64 (63.75 … 64.5 → 64, 64, 64, 64 with the third at 64.49).
    const levels = [0.25, 0.25 + 1 / 1024, 0.25 + 2 / 1024, 0.25 + 3 / 1024];
    expect(levels.map((level) => Math.round(level * 255))).toEqual([64, 64, 64, 64]);
    const image = toI420P10(halfImage(8, 2, (x) => {
      const level = levels[Math.floor(x / 2)]!;
      return [level, level, level];
    }), "encoded");
    // Y = 64 + 876·level: 283, 283.86, 284.71, 285.57 → four codes where 8 bits had one.
    const row = planes(image).y.slice(0, 8);
    expect(row).toEqual([283, 283, 284, 284, 285, 285, 286, 286]);
    expect(new Set(row).size).toBe(4);
  });

  it("sRGB-encodes a linear Output first, as every 8-bit export path does", () => {
    // Linear 0.214041 is sRGB 0.5 (to within half precision): Y = 64 + 876·0.5 = 502.
    const image = toI420P10(halfImage(2, 2, () => [0.2140411, 0.2140411, 0.2140411]), "linear");
    expect(planes(image).y).toEqual([502, 502, 502, 502]);
  });

  it("clamps out-of-range values instead of wrapping them", () => {
    const image = toI420P10(halfImage(2, 2, () => [4, 4, 4]), "encoded");
    expect(planes(image).y).toEqual([940, 940, 940, 940]);
  });
});

describe("what it refuses", () => {
  it("refuses an 8-bit Output, the one source that would make the label a lie", () => {
    for (const format of ["rgba8unorm", "rgba8unorm-srgb"] as const) {
      const image: ReadbackImage = { width: 2, height: 2, format, rowStride: 8, bytes: new Uint8Array(16) };
      expect(() => toI420P10(image, "encoded")).toThrow(ExportError);
      expect(() => toI420P10(image, "encoded")).toThrow(new RegExp(`this one is ${format}`));
    }
  });

  it("refuses an odd size, which 4:2:0 cannot represent", () => {
    expect(() => toI420P10(halfImage(3, 2, () => [0, 0, 0]), "encoded")).toThrow(/even width and height/);
  });

  it("refuses a readback shorter than its declared rows", () => {
    const image = halfImage(2, 2, () => [0, 0, 0]);
    expect(() => toI420P10({ ...image, bytes: image.bytes.subarray(0, 20) }, "encoded")).toThrow(/shorter than its rows/);
  });
});
