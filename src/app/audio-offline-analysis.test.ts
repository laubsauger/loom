import { describe, expect, it } from "vitest";

import { NO_TEMPO_CLAIM, featureTrackLength, readFeatureFrame, serializeFeatureTrack } from "@domain/audio/feature-track.ts";
import { AUDIO_DETECTOR_DEFAULTS } from "@nodes/definitions/audio.ts";
import { AUDIO_ANALYSIS_OPTIONS } from "./audio-analysis-protocol.ts";
import { analyseOffline } from "./audio-offline-analysis.ts";

/**
 * T1229 — the offline walk on a synthetic click track whose every number is known.
 *
 * 48 kHz, 60 fps, 12 s. A click is a 60 Hz sine (inside the kick band, 30–150 Hz) decaying
 * over 20 ms, every 0.48 s from 0.5 s — 125 BPM, 24 clicks, every fourth one at full
 * height and the rest at half. 0.48 s is exactly 45 hops of 512, so the tempo grid is
 * integral and the estimator's answer is 125 to the width of its parabola.
 */

const SAMPLE_RATE = 48_000;
const FPS = 60;
const SECONDS = 12;
const PERIOD = 0.48;
const FIRST = 0.5;
const CLICKS = 24;
const { fftSize, hop } = AUDIO_ANALYSIS_OPTIONS;

function clickTrack(): Float32Array {
  const pcm = new Float32Array(SAMPLE_RATE * SECONDS);
  for (let index = 0; index < CLICKS; index += 1) {
    const start = Math.round((FIRST + index * PERIOD) * SAMPLE_RATE);
    const height = index % 4 === 0 ? 1 : 0.5;
    for (let i = 0; i < 0.08 * SAMPLE_RATE && start + i < pcm.length; i += 1) {
      pcm[start + i] = height * Math.sin((2 * Math.PI * 60 * i) / SAMPLE_RATE) * Math.exp(-i / (0.02 * SAMPLE_RATE));
    }
  }
  return pcm;
}

const clickTimes = Array.from({ length: CLICKS }, (_, index) => FIRST + index * PERIOD);

