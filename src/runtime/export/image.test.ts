import { describe, expect, it } from "vitest";
import type { ReadbackImage } from "../../domain/types/backend.ts";
import { decodeToLinear, resizePlane, toRgba8, toRgba8At, transferForSpace } from "./image.ts";
import { linearToSrgb } from "./pixel-format.ts";
import { ExportError } from "./types.ts";

function halfImage(values: ReadonlyArray<number>, rowStride = 8): ReadbackImage {
  const bytes = new Uint8Array(Math.max(rowStride, 8));
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint16(index * 2, value, true));
  return { width: 1, height: 1, format: "rgba16float", rowStride, bytes };
}

describe("the transfer decision is made explicitly, never by accident", () => {
  it("passes ENCODED 8-bit bytes through unchanged", () => {
    // §V56 puts the display transform on the Output node. Once it has run, the target
    // DECLARES `encoded` and the export adds nothing — encoding again is B47 (§V70a's
    // failure wearing a different hat).
    const bytes = new Uint8Array([9, 200, 77, 128]);
    const image: ReadbackImage = {
      width: 1,
      height: 1,
      format: "rgba8unorm",
      rowStride: 4,
      bytes,
    };
    expect([...toRgba8(image, { space: "encoded" }).data]).toEqual([9, 200, 77, 128]);
  });

  it("ENCODES the same 8-bit bytes when they are declared linear (T375/B47)", () => {
    // The identical format, the identical bytes, the opposite answer — because the answer
    // was never the format's to give. This is the pair that used to be one behaviour.
    const bytes = new Uint8Array([55, 55, 55, 255]);
    const image: ReadbackImage = { width: 1, height: 1, format: "rgba8unorm", rowStride: 4, bytes };
    expect([...toRgba8(image, { space: "linear" }).data]).toEqual([128, 128, 128, 255]);
  });

  it("maps a declared space to a transfer in exactly one place", () => {
    // A colour always leaves display-encoded: by the time the transfer runs the plane is
    // linear, whatever the bytes arrived as. Byte-exactness comes from the passthrough
    // path, not from cancelling a decode with a missing encode.
    expect(transferForSpace("linear")).toBe("srgb");
    expect(transferForSpace("encoded")).toBe("srgb");
    // Not a colour: §V56 says data bypasses every conversion.
    expect(transferForSpace("data")).toBe("raw");
  });

  it("passes srgb-typed bytes through unchanged too — they are already encoded", () => {
    const bytes = new Uint8Array([188, 188, 188, 128]);
    const image: ReadbackImage = {
      width: 1,
      height: 1,
      format: "rgba8unorm-srgb",
      rowStride: 4,
      bytes,
    };
    expect([...toRgba8(image, { space: "encoded" }).data]).toEqual([188, 188, 188, 128]);
  });

  it("sRGB-encodes float formats, because 8 bits leaves no honest alternative", () => {
    // 0.5 linear is 188 encoded, not 128. Quantising raw linear floats would make every HDR
    // capture come out visibly dark and look like a rendering bug.
    const encoded = toRgba8(halfImage([0x3800, 0x3800, 0x3800, 0x3c00]), { space: "linear" });
    expect([...encoded.data]).toEqual([188, 188, 188, 255]);
    expect(Math.round(linearToSrgb(0.5) * 255)).toBe(188);
  });

  it("clamps out-of-range and non-finite HDR values rather than writing NaN", () => {
    // 2.0, -1.0, +Inf, NaN. All four are values a real rgba16float buffer holds.
    const encoded = toRgba8(halfImage([0x4000, 0xbc00, 0x7c00, 0x7e00]), { space: "linear" });
    expect([...encoded.data]).toEqual([255, 0, 255, 0]);
  });

  it("honours an explicit raw transfer for a float buffer", () => {
    const encoded = toRgba8(halfImage([0x3800, 0x3800, 0x3800, 0x3c00]), { space: "linear", transfer: "raw" });
    expect([...encoded.data]).toEqual([128, 128, 128, 255]);
  });

  it("replicates r32float across RGB as a display choice, made in one place", () => {
    const bytes = new Uint8Array(4);
    new DataView(bytes.buffer).setFloat32(0, 1, true);
    const image: ReadbackImage = { width: 1, height: 1, format: "r32float", rowStride: 4, bytes };
    expect([...toRgba8(image, { space: "data" }).data]).toEqual([255, 255, 255, 255]);
    // The DECODED plane still reports the honest zeroes — the guess lives only in the encoder.
    expect([...decodeToLinear(image, "data").rgba]).toEqual([1, 0, 0, 1]);
  });

  it("refuses to make a picture out of a depth buffer", () => {
    const image: ReadbackImage = {
      width: 1,
      height: 1,
      format: "depth24plus",
      rowStride: 4,
      bytes: new Uint8Array(4),
    };
    expect(() => toRgba8(image, { space: "data" })).toThrow(ExportError);
  });
});

describe("row stride", () => {
  it("is honoured when decoding, not recomputed from the width", () => {
    const rowStride = 256;
    const bytes = new Uint8Array(rowStride * 2);
    bytes.set([255, 0, 0, 255, 0, 255, 0, 255], 0);
    bytes.set([0, 0, 255, 255, 255, 255, 0, 255], rowStride);
    const image: ReadbackImage = { width: 2, height: 2, format: "rgba8unorm", rowStride, bytes };
    expect([...toRgba8(image, { space: "encoded" }).data]).toEqual([
      255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 0, 255,
    ]);
  });
});

describe("downscaling", () => {
  it("averages in LINEAR space, not over encoded bytes", () => {
    // Averaging sRGB bytes darkens every downscale visibly. A 2x1 of black and white must
    // average to linear 0.5, which encodes to 188 — not to (0+255)/2 = 128.
    const bytes = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255]);
    const image: ReadbackImage = {
      width: 2,
      height: 1,
      format: "rgba8unorm-srgb",
      rowStride: 8,
      bytes,
    };
    const encoded = toRgba8At(image, 1, 1, { space: "encoded" });
    expect(encoded.data[0]).toBe(188);
  });

  it("covers every source pixel exactly once", () => {
    const plane = {
      width: 4,
      height: 1,
      format: "rgba8unorm" as const,
      rgba: Float32Array.from([1, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
    };
    // 1/4 of the source is red; a box filter over 4 -> 1 must report exactly 0.25.
    expect(resizePlane(plane, 1, 1).rgba[0]).toBeCloseTo(0.25, 6);
  });

  it("leaves the plane alone when asked to upscale", () => {
    const plane = {
      width: 2,
      height: 1,
      format: "rgba8unorm" as const,
      rgba: new Float32Array(8),
    };
    expect(resizePlane(plane, 8, 4)).toBe(plane);
  });
});
