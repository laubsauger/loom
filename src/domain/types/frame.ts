/**
 * Transport-independent frame input (§I.frame, doc §16.4).
 *
 * The live scheduler supplies these from the browser clock; a future timeline supplies
 * them from playhead state; a future offline renderer supplies exact frame numbers and
 * fixed steps. Time-dependent nodes read ONLY from here — never `Date.now`,
 * `performance.now`, or rAF (§V44, §V49).
 */
export interface FrameEvaluationInput {
  timeSeconds: number;
  deltaSeconds: number;
  frameIndex: number;
  mode: "realtime" | "fixed-step" | "offline";
  randomSeed: number;
}

/** Supplies frame input. Swappable: live clock now, playhead or offline queue later (§V49). */
export interface TransportSource {
  next(): FrameEvaluationInput;
  reset(seed?: number): void;
}
