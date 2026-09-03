import { describe, expect, it } from "vitest";
import { matteCoverage, matteToFloats, neutralMatte, packMatteInput, smoothMatte } from "./matte-runner.ts";

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

/**
 * §V288 — the measurement that separates "it ran and found nobody" from "it is broken".
 *
 * The bug this closes is not a wrong pixel; it is a MISSING NUMBER. A matte's neutral
 * output and its correct output on an empty frame are the same picture, so four different
 * states rendered identically and only three of them said anything. These assertions are
 * about DIRECTION and about the values a consumer reads, never about a magnitude that
 * would only pin the fixture.
 */
describe("how much of the frame a matte claims (§V288, §V839)", () => {
  const SIDE = 32;

  /** A subject: full alpha inside a centred box covering a quarter of the frame. */
  function subject(fill: number): Uint8Array {
    const floats = new Float32Array(SIDE * SIDE);
    for (let y = SIDE / 4; y < (SIDE * 3) / 4; y += 1) {
      for (let x = SIDE / 4; x < (SIDE * 3) / 4; x += 1) floats[y * SIDE + x] = fill;
    }
    return new Uint8Array(floats.buffer);
  }

  it("is the fraction of the frame the matte actually claims", () => {
    // A quarter of the frame at full alpha IS a quarter. The number a notice and a
    // `<name>:coverage` channel both read is this one, so it has to mean what it says.
    expect(matteCoverage(subject(1))).toBeCloseTo(0.25, 6);
    expect(matteCoverage(subject(0.5))).toBeCloseTo(0.125, 6);
  });

  /**
   * §V839 — CONFIRM THE METRIC MOVES THE WAY ITS NAME SAYS, by mutating to a known-bad
   * state and checking the number goes where predicted. A coverage that rose as the matte
   * emptied would have named the notice's condition backwards and fired it on the one
   * frame where everything was fine.
   */
  it("goes DOWN as the matte empties, and reaches zero for the neutral output", () => {
    const full = matteCoverage(subject(1));
    const half = matteCoverage(subject(0.5));
    const empty = matteCoverage(neutralMatte(SIDE, SIDE));
    expect(full).toBeGreaterThan(half);
    expect(half).toBeGreaterThan(empty);
    expect(empty).toBe(0);
    // And the threshold the notice fires on separates them, which is the whole claim:
    // a subject reads far above it, the neutral output far below.
    expect(full).toBeGreaterThan(0.001);
    expect(empty).toBeLessThan(0.001);
  });

  it("counts a NaN as no coverage rather than poisoning the whole reading", () => {
    // One bad texel used to make the mean NaN, and `NaN < threshold` is false — so a
    // completely broken result would have reported itself as a healthy one.
    const floats = new Float32Array(SIDE * SIDE).fill(1);
    floats[0] = Number.NaN;
    const measured = matteCoverage(new Uint8Array(floats.buffer));
    expect(Number.isFinite(measured)).toBe(true);
    expect(measured).toBeCloseTo((SIDE * SIDE - 1) / (SIDE * SIDE), 6);
  });
});
