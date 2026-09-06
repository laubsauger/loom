/**
 * T1229 — whole-track tempo and beat tracking, Ellis-style dynamic programming.
 *
 * The live doors (T1228) can DECLARE a tempo or pass a record's claim through; nothing
 * in the repo ESTIMATED one, because a live estimator has to commit without seeing the
 * future. Offline it can see all of it, which is what makes Ellis's method the right
 * one here: it is a global optimisation over the whole onset envelope, not a phase lock
 * that trails the music.
 *
 * Reference: D. Ellis, "Beat Tracking by Dynamic Programming", J. New Music Research
 * 36(1), 2007. The constants are librosa's port of it (`beat_track`: tightness 100, a
 * log-Gaussian tempo prior one octave wide around 120 BPM, the local score smoothed by
 * a Gaussian of width period/32), stated here as FIRST VALUES rather than tuned.
 *
 * Three steps, each pure and separately testable:
 *
 *  1. TEMPO — the autocorrelation of the onset envelope over the lags of 40..240 BPM,
 *     weighted by the prior; the best lag is refined by parabolic interpolation so the
 *     period is not quantised to the hop grid (at 93.75 hops/s an integer lag is a 2%
 *     step near 120 BPM).
 *  2. BEATS — Ellis's recursion: `C(t) = O(t) + α · max_τ [ −(log(τ/P))² + C(t−τ) ]`,
 *     back-tracked from the last strong cumulative score.
 *  3. BAR — a guess, and reported as one: for 3 and 4 beats per bar, which beat phase
 *     carries the most onset weight; the contrast between phases is the confidence.
 *
 * Every value is derivable on a synthetic click train (`tempo.test.ts`): a train at an
 * integer hop period yields that period exactly, the beats land on the click hops, and
 * an accent every fourth click makes the bar 4 with the downbeat on the accent.
 */

export interface TempoEstimate {
  /** Period in hops, fractional after interpolation; 0 when no estimate could be made. */
  readonly periodHops: number;
  /** 60 · hopRate / periodHops; 0 without an estimate. */
  readonly bpm: number;
  /**
   * 0..1, STRICTLY below 1 (`AudioFeatures.bpmConfidence`: 1 means declared). One minus
   * the mean POSITIVE weighted autocorrelation over the candidate lags divided by its
   * peak — a periodic train leaves most lags near zero and scores high, noise leaves
   * them level with the peak and scores near zero.
   */
  readonly confidence: number;
}

export interface BeatTrack {
  readonly tempo: TempoEstimate;
  /** Beat positions as hop indices into the envelope, ascending. Empty without a tempo. */
  readonly beats: readonly number[];
}

export interface BarEstimate {
  /** 3 or 4; 0 when there are too few beats to say. */
  readonly beatsPerBar: number;
  /** Index into `beats` of the first downbeat; −1 without a bar. */
  readonly downbeat: number;
  /** 0..1 — the phase contrast the guess rests on; 0 means the beats are all alike. */
  readonly confidence: number;
}

export interface TempoOptions {
  /** Hops per second of the envelope. */
  readonly hopRate: number;
  readonly minBpm?: number;
  readonly maxBpm?: number;
  /** Centre of the log-Gaussian prior, BPM. */
  readonly priorBpm?: number;
  /** Width of the prior in octaves. */
  readonly priorOctaves?: number;
  /** Ellis's α: how strongly a beat interval is held to the period. */
  readonly tightness?: number;
}

const DEFAULTS = {
  minBpm: 40,
  maxBpm: 240,
  priorBpm: 120,
  priorOctaves: 1,
  tightness: 100,
};

function standardDeviation(values: ArrayLike<number>): number {
  const n = values.length;
  if (n < 2) return 0;
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += values[i] as number;
  mean /= n;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    const d = (values[i] as number) - mean;
    sum += d * d;
  }
  return Math.sqrt(sum / (n - 1));
}

/**
 * Step 1. The envelope's autocorrelation at every candidate lag, weighted by the prior;
 * the peak, refined to a fractional lag by fitting a parabola through its neighbours.
 */
