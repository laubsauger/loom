import type { AudioSpectrumBands } from "../audio/spectrum-bands.ts";
import type { AudioTonalFields } from "../audio/tonal-fields.ts";
import { DEFAULT_PROJECT_FPS } from "./graph.ts";

/**
 * Transport-independent frame input (§I.frame, doc §16.4).
 *
 * The live scheduler supplies these from the browser clock; a future timeline supplies
 * them from playhead state; a future offline renderer supplies exact frame numbers and
 * fixed steps. Time-dependent nodes read ONLY from here — never `Date.now`,
 * `performance.now`, or rAF (§V44, §V49).
 *
 * T1554b: this is the shape a frame is READ as, and its clock fields stay optional so a
 * test can hand a consumer the five fields it cares about. Product code never builds one:
 * every frame it produces comes from `frameFromClock` or `ZERO_FRAME` below, as an
 * `EvaluationFrame` with every clock filled, and `frame-literals.test.ts` fails on a frame
 * object literal anywhere else.
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
  /**
   * T1497b — WHICH RUN of the absolute clock `absTimeSeconds` counts in: an opaque id the
   * app mints each time that clock starts from zero (session start, a render's
   * `resetAbsolute`) and when a different document opens.
   *
   * A preset morph is stamped with the absolute time of its recall, and `absTimeSeconds`
   * alone cannot say whether a stamp belongs to THIS count: a render zeroes the clock, so
   * a record stamped at live second 3 would replay three seconds into the next export, on
   * every export. A record from another epoch is FINISHED, which is what makes a saved
   * document render its end state byte-identically (the design doc §5.4).
   *
   * Compared for equality and nothing else — never parsed, never ordered, never shown.
   * Optional (§V68): a transport that mints none (the offline transport, a preview's own
   * clock) publishes none, and every morph record is then finished for its frames.
   */
  absEpoch?: string;
  /**
   * T1426b — the PROJECT's frame rate: frames of the finished picture per second.
   *
   * Not `1 / deltaSeconds`, and that is the point of it: the live clock may advance several
   * timeline frames in one displayed frame, and an offline render that averages sub-frames
   * steps `subframes` times per project frame. An Echo that wants "three frames back" means
   * three frames of the FILM, which is `3 / fps` seconds whatever either transport did.
   * Optional (§V68); an expression reads `DEFAULT_PROJECT_FPS` when a transport supplies none.
   */
  fps?: number;
  /**
   * T1435b — offline sub-frames averaged into each output frame (temporal AA and motion
   * blur by accumulation); 1 when frames are not accumulated, which is every live frame.
   * The transport then steps at `fps * subframes`, so `delta` is a sub-frame's step. A shot
   * that draws its own shutter blur reads it to stand down when accumulation provides one.
   */
  subframes?: number;
  /**
   * T1785b — the PROJECT TEMPO at this frame: the transport's beat clock, read by any
   * expression as `bpm`, `beat`, `beatphase`, `beatpulse`, `bar`, `barphase`, `tempolocked`.
   *
   * It arrives here and nowhere else (§V44, §V1038): a tap, a MIDI clock pulse and an audio
   * tempo claim all happen on the wall clock, and the app's beat clock turns them into this
   * reading once per frame. An offline render gets it from the frame's absolute time and
   * the document's BPM, so the same project renders the same beat on any day.
   * Optional (§V68): a transport that states none is read through `tempoOf`, which counts
   * the default tempo along the absolute clock.
   */
  tempo?: FrameTempo;
}

/**
 * T1785b — where a tempo comes from. `manual` is the document's BPM (typed or tapped),
 * `audio` follows the audio analysis' tempo claim, `midiClock` follows MIDI realtime.
 */
export const TEMPO_SOURCES = ["manual", "audio", "midiClock"] as const;
export type TempoSourceKind = (typeof TEMPO_SOURCES)[number];

/** T1785b — the tempo a document that states none has, and a frame whose transport stamps none. */
export const DEFAULT_PROJECT_BPM = 120;
/** T1785b — the beat clock counts bars of four beats; a time signature is T1790b. */
export const BEATS_PER_BAR = 4;

