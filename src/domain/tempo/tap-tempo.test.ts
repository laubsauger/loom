import { describe, expect, it } from "vitest";

import { createTapTempo, roundBpm } from "./tap-tempo.ts";

/** T1785b — the tap estimator alone. The command, the document and the beat phase are in `project-tempo.test.ts`. */
describe("tap tempo (T1785b)", () => {
  it("one tap is no tempo; two are 60 over their interval", () => {
    const taps = createTapTempo();
    expect(taps.tap(1)).toEqual({ bpm: null, taps: 1 });
    expect(taps.tap(1.5)).toEqual({ bpm: 120, taps: 2 });
  });

  it("an even number of intervals takes the mean of the middle two", () => {
    const taps = createTapTempo();
    for (const time of [0, 0.5]) taps.tap(time);
    // Intervals 0.5 and 0.75: the median is 0.625 s, 96 bpm.
    expect(taps.tap(1.25).bpm).toBe(96);
  });

  it("a tapped tempo is stored to a tenth, inside the range a project may hold", () => {
    expect(roundBpm(123.456)).toBe(123.5);
    expect([roundBpm(3), roundBpm(5000)]).toEqual([20, 999]);
    const taps = createTapTempo();
    taps.tap(0);
    // 0.01 s apart would be 6000 bpm.
    expect(taps.tap(0.01).bpm).toBe(999);
  });

  it("a tap that goes back in time starts a new count", () => {
    const taps = createTapTempo();
    taps.tap(5);
    taps.tap(5.5);
    expect(taps.tap(2)).toEqual({ bpm: null, taps: 1 });
  });
});
