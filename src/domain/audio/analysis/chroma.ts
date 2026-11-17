/**
 * T1751b — chroma as PURE functions: one long window in, twelve pitch-class energies out.
 *
 * The method is HPCP's (Gómez 2006), chosen by measurement over the obvious one. "Every bin
 * to its nearest pitch class" puts 0.64 of a C2 triad's energy on its chord tones and names
 * the wrong chord for input 35 cents off pitch; folding interpolated PEAKS puts 0.92 there
 * from C2 to C4 and holds under detuning. So:
 *
 *  1. `spectralPeaks`: Hann window, power spectrum, local maxima inside the tonal range and
 *     above a floor relative to the frame's strongest bin, each refined by a parabola
 *     through its log power and its two neighbours' — a frequency well under one bin.
 *  2. `estimateTuning`: the energy-weighted CIRCULAR mean of the peaks' distance from the
 *     nearest equal-tempered semitone. Circular, because +49 and −49 cents are neighbours.
 *  3. `foldChroma`: each peak's energy to its nearest class, weighted cos² of its distance
 *     from the class centre (1 on the note, 0 at the quarter tone), relative to a tuning.
 *
 * What was tested and NOT built: keeping only peaks that persist from the previous frame
 * (a causal stand-in for harmonic/percussive separation). White noise kept 0.87–0.94 of its
 * energy, so it separates nothing at this peak density.
 *
 * Headless and worker-movable: typed arrays in and out, no DOM, no clock.
 */
import { fftInPlace } from "./stft.ts";

/** Periodic Hann, N coefficients. A sine on bin k reads half its peak on k ± 1 and nothing further. */
export function hannWindow(size: number): Float64Array {
  const window = new Float64Array(size);
  for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return window;
}

/** Peaks of one frame: `count` valid entries in each array. */
export interface SpectralPeaks {
  readonly frequency: Float64Array;
  /** Power (magnitude squared) at the interpolated peak. */
  readonly energy: Float64Array;
  count: number;
}

export interface PeakWorkspace {
  readonly real: Float64Array;
  readonly imag: Float64Array;
  readonly power: Float64Array;
  readonly peaks: SpectralPeaks;
}

export function createPeakWorkspace(windowSize: number): PeakWorkspace {
  const bins = windowSize / 2;
  return {
    real: new Float64Array(windowSize),
    imag: new Float64Array(windowSize),
    power: new Float64Array(bins),
    // A local maximum needs a lower neighbour on each side: at most every other bin.
    peaks: { frequency: new Float64Array(bins / 2 + 1), energy: new Float64Array(bins / 2 + 1), count: 0 },
  };
}

export interface PeakOptions {
  readonly sampleRate: number;
  readonly lowHz: number;
  readonly highHz: number;
  /** Negative: how far under the strongest bin a peak may sit and still count. */
  readonly floorDecibels: number;
  /** A sine amplitude: a peak quieter than this is not a partial, however quiet the rest is. */
  readonly floorAmplitude: number;
}

/**
 * The peaks of `samples` (a whole window). Returns `workspace.peaks`, overwritten.
 *
 * The parabola is fitted to LOG power: a Hann main lobe is close to a Gaussian, whose log
 * is exactly a parabola, so the fit lands nearer the true frequency than a fit to the power
 * itself. For a sine exactly on a bin the two neighbours are equal and the offset is 0.
 */
export function spectralPeaks(
  samples: ArrayLike<number>,
  window: Float64Array,
  options: PeakOptions,
  workspace: PeakWorkspace,
): SpectralPeaks {
  const size = window.length;
  if (samples.length !== size || workspace.real.length !== size) {
    throw new Error(`spectralPeaks: ${samples.length} samples / workspace ${workspace.real.length} do not fit a ${size} window`);
  }
  const { real, imag, power, peaks } = workspace;
  for (let i = 0; i < size; i += 1) real[i] = (samples[i] as number) * (window[i] as number);
  imag.fill(0);
  fftInPlace(real, imag);
  const bins = size / 2;
  const binHz = options.sampleRate / size;
  const first = Math.max(1, Math.floor(options.lowHz / binHz));
  const last = Math.min(bins - 2, Math.ceil(options.highHz / binHz));
  let strongest = 0;
  // One bin either side of the range too: the parabola reads a peak's neighbours.
  for (let bin = first - 1; bin <= last + 1; bin += 1) {
    const value = (real[bin] as number) * (real[bin] as number) + (imag[bin] as number) * (imag[bin] as number);
    power[bin] = value;
    if (value > strongest) strongest = value;
  }
  peaks.count = 0;
  if (strongest <= 0) return peaks;
  // A sine of amplitude A reads A·N/4 on its bin under a Hann window.
  const quietest = (options.floorAmplitude * size) / 4;
  const floor = Math.max(strongest * 10 ** (options.floorDecibels / 10), quietest * quietest);
  for (let bin = first; bin <= last; bin += 1) {
    const centre = power[bin] as number;
    const below = power[bin - 1] as number;
    const above = power[bin + 1] as number;
    if (centre <= floor || centre <= below || centre < above) continue;
    // Half the log of a power is the log of a magnitude; a zero neighbour is floored, not −∞.
    const a = 0.5 * Math.log(Math.max(below, centre * 1e-30));
    const b = 0.5 * Math.log(centre);
    const c = 0.5 * Math.log(Math.max(above, centre * 1e-30));
    const curvature = a - 2 * b + c;
    const offset = curvature < 0 ? (0.5 * (a - c)) / curvature : 0;
    const frequency = (bin + offset) * binHz;
    if (frequency < options.lowHz || frequency > options.highHz) continue;
    peaks.frequency[peaks.count] = frequency;
    peaks.energy[peaks.count] = Math.exp(2 * (b - 0.25 * (a - c) * offset));
    peaks.count += 1;
  }
  return peaks;
}