/** T1785b — the beat clock's reading for one frame. */
export interface FrameTempo {
  /** Beats per minute in effect for this frame. */
  readonly bpm: number;
  /** Position on the beat grid at this frame, in beats since the downbeat; never negative. */
  readonly beats: number;
  /** Beats that landed in this frame: 0 between beats, 1 on the frame a beat lands (more when a frame spans several). */
  readonly pulse: number;
  readonly source: TempoSourceKind;
  /**
   * The source is delivering: always for `manual`; for `audio` while the claim is confident;
   * for `midiClock` while pulses arrive. False means the tempo is the last one held.
   */
  readonly locked: boolean;
}

/**
 * T1785b — a tempo counted along a clock, the arithmetic every deterministic reading uses:
 * `seconds` is where the frame is on that clock and `deltaSeconds` the step that got it there.
 * A frame with no step (the first of a run) pulses when it sits exactly on a beat.
 */
export function tempoAlong(bpm: number, seconds: number, deltaSeconds: number, source: TempoSourceKind = "manual"): FrameTempo {
  const beats = Math.max(0, (seconds * bpm) / 60);
  const before = Math.max(0, ((seconds - deltaSeconds) * bpm) / 60);
  const pulse = deltaSeconds > 0 ? Math.max(0, Math.floor(beats) - Math.floor(before)) : beats === Math.floor(beats) ? 1 : 0;
  return { bpm, beats, pulse, source, locked: source === "manual" };
}

/**
 * T1785b — a frame's tempo; a frame that carries none counts the default tempo along its absolute clock.
 * T1787b: such a frame with no step is not a moment of playback (the compile's zero frame,
 * a redraw), so no beat lands in it: it used to pulse whenever it sat on a beat, time zero included.
 */
export function tempoOf(frame: FrameEvaluationInput): FrameTempo {
  if (frame.tempo !== undefined) return frame.tempo;
  const counted = tempoAlong(DEFAULT_PROJECT_BPM, absTimeSecondsOf(frame), frame.deltaSeconds);
  return frame.deltaSeconds > 0 ? counted : { ...counted, pulse: 0 };
}

/**
 * T1497b — THE ABSOLUTE CLOCK AS A COMMAND READS IT: the epoch and `absTimeSeconds` of the
 * last frame the transport produced.
 *
 * A preset recall stamps its morph with this, and it is how §V44 holds on the command side:
 * the handler reads no clock of its own. The app attaches the reader to the bus
 * (`LoomBus.attachFrameClock`), so a Panel, the phone, the keymap, a pulse and an agent all
 * stamp the same moment without doing anything. A bus with no app has none, and a morph
 * requested there commits as a cut.
 */
