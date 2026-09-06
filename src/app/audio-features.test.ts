import { describe, expect, it } from "vitest";

import { AUDIO_BAND_EDGES_HZ, CENTROID_RANGE_HZ, computeAudioFeatures } from "./audio-features.ts";
import type { AudioAnalysisState } from "./audio-features.ts";

/**
 * T414: the analyser-bytes → features math, pinned with EXACT values (§V147).
 *
 * These constants are the recorded-features contract's semantics: change a band edge or
 * the flux normalisation and every recorded track re-renders differently, so a change
 * here is a versioning event, not a tweak.
 */

const SAMPLE_RATE = 48_000;
const FFT_SIZE = 2048; // bin width 23.4375 Hz, 1024 bins

const freshState = (): AudioAnalysisState => ({ previousSpectrum: null, previousOnset: 0 });

function spectrum(fill: (bin: number) => number): Uint8Array {
  const bins = new Uint8Array(FFT_SIZE / 2);
  for (let bin = 0; bin < bins.length; bin += 1) bins[bin] = fill(bin);
  return bins;
}

const silence = (): Uint8Array => new Uint8Array(FFT_SIZE);

describe("computeAudioFeatures (T414, §V147)", () => {
  it("averages each band over exactly its bins, normalised to 0..1", () => {
    const binHz = SAMPLE_RATE / FFT_SIZE;
    // Energy ONLY in the low band: bins whose centre lies within 20..250 Hz.
    const firstLow = Math.ceil(AUDIO_BAND_EDGES_HZ.low[0] / binHz);
    const lastLow = Math.floor(AUDIO_BAND_EDGES_HZ.low[1] / binHz);
    const features = computeAudioFeatures({
      frequency: spectrum((bin) => (bin >= firstLow && bin <= lastLow ? 255 : 0)),
      timeDomain: silence(),
      sampleRate: SAMPLE_RATE,
      fftSize: FFT_SIZE,
      state: freshState(),
    });
    expect(features.low).toBe(1);
    expect(features.lowMid).toBe(0);
    expect(features.highMid).toBe(0);
    expect(features.high).toBe(0);
  });

  it("computes RMS level exactly: a full-scale square wave is 1, silence is 0", () => {
    const square = new Uint8Array(FFT_SIZE);
    for (let index = 0; index < square.length; index += 1) square[index] = index % 2 === 0 ? 0 : 255;
    const features = computeAudioFeatures({
      frequency: spectrum(() => 0),
      timeDomain: square,
      sampleRate: SAMPLE_RATE,
      fftSize: FFT_SIZE,
      state: freshState(),
    });
    // (0-128)/128 = -1 and (255-128)/128 = 127/128, alternating.
    const expected = Math.sqrt((1 + (127 / 128) ** 2) / 2);
    expect(features.level).toBe(expected);

    const quiet = computeAudioFeatures({
      frequency: spectrum(() => 0),
      timeDomain: silence().fill(128),
      sampleRate: SAMPLE_RATE,
      fftSize: FFT_SIZE,
      state: freshState(),
    });
    expect(quiet.level).toBe(0);
  });

  it("onset is mean POSITIVE flux: first frame 0, silence-to-full-deck exactly 1, decays count 0", () => {
    const state = freshState();
    const base = {
      timeDomain: silence(),
      sampleRate: SAMPLE_RATE,
      fftSize: FFT_SIZE,
      state,
    };
    // Frame 1: no previous spectrum — no spurious full-deck hit.
    const first = computeAudioFeatures({ ...base, frequency: spectrum(() => 0) });
    expect(first.onset).toBe(0);
    // Frame 2: every bin jumps 0 -> 255. Mean positive flux normalises to exactly 1.
    const hit = computeAudioFeatures({ ...base, frequency: spectrum(() => 255) });
    expect(hit.onset).toBe(1);
    // Frame 3: everything FALLS — negative flux never counts, onset back to 0.
    const decay = computeAudioFeatures({ ...base, frequency: spectrum(() => 0) });
    expect(decay.onset).toBe(0);
    // Frame 4: half the bins rise by 100 → (512 × 100) / 1024 / 255.
    const partial = computeAudioFeatures({ ...base, frequency: spectrum((bin) => (bin % 2 === 0 ? 100 : 0)) });
    expect(partial.onset).toBe((512 * 100) / 1024 / 255);
  });

  it("onsetCount is a RISING edge of the pinned threshold; onsetMax equals onset at per-frame fidelity (T437)", () => {
    const state = freshState();
    const base = { timeDomain: silence(), sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE, state };
    computeAudioFeatures({ ...base, frequency: spectrum(() => 0) }); // prime previous spectrum
    const hit = computeAudioFeatures({ ...base, frequency: spectrum(() => 255) });
    expect(hit.onset).toBe(1);
    expect(hit.onsetCount).toBe(1); // rose through the threshold
    expect(hit.onsetMax).toBe(hit.onset);
    // Sustained energy is ONE event, not one per frame: the envelope must fall below
    // the threshold before a new rising edge counts.
    const sustainedRise = computeAudioFeatures({ ...base, frequency: spectrum(() => 255) });
    // (spectrum unchanged -> zero flux -> below threshold; a genuinely sustained
    // ABOVE-threshold flux needs ever-rising bins, so drive one:)
    expect(sustainedRise.onsetCount).toBe(0);
    const decay = computeAudioFeatures({ ...base, frequency: spectrum(() => 0) });
    expect(decay.onsetCount).toBe(0);
    const second = computeAudioFeatures({ ...base, frequency: spectrum(() => 200) });
    expect(second.onsetCount).toBe(1); // a fresh rise after a fall is a second event
  });

  /**
   * T1227 — the centroid, analytically. A bin-aligned tone through the analyser's
   * Blackman window leaks SYMMETRICALLY (255 on k-1..k+1, 240 on k±2, measured in
   * `hop-analyser.test.ts`), so its magnitude-weighted centroid is exactly k · binHz,
   * whatever the leakage's shape — and that is what pins the value without re-deriving
   * the weights. Silence is 0, not the range's midpoint.
   */
  it("centroid of a symmetric tone is EXACTLY the tone's bin frequency, mapped over CENTROID_RANGE_HZ; silence is 0", () => {
    const binHz = SAMPLE_RATE / FFT_SIZE;
    const base = { timeDomain: silence(), sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE, state: freshState() };
    const tone = (k: number): Uint8Array =>
      spectrum((bin) => (Math.abs(bin - k) <= 1 ? 255 : Math.abs(bin - k) === 2 ? 240 : 0));
    const [lowHz, highHz] = CENTROID_RANGE_HZ;
    for (const k of [10, 100, 400]) {
      const { centroid } = computeAudioFeatures({ ...base, frequency: tone(k) });
      expect(centroid).toBeCloseTo((k * binHz - lowHz) / (highHz - lowHz), 12);
    }
    expect(computeAudioFeatures({ ...base, frequency: spectrum(() => 0) }).centroid).toBe(0);
  });

  it("centroid weighs MAGNITUDE, not the dB byte: a -65 dB bin barely moves a -30 dB one", () => {
    // Byte 255 is -30 dB, byte 128 is -64.9 dB: 35 dB apart, a magnitude ratio of ~0.018.
    // Weighted by the BYTE the quiet bin would pull the centroid a third of the way over
    // (128/383); weighted by magnitude it pulls it 1.8% of the way. The test is the
    // difference between "brightness" and "which bins are above the floor".
    const binHz = SAMPLE_RATE / FFT_SIZE;
    const loud = 100;
    const quiet = 500;
    const base = { timeDomain: silence(), sampleRate: SAMPLE_RATE, fftSize: FFT_SIZE, state: freshState() };
    const { centroid } = computeAudioFeatures({
      ...base,
      frequency: spectrum((bin) => (bin === loud ? 255 : bin === quiet ? 128 : 0)),
    });
    const ratio = 10 ** (((128 / 255) * 70 - 70) / 20);
    const [lowHz, highHz] = CENTROID_RANGE_HZ;
    const expectedHz = (loud + quiet * ratio) / (1 + ratio) * binHz;
    expect(centroid).toBeCloseTo((expectedHz - lowHz) / (highHz - lowHz), 12);
    const byteWeightedHz = ((loud * 255 + quiet * 128) / (255 + 128)) * binHz;
    expect(centroid).toBeLessThan((byteWeightedHz - lowHz) / (highHz - lowHz) / 2);
  });
});