/** A peak's pitch as a fractional MIDI note number against `referenceHz` for A4. */
export function midiOf(frequency: number, referenceHz: number): number {
  return 69 + 12 * Math.log2(frequency / referenceHz);
}

export interface TuningEstimate {
  /** −50..50: where the peaks sit against the equal-tempered grid at `referenceHz`. */
  readonly cents: number;
  /** 0..1: the resultant length. 1 when every peak agrees, near 0 when they are spread around the semitone. */
  readonly strength: number;
}

/** The energy-weighted circular mean of the peaks' deviation from the nearest semitone. */
export function estimateTuning(peaks: SpectralPeaks, referenceHz: number): TuningEstimate {
  let x = 0;
  let y = 0;
  let total = 0;
  for (let index = 0; index < peaks.count; index += 1) {
    const pitch = midiOf(peaks.frequency[index] as number, referenceHz);
    const angle = 2 * Math.PI * (pitch - Math.round(pitch));
    const energy = peaks.energy[index] as number;
    x += energy * Math.cos(angle);
    y += energy * Math.sin(angle);
    total += energy;
  }
  if (total <= 0) return { cents: 0, strength: 0 };
  return { cents: (Math.atan2(y, x) / (2 * Math.PI)) * 100, strength: Math.hypot(x, y) / total };
}

/**
 * Folds the peaks into `out` (twelve energies, C = 0), against a grid `tuningCents` away
 * from `referenceHz`. A peak on a class centre gives that class all its energy; a peak a
 * quarter tone off gives nothing to anyone, because it belongs to no class.
 */
export function foldChroma(peaks: SpectralPeaks, referenceHz: number, tuningCents: number, out: Float64Array): Float64Array {
  out.fill(0);
  for (let index = 0; index < peaks.count; index += 1) {
    const pitch = midiOf(peaks.frequency[index] as number, referenceHz) - tuningCents / 100;
    const nearest = Math.round(pitch);
    const weight = Math.cos(Math.PI * (pitch - nearest));
    const pitchClass = ((nearest % 12) + 12) % 12;
    out[pitchClass] = (out[pitchClass] as number) + (peaks.energy[index] as number) * weight * weight;
  }
  return out;
}

/**
 * Energies → the profile a consumer reads: `sqrt(E / E_max)`, so the strongest class is 1
 * whenever anything folded and the rest are amplitude ratios against it. Loudness is not in
 * it on purpose: `level` and the bands carry loudness. All zeros when nothing folded.
 */
export function chromaProfile(energies: Float64Array, out: Float64Array): Float64Array {
  let strongest = 0;
  for (let index = 0; index < 12; index += 1) strongest = Math.max(strongest, energies[index] as number);
  for (let index = 0; index < 12; index += 1) out[index] = strongest > 0 ? Math.sqrt((energies[index] as number) / strongest) : 0;
  return out;
}

/**
 * How concentrated the folded energy is: the share the four strongest classes hold, mapped
 * from one third (twelve equal classes) at 0 to `full` at 1. Four classes or fewer holding
 * everything is exactly 1, which is what a tone, an interval and a triad without partials do.
 */
export function chromaConfidence(energies: Float64Array, full: number): number {
  let total = 0;
  const top = [0, 0, 0, 0];
  for (let index = 0; index < 12; index += 1) {
    let value = energies[index] as number;
    total += value;
    for (let slot = 0; slot < 4; slot += 1) {
      if (value > (top[slot] as number)) {
        const displaced = top[slot] as number;
        top[slot] = value;
        value = displaced;
      }
    }
  }
  if (total <= 0) return 0;
  const share = ((top[0] as number) + (top[1] as number) + (top[2] as number) + (top[3] as number)) / total;
  const mapped = (share - 1 / 3) / (full - 1 / 3);
  return mapped <= 0 ? 0 : mapped >= 1 ? 1 : mapped;
}
