import { describe, expect, it } from "vitest";
import { evaluateExpression, scopeFromFrame } from "../expressions/index.ts";
import {
  describeForecast,
  forecastClamp,
  numericRangeOf,
  rangeRemedy,
} from "./expression-range.ts";

/**
 * T368 — a monotone expression against a bounded parameter.
 *
 * The case that produced this: `transform.r` is ±360, and `time * 7` is correct at t=0
 * and pinned at 360 from t≈51.4 onward. These tests assert the two things a user would
 * notice: WHEN it stops, and WHAT to write instead — and that what to write instead
 * actually runs.
 */

const ROTATE = { min: -360, max: 360 } as const;

describe("forecastClamp", () => {
  it("finds the second the E13 roll stops, not merely that it will", () => {
    const forecast = forecastClamp("time * 7", ROTATE);
    expect(forecast).not.toBeNull();
    // 360 / 7 = 51.43s. A range assertion here would tolerate a forecast that is right
    // about the failure and wrong about the moment (§V218).
    expect(forecast?.atSeconds).toBeCloseTo(360 / 7, 2);
    expect(forecast?.limit).toBe(360);
  });

  it("says nothing about an expression that stays in range for the whole horizon", () => {
    expect(forecastClamp("time * 7 % 360", ROTATE)).toBeNull();
    expect(forecastClamp("mod(time * 7, 360)", ROTATE)).toBeNull();
    expect(forecastClamp("sin(time) * 180", ROTATE)).toBeNull();
    expect(forecastClamp("180", ROTATE)).toBeNull();
  });

  it("catches the one that is already out of range at t=0", () => {
    const forecast = forecastClamp("400", ROTATE);
    expect(forecast?.atSeconds).toBe(0);
  });

  it("catches a NEGATIVE ramp against the lower bound too", () => {
    const forecast = forecastClamp("time * -7", ROTATE);
    expect(forecast?.atSeconds).toBeCloseTo(360 / 7, 2);
    expect(forecast?.limit).toBe(-360);
  });

  it("forecasts against frame and walltime, since an expression may read either", () => {
    // `frame` advances 60× faster than `time`: a forecast that only moved `time` would
    // report "never" for an expression that clamps in the first second.
    const forecast = forecastClamp("frame", { min: null, max: 120 });
    expect(forecast?.atSeconds).toBeCloseTo(2, 1);
  });

  it("makes NO claim about an expression it cannot run (§V240 in reverse)", () => {
    // An op() reference needs a graph. Guessing here would be the same lie the silent
    // clamp was telling, with more confidence.
    expect(forecastClamp("op('noise1').par.gain", ROTATE)).toBeNull();
    expect(forecastClamp("nonsense +", ROTATE)).toBeNull();
    expect(forecastClamp("unknownName", ROTATE)).toBeNull();
  });
});

describe("rangeRemedy", () => {
  it("offers BOTH remedies for a two-sided range, and both of them run", () => {
    const remedy = rangeRemedy("time * 7", ROTATE);
    expect(remedy).toContain("clamp(time * 7, -360, 360)");
    expect(remedy).toContain("mod(time * 7, 360)");
    // §V150's rule, applied to advice: the text has to be something the evaluator takes.
    const scope = scopeFromFrame({
      timeSeconds: 100,
      deltaSeconds: 1 / 60,
      frameIndex: 6000,
      mode: "offline",
      randomSeed: 0,
    });
    expect(evaluateExpression("clamp(time * 7, -360, 360)", scope)).toEqual({ ok: true, value: 360 });
    expect(evaluateExpression("mod(time * 7, 360)", scope)).toEqual({ ok: true, value: 340 });
    // And the wrapped one is what a user would notice: it is still moving at t=100.
    expect(forecastClamp("mod(time * 7, 360)", ROTATE)).toBeNull();
  });

  it("withholds the wrap when wrapping would land OUTSIDE the range", () => {
    // `mod(x, 10)` returns [0, 10), which is not inside a range that starts at 2. Naming
    // it anyway would be confident advice that produces a different wrong value (§V293).
    const remedy = rangeRemedy("time", { min: 2, max: 10 });
    expect(remedy).toContain("clamp(time, 2, 10)");
    expect(remedy).not.toContain("mod(");
  });

  it("uses the one-sided form when only one bound is declared", () => {
    expect(rangeRemedy("time", { min: null, max: 8 })).toBe("Hold it with min(time, 8).");
    expect(rangeRemedy("time", { min: 1, max: null })).toBe("Hold it with max(time, 1).");
    expect(rangeRemedy("time", { min: null, max: null })).toBeNull();
  });
});

describe("numericRangeOf", () => {
  it("reads the bounds off a number and a vector, and nothing off the rest", () => {
    expect(numericRangeOf({ type: "number", label: "R", default: 0, min: -360, max: 360 })).toEqual({
      min: -360,
      max: 360,
    });
    expect(numericRangeOf({ type: "vector", label: "T", size: 2, default: [0, 0], max: 1 })).toEqual({
      min: null,
      max: 1,
    });
    // Unbounded is the honest answer for `renderInstances.rotate` and `eye`: nothing to
    // forecast, nothing to suggest.
    expect(numericRangeOf({ type: "number", label: "R", default: 0 })).toBeNull();
    expect(numericRangeOf({ type: "string", label: "S", default: "" })).toBeNull();
  });
});

describe("describeForecast", () => {
  it("names the limit, the moment and the remedy in one line", () => {
    const forecast = forecastClamp("time * 7", ROTATE);
    if (forecast === null) throw new Error("expected a forecast");
    const sentence = describeForecast(forecast);
    expect(sentence).toContain("360");
    expect(sentence).toContain("51");
    expect(sentence).toContain("mod(time * 7, 360)");
  });
});
