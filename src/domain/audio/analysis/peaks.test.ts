import { describe, expect, it } from "vitest";
import { createPeakPicker } from "./peaks.ts";

/**
 * T1226 — the adaptive picker against hand-computed thresholds (§V147). Each case
 * states the mean the bar is built from, so a wrong history window or an off-by-one in
 * "before the current value" changes a number here.
 */

function events(picker: ReturnType<typeof createPeakPicker>, values: number[]): number[] {
  return values.map((value) => (picker.push(value) ? 1 : 0));
}

describe("createPeakPicker", () => {
  it("over silence the bar is delta: the first hop above it is an event, the plateau after it is not", () => {
    const picker = createPeakPicker({ historyHops: 4, delta: 0.05, minGapHops: 0 });
    expect(picker.threshold()).toBe(0.05);
    // After two zeros the bar is still 0.05; 0.06 crosses it once, the plateau stays above.
    expect(events(picker, [0, 0, 0.06, 0.06, 0])).toEqual([0, 0, 1, 0, 0]);
  });

  it("the bar follows the mean of the PREVIOUS hops: a step from 0.1 to 0.14 clears delta 0.03, to 0.13 does not", () => {
    const rises = createPeakPicker({ historyHops: 4, delta: 0.03, minGapHops: 0 });
    // History fills with 0.1 — the first push (0.1 > 0.03) is itself an event over silence.
    expect(events(rises, [0.1, 0.1, 0.1, 0.1])).toEqual([1, 0, 0, 0]);
    expect(rises.threshold()).toBeCloseTo(0.13, 12);
    expect(rises.push(0.14)).toBe(true);

    const holds = createPeakPicker({ historyHops: 4, delta: 0.03, minGapHops: 0 });
    events(holds, [0.1, 0.1, 0.1, 0.1]);
    expect(holds.push(0.13)).toBe(false);
  });

  it("the history is a window: after four hops of 0.4 then four of 0, the bar is back to delta", () => {
    const picker = createPeakPicker({ historyHops: 4, delta: 0.02, minGapHops: 0 });
    events(picker, [0.4, 0.4, 0.4, 0.4]);
    expect(picker.threshold()).toBeCloseTo(0.42, 12);
    events(picker, [0, 0, 0, 0]);
    expect(picker.threshold()).toBeCloseTo(0.02, 12);
  });

  it("minGapHops drops a retrigger inside the gap and keeps the one after it", () => {
    const picker = createPeakPicker({ historyHops: 100, delta: 0.1, minGapHops: 3 });
    // Events would fire at hops 0, 2 and 4; the gap of 3 keeps 0 and 4 only.
    expect(events(picker, [0.5, 0, 0.5, 0, 0.5])).toEqual([1, 0, 0, 0, 1]);
  });

  it("reset forgets the history and the gap", () => {
    const picker = createPeakPicker({ historyHops: 4, delta: 0.02, minGapHops: 10 });
    events(picker, [0.4, 0.4]);
    picker.reset();
    expect(picker.threshold()).toBe(0.02);
    expect(picker.push(0.1)).toBe(true);
  });

  it("rejects an empty history, a negative delta or a negative gap", () => {
    expect(() => createPeakPicker({ historyHops: 0, delta: 0.1, minGapHops: 0 })).toThrow(/bad options/);
    expect(() => createPeakPicker({ historyHops: 4, delta: -1, minGapHops: 0 })).toThrow(/bad options/);
    expect(() => createPeakPicker({ historyHops: 4, delta: 0.1, minGapHops: -1 })).toThrow(/bad options/);
  });
});
