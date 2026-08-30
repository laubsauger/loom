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
  /**
   * ABSOLUTE frame: frames this transport has produced, and it NEVER resets (T461).
   *
   * The third clock, and the one T455 makes necessary rather than nice. Once the timeline
   * is bounded, `frameIndex` and `timeSeconds` WRAP at the out point — so an expression
   * driving a continuous rotation off `time` snaps back every lap, and its author has no
   * other clock to reach for. This is that clock: TouchDesigner's `absTime`, and the owner
   * named it.
   *
   * What it is NOT is a wall clock, and the difference matters more here than it does in
   * TD. TD's `absTime` is process uptime and is not reproducible. This is a COUNT of
   * frames — the same determinism `frameIndex` has (§V44, §V45, §V47) — so a graph reading
   * it renders the same offline as it does live, and T431's byte-identical audio replay
   * keeps working. A wall-clock version would break both and look perfectly correct in
   * every live session, which is exactly the failure shape this project keeps finding.
   *
   * Optional for the same reason `wallSeconds` is (§V68): a transport that has no absolute
   * clock reports none, and readers fall back to the timeline pair — so the two clocks
   * AGREE until the first lap and diverge only when the timeline actually wraps, which is
   * precisely when the distinction is worth seeing.
   */
  absFrameIndex?: number;
  /** `absFrameIndex` in seconds, at the timeline's rate. Never a wall reading (T461). */
  absTimeSeconds?: number;
}

/**
 * T414: per-frame audio FEATURES — the sound determinism boundary (§V45, §V329).
 *
 * What crosses into the engine is this record, never audio samples. The live session's
 * analyser computes it once per displayed frame (app layer — the engine cannot own a
 * microphone); everything downstream — value channels, uniforms, substep counts — is
 * then a pure function of (frame, features), so the whole audio-reactive family takes
 * exactly one field's worth of §V45 carve-out, the same shape the pointer stream took.
 *
 * REPLAY records FEATURES, not PCM: a recorded `frameIndex → AudioFeatures` track fed
 * back through this field reproduces a performance bit-exactly by construction, where
 * re-analysing audio offline would have to reproduce the browser analyser's windowing
 * and FFT bit-for-bit across engines — a §V47 parity promise nobody can keep. An
 * offline render either replays a track or runs in silence (all zeros) with a notice;
 * it never re-listens.
 *
 * Ranges are nominal 0..1 (levels can exceed 1 on hot signals; consumers clamp via
 * `valueLimit`). Smoothing is deliberately ABSENT — `valueLag` downstream gives both
 * the raw transient and the damped envelope, where a pre-smoothed source gives neither.
 */
export interface AudioFeatures {
  /** Broadband RMS of the current analysis window. */
  readonly level: number;
  /** Band energies: ~20-250 Hz, 250-2k, 2k-6k, 6k-16k. */
  readonly low: number;
  readonly lowMid: number;
  readonly highMid: number;
  readonly high: number;
  /**
   * Positive spectral flux, normalised — an ONSET envelope, not a beat claim: it rises
   * on any broadband energy increase (a kick, a snare, a chord, a cough). Threshold it
   * yourself (`valueTrigger`) for the transients you mean.
   */
  readonly onset: number;
  /**
   * T437: onset EVENTS within the frame interval — rising crossings of the pinned
   * event threshold (see `ONSET_EVENT_THRESHOLD`). Semantics are interval-shaped on
   * purpose: with per-frame analysis this is 0 or 1; a faster analysis hop later can
   * report 2 or 3 for a frame containing several transients WITHOUT changing what the
   * field means — only its fidelity. That is what lets the field land before any
   * recorded track exists (§V352's corollary: semantics are the recorded contract).
   */
  readonly onsetCount: number;
  /** T437: the largest onset value observed within the frame interval (≥ `onset` once analysis outpaces the frame rate; equal to it today). */
  readonly onsetMax: number;
}

/** Wall time, falling back to the timeline when the transport supplied none (§V172). */
export function wallSecondsOf(frame: FrameEvaluationInput): number {
  return frame.wallSeconds ?? frame.timeSeconds;
}

/** Wall delta, falling back to the timeline step when the transport supplied none. */
export function wallDeltaSecondsOf(frame: FrameEvaluationInput): number {
  return frame.wallDeltaSeconds ?? frame.deltaSeconds;
}

/**
 * Absolute time, falling back to the timeline reading when the transport supplied none.
 *
 * The fallback is the SAFE one and it is deliberate: timeline time is deterministic, so a
 * transport with no absolute clock still gives a reproducible number rather than a
 * plausible-looking wall reading (T461, §V44).
 */
export function absTimeSecondsOf(frame: FrameEvaluationInput): number {
  return frame.absTimeSeconds ?? frame.timeSeconds;
}

/** Absolute frame count, falling back to the timeline index for the same reason. */
export function absFrameIndexOf(frame: FrameEvaluationInput): number {
  return frame.absFrameIndex ?? frame.frameIndex;
}

/** Supplies frame input. Swappable: live clock now, playhead or offline queue later (§V49). */
export interface TransportSource {
  next(): FrameEvaluationInput;
  /**
   * Start over: the timeline goes back to zero AND stateful stages are cleared by the
   * caller alongside it (§V170, §V181). This is what a SEEK does.
   */
  reset(seed?: number): void;
  /**
   * T467: zero the ABSOLUTE clock (T461) — the render path's verb, and only its. A take
   * is a fresh performance: the same project rendered on two different days must carry
   * the same abstime into every frame, or expressions reading it change the pixels.
   * The live clock never calls this; seeks and laps leave abstime growing.
   */
  resetAbsolute(): void;
  /**
   * WRAP the timeline to a frame, keeping everything else running (T464).
   *
   * **A LOOP IS NOT A SEEK.** This is the distinction the transport was missing, and the
   * owner caught its absence: when a piece reaches its out point, playback CONTINUES —
   * only the time VALUE wraps. A feedback that survives the wrap is what makes long-form
   * feedback work at all, and it is what TouchDesigner does.
   *
   * §V181 is not weakened by this; it was being applied outside the situation it was
   * written for. Its reasoning is that REPLAYED frames must not carry a trajectory from a
   * history they did not come from — which is true of a scrub, where the user jumped, and
   * false of a lap, where nothing was skipped and no frame is replayed. The rule is right;
   * its blast radius was not checked.
   *
   * So this changes the CLOCK and nothing else: no temporal history is cleared, no CPU
   * stage is reset, no frame is replayed, and the absolute clock (T461) keeps counting —
   * which is what lets `time` wrap while `abstime` does not.
   *
   * Optional: a transport with no notion of wrapping (the offline queue) simply omits it,
   * and a caller that finds it absent has nothing to fall back to except a seek, which it
   * must then choose deliberately.
   */
  wrapTo?(frameIndex: number): void;
}
