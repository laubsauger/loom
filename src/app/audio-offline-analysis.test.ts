import { describe, expect, it } from "vitest";

import { FEATURE_TRACK_STRIDE, NO_TEMPO_CLAIM, featureTrackLength, readFeatureFrame, serializeFeatureTrack } from "@domain/audio/feature-track.ts";
import { CHROMA_NAMES, TONAL_ANALYSIS, TONAL_FIELD_NAMES } from "@domain/audio/tonal-fields.ts";
import { AUDIO_DETECTOR_DEFAULTS } from "@nodes/definitions/audio.ts";
import { AUDIO_ANALYSIS_OPTIONS } from "./audio-analysis-protocol.ts";
import { createTonalAnalyser } from "@domain/audio/analysis/tonal-analyser.ts";
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
    const first = analyseOffline(clickTrack(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, false, 0);
    const second = analyseOffline(clickTrack(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, false, 0);
    expect(serializeFeatureTrack(first.track)).toBe(serializeFeatureTrack(second.track));
    expect(first.track.fps).toBe(FPS);
    expect(first.track.provenance).toEqual({ detector: AUDIO_DETECTOR_DEFAULTS, tonal: false });
    // One frame per 1/60 s up to and including the file's end: 720 intervals, 721 frames.
    expect(featureTrackLength(first.track)).toBe(SECONDS * FPS + 1);
  });
});

