import { describe, expect, it } from "vitest";
import { liveClock } from "./live-clock.ts";
import { absFrameIndexOf, absTimeSecondsOf } from "../types/frame.ts";
import { scopeFromFrame } from "../expressions/evaluate.ts";
import { evaluateExpression } from "../expressions/evaluate.ts";
import { frameVariableNames } from "../expressions/reference.ts";

/**
 * THE CLOCK THAT DOES NOT RESET (T461, T455).
 *
 * ## Why this exists at all
 *
 * T455 bounds the timeline: a piece of length N plays 0..N-1 and wraps, so `time` and
 * `frame` restart at every lap. That takes something away — an expression driving a
 * continuous rotation off `time * 90` looks right for one lap and snaps back forever
 * after, and there is no other clock to reach for. `abstime` is that clock.
 *
 * ## The constraint that makes ours differ from TouchDesigner's
 *
 * TD's `absTime` is process uptime. Ours is a frame COUNT divided by the timeline rate,
 * and the difference is determinism: a wall-clock absolute time would render differently
 * every time the same project was rendered, and would look perfectly correct in every live
 * session while doing it. That is the exact failure shape §V44/§V47 exist for, so the
 * "never a wall reading" half is asserted here rather than trusted to a comment (§V375).
 */

/** A clock whose wall reading advances fast, so a wall-derived absTime would be obvious. */
function clockWithWall(fps = 60) {
  let ms = 0;
  return liveClock({
    fps,
    now: () => {
      ms += 200;
      return ms;
    },
  });
}

describe("liveClock's absolute clock (T461)", () => {
  it("counts frames and reports them in seconds at the timeline rate", () => {
    const clock = liveClock({ fps: 60 });
    for (let index = 0; index < 5; index += 1) clock.next();
    const frame = clock.next();
    expect(frame.absFrameIndex).toBe(5);
    expect(frame.absTimeSeconds).toBeCloseTo(5 / 60, 10);
  });

  it("SURVIVES a reset, where the timeline pair does not — the whole point", () => {
    const clock = liveClock({ fps: 60 });
    for (let index = 0; index < 10; index += 1) clock.next();
    clock.reset();
    const afterLap = clock.next();

    // The timeline is back at the beginning...
    expect(afterLap.frameIndex).toBe(0);
    expect(afterLap.timeSeconds).toBe(0);
    // ...and the absolute clock is not. `frameIndex % length` would give both of these
    // the same value, which is precisely the version that takes `abstime` away.
    expect(afterLap.absFrameIndex).toBe(10);
    expect(afterLap.absTimeSeconds).toBeCloseTo(10 / 60, 10);
  });

  it("keeps counting across MANY laps, monotonically", () => {
    const clock = liveClock({ fps: 60 });
    let previous = -1;
    for (let lap = 0; lap < 4; lap += 1) {
      for (let index = 0; index < 3; index += 1) {
        const frame = clock.next();
        expect(frame.absFrameIndex ?? -1).toBeGreaterThan(previous);
        previous = frame.absFrameIndex ?? -1;
      }
      clock.reset();
    }
    expect(previous).toBe(11);
  });

  it("is a FRAME COUNT, not the wall clock — the determinism half (§V44, §V47)", () => {
    // 200ms of wall time per frame against a 60fps timeline: after ten frames the wall
    // reads 2s and the absolute clock must read 10/60. A wall-derived absTime would be an
    // order of magnitude out here and identical to `wallSeconds`.
    const clock = clockWithWall(60);
    for (let index = 0; index < 10; index += 1) clock.next();
    const frame = clock.next();
    expect(frame.absTimeSeconds).toBeCloseTo(10 / 60, 6);
    expect(frame.wallSeconds).toBeGreaterThan(1);
    expect(frame.absTimeSeconds).not.toBeCloseTo(frame.wallSeconds ?? 0, 2);
  });

  it("advances by the NEW step after a rate change, rather than rescaling what elapsed", () => {
    let fps = 60;
    const clock = liveClock({ fps: () => fps });
    for (let index = 0; index < 60; index += 1) clock.next();
    const atSixty = clock.next();
    expect(atSixty.absTimeSeconds).toBeCloseTo(1, 6);

    fps = 30;
    const afterChange = clock.next();
    // One second elapsed stays one second elapsed; the next frame is worth 1/30 now.
    // `absFrameIndex / fps` would have teleported this to two seconds.
    expect(afterChange.absTimeSeconds).toBeCloseTo(1 + 1 / 30, 6);
  });

  it("falls back to the timeline reading for a transport that has no absolute clock (§V68)", () => {
    const bare = { timeSeconds: 3, deltaSeconds: 1 / 60, frameIndex: 180, mode: "offline" as const, randomSeed: 1 };
    // The SAFE fallback: a deterministic number, never an invented wall reading.
    expect(absTimeSecondsOf(bare)).toBe(3);
    expect(absFrameIndexOf(bare)).toBe(180);
  });
});

