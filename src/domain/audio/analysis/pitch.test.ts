import { describe, expect, it } from "vitest";

import { pitchDetector, pitchTracker, PITCH_CLARITY, type PitchReading } from "./pitch.ts";

/**
 * T1755b — lead pitch on signals whose pitch is known: tones with partials, a chord, noise.
 */
const SAMPLE_RATE = 48_000;
const SIZE = 2048;
const detector = pitchDetector({ sampleRate: SAMPLE_RATE, windowSize: SIZE });
const cents = (measured: number, truth: number): number => 1200 * Math.log2(measured / truth);

/** A note with `partials` harmonics at 1/h, starting at an arbitrary phase. */
function note(frequency: number, partials = 5, phase = 0.3): Float64Array {
  const samples = new Float64Array(SIZE);
  for (let h = 1; h <= partials; h += 1) {
    if (frequency * h > SAMPLE_RATE / 2) break;
    for (let i = 0; i < SIZE; i += 1) samples[i] = (samples[i] as number) + (0.3 / h) * Math.sin((2 * Math.PI * frequency * h * i) / SAMPLE_RATE + phase * h);
  }
  return samples;
}

function noise(seed: number): Float64Array {
  let state = seed >>> 0;
  return Float64Array.from({ length: SIZE }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state / 2 ** 32) * 2 - 1;
  });
}

describe("pitchDetector — MPM", () => {
  it("reads a note's pitch within three cents from A1 to A6, at a clarity over 0.99 — and the FUNDAMENTAL, not a partial or a sub-octave", () => {
    for (const frequency of [55, 82.41, 110, 220, 222.17, 440, 587.33, 880, 1760]) {
      const reading = detector.detect(note(frequency));
      expect(Math.abs(cents(reading.frequency, frequency)), `${String(frequency)} Hz read as ${String(reading.frequency)}`).toBeLessThan(3);
      expect(reading.clarity).toBeGreaterThan(0.99);
    }
  });

  it("a second partial stronger than the fundamental is still not the pitch — which is what 'the first peak near the highest' is for", () => {
    // 196 Hz with its octave partial twice as strong: the half-period lag scores well, and not well enough.
    const samples = new Float64Array(SIZE);
    for (const [h, amplitude] of [[1, 0.15], [2, 0.3], [3, 0.05]] as const) {
      for (let i = 0; i < SIZE; i += 1) samples[i] = (samples[i] as number) + amplitude * Math.sin((2 * Math.PI * 196 * h * i) / SAMPLE_RATE + h);
    }
    expect(Math.abs(cents(detector.detect(samples).frequency, 196))).toBeLessThan(3);
  });

  it("does not depend on loudness: the same note 40 dB down is the same reading", () => {
    const loud = detector.detect(note(220));
    const quiet = detector.detect(note(220).map((sample) => sample * 0.01));
    expect(quiet.frequency).toBeCloseTo(loud.frequency, 9);
    expect(quiet.clarity).toBeCloseTo(loud.clarity, 9);
  });

  it("a CONSONANT interval is periodic and still not a note: a fifth, a major third and a major triad claim nothing — there is no sound at their common period", () => {
    const together = (...midi: number[]): Float64Array => {
      const sum = new Float64Array(SIZE);
      for (const pitch of midi) note(440 * 2 ** ((pitch - 69) / 12), 6, pitch).forEach((sample, i) => (sum[i] = (sum[i] as number) + sample));
      return sum;
    };
    // Each of these repeats exactly enough to read a clarity of 0.97 or more (a fifth: 0.9996).
    for (const chord of [[48, 55], [60, 67], [72, 79], [60, 64], [72, 76], [60, 64, 67], [72, 76, 79], [60, 63, 67]]) {
      expect(detector.detect(together(...chord)), chord.join("+")).toEqual({ frequency: 0, clarity: 0 });
    }
    // An octave is the lower note with a brighter tone, and reads as it: the class is right either way.
    expect(Math.abs(cents(detector.detect(together(48, 60)).frequency, 130.81))).toBeLessThan(3);
  });

  it("the price of that, stated: a note whose fundamental is 20 dB under its second partial reads no pitch", () => {
    const samples = new Float64Array(SIZE);
    for (const [h, amplitude] of [[1, 0.03], [2, 0.3], [3, 0.2]] as const) {
      for (let i = 0; i < SIZE; i += 1) samples[i] = (samples[i] as number) + amplitude * Math.sin((2 * Math.PI * 110 * h * i) / SAMPLE_RATE + h);
    }
    expect(detector.detect(samples)).toEqual({ frequency: 0, clarity: 0 });
  });

  it("claims NOTHING for a chord, for noise, for silence, and for a note below what the window can hold", () => {
    const chord = new Float64Array(SIZE);
    for (const frequency of [130.81, 164.81, 196]) note(frequency).forEach((sample, i) => (chord[i] = (chord[i] as number) + sample));
    expect(detector.detect(chord)).toEqual({ frequency: 0, clarity: 0 });
    for (let seed = 1; seed <= 10; seed += 1) expect(detector.detect(noise(seed))).toEqual({ frequency: 0, clarity: 0 });
    expect(detector.detect(new Float64Array(SIZE))).toEqual({ frequency: 0, clarity: 0 });
    // Two periods must fit: 2048 samples at 48 kHz hold down to 46.9 Hz.
    expect(detector.minHz).toBe(SAMPLE_RATE / (SIZE / 2));
    expect(detector.detect(note(30)).frequency).toBe(0);
  });

  it("refuses a window of the wrong size", () => {
    expect(() => detector.detect(new Float64Array(1024))).toThrow(/expected 2048 samples, got 1024/);
  });
});

