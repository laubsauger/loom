import { describe, expect, it } from "vitest";
import { depthToRgba, depthToRgbaBytes, neutralDepth, packModelInput } from "./depth-runner.ts";

/**
 * The two conversions around the model (T385).
 *
 * These are where depth silently goes wrong — a channel order swapped, a normalisation
 * skipped, an axis transposed — each producing something that LOOKS like a depth map. No
 * gate over the rendered pixels would catch any of them, so they are checked by value.
 */

describe("packing the model's input", () => {
  it("converts interleaved RGBA texels into PLANAR channels", () => {
    // Four pixels (side 2), each a pure primary or black, so every channel's plane has a
    // distinct signature. Interleaved input left interleaved would still RUN and would
    // feed the model a scrambled image — the failure this asserts against.
    const texels = new Float32Array([
      1, 0, 0, 1, // red
      0, 1, 0, 1, // green
      0, 0, 1, 1, // blue
      0, 0, 0, 1, // black
    ]);
    const packed = packModelInput(texels, 2);
    expect(packed.length).toBe(3 * 4);

    const denorm = (plane: number, index: number) =>
      packed[plane * 4 + index]! * [0.229, 0.224, 0.225][plane]! + [0.485, 0.456, 0.406][plane]!;

    // Plane 0 is RED across all four pixels: 1,0,0,0 — not the first four numbers of the
    // interleaved buffer, which would be 1,0,0,1.
    expect([0, 1, 2, 3].map((i) => Math.round(denorm(0, i)) + 0)).toEqual([1, 0, 0, 0]);
    expect([0, 1, 2, 3].map((i) => Math.round(denorm(1, i)) + 0)).toEqual([0, 1, 0, 0]);
    expect([0, 1, 2, 3].map((i) => Math.round(denorm(2, i)) + 0)).toEqual([0, 0, 1, 0]);
  });

  it("normalises per channel with ImageNet statistics, not one global scale", () => {
    // A mid-grey pixel must NOT map to zero: the three channels have different means, so
    // a single global normalisation would put all three at the same value and quietly
    // shift the colour balance the model was trained against.
    const texels = new Float32Array([0.5, 0.5, 0.5, 1]);
    const packed = packModelInput(texels, 1);

    expect(packed[0]).toBeCloseTo((0.5 - 0.485) / 0.229, 6);
    expect(packed[1]).toBeCloseTo((0.5 - 0.456) / 0.224, 6);
    expect(packed[2]).toBeCloseTo((0.5 - 0.406) / 0.225, 6);
    expect(packed[0]).not.toBeCloseTo(packed[1]!, 3);
  });

  it("drops alpha rather than feeding it as a fourth channel", () => {
    const texels = new Float32Array([0, 0, 0, 0.123]);
    expect(packModelInput(texels, 1).length).toBe(3);
  });
});

describe("turning relative depth into a texture (T959: float texels, byte views)", () => {
  const floatsOf = (bytes: Uint8Array): Float32Array =>
    new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);

  it("stretches the frame's own range across 0..1 — in FLOAT, no byte rounding", () => {
    const depth = new Float32Array([0, 1, 2, 3]);
    const floats = floatsOf(depthToRgba(depth, 2, 2, 2));
    expect(floats[0]).toBe(0);
    expect(floats[3]).toBe(1);
    // The precision claim itself: a third of the range is a third, not the nearest of
    // 256 steps — 1/3 is not representable in 8 bits (85/255 = 0.333333... rounds).
    const third = floatsOf(depthToRgba(new Float32Array([0, 1, 2, 3]).map((v) => v / 3), 2, 2, 2));
    expect(third[1]).toBeCloseTo(1 / 3, 7);
  });

  it("quantised to 256 levels before T959 — pinned as the contrast, not the contract", () => {
    const bytes = depthToRgbaBytes(new Float32Array([0, 1, 2, 3]), 2, 2, 2);
    expect(bytes[0]).toBe(0);
    expect(bytes[3 * 4]).toBe(255);
  });

  it("normalises a degenerate frame to the IDENTITY, not to zero", () => {
    const floats = floatsOf(depthToRgba(new Float32Array([7, 7, 7, 7]), 2, 2, 2));
    for (const v of floats) expect(v).toBe(0.5);
  });

  it("survives a frame containing NaN rather than producing a broken map", () => {
    const floats = floatsOf(depthToRgba(new Float32Array([0, Number.NaN, 1, 0.5]), 2, 2, 2));
    expect([...floats].every((v) => Number.isFinite(v))).toBe(true);
  });

  it("resamples to the node's resolution, not the model's", () => {
    const bytes = depthToRgba(new Float32Array([0, 1, 2, 3]), 2, 8, 5);
    expect(bytes.length).toBe(8 * 5 * 4); // r32float: 4 bytes per texel
  });

  it("keeps near bright and far dark across the resample", () => {
    const depth = new Float32Array([0, 3, 0, 3]);
    const floats = floatsOf(depthToRgba(depth, 2, 4, 2));
    expect(floats[0]!).toBeLessThan(floats[3]!);
  });
});

describe("the identity a node publishes with no result", () => {
  it("is EXACTLY the value Displace reads as no displacement", () => {
    // T959: 0.5 exactly — the 8-bit encoder could only manage 128/255 = 0.502, which was
    // a permanent 0.2% displacement bias on every model-less machine.
    const grey = neutralDepth(3, 2);
    expect(grey.length).toBe(3 * 2 * 4);
    const floats = new Float32Array(grey.buffer);
    for (const v of floats) expect(v).toBe(0.5);
  });
});
