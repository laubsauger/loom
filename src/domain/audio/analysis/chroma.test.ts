import { describe, expect, it } from "vitest";

import { CHROMA_CONFIDENCE_FULL, TONAL_ANALYSIS } from "../tonal-fields.ts";
import {
  chromaConfidence,
  chromaProfile,
  createPeakWorkspace,
  estimateTuning,
  foldChroma,
  hannWindow,
  midiOf,
  spectralPeaks,
  type SpectralPeaks,
} from "./chroma.ts";

/**
 * T1751b — chroma, asserted on signals whose answer is known before the code runs (§V147).
 *
 * Two kinds of signal. Where the claim is about the ARITHMETIC (the fold's weight, the
 * circular mean, the profile, the confidence map) the peaks are written by hand or the tone
 * is put exactly on a bin, and the expected number is closed-form. Where the claim is about
 * the METHOD (a real triad with partials names its chord from C2 up, where the obvious fold
 * does not) the signal is synthesised at 48 kHz and the assertion is which classes lead and
 * how much of the energy they hold — a threshold, and the alternative it excludes is
 * measured beside it in the same test.
 */
const SIZE = TONAL_ANALYSIS.windowSize;
const RANGE = { lowHz: TONAL_ANALYSIS.lowHz, highHz: TONAL_ANALYSIS.highHz, floorDecibels: TONAL_ANALYSIS.floorDecibels, floorAmplitude: TONAL_ANALYSIS.floorAmplitude };
const midiHz = (note: number, cents = 0): number => 440 * 2 ** ((note - 69 + cents / 100) / 12);

/** Hand-written peaks: `[frequency, energy]` pairs. */
function peaksOf(...entries: ReadonlyArray<readonly [number, number]>): SpectralPeaks {
  return {
    frequency: Float64Array.from(entries.map(([frequency]) => frequency)),
    energy: Float64Array.from(entries.map(([, energy]) => energy)),
    count: entries.length,
  };
}

/** Notes with six partials at 1/h, each partial at its own phase so nothing lines up by accident. */
function notes(sampleRate: number, midiNotes: readonly number[], cents = 0, partials = 6): Float64Array {
  const samples = new Float64Array(SIZE);
  for (const note of midiNotes) {
    for (let h = 1; h <= partials; h += 1) {
      const frequency = midiHz(note, cents) * h;
      for (let i = 0; i < SIZE; i += 1) samples[i] = (samples[i] as number) + (0.2 / h) * Math.sin((2 * Math.PI * frequency * i) / sampleRate + note * h);
    }
  }
  return samples;
}

function peaksAt(samples: Float64Array, sampleRate: number): SpectralPeaks {
  return spectralPeaks(samples, hannWindow(SIZE), { sampleRate, ...RANGE }, createPeakWorkspace(SIZE));
}

/** The share of the folded energy on `classes`, and the three strongest classes. */
function chordReading(energies: Float64Array, classes: readonly number[]): { share: number; leaders: number[] } {
  const total = energies.reduce((sum, value) => sum + value, 0);
  const share = classes.reduce((sum, pitchClass) => sum + (energies[pitchClass] as number), 0) / total;
  const leaders = [...energies.keys()].sort((a, b) => (energies[b] as number) - (energies[a] as number)).slice(0, 3).sort((a, b) => a - b);
  return { share, leaders };
}

/** The fold this module refuses: every bin's power to the class of the bin's own centre. */
function nearestBinFold(samples: Float64Array, sampleRate: number): Float64Array {
  const workspace = createPeakWorkspace(SIZE);
  spectralPeaks(samples, hannWindow(SIZE), { sampleRate, ...RANGE }, workspace);
  const out = new Float64Array(12);
  const binHz = sampleRate / SIZE;
  for (let bin = Math.ceil(RANGE.lowHz / binHz); bin * binHz <= RANGE.highHz; bin += 1) {
    const pitchClass = ((Math.round(midiOf(bin * binHz, 440)) % 12) + 12) % 12;
    out[pitchClass] = (out[pitchClass] as number) + (workspace.power[bin] as number);
  }
  return out;
}

