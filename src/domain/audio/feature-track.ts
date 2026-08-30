import type { AudioFeatures } from "../types/frame.ts";

/**
 * Recorded audio feature tracks — the replay half of the sound determinism seam
 * (T431, §V352, §V357).
 *
 * ## Why features and never PCM
 *
 * §V352: replaying audio would mean re-analysing it offline, and matching the browser
 * `AnalyserNode`'s windowing and FFT bit-for-bit across engines is a §V47 parity promise
 * nobody can keep. The FEATURES are what actually determined the render — value
 * channels, uniforms, substep counts are all pure functions of (frame, features) — so
 * recording them makes replay exact BY CONSTRUCTION, frame cost included.
 *
 * ## The version is the SEMANTICS, not the file layout
 *
 * §V352's corollary: because features are the recorded contract, the meaning of each
 * field is the thing a track depends on. `AUDIO_BAND_EDGES_HZ` and
 * `ONSET_EVENT_THRESHOLD` in `app/audio-features.ts` are pinned by exact-value test, and
 * `feature-track.test.ts` fails if either changes without `FEATURE_TRACK_VERSION` moving
 * with it — so a band edge cannot be "tweaked" without the invalidation being visible.
 *
 * §V357 is what keeps that cost bounded: `onsetCount` and `onsetMax` are defined by the
 * INTERVAL they describe, not by how they are currently computed, so a faster analysis
 * hop later reports real multi-event frames without changing what the fields MEAN — a
 * fidelity improvement, not a versioning event. Fields defined as "whatever the analyser
 * returned" would make every improvement invalidate every recording.
 */

/**
 * Bumped when the MEANING of any field changes — a band edge, the onset threshold, the
 * field set, or the order below. Never for a performance change in the analyser.
 */
export const FEATURE_TRACK_VERSION = 1;

/**
 * Field order IS part of the contract, which is why it lives in one exported constant
 * rather than in a hand-written encode and a hand-written decode that can disagree.
 *
 * Frames are stored flat — eight numbers per frame, not eight-key objects. A ten-minute
 * performance at 60fps is 36 000 frames: as objects that is a multi-megabyte JSON of
 * repeated key names, and as a flat array it is the numbers and nothing else.
 */
export const FEATURE_TRACK_FIELDS = [
  "level",
  "low",
  "lowMid",
  "highMid",
  "high",
  "onset",
  "onsetCount",
  "onsetMax",
] as const satisfies ReadonlyArray<keyof AudioFeatures>;

export const FEATURE_TRACK_STRIDE = FEATURE_TRACK_FIELDS.length;

export interface FeatureTrack {
  readonly version: number;
  /**
   * The frame rate the track was recorded at. Frames are identified by INDEX, so this is
   * what makes an index mean a time — a track recorded at 30 and replayed at 60 would
   * play at half speed, and the reader is what notices.
   */
  readonly fps: number;
  /** Flat, `FEATURE_TRACK_STRIDE` numbers per frame, index 0 = frame 0. */
  readonly frames: readonly number[];
}

/** All-zero features: what silence is, and what a render past the end of a track gets. */
export const SILENCE: AudioFeatures = {
  level: 0,
  low: 0,
  lowMid: 0,
  highMid: 0,
  high: 0,
  onset: 0,
  onsetCount: 0,
  onsetMax: 0,
};

export function featureTrackLength(track: FeatureTrack): number {
  return Math.floor(track.frames.length / FEATURE_TRACK_STRIDE);
}

export interface FeatureTrackRecorder {
  /**
   * Records what crossed the seam on this frame. `null` — no audio source attached —
   * records silence, because that is exactly what the engine saw.
   */
  capture(frameIndex: number, features: AudioFeatures | null): void;
  /** Frames captured so far, by highest index seen. */
  readonly length: number;
  track(): FeatureTrack;
}

/**
 * Captures at the SEAM, never at the analyser.
 *
 * The distinction is the whole point: what must replay identically is what the engine
 * READ, not what the analyser computed. Tapping the analyser would record a value the
 * frame loop might never have sampled, and the replay would then differ from the
 * performance in exactly the frames where it mattered.
 */
