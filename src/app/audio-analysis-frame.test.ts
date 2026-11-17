import { describe, expect, it } from "vitest";
import type { HopFeatures } from "@domain/audio/analysis/hop-analyser.ts";
import { SILENCE } from "@domain/audio/feature-track.ts";
import { NO_KEY } from "@domain/audio/analysis/chord.ts";
import { TONAL_FIELD_NAMES } from "@domain/audio/tonal-fields.ts";
import { createAudioHopReducer } from "./audio-analysis-frame.ts";
import { DETECTOR_STREAM, STREAM_COUNT } from "./audio-analysis-protocol.ts";
import { computeAudioFeatures, ONSET_EVENT_THRESHOLD } from "./audio-features.ts";

/**
 * T1226 — the reducer against the v1 record's definitions (§V357): within one frame
 * interval, `onsetCount` is the number of rising crossings and `onsetMax` the peak.
 * The polled path could only ever answer 0/1 and "the last reading"; the numbers here
 * are the ones it structurally could not produce.
 */

const FFT_SIZE = 16;
const SAMPLE_RATE = 16 * 100; // 100 Hz per bin: bands are easy to place.
/** The reducer takes the product's stream layout (`DETECTOR_STREAM`), so the fixture matches it. */
const STREAMS = STREAM_COUNT;

function hop(overrides: Partial<HopFeatures> & { level?: number } = {}): HopFeatures {
  const { level = 0, ...rest } = overrides;
  return {
    frequency: new Uint8Array(FFT_SIZE / 2).fill(level),
    timeDomain: new Uint8Array(FFT_SIZE).fill(128),
    flux: 0,
    event: false,
    bandFlux: new Float64Array(STREAMS),
    bandEvents: new Uint8Array(STREAMS),
    ...rest,
  };
}