export interface FrameClock {
  readonly epoch: string;
  readonly absTimeSeconds: number;
  /**
   * T1508b — the TIMELINE clock of that same frame, so a surface or an agent reads where a
   * cue list that follows the timeline is from the one clock the picture used: the playhead
   * in seconds and the timeline's frames per second (fps × sub-frames). Optional (§V68): a
   * clock attached without them reports no timeline position.
   */
  readonly timeSeconds?: number;
  readonly timelineRate?: number;
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
 *
 * T1227 — VERSION 2 of the record (`FEATURE_TRACK_VERSION`), written from what the T1226
 * engine delivers. The eight v1 fields are verbatim. What is added, and how honest each
 * addition is, in three tiers:
 *
 *  - `kick` / `snare` / `hat` and their counts are BAND HEURISTICS: an onset envelope
 *    confined to the band a drum mostly lives in (`AUDIO_DETECTOR_BANDS_HZ`). On a mix
 *    they are a guess that a bass note or a vocal consonant can trigger; on a drums stem
 *    (T1231) the same fields become a measurement. The names say what they are FOR, the
 *    descriptions say what they ARE.
 *  - `centroid` is a measurement: where the spectrum's weight sits, the cheapest
 *    "brightness" the value graph cannot make from four bands.
 *  - the tempo fields are a CLAIM, and `bpmConfidence` is what makes them honest: 0 means
 *    no claim is being made and every other tempo field reads 0. A live source makes no
 *    claim until a tempo is declared or estimated (T1228); `audioPattern` knows its own
 *    and claims it at 1. There is deliberately NO `bar` / `barPhase` here: a downbeat
 *    from live input is a claim nobody can back, so bar structure stays with the nodes
 *    that can count it (`audioPattern`, a declared `beatsPerBar` + reset, or an offline
 *    pre-analysis, T1229).
 */
/*
 * T1751b: the record also carries the TONAL fields (`AudioTonalFields`: twelve pitch-class
 * energies `chroma0` … `chroma11`, their confidence, the tuning, the lag, and the chord and
 * key claims §T1753b fills). Version 4 of the record. The audio SOURCE nodes do not publish
 * them; the tonal nodes (`audio-tonal.ts`) do.
 */
export interface AudioFeatures extends AudioSpectrumBands, AudioTonalFields {
  /** Broadband RMS of the current analysis window. */
  readonly level: number;
  /**
   * Band energies: ~20-250 Hz, 250-2k, 2k-6k, 6k-16k — the MUSICAL bands. T1347b added
   * the SPECTRUM beside them: eighteen log-spaced bands `band80` … `band16000`
   * (`AUDIO_SPECTRUM_BANDS`), inherited from `AudioSpectrumBands` above, in the same
   * analyser byte domain as these four. Version 3 of the record.
   */
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
  /** T437: the largest onset value observed within the frame interval (≥ `onset` once analysis outpaces the frame rate; T1226 made it real). */
  readonly onsetMax: number;
  /**
   * T1227: the largest band-limited onset (SuperFlux over the kick band, in `onset`'s
   * units) observed within the frame interval. A heuristic on a mix — see the type doc.
   */
  readonly kick: number;
  /** T1227: kick-band events within the frame interval — rising crossings of an adaptive bar (recent mean + `DETECTOR_EVENT_PICKER.delta`). */
  readonly kickCount: number;
  /** T1227: as `kick`, over the snare band. */
  readonly snare: number;
  readonly snareCount: number;
  /** T1227: as `kick`, over the hat band. */
  readonly hat: number;
  readonly hatCount: number;
  /**
   * T1227: spectral centroid — the magnitude-weighted mean frequency of the analysis
   * window, mapped linearly from `CENTROID_RANGE_HZ` onto 0..1. Silence reads 0.
   */
  readonly centroid: number;
  /** T1227: the claimed tempo in beats per minute; 0 when `bpmConfidence` is 0. */
  readonly bpm: number;
  /**
   * T1227: 0..1 — how much the tempo claim is worth, and it carries THREE distinct
   * meanings a consumer branching on it needs to tell apart:
   *  - 0 is NO CLAIM, and every other tempo field is then 0;
   *  - 1 is a DECLARED tempo (T1228: the user said so, or `audioPattern` IS one) — it does
   *    not mean an estimator is very sure;
   *  - strictly between is an ESTIMATE, and the number is the estimator's own confidence.
   */
  readonly bpmConfidence: number;
  /** T1227: 0..1 ramp inside the current claimed beat; 0 without a claim. */
  readonly beatPhase: number;
  /** T1227: beats counted since the claim began (a lock, a reset, the in point) — monotonic integer; 0 without a claim. */
  readonly beat: number;
  /** T1227: beats that fell within the frame interval — the pulse, interval-shaped like `onsetCount`; 0 without a claim. */
  readonly beatCount: number;
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

/**
 * T1426b — the project's rate at a frame. A transport that states none (or a nonsense one) is
 * a plain project at the default rate, which is what `projectFps()` says of absent settings.
 */
export function fpsOf(frame: Pick<FrameEvaluationInput, "fps">): number {
  return frame.fps !== undefined && Number.isFinite(frame.fps) && frame.fps > 0 ? frame.fps : DEFAULT_PROJECT_FPS;
}

/** T1435b — sub-frames accumulated per output frame; 1 (no accumulation) when none is stated. */
export function subframesOf(frame: Pick<FrameEvaluationInput, "subframes">): number {
  return frame.subframes !== undefined && Number.isFinite(frame.subframes) && frame.subframes >= 1 ? frame.subframes : 1;
}

/**
 * T1554b — A FRAME AS A PRODUCER HANDS IT OVER: every clock filled.
 *
 * `FrameEvaluationInput` leaves six clock fields optional and every reader falls back to the
 * timeline for an absent one. That is how the absolute clock reached the app one site at a
 * time (T461, T468, B97, T489 — §V437): a hand-built frame that left a field out still
 * compiled, and on a timeline that never wrapped it still looked right. This type is the
 * fix's other half. The fallbacks are applied ONCE, in `frameFromClock`, and what comes out
 * has nothing left to fall back on. `TransportSource.next()` returns it, so a transport that
 * forgets a clock is a type error rather than a frame that agrees with the timeline until
 * the first lap.
 *
 * `absEpoch` stays optional, and that is not a fallback: its absence is the fact "this
 * transport mints no epoch" (an export, a preview's own clock, the headless server), which
 * makes every morph record finished (T1497b). Nothing reads it as "use the timeline".
 *
 * Consumers keep taking `FrameEvaluationInput`, which this is assignable to; the reason is
 * the ~185 test files that hand a consumer a five-field frame. Product frames are complete
 * by construction (`frame-literals.test.ts`), so the `*Of` accessors above are where an
 * incomplete one — a test's — is completed, and the only place.
 */
export interface EvaluationFrame extends FrameEvaluationInput {
  wallSeconds: number;
  wallDeltaSeconds: number;
  absFrameIndex: number;
  absTimeSeconds: number;
  fps: number;
  subframes: number;
}

/**
 * What a producer knows about one frame: the timeline reading, the seed, and the project
 * rate — `fps` is REQUIRED, because a transport always knows the rate it steps at and the
 * reader's default (`DEFAULT_PROJECT_FPS`) is only right by coincidence. Every other clock
 * is optional, and absent means "this transport has no such clock": the timeline reading
 * stands in for it (wall, absolute) or no accumulation does (sub-frames).
 */
export interface FrameClockReading extends FrameEvaluationInput {
  fps: number;
}

/**
 * T1554b — the one way product code makes a frame (the other is `ZERO_FRAME`).
 *
 * The fallbacks are exactly the `*Of` accessors', applied here once, so a frame built from a
 * timeline-only reading reads the same through either. Keys come out in the order both
 * transports always wrote them, and `absEpoch` is omitted rather than `undefined` when the
 * reading has none (T1497b: a frame without the field has no epoch at all).
 */
export function frameFromClock(reading: FrameClockReading): EvaluationFrame {
  return {
    timeSeconds: reading.timeSeconds,
    deltaSeconds: reading.deltaSeconds,
    frameIndex: reading.frameIndex,
    mode: reading.mode,
    randomSeed: reading.randomSeed,
    wallSeconds: wallSecondsOf(reading),
    wallDeltaSeconds: wallDeltaSecondsOf(reading),
    absFrameIndex: absFrameIndexOf(reading),
    absTimeSeconds: absTimeSecondsOf(reading),
    ...(reading.absEpoch === undefined ? {} : { absEpoch: reading.absEpoch }),
    fps: reading.fps,
    subframes: reading.subframes ?? 1,
    // T1785b: omitted, never `undefined`, when the transport stamps no tempo (`tempoOf`).
    ...(reading.tempo === undefined ? {} : { tempo: reading.tempo }),
  };
}

/**
 * T1554b — §V44's deterministic zero frame: what a read OUTSIDE any frame resolves at
 * (a compile-time resolve, a stored read, a completion menu's variable names). Time zero on
 * every clock, seed zero, the default project rate, no epoch. Frozen, because it is shared.
 *
 * Before this there were four of it, hand-written in four modules, and none carried `fps`.
 */
export const ZERO_FRAME: Readonly<EvaluationFrame> = Object.freeze(
  frameFromClock({
    timeSeconds: 0,
    deltaSeconds: 0,
    frameIndex: 0,
    mode: "offline",
    randomSeed: 0,
    fps: DEFAULT_PROJECT_FPS,
  }),
);

/** Supplies frame input. Swappable: live clock now, playhead or offline queue later (§V49). */
export interface TransportSource {
  /** T1554b: a complete frame — every clock this transport has, and the timeline's for the rest. */
  next(): EvaluationFrame;
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
