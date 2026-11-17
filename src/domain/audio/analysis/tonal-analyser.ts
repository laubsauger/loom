/**
 * T1751b — the tonal analyser: one long window in, one frame's pitch classes out.
 *
 * The stateful wrapper round `chroma.ts`, and the one core every path runs: the worklet
 * hands it the last `windowSize` samples every `TONAL_ANALYSIS.hop`, and the offline walk
 * does the same over decoded PCM, so a file's chroma is the same code live and pre-analysed.
 *
 * The only state is the TUNING. A frame's own estimate is noisy and, a quarter tone off
 * pitch, ambiguous between two labellings; folding against it directly would let the twelve
 * names flip from frame to frame. So the analyser starts at the reference (A = 440 Hz) and
 * eases toward what confident frames measure, over `TUNING_SECONDS`. The ease is on the
 * unit circle, where +49 and −49 cents are close. Time arrives as SAMPLES ADVANCED, never a
 * clock, so the same constants mean the same seconds on any hop grid.
 */
import { CHROMA_CONFIDENCE_FULL, TONAL_ANALYSIS } from "../tonal-fields.ts";
import { createChordEstimator, createKeyEstimator, type ChordClaim, type KeyClaim } from "./chord.ts";
import { createVoiceTracker, type VoiceState } from "./voices.ts";
import {
  chromaConfidence,
  chromaProfile,
  createPeakWorkspace,
  estimateTuning,
  foldChroma,
  hannWindow,
  spectralPeaks,
} from "./chroma.ts";

export interface TonalAnalyserOptions {
  readonly sampleRate: number;
  readonly windowSize: number;
  /**
   * T1752b: a tuning KNOWN in advance, in cents from the reference. Given, every window is
   * folded against it and the analyser learns nothing — what the offline walk does once it
   * has measured the whole file (`estimateTuningOver`). Absent, the tuning is learned while
   * listening, which is all a live input can do.
   */
  readonly tuning?: number;
}

export interface TonalFrame {
  /** Twelve values, C = 0: `sqrt(E / E_max)`. All zeros in silence. */
  readonly chroma: Float64Array;
  /** 0..1, see `chromaConfidence`. */
  readonly confidence: number;
  /** The tuning this frame was folded against, cents from the reference. */
  readonly tuning: number;
  /** Seconds between the centre of the analysed window and its end. */
  readonly lag: number;
  /**
   * T1753b: the chord and the key as claimed WHILE LISTENING (`chord.ts`, the forward
   * decode). The offline walk has the whole file and replaces both with the Viterbi path.
   */
  readonly chord: ChordClaim;
  readonly key: KeyClaim;
  /** T1756b: the tracked note voices, one entry per slot (`voices.ts`). */
  readonly voices: readonly VoiceState[];
}

export interface TonalAnalyser {
  /**
   * Analyse one window of `windowSize` samples. `advancedSamples` is how far the window
   * moved since the previous call (0 on the first), which is the analyser's only clock.
   */
  analyse(samples: ArrayLike<number>, advancedSamples: number): TonalFrame;
}

/** How long the tuning takes to follow a confident estimate. */
export const TUNING_SECONDS = 5;
/** A frame moves the tuning only when its classes are this concentrated and its peaks agree this well. */
export const TUNING_MIN_CONFIDENCE = 0.5;
export const TUNING_MIN_STRENGTH = 0.5;

