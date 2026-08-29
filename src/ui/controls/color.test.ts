import { describe, expect, it } from "vitest";
import {
  convertColor,
  cssColorFor,
  fromDisplay,
  linearToSrgb,
  parseHex,
  srgbToLinear,
  toDisplay,
  toHex,
  toRgba,
} from "./color.ts";
import type { Rgba } from "./color.ts";

/**
 * doc §8.1 — "Colour values support linear and display colour representations",
 * doc §16.2 — display colours are decoded to linear, data colours are not.
 *
 * The invariant worth protecting: the STORED value never changes when the user merely
 * switches which representation they are editing in. Get that wrong and every colour in
 * a project drifts every time someone opens the picker.
 */

const close = (a: Rgba, b: Rgba, digits = 6): void => {
  for (let index = 0; index < 4; index += 1) {
    expect(a[index] ?? 0).toBeCloseTo(b[index] ?? 0, digits);
  }
};

describe("sRGB transfer functions", () => {
  it("round-trips a channel through both directions", () => {
    for (const channel of [0, 0.04, 0.18, 0.5, 0.9, 1]) {
      expect(linearToSrgb(srgbToLinear(channel))).toBeCloseTo(channel, 6);
    }
  });

  it("pins the endpoints and the mid-grey relationship", () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 6);
    // Display 0.5 is much darker than linear 0.5 — the whole reason the toggle exists.
    expect(srgbToLinear(0.5)).toBeCloseTo(0.2140, 3);
  });
});

describe("representation switching", () => {
  it("leaves the stored value untouched when only the representation changes", () => {
    const stored: Rgba = [0.2, 0.4, 0.6, 0.8];
    const shownAsDisplay = convertColor(stored, "linear", "display");
    const backToStored = convertColor(shownAsDisplay, "display", "linear");
    close(backToStored, stored);
  });

  it("is the identity when the spaces match", () => {
    const stored: Rgba = [0.2, 0.4, 0.6, 1];
    expect(convertColor(stored, "display", "display")).toBe(stored);
    expect(toDisplay(stored, "display")).toBe(stored);
    expect(fromDisplay(stored, "display")).toBe(stored);
  });

  it("never encodes alpha — it is coverage, not light", () => {
    const encoded = toDisplay([0.5, 0.5, 0.5, 0.5], "linear");
    expect(encoded[3]).toBe(0.5);
  });
});

describe("swatch and hex", () => {
  it("shows a linear value through the display encoding, not raw", () => {
    const linearMid = cssColorFor([0.5, 0.5, 0.5, 1], "linear");
    const displayMid = cssColorFor([0.5, 0.5, 0.5, 1], "display");
    // A linear 0.5 swatch drawn raw would be visibly the wrong grey.
    expect(linearMid).not.toBe(displayMid);
    expect(displayMid).toContain("128");
  });

  it("round-trips a hex through the parameter's own space", () => {
    const parsed = parseHex("#336699", "linear", 1);
    expect(parsed).not.toBeNull();
    expect(toHex(parsed as Rgba, "linear")).toBe("#336699");
  });

  it("accepts short hex, bare hex, and preserves the current alpha", () => {
    const short = parseHex("f80", "display", 0.25);
    close(short as Rgba, [1, 0x88 / 255, 0, 0.25], 5);
  });

  it("returns null for a bad paste rather than zeroing the colour", () => {
    expect(parseHex("nope", "display", 1)).toBeNull();
    expect(parseHex("#12345", "display", 1)).toBeNull();
    expect(parseHex("", "display", 1)).toBeNull();
  });
});

describe("tolerant reads", () => {
  it("falls back to opaque black for a malformed stored value", () => {
    expect(toRgba(null)).toEqual([0, 0, 0, 1]);
    expect(toRgba("red")).toEqual([0, 0, 0, 1]);
    expect(toRgba([0.5])).toEqual([0.5, 0, 0, 1]);
    expect(toRgba([Number.NaN, 1, 1, 1])).toEqual([0, 1, 1, 1]);
  });
});
