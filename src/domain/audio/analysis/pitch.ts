/**
 * T1755b — LEAD PITCH: the one note a single voice or instrument is playing, quickly, and
 * no claim when there is not one.
 *
 * ## The method: McLeod and Wyvill's (MPM), on the hop window
 *
 * The normalised square difference function of a window, `n(τ) = 2·r(τ) / m(τ)` — the
 * autocorrelation `r` over the energy `m` of the two overlapping stretches — is 1 at a lag
 * the signal repeats at exactly, whatever its loudness. The pitch is the FIRST lag whose
 * peak comes within `PITCH_PEAK_SHARE` of the highest one (the first, not the highest: the
 * highest is as often two periods as one), refined by a parabola through the peak.
 *
 * `r` is computed by FFT (two transforms of twice the window), not by the definition: the
 * direct sum measured 926 µs per call at this window, 8.7 % of the audio thread at hop
 * rate. pYIN was not taken: its decode is a batch over many candidates per frame, and what
 * it buys (no octave blips, honest voicing) a three-reading median and the clarity give here.
 *
 * ## Clarity is the confidence — and it is NOT enough on its own
 *
 * The height of the chosen peak is how periodic the window is: 1 for a tone, low for noise
 * and for a dissonant cluster. Below `PITCH_CLARITY` there is NO CLAIM: pitch 0 at
 * confidence 0 (§T1227's contract).
 *
 * But a CONSONANT interval is periodic too. A fifth is 2:3 and repeats at the octave below
 * its lower note; a major triad is 4:5:6 and repeats two octaves below its root. Measured:
 * a fifth reads a clarity of 0.9996 and a major triad at C4 0.97, against 0.99 for one
 * note with a little noise on it — so clarity alone would publish, with full confidence, a
 * note nobody is playing (the design said a chord reads no pitch; the first real chord
 * through the worklet said otherwise). What tells them apart is the FUNDAMENTAL: that
 * phantom note has no energy at its own frequency, only at multiples of it. So a reading
 * also needs its first partial to hold at least `PITCH_FUNDAMENTAL_SHARE` of the power of
 * its strongest one, read off the spectrum the autocorrelation already computed.
 *
 * The cost of that guard, stated: a single instrument whose fundamental is far weaker than
 * its partials (the lowest octave of a piano, a bassoon's bottom notes, anything played
 * through a small speaker) reads no pitch. No claim is the honest failure; a phantom is not.
 * Two notes an octave apart read as the lower one, which is the pitch class either way.
 *
 * ## The tracker
 *
 * `pitchTracker` turns readings into a note: the median of the last three voiced
 * readings (one octave blip cannot move it), and an ONSET when a claim begins or when the
 * pitch has left the note it was on by more than `PITCH_ONSET_SEMITONES` for two readings.
 */
import { fftInPlace } from "./stft.ts";

/** A peak this share of the highest is "the first peak": McLeod's k. */
export const PITCH_PEAK_SHARE = 0.93;
/** Under this clarity a window has no single pitch. */
export const PITCH_CLARITY = 0.9;
/**
 * The power at the claimed fundamental, over the power of its strongest partial, under which
 * the "pitch" is the common period of several notes and not a note. −10 dB: over what the
 * neighbouring partial leaks into an empty fundamental (about −16 dB at the lowest pitches).
 */
export const PITCH_FUNDAMENTAL_SHARE = 0.1;
/** Partials read for that test. */
const PITCH_PARTIALS = 10;
/** The highest pitch looked for. Above it a period is under 24 samples at 48 kHz and a semitone is a sample and a half. */
export const PITCH_MAX_HZ = 2000;
/** A window under this mean square (−70 dBFS) is silence. */
export const PITCH_SILENCE_MEAN_SQUARE = 1e-7;
/** A lead that moves this far from the note it was on, and stays, has started another note. */
export const PITCH_ONSET_SEMITONES = 0.8;