describe("the expression scope carries both clocks (T461, §V150)", () => {
  it("offers `abstime` and `absframe` beside `time` and `frame`", () => {
    const clock = liveClock({ fps: 60 });
    for (let index = 0; index < 4; index += 1) clock.next();
    clock.reset();
    const scope = scopeFromFrame(clock.next());
    expect(scope["time"]).toBe(0);
    expect(scope["frame"]).toBe(0);
    expect(scope["absframe"]).toBe(4);
    expect(scope["abstime"]).toBeCloseTo(4 / 60, 10);
  });

  it("an expression can actually READ them — a name in the scope the evaluator rejects is worse than none", () => {
    const clock = liveClock({ fps: 60 });
    for (let index = 0; index < 120; index += 1) clock.next();
    clock.reset();
    const scope = scopeFromFrame(clock.next());
    const rotation = evaluateExpression("abstime * 90", scope);
    expect(rotation.ok).toBe(true);
    // Two seconds of absolute time at 90 degrees a second, on a timeline that has just
    // been rewound to zero. Accumulated seconds carry the usual float dust, so this is
    // close-to rather than exact — the claim is the VALUE, not the last bit of it.
    expect(rotation.ok ? rotation.value : Number.NaN).toBeCloseTo(180, 6);
  });

  it("the completion menu and the help panel pick them up WITHOUT a second list (§V150)", () => {
    // `frameVariableNames` asks `scopeFromFrame`; nothing was hand-added anywhere. If this
    // ever needs an edit elsewhere to pass, the derivation has been broken.
    expect(frameVariableNames()).toContain("abstime");
    expect(frameVariableNames()).toContain("absframe");
  });
});

/**
 * WRAPPING IS NOT RESETTING (T464).
 *
 * `reset` and `wrapTo` sit next to each other in `liveClock` and differ only in what they
 * leave alone — which is exactly the kind of difference that erodes into "they both start
 * the timeline over" unless something holds them apart. These are the observable
 * consequences of the difference, one assertion each.
 */
describe("liveClock.wrapTo (T464)", () => {
  it("moves the timeline to the in point and leaves the ABSOLUTE clock running", () => {
    const clock = liveClock({ fps: 60 });
    for (let index = 0; index < 8; index += 1) clock.next();
    clock.wrapTo?.(0);
    const wrapped = clock.next();

    expect(wrapped.frameIndex).toBe(0);
    expect(wrapped.timeSeconds).toBe(0);
    // T461's whole purpose: `time` wraps, `abstime` does not, so a continuous rotation
    // driven off `abstime` does not snap back while the feedback keeps running.
    expect(wrapped.absFrameIndex).toBe(8);
  });

  it("carries a REAL step across the wrap, not the zero delta frame 0 gets", () => {
    const clock = liveClock({ fps: 60 });
    for (let index = 0; index < 4; index += 1) clock.next();
    clock.wrapTo?.(0);
    // A zero delta here would stall every delta-driven simulation for one frame, once per
    // lap — a stutter with a period, which is the hardest kind to attribute to anything.
    expect(clock.next().deltaSeconds).toBeCloseTo(1 / 60, 10);
  });

  it("resets the step only after a real RESET, where there genuinely is no previous frame", () => {
    const clock = liveClock({ fps: 60 });
    for (let index = 0; index < 4; index += 1) clock.next();
    clock.reset();
    expect(clock.next().deltaSeconds).toBe(0);
  });

  it("wraps to a NON-ZERO in point, with time to match", () => {
    const clock = liveClock({ fps: 60 });
    for (let index = 0; index < 20; index += 1) clock.next();
    clock.wrapTo?.(5);
    const wrapped = clock.next();
    expect(wrapped.frameIndex).toBe(5);
    expect(wrapped.timeSeconds).toBeCloseTo(5 / 60, 10);
  });

  it("keeps the WALL clock accumulating, because no real time was skipped", () => {
    const clock = clockWithWall(60);
    for (let index = 0; index < 5; index += 1) clock.next();
    const before = clock.next().wallSeconds ?? 0;
    clock.wrapTo?.(0);
    const after = clock.next().wallSeconds ?? 0;
    // `reset` zeroes this; a lap must not, because the wall clock did not stop.
    expect(after).toBeGreaterThan(before);
  });
});

describe("T467 — only a RENDER zeroes the absolute clock", () => {
  it("resetAbsolute starts the show clock over; reset still leaves it growing", () => {
    const clock = liveClock({ fps: 60 });
    for (let index = 0; index < 10; index += 1) clock.next();

    // T461, restated as the contrast: a seek's reset keeps the clock counting…
    clock.reset();
    expect(clock.next().absFrameIndex).toBe(10);

    // …and a take's resetAbsolute is the one verb that starts it over — the fresh
    // performance rule: same project, any day, same abstime, same bytes.
    clock.resetAbsolute();
    clock.reset();
    const fresh = clock.next();
    expect(fresh.absFrameIndex).toBe(0);
    expect(fresh.absTimeSeconds).toBe(0);
  });
});
