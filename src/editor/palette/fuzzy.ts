/**
 * Fuzzy subsequence matching for the command palette (T79).
 *
 * Deliberately small and deterministic: the palette must rank the same way every time
 * so muscle memory works ("und" always lands on Undo). Scoring rewards contiguous runs,
 * matches at word starts and camelCase humps, and penalises gaps and long labels.
 */

export interface FuzzyMatch {
  score: number;
  /** Indices in the original text that matched, for highlighting. */
  indices: readonly number[];
}

const WORD_SEPARATORS = new Set([" ", ".", ":", "-", "_", "/", "+"]);

export function fuzzyScore(query: string, text: string): FuzzyMatch | null {
  const needle = query.toLowerCase();
  const haystack = text.toLowerCase();
  if (needle === "") return { score: 0, indices: [] };
  if (needle.length > haystack.length) return null;

  const indices: number[] = [];
  let score = 0;
  let cursor = 0;
  let previous = -2;

  for (const character of needle) {
    if (character === " ") continue;
    let found = -1;
    for (let index = cursor; index < haystack.length; index += 1) {
      if (haystack[index] === character) {
        found = index;
        break;
      }
    }
    if (found === -1) return null;

    let bonus = 0;
    if (found === previous + 1) bonus += 8;
    if (found === 0) {
      bonus += 10;
    } else {
      const before = haystack[found - 1] ?? "";
      if (WORD_SEPARATORS.has(before)) bonus += 6;
      else if (text[found] !== haystack[found]) bonus += 4; // camelCase hump
    }
    const gap = Math.min(found - (previous + 1), 12);
    score += 10 + bonus - gap * 0.5;
    indices.push(found);
    previous = found;
    cursor = found + 1;
  }

  // Same match in a shorter label is the better match.
  return { score: score - text.length * 0.05, indices };
}

export interface FuzzyResult<T> {
  item: T;
  score: number;
  indices: readonly number[];
}

/**
 * Filters and ranks. `getText` may return several haystacks (label, command name); the
 * best-scoring one wins, so typing either finds the entry.
 */
export function fuzzyFilter<T>(
  query: string,
  items: readonly T[],
  getText: (item: T) => readonly string[],
): FuzzyResult<T>[] {
  const trimmed = query.trim();
  const results: FuzzyResult<T>[] = [];

  items.forEach((item, order) => {
    let best: FuzzyMatch | null = null;
    let bestIsPrimary = false;
    getText(item).forEach((text, textIndex) => {
      const match = fuzzyScore(trimmed, text);
      if (match === null) return;
      // A hit on the primary text (index 0) outranks a hit on a secondary one at the
      // same score, so labels beat internal command names.
      const primary = textIndex === 0;
      if (best === null || match.score > best.score || (match.score === best.score && primary && !bestIsPrimary)) {
        best = match;
        bestIsPrimary = primary;
      }
    });
    if (best === null) return;
    const match: FuzzyMatch = best;
    results.push({
      item,
      // Stable order for equal scores: keep the incoming order.
      score: match.score - order * 1e-6,
      indices: bestIsPrimary ? match.indices : [],
    });
  });

  results.sort((a, b) => b.score - a.score);
  return results;
}