describe("analyseOffline — the record is what the live engine would have read on a perfect clock", () => {
  const analysis = analyseOffline(clickTrack(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, false, 0);
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
    const analysis = analyseOffline(new Float32Array(SAMPLE_RATE * 4), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, false, 0);
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

describe("T1751b / T1752b — the offline walk carries the tonal pass, centred on each frame", () => {
  /** Silence for a second, A4 (six partials) for a second, silence for a second; `cents` detunes the note. */
  function noteThenSilence(cents = 0): Float32Array {
    const samples = new Float32Array(SAMPLE_RATE * 3);
    const a4 = 440 * 2 ** (cents / 1200);
    for (let i = SAMPLE_RATE; i < SAMPLE_RATE * 2; i += 1) {
      for (let h = 1; h <= 6; h += 1) samples[i] = (samples[i] as number) + (0.2 / h) * Math.sin((2 * Math.PI * a4 * h * i) / SAMPLE_RATE);
    }
    return samples;
  }
  const classes = (frame: ReturnType<typeof readFeatureFrame>): number[] => CHROMA_NAMES.map((name) => frame[name]);
  const half = TONAL_ANALYSIS.windowSize / 2 / SAMPLE_RATE;

  it("asked for, a frame reads the note; not asked for, every tonal field is NO CLAIM", () => {
    const tonal = analyseOffline(noteThenSilence(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, true, 0).track;
    const plain = analyseOffline(noteThenSilence(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, false, 0).track;
    expect(tonal.provenance).toEqual({ detector: AUDIO_DETECTOR_DEFAULTS, tonal: true });
    for (const index of [70, 90, 110]) {
      const frame = readFeatureFrame(tonal, index);
      // A's partials: A (1, 2, 4), E (3, 6) and C sharp (5). A leads, E second, C sharp third, nothing else.
      expect(frame.chroma9).toBe(1);
      expect(frame.chroma4).toBeGreaterThan(frame.chroma1);
      expect(frame.chroma1).toBeGreaterThan(0);
      expect(classes(frame).filter((value) => value > 0)).toHaveLength(3);
      expect(frame.chromaConfidence).toBe(1);
    }
    for (const index of [70, 90]) {
      const frame = readFeatureFrame(plain, index);
      expect(TONAL_FIELD_NAMES.map((name) => frame[name])).toEqual(new Array(TONAL_FIELD_NAMES.length).fill(0));
    }
  });

  it("T1752b — CENTRED: the frame AT the note's onset already reads it, the frame at its end still does, and the lag in the record is 0", () => {
    const tonal = analyseOffline(noteThenSilence(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, true, 0).track;
    // The note starts at 1 s (frame 60) and ends at 2 s (frame 120). A window that ENDED on
    // frame 60 would hold no sample of the note; the one centred there holds half a window of it.
    expect(readFeatureFrame(tonal, 60).chroma9).toBe(1);
    expect(readFeatureFrame(tonal, 120).chroma9).toBe(1);
    // Symmetric, and bounded by half a window plus one window step each side: beyond that, nothing.
    const reach = Math.ceil((half + TONAL_ANALYSIS.hop / SAMPLE_RATE) * FPS);
    expect(classes(readFeatureFrame(tonal, 60 - reach - 1))).toEqual(new Array(12).fill(0));
    expect(classes(readFeatureFrame(tonal, 120 + reach + 1))).toEqual(new Array(12).fill(0));
    for (let index = 0; index < featureTrackLength(tonal); index += 1) expect(readFeatureFrame(tonal, index).tonalLag).toBe(0);
  });

  it("T1752b — ONE tuning for the file, known from its first frame: a note 35 cents sharp reads 35 everywhere, silence included", () => {
    const tonal = analyseOffline(noteThenSilence(35), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, true, 0).track;
    const tunings = new Set<number>();
    for (let index = 0; index < featureTrackLength(tonal); index += 1) tunings.add(readFeatureFrame(tonal, index).tuning);
    expect(tunings.size).toBe(1);
    // The harmonic series is not equal-tempered (the fifth partial is 14 cents flat), so the
    // file's own figure sits a little under 35; within a cent and a half of it.
    expect(Math.abs([...tunings][0]! - 35)).toBeLessThan(1.5);
    expect(readFeatureFrame(tonal, 90).chroma9).toBe(1);
  });

  it("the tonal pass changes nothing else in the record: every source field is the same number with it on", () => {
    const pcm = new Float32Array(SAMPLE_RATE * 2);
    for (let i = 0; i < pcm.length; i += 1) pcm[i] = 0.3 * Math.sin((2 * Math.PI * 440 * i) / SAMPLE_RATE);
    const tonal = analyseOffline(pcm, SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, true, 0).track;
    const plain = analyseOffline(pcm, SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, false, 0).track;
    const sourceCount = FEATURE_TRACK_STRIDE - TONAL_FIELD_NAMES.length;
    for (let frame = 0; frame < featureTrackLength(plain); frame += 1) {
      const at = frame * FEATURE_TRACK_STRIDE;
      expect(tonal.frames.slice(at, at + sourceCount)).toEqual(plain.frames.slice(at, at + sourceCount));
    }
  });
});

describe("T1753b — chord and key, end to end from samples", () => {
  /** Triads of six-partial notes: C major, then F major from `CHANGE`, each about two seconds. */
  const CHANGE = SAMPLE_RATE * 2 + 777;
  function progression(): Float32Array {
    const samples = new Float32Array(SAMPLE_RATE * 4);
    const chord = (notes: number[], from: number, to: number): void => {
      for (const note of notes) {
        const frequency = 440 * 2 ** ((note - 69) / 12);
        for (let h = 1; h <= 6; h += 1) {
          for (let i = from; i < to; i += 1) samples[i] = (samples[i] as number) + (0.1 / h) * Math.sin((2 * Math.PI * frequency * h * i) / SAMPLE_RATE + note * h);
        }
      }
    };
    chord([48, 52, 55], 0, CHANGE);
    chord([53, 57, 60], CHANGE, samples.length);
    return samples;
  }

  it("a file: C major from its first frame, F major from the frame of the change (within one tonal hop), exactly two changes, the age restarting", () => {
    const { track } = analyseOffline(progression(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, true, 0);
    const frames = Array.from({ length: featureTrackLength(track) }, (_, index) => readFeatureFrame(track, index));
    expect([frames[0]!.chordRoot, frames[0]!.chordQuality]).toEqual([0, 1]);
    const firstF = frames.findIndex((frame) => frame.chordRoot === 5);
    const changeFrame = (CHANGE / SAMPLE_RATE) * FPS;
    const hopFrames = (TONAL_ANALYSIS.hop / SAMPLE_RATE) * FPS;
    expect(Math.abs(firstF - changeFrame)).toBeLessThanOrEqual(hopFrames + 1);
    // Nothing but those two chords, ever, and each a confident major triad.
    for (const [index, frame] of frames.entries()) {
      if (index >= frames.length - 12) continue; // the file's last 0.2 s fades into the padding
      expect([frame.chordRoot, frame.chordQuality], `frame ${String(index)}`).toEqual([index < firstF ? 0 : 5, 1]);
      // A triad of real notes leads by less than three bare classes do (its partials are other
      // classes): measured 0.84 to 1 here. Lower still in the frames whose window holds both chords.
      expect(frame.chordConfidence).toBeGreaterThan(Math.abs(index - firstF) > 12 ? 0.75 : 0.5);
    }
    expect(frames.slice(0, frames.length - 12).reduce((sum, frame) => sum + frame.chordChangeCount, 0)).toBe(2);
    expect([frames[0]!.chordChangeCount, frames[firstF]!.chordChangeCount]).toEqual([1, 1]);
    expect(frames[firstF - 1]!.chordAge).toBeGreaterThan(1.9);
    expect(frames[firstF]!.chordAge).toBeLessThan(0.05);
  });

  it("without the tonal pass the chord and key are NO CLAIM; and silence claims neither with it", () => {
    const plain = analyseOffline(progression(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, false, 0).track;
    const quiet = analyseOffline(new Float32Array(SAMPLE_RATE * 2), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, true, 0).track;
    for (const track of [plain, quiet]) {
      for (const index of [0, 60, 119]) {
        const frame = readFeatureFrame(track, index);
        expect([frame.chordRoot, frame.chordQuality, frame.chordConfidence, frame.chordChangeCount, frame.keyTonic, frame.keyMode, frame.keyConfidence]).toEqual([0, 0, 0, 0, 0, 0, 0]);
      }
    }
  });

  it("LIVE, the same samples through the analyser as the worklet runs it: the change is reported after it sounds, never before, and within 0.6 s", () => {
    const samples = progression();
    const analyser = createTonalAnalyser({ sampleRate: SAMPLE_RATE, windowSize: TONAL_ANALYSIS.windowSize });
    const window = new Float64Array(TONAL_ANALYSIS.windowSize);
    const reports: Array<{ end: number; root: number; quality: number; changed: boolean }> = [];
    for (let end = TONAL_ANALYSIS.windowSize, index = 0; end <= samples.length; end += TONAL_ANALYSIS.hop, index += 1) {
      for (let i = 0; i < window.length; i += 1) window[i] = samples[end - window.length + i] as number;
      const { chord } = analyser.analyse(window, index === 0 ? 0 : TONAL_ANALYSIS.hop);
      reports.push({ end, root: chord.root, quality: chord.quality, changed: chord.changed });
    }
    const toF = reports.find((report) => report.root === 5);
    expect(toF).toBeDefined();
    expect(toF!.end).toBeGreaterThan(CHANGE);
    expect((toF!.end - CHANGE) / SAMPLE_RATE).toBeLessThan(0.6);
    // C is claimed first, then F: two changes, no third chord in between.
    expect(reports.filter((report) => report.changed).map((report) => [report.root, report.quality])).toEqual([
      [0, 1],
      [5, 1],
    ]);
  });
});

describe("T1755b — the lead pitch, end to end from samples", () => {
  /** A4 for a second, then D5 for a second, then a C major triad for a second: five-partial notes. */
  function melody(): Float32Array {
    const samples = new Float32Array(SAMPLE_RATE * 3);
    const note = (frequency: number, from: number, to: number): void => {
      for (let h = 1; h <= 5; h += 1) {
        for (let i = from; i < to; i += 1) samples[i] = (samples[i] as number) + (0.15 / h) * Math.sin((2 * Math.PI * frequency * h * i) / SAMPLE_RATE);
      }
    };
    note(440, 0, SAMPLE_RATE);
    note(440 * 2 ** (5 / 12), SAMPLE_RATE, SAMPLE_RATE * 2);
    for (const frequency of [130.81, 164.81, 196]) note(frequency, SAMPLE_RATE * 2, SAMPLE_RATE * 3);
    return samples;
  }

  it("a file: A4 then D5 within three cents, exactly two note onsets, and NO CLAIM under the chord; the lag is the path's", () => {
    const { track } = analyseOffline(melody(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, true, 0);
    const frames = Array.from({ length: featureTrackLength(track) }, (_, index) => readFeatureFrame(track, index));
    expect(Math.abs(frames[30]!.pitch - 69) * 100).toBeLessThan(3);
    expect(Math.abs(frames[90]!.pitch - 74) * 100).toBeLessThan(3);
    expect(frames[30]!.pitchConfidence).toBeGreaterThan(0.99);
    for (const index of [140, 150, 170]) expect([frames[index]!.pitch, frames[index]!.pitchConfidence]).toEqual([0, 0]);
    expect(frames.reduce((sum, frame) => sum + frame.pitchOnsetCount, 0)).toBe(2);
    // The first onset is on the first reading (the first hop window, 2048 samples in); the
    // second within a tenth of a second after the D begins, never before it.
    const onsets = frames.flatMap((frame, index) => (frame.pitchOnsetCount > 0 ? [index] : []));
    expect(onsets[0]).toBe(Math.ceil(2048 / (SAMPLE_RATE / FPS)));
    expect(onsets[1]! / FPS).toBeGreaterThan(1);
    expect(onsets[1]! / FPS).toBeLessThan(1.1);
    // Half the 2048 window plus the median's reading, every second hop of 512.
    expect(frames[30]!.pitchLag).toBe((1024 + 2 * 512) / SAMPLE_RATE);
  });

  it("without the tonal pass there is no lead pitch in the record", () => {
    const { track } = analyseOffline(melody(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, false, 0);
    const frame = readFeatureFrame(track, 30);
    expect([frame.pitch, frame.pitchConfidence, frame.pitchOnsetCount, frame.pitchLag]).toEqual([0, 0, 0, 0]);
  });
});

describe("T1756b — voices, end to end from samples", () => {
  /** C3 held for three seconds; above it E4, then G4, then C5, a second each. Six-partial notes. */
  function heldBassAndArpeggio(): Float32Array {
    const samples = new Float32Array(SAMPLE_RATE * 3);
    const note = (midi: number, from: number, to: number): void => {
      const frequency = 440 * 2 ** ((midi - 69) / 12);
      for (let h = 1; h <= 6; h += 1) {
        for (let i = from; i < to; i += 1) samples[i] = (samples[i] as number) + (0.12 / h) * Math.sin((2 * Math.PI * frequency * h * i) / SAMPLE_RATE + midi * h);
      }
    };
    note(48, 0, samples.length);
    [64, 67, 72].forEach((midi, index) => note(midi, index * SAMPLE_RATE, (index + 1) * SAMPLE_RATE));
    return samples;
  }
  const voicesOf = (frame: ReturnType<typeof readFeatureFrame>) =>
    [0, 1, 2, 3, 4].map((slot) => {
      const record = frame as unknown as Record<string, number>;
      return { pitch: Math.round(record[`voice${String(slot)}Pitch`]!), confidence: record[`voice${String(slot)}Confidence`]!, id: record[`voice${String(slot)}Id`]!, onsets: record[`voice${String(slot)}OnsetCount`]! };
    });

  it("THE FLICKER PROPERTY, from a file: the held bass keeps one slot and one id for three seconds while three notes pass above it; two voices, never an octave ghost", () => {
    const { track } = analyseOffline(heldBassAndArpeggio(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, true, 0);
    const frames = Array.from({ length: featureTrackLength(track) }, (_, index) => readFeatureFrame(track, index));
    const steady = frames.slice(6, 174);
    const bassSlots = new Set(steady.map((frame) => voicesOf(frame).findIndex((voice) => voice.confidence > 0 && voice.pitch === 48)));
    expect(bassSlots.size).toBe(1);
    const slot = [...bassSlots][0]!;
    expect(slot).toBeGreaterThanOrEqual(0);
    expect(new Set(steady.map((frame) => voicesOf(frame)[slot]!.id)).size).toBe(1);
    // In the middle of each second: exactly the bass and that second's note.
    for (const [index, upper] of [[30, 64], [90, 67], [150, 72]] as const) {
      const sounding = voicesOf(frames[index]!).filter((voice) => voice.confidence > 0).map((voice) => voice.pitch).sort((a, b) => a - b);
      expect(sounding).toEqual([48, upper]);
      expect(frames[index]!.voiceCount).toBe(2);
    }
    // Four notes begin, in all: four onsets, four ids.
    const onsets = frames.reduce((sum, frame) => sum + voicesOf(frame).reduce((inner, voice) => inner + voice.onsets, 0), 0);
    expect(onsets).toBe(4);
  });

  it("without the tonal pass, and in silence with it, there are no voices", () => {
    const plain = analyseOffline(heldBassAndArpeggio(), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, false, 0).track;
    const quiet = analyseOffline(new Float32Array(SAMPLE_RATE), SAMPLE_RATE, FPS, AUDIO_DETECTOR_DEFAULTS, true, 0).track;
    for (const track of [plain, quiet]) {
      const frame = readFeatureFrame(track, 30);
      expect(frame.voiceCount).toBe(0);
      expect(voicesOf(frame).every((voice) => voice.confidence === 0 && voice.id === 0)).toBe(true);
    }
  });
});