export function createTonalAnalyser(options: TonalAnalyserOptions): TonalAnalyser {
  const { sampleRate, windowSize } = options;
  if (!(windowSize > 0) || (windowSize & (windowSize - 1)) !== 0) {
    throw new Error(`createTonalAnalyser: windowSize must be a power of two, got ${windowSize}`);
  }
  if (!(sampleRate > 0)) throw new Error(`createTonalAnalyser: bad sample rate ${sampleRate}`);
  const window = hannWindow(windowSize);
  const workspace = createPeakWorkspace(windowSize);
  const energies = new Float64Array(12);
  const peakOptions = {
    sampleRate,
    lowHz: TONAL_ANALYSIS.lowHz,
    highHz: TONAL_ANALYSIS.highHz,
    floorDecibels: TONAL_ANALYSIS.floorDecibels,
    floorAmplitude: TONAL_ANALYSIS.floorAmplitude,
  };
  const lag = windowSize / 2 / sampleRate;
  const chords = createChordEstimator();
  const keys = createKeyEstimator();
  const voices = createVoiceTracker();
  /** A peak's energy as a sine amplitude: a sine of amplitude A reads A·N/4 on its bin under the Hann window. */
  const amplitudeOf = (energy: number): number => (Math.sqrt(energy) * 4) / windowSize;
  const noPeaks = { frequency: new Float64Array(0), energy: new Float64Array(0), count: 0 };
  // The tuning as a point on the unit circle; (1, 0) is the reference.
  const fixed = options.tuning !== undefined;
  let tuneX = fixed ? Math.cos((2 * Math.PI * (options.tuning as number)) / 100) : 1;
  let tuneY = fixed ? Math.sin((2 * Math.PI * (options.tuning as number)) / 100) : 0;

  return {
    analyse(samples, advancedSamples) {
      if (samples.length !== windowSize) {
        throw new Error(`tonal analyser: expected ${windowSize} samples, got ${samples.length}`);
      }
      // Fresh per frame on purpose: the worklet transfers it across the port.
      const chroma = new Float64Array(12);
      // A fixed tuning is reported as given, not as its own round trip through the circle.
      const tuning = fixed ? (options.tuning as number) : (Math.atan2(tuneY, tuneX) / (2 * Math.PI)) * 100;
      let meanSquare = 0;
      for (let i = 0; i < windowSize; i += 1) meanSquare += (samples[i] as number) * (samples[i] as number);
      const seconds = Math.max(0, advancedSamples) / sampleRate;
      if (meanSquare / windowSize < TONAL_ANALYSIS.silenceMeanSquare) {
        return {
          chroma,
          confidence: 0,
          tuning,
          lag,
          chord: chords.push(chroma, 0, seconds),
          key: keys.push(chroma, 0, seconds),
          voices: voices.push(noPeaks, amplitudeOf, 0, seconds),
        };
      }

      const peaks = spectralPeaks(samples, window, peakOptions, workspace);
      foldChroma(peaks, TONAL_ANALYSIS.referenceHz, tuning, energies);
      const confidence = chromaConfidence(energies, CHROMA_CONFIDENCE_FULL);
      chromaProfile(energies, chroma);

      // The tuning learns from this frame AFTER folding it: a frame is read against what
      // was known when it arrived, and the next one against what it taught.
      const chord = chords.push(chroma, confidence, seconds);
      const key = keys.push(chroma, confidence, seconds);
      const voiced = voices.push(peaks, amplitudeOf, confidence, seconds);
      if (fixed) return { chroma, confidence, tuning, lag, chord, key, voices: voiced };
      const estimate = estimateTuning(peaks, TONAL_ANALYSIS.referenceHz);
      if (advancedSamples > 0 && confidence >= TUNING_MIN_CONFIDENCE && estimate.strength >= TUNING_MIN_STRENGTH) {
        const k = 1 - Math.exp(-advancedSamples / sampleRate / TUNING_SECONDS);
        const angle = (2 * Math.PI * estimate.cents) / 100;
        tuneX += (Math.cos(angle) - tuneX) * k;
        tuneY += (Math.sin(angle) - tuneY) * k;
      }
      return { chroma, confidence, tuning, lag, chord, key, voices: voiced };
    },
  };
}

/**
 * T1752b — ONE tuning for a whole file: the circular mean of every confident window's own
 * estimate, each weighted by how well its peaks agree. The same gates the live ease uses
 * decide which windows count, so noise and silence teach nothing here either. Windows do
 * not overlap (a file is measured, not followed), and a file with no confident window is
 * at the reference: 0.
 */
export function estimateTuningOver(samples: ArrayLike<number>, sampleRate: number, windowSize: number): number {
  const window = hannWindow(windowSize);
  const workspace = createPeakWorkspace(windowSize);
  const energies = new Float64Array(12);
  const frame = new Float64Array(windowSize);
  const peakOptions = {
    sampleRate,
    lowHz: TONAL_ANALYSIS.lowHz,
    highHz: TONAL_ANALYSIS.highHz,
    floorDecibels: TONAL_ANALYSIS.floorDecibels,
    floorAmplitude: TONAL_ANALYSIS.floorAmplitude,
  };
  let x = 0;
  let y = 0;
  for (let end = windowSize; end <= samples.length; end += windowSize) {
    let meanSquare = 0;
    for (let i = 0; i < windowSize; i += 1) {
      const sample = samples[end - windowSize + i] as number;
      frame[i] = sample;
      meanSquare += sample * sample;
    }
    if (meanSquare / windowSize < TONAL_ANALYSIS.silenceMeanSquare) continue;
    const peaks = spectralPeaks(frame, window, peakOptions, workspace);
    const estimate = estimateTuning(peaks, TONAL_ANALYSIS.referenceHz);
    // Against the reference: confidence is about how concentrated the classes are, and a
    // detuned file's classes are as concentrated as a tuned one's (the fold only scales them).
    foldChroma(peaks, TONAL_ANALYSIS.referenceHz, estimate.cents, energies);
    if (chromaConfidence(energies, CHROMA_CONFIDENCE_FULL) < TUNING_MIN_CONFIDENCE || estimate.strength < TUNING_MIN_STRENGTH) continue;
    const angle = (2 * Math.PI * estimate.cents) / 100;
    x += estimate.strength * Math.cos(angle);
    y += estimate.strength * Math.sin(angle);
  }
  return x === 0 && y === 0 ? 0 : (Math.atan2(y, x) / (2 * Math.PI)) * 100;
}
