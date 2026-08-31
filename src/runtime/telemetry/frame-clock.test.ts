import { describe, expect, it } from "vitest";
import { FRAME_CLOCK_WINDOW_MS, frameClockVerdict } from "./frame-clock.ts";

/**
 * T304 — the verdict distinguishes the three facts a frozen picture can mean, and it
 * can tell "throttle detected" from "notice always on" (§V461: this is a notice about
 * a condition the test environment does not naturally have, so the healthy case is
 * asserted as hard as the broken ones).
 */
const NOW = 100_000;
const SETTINGS = { fps: 60 };

/** N frames evenly spread across the trailing window. */
function cadence(fps: number): number[] {
  const count = Math.round((fps * FRAME_CLOCK_WINDOW_MS) / 1000);
  return Array.from({ length: count }, (_, i) => NOW - FRAME_CLOCK_WINDOW_MS + ((i + 1) * FRAME_CLOCK_WINDOW_MS) / count);
}

describe("T304 — frameClockVerdict", () => {
  it("a healthy playing clock is LIVE — the notice is not always on", () => {
    const verdict = frameClockVerdict({ playing: true, hidden: false, settings: SETTINGS, recentFrameTimes: cadence(58), now: NOW });
    expect(verdict.kind).toBe("live");
  });

  it("not playing is PAUSED, whatever the cadence — three facts, three names (§V541)", () => {
    expect(frameClockVerdict({ playing: false, hidden: true, settings: SETTINGS, recentFrameTimes: [], now: NOW }).kind).toBe("paused");
    expect(frameClockVerdict({ playing: false, hidden: false, settings: SETTINGS, recentFrameTimes: cadence(60), now: NOW }).kind).toBe("paused");
  });

  it("playing + hidden + collapsed cadence is the BROWSER, and the suggestion names both remedies", () => {
    const verdict = frameClockVerdict({ playing: true, hidden: true, settings: SETTINGS, recentFrameTimes: cadence(1), now: NOW });
    expect(verdict.kind).toBe("browser-throttled");
    if (verdict.kind !== "browser-throttled") return;
    // §V403 both readers: the human route and the honest automation statement.
    expect(verdict.suggestion).toContain("front");
    expect(verdict.suggestion).toContain("automation");
    expect(verdict.suggestion).toContain("nothing is broken");
  });

  it("playing + VISIBLE + collapsed cadence is the MACHINE, not the browser", () => {
    const verdict = frameClockVerdict({ playing: true, hidden: false, settings: SETTINGS, recentFrameTimes: cadence(10), now: NOW });
    expect(verdict.kind).toBe("running-behind");
    if (verdict.kind !== "running-behind") return;
    expect(verdict.observedFps).toBeCloseTo(10, 0);
    expect(verdict.suggestion).toContain("performance pane");
  });

  it("the boundary is HALF the project rate, floored at 1 for slow art", () => {
    // 31 of 60 expected: above half — live even though frames are dropping.
    expect(frameClockVerdict({ playing: true, hidden: false, settings: SETTINGS, recentFrameTimes: cadence(31), now: NOW }).kind).toBe("live");
    // 29 of 60: under half — behind.
    expect(frameClockVerdict({ playing: true, hidden: false, settings: SETTINGS, recentFrameTimes: cadence(29), now: NOW }).kind).toBe("running-behind");
    // A deliberate 2fps project at its own full rate is LIVE, not broken.
    expect(frameClockVerdict({ playing: true, hidden: false, settings: { fps: 2 }, recentFrameTimes: cadence(2), now: NOW }).kind).toBe("live");
  });

  it("no frames at all while playing collapses to the verdict, not to a crash", () => {
    expect(frameClockVerdict({ playing: true, hidden: true, settings: SETTINGS, recentFrameTimes: [], now: NOW }).kind).toBe("browser-throttled");
    // Stale frames outside the window count as none: a loop that JUST stopped reads
    // as stopped, not as its last good second.
    const stale = cadence(60).map((at) => at - FRAME_CLOCK_WINDOW_MS * 3);
    expect(frameClockVerdict({ playing: true, hidden: false, settings: SETTINGS, recentFrameTimes: stale, now: NOW }).kind).toBe("running-behind");
  });
});