describe("spectralPeaks — one partial is one peak, at its own frequency", () => {
  // 45056 Hz puts 440 Hz exactly on bin 80 of an 8192 window (5.5 Hz a bin).
  const ON_BIN_RATE = 45056;

  it("a sine exactly on a bin: one peak, at the bin's frequency, with the energy the Hann window gives it", () => {
    const amplitude = 0.5;
    const samples = Float64Array.from({ length: SIZE }, (_, i) => amplitude * Math.sin((2 * Math.PI * 440 * i) / ON_BIN_RATE));
    const peaks = peaksAt(samples, ON_BIN_RATE);
    expect(peaks.count).toBe(1);
    expect(peaks.frequency[0]).toBeCloseTo(440, 9);
    // Hann sums to N/2, so a sine of amplitude A reads A·N/4 on its bin: the two halves of A/2 times N/2.
    expect(Math.sqrt(peaks.energy[0] as number)).toBeCloseTo((amplitude * SIZE) / 4, 6);
  });

  it("a sine BETWEEN bins is still one peak — the window's side lobes are not partials — and the parabola places it within a twentieth of a bin", () => {
    const binHz = 48000 / SIZE;
    let worst = 0;
    for (let step = 0; step < 40; step += 1) {
      const frequency = 430 + step * 0.37;
      const samples = Float64Array.from({ length: SIZE }, (_, i) => 0.3 * Math.sin((2 * Math.PI * frequency * i) / 48000 + step));
      const peaks = peaksAt(samples, 48000);
      expect(peaks.count).toBe(1);
      worst = Math.max(worst, Math.abs((peaks.frequency[0] as number) - frequency) / binHz);
    }
    expect(worst).toBeLessThan(0.05);
  });

  it("silence has no peaks, and a loud tone OUTSIDE the tonal range leaves none inside it", () => {
    expect(peaksAt(new Float64Array(SIZE), 48000).count).toBe(0);
    // The bug this pins: with only a relative floor, the 9 kHz tone's rounding residue
    // inside the range (sixteen orders down) was the strongest thing there and became 161 "partials".
    const high = Float64Array.from({ length: SIZE }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 9000 * i) / 48000));
    expect(peaksAt(high, 48000).count).toBe(0);
    // The absolute floor is an amplitude: a partial just over it counts, one just under does not.
    const at = (amplitude: number): number =>
      peaksAt(Float64Array.from({ length: SIZE }, (_, i) => amplitude * Math.sin((2 * Math.PI * 440 * i) / 45056)), 45056).count;
    expect(at(TONAL_ANALYSIS.floorAmplitude * 1.01)).toBe(1);
    expect(at(TONAL_ANALYSIS.floorAmplitude * 0.99)).toBe(0);
  });
});

describe("foldChroma — a peak belongs to its nearest class, by how near it is", () => {
  it("on the note: all of its energy, and nothing anywhere else", () => {
    const out = foldChroma(peaksOf([440, 3]), 440, 0, new Float64Array(12));
    expect([...out]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, 3, 0, 0]);
  });

  it("the octave does not matter: A1, A4 and A7 are the same class", () => {
    const out = foldChroma(peaksOf([55, 1], [440, 2], [3520, 4]), 440, 0, new Float64Array(12));
    expect(out[9]).toBeCloseTo(7, 12);
    expect(out.reduce((sum, value) => sum + value, 0)).toBeCloseTo(7, 12);
  });

  it("25 cents off is cos²(π/4) = half; a quarter tone off belongs to no class", () => {
    expect(foldChroma(peaksOf([midiHz(69, 25), 1]), 440, 0, new Float64Array(12))[9]).toBeCloseTo(0.5, 12);
    const quarter = foldChroma(peaksOf([midiHz(69, 50 - 1e-9), 1]), 440, 0, new Float64Array(12));
    expect(Math.max(...quarter)).toBeLessThan(1e-15);
  });

  it("is read against the tuning: 25 cents sharp under a 25-cent tuning is on the note again", () => {
    expect(foldChroma(peaksOf([midiHz(69, 25), 1]), 440, 25, new Float64Array(12))[9]).toBeCloseTo(1, 12);
  });
});

