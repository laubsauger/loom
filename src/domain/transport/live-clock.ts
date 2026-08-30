import type { FrameEvaluationInput, TransportSource } from "../types/frame.ts";

export interface LiveClockOptions {
  seed?: number;
  maxDeltaSeconds?: number;
  now?: () => number;
  /**
   * Frames per second the TIMELINE advances at (T271). The scheduler must be capped to
   * the same number, or timeline time runs fast on a 120 Hz display and slow on a
   * struggling one — one fps, driving both.
   */
  fps?: number | (() => number);
  /**
   * Which clock `timeSeconds` / `deltaSeconds` carry (T271, §V172).
   *
   * `"timeline"` (default, and TD's) is `frameIndex / fps` with a constant step: uniform
   * by construction, which is what makes `time * 0.15` move evenly. `"wall"` restores the
   * older behaviour, where time accumulates real clamped deltas.
   *
   * Both readings are ALWAYS published: whichever clock is not selected is still
   * available on `wallSeconds` / `wallDeltaSeconds`. What never happens is a mix — the
   * pair always belongs to one clock.
   */
  clock?: "timeline" | "wall";
}

export const DEFAULT_TIMELINE_FPS = 60;

/**
 * Live transport: two clocks, one selected (§I.frame, T63, T271).
 *
 * This is the ONLY place allowed to read wall-clock time. Nodes receive
 * FrameEvaluationInput instead, so a timeline or offline renderer can swap this
 * out without touching node semantics (§V44, §V49).
 *
 * ## Why there are two
 *
 * Real deltas jitter: rAF fires a few milliseconds early or late, so a linear expression
 * on `time` steps unevenly and the motion visibly stutters even at a steady frame rate.
 * TIMELINE time removes the jitter by construction — frame N is exactly N/fps — at the
 * cost of drifting from the wall clock when frames are dropped: playback slows down
 * rather than skipping ahead. That is the TD trade, taken deliberately, and it is why the
 * wall reading stays available under its own name for anything that must match the
 * outside world.
 *
 * ## The pair is never mixed (§V172)
 *
 * `timeSeconds` and `deltaSeconds` always come from the SAME clock. A timeline time with
 * a wall delta would make time-driven nodes and delta-driven nodes advance differently
 * and pull one graph apart — which is the same failure the delta clamp below already
 * fixed for the backgrounded-tab case, in a different disguise.
 */
