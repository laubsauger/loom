/**
 * T1226 — spectral flux on analyser-shaped bytes, as PURE functions.
 *
 * Flux is the engine's onset quantity: how much of the spectrum ROSE since a reference
 * spectrum. Two flavours live here because two consumers need them:
 *
 * - `positiveFlux` against the previous hop is the v1 `onset` formula
 *   (`audio-features.ts`, T437) at hop resolution: mean positive byte rise over a bin
 *   range, / 255, so a silence→full-scale jump across the range is exactly 1. The v1
 *   record's `onsetCount`/`onsetMax` are defined on it (§V357), so it cannot change.
 * - `positiveFlux` against a `maxFilter`ed spectrum from μ hops back is SuperFlux
 *   (Böck & Widmer 2013): the lag lets a rise that takes several overlapping windows to
 *   complete count once at full height instead of μ times at a fraction, and the max
 *   filter over ±`halfWidth` bins stops vibrato — a partial sliding into the next bin —
 *   from reading as a rise. Same function, different reference; the choice of reference
 *   is `hop-analyser.ts`'s.
 *
 * `binRange` is `bandAverage`'s bin selection in `audio-features.ts`, restated: a band's
 * flux and a band's level must look at the same bins or the two channels disagree about
 * where "low" ends. Pinned against each other by test.
 */

/** The bins a `[lowHz, highHz]` band covers, inclusive, clamped to the spectrum. Empty when `last < first`. */
export function binRange(binHz: number, lowHz: number, highHz: number, binCount: number): readonly [number, number] {
  const first = Math.max(0, Math.ceil(lowHz / binHz));
  const last = Math.min(binCount - 1, Math.floor(highHz / binHz));
  return [first, last];
}

/**
 * Mean positive rise of `current` over `reference` on bins `first..last` inclusive,
 * normalised to 0..1. An empty range is 0, as is a range on a `reference` of another
 * length (no previous hop yet: the first window reports 0, never a full-deck hit).
 */
export function positiveFlux(
  current: Uint8Array,
  reference: Uint8Array | null,
  first = 0,
  last = current.length - 1,
): number {
  if (reference === null || reference.length !== current.length || last < first) return 0;
  let flux = 0;
  for (let bin = first; bin <= last; bin += 1) {
    const rise = (current[bin] as number) - (reference[bin] as number);
    if (rise > 0) flux += rise;
  }
  return flux / (last - first + 1) / 255;
}

/** Each bin becomes the max of itself and its `halfWidth` neighbours on either side, written into `out`. */
export function maxFilter(spectrum: Uint8Array, halfWidth: number, out: Uint8Array): Uint8Array {
  if (out.length !== spectrum.length) {
    throw new Error(`maxFilter: out ${out.length} does not fit ${spectrum.length} bins`);
  }
  const lastBin = spectrum.length - 1;
  for (let bin = 0; bin <= lastBin; bin += 1) {
    let peak = spectrum[bin] as number;
    const from = Math.max(0, bin - halfWidth);
    const to = Math.min(lastBin, bin + halfWidth);
    for (let i = from; i <= to; i += 1) if ((spectrum[i] as number) > peak) peak = spectrum[i] as number;
    out[bin] = peak;
  }
  return out;
}
