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

/**
 * T1227 — the DETECTOR bands: where each drum's onset is looked for. These are not the
 * energy bands above (those are calibrated for what a band READS; these for what rises
 * when a drum hits): a kick's fundamental and body, a snare's body and the low half of
 * its crack, a hat's air above where vocals and guitars still live. Heuristics on a mix,
 * and part of the recorded contract (§V352): a track's `kick` means "over these Hz".
 */
export const AUDIO_DETECTOR_BANDS_HZ = {
  kick: [30, 150],
  snare: [150, 2500],
  hat: [5000, 16000],
} as const;

/**
 * T1227 — the adaptive event bar the detector counts against: an event is a rising
 * crossing of the recent mean (over `historyHops` analysis hops of 512 samples, ~1 s)
 * plus `delta` (in the envelope's units: 0.05 ≈ 13 byte-levels of mean rise inside a
 * band), at most one per `minGapHops` (32 ms). Recorded contract like the fixed onset
 * level above — a different margin counts different events. FIRST VALUES (T1226): nothing
 * has been measured against material yet; T1230 is where they get retuned, and that is
 * a versioning event when it happens.
 */
export const DETECTOR_EVENT_PICKER = { historyHops: 96, delta: 0.05, minGapHops: 3 } as const;

/** T1227 — the span `centroid` maps onto 0..1: the audible range the bands cover. */
export const CENTROID_RANGE_HZ = [20, 16000] as const;

/** The analyser's byte map, inverted: `getByteFrequencyData` puts [-100, -30] dB on 0..255. */
const ANALYSER_MIN_DB = -100;
const ANALYSER_DB_SPAN = 70;

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

/**
 * T1227 — spectral centroid over `CENTROID_RANGE_HZ`, weighted by linear MAGNITUDE.
 *
 * The bytes are decibels, so they are inverted first: weighting by the byte itself would
 * give a quiet bin at −90 dB a third of the pull of a loud one at −30, and the centroid of
 * a single tone would drift toward the middle of the range instead of sitting on the tone.
 * Byte 0 is "at or below the floor" and weighs nothing, so silence reads 0 rather than the
 * range's midpoint. A tone on bin k, whose leakage is symmetric, reads exactly k · binHz.
 */
function spectralCentroid(frequency: Uint8Array, binHz: number): number {
  const [lowHz, highHz] = CENTROID_RANGE_HZ;
  const first = Math.max(0, Math.ceil(lowHz / binHz));
  const last = Math.min(frequency.length - 1, Math.floor(highHz / binHz));
  let weighted = 0;
  let total = 0;
  for (let bin = first; bin <= last; bin += 1) {
    const byte = frequency[bin] ?? 0;
    if (byte === 0) continue;
    const magnitude = 10 ** ((ANALYSER_MIN_DB + (byte / 255) * ANALYSER_DB_SPAN) / 20);
    weighted += bin * binHz * magnitude;
    total += magnitude;
  }
  if (total === 0) return 0;
  const centroid = (weighted / total - lowHz) / (highHz - lowHz);
  return centroid <= 0 ? 0 : centroid >= 1 ? 1 : centroid;
}

/**
 * The fields one analysis window's BYTES determine. The detector and tempo fields of the
 * record are not among them: those come from the hop stream (`audio-analysis-frame.ts`)
 * and from a tempo claim, and this function is not where either is made.
 */
export type AudioSpectralFeatures = Pick<
  AudioFeatures,
  "level" | "low" | "lowMid" | "highMid" | "high" | "onset" | "onsetCount" | "onsetMax" | "centroid"
>;

export function computeAudioFeatures(input: AudioAnalysisInput): AudioSpectralFeatures {
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
   * T437, at the fidelity of ONE window: the max IS the reading, and the count is a
   * single rising edge. T1226 runs this on every hop and reduces several per frame
   * interval into a true max and a real count (`audio-analysis-frame.ts`) — the same
   * meaning, more readings.
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
    centroid: spectralCentroid(frequency, binHz),
  };
}
