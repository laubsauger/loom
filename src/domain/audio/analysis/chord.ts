/**
 * T1753b — CHORD AND KEY from pitch classes: claims that change at musical rates, with a
 * confidence, and nothing when there is nothing to claim.
 *
 * ## One mechanism, twice: a sticky decode
 *
 * A frame's best-matching triad flickers. Between two chords it is briefly a third one; on
 * a drum hit it is anything. What a listener calls "the chord" is the state that EXPLAINS
 * A STRETCH of frames, and the cost of changing one's mind is what makes it a stretch. So
 * both estimates are the same small hidden-Markov decode: each state scores every frame,
 * staying is free, and switching costs `penalty` (in score × seconds, so it means the same
 * on any frame grid).
 *
 *  - LIVE it runs forward only (`stickyDecoder`): the reported state is where the
 *    best path is NOW. A new chord is reported once it has out-scored the old one by the
 *    penalty, which is the lag: a few tenths of a second, longer for chords that share notes.
 *  - With the WHOLE FILE in hand it is Viterbi (`stickyPath`): the same scores and the same
 *    penalty, but the path is chosen knowing what follows, so the boundary lands on the
 *    change itself.
 *
 * ## Chord: triads and "none"
 *
 * 25 states. A triad's score is the cosine between the chroma profile and its three
 * classes (`triads.ts` has the keyboard's form of the same match), times the chroma
 * confidence — so noise, whose best triad is as good as any, scores a tenth of what music
 * does. "None" scores a constant that silence and noise fall under and music clears.
 * Major and minor only: a seventh shares three of four notes with a triad and mostly
 * becomes flicker between neighbours.
 *
 * The published CONFIDENCE is not the state's score but its lead: how far it stays ahead
 * of the best other triad, averaged over half a second, with a lead of a quarter reading
 * as 1 (a clean triad leads by a third). A single note or a bare fifth leads nothing, so
 * it is no claim: confidence 0, root and quality 0 (§T1227's contract).
 *
 * ## Key: profile correlation over a long window
 *
 * Temperley's key profiles, correlated against the average of the recent pitch
 * classes (weighted by their confidence), decoded stickily at a far larger penalty: a key
 * is a slow fact and says so. Its confidence is its lead over the next key, and grows with
 * the amount of music heard, so the first seconds claim little.
 */
import { TRIAD_FULL_MARGIN, TRIAD_MAJOR, TRIAD_MINOR, TRIAD_NONE } from "../triads.ts";

// ---------------------------------------------------------------------------------------------
// The sticky decode
// ---------------------------------------------------------------------------------------------

export interface StickyDecoder {
  /** One frame's scores (one per state) over `seconds`. Returns the state the best path is in now. */
  push(scores: ArrayLike<number>, seconds: number): number;
}

/**
 * Forward-only. `initial` is the state it starts in (and returns to on a tie it cannot
 * otherwise break: the state it is already in wins a tie, so equal evidence changes nothing).
 */
export function stickyDecoder(states: number, penalty: number, initial = 0): StickyDecoder {
  const best = new Float64Array(states).fill(-penalty);
  best[initial] = 0;
  let current = initial;
  return {
    push(scores, seconds) {
      let top = -Infinity;
      for (let state = 0; state < states; state += 1) top = Math.max(top, best[state] as number);
      const entry = top - penalty;
      let leader = current;
      let leaderValue = -Infinity;
      for (let state = 0; state < states; state += 1) {
        const value = Math.max(best[state] as number, entry) + (scores[state] as number) * seconds;
        best[state] = value;
        if (value > leaderValue) {
          leaderValue = value;
          leader = state;
        }
      }
      // The state it is in keeps a tie.
      if ((best[current] as number) < leaderValue) current = leader;
      // Only differences matter: keep the numbers near zero over an hour of frames.
      for (let state = 0; state < states; state += 1) best[state] = (best[state] as number) - leaderValue;
      return current;
    },
  };
}

/**
 * Viterbi over every frame: the path that maximises the summed scores less `penalty` per
 * switch. `scores` is `frames × states`, row-major; `seconds[frame]` is that frame's weight.
 */
