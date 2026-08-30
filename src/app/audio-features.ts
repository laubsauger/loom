import type { AudioFeatures } from "@domain/types/frame.ts";

/**
 * T414: analyser bytes → AudioFeatures, as a PURE function.
 *
 * This is the only place feature semantics live — the capture hook feeds it whatever
 * the AnalyserNode produced this frame, and a test feeds it synthetic arrays and
 * asserts exact values (§V147). Keeping it pure is also the honesty about determinism:
 * the FEATURES are the recorded/replayed contract (see `AudioFeatures` in frame.ts);
 * this function is merely the live session's way of producing them, and nothing
 * downstream may depend on HOW they were produced.
 *
 * Band edges are musical rather than even: low ends where kick/bass energy does,
 * lowMid spans the body of most instruments, highMid the presence range, high the air.
 */
export const AUDIO_BAND_EDGES_HZ = {
  low: [20, 250],
  lowMid: [250, 2000],
  highMid: [2000, 6000],
  high: [6000, 16000],
} as const;

export interface AudioAnalysisState {
  /** Previous frame's frequency bytes, for spectral flux. Null on the first frame. */
  previousSpectrum: Uint8Array | null;
  /** Previous onset value, for the rising-edge event count (T437). */
  previousOnset: number;
}

/**
 * T437: an onset EVENT is a rising crossing of this flux level. The constant is part
 * of the recorded contract (§V352's corollary — changing it is a versioning event for
 * every recorded feature track), pinned by exact-value test. 0.02 mean positive flux
 * is ~5 byte-levels of broadband rise: real transients clear it easily, breathing
 * noise does not.
 */
export const ONSET_EVENT_THRESHOLD = 0.02;

export interface AudioAnalysisInput {
  /** `analyser.getByteFrequencyData` output: frequencyBinCount bytes, 0..255. */
  readonly frequency: Uint8Array;
  /** `analyser.getByteTimeDomainData` output: fftSize bytes, 128 = silence. */
  readonly timeDomain: Uint8Array;
  readonly sampleRate: number;
  /** The analyser's fftSize; bin width is sampleRate / fftSize. */
  readonly fftSize: number;
  /** Mutated in place (previous spectrum). Owned by the capture hook. */
  readonly state: AudioAnalysisState;
}

function bandAverage(frequency: Uint8Array, binHz: number, lowHz: number, highHz: number): number {
  const first = Math.max(0, Math.ceil(lowHz / binHz));
  const last = Math.min(frequency.length - 1, Math.floor(highHz / binHz));
  if (last < first) return 0;
  let sum = 0;
  for (let bin = first; bin <= last; bin += 1) sum += frequency[bin] ?? 0;
  return sum / (last - first + 1) / 255;
}

export function computeAudioFeatures(input: AudioAnalysisInput): AudioFeatures {
  const { frequency, timeDomain, sampleRate, fftSize, state } = input;
  const binHz = sampleRate / fftSize;

  /* Broadband RMS from the time domain: 128 is silence, ±128 full scale. */
  let sumSquares = 0;
  for (let index = 0; index < timeDomain.length; index += 1) {
    const centred = ((timeDomain[index] ?? 128) - 128) / 128;
    sumSquares += centred * centred;
  }
  const level = timeDomain.length === 0 ? 0 : Math.sqrt(sumSquares / timeDomain.length);

  /*
   * Onset: mean POSITIVE spectral flux, normalised to 0..1 (a silence→full-scale jump
   * across every bin is exactly 1). Rises on any broadband energy increase; the first
   * frame has no previous spectrum and reports 0 rather than a spurious full-deck hit.
   */
  let onset = 0;
  const previous = state.previousSpectrum;
  if (previous !== null && previous.length === frequency.length && frequency.length > 0) {
    let flux = 0;
    for (let bin = 0; bin < frequency.length; bin += 1) {
      const rise = (frequency[bin] ?? 0) - (previous[bin] ?? 0);
      if (rise > 0) flux += rise;
    }
    onset = flux / frequency.length / 255;
  }
  if (previous !== null && previous.length === frequency.length) {
    previous.set(frequency);
  } else {
    state.previousSpectrum = new Uint8Array(frequency);
  }

  /*
   * T437, at per-frame fidelity: one analysis per interval means the max IS the
   * reading, and the count is a single rising edge. A faster analysis hop later
   * raises fidelity — several hops per interval, a true max and a real count —
   * without changing either field's meaning.
   */
  const onsetCount = onset > ONSET_EVENT_THRESHOLD && state.previousOnset <= ONSET_EVENT_THRESHOLD ? 1 : 0;
  state.previousOnset = onset;

  return {
    level,
    low: bandAverage(frequency, binHz, ...AUDIO_BAND_EDGES_HZ.low),
    lowMid: bandAverage(frequency, binHz, ...AUDIO_BAND_EDGES_HZ.lowMid),
    highMid: bandAverage(frequency, binHz, ...AUDIO_BAND_EDGES_HZ.highMid),
    high: bandAverage(frequency, binHz, ...AUDIO_BAND_EDGES_HZ.high),
    onset,
    onsetCount,
    onsetMax: onset,
  };
}