describe("analyseOffline — the same PCM walks to the same bytes (T1229)", () => {
  it("two walks of one file serialize identically, and the track knows its settings and rate", () => {
    const first = analyseOffline(clickTrack(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS);
    const second = analyseOffline(clickTrack(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS);
    expect(serializeFeatureTrack(first.track)).toBe(serializeFeatureTrack(second.track));
    expect(first.track.fps).toBe(FPS);
    expect(first.track.provenance).toEqual({ detector: AUDIO_DETECTOR_DEFAULTS });
    // One frame per 1/60 s up to and including the file's end: 720 intervals, 721 frames.
    expect(featureTrackLength(first.track)).toBe(SECONDS * FPS + 1);
  });
});

describe("analyseOffline — the record is what the live engine would have read on a perfect clock", () => {
  const analysis = analyseOffline(clickTrack(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS);
  const length = featureTrackLength(analysis.track);
  const frames = Array.from({ length }, (_, index) => readFeatureFrame(analysis.track, index));

  it("each click is one kickCount, on the frame whose interval holds the window that saw it", () => {
    const kickFrames = frames.flatMap((frame, index) => (frame.kickCount > 0 ? [index] : []));
    expect(kickFrames).toHaveLength(CLICKS);
    expect(frames.reduce((sum, frame) => sum + frame.kickCount, 0)).toBe(CLICKS);
    kickFrames.forEach((frameIndex, click) => {
      // Frame i reduces the hops whose window ENDS in ((i − 1)/fps, i/fps]. The picker fires
      // on the first window whose Blackman-weighted energy clears the bar; the click sits at
      // the window's tapered edge for the first hop or two, so the firing window ends at
      // most fftSize + 2·hop samples after the click, and the frame at most 1/fps after that.
      const late = frameIndex / FPS - (clickTimes[click] as number);
      expect(late).toBeGreaterThan(0);
      expect(late).toBeLessThanOrEqual((fftSize + 2 * hop) / SAMPLE_RATE + 1 / FPS);
    });
  });

  it("the whole-track tempo is 125 BPM, an ESTIMATE, and every frame carries it", () => {
    // The clicks' flux spans more than one hop, so the autocorrelation's neighbours at 44
    // and 46 are not perfectly alike and the parabola moves the vertex by under 0.002 hop.
    expect(analysis.tempo.bpm).toBeCloseTo(125, 2);
    expect(analysis.tempo.confidence).toBeGreaterThan(0.5);
    expect(analysis.tempo.confidence).toBeLessThan(1);
    for (const frame of frames) {
      expect(frame.bpm).toBe(analysis.tempo.bpm);
      expect(frame.bpmConfidence).toBe(analysis.tempo.confidence);
    }
  });

  it("the beats are the clicks, one window late each, exactly a period apart", () => {
    expect(analysis.beats).toHaveLength(CLICKS);
    analysis.beats.forEach((beat, click) => {
      const late = beat - (clickTimes[click] as number);
      expect(late).toBeGreaterThan(0);
      expect(late).toBeLessThanOrEqual((fftSize + 2 * hop) / SAMPLE_RATE);
    });
    for (let index = 1; index < analysis.beats.length; index += 1) {
      expect((analysis.beats[index] as number) - (analysis.beats[index - 1] as number)).toBeCloseTo(PERIOD, 12);
    }
  });

  it("beatPhase ramps at the period, wraps on a beat frame, and beat counts the wraps", () => {
    const step = 1 / FPS / PERIOD;
    let wraps = 0;
    for (let index = 1; index < length; index += 1) {
      const previous = frames[index - 1]!;
      const current = frames[index]!;
      expect(current.beatPhase).toBeGreaterThanOrEqual(0);
      expect(current.beatPhase).toBeLessThan(1);
      if (current.beatCount === 0) {
        // Between tracked beats the step is exactly 1/(fps · 0.48); before the first and
        // after the last it is at the GLOBAL period 60/124.995, 4e-5 longer — the
        // extrapolation is at the estimate, not at a spacing it has not seen.
        expect(current.beatPhase - previous.beatPhase).toBeCloseTo(step, 5);
        expect(current.beat).toBe(previous.beat);
      } else {
        expect(current.beatCount).toBe(1);
        expect(current.beatPhase).toBeLessThan(previous.beatPhase);
        expect(current.beat).toBe(previous.beat + 1);
        wraps += 1;
      }
    }
    // The 24 tracked beats plus the one extrapolated grid beat before the first click
    // (0.5227 − 0.48 ≥ 0); the frame after the last beat sits within a period of the end.
    expect(wraps).toBe(CLICKS + 1);
    expect(frames[length - 1]!.beat).toBe(CLICKS + 1);
  });

  it("the accent every fourth click is a 4-beat bar with the downbeat on the first click", () => {
    expect(analysis.bar.beatsPerBar).toBe(4);
    expect(analysis.bar.downbeatSeconds).toBe(analysis.beats[0]);
    expect(analysis.bar.confidence).toBeGreaterThan(0);
  });
});

describe("analyseOffline — silence claims nothing", () => {
  it("a silent file has no kicks, no tempo and no bar, and every frame says so", () => {
    const analysis = analyseOffline(new Float32Array(SAMPLE_RATE * 4), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS);
    expect(analysis.tempo).toEqual({ bpm: 0, confidence: 0 });
    expect(analysis.bar).toEqual({ beatsPerBar: 0, downbeatSeconds: 0, confidence: 0 });
    expect(analysis.beats).toEqual([]);
    for (let index = 0; index < featureTrackLength(analysis.track); index += 1) {
      const frame = readFeatureFrame(analysis.track, index);
      expect(frame.kickCount).toBe(0);
      expect(frame).toMatchObject(NO_TEMPO_CLAIM);
    }
  });
});
