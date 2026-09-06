import { describe, expect, it } from "vitest";
import { binRange, maxFilter, positiveFlux } from "./flux.ts";

/**
 * T1226 — flux against ANALYTIC values (§V147). Every expected number below is a
 * fraction with a visible numerator: which bins rose, by how much, over how many.
 */

describe("positiveFlux", () => {
  it("a silence→full-scale jump across every bin is exactly 1, and the reverse is 0", () => {
    const silence = new Uint8Array(8);
    const full = new Uint8Array(8).fill(255);
    expect(positiveFlux(full, silence)).toBe(1);
    expect(positiveFlux(silence, full)).toBe(0);
  });

  it("only the rises count, averaged over the whole range: (10 + 20) / 4 / 255", () => {
    const previous = Uint8Array.from([100, 100, 100, 100]);
    const current = Uint8Array.from([110, 90, 120, 100]);
    expect(positiveFlux(current, previous)).toBe(30 / 4 / 255);
  });

  it("a bin range averages over ITS bins only: bins 2..3 of the same pair give 20 / 2 / 255", () => {
    const previous = Uint8Array.from([100, 100, 100, 100]);
    const current = Uint8Array.from([110, 90, 120, 100]);
    expect(positiveFlux(current, previous, 2, 3)).toBe(20 / 2 / 255);
  });

  it("no reference, a reference of another length, or an empty range: 0, never a full-deck hit", () => {
    const full = new Uint8Array(8).fill(255);
    expect(positiveFlux(full, null)).toBe(0);
    expect(positiveFlux(full, new Uint8Array(4))).toBe(0);
    expect(positiveFlux(full, new Uint8Array(8), 5, 4)).toBe(0);
  });
});

describe("binRange", () => {
  it("is ceil(low / binHz) .. floor(high / binHz), clamped to the spectrum", () => {
    // 48 kHz / 2048 = 23.4375 Hz per bin: 20 Hz → bin 1, 250 Hz → bin 10.
    expect(binRange(23.4375, 20, 250, 1024)).toEqual([1, 10]);
    expect(binRange(23.4375, 6000, 16000, 1024)).toEqual([256, 682]);
    // A band past the top of the spectrum clamps to the last bin.
    expect(binRange(23.4375, 20000, 30000, 1024)).toEqual([854, 1023]);
  });

  it("a band narrower than a bin, between two bin centres, is empty (last < first)", () => {
    const [first, last] = binRange(100, 110, 190, 16);
    expect(last).toBeLessThan(first);
  });
});

describe("maxFilter", () => {
  it("halfWidth 1 spreads a lone peak one bin either side, and the edges clamp", () => {
    const spectrum = Uint8Array.from([0, 0, 50, 0, 0, 0, 200]);
    expect(Array.from(maxFilter(spectrum, 1, new Uint8Array(7)))).toEqual([0, 50, 50, 50, 0, 200, 200]);
  });

  it("halfWidth 0 is the identity, and a wrong-sized out throws", () => {
    const spectrum = Uint8Array.from([3, 1, 4, 1, 5]);
    expect(Array.from(maxFilter(spectrum, 0, new Uint8Array(5)))).toEqual([3, 1, 4, 1, 5]);
    expect(() => maxFilter(spectrum, 1, new Uint8Array(4))).toThrow(/does not fit/);
  });

  it("a partial that slides one bin over reads as NO rise against the filtered reference", () => {
    const before = Uint8Array.from([0, 0, 120, 0, 0]);
    const after = Uint8Array.from([0, 0, 0, 120, 0]);
    // Raw flux sees a fresh 120 at bin 3; SuperFlux's reference already holds it there.
    expect(positiveFlux(after, before)).toBe(120 / 5 / 255);
    expect(positiveFlux(after, maxFilter(before, 1, new Uint8Array(5)))).toBe(0);
  });
});
