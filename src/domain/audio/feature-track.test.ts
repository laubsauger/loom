import { describe, expect, it } from "vitest";

import {
  AUDIO_BAND_EDGES_HZ,
  AUDIO_DETECTOR_BANDS_HZ,
  CENTROID_RANGE_HZ,
  DETECTOR_EVENT_PICKER,
  ONSET_EVENT_THRESHOLD,
} from "../../app/audio-features.ts";
import type { AudioFeatures } from "../types/frame.ts";
import {
  FEATURE_TRACK_FIELDS,
  FEATURE_TRACK_STRIDE,
  FEATURE_TRACK_VERSION,
  SILENCE,
  createFeatureTrackRecorder,
  featureTrackLength,
  featureTrackPlayer,
  parseFeatureTrack,
  readFeatureFrame,
  serializeFeatureTrack,
} from "./feature-track.ts";

/** A different value in every one of the twenty fields, so a permuted or dropped field cannot round-trip. */
const features = (level: number): AudioFeatures => ({
  level,
  low: level * 2,
  lowMid: level * 3,
  highMid: level * 4,
  high: level * 5,
  onset: level * 6,
  onsetCount: 1,
  onsetMax: level * 7,
  kick: level * 8,
  kickCount: 2,
  snare: level * 9,
  snareCount: 3,
  hat: level * 10,
  hatCount: 4,
  centroid: level * 11,
  bpm: 120 + level,
  bpmConfidence: level * 12,
  beatPhase: level * 13,
  beat: 5,
  beatCount: 6,
});

describe("§V352 — the recorded CONTRACT is pinned, and changing it is a versioning event", () => {
  /**
   * The point of §V352's corollary, made mechanical.
   *
   * A recorded track's meaning depends on the band edges and the onset threshold. If
   * someone "tunes" a band edge, every track ever recorded now describes a different
   * sound while still parsing perfectly — the worst shape of wrong, because nothing
   * fails. This test is what makes that tuning impossible without also moving the
   * version, which is what makes old tracks REFUSE instead of lie.
   */
  it("fails if a band edge, a threshold, a detector band, the picker or the centroid span moves without the version moving", () => {
    expect(AUDIO_BAND_EDGES_HZ).toEqual({
      low: [20, 250],
      lowMid: [250, 2000],
      highMid: [2000, 6000],
      high: [6000, 16000],
    });
    expect(ONSET_EVENT_THRESHOLD).toBe(0.02);
    // T1227 — the v2 contract: the detector bands, the adaptive bar their counts are
    // taken against (first values; retuning them in T1230 is a versioning event, and
    // this is the line that says so), and the span the centroid maps onto 0..1.
    expect(AUDIO_DETECTOR_BANDS_HZ).toEqual({ kick: [30, 150], snare: [150, 2500], hat: [5000, 16000] });
    expect(DETECTOR_EVENT_PICKER).toEqual({ historyHops: 96, delta: 0.05, minGapHops: 3 });
    expect(CENTROID_RANGE_HZ).toEqual([20, 16000]);
    // The field set and its ORDER are equally part of the layout this version describes:
    // the eight v1 fields verbatim and in place, then what v2 added.
    expect([...FEATURE_TRACK_FIELDS]).toEqual([
      "level",
      "low",
      "lowMid",
      "highMid",
      "high",
      "onset",
      "onsetCount",
      "onsetMax",
      "kick",
      "kickCount",
      "snare",
      "snareCount",
      "hat",
      "hatCount",
      "centroid",
      "bpm",
      "bpmConfidence",
      "beatPhase",
      "beat",
      "beatCount",
    ]);
    // Change any of the above and this line is the one you must change too.
    expect(FEATURE_TRACK_VERSION).toBe(2);
  });

  it("T1227 — a version 1 track refuses by name, and the reader never widens it into twenty fields", () => {
    // Eight numbers per frame under version 1. Reading it as v2 would be a stride error
    // that parses: 20 frames of eight would become 8 frames of twenty, each field wrong.
    const stored = JSON.stringify({ version: 1, fps: 60, frames: new Array(8 * 20).fill(0.5) });
    const result = parseFeatureTrack(stored);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("audio.track.version");
    expect(result.message).toContain("version 1");
  });

  it("§V357 — the fields are named for the INTERVAL they describe, not the analyser", () => {
    // Not decoration: `onsetCount` reading 2 for one frame must be a FIDELITY change and
    // not a contract change, or every analyser improvement invalidates every recording.
    // A track carrying multi-event frames round-trips under the SAME version.
    const recorder = createFeatureTrackRecorder(60);
    recorder.capture(0, { ...features(0.5), onsetCount: 3, onsetMax: 0.9 });
    const round = parseFeatureTrack(serializeFeatureTrack(recorder.track()));
    expect(round.ok).toBe(true);
    if (!round.ok) return;
    expect(readFeatureFrame(round.track, 0).onsetCount).toBe(3);
    expect(round.track.version).toBe(FEATURE_TRACK_VERSION);
  });
});