describe("estimateTuning — the circular mean of where the peaks sit against the grid", () => {
  it("every peak 35 cents sharp reads 35, at full strength", () => {
    const estimate = estimateTuning(peaksOf([midiHz(60, 35), 1], [midiHz(64, 35), 2], [midiHz(79, 35), 0.5]), 440);
    expect(estimate.cents).toBeCloseTo(35, 9);
    expect(estimate.strength).toBeCloseTo(1, 12);
  });

  it("+49 and −49 cents are NEIGHBOURS: their mean is the quarter tone, not zero", () => {
    const estimate = estimateTuning(peaksOf([midiHz(60, 49), 1], [midiHz(64, -49), 1]), 440);
    // An arithmetic mean would say 0 — in tune — for two peaks that are both nearly a quarter tone out.
    expect(Math.abs(estimate.cents)).toBeCloseTo(50, 9);
    expect(estimate.strength).toBeCloseTo(Math.cos(2 * Math.PI * 0.01), 12);
  });

  it("peaks spread evenly round the semitone agree on nothing: strength 0", () => {
    const estimate = estimateTuning(peaksOf([midiHz(60, 0), 1], [midiHz(62, 25), 1], [midiHz(64, 50), 1], [midiHz(65, -25), 1]), 440);
    expect(estimate.strength).toBeLessThan(1e-9);
  });

  it("a synthesised triad 35 cents sharp, through the FFT, reads 35 within half a cent", () => {
    const estimate = estimateTuning(peaksAt(notes(48000, [48, 52, 55], 35), 48000), 440);
    expect(Math.abs(estimate.cents - 35)).toBeLessThan(0.5);
  });
});

describe("chromaProfile and chromaConfidence", () => {
  it("the profile is the amplitude ratio against the strongest class", () => {
    const energies = new Float64Array(12);
    energies[0] = 4;
    energies[7] = 1;
    expect([...chromaProfile(energies, new Float64Array(12))]).toEqual([1, 0, 0, 0, 0, 0, 0, 0.5, 0, 0, 0, 0]);
    expect([...chromaProfile(new Float64Array(12), new Float64Array(12))]).toEqual(new Array(12).fill(0));
  });

  it("confidence: four classes or fewer holding everything is 1, twelve equal classes is 0, six equal is the map's own value", () => {
    const withClasses = (count: number): Float64Array => Float64Array.from({ length: 12 }, (_, index) => (index < count ? 1 : 0));
    expect(chromaConfidence(withClasses(1), CHROMA_CONFIDENCE_FULL)).toBe(1);
    expect(chromaConfidence(withClasses(4), CHROMA_CONFIDENCE_FULL)).toBe(1);
    expect(chromaConfidence(withClasses(12), CHROMA_CONFIDENCE_FULL)).toBe(0);
    // Six equal classes: the top four hold 4/6.
    expect(chromaConfidence(withClasses(6), CHROMA_CONFIDENCE_FULL)).toBeCloseTo((4 / 6 - 1 / 3) / (CHROMA_CONFIDENCE_FULL - 1 / 3), 12);
    expect(chromaConfidence(new Float64Array(12), CHROMA_CONFIDENCE_FULL)).toBe(0);
  });
});

describe("the method: a triad with partials names its chord from C2 up", () => {
  it.each([
    ["C major at C4", [60, 64, 67]],
    ["C major at C3", [48, 52, 55]],
    ["C major at C2", [36, 40, 43]],
    ["A minor at A2", [45, 48, 52]],
  ] as const)("%s: its three classes lead and hold nine tenths of the energy", (_name, chord) => {
    const classes = chord.map((note) => note % 12).sort((a, b) => a - b);
    const energies = foldChroma(peaksAt(notes(48000, chord), 48000), 440, 0, new Float64Array(12));
    const reading = chordReading(energies, classes);
    expect(reading.leaders).toEqual(classes);
    // The rest is not error: the third and fifth partials of each tone ARE other classes.
    expect(reading.share).toBeGreaterThan(0.9);
    expect(chromaConfidence(energies, CHROMA_CONFIDENCE_FULL)).toBe(1);
  });

  it("and the nearest-bin fold does not: at C2 it leaves a third of the energy off the chord", () => {
    const chord = [36, 40, 43];
    const samples = notes(48000, chord);
    const refused = chordReading(nearestBinFold(samples, 48000), [0, 4, 7]);
    const built = chordReading(foldChroma(peaksAt(samples, 48000), 440, 0, new Float64Array(12)), [0, 4, 7]);
    expect(refused.share).toBeLessThan(0.75);
    expect(built.share - refused.share).toBeGreaterThan(0.15);
  });
});
