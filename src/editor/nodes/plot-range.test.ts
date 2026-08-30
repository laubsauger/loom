import { describe, expect, it } from "vitest";
import { niceStep, stickyRange } from "./plot-range.ts";
import type { PlotRange } from "./plot-range.ts";

/**
 * T352 / §V296 — the plot must not invent motion.
 *
 * The bug the owner saw: "expanding and contracting sine while it should be a pretty
 * stable one". The range was recomputed from the visible window every frame, so the last
 * decimal of the window's min and max — which moves as the window slides even when the
 * SIGNAL does not — moved the axis, and the wave breathed.
 *
 * So the assertion that matters is not "the range is reasonable", it is "the range does
 * not CHANGE while the amplitude does not". The first test simulates the real thing: a
 * sine sampled into a window that slides one sample per frame, which is exactly what
 * `value-history` feeds the plot.
 */

/** Min and max of a sine window starting at `offset`, the way `rangeOf` computes them. */
function sineWindow(offset: number, amplitude = 1, samples = 120): PlotRange {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < samples; index += 1) {
    const value = amplitude * Math.sin((offset + index) * 0.11);
    if (value < low) low = value;
    if (value > high) high = value;
  }
  return { low, high };
}

describe("stickyRange (T352, §V296)", () => {
  it("does not move for a sine of constant amplitude, however the window slides", () => {
    // NON-VACUITY: the raw windows really do wobble — that wobble IS the bug, and a test
    // fed identical windows would prove nothing.
    const windows = Array.from({ length: 200 }, (_unused, frame) => sineWindow(frame));
    const rawLows = new Set(windows.map((window) => window.low.toFixed(6)));
    expect(rawLows.size).toBeGreaterThan(1);

    let range = stickyRange(null, windows[0] as PlotRange);
    const first = range;
    for (const window of windows) {
      range = stickyRange(range, window);
      // Identity, not equality: the caller holds this in a ref and the axis is the same
      // object it was on frame one.
      expect(range).toBe(first);
    }
  });

  it("widens at once when the signal grows past the range", () => {
    const held = stickyRange(null, sineWindow(0));
    const grown = stickyRange(held, sineWindow(0, 3));

    expect(grown).not.toBe(held);
    expect(grown.high).toBeGreaterThanOrEqual(3);
    expect(grown.low).toBeLessThanOrEqual(-3);
  });

  it("holds through a small drop in amplitude — that is noise, not a new scale", () => {
    const held = stickyRange(null, sineWindow(0));
    // 80% of the amplitude still reads as the same signal; following it down would be the
    // breathing bug arriving from the other direction.
    expect(stickyRange(held, sineWindow(0, 0.8))).toBe(held);
  });

  it("follows a genuine collapse down, once", () => {
    const held = stickyRange(null, sineWindow(0));
    const shrunk = stickyRange(held, sineWindow(0, 0.1));

    expect(shrunk).not.toBe(held);
    expect(shrunk.high - shrunk.low).toBeLessThan((held.high - held.low) / 2);
    // And having followed it, it settles: the next window changes nothing.
    expect(stickyRange(shrunk, sineWindow(30, 0.1))).toBe(shrunk);
  });

  it("keeps the range it had when the window is not finite", () => {
    const held = stickyRange(null, sineWindow(0));
    expect(stickyRange(held, { low: Number.NaN, high: Number.NaN })).toBe(held);
    expect(stickyRange(null, { low: Number.POSITIVE_INFINITY, high: 1 })).toEqual({ low: 0, high: 0 });
  });

  it("costs a few axes during warm-up, not one per frame", () => {
    // Each frame adds one sample, so a filling window really does keep revealing new
    // extremes — every one of those is a genuine scale change and the range should
    // follow. What it must not do is produce a fresh axis per frame, which is the
    // per-frame auto-range this replaces.
    const grow = (samples: number) => sineWindow(0, 1, samples);
    const frames = 120;
    let range = stickyRange(null, grow(4));
    const seen = new Set<string>();
    const tail: PlotRange[] = [];
    for (let samples = 4; samples < frames; samples += 1) {
      range = stickyRange(range, grow(samples));
      seen.add(`${range.low}:${range.high}`);
      if (samples > frames - 40) tail.push(range);
    }
    expect(seen.size).toBeLessThan(frames / 5);
    // And once the sine has shown a whole period, the axis is finished moving.
    expect(new Set(tail).size).toBe(1);
  });

  it("picks a step a person would have picked", () => {
    expect(niceStep(2)).toBe(0.5);
    expect(niceStep(0)).toBe(0);
    expect(niceStep(Number.NaN)).toBe(0);
  });
});
