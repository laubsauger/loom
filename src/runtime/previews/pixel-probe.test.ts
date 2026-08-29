import { describe, expect, it } from "vitest";
import { decodeHalf, decodePixel } from "./pixel-probe.ts";
import type { ReadbackImage } from "./pixel-probe.ts";

function image(partial: Partial<ReadbackImage> & Pick<ReadbackImage, "format" | "bytes">): ReadbackImage {
  return {
    width: partial.width ?? 1,
    height: partial.height ?? 1,
    rowStride: partial.rowStride ?? 0,
    format: partial.format,
    bytes: partial.bytes,
  };
}

function halfBytes(values: ReadonlyArray<number>): Uint8Array {
  const buffer = new ArrayBuffer(values.length * 2);
  const view = new DataView(buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  return new Uint8Array(buffer);
}

describe("half float decoding", () => {
  it("decodes the values a preview will actually meet", () => {
    expect(decodeHalf(0x0000)).toBe(0);
    expect(decodeHalf(0x3c00)).toBe(1);
    expect(decodeHalf(0xbc00)).toBe(-1);
    expect(decodeHalf(0x3800)).toBe(0.5);
    expect(decodeHalf(0x7c00)).toBe(Infinity);
    expect(decodeHalf(0xfc00)).toBe(-Infinity);
    expect(Number.isNaN(decodeHalf(0x7e00))).toBe(true);
  });

  it("decodes subnormals rather than flushing them to zero", () => {
    expect(decodeHalf(0x0001)).toBeCloseTo(Math.pow(2, -24), 12);
  });
});

describe("pixel decoding (§V60 — descriptor plus bytes, never bare bytes)", () => {
  it("decodes rgba8unorm as stored linear values", () => {
    const sample = decodePixel(
      image({ format: "rgba8unorm", bytes: new Uint8Array([255, 128, 0, 255]) }),
      0,
      0,
    );
    expect(sample?.rgba[0]).toBe(1);
    expect(sample?.rgba[1]).toBeCloseTo(128 / 255, 6);
    expect(sample?.rgba[3]).toBe(1);
  });

  it("decodes an srgb texture to the LINEAR working space, leaving alpha alone", () => {
    // §V56 — the project works in linear. Reporting encoded bytes would make the readout
    // disagree with every number the graph actually operates on. Alpha is never encoded.
    const sample = decodePixel(
      image({ format: "rgba8unorm-srgb", bytes: new Uint8Array([188, 188, 188, 128]) }),
      0,
      0,
    );
    expect(sample?.rgba[0]).toBeCloseTo(0.5, 2);
    expect(sample?.rgba[3]).toBeCloseTo(128 / 255, 6);
  });

  it("decodes rgba16float, including values a preview flags as broken", () => {
    const sample = decodePixel(
      image({ format: "rgba16float", bytes: halfBytes([0x3c00, 0x7c00, 0x7e00, 0x3800]) }),
      0,
      0,
    );
    expect(sample?.rgba[0]).toBe(1);
    expect(sample?.rgba[1]).toBe(Infinity);
    expect(Number.isNaN(sample?.rgba[2] ?? 0)).toBe(true);
    expect(sample?.rgba[3]).toBe(0.5);
  });

  it("reports r32float as one channel, not as grey", () => {
    // A data texture's green and blue are not zero — they do not exist. Reporting a guess
    // would be worse than reporting nothing.
    const buffer = new ArrayBuffer(4);
    new DataView(buffer).setFloat32(0, -2.5, true);
    const sample = decodePixel(
      image({ format: "r32float", bytes: new Uint8Array(buffer) }),
      0,
      0,
    );
    expect(sample?.rgba).toEqual([-2.5, 0, 0, 1]);
  });

  it("honours row stride rather than assuming width * bytesPerPixel", () => {
    // Padded rows are the single most common source of "the colours are shifted" bugs.
    const bytes = new Uint8Array(2 * 8);
    bytes.set([9, 9, 9, 9, 0, 0, 0, 0], 0);
    bytes.set([1, 2, 3, 4, 0, 0, 0, 0], 8);
    const sample = decodePixel(
      image({ format: "rgba8unorm", width: 1, height: 2, rowStride: 8, bytes }),
      0,
      1,
    );
    expect(sample?.rgba[0]).toBeCloseTo(1 / 255, 6);
  });

  it("returns null when the cursor leaves the picture, rather than throwing", () => {
    const source = image({ format: "rgba8unorm", bytes: new Uint8Array([1, 2, 3, 4]) });
    expect(decodePixel(source, 1, 0)).toBeNull();
    expect(decodePixel(source, -1, 0)).toBeNull();
    expect(decodePixel(source, 0.5, 0)).toBeNull();
  });

  it("refuses a depth format instead of inventing a colour for it", () => {
    expect(
      decodePixel(image({ format: "depth24plus", bytes: new Uint8Array(4) }), 0, 0),
    ).toBeNull();
  });
});
