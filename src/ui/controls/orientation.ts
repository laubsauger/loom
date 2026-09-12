/**
 * The orientation derivation behind `SwapDimensions` (T1157), split out of
 * `swap-dimensions.tsx` by T1315b so that file exports only components and Fast
 * Refresh can swap them.
 *
 * Orientation is `width < height` — a FUNCTION of the resolution, not a fact stored
 * beside it. See `swap-dimensions.tsx` for why that matters (§T1064).
 */

export type Orientation = "landscape" | "portrait" | "square";

/**
 * The one derivation, exported so both the control and its gates read the same rule
 * rather than each writing `width < height` again.
 */
export function orientationOf(width: number, height: number): Orientation {
  if (width === height) return "square";
  return width < height ? "portrait" : "landscape";
}