export function estimateTempo(envelope: ArrayLike<number>, options: TempoOptions): TempoEstimate {
  const { hopRate } = options;
  const minBpm = options.minBpm ?? DEFAULTS.minBpm;
  const maxBpm = options.maxBpm ?? DEFAULTS.maxBpm;
  const priorBpm = options.priorBpm ?? DEFAULTS.priorBpm;
  const priorOctaves = options.priorOctaves ?? DEFAULTS.priorOctaves;
  if (!(hopRate > 0) || !(minBpm > 0) || !(maxBpm > minBpm)) {
    throw new Error(`estimateTempo: bad options ${JSON.stringify(options)}`);
  }
  const none: TempoEstimate = { periodHops: 0, bpm: 0, confidence: 0 };
  const n = envelope.length;
  const minLag = Math.max(1, Math.round((60 * hopRate) / maxBpm));
  const maxLag = Math.round((60 * hopRate) / minBpm);
  if (n <= maxLag + 1) return none;

  // Mean removed so a DC offset (a constant noise floor) does not dominate every lag.
  let mean = 0;
  for (let i = 0; i < n; i += 1) mean += envelope[i] as number;
  mean /= n;
  const centred = new Float64Array(n);
  let energy = 0;
  for (let i = 0; i < n; i += 1) {
    const value = (envelope[i] as number) - mean;
    centred[i] = value;
    energy += value * value;
  }
  // Nothing left after the mean: silence, or a flat floor whose residue is rounding.
  if (energy <= Number.EPSILON * n * mean * mean) return none;

  // Weighted autocorrelation over [minLag − 1, maxLag + 1] so the peak's neighbours exist.
  const first = Math.max(1, minLag - 1);
  const last = maxLag + 1;
  const raw = new Float64Array(last - first + 1);
  const weighted = new Float64Array(last - first + 1);
  const priorCentreLag = (60 * hopRate) / priorBpm;
  for (let lag = first; lag <= last; lag += 1) {
    let sum = 0;
    for (let i = lag; i < n; i += 1) sum += (centred[i] as number) * (centred[i - lag] as number);
    const octaves = Math.log2(lag / priorCentreLag) / priorOctaves;
    raw[lag - first] = sum / energy;
    weighted[lag - first] = (sum / energy) * Math.exp(-0.5 * octaves * octaves);
  }

  let bestLag = minLag;
  let best = -Infinity;
  let total = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = weighted[lag - first] as number;
    // Positive part only: the mean then includes the peak itself, so it is at least
    // peak / lags and the confidence is at most 1 − 1/lags — never the declared 1.
    total += Math.max(0, value);
    if (value > best) {
      best = value;
      bestLag = lag;
    }
  }
  if (!(best > 0)) return none;

  // Parabolic refinement through the peak's two neighbours — on the UNWEIGHTED
  // autocorrelation, so the prior chooses the lag and only the data places the vertex
  // (the prior's slope would otherwise pull every peak toward 120 BPM by a fraction).
  let offset = 0;
  if (bestLag - 1 >= first && bestLag + 1 <= last) {
    const left = raw[bestLag - 1 - first] as number;
    const centre = raw[bestLag - first] as number;
    const right = raw[bestLag + 1 - first] as number;
    const denominator = left - 2 * centre + right;
    if (denominator < 0) offset = Math.max(-0.5, Math.min(0.5, (0.5 * (left - right)) / denominator));
  }
  const periodHops = bestLag + offset;

  const meanOverLags = total / (maxLag - minLag + 1);
  const confidence = Math.max(0, Math.min(1, 1 - meanOverLags / best));
  return { periodHops, bpm: (60 * hopRate) / periodHops, confidence };
}

/**
 * Step 2. Ellis's dynamic programme on the envelope, given a period.
 *
 * The local score is the envelope, normalised by its standard deviation and smoothed
 * by a Gaussian of width `period / 32` (so a beat a hop off the onset still scores).
 * The recursion looks back over [period/2, 2·period] hops with the log-ratio penalty,
 * and the beats are read back from the last cumulative-score maximum that is at least
 * half the median of all maxima — Ellis's rule for not trailing off into a fade-out.
 */