export function createFeatureTrackRecorder(fps: number): FeatureTrackRecorder {
  const byIndex = new Map<number, AudioFeatures>();
  let highest = -1;

  return {
    capture(frameIndex, features) {
      if (!Number.isInteger(frameIndex) || frameIndex < 0) return;
      byIndex.set(frameIndex, features ?? SILENCE);
      if (frameIndex > highest) highest = frameIndex;
    },
    get length() {
      return highest + 1;
    },
    track() {
      const frames: number[] = [];
      // HOLES HOLD, they do not fall silent. A live session that dropped frame 7 never
      // read the analyser for it — but the analyser's value did not vanish, it persisted
      // until the next read. Replaying silence there would inject a gap the performance
      // never had; holding is what actually happened to the sound.
      let last = SILENCE;
      for (let index = 0; index <= highest; index += 1) {
        const features = byIndex.get(index) ?? last;
        last = features;
        for (const field of FEATURE_TRACK_FIELDS) frames.push(features[field]);
      }
      return { version: FEATURE_TRACK_VERSION, fps, frames };
    },
  };
}

/**
 * Reads frame `frameIndex` out of a track.
 *
 * Past the end returns SILENCE, and that is a decision rather than a fallback: holding
 * the last frame would freeze a transient at full level for the rest of the render, and
 * looping would invent musical structure the performance did not have. A render longer
 * than its recording has no recorded sound for the extra frames, and silence is the only
 * answer that says so (§V288 — the caller can see the track's length and report it).
 */
export function readFeatureFrame(track: FeatureTrack, frameIndex: number): AudioFeatures {
  const count = featureTrackLength(track);
  if (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= count) return SILENCE;
  const base = frameIndex * FEATURE_TRACK_STRIDE;
  const features: Record<string, number> = {};
  for (let offset = 0; offset < FEATURE_TRACK_STRIDE; offset += 1) {
    features[FEATURE_TRACK_FIELDS[offset] as string] = track.frames[base + offset] ?? 0;
  }
  return features as unknown as AudioFeatures;
}

/** The closure the frame driver's `audio` seam takes. */
export function featureTrackPlayer(track: FeatureTrack): (frameIndex: number) => AudioFeatures {
  return (frameIndex) => readFeatureFrame(track, frameIndex);
}

export interface TrackReadFailure {
  readonly ok: false;
  readonly code: string;
  readonly message: string;
}

export type TrackReadResult = { readonly ok: true; readonly track: FeatureTrack } | TrackReadFailure;

/**
 * Parses a stored track, refusing by NAME rather than returning something plausible
 * (§V288). A version this build does not understand is the important one: silently
 * replaying a track recorded under different band edges would render a performance that
 * never happened, and look entirely correct doing it.
 */
export function parseFeatureTrack(text: string): TrackReadResult {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      code: "audio.track.malformed",
      message: `The feature track is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (typeof value !== "object" || value === null) {
    return { ok: false, code: "audio.track.malformed", message: "The feature track is not an object." };
  }
  const record = value as Record<string, unknown>;
  const version = record["version"];
  if (version !== FEATURE_TRACK_VERSION) {
    return {
      ok: false,
      code: "audio.track.version",
      message: `This feature track was recorded under contract version ${String(version)}; this build reads version ${String(FEATURE_TRACK_VERSION)}.`,
    };
  }
  const fps = record["fps"];
  if (typeof fps !== "number" || !Number.isFinite(fps) || fps <= 0) {
    return {
      ok: false,
      code: "audio.track.fps",
      message: `The feature track's frame rate is ${String(fps)}, which is not a rate.`,
    };
  }
  const frames = record["frames"];
  if (!Array.isArray(frames) || frames.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))) {
    return {
      ok: false,
      code: "audio.track.frames",
      message: "The feature track's frames are not a flat list of finite numbers.",
    };
  }
  if (frames.length % FEATURE_TRACK_STRIDE !== 0) {
    return {
      ok: false,
      code: "audio.track.frames",
      message: `The feature track holds ${String(frames.length)} numbers, which is not a whole number of ${String(FEATURE_TRACK_STRIDE)}-field frames.`,
    };
  }
  return { ok: true, track: { version: FEATURE_TRACK_VERSION, fps, frames: frames as number[] } };
}

export function serializeFeatureTrack(track: FeatureTrack): string {
  return JSON.stringify(track);
}
