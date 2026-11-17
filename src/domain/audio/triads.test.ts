import { describe, expect, it } from "vitest";

import { matchTriad, NO_TRIAD, TRIAD_MAJOR, TRIAD_MINOR, TRIAD_TIE_CONFIDENCE } from "./triads.ts";

/** A profile with `value` on each of `classes`. */
const profile = (classes: readonly number[], value = 1): number[] => Array.from({ length: 12 }, (_, index) => (classes.includes(index) ? value : 0));

describe("matchTriad (T1762b)", () => {
  it("names all twenty-four triads from their three classes, at full confidence", () => {
    for (let root = 0; root < 12; root += 1) {
      expect(matchTriad(profile([root, (root + 4) % 12, (root + 7) % 12]))).toEqual({ root, quality: TRIAD_MAJOR, confidence: 1 });
      expect(matchTriad(profile([root, (root + 3) % 12, (root + 7) % 12]))).toEqual({ root, quality: TRIAD_MINOR, confidence: 1 });
    }
  });

  it("does not depend on how loud: the same classes at a tenth the strength are the same triad", () => {
    expect(matchTriad(profile([2, 6, 9], 0.1))).toEqual({ root: 2, quality: TRIAD_MAJOR, confidence: 1 });
  });

  it("a third fits two triads, and only the bass can choose: C under E is C major, at the tie's confidence", () => {
    // C and E are two notes of C major AND of A minor.
    expect(matchTriad(profile([0, 4]))).toEqual(NO_TRIAD);
    expect(matchTriad(profile([0, 4]), 0)).toEqual({ root: 0, quality: TRIAD_MAJOR, confidence: TRIAD_TIE_CONFIDENCE });
    // With E in the bass neither tied triad is rooted there, so nothing is claimed.
    expect(matchTriad(profile([0, 4]), 4)).toEqual(NO_TRIAD);
  });

  it("claims nothing where the quality is unknowable: a fifth, a single note, silence", () => {
    // C and G: C major and C minor fit equally and share the root, so the bass cannot choose.
    expect(matchTriad(profile([0, 7]), 0)).toEqual(NO_TRIAD);
    expect(matchTriad(profile([9]), 9)).toEqual(NO_TRIAD);
    expect(matchTriad(profile([]), 0)).toEqual(NO_TRIAD);
  });

  it("confidence is the lead over the runner-up: a triad with a strong added sixth leads by less", () => {
    // C E G with A at full strength: C major scores 3/√12, A minor (A C E) the same — a tie the bass breaks.
    expect(matchTriad([1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0], 0)).toEqual({ root: 0, quality: TRIAD_MAJOR, confidence: TRIAD_TIE_CONFIDENCE });
    // With the A at half strength C major leads: (3 − 2.5) / √(3 · 3.25) over the margin 0.25.
    const lead = (3 - 2.5) / Math.sqrt(3 * 3.25);
    const match = matchTriad([1, 0, 0, 0, 1, 0, 0, 1, 0, 0.5, 0, 0]);
    expect(match.root).toBe(0);
    expect(match.quality).toBe(TRIAD_MAJOR);
    expect(match.confidence).toBeCloseTo(lead / 0.25, 12);
  });
});