export function stickyPath(scores: Float64Array, states: number, seconds: ArrayLike<number>, penalty: number, initial = 0): Int32Array {
  const frames = seconds.length;
  const path = new Int32Array(frames);
  if (frames === 0) return path;
  const best = new Float64Array(states).fill(-penalty);
  best[initial] = 0;
  /** Per frame and state: the state it came from. */
  const from = new Int32Array(frames * states);
  for (let frame = 0; frame < frames; frame += 1) {
    let top = 0;
    for (let state = 1; state < states; state += 1) if ((best[state] as number) > (best[top] as number)) top = state;
    const entry = (best[top] as number) - penalty;
    for (let state = 0; state < states; state += 1) {
      const stay = best[state] as number;
      from[frame * states + state] = stay >= entry ? state : top;
      best[state] = Math.max(stay, entry) + (scores[frame * states + state] as number) * (seconds[frame] as number);
    }
  }
  let state = 0;
  for (let candidate = 1; candidate < states; candidate += 1) if ((best[candidate] as number) > (best[state] as number)) state = candidate;
  for (let frame = frames - 1; frame >= 0; frame -= 1) {
    path[frame] = state;
    state = from[frame * states + state] as number;
  }
  return path;
}

// ---------------------------------------------------------------------------------------------
// Chord
// ---------------------------------------------------------------------------------------------

/** State 0 is none; a triad is `1 + 2 · root + (quality − 1)`. */
export const CHORD_STATES = 25;
export const CHORD_NONE_STATE = 0;
/** What "no chord" scores: over noise (about 0.1) and silence (0), under any two notes of a triad (0.8 at full confidence). */
export const CHORD_NONE_SCORE = 0.35;
/** The cost of changing chord, in score × seconds. FIRST VALUE: about 0.2 s for an unrelated chord, 0.4 s for one sharing two notes. */
export const CHORD_PENALTY = 0.12;
/** The time over which a chord's lead is averaged into its confidence. */
export const CHORD_CONFIDENCE_SECONDS = 0.5;

export const chordStateOf = (root: number, quality: number): number => (quality === TRIAD_NONE ? CHORD_NONE_STATE : 1 + 2 * root + (quality - 1));
export const chordRootOf = (state: number): number => (state === CHORD_NONE_STATE ? 0 : (state - 1) >> 1);
export const chordQualityOf = (state: number): number => (state === CHORD_NONE_STATE ? TRIAD_NONE : ((state - 1) & 1) === 0 ? TRIAD_MAJOR : TRIAD_MINOR);

/** One frame's 25 scores from its chroma profile and confidence. */
export function chordScores(profile: ArrayLike<number>, confidence: number, out: Float64Array, offset = 0): void {
  let norm = 0;
  for (let index = 0; index < 12; index += 1) norm += (profile[index] as number) * (profile[index] as number);
  out[offset] = CHORD_NONE_SCORE;
  const scale = norm > 0 ? confidence / Math.sqrt(3 * norm) : 0;
  for (let root = 0; root < 12; root += 1) {
    const fifth = profile[(root + 7) % 12] as number;
    out[offset + 1 + 2 * root] = ((profile[root] as number) + (profile[(root + 4) % 12] as number) + fifth) * scale;
    out[offset + 2 + 2 * root] = ((profile[root] as number) + (profile[(root + 3) % 12] as number) + fifth) * scale;
  }
}

/** A triad state's lead over the best OTHER triad in one frame's scores; 0 for none. */
export function chordLead(scores: ArrayLike<number>, state: number, offset = 0): number {
  if (state === CHORD_NONE_STATE) return 0;
  let other = -Infinity;
  for (let candidate = 1; candidate < CHORD_STATES; candidate += 1) {
    if (candidate !== state) other = Math.max(other, scores[offset + candidate] as number);
  }
  return (scores[offset + state] as number) - other;
}

export interface ChordClaim {
  /** 0..11, C = 0; 0 with no claim. */
  readonly root: number;
  /** 0 none, 1 major, 2 minor. */
  readonly quality: number;
  /** 0 is NO CLAIM. */
  readonly confidence: number;
  /** This frame's claim differs from the last one (a new chord, or a claim beginning or ending). */
  readonly changed: boolean;
  /** Seconds the present claim has held; 0 with none. */
  readonly age: number;
}

export interface ChordEstimator {
  push(profile: ArrayLike<number>, confidence: number, seconds: number): ChordClaim;
}