export function liveClock(options: LiveClockOptions = {}): TransportSource {
  const now = options.now ?? (() => performance.now());
  const maxDelta = options.maxDeltaSeconds ?? 0.25;
  // Read PER FRAME, not captured: the project's fps is a document setting the user can
  // change while running, and re-creating the transport to pick it up would reset
  // `timeSeconds` to zero — a settings edit is not a seek.
  const readFps = typeof options.fps === "function" ? options.fps : () => options.fps as number;
  const fpsNow = (): number => {
    const value = readFps();
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? value
      : DEFAULT_TIMELINE_FPS;
  };
  const useTimeline = (options.clock ?? "timeline") === "timeline";

  let seed = options.seed ?? 0;
  let frameIndex = 0;
  // Timeline epoch: the (time, frame, rate) triple the current run of frames is measured
  // from. Only a rate change moves it.
  let epochSeconds = 0;
  let epochIndex = 0;
  let epochFps = fpsNow();
  let lastTimelineSeconds = 0;
  /**
   * Has this clock emitted a frame since it was last RESET (T464)?
   *
   * Frame zero has no predecessor, so its delta is zero. That test used to be
   * `index === 0`, which stopped being the same question the moment a LOOP could wrap the
   * index back to the in point: playback across a wrap is continuous, so reporting a zero
   * delta there would stall every delta-driven simulation for one frame, once per lap —
   * a stutter with a period, which is the hardest kind to attribute.
   */
  let hasEmitted = false;
  let lastMs: number | null = null;
  let wallSeconds = 0;
  /**
   * The ABSOLUTE clock (T461). Frames this transport has produced, and `reset()` below
   * deliberately does not clear it.
   *
   * That omission is the whole feature. Once the timeline is bounded (T455) a lap is a
   * seek, and a seek resets everything above — so an expression driving a continuous
   * rotation off `time` snaps back every lap with nothing else to reach for. This is the
   * something else. It is a COUNT, never a wall reading: the same graph renders the same
   * frames offline as it plays live (§V44, §V47).
   *
   * Seconds are ACCUMULATED rather than divided, unlike the timeline pair above, and for a
   * reason the timeline does not have: there is no epoch to rebase on. A rate change must
   * leave elapsed absolute time where it is and simply advance by the new step from there,
   * which is what a running sum does and what `absFrames / fps` would not.
   */
  let absFrameIndex = 0;
  let absSeconds = 0;

  return {
    next(): FrameEvaluationInput {
      const nowMs = now();
      const rawDelta = lastMs === null ? 0 : (nowMs - lastMs) / 1000;
      lastMs = nowMs;

      // Clamp so a backgrounded tab does not hand simulations an enormous step.
      const wallDeltaSeconds = Math.min(Math.max(rawDelta, 0), maxDelta);
      // Wall time accumulates from the same clamped deltas the simulations would consume:
      // otherwise a 10-minute background jump moves time-driven nodes 600s while
      // delta-driven ones step 0.25s, and the two halves of one graph diverge.
      // Starting at 0 also keeps f32 shader uniforms precise far longer than the
      // page-epoch timestamps performance.now() returns.
      wallSeconds += wallDeltaSeconds;

      const index = frameIndex++;
      const fps = fpsNow();
      const absIndex = absFrameIndex++;
      if (absIndex > 0) absSeconds += 1 / fps;
      // Divided rather than accumulated, so frame N lands on exactly N/fps with no
      // accumulated rounding — but divided from an EPOCH, not from zero, so that changing
      // the project's rate does not teleport the timeline. At 60fps frame 600 is 10s; a
      // naive `index / fps` would make it 20s the instant the rate became 30. Rebasing on
      // the rate change keeps elapsed time continuous while every frame within one rate is
      // still exact.
      const first = !hasEmitted;
      hasEmitted = true;
      if (fps !== epochFps) {
        // Rebase so this frame advances by the NEW rate's step. Carrying the old step for
        // one frame would report a delta of 1/newFps while time moved 1/oldFps, and §V172
        // is exactly that the pair always belongs to one clock — a rate change must not
        // open a one-frame hole in it.
        epochSeconds = lastTimelineSeconds + (first ? 0 : 1 / fps);
        epochIndex = index;
        epochFps = fps;
      }
      const timelineSeconds = epochSeconds + (index - epochIndex) / fps;
      const timelineDelta = first ? 0 : 1 / fps;
      lastTimelineSeconds = timelineSeconds;

      return {
        timeSeconds: useTimeline ? timelineSeconds : wallSeconds,
        deltaSeconds: useTimeline ? timelineDelta : wallDeltaSeconds,
        frameIndex: index,
        mode: "realtime",
        randomSeed: seed,
        wallSeconds,
        wallDeltaSeconds,
        absFrameIndex: absIndex,
        absTimeSeconds: absSeconds,
      };
    },
    /**
     * T467 — the ONE caller with the right to zero the absolute clock: a RENDER. A take
     * is a fresh performance — the same project rendered on two different days must
     * yield the same abstime and therefore the same bytes (T431's replay contract) —
     * while the LIVE clock keeps counting through every seek and lap (T461). That is
     * why this is a separate verb rather than a flag on `reset`: the live paths cannot
     * reach it by accident.
     */
    resetAbsolute(): void {
      absFrameIndex = 0;
      absSeconds = 0;
    },
    reset(nextSeed?: number): void {
      // T461 — `absFrameIndex` and `absSeconds` are NOT cleared here, and that is the
      // point: a seek (which is what a lap is, §V170) rewinds the timeline and leaves the
      // absolute clock running, so `abstime` is the one number an expression can lean on
      // across a loop boundary. A RENDER zeroes it through `resetAbsolute` (T467).
      if (nextSeed !== undefined) seed = nextSeed;
      frameIndex = 0;
      lastMs = null;
      wallSeconds = 0;
      epochSeconds = 0;
      epochIndex = 0;
      epochFps = fpsNow();
      lastTimelineSeconds = 0;
      hasEmitted = false;
    },
    /**
     * T464 — the LOOP path. Everything a `reset` clears, this deliberately keeps.
     *
     * Compare the two bodies: `reset` above zeroes the seed's frame counter, the wall
     * clock and the epoch, and its callers clear GPU temporal history and CPU stage state
     * alongside it. This moves the timeline epoch and NOTHING else — the wall clock keeps
     * accumulating, the absolute clock keeps counting (T461), `hasEmitted` stays true so
     * the wrap frame carries a real step rather than a zero one, and no caller is being
     * told to clear anything. That difference IS the difference between a lap and a jump.
     */
    wrapTo(target: number): void {
      const index = Math.max(0, Math.trunc(target));
      const fps = fpsNow();
      frameIndex = index;
      epochIndex = index;
      epochSeconds = index / fps;
      epochFps = fps;
      lastTimelineSeconds = epochSeconds;
    },
  };
}
