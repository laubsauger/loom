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
   * T271/§V172 — the default clock is the TIMELINE: frame N is exactly N/fps. That is what
   * makes `time * 0.15` move evenly; a raw wall accumulation jitters by however much rAF
   * jittered, which is the stutter T271 fixed.
   *
   * T740 narrowed the claim from "regardless of when frames arrived" to "regardless of
   * rAF's JITTER". Ticks that arrive a few milliseconds early or late are still worth
   * exactly one frame — the jitter is rounded away, which is the whole property — but a
   * tick that arrives a WHOLE FRAME late is worth two, because it was.
   */
  it("rounds rAF jitter away: an early or late tick is still exactly one frame", () => {
    // ±5ms around 16.67, which is what a healthy 60 Hz rAF actually looks like.
    const arrivals = [0, 11, 33, 45, 67, 78];
    let tick = -1;
    const clock = liveClock({ fps: 60, presenting: () => true, now: () => arrivals[(tick += 1)] ?? 0 });

    const first = clock.next();
    expect(first.timeSeconds).toBe(0);
    expect(first.deltaSeconds).toBe(0);
    for (let index = 1; index < arrivals.length; index += 1) {
      const frame = clock.next();
      expect(frame.frameIndex).toBe(index);
      expect(frame.timeSeconds).toBeCloseTo(index / 60, 12);
      expect(frame.deltaSeconds).toBeCloseTo(1 / 60, 12);
    }
  });

  /**
   * T740 — THE BUG, at the clock. A browser throttling rAF to 30 Hz on a 60 fps project is
   * a laptop on battery, and the fixed step made the timeline run at HALF SPEED there.
   * Audio does not slow down to match: `media-playback.ts` found the element half a second
   * further along every second and seeked it back roughly every 0.3s, which is what the
   * owner heard. The timeline keeps up by SKIPPING FRAME NUMBERS — drop a frame, never a
   * sample — so time stays on the exact k/fps grid rather than becoming a wall reading.
   */
  it("keeps up with real time when the browser delivers HALF the ticks (T740)", () => {
    let t = 0;
    const clock = liveClock({ fps: 60, presenting: () => true, now: () => t });

    clock.next();
    let last = 0;
    for (let tick = 1; tick <= 30; tick += 1) {
      t = tick * (1000 / 30); // 30 delivered ticks in one real second
      const frame = clock.next();
      expect(frame.deltaSeconds).toBeCloseTo(2 / 60, 12); // two frames' worth, because it was
      expect(frame.frameIndex).toBe(tick * 2); // and the odd frame numbers are DROPPED
      last = frame.timeSeconds;
    }
    // One second of real time, one second of timeline. The old fixed step reported 0.5.
    expect(last).toBeCloseTo(1, 9);
  });

  /**
   * T740/§V662 — THE OTHER HALF, and the expensive one to get wrong.
   *
   * `renderFrameRange` steps a take one frame at a time with a GPU readback and a video
   * encode between the steps, and `seek` replays 0..N as fast as the machine manages
   * (§V170). Neither is a presentation: the frame index IS the take, so a step must be
   * worth exactly one frame however long it took. A clock that measured wall time here
   * would make a slow machine render a SHORTER, faster file from the same project — T431's
   * replay contract broken by a fix aimed at something else entirely.
   */
  it("a step that is NOT part of a presentation is worth exactly one frame, whatever the wall says", () => {
    let t = 0;
    // 250ms per step: a heavy replay frame, and fifteen frames' worth of wall time at 60fps.
    const clock = liveClock({ fps: 60, now: () => (t += 250) });

    for (let index = 0; index < 20; index += 1) {
      const frame = clock.next();
      expect(frame.frameIndex).toBe(index);
      expect(frame.absFrameIndex).toBe(index);
      expect(frame.timeSeconds).toBeCloseTo(index / 60, 12);
      expect(frame.deltaSeconds).toBe(index === 0 ? 0 : 1 / 60);
    }
  });

  it("switching from presenting to stepping does not pay off a banked deficit in skipped frames", () => {
    // The seek path: playback throttled to 30Hz (so the clock is mid-carry), then paused
    // and stepped. The step must be one frame, not one frame plus whatever was owed.
    let t = 0;
    let live = true;
    const clock = liveClock({ fps: 60, presenting: () => live, now: () => t });
    clock.next();
    for (let tick = 1; tick <= 10; tick += 1) {
      t = tick * (1000 / 30);
      clock.next();
    }
    live = false;
    const before = clock.next();
    t += 500;
    expect(clock.next().frameIndex).toBe(before.frameIndex + 1);
  });

  it("publishes the wall pair alongside it, quantised where the wall pair is raw", () => {
    let t = 0;
    const clock = liveClock({ fps: 60, maxDeltaSeconds: 0.25, presenting: () => true, now: () => t });

    clock.next();
    t = 500; // half a second of real time for one frame
    const frame = clock.next();

    // Both are reported and each is paired with ITS OWN step (§V172) — never mixed. They
    // measure the same elapsed time (T740: the clamped 0.25s, not 1/60 of it) and differ
    // in SHAPE: the timeline lands on a frame boundary, the wall reading does not have to.
    expect(frame.wallSeconds).toBeCloseTo(0.25, 12); // clamped
    expect(frame.wallDeltaSeconds).toBe(0.25);
    expect(frame.timeSeconds).toBeCloseTo(0.25, 12);
    expect(frame.deltaSeconds).toBeCloseTo(0.25, 12);
    expect(frame.frameIndex).toBe(15); // 0.25s at 60fps, exactly
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

describe("fps as a live setting (T272)", () => {
  it("reads the rate every frame, so a project setting can change while running", () => {
    let fps = 60;
    const clock = liveClock({ fps: () => fps, now: () => 0 });
    clock.next();
    fps = 30;
    // The step is the NEW rate's, immediately — not the one captured at construction.
    const before = clock.next().timeSeconds;
    expect(clock.next().timeSeconds - before).toBeCloseTo(1 / 30, 10);
  });

  it("does not teleport the timeline when the rate changes", () => {
    // The bug this prevents: with a naive `frameIndex / fps`, frame 600 reads 10s at
    // 60fps and 20s the instant the rate becomes 30 — every time-driven node in the
    // project jumps ten seconds because someone nudged a settings field.
    let fps = 60;
    const clock = liveClock({ fps: () => fps, now: () => 0 });
    let last = 0;
    for (let i = 0; i < 600; i += 1) last = clock.next().timeSeconds;
    expect(last).toBeCloseTo(599 / 60, 10);

    fps = 30;
    const after = clock.next().timeSeconds;
    // Continuous: one frame later, one frame's worth of time at the new rate.
    expect(after - last).toBeCloseTo(1 / 30, 10);
  });

  it("stays exact within a rate, so frames are not walked into drift", () => {
    // Rebasing must not turn division into accumulation — 10000 frames of `+= 1/fps`
    // accumulates float error that `index / fps` does not have.
    const clock = liveClock({ fps: () => 60, now: () => 0 });
    let last = 0;
    for (let i = 0; i < 10_000; i += 1) last = clock.next().timeSeconds;
    expect(last).toBe(9999 / 60);
  });
});