/** A lead this small is no claim: it is what is left of a chord long after its notes thinned to one. */
export const CHORD_MIN_CONFIDENCE = 0.02;
/**
 * The confidence a stretch must reach to be claimed at all. Under it the decode's state is
 * a best guess among near-equals (two notes, a passing tone), and a guess is not a claim.
 * Set on ONE piano recording (§T1756b's score): at 0.2 a chord is claimed on 56 % of its
 * frames and names the triad its sounding notes make 79 % of the time; at 0.3, 32 % and
 * 88 %; at 0.45, 8 % and 92 %.
 */
export const CHORD_CLAIM_CONFIDENCE = 0.2;

const confidenceOfLead = (lead: number): number => {
  const value = lead >= TRIAD_FULL_MARGIN ? 1 : lead / TRIAD_FULL_MARGIN;
  return value < CHORD_MIN_CONFIDENCE ? 0 : value;
};

/** The live estimate: the forward decode, its lead eased over half a second, and what changed. */
export function createChordEstimator(): ChordEstimator {
  const decoder = stickyDecoder(CHORD_STATES, CHORD_PENALTY, CHORD_NONE_STATE);
  const scores = new Float64Array(CHORD_STATES);
  let state = CHORD_NONE_STATE;
  let lead = 0;
  let claimed = CHORD_NONE_STATE;
  let age = 0;
  /** Whether the present state has been claimed. Once it has, it stays claimed until the state changes. */
  let claiming = false;
  return {
    push(profile, confidence, seconds) {
      chordScores(profile, confidence, scores);
      const next = decoder.push(scores, seconds);
      // A new state starts its lead from this frame's, not from the old chord's. A frame in
      // which ANOTHER triad leads is the next chord arriving: the decode has not switched yet,
      // and until it does the held chord's lead eases toward nothing rather than below it —
      // so a change is one event (C, then F), not two (C, none, F).
      const now = Math.max(0, chordLead(scores, next));
      lead = next !== state ? now : lead + (now - lead) * (1 - Math.exp(-seconds / CHORD_CONFIDENCE_SECONDS));
      if (next !== state) claiming = false;
      state = next;
      // A CLAIM BELONGS TO THE STRETCH, not the frame. Measured on a piano recording, a chord
      // held for a second and a half had its lead dip to nothing between arpeggiated notes
      // several times, and each dip ended and restarted the claim: 63 change events a minute
      // against 23 changes of chord. So a state is claimed once its lead says so, and stays
      // claimed, at no less than the least confidence, until the decode leaves it.
      if (confidenceOfLead(lead) >= CHORD_CLAIM_CONFIDENCE && state !== CHORD_NONE_STATE) claiming = true;
      const value = claiming ? Math.max(CHORD_MIN_CONFIDENCE, confidenceOfLead(lead)) : 0;
      const claim = claiming ? state : CHORD_NONE_STATE;
      const changed = claim !== claimed;
      age = changed || claim === CHORD_NONE_STATE ? 0 : age + seconds;
      claimed = claim;
      return { root: chordRootOf(claim), quality: chordQualityOf(claim), confidence: claim === CHORD_NONE_STATE ? 0 : value, changed, age };
    },
  };
}

/**
 * The whole-file estimate: Viterbi over every frame's scores, each frame's confidence its
 * lead averaged over the half second centred on it. `profiles` is `frames × 12`.
 */
