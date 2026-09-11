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

/** `count` frames evenly spread across the trailing window. */
function frames(count: number): number[] {
  return Array.from({ length: count }, (_, i) => NOW - FRAME_CLOCK_WINDOW_MS + ((i + 1) * FRAME_CLOCK_WINDOW_MS) / count);
}

/** N frames per second, evenly spread across the trailing window. */
function cadence(fps: number): number[] {
  return frames(Math.round((fps * FRAME_CLOCK_WINDOW_MS) / 1000));
}

/** The frames a full window holds at a project rate. 60 fps over 1500 ms is 90. */
function windowFrames(fps: number): number {
  return Math.round((fps * FRAME_CLOCK_WINDOW_MS) / 1000);
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

  /**
   * T1300 — the owner, reading the header: *"if project fps is 60 and we achieve 30 what
   * does live even mean then. that's super arbitrary"*. It meant "the clock is running",
   * and nothing else. These assert that the two questions are now separate and that the
   * old one did not move: `kind` is unchanged (other consumers read it by name), and
   * `realtime` answers the question the header's indicator actually asks.
   */
  describe("realtime is a SECOND question — at the set rate or above", () => {
    function realtimeAt(count: number, fps = 60): boolean {
      return frameClockVerdict({ playing: true, hidden: false, settings: { fps }, recentFrameTimes: frames(count), now: NOW }).realtime;
    }

    it("the band between half rate and full rate is LIVE and is NOT realtime", () => {
      // The exact case the owner named, and the band the header used to say nothing about.
      const verdict = frameClockVerdict({ playing: true, hidden: false, settings: SETTINGS, recentFrameTimes: cadence(30), now: NOW });
      expect(verdict.kind).toBe("live");
      expect(verdict.realtime).toBe(false);
    });

    it("at the project rate it is realtime, and above it stays realtime", () => {
      expect(realtimeAt(windowFrames(60))).toBe(true);
      // A 100 Hz display running a 60 fps project renders more than the window expects.
      expect(realtimeAt(windowFrames(100))).toBe(true);
    });

    it("tolerates the window's counting jitter and one dropped frame, and not a third", () => {
      // `recent` is a count over a trailing window, so a loop dead on 60 fps reads 89 or 90
      // purely from where `now` fell between two frames. One more frame is a genuinely
      // dropped one, which is compositor noise. The third is a shortfall a person can see,
      // and is where the indicator must stop saying Realtime.
      const full = windowFrames(60);
      expect(realtimeAt(full - 1)).toBe(true);
      expect(realtimeAt(full - 2)).toBe(true);
      expect(realtimeAt(full - 3)).toBe(false);
    });

    it("the slack is counted in FRAMES, so a slow project is not graded on a fast one's tolerance", () => {
      // 24 fps holds 36 frames per window. Two short is still realtime — the same two
      // frames of jitter a 60 fps project gets, not a fraction that shrinks with the rate.
      expect(realtimeAt(windowFrames(24) - 2, 24)).toBe(true);
      expect(realtimeAt(windowFrames(24) - 3, 24)).toBe(false);
      // And it cannot swallow a slow project. 6 fps holds nine frames per window, so a flat
      // two-frame slack would call 4.67 fps realtime; capped at a tenth of the window, even
      // ONE short is behind. The same "two frames" that is noise at 60 fps is a sixth of
      // the rate at 6, which is why the slack is capped and not merely counted.
      expect(realtimeAt(windowFrames(6), 6)).toBe(true);
      expect(realtimeAt(windowFrames(6) - 1, 6)).toBe(false);
    });

    it("a rate whose window count is fractional can still reach realtime", () => {
      // 3 fps expects 4.5 frames per window and `recent` is an integer, so a threshold that
      // rounded UP would read Behind forever on a project doing exactly what it was told.
      // The half-frame floor is that rounding rule, not a tolerance.
      expect(realtimeAt(4, 3)).toBe(true);
      expect(realtimeAt(3, 3)).toBe(false);
    });

    it("nothing below half rate can claim realtime — the kinds settle it by construction", () => {
      expect(frameClockVerdict({ playing: true, hidden: false, settings: SETTINGS, recentFrameTimes: cadence(10), now: NOW }).realtime).toBe(false);
      expect(frameClockVerdict({ playing: true, hidden: true, settings: SETTINGS, recentFrameTimes: [], now: NOW }).realtime).toBe(false);
      // Paused is not realtime either: nothing is rendering, so there is no rate to hit.
      expect(frameClockVerdict({ playing: false, hidden: false, settings: SETTINGS, recentFrameTimes: cadence(60), now: NOW }).realtime).toBe(false);
    });
  });

  it("no frames at all while playing collapses to the verdict, not to a crash", () => {
    expect(frameClockVerdict({ playing: true, hidden: true, settings: SETTINGS, recentFrameTimes: [], now: NOW }).kind).toBe("browser-throttled");
    // Stale frames outside the window count as none: a loop that JUST stopped reads
    // as stopped, not as its last good second.
    const stale = cadence(60).map((at) => at - FRAME_CLOCK_WINDOW_MS * 3);
    expect(frameClockVerdict({ playing: true, hidden: false, settings: SETTINGS, recentFrameTimes: stale, now: NOW }).kind).toBe("running-behind");
  });
});