export function trackBeats(envelope: ArrayLike<number>, periodHops: number, tightness = DEFAULTS.tightness): number[] {
  const n = envelope.length;
  if (!(periodHops >= 1) || n === 0) return [];
  const period = periodHops;

  const deviation = standardDeviation(envelope);
  if (!(deviation > 0)) return [];
  const half = Math.round(period);
  const sigma = period / 32;
  const localScore = new Float64Array(n);
  for (let i = 0; i < n; i += 1) {
    let sum = 0;
    for (let k = -half; k <= half; k += 1) {
      const j = i + k;
      if (j < 0 || j >= n) continue;
      const weight = Math.exp(-0.5 * (k / sigma) * (k / sigma));
      sum += ((envelope[j] as number) / deviation) * weight;
    }
    localScore[i] = sum;
  }

  const windowStart = -Math.round(2 * period);
  const windowEnd = -Math.round(period / 2);
  const windowSize = windowEnd - windowStart + 1;
  const transition = new Float64Array(windowSize);
  for (let w = 0; w < windowSize; w += 1) {
    const lag = -(windowStart + w);
    const ratio = Math.log(lag / period);
    transition[w] = -tightness * ratio * ratio;
  }

  const cumulative = new Float64Array(n);
  const backlink = new Int32Array(n).fill(-1);
  let localMax = 0;
  for (let i = 0; i < n; i += 1) localMax = Math.max(localMax, localScore[i] as number);
  let firstBeat = true;
  for (let i = 0; i < n; i += 1) {
    let bestScore = -Infinity;
    let bestLag = 0;
    for (let w = 0; w < windowSize; w += 1) {
      const j = i + windowStart + w;
      // A predecessor before time 0 carries the transition weight alone, as in the reference.
      const candidate = (transition[w] as number) + (j >= 0 ? (cumulative[j] as number) : 0);
      if (candidate > bestScore) {
        bestScore = candidate;
        bestLag = windowStart + w;
      }
    }
    cumulative[i] = (localScore[i] as number) + bestScore;
    if (firstBeat && (localScore[i] as number) < 0.01 * localMax) {
      backlink[i] = -1;
    } else {
      const j = i + bestLag;
      backlink[i] = j >= 0 ? j : -1;
      firstBeat = false;
    }
  }

  // The last strong local maximum of the cumulative score.
  const maxima: number[] = [];
  for (let i = 0; i < n; i += 1) {
    const value = cumulative[i] as number;
    const before = i > 0 ? (cumulative[i - 1] as number) : -Infinity;
    const after = i < n - 1 ? (cumulative[i + 1] as number) : -Infinity;
    if (value >= before && value > after) maxima.push(i);
  }
  if (maxima.length === 0) return [];
  const sorted = maxima.map((i) => cumulative[i] as number).sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  let tail = -1;
  for (const i of maxima) if ((cumulative[i] as number) >= 0.5 * median) tail = i;
  if (tail < 0) return [];

  const beats: number[] = [];
  for (let i = tail; i >= 0; i = backlink[i] as number) beats.push(i);
  beats.reverse();

  // The programme keeps the grid through silence at either end — a beat at hop 0 before
  // the first sound, because a step of one period back from the first click costs nothing.
  // The reference trims those (librosa's `__trim_beats`); here a beat at the ends that has
  // no more local score than the first-beat rule allows is not a beat.
  const floor = 0.01 * localMax;
  let first = 0;
  while (first < beats.length && (localScore[beats[first] as number] as number) < floor) first += 1;
  let last = beats.length;
  while (last > first && (localScore[beats[last - 1] as number] as number) < floor) last -= 1;
  return beats.slice(first, last);
}

/** Steps 1 and 2 together. */
export function beatTrack(envelope: ArrayLike<number>, options: TempoOptions): BeatTrack {
  const tempo = estimateTempo(envelope, options);
  if (tempo.periodHops === 0) return { tempo, beats: [] };
  return { tempo, beats: trackBeats(envelope, tempo.periodHops, options.tightness ?? DEFAULTS.tightness) };
}

/**
 * Step 3. Which beat phase carries the accents, for 3 and for 4 beats per bar.
 *
 * The weight of a beat is the envelope at its hop. For each candidate bar length the
 * phases' mean weights are compared: the contrast `(max − mean) / mean` is how much the
 * strongest phase stands out, and the bar length with the larger contrast wins. Beats
 * that are all alike give contrast 0 for both — no bar, and the number says so.
 */
export function estimateBar(envelope: ArrayLike<number>, beats: readonly number[]): BarEstimate {
  const none: BarEstimate = { beatsPerBar: 0, downbeat: -1, confidence: 0 };
  let best = none;
  for (const beatsPerBar of [3, 4]) {
    // At least two full bars, or a phase can win on a single beat.
    if (beats.length < 2 * beatsPerBar) continue;
    const sums = new Float64Array(beatsPerBar);
    const counts = new Uint32Array(beatsPerBar);
    beats.forEach((hop, index) => {
      const phase = index % beatsPerBar;
      sums[phase] = (sums[phase] as number) + (envelope[hop] as number);
      counts[phase] = (counts[phase] as number) + 1;
    });
    let total = 0;
    let strongest = 0;
    let strongestPhase = 0;
    for (let phase = 0; phase < beatsPerBar; phase += 1) {
      const mean = (sums[phase] as number) / (counts[phase] as number);
      total += mean;
      if (mean > strongest) {
        strongest = mean;
        strongestPhase = phase;
      }
    }
    const mean = total / beatsPerBar;
    if (!(mean > 0)) continue;
    const contrast = Math.max(0, Math.min(1, (strongest - mean) / mean));
    if (contrast > best.confidence) {
      best = { beatsPerBar, downbeat: strongestPhase, confidence: contrast };
    }
  }
  return best;
}