describe("createAudioHopReducer", () => {
  it("before any hop it reads SILENCE: every one of the twenty fields 0, nothing counted", () => {
    const frame = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE).read();
    expect(frame.hops).toBe(0);
    expect(frame.features).toEqual(SILENCE);
  });

  it("three events on four hops in one interval count 3 — the polled path's ceiling was 1", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE);
    reducer.push(hop({ flux: 0.3, event: true }));
    reducer.push(hop({ flux: 0.01, event: false }));
    reducer.push(hop({ flux: 0.25, event: true }));
    reducer.push(hop({ flux: 0.5, event: true, level: 100 }));
    const frame = reducer.read();
    expect(frame.hops).toBe(4);
    expect(frame.features.onsetCount).toBe(3);
    // The interval's PEAK, which is not the last hop's reading and not the frame's own.
    expect(frame.features.onsetMax).toBe(0.5);
  });

  it("bands and level come from the LATEST hop through computeAudioFeatures, bit for bit", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE);
    reducer.push(hop({ level: 40 }));
    const last = hop({ level: 200 });
    (last.timeDomain as Uint8Array).fill(192);
    reducer.push(last);
    const frame = reducer.read();
    const expected = computeAudioFeatures({
      frequency: last.frequency,
      timeDomain: last.timeDomain,
      sampleRate: SAMPLE_RATE,
      fftSize: FFT_SIZE,
      state: { previousSpectrum: null, previousOnset: 0 },
    });
    expect(frame.features.level).toBe(expected.level);
    expect(frame.features.low).toBe(expected.low);
    expect(frame.features.high).toBe(expected.high);
    // 200 / 255 on every bin the low band covers (20..250 Hz at 100 Hz per bin: bins 1..2).
    expect(frame.features.low).toBe(200 / 255);
    expect(frame.features.level).toBe(0.5);
  });

  it("the frame-to-frame onset is v1's: flux against the PREVIOUS READ's bytes, and it feeds the max", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE);
    reducer.push(hop({ level: 0 }));
    reducer.read();
    // Every bin rises 0 → 51 between reads: onset 51 / 255 = 0.2, above every hop's flux.
    reducer.push(hop({ level: 51, flux: 0.05, event: true }));
    const frame = reducer.read();
    expect(frame.features.onset).toBe(0.2);
    expect(frame.features.onsetMax).toBe(0.2);
    expect(frame.features.onsetCount).toBe(1);
  });

  it("a rise that crosses the level only frame-to-frame still counts once (the polled path saw it)", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE);
    reducer.push(hop({ level: 0 }));
    reducer.read();
    // Four small hops, none an event on its own; the interval as a whole rose 0 → 40.
    for (let i = 1; i <= 4; i += 1) reducer.push(hop({ level: 10 * i, flux: 10 / 255 / 8, event: false }));
    const frame = reducer.read();
    expect(frame.features.onset).toBe(40 / 255);
    expect(frame.features.onset).toBeGreaterThan(ONSET_EVENT_THRESHOLD);
    expect(frame.features.onsetCount).toBe(1);
  });

  it("a read with no new hop repeats the bytes: same bands, onset 0, nothing counted", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE);
    reducer.push(hop({ level: 90, flux: 0.4, event: true }));
    const first = reducer.read();
    const again = reducer.read();
    expect(again.hops).toBe(0);
    expect(again.features.low).toBe(first.features.low);
    expect(again.features.onset).toBe(0);
    expect(again.features.onsetCount).toBe(0);
    expect(again.features.onsetMax).toBe(0);
  });

  /**
   * T1227 — the detector fields are the streams reduced, and WHICH stream is which is the
   * protocol's `DETECTOR_STREAM`, not a guess: a fixture with a different value on every
   * stream would read back permuted if the reducer indexed them wrongly (stream 0, the
   * whole spectrum, is deliberately given the largest numbers so it cannot hide).
   */
  it("kick/snare/hat are the interval max of THEIR stream's SuperFlux, the counts its events, then they clear", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE);
    const flux = (whole: number, kick: number, snare: number, hat: number): Float64Array => {
      const out = new Float64Array(STREAMS);
      out[0] = whole;
      out[DETECTOR_STREAM.kick] = kick;
      out[DETECTOR_STREAM.snare] = snare;
      out[DETECTOR_STREAM.hat] = hat;
      return out;
    };
    const events = (whole: number, kick: number, snare: number, hat: number): Uint8Array => {
      const out = new Uint8Array(STREAMS);
      out[0] = whole;
      out[DETECTOR_STREAM.kick] = kick;
      out[DETECTOR_STREAM.snare] = snare;
      out[DETECTOR_STREAM.hat] = hat;
      return out;
    };
    reducer.push(hop({ bandFlux: flux(0.9, 0.1, 0.5, 0), bandEvents: events(1, 0, 1, 0) }));
    reducer.push(hop({ bandFlux: flux(0.8, 0.3, 0.2, 0), bandEvents: events(1, 1, 1, 0) }));
    reducer.push(hop({ bandFlux: flux(0.7, 0.05, 0.1, 0.4), bandEvents: events(0, 0, 0, 1) }));
    const frame = reducer.read();
    expect(frame.features.kick).toBe(0.3);
    expect(frame.features.kickCount).toBe(1);
    expect(frame.features.snare).toBe(0.5);
    expect(frame.features.snareCount).toBe(2);
    expect(frame.features.hat).toBe(0.4);
    expect(frame.features.hatCount).toBe(1);
    // The whole-spectrum stream (0) reaches no field: its 0.9 and its two events appear nowhere.
    expect(frame.features.onsetMax).toBe(0);
    expect(frame.features.onsetCount).toBe(0);
    const again = reducer.read();
    expect([again.features.kick, again.features.snare, again.features.hat]).toEqual([0, 0, 0]);
    expect([again.features.kickCount, again.features.snareCount, again.features.hatCount]).toEqual([0, 0, 0]);
  });

  it("makes NO tempo claim: bpmConfidence 0 and every tempo field 0, however many events arrived", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE);
    for (let i = 0; i < 8; i += 1) {
      reducer.push(hop({ flux: 0.3, event: true, bandFlux: new Float64Array(STREAMS).fill(0.3), bandEvents: new Uint8Array(STREAMS).fill(1) }));
    }
    const { features } = reducer.read();
    expect(features.kickCount).toBe(8);
    expect([features.bpm, features.bpmConfidence, features.beatPhase, features.beat, features.beatCount]).toEqual([0, 0, 0, 0, 0]);
  });

  it("refuses a hop with the wrong stream count by name rather than reading a detector off the end", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE);
    expect(() => reducer.push(hop({ bandFlux: new Float64Array(2), bandEvents: new Uint8Array(2) }))).toThrow(
      `expected ${STREAMS} streams, got 2/2`,
    );
  });
});

