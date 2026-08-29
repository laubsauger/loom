import { describe, expect, it } from "vitest";
import type { NumberParameter } from "@domain/types/parameters.ts";
import {
  DRAG_MODIFIER_FACTOR,
  PIXELS_PER_DECADE,
  PIXELS_PER_STEP,
  clampToRange,
  decimalsFor,
  describeRange,
  dragModifierFrom,
  formatNumber,
  normalizeValue,
  nudge,
  quantize,
  rangeFraction,
  stepFor,
  valueFromDrag,
} from "./drag-math.ts";
import type { NumericSpec } from "./types.ts";

/**
 * doc §8.1 is a behaviour contract for the numeric control. These tests are that
 * contract expressed as maths, so a refactor of the component cannot quietly change
 * what a drag, a modifier or a reset does.
 */

const bounded: NumericSpec = { min: 0, max: 1, step: 0.01 };
const unbounded: NumericSpec = {};

describe("modifier selection (doc §8.1)", () => {
  it("makes shift fine and alt coarse", () => {
    expect(dragModifierFrom({ shiftKey: true, altKey: false })).toBe("fine");
    expect(dragModifierFrom({ shiftKey: false, altKey: true })).toBe("coarse");
    expect(dragModifierFrom({ shiftKey: false, altKey: false })).toBe("normal");
  });

  it("resolves both-held toward the slower speed, never the faster one", () => {
    // An accidental extra modifier must not multiply the value by ten.
    expect(dragModifierFrom({ shiftKey: true, altKey: true })).toBe("fine");
  });

  it("scales fine and coarse a decade either side of normal", () => {
    expect(DRAG_MODIFIER_FACTOR.fine).toBeLessThan(DRAG_MODIFIER_FACTOR.normal);
    expect(DRAG_MODIFIER_FACTOR.coarse).toBeGreaterThan(DRAG_MODIFIER_FACTOR.normal);
  });
});

describe("step derivation", () => {
  it("uses the manifest step when it declares one", () => {
    expect(stepFor({ step: 0.25 })).toBe(0.25);
  });

  it("derives a step from a declared range so a full drag is a comfortable distance", () => {
    // 1/100 of the range: 200 px of travel covers the whole range at normal speed.
    expect(stepFor({ min: 0, max: 100 })).toBe(1);
    expect(100 * PIXELS_PER_STEP).toBe(200);
  });

  it("ignores a nonsense step rather than dividing by zero", () => {
    expect(stepFor({ step: 0 })).toBe(0.01);
    expect(stepFor({ step: Number.NaN })).toBe(0.01);
  });
});

describe("drag maths", () => {
  it("moves one step per PIXELS_PER_STEP at normal speed", () => {
    const value = valueFromDrag({
      startValue: 0.5,
      deltaX: PIXELS_PER_STEP * 10,
      spec: bounded,
      modifier: "normal",
    });
    expect(value).toBe(0.6);
  });

  it("moves a tenth as far with shift and ten times as far with alt", () => {
    const drag = (modifier: "fine" | "normal" | "coarse"): number =>
      valueFromDrag({ startValue: 0.5, deltaX: PIXELS_PER_STEP * 10, spec: { min: 0, max: 10, step: 0.001 }, modifier });
    expect(drag("fine")).toBeCloseTo(0.501, 5);
    expect(drag("normal")).toBeCloseTo(0.51, 5);
    expect(drag("coarse")).toBeCloseTo(0.6, 5);
  });

  it("is absolute, so dragging out and back returns exactly to the start value", () => {
    const start = 0.42;
    const out = valueFromDrag({ startValue: start, deltaX: 137, spec: bounded, modifier: "normal" });
    const back = valueFromDrag({ startValue: start, deltaX: 0, spec: bounded, modifier: "normal" });
    expect(out).not.toBe(start);
    expect(back).toBe(start);
  });

  it("clamps to the manifest range in both directions", () => {
    expect(valueFromDrag({ startValue: 0.9, deltaX: 5000, spec: bounded, modifier: "coarse" })).toBe(1);
    expect(valueFromDrag({ startValue: 0.1, deltaX: -5000, spec: bounded, modifier: "coarse" })).toBe(0);
  });

  it("never emits float noise: values land on the step grid at the declared precision", () => {
    const spec: NumericSpec = { min: 0, max: 1, step: 0.1 };
    const value = valueFromDrag({ startValue: 0.1, deltaX: PIXELS_PER_STEP * 2, spec, modifier: "normal" });
    // Not 0.30000000000000004 — a document full of that is unreadable and undiffable.
    expect(value).toBe(0.3);
    expect(String(value)).toBe("0.3");
  });

  it("moves a log-scaled parameter by ratio, so both ends of a wide range are reachable", () => {
    const spec: NumericSpec = { min: 0.001, max: 1000, scale: "log", precision: 4 };
    const decade = valueFromDrag({
      startValue: 1,
      deltaX: PIXELS_PER_DECADE,
      spec,
      modifier: "normal",
    });
    expect(decade).toBeCloseTo(10, 3);
    const down = valueFromDrag({ startValue: 1, deltaX: -PIXELS_PER_DECADE, spec, modifier: "normal" });
    expect(down).toBeCloseTo(0.1, 4);
  });
});