describe("recording captures what crossed the seam", () => {
  it("round-trips every field exactly", () => {
    const recorder = createFeatureTrackRecorder(60);
    recorder.capture(0, features(0.1));
    recorder.capture(1, features(0.25));
    const track = recorder.track();

    expect(featureTrackLength(track)).toBe(2);
    expect(track.frames).toHaveLength(2 * FEATURE_TRACK_STRIDE);
    expect(readFeatureFrame(track, 0)).toEqual(features(0.1));
    expect(readFeatureFrame(track, 1)).toEqual(features(0.25));
  });

  it("records silence for a frame with no audio source, because that is what the engine read", () => {
    const recorder = createFeatureTrackRecorder(60);
    recorder.capture(0, null);
    expect(readFeatureFrame(recorder.track(), 0)).toEqual(SILENCE);
  });

  it("HOLDS a dropped frame rather than falling silent in it", () => {
    // A live session that never rendered frame 1 never read the analyser for it — but the
    // sound did not stop. Silence there would inject a gap the performance never had.
    const recorder = createFeatureTrackRecorder(60);
    recorder.capture(0, features(0.4));
    recorder.capture(2, features(0.6));
    const track = recorder.track();

    expect(featureTrackLength(track)).toBe(3);
    expect(readFeatureFrame(track, 1)).toEqual(features(0.4));
    expect(readFeatureFrame(track, 2)).toEqual(features(0.6));
  });
});

describe("replay is exact, and honest past the end", () => {
  it("returns SILENCE past the last recorded frame rather than freezing or looping", () => {
    const recorder = createFeatureTrackRecorder(60);
    recorder.capture(0, features(0.9));
    const play = featureTrackPlayer(recorder.track());

    expect(play(0)).toEqual(features(0.9));
    // Holding would freeze a transient at full level for the rest of the render; looping
    // would invent structure. Neither is what "the recording ended" means.
    expect(play(1)).toEqual(SILENCE);
    expect(play(9999)).toEqual(SILENCE);
    expect(play(-1)).toEqual(SILENCE);
  });
});

describe("a stored track refuses by name rather than replaying something plausible", () => {
  it("refuses a version this build does not read", () => {
    const stored = JSON.stringify({ version: FEATURE_TRACK_VERSION + 1, fps: 60, frames: [] });
    const result = parseFeatureTrack(stored);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("audio.track.version");
    // The message has to carry BOTH numbers or it cannot be acted on.
    expect(result.message).toContain(String(FEATURE_TRACK_VERSION + 1));
    expect(result.message).toContain(String(FEATURE_TRACK_VERSION));
  });

  it("refuses a frame list that is not a whole number of frames", () => {
    const stored = JSON.stringify({ version: FEATURE_TRACK_VERSION, fps: 60, frames: [1, 2, 3] });
    const result = parseFeatureTrack(stored);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("audio.track.frames");
    expect(result.message).toContain(String(FEATURE_TRACK_STRIDE));
  });

  it("refuses a rate that is not a rate, and malformed JSON", () => {
    const noFps = parseFeatureTrack(JSON.stringify({ version: FEATURE_TRACK_VERSION, fps: 0, frames: [] }));
    expect(noFps.ok).toBe(false);
    if (!noFps.ok) expect(noFps.code).toBe("audio.track.fps");

    const broken = parseFeatureTrack("{not json");
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.code).toBe("audio.track.malformed");
  });

  it("keeps the file to the numbers — no repeated key names per frame", () => {
    // Ten minutes at 60fps is 36 000 frames. As objects that is a multi-megabyte JSON of
    // the word "highMid"; flat, it is the numbers. Asserted so a future "readability"
    // refactor has to argue with the size rather than discover it.
    const recorder = createFeatureTrackRecorder(60);
    for (let index = 0; index < 100; index += 1) recorder.capture(index, features(index / 100));
    const text = serializeFeatureTrack(recorder.track());
    expect(text).not.toContain("highMid");
    expect(text.length).toBeLessThan(100 * FEATURE_TRACK_STRIDE * 22);
  });
});

describe("T1229 — a track carries the detector settings it was recorded WITH, as provenance", () => {
  const detector = { threshold: 0.25, retrigger: 0.08 };

  it("round-trips the settings, and a track recorded without them has none", () => {
    const recorder = createFeatureTrackRecorder(60, { detector });
    recorder.capture(0, features(0.5));
    const result = parseFeatureTrack(serializeFeatureTrack(recorder.track()));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.track.provenance).toEqual({ detector });

    // Absent, not defaulted: a file from before T1229 does not know its knobs, and
    // inventing the shipped defaults for it would be a claim the recording never made.
    const old = parseFeatureTrack(JSON.stringify({ version: FEATURE_TRACK_VERSION, fps: 60, frames: [] }));
    expect(old.ok).toBe(true);
    if (old.ok) expect("provenance" in old.track).toBe(false);
    expect("provenance" in createFeatureTrackRecorder(60).track()).toBe(false);
  });

  it("a take whose knobs moved while armed is disowned: the file carries no settings at all", () => {
    const recorder = createFeatureTrackRecorder(60, { detector });
    recorder.capture(0, features(0.5));
    recorder.disown();
    recorder.capture(1, features(0.6));
    expect("provenance" in recorder.track()).toBe(false);
  });

  it("refuses provenance that is not a finite threshold and retrigger, by name", () => {
    const stored = JSON.stringify({
      version: FEATURE_TRACK_VERSION,
      fps: 60,
      frames: [],
      provenance: { detector: { threshold: "high", retrigger: 0.08 } },
    });
    const result = parseFeatureTrack(stored);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("audio.track.provenance");
  });
});
