import { describe, expect, it } from "vitest";
import { liveClock } from "./live-clock.ts";

/** §V45: same seed and frame index must reproduce the same frame input. */
describe("liveClock", () => {
  it("advances frameIndex monotonically from zero", () => {
    let t = 0;
    const clock = liveClock({ now: () => (t += 16.67) });

    expect(clock.next().frameIndex).toBe(0);
    expect(clock.next().frameIndex).toBe(1);
    expect(clock.next().frameIndex).toBe(2);
  });

  it("reports realtime mode and carries the project seed", () => {
    const clock = liveClock({ seed: 4242, now: () => 0 });
    const frame = clock.next();

    expect(frame.mode).toBe("realtime");
    expect(frame.randomSeed).toBe(4242);
  });

  it("clamps the WALL delta so a backgrounded tab cannot hand a simulation a huge step", () => {
    let t = 0;
    const clock = liveClock({ maxDeltaSeconds: 0.25, clock: "wall", now: () => t });

    clock.next();
    t = 60_000; // tab slept a minute
    expect(clock.next().deltaSeconds).toBe(0.25);
  });

  /**
   * T271/§V172 — the default clock is the TIMELINE: frame N is exactly N/fps, with a
   * constant step. That is what makes `time * 0.15` move evenly; a wall accumulation
   * jitters by however much rAF jittered, which is the stutter this fixed.
   */
  it("advances timeline time by exactly 1/fps regardless of when frames actually arrived", () => {
    let t = 0;
    const clock = liveClock({ fps: 60, now: () => (t += Math.random() * 40) });

    const first = clock.next();
    const second = clock.next();
    const third = clock.next();

    expect(first.timeSeconds).toBe(0);
    expect(first.deltaSeconds).toBe(0);
    expect(second.timeSeconds).toBeCloseTo(1 / 60, 12);
    expect(second.deltaSeconds).toBeCloseTo(1 / 60, 12);
    expect(third.timeSeconds).toBeCloseTo(2 / 60, 12);
    expect(third.deltaSeconds).toBeCloseTo(1 / 60, 12);
  });

  it("publishes the wall pair alongside it, so real-world sync is still reachable", () => {
    let t = 0;
    const clock = liveClock({ fps: 60, maxDeltaSeconds: 0.25, now: () => t });

    clock.next();
    t = 500; // half a second of real time for one frame
    const frame = clock.next();

    // The timeline advanced one frame; the wall clock advanced half a second. Both are
    // reported, and each is paired with ITS OWN step (§V172) — never mixed.
    expect(frame.timeSeconds).toBeCloseTo(1 / 60, 12);
    expect(frame.deltaSeconds).toBeCloseTo(1 / 60, 12);
    expect(frame.wallSeconds).toBeCloseTo(0.25, 12); // clamped
    expect(frame.wallDeltaSeconds).toBe(0.25);
  });

  it("first frame has zero delta rather than a jump from an unset baseline", () => {
    const clock = liveClock({ now: () => 999_999 });
    expect(clock.next().deltaSeconds).toBe(0);
  });

  it("accumulates wall time from clamped deltas so time- and delta-driven nodes agree", () => {
    let t = 0;
    const clock = liveClock({ maxDeltaSeconds: 0.25, clock: "wall", now: () => t });

    clock.next(); // frame 0 at time 0
    t = 100;
    expect(clock.next().timeSeconds).toBeCloseTo(0.1);
    t = 600_100; // tab slept ten minutes
    const woke = clock.next();
    // Time advances by the same clamped step the simulations receive — not by 600s.
    expect(woke.deltaSeconds).toBe(0.25);
    expect(woke.timeSeconds).toBeCloseTo(0.35);
  });

  it("starts time at zero regardless of the page epoch", () => {
    const clock = liveClock({ now: () => 999_999 });
    expect(clock.next().timeSeconds).toBe(0);
    expect(clock.next().wallSeconds).toBe(0);
  });

  it("reset restarts the time base, not only the frame index", () => {
    let t = 0;
    const clock = liveClock({ now: () => (t += 100) });
    clock.next();
    clock.next();

    clock.reset();
    const frame = clock.next();
    expect(frame.frameIndex).toBe(0);
    expect(frame.timeSeconds).toBe(0);
  });

  it("reset restarts frame index and reseeds", () => {
    let t = 0;
    const clock = liveClock({ seed: 1, now: () => (t += 10) });
    clock.next();
    clock.next();

    clock.reset(7);
    const frame = clock.next();
    expect(frame.frameIndex).toBe(0);
    expect(frame.randomSeed).toBe(7);
    expect(frame.deltaSeconds).toBe(0);
  });
});
