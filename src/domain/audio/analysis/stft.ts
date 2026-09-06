/**
 * T1225 — the STFT the audio analysis engine is built on, as PURE functions.
 *
 * The one requirement that shapes everything here: the engine's band values must be
 * the values today's `AnalyserNode` produces, WITHIN BYTE QUANTISATION, or the sixteen
 * audio examples and `audioPattern`'s dB calibration (T701/T776) all need a retune. So
 * this is not a generic STFT — it is WebAudio's analyser, restated: the spec's Blackman
 * window (a0 0.42, a1 0.5, a2 0.08, x = i / N), magnitude / N, 20·log10, and the byte
 * map `trunc(255 · (dB − minDb) / (maxDb − minDb))`. T702 measured that restatement
 * against a live node (mean |error| < 0.5 dB, identical channel values); the worklet
 * parity spec measures THIS file the same way on identical samples.
 *
 * Headless and worker-movable by construction: no DOM, no clock, typed arrays in and
 * out. `src/app/audio-analysis.worklet.ts` runs it on the audio thread; a test runs it
 * on synthetic samples and asserts analytic values (§V147).
 */

/** WebAudio's Blackman window, N coefficients. Periodic form (x = i / N), as the spec defines it. */
export function blackmanWindow(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i += 1) {
    const x = i / size;
    window[i] = 0.42 - 0.5 * Math.cos(2 * Math.PI * x) + 0.08 * Math.cos(4 * Math.PI * x);
  }
  return window;
}

/** In-place iterative radix-2 FFT. `real.length` must be a power of two. */
export function fftInPlace(real: Float64Array, imag: Float64Array): void {
  const size = real.length;
  if (size !== imag.length || (size & (size - 1)) !== 0) {
    throw new Error(`fftInPlace: size must be a power of two with matching parts, got ${size}/${imag.length}`);
  }
  for (let i = 1, j = 0; i < size; i += 1) {
    let bit = size >> 1;
    for (; (j & bit) !== 0; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = real[i] as number;
      real[i] = real[j] as number;
      real[j] = tr;
      const ti = imag[i] as number;
      imag[i] = imag[j] as number;
      imag[j] = ti;
    }
  }
  for (let length = 2; length <= size; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const wReal = Math.cos(angle);
    const wImag = Math.sin(angle);
    for (let start = 0; start < size; start += length) {
      let curReal = 1;
      let curImag = 0;
      for (let k = 0; k < length / 2; k += 1) {
        const a = start + k;
        const b = a + length / 2;
        const tReal = (real[b] as number) * curReal - (imag[b] as number) * curImag;
        const tImag = (real[b] as number) * curImag + (imag[b] as number) * curReal;
        real[b] = (real[a] as number) - tReal;
        imag[b] = (imag[a] as number) - tImag;
        real[a] = (real[a] as number) + tReal;
        imag[a] = (imag[a] as number) + tImag;
        const nextReal = curReal * wReal - curImag * wImag;
        curImag = curReal * wImag + curImag * wReal;
        curReal = nextReal;
      }
    }
  }
}

/** Silence has no logarithm; the analyser reports this for an all-zero bin. */
export const SILENT_DECIBELS = -1000;

/**
 * One analyser frame: `samples` (fftSize of them) → per-bin dB, fftSize / 2 bins.
 * `window` is `blackmanWindow(samples.length)`, hoisted by the caller because the
 * worklet computes ~100 of these a second and the window never changes.
 */
export function spectrumDecibels(
  samples: ArrayLike<number>,
  window: Float64Array,
  out: Float64Array = new Float64Array(samples.length / 2),
): Float64Array {
  const size = samples.length;
  if (window.length !== size || out.length !== size / 2) {
    throw new Error(`spectrumDecibels: window ${window.length} / out ${out.length} do not fit ${size} samples`);
  }
  const real = new Float64Array(size);
  const imag = new Float64Array(size);
  for (let i = 0; i < size; i += 1) real[i] = (samples[i] as number) * (window[i] as number);
  fftInPlace(real, imag);
  const scale = 1 / size;
  for (let bin = 0; bin < size / 2; bin += 1) {
    const magnitude = Math.hypot(real[bin] as number, imag[bin] as number) * scale;
    out[bin] = magnitude === 0 ? SILENT_DECIBELS : 20 * Math.log10(magnitude);
  }
  return out;
}

/** The analyser's `[minDecibels, maxDecibels]` defaults; the divisor 70 in `(dB + 100) / 70`. */
export const ANALYSER_MIN_DECIBELS = -100;
export const ANALYSER_MAX_DECIBELS = -30;

/** `getByteFrequencyData`'s quantiser: dB → 0..255, truncated, clamped. */
export function decibelsToByte(db: number, minDb = ANALYSER_MIN_DECIBELS, maxDb = ANALYSER_MAX_DECIBELS): number {
  const scaled = (255 * (db - minDb)) / (maxDb - minDb);
  if (!Number.isFinite(scaled) || scaled < 0) return 0;
  if (scaled > 255) return 255;
  return Math.trunc(scaled);
}

/** `getByteTimeDomainData`'s quantiser: a −1..1 sample → 0..255, 128 = silence, truncated. */
export function sampleToByte(sample: number): number {
  const scaled = 128 * (1 + sample);
  if (!Number.isFinite(scaled) || scaled < 0) return 0;
  if (scaled > 255) return 255;
  return Math.trunc(scaled);
}

/**
 * The whole analyser, analyser-shaped: the two byte arrays `computeAudioFeatures` eats.
 * `frequency` is fftSize / 2 bytes, `timeDomain` fftSize bytes — both written in place
 * so the worklet reuses its buffers between hops.
 */
export function analyserBytes(
  samples: ArrayLike<number>,
  window: Float64Array,
  frequency: Uint8Array,
  timeDomain: Uint8Array,
  scratch: Float64Array = new Float64Array(samples.length / 2),
): void {
  const decibels = spectrumDecibels(samples, window, scratch);
  for (let bin = 0; bin < decibels.length; bin += 1) frequency[bin] = decibelsToByte(decibels[bin] as number);
  for (let i = 0; i < samples.length; i += 1) timeDomain[i] = sampleToByte(samples[i] as number);
}
