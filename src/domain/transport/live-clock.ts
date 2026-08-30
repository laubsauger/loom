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
  let lastMs: number | null = null;
  let wallSeconds = 0;

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
      // Divided rather than accumulated, so frame N lands on exactly N/fps with no
      // accumulated rounding — but divided from an EPOCH, not from zero, so that changing
      // the project's rate does not teleport the timeline. At 60fps frame 600 is 10s; a
      // naive `index / fps` would make it 20s the instant the rate became 30. Rebasing on
      // the rate change keeps elapsed time continuous while every frame within one rate is
      // still exact.
      if (fps !== epochFps) {
        // Rebase so this frame advances by the NEW rate's step. Carrying the old step for
        // one frame would report a delta of 1/newFps while time moved 1/oldFps, and §V172
        // is exactly that the pair always belongs to one clock — a rate change must not
        // open a one-frame hole in it.
        epochSeconds = lastTimelineSeconds + (index === 0 ? 0 : 1 / fps);
        epochIndex = index;
        epochFps = fps;
      }
      const timelineSeconds = epochSeconds + (index - epochIndex) / fps;
      const timelineDelta = index === 0 ? 0 : 1 / fps;
      lastTimelineSeconds = timelineSeconds;

      return {
        timeSeconds: useTimeline ? timelineSeconds : wallSeconds,
        deltaSeconds: useTimeline ? timelineDelta : wallDeltaSeconds,
        frameIndex: index,
        mode: "realtime",
        randomSeed: seed,
        wallSeconds,
        wallDeltaSeconds,
      };
    },
    reset(nextSeed?: number): void {
      if (nextSeed !== undefined) seed = nextSeed;
      frameIndex = 0;
      lastMs = null;
      wallSeconds = 0;
      epochSeconds = 0;
      epochIndex = 0;
      epochFps = fpsNow();
      lastTimelineSeconds = 0;
    },
  };
}