describe("pitchTracker — readings to a note", () => {
  const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);
  const voiced = (midi: number, clarity = 0.98): PitchReading => ({ frequency: hz(midi), clarity });
  const NONE: PitchReading = { frequency: 0, clarity: 0 };

  it("a claim beginning is an onset; holding the note is not; the pitch is the MIDI number", () => {
    const tracker = pitchTracker();
    expect(tracker.push(NONE)).toEqual({ pitch: 0, confidence: 0, onset: false });
    const first = tracker.push(voiced(60));
    expect([first.onset, first.confidence]).toEqual([true, 0.98]);
    expect(first.pitch).toBeCloseTo(60, 12);
    expect(tracker.push(voiced(60)).onset).toBe(false);
    expect(tracker.push(voiced(60.3)).onset).toBe(false);
  });

  it("one octave blip does not move the pitch and is not a note: the median of three holds", () => {
    const tracker = pitchTracker();
    tracker.push(voiced(60));
    tracker.push(voiced(60));
    const blip = tracker.push(voiced(72));
    expect(blip.pitch).toBeCloseTo(60, 12);
    expect(blip.onset).toBe(false);
    expect(tracker.push(voiced(60)).onset).toBe(false);
  });

  it("a new note is an onset once the median has left the old one and stayed: on the third reading of it", () => {
    const tracker = pitchTracker();
    for (let i = 0; i < 4; i += 1) tracker.push(voiced(60));
    // Reading 1 of the D: the median is still C. Reading 2: the median is D, away once. Reading 3: away twice.
    expect([tracker.push(voiced(62)), tracker.push(voiced(62)), tracker.push(voiced(62))].map((frame) => frame.onset)).toEqual([false, false, true]);
    expect(tracker.push(voiced(62)).onset).toBe(false);
  });

  it("vibrato a third of a semitone wide is one note", () => {
    const tracker = pitchTracker();
    const onsets = Array.from({ length: 60 }, (_, i) => tracker.push(voiced(60 + 0.3 * Math.sin(i / 3))).onset).filter(Boolean);
    expect(onsets).toHaveLength(1);
  });

  it("the claim ending forgets the note: the same pitch after a gap is a new onset", () => {
    const tracker = pitchTracker();
    tracker.push(voiced(60));
    tracker.push(NONE);
    expect(tracker.push(voiced(60)).onset).toBe(true);
    void PITCH_CLARITY;
  });
});
