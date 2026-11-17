/**
 * T1762b — which TRIAD twelve pitch-class strengths make, if they make one.
 *
 * The matcher the keyboard node uses on its sounding notes, and the emission §T1753b's
 * chord estimate will read from audio: cosine similarity between a chroma PROFILE (each
 * class's strength, as the tonal nodes publish it) and the 24 major and minor triads.
 *
 * It claims only what the classes say. Two notes a third apart fit two triads equally (C
 * and E are in C major and in A minor); `bass` breaks that tie toward the triad rooted on
 * the lowest sounding note, at half confidence. A fifth alone fits a major and a minor
 * triad on the SAME root, a single note fits six triads, and silence fits none: those are
 * no claim — root and quality 0 at confidence 0, the tempo claim's contract (§T1227).
 */
export const TRIAD_NONE = 0;
export const TRIAD_MAJOR = 1;
export const TRIAD_MINOR = 2;

export interface TriadMatch {
  /** 0..11, C = 0. 0 with no claim. */
  readonly root: number;
  /** `TRIAD_NONE`, `TRIAD_MAJOR` or `TRIAD_MINOR`. */
  readonly quality: number;
  /** 0 is NO CLAIM. */
  readonly confidence: number;
}

export const NO_TRIAD: TriadMatch = { root: 0, quality: TRIAD_NONE, confidence: 0 };

/** The winner's lead over the runner-up that reads as full confidence: a clean triad leads by one third. */
export const TRIAD_FULL_MARGIN = 0.25;
/** A tie that the bass note broke is a claim, at this confidence. */
export const TRIAD_TIE_CONFIDENCE = 0.5;
const TIE = 1e-9;

/**
 * `profile` is twelve non-negative strengths, C = 0. `bass` is the pitch class of the lowest
 * sounding note, or undefined when that is not known (audio).
 */
export function matchTriad(profile: ArrayLike<number>, bass?: number): TriadMatch {
  let norm = 0;
  for (let index = 0; index < 12; index += 1) norm += (profile[index] as number) * (profile[index] as number);
  if (norm <= 0) return NO_TRIAD;
  const scale = 1 / Math.sqrt(3 * norm);
  let best = -1;
  let second = -1;
  const tied: Array<{ root: number; quality: number }> = [];
  for (let root = 0; root < 12; root += 1) {
    for (const quality of [TRIAD_MAJOR, TRIAD_MINOR]) {
      const third = quality === TRIAD_MAJOR ? 4 : 3;
      const score = ((profile[root] as number) + (profile[(root + third) % 12] as number) + (profile[(root + 7) % 12] as number)) * scale;
      if (score > best + TIE) {
        second = best;
        best = score;
        tied.length = 0;
        tied.push({ root, quality });
      } else if (score > best - TIE) {
        tied.push({ root, quality });
      } else if (score > second) {
        second = score;
      }
    }
  }
  if (tied.length === 1) {
    const winner = tied[0] as { root: number; quality: number };
    const confidence = Math.min(1, (best - Math.max(0, second)) / TRIAD_FULL_MARGIN);
    return confidence > 0 ? { root: winner.root, quality: winner.quality, confidence } : NO_TRIAD;
  }
  // A tie: only the bass can say, and only if it names exactly one of the tied triads.
  const rooted = bass === undefined ? [] : tied.filter((candidate) => candidate.root === bass);
  if (rooted.length !== 1) return NO_TRIAD;
  const winner = rooted[0] as { root: number; quality: number };
  return { root: winner.root, quality: winner.quality, confidence: TRIAD_TIE_CONFIDENCE };
}
