import type { FrameEvaluationInput, TransportSource } from "../types/frame.ts";
import { DEFAULT_PROJECT_FPS, projectFps } from "../types/graph.ts";

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
   * `"timeline"` (default, and TD's) is `frameIndex / fps`: quantised to the frame grid,
   * which is what makes `time * 0.15` move evenly. `"wall"` accumulates the raw clamped
   * deltas instead. Both track real time (T740) — they differ in whether the step is
   * rounded to a frame.
   *
   * Both readings are ALWAYS published: whichever clock is not selected is still
   * available on `wallSeconds` / `wallDeltaSeconds`. What never happens is a mix — the
   * pair always belongs to one clock.
   */
  clock?: "timeline" | "wall";
  /**
   * IS THIS FRAME PART OF A REAL-TIME PRESENTATION? (T740, §V662)
   *
   * The catch-up that fixes T740 is correct for exactly one situation: frames arriving
   * from a SCHEDULER, where a tick that came late means real time — and the audio playing
   * over it — moved on without us. It is wrong for every other caller of `next()`, and
   * this project has several: a seek REPLAYS frames 0..N as fast as it can (§V170), a
   * step button advances one, and `renderFrameRange` steps a take frame by frame with a
   * GPU readback and a video encode between the steps (T433, T431). Those must advance
   * EXACTLY ONE FRAME each, because the frame index is the take, and measuring wall time
   * between them would make a slow machine skip frames and render a different file — the
   * §V44/§V47 failure this project keeps finding, in its most expensive form.
   *
   * ⚠ DEFAULT FALSE, and phrased as a question about the PRESENTATION rather than a list
   * of the deterministic callers (§V662): a caller added later gets the fixed step, which
   * is the safe direction. Forgetting to opt IN costs a slow clock, which is audible and
   * has a named gate; forgetting to opt OUT would silently corrupt a render.
   */
  presenting?: () => boolean;
}

/**
 * The document's default, not a second copy of it (T933). `DEFAULT_PROJECT_FPS`'s own
 * docblock says it is "shared with the transport so the clock and the document cannot
 * disagree about the default" — it was a separate `= 60` here, so the sharing was a
 * claim rather than a fact, and nothing would have caught the two drifting apart.
 */
