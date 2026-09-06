import { describe, expect, it } from "vitest";
import {
  ANALYSER_MAX_DECIBELS,
  ANALYSER_MIN_DECIBELS,
  analyserBytes,
  blackmanWindow,
  decibelsToByte,
  fftInPlace,
  sampleToByte,
  spectrumDecibels,
} from "./stft.ts";

/**
 * T1225 — the STFT against ANALYTIC values (§V147), not against another FFT.
 *
 * The periodic Blackman window is three cosines, so its DFT is five lines: a0·N at bin
 * 0, −a1·N/2 at ±1, a2·N/2 at ±2, nothing anywhere else. A sine of amplitude A sitting
 * exactly on bin k (k ≥ 3) therefore lands as A·a0/2 at bin k, A·a1/4 one bin either
 * side, A·a2/4 two bins either side, and ZERO beyond — after the analyser's 1/N scale.
 * Those are the numbers below; a wrong window, a wrong scale or a wrong FFT moves them.
 */

const N = 2048;
const A0 = 0.42;
const A1 = 0.5;
const A2 = 0.08;

function sine(amplitude: number, bin: number): Float64Array {
  const out = new Float64Array(N);
  for (let n = 0; n < N; n += 1) out[n] = amplitude * Math.sin((2 * Math.PI * bin * n) / N);
  return out;
}

describe("spectrumDecibels — WebAudio's analyser, restated", () => {
  const window = blackmanWindow(N);

  it("a full-scale sine on bin 100 measures A·a0/2 there: 20·log10(0.21) dB", () => {
    const decibels = spectrumDecibels(sine(1, 100), window);
    expect(decibels[100]).toBeCloseTo(20 * Math.log10(A0 / 2), 9);
  });

  it("leaks exactly the window's two side lines and nothing further", () => {
    const decibels = spectrumDecibels(sine(1, 100), window);
    for (const side of [-1, 1]) expect(decibels[100 + side]).toBeCloseTo(20 * Math.log10(A1 / 4), 9);
    for (const side of [-2, 2]) expect(decibels[100 + side]).toBeCloseTo(20 * Math.log10(A2 / 4), 9);
    // Beyond ±2 the analytic value is zero; float rounding leaves it far below the byte floor.
    for (const side of [-3, 3, -10, 10, 400]) expect(decibels[100 + side]).toBeLessThan(ANALYSER_MIN_DECIBELS - 100);
  });

  it("is a logarithm of amplitude: −20 dB of signal is −20 dB of bin", () => {
    const loud = spectrumDecibels(sine(1, 37), window);
    const quiet = spectrumDecibels(sine(0.1, 37), window);
    expect((loud[37] as number) - (quiet[37] as number)).toBeCloseTo(20, 9);
  });

  it("DC measures the window's mean, a0", () => {
    const decibels = spectrumDecibels(new Float64Array(N).fill(0.5), window);
    expect(decibels[0]).toBeCloseTo(20 * Math.log10(0.5 * A0), 9);
  });

  it("silence has no logarithm and says so rather than returning −Infinity", () => {
    const decibels = spectrumDecibels(new Float64Array(N), window);
    for (const db of decibels) expect(db).toBe(-1000);
  });

  it("refuses a window or scratch of the wrong size instead of reading past it", () => {
    expect(() => spectrumDecibels(sine(1, 4), blackmanWindow(1024))).toThrow(/do not fit 2048 samples/);
    expect(() => spectrumDecibels(sine(1, 4), window, new Float64Array(3))).toThrow(/do not fit/);
    expect(() => fftInPlace(new Float64Array(6), new Float64Array(6))).toThrow(/power of two/);
  });
});

describe("the byte quantisers — what `getByte*Data` does to a float", () => {
  it("maps the analyser window [−100, −30] dB onto 0..255 by truncation", () => {
    expect(decibelsToByte(ANALYSER_MIN_DECIBELS)).toBe(0);
    expect(decibelsToByte(ANALYSER_MAX_DECIBELS)).toBe(255);
    expect(decibelsToByte(-65)).toBe(127); // 255 · 35 / 70 = 127.5, truncated
    expect(decibelsToByte(-64.9)).toBe(127);
    expect(decibelsToByte(-1000)).toBe(0);
    expect(decibelsToByte(0)).toBe(255);
    expect(decibelsToByte(Number.NaN)).toBe(0);
  });

  it("maps −1..1 samples onto 0..255 with 128 as silence", () => {
    expect(sampleToByte(0)).toBe(128);
    expect(sampleToByte(-1)).toBe(0);
    expect(sampleToByte(0.5)).toBe(192);
    expect(sampleToByte(1)).toBe(255); // 256 clamps
    expect(sampleToByte(-0.001)).toBe(127); // truncation, not rounding
  });

  it("analyserBytes fills both arrays in place, analyser-shaped", () => {
    const frequency = new Uint8Array(N / 2);
    const timeDomain = new Uint8Array(N);
    const samples = sine(0.5, 100);
    analyserBytes(samples, blackmanWindow(N), frequency, timeDomain);
    // 0.5 · 0.21 = 0.105 → −19.58 dB → 255 · 80.42 / 70 = 292 → clamps to 255.
    expect(frequency[100]).toBe(255);
    // Two bins out: 0.5 · 0.02 = 0.01 → −40 dB → 255 · 60 / 70 = 218.57 → 218.
    expect(frequency[102]).toBe(218);
    expect(frequency[110]).toBe(0);
    expect(timeDomain[0]).toBe(128);
    expect(timeDomain[1]).toBe(sampleToByte(samples[1] as number));
  });
});
