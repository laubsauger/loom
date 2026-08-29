/**
 * Transport-independent frame input (§I.frame, doc §16.4).
 *
 * The live scheduler supplies these from the browser clock; a future timeline supplies
 * them from playhead state; a future offline renderer supplies exact frame numbers and
 * fixed steps. Time-dependent nodes read ONLY from here — never `Date.now`,
 * `performance.now`, or rAF (§V44, §V49).
 */
export interface FrameEvaluationInput {
  /**
   * TIMELINE time: `frameIndex / fps`, uniform by construction (T271, §V172).
   *
   * The default clock, and TD's. A linear expression on `time` steps evenly because the
   * step is a constant, where a wall-clock accumulation jitters by however much rAF
   * jittered — which is what "`time * 0.15` animates jittery" actually was.
   *
   * The trade is deliberate: with a fixed step a dropped frame SLOWS the animation
   * instead of skipping it, and playback drifts from the wall clock. Anyone who needs
   * real-world sync reads `wallSeconds` instead, which is exactly why it exists.
   */
  timeSeconds: number;
  /**
   * The step that belongs to `timeSeconds`, and only ever that one.
   *
   * §V172: time and delta must come from the SAME clock. Mixing a timeline time with a
   * wall delta makes time-driven nodes and delta-driven nodes advance differently, and
   * the two halves of one graph drift apart — the exact failure `liveClock` fixed once
   * already for the backgrounded-tab case.
   */
  deltaSeconds: number;
  frameIndex: number;
  mode: "realtime" | "fixed-step" | "offline";
  randomSeed: number;
  /**
   * WALL time: seconds of real time since playback started, clamped per step.
   *
   * The second half of the dual clock (T271). Optional, and a reader that finds it absent
   * uses `timeSeconds` — which is the SAFE fallback, because timeline time is
   * deterministic and an offline render therefore stays reproducible (§V44) whether or
   * not its transport bothered to supply a wall reading. A transport that has no wall
   * clock at all (an offline queue) sets these EQUAL to the timeline pair rather than
   * inventing a reading, for the same reason.
   */
  wallSeconds?: number;
  /** The step that belongs to `wallSeconds` (§V172). Clamped exactly as it is. */
  wallDeltaSeconds?: number;
}

/** Wall time, falling back to the timeline when the transport supplied none (§V172). */
export function wallSecondsOf(frame: FrameEvaluationInput): number {
  return frame.wallSeconds ?? frame.timeSeconds;
}

/** Wall delta, falling back to the timeline step when the transport supplied none. */
export function wallDeltaSecondsOf(frame: FrameEvaluationInput): number {
  return frame.wallDeltaSeconds ?? frame.deltaSeconds;
}

/** Supplies frame input. Swappable: live clock now, playhead or offline queue later (§V49). */
export interface TransportSource {
  next(): FrameEvaluationInput;
  reset(seed?: number): void;
}