describe("T1751b — the reducer carries the latest tonal window", () => {
  const tonalFrame = (pitchClass: number, confidence: number) => {
    const chroma = new Float64Array(12);
    chroma[pitchClass] = 1;
    return { chroma, confidence, tuning: -7, lag: 0.085, chord: NO_CHORD, key: NO_KEY, voices: [] };
  };
  const NO_CHORD = { root: 0, quality: 0, confidence: 0, changed: false, age: 0 };

  it("with no tonal window ever pushed, every tonal field is NO CLAIM — a capture without the pass", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE);
    reducer.push(hop({ level: 200 }));
    const { features } = reducer.read();
    expect(TONAL_FIELD_NAMES.map((name) => features[name])).toEqual(new Array(TONAL_FIELD_NAMES.length).fill(0));
  });

  it("a frame reads the LATEST window, and it holds across frames until the next arrives", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE);
    reducer.pushTonal(tonalFrame(2, 0.4));
    reducer.pushTonal(tonalFrame(9, 0.8));
    const first = reducer.read().features;
    expect([first.chroma2, first.chroma9, first.chromaConfidence, first.tuning, first.tonalLag]).toEqual([0, 1, 0.8, -7, 0.085]);
    // No new window before the next frame (a window every 43 ms, a frame every 17): same reading.
    const held = reducer.read().features;
    expect([held.chroma9, held.chromaConfidence, held.tonalLag]).toEqual([1, 0.8, 0.085]);
    // A window that claims no chord and no key leaves those fields at NO CLAIM beside a live chroma.
    expect([held.chordRoot, held.chordQuality, held.chordConfidence, held.keyTonic, held.keyMode, held.keyConfidence]).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it("T1753b — the latest window's chord and key are the record's; chord CHANGES are counted over the interval and then start again", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE);
    const withClaims = (root: number, changed: boolean, age: number) => ({
      ...tonalFrame(root, 1),
      chord: { root, quality: 1, confidence: 0.8, changed, age },
      key: { tonic: 7, mode: 2, confidence: 0.6 },
    });
    // Two changes between two frames (a passing chord): both are counted, the later chord is the one read.
    reducer.pushTonal(withClaims(0, true, 0));
    reducer.pushTonal(withClaims(5, true, 0));
    reducer.pushTonal(withClaims(5, false, 0.04));
    const first = reducer.read().features;
    expect([first.chordRoot, first.chordQuality, first.chordConfidence, first.chordChangeCount, first.chordAge]).toEqual([5, 1, 0.8, 2, 0.04]);
    expect([first.keyTonic, first.keyMode, first.keyConfidence]).toEqual([7, 2, 0.6]);
    // No new window: the chord holds, and nothing changed in THIS interval.
    const held = reducer.read().features;
    expect([held.chordRoot, held.chordChangeCount]).toEqual([5, 0]);
  });
});

describe("T1755b — the reducer carries the latest lead pitch and counts its onsets", () => {
  const reading = (pitch: number, onset: boolean) => ({ pitch, confidence: pitch > 0 ? 0.96 : 0, onset, lag: 0.043 });

  it("with no reading ever pushed the pitch fields are NO CLAIM, lag included", () => {
    const { features } = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE).read();
    expect([features.pitch, features.pitchConfidence, features.pitchOnsetCount, features.pitchLag]).toEqual([0, 0, 0, 0]);
  });

  it("a frame reads the latest reading; two notes begun between two frames are two onsets; the count then starts again", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE);
    reducer.pushPitch(reading(60, true));
    reducer.pushPitch(reading(64, true));
    const first = reducer.read().features;
    expect([first.pitch, first.pitchConfidence, first.pitchOnsetCount, first.pitchLag]).toEqual([64, 0.96, 2, 0.043]);
    const held = reducer.read().features;
    expect([held.pitch, held.pitchOnsetCount]).toEqual([64, 0]);
    // The claim ending is read as ending: pitch 0 at confidence 0, the lag still the path's.
    reducer.pushPitch(reading(0, false));
    const ended = reducer.read().features;
    expect([ended.pitch, ended.pitchConfidence, ended.pitchLag]).toEqual([0, 0, 0.043]);
  });
});

describe("T1756b — the reducer carries the voices and counts each one's onsets", () => {
  const voice = (pitch: number, onset: boolean, id: number, confidence = 0.9) => ({ pitch, level: 0.7, confidence, age: 0.1, onset, id });
  const EMPTY = { pitch: 0, level: 0, confidence: 0, age: 0, onset: false, id: 0 };
  const frameWith = (...voices: Array<ReturnType<typeof voice>>) => ({
    chroma: new Float64Array(12),
    confidence: 1,
    tuning: 0,
    lag: 0.085,
    chord: { root: 0, quality: 0, confidence: 0, changed: false, age: 0 },
    key: NO_KEY,
    voices: [...voices, ...new Array(5 - voices.length).fill(EMPTY)],
  });

  it("each slot's fields are the latest window's; onsets are summed per slot over the interval; voiceCount counts the slots in use", () => {
    const reducer = createAudioHopReducer(FFT_SIZE, SAMPLE_RATE);
    reducer.pushTonal(frameWith(voice(60, true, 1), voice(67, true, 2)));
    reducer.pushTonal(frameWith(voice(60, false, 1), voice(72, true, 3)));
    const first = reducer.read().features;
    expect([first.voice0Pitch, first.voice0Level, first.voice0Confidence, first.voice0Age, first.voice0Id, first.voice0OnsetCount]).toEqual([60, 0.7, 0.9, 0.1, 1, 1]);
    // Slot 1 held two notes inside one frame interval: the later one is read, both onsets are counted.
    expect([first.voice1Pitch, first.voice1Id, first.voice1OnsetCount, first.voiceCount]).toEqual([72, 3, 2, 2]);
    expect([first.voice2Confidence, first.voice2OnsetCount]).toEqual([0, 0]);
    const held = reducer.read().features;
    expect([held.voice0OnsetCount, held.voice1OnsetCount, held.voiceCount]).toEqual([0, 0, 2]);
  });
});