export function decodeChords(profiles: Float64Array, confidences: ArrayLike<number>, seconds: number): ChordClaim[] {
  const frames = confidences.length;
  const scores = new Float64Array(frames * CHORD_STATES);
  for (let frame = 0; frame < frames; frame += 1) {
    chordScores(profiles.subarray(frame * 12, frame * 12 + 12), confidences[frame] as number, scores, frame * CHORD_STATES);
  }
  const path = stickyPath(scores, CHORD_STATES, new Float64Array(frames).fill(seconds), CHORD_PENALTY, CHORD_NONE_STATE);
  const leads = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) leads[frame] = chordLead(scores, path[frame] as number, frame * CHORD_STATES);
  const reach = Math.max(0, Math.round(CHORD_CONFIDENCE_SECONDS / 2 / seconds));
  // A claim belongs to the STRETCH (see `createChordEstimator`): a run of one state is
  // claimed, whole, when its mean lead says so.
  const runClaimed = new Uint8Array(frames);
  for (let start = 0; start < frames; ) {
    let end = start;
    let total = 0;
    while (end < frames && path[end] === path[start]) {
      total += Math.max(0, leads[end] as number);
      end += 1;
    }
    if (path[start] !== CHORD_NONE_STATE && confidenceOfLead(total / (end - start)) >= CHORD_CLAIM_CONFIDENCE) runClaimed.fill(1, start, end);
    start = end;
  }
  const claims: ChordClaim[] = [];
  let claimed = CHORD_NONE_STATE;
  let age = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    // The centred mean, over frames of the SAME state only: a neighbour chord's lead is not this one's.
    let sum = 0;
    let count = 0;
    for (let other = Math.max(0, frame - reach); other <= Math.min(frames - 1, frame + reach); other += 1) {
      if (path[other] !== path[frame]) continue;
      sum += Math.max(0, leads[other] as number);
      count += 1;
    }
    const value = runClaimed[frame] === 1 ? Math.max(CHORD_MIN_CONFIDENCE, confidenceOfLead(sum / count)) : 0;
    const claim = runClaimed[frame] === 1 ? (path[frame] as number) : CHORD_NONE_STATE;
    const changed = claim !== claimed;
    age = changed || claim === CHORD_NONE_STATE ? 0 : age + seconds;
    claimed = claim;
    claims.push({ root: chordRootOf(claim), quality: chordQualityOf(claim), confidence: claim === CHORD_NONE_STATE ? 0 : value, changed, age });
  }
  return claims;
}

// ---------------------------------------------------------------------------------------------
// Key
// ---------------------------------------------------------------------------------------------

/**
 * Temperley's key profiles (1999, the revision of Krumhansl and Kessler's), from the tonic.
 *
 * Chosen by measurement, over the Krumhansl–Kessler profiles this was first built with. On
 * a piano recording of Debussy's Clair de Lune (D flat major), K–K named the DOMINANT, A
 * flat major, for the piece (0.783 against 0.781) and for half its windows — its known
 * failing: the fifth degree scores nearly as high as the tonic. Temperley's reads D flat
 * major at 0.843 against 0.642 for the next key, and agrees with the key the SCORE's own
 * notes give in the windows where that is clear.
 */
export const KEY_PROFILE_MAJOR = [5.0, 2.0, 3.5, 2.0, 4.5, 4.0, 2.0, 4.5, 2.0, 3.5, 1.5, 4.0] as const;
export const KEY_PROFILE_MINOR = [5.0, 2.0, 3.5, 4.5, 2.0, 4.0, 2.0, 4.5, 3.5, 2.0, 1.5, 4.0] as const;

/** State 0 is none; a key is `1 + 2 · tonic + (mode − 1)`, as a chord's state is. */
export const KEY_STATES = 25;
/** The window a live key is averaged over, and the centred one a file's is. */
export const KEY_SECONDS = 20;
export const KEY_FILE_SECONDS = 30;
/** The cost of changing key, in score × seconds: a key leading by 0.1 takes ten seconds to take over. FIRST VALUE. */
export const KEY_PENALTY = 1;
/** A key's lead over the next key that reads as full confidence. FIRST VALUE. */
export const KEY_FULL_MARGIN = 0.1;
/** Seconds of confident music before a key is claimed at its full confidence. */
export const KEY_EVIDENCE_SECONDS = 5;

/** 25 scores: Pearson's correlation of `average` with each key's rotated profile; none scores 0. Flat input correlates with nothing. */
export function keyScores(average: ArrayLike<number>, out: Float64Array, offset = 0): void {
  let mean = 0;
  for (let index = 0; index < 12; index += 1) mean += (average[index] as number) / 12;
  let variance = 0;
  for (let index = 0; index < 12; index += 1) variance += ((average[index] as number) - mean) ** 2;
  out[offset] = 0;
  for (let tonic = 0; tonic < 12; tonic += 1) {
    for (const [mode, profile] of [
      [0, KEY_PROFILE_MAJOR],
      [1, KEY_PROFILE_MINOR],
    ] as const) {
      let profileMean = 0;
      for (const value of profile) profileMean += value / 12;
      let covariance = 0;
      let profileVariance = 0;
      for (let index = 0; index < 12; index += 1) {
        const p = (profile[index] as number) - profileMean;
        covariance += ((average[(tonic + index) % 12] as number) - mean) * p;
        profileVariance += p * p;
      }
      out[offset + 1 + 2 * tonic + mode] = variance > 1e-12 ? covariance / Math.sqrt(variance * profileVariance) : 0;
    }
  }
}

