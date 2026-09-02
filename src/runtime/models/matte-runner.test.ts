import { describe, expect, it } from "vitest";
import { matteToFloats, neutralMatte, packMatteInput, smoothMatte } from "./matte-runner.ts";

describe("packing MODNet's input (T957)", () => {
  it("normalises (x − 0.5) / 0.5 per channel, NCHW — the reference inference, not the card", () => {
    const texels = new Float32Array([0, 0.5, 1, 1]); // one rgba texel
    const packed = packMatteInput(texels, 1);
    expect(packed.length).toBe(3);
    expect(packed[0]).toBe(-1); // r 0
    expect(packed[1]).toBe(0); //  g 0.5
    expect(packed[2]).toBe(1); //  b 1
  });
});

describe("the matte as a texture (T957, T959, T974)", () => {
  const floatsOf = (bytes: Uint8Array): Float32Array =>
    new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);

  it("returns FLOAT texels — a soft alpha survives with no byte rounding", () => {
    const model = new Float32Array([1 / 3, 1 / 3, 1 / 3, 1 / 3]);
    const floats = floatsOf(matteToFloats(model, 2, 2, 2));
    expect(floats[0]).toBeCloseTo(1 / 3, 7);
  });

  it("reads back only the letterbox's occupied band on a wide result (T974's rule)", () => {
    // Model texels valued by their own v: a 2:1 result must span the centred half band,
    // starting at v = 0.25 — never the bar rows.
    const side = 8;
    const model = new Float32Array(side * side);
    for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) model[y * side + x] = (y + 0.5) / side;
    const floats = floatsOf(matteToFloats(model, side, 16, 8));
    expect(floats[0]!).toBeGreaterThan(0.2); // the band's start, not the top bar
    expect(floats[0]!).toBeLessThan(0.35);
    expect(floats[7 * 16]!).toBeGreaterThan(0.65); // the band's end
    expect(floats[7 * 16]!).toBeLessThan(0.8);
  });

  it("clamps NaN and out-of-range model values instead of publishing them", () => {
    const floats = floatsOf(matteToFloats(new Float32Array([Number.NaN, 2, -1, 0.5]), 2, 2, 2));
    for (const v of floats) {
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("publishes ZERO with no model — 'nobody is here', so a masked composite shows nothing", () => {
    const grey = neutralMatte(3, 2);
    expect(grey.length).toBe(3 * 2 * 4);
    for (const v of new Float32Array(grey.buffer)) expect(v).toBe(0);
  });
});

describe("the temporal EMA (T957 — §T981's state slot, proven small)", () => {
  it("blends toward the new frame by alpha, steadying a flickering edge", () => {
    const previous = new Float32Array([0, 1]);
    const next = new Float32Array([1, 0]);
    const smoothed = smoothMatte(previous, next, 0.5);
    expect(smoothed[0]).toBeCloseTo(0.5, 6);
    expect(smoothed[1]).toBeCloseTo(0.5, 6);
  });

  it("passes the first frame through untouched, and alpha 1 disables smoothing", () => {
    const next = new Float32Array([0.25, 0.75]);
    expect([...smoothMatte(undefined, Float32Array.from(next), 0.5)]).toEqual([0.25, 0.75]);
    expect([...smoothMatte(new Float32Array([0, 0]), Float32Array.from(next), 1)]).toEqual([0.25, 0.75]);
  });
});