describe("quantisation, clamping and precision", () => {
  it("snaps to the step grid anchored at the minimum", () => {
    const spec: NumericSpec = { min: 0.5, max: 2.5, step: 0.5 };
    expect(quantize(1.24, spec)).toBe(1);
    expect(quantize(1.26, spec)).toBe(1.5);
  });

  it("honours an explicit precision over the step's own decimals", () => {
    expect(decimalsFor({ step: 0.001, precision: 1 })).toBe(1);
    expect(normalizeValue(0.126, { step: 0.001, precision: 1 })).toBe(0.1);
  });

  it("collapses a non-finite value into the range instead of storing NaN", () => {
    expect(normalizeValue(Number.NaN, bounded)).toBe(0);
    expect(normalizeValue(Number.POSITIVE_INFINITY, bounded)).toBe(0);
  });

  it("clamps independently of quantisation", () => {
    expect(clampToRange(5, { max: 2 })).toBe(2);
    expect(clampToRange(-5, { min: -2 })).toBe(-2);
    expect(clampToRange(5, unbounded)).toBe(5);
  });
});

describe("keyboard nudging (§V19)", () => {
  it("moves one step per press and ten per page", () => {
    expect(nudge({ value: 0.5, direction: 1, spec: bounded, modifier: "normal" })).toBe(0.51);
    expect(nudge({ value: 0.5, direction: -1, spec: bounded, modifier: "normal", steps: 10 })).toBe(0.4);
  });

  it("scales by steps, and never below one — a step is the smallest meaningful move", () => {
    const spec: NumericSpec = { min: 0, max: 10, step: 0.01 };
    // Fine cannot subdivide the manifest's step: the author declared that granularity,
    // and a sub-step value would only be rounded back off the grid on the way in.
    expect(nudge({ value: 1, direction: 1, spec, modifier: "fine" })).toBeCloseTo(1.01, 5);
    expect(nudge({ value: 1, direction: 1, spec, modifier: "coarse" })).toBeCloseTo(1.1, 5);
  });

  it("keeps every emitted value on the manifest's step grid", () => {
    const spec: NumericSpec = { min: 0, max: 1, step: 0.25 };
    for (const modifier of ["fine", "normal", "coarse"] as const) {
      const value = nudge({ value: 0.25, direction: 1, spec, modifier });
      expect(Number.isInteger(value / 0.25)).toBe(true);
    }
  });

  it("clamps at the range ends rather than running past them", () => {
    expect(nudge({ value: 1, direction: 1, spec: bounded, modifier: "coarse" })).toBe(1);
  });
});

describe("display", () => {
  it("shows a fixed number of decimals so digits do not jitter under a drag", () => {
    expect(formatNumber(0.5, { step: 0.01 })).toBe("0.50");
    expect(formatNumber(4, { step: 1 })).toBe("4");
  });

  it("describes only the bounds the manifest actually declares", () => {
    expect(describeRange({ min: 0, max: 1 })).toBe("0…1");
    expect(describeRange({ min: 0 })).toBe("≥ 0");
    expect(describeRange({ max: 8 })).toBe("≤ 8");
    expect(describeRange(unbounded)).toBeNull();
  });

  it("reports a range fraction only when the range exists", () => {
    expect(rangeFraction(0.25, bounded)).toBeCloseTo(0.25, 6);
    expect(rangeFraction(5, unbounded)).toBeNull();
  });
});

describe("a NumberParameter is usable as a NumericSpec without translation", () => {
  it("reads min/max/step/precision straight off the manifest", () => {
    const parameter: NumberParameter = {
      type: "number",
      label: "Radius",
      default: 4,
      min: 0,
      max: 64,
      step: 0.5,
      unit: "px",
      precision: 1,
    };
    expect(stepFor(parameter)).toBe(0.5);
    expect(normalizeValue(70, parameter)).toBe(64);
    expect(formatNumber(4, parameter)).toBe("4.0");
  });
});