export interface PitchReading {
  /** Hz; 0 with no claim. */
  readonly frequency: number;
  /** 0..1: the chosen peak's height. 0 with no claim. */
  readonly clarity: number;
}

export interface PitchDetector {
  /** One window of `windowSize` samples. */
  detect(samples: ArrayLike<number>): PitchReading;
  /** The lowest pitch this window can hold two periods of. */
  readonly minHz: number;
}

const NO_PITCH: PitchReading = { frequency: 0, clarity: 0 };

export function pitchDetector(options: { readonly sampleRate: number; readonly windowSize: number }): PitchDetector {
  const { sampleRate, windowSize } = options;
  if (!(windowSize > 0) || (windowSize & (windowSize - 1)) !== 0) {
    throw new Error(`pitchDetector: windowSize must be a power of two, got ${windowSize}`);
  }
  const padded = windowSize * 2;
  const real = new Float64Array(padded);
  const imag = new Float64Array(padded);
  const nsdf = new Float64Array(windowSize / 2 + 1);
  /** The power spectrum of the padded window, kept for the fundamental test. */
  const power = new Float64Array(windowSize + 1);
  const binHz = sampleRate / padded;
  /** The strongest of the three bins round partial `h` of `frequency`; 0 past Nyquist. */
  const partialPower = (frequency: number, h: number): number => {
    const bin = Math.round((frequency * h) / binHz);
    if (bin + 1 > windowSize) return 0;
    return Math.max(power[bin - 1] as number, power[bin] as number, power[bin + 1] as number);
  };
  const maxLag = windowSize / 2;
  const minLag = Math.max(2, Math.floor(sampleRate / PITCH_MAX_HZ));

  return {
    minHz: sampleRate / maxLag,
    detect(samples) {
      if (samples.length !== windowSize) throw new Error(`pitch detector: expected ${windowSize} samples, got ${samples.length}`);
      let energy = 0;
      for (let i = 0; i < windowSize; i += 1) {
        const sample = samples[i] as number;
        real[i] = sample;
        energy += sample * sample;
      }
      if (energy / windowSize < PITCH_SILENCE_MEAN_SQUARE) return NO_PITCH;
      // Autocorrelation by FFT: transform the zero-padded window, take its power, transform
      // again. The power spectrum is real and even, so the second forward transform IS the
      // inverse, times the length.
      real.fill(0, windowSize);
      imag.fill(0);
      fftInPlace(real, imag);
      for (let bin = 0; bin < padded; bin += 1) {
        real[bin] = (real[bin] as number) * (real[bin] as number) + (imag[bin] as number) * (imag[bin] as number);
        imag[bin] = 0;
        if (bin <= windowSize) power[bin] = real[bin] as number;
      }
      fftInPlace(real, imag);
      // m(τ) = Σ x[j]² + x[j+τ]² over the overlap, by taking one sample off each end per lag.
      let m = 2 * energy;
      nsdf[0] = 1;
      for (let lag = 1; lag <= maxLag; lag += 1) {
        const head = samples[lag - 1] as number;
        const tail = samples[windowSize - lag] as number;
        m -= head * head + tail * tail;
        nsdf[lag] = m > 0 ? (2 * (real[lag] as number)) / padded / m : 0;
      }

      // Key maxima: the highest point of each positive stretch after the first zero crossing.
      let lag = 1;
      while (lag <= maxLag && (nsdf[lag] as number) > 0) lag += 1;
      let highest = 0;
      const peaks: number[] = [];
      while (lag < maxLag) {
        while (lag < maxLag && (nsdf[lag] as number) <= 0) lag += 1;
        let peak = -1;
        while (lag < maxLag && (nsdf[lag] as number) > 0) {
          if (peak < 0 || (nsdf[lag] as number) > (nsdf[peak] as number)) peak = lag;
          lag += 1;
        }
        // A stretch still rising at the last lag has no maximum inside the window.
        if (peak >= minLag && peak < maxLag && (lag < maxLag || (nsdf[peak + 1] as number) < (nsdf[peak] as number))) {
          peaks.push(peak);
          highest = Math.max(highest, nsdf[peak] as number);
        }
      }
      for (const peak of peaks) {
        if ((nsdf[peak] as number) < PITCH_PEAK_SHARE * highest) continue;
        const a = nsdf[peak - 1] as number;
        const b = nsdf[peak] as number;
        const c = nsdf[peak + 1] as number;
        const curvature = a - 2 * b + c;
        const offset = curvature < 0 ? (0.5 * (a - c)) / curvature : 0;
        const clarity = Math.min(1, b - 0.25 * (a - c) * offset);
        if (clarity < PITCH_CLARITY) return NO_PITCH;
        const frequency = sampleRate / (peak + offset);
        // A note sounds at its own frequency. A common period of several notes does not.
        let strongest = 0;
        for (let h = 1; h <= PITCH_PARTIALS; h += 1) strongest = Math.max(strongest, partialPower(frequency, h));
        return partialPower(frequency, 1) < PITCH_FUNDAMENTAL_SHARE * strongest ? NO_PITCH : { frequency, clarity };
      }
      return NO_PITCH;
    },
  };
}