export interface KeyClaim {
  /** 0..11, C = 0; 0 with no claim. */
  readonly tonic: number;
  /** 0 none, 1 major, 2 minor. */
  readonly mode: number;
  /** 0 is NO CLAIM. */
  readonly confidence: number;
}

export const NO_KEY: KeyClaim = { tonic: 0, mode: 0, confidence: 0 };

function keyClaimOf(scores: ArrayLike<number>, state: number, evidenceSeconds: number, offset = 0): KeyClaim {
  if (state === CHORD_NONE_STATE) return NO_KEY;
  let other = -Infinity;
  for (let candidate = 1; candidate < KEY_STATES; candidate += 1) {
    if (candidate !== state) other = Math.max(other, scores[offset + candidate] as number);
  }
  const lead = (scores[offset + state] as number) - other;
  const confidence = Math.min(1, Math.max(0, lead / KEY_FULL_MARGIN)) * Math.min(1, evidenceSeconds / KEY_EVIDENCE_SECONDS);
  return confidence > 0 ? { tonic: chordRootOf(state), mode: chordQualityOf(state), confidence } : NO_KEY;
}

export interface KeyEstimator {
  /** One frame's pitch classes, how much to believe them (0..1), and how long the frame lasts. */
  push(profile: ArrayLike<number>, weight: number, seconds: number): KeyClaim;
}

/** The live estimate: an average that forgets over `KEY_SECONDS`, decoded forward. */
export function createKeyEstimator(): KeyEstimator {
  const decoder = stickyDecoder(KEY_STATES, KEY_PENALTY, CHORD_NONE_STATE);
  const average = new Float64Array(12);
  const scores = new Float64Array(KEY_STATES);
  let evidence = 0;
  return {
    push(profile, weight, seconds) {
      const keep = Math.exp(-seconds / KEY_SECONDS);
      for (let index = 0; index < 12; index += 1) average[index] = (average[index] as number) * keep + (profile[index] as number) * weight * seconds;
      evidence = evidence * keep + weight * seconds;
      keyScores(average, scores);
      return keyClaimOf(scores, decoder.push(scores, seconds), evidence);
    },
  };
}

/** The whole-file estimate: each frame's key from the `KEY_FILE_SECONDS` centred on it, decoded by Viterbi. */
export function decodeKeys(profiles: Float64Array, confidences: ArrayLike<number>, seconds: number): KeyClaim[] {
  const frames = confidences.length;
  // Prefix sums of the weighted profiles, so every centred window is two subtractions.
  const sums = new Float64Array((frames + 1) * 13);
  for (let frame = 0; frame < frames; frame += 1) {
    const weight = (confidences[frame] as number) * seconds;
    for (let index = 0; index < 12; index += 1) {
      sums[(frame + 1) * 13 + index] = (sums[frame * 13 + index] as number) + (profiles[frame * 12 + index] as number) * weight;
    }
    sums[(frame + 1) * 13 + 12] = (sums[frame * 13 + 12] as number) + weight;
  }
  const reach = Math.round(KEY_FILE_SECONDS / 2 / seconds);
  const scores = new Float64Array(frames * KEY_STATES);
  const evidence = new Float64Array(frames);
  const average = new Float64Array(12);
  for (let frame = 0; frame < frames; frame += 1) {
    const low = Math.max(0, frame - reach);
    const high = Math.min(frames, frame + reach + 1);
    for (let index = 0; index < 12; index += 1) average[index] = (sums[high * 13 + index] as number) - (sums[low * 13 + index] as number);
    evidence[frame] = (sums[high * 13 + 12] as number) - (sums[low * 13 + 12] as number);
    keyScores(average, scores, frame * KEY_STATES);
  }
  const path = stickyPath(scores, KEY_STATES, new Float64Array(frames).fill(seconds), KEY_PENALTY, CHORD_NONE_STATE);
  return Array.from({ length: frames }, (_, frame) => keyClaimOf(scores, path[frame] as number, evidence[frame] as number, frame * KEY_STATES));
}