export const DEFAULT_TIMELINE_FPS = DEFAULT_PROJECT_FPS;

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
 * TIMELINE time removes the jitter by construction — frame N is exactly N/fps — and the
 * wall reading stays available under its own name for anything that wants the raw step.
 *
 * ## What the timeline does NOT do, and T740 is why (§V662)
 *
 * It does not advance by one frame per TICK. This clock is the REALTIME transport — the
 * fixed step per tick belongs to `offlineTransport`, whose modes are `fixed-step` and
 * `offline` and where reproducibility is the whole point (§V44, §V47). Here a tick that
 * arrived late is worth as many frames as actually elapsed.
 *
 * The version that stepped `1/fps` per tick RAN AT HALF SPEED whenever the browser
 * throttled rAF to 30 Hz on a 60 fps project — which is what a laptop does on battery.
 * Every wall-clock consumer then raced ahead of it, and the loudest was audio: an
 * `<audio>` element plays on the hardware's own clock, so `media-playback.ts` found it
 * 0.5 s further along every second and seeked it back roughly every 0.3 s. A periodic,
 * very audible skip, measured at 9 corrections in 3 seconds before this changed.
 *
 * ⚠ THE PRINCIPLE: audio is a REAL-TIME stream with its own hardware clock, and frames
 * are SAMPLES of it. When the two disagree, DROP A FRAME, NEVER A SAMPLE. That is why
 * the catch-up below is counted in WHOLE FRAMES: the timeline stays on the exact k/fps
 * grid that makes `time * 0.15` move evenly, and the deficit is paid by skipping frame
 * numbers rather than by slowing time down or by handing nodes a jittery step.
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
  // T933: through `projectFps`, which is where "what rate is this project" is answered
  // for the settings pane and the scheduler too. This used to be a hand-rolled copy of
  // the same predicate against a hand-rolled copy of the same default.
  const fpsNow = (): number => projectFps({ fps: readFps() });
  const useTimeline = (options.clock ?? "timeline") === "timeline";
  const presenting = options.presenting ?? (() => false);

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
  /** The absolute clock's own `hasEmitted`: it survives `reset`, and `resetAbsolute` re-arms it. */
  let hasEmittedAbs = false;
  /**
   * T740 — elapsed wall time not yet paid out in whole frames, positive or negative.
   *
   * Rounding each tick independently would leave a SYSTEMATIC error at every non-integer
   * ratio: 45 delivered ticks against a 60 fps target rounds 1.33 frames to 1 every time
   * and the timeline runs at 75% speed — the same bug as before, just slower to hear.
   * Carrying the remainder makes the long-run rate exact for any delivery rate.
   */
  let carrySeconds = 0;
  /**
   * A lap the next frame must LAND ON rather than step past (T464, T740).
   *
   * `wrapTo` used to write `frameIndex` directly, which worked while `next` advanced the
   * index AFTER reading it. It advances BEFORE reading now — the step belongs to the frame
   * whose wall delta measured it — so the in point has to be recorded as a target instead
   * or the first frame of every lap would be the in point plus one step.
   */
  let wrapTarget: number | null = null;

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

      const fps = fpsNow();
      const first = !hasEmitted;
      hasEmitted = true;

      /**
       * T740 — how many WHOLE FRAMES of timeline this tick is worth.
       *
       * At least one, always: a tick that produced a frame advanced the timeline by a
       * frame, and a display running FASTER than the target is the scheduler's problem
       * (`createPacedGate` drops those ticks before they reach here), not a reason to
       * report a zero step. The carry is floored at one frame of credit for the same
       * reason — a fast display must not bank an unbounded lead that would later swallow
       * a real stall — and the deficit is capped by `maxDelta`, so a backgrounded tab
       * resyncs by at most that much rather than bursting through a minute of frames.
       */
      let steps = 0;
      if (!first) {
        if (presenting()) {
          carrySeconds = Math.min(Math.max(carrySeconds + wallDeltaSeconds, -1 / fps), maxDelta);
          steps = Math.max(1, Math.round(carrySeconds * fps));
          carrySeconds -= steps / fps;
        } else {
          // Not a presentation: one call, one frame, no clock (see `presenting`). The
          // carry is dropped rather than banked, so a deterministic run of steps cannot
          // leave a debt for the playback that follows it to pay off in skipped frames.
          steps = 1;
          carrySeconds = 0;
        }
      }
      // A pending lap OVERRIDES the advance and nothing else (T464): the wrap frame IS the
      // in point, so it cannot be stepped past — but it still carries this tick's real
      // step in `deltaSeconds` and on the absolute clock below, because playback did not
      // stop. `steps` therefore stays computed and only the INDEX is taken from the wrap.
      if (wrapTarget !== null) {
        frameIndex = wrapTarget;
        wrapTarget = null;
      } else {
        frameIndex += steps;
      }
      const index = frameIndex;

      // The absolute clock keeps its own "first", because `reset` deliberately does not
      // clear it (T461): the tick after a seek is frame zero for the timeline and an
      // ordinary continuing frame for abstime, and it must still advance by a step.
      if (hasEmittedAbs) {
        const absSteps = Math.max(1, steps);
        absFrameIndex += absSteps;
        absSeconds += absSteps / fps;
      }
      hasEmittedAbs = true;
      const absIndex = absFrameIndex;

      // Divided rather than accumulated, so frame N lands on exactly N/fps with no
      // accumulated rounding — but divided from an EPOCH, not from zero, so that changing
      // the project's rate does not teleport the timeline. At 60fps frame 600 is 10s; a
      // naive `index / fps` would make it 20s the instant the rate became 30. Rebasing on
      // the rate change keeps elapsed time continuous while every frame within one rate is
      // still exact. Skipped frame numbers change nothing here: the identity
      // `timeSeconds === frameIndex / fps` is what a dropped frame is MEASURED in.
      if (fps !== epochFps) {
        // Rebase so this frame advances by the NEW rate's step. Carrying the old step for
        // one frame would report a delta of 1/newFps while time moved 1/oldFps, and §V172
        // is exactly that the pair always belongs to one clock — a rate change must not
        // open a one-frame hole in it.
        epochSeconds = lastTimelineSeconds + steps / fps;
        epochIndex = index;
        epochFps = fps;
      }
      const timelineSeconds = epochSeconds + (index - epochIndex) / fps;
      const timelineDelta = steps / fps;
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
      hasEmittedAbs = false;
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
      // T740: a seek starts a fresh run of frames, so it starts with no unpaid remainder
      // and no pending lap — the frame it was going to land on is not where we are going.
      carrySeconds = 0;
      wrapTarget = null;
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
      // T740: recorded rather than written straight to `frameIndex`, because the next
      // frame advances the index before reading it. See `wrapTarget`.
      wrapTarget = index;
      frameIndex = index;
      epochIndex = index;
      epochSeconds = index / fps;
      epochFps = fps;
      lastTimelineSeconds = epochSeconds;
    },
  };
}