export interface PitchFrame {
  /** A fractional MIDI note number (69 is A = 440 Hz); 0 with no claim. */
  readonly pitch: number;
  /** The clarity of the reading the pitch came from; 0 is NO CLAIM. */
  readonly confidence: number;
  /** A note began on this reading. */
  readonly onset: boolean;
}

export interface PitchTracker {
  push(reading: PitchReading): PitchFrame;
}

const NO_FRAME: PitchFrame = { pitch: 0, confidence: 0, onset: false };

/** Readings in, the note out: a three-reading median, and where a note begins. */
export function pitchTracker(): PitchTracker {
  /** The last voiced readings as MIDI numbers, newest last; cleared when the claim ends. */
  let recent: number[] = [];
  /** The pitch of the note in progress, or null with none. */
  let note: number | null = null;
  /** Consecutive readings away from `note`. */
  let away = 0;
  return {
    push(reading) {
      if (reading.frequency <= 0) {
        recent = [];
        note = null;
        away = 0;
        return NO_FRAME;
      }
      recent.push(69 + 12 * Math.log2(reading.frequency / 440));
      if (recent.length > 3) recent.shift();
      const sorted = [...recent].sort((a, b) => a - b);
      const pitch = sorted[(sorted.length - 1) >> 1] as number;
      let onset = false;
      if (note === null) {
        note = pitch;
        onset = true;
      } else if (Math.abs(pitch - note) > PITCH_ONSET_SEMITONES) {
        away += 1;
        if (away >= 2) {
          note = pitch;
          away = 0;
          onset = true;
        }
      } else {
        away = 0;
      }
      return { pitch, confidence: reading.clarity, onset };
    },
  };
}

export interface LeadPitchFrame extends PitchFrame {
  /** Seconds between the sound and this reading: half the window, plus the median's one reading. */
  readonly lag: number;
}

export interface LeadPitch {
  /** One hop's window. Returns a reading on the hops it reads, null on the ones it skips. */
  push(window: ArrayLike<number>): LeadPitchFrame | null;
}

/**
 * The detector and the tracker on a hop grid: the one object the worklet, the polled
 * fallback and the offline walk each hold, so the lead pitch is the same code on every path.
 * `hop` is the samples between two pushes; it reads every `everyHops`-th.
 */
export function createLeadPitch(options: { readonly sampleRate: number; readonly windowSize: number; readonly hop: number; readonly everyHops: number }): LeadPitch {
  const detector = pitchDetector(options);
  const tracker = pitchTracker();
  const every = Math.max(1, Math.floor(options.everyHops));
  const lag = (options.windowSize / 2 + every * options.hop) / options.sampleRate;
  let hops = 0;
  return {
    push(window) {
      const reads = hops % every === 0;
      hops += 1;
      return reads ? { ...tracker.push(detector.detect(window)), lag } : null;
    },
  };
}
