import { describe, expect, it } from "vitest";

import { AUDIO_BAND_EDGES_HZ, computeAudioFeatures } from "./audio-features.ts";
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

const freshState = (): AudioAnalysisState => ({ previousSpectrum: null });

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
});
