import type { FrameRange } from "@domain/types/graph.ts";
import { frameRangeLength } from "@domain/types/graph.ts";

/**
 * The timeline track's geometry (T1259), split out of `timeline-scrubber.tsx` by T1315b
 * so that file exports only components.
 */

/**
 * Where a frame sits along the track, as 0..1.
 *
 * Pure and exported because it is the part with an off-by-one in it, and a jsdom test
 * cannot measure a box (§V339): the geometry is asserted here on numbers and in
 * `src/tests/e2e` on pixels, and neither pretends to be the other.
 */
export function fractionOfRange(range: FrameRange, frameIndex: number): number {
  const span = frameRangeLength(range) - 1;
  if (span <= 0) return 0;
  return clamp01((frameIndex - range.start) / span);
}

/** The inverse: which frame a fraction of the track points at. Always inside the range. */
export function frameAtFraction(range: FrameRange, fraction: number): number {
  const span = frameRangeLength(range) - 1;
  return range.start + Math.round(clamp01(fraction) * span);
}

/** Shared by the two conversions above and by the track's pointer→fraction read. */
export function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
