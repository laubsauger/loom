/**
 * T379 — the ONE set of gesture arithmetic every inspection surface shares.
 *
 * The owner's instruction was "this should be something they inherit from a common
 * thing", and the drift risk is precisely the numbers: a tile and a viewer that each
 * keep their own radians-per-pixel grow different wrists within a week. The EVENT
 * WIRING legitimately differs per host (a node tile must negotiate with React Flow's
 * alt/peek/nowheel world; the viewer owns its surface outright), so what is shared is
 * the arithmetic that turns pixels into orbit deltas — one place, three consumers
 * (node tile, viewer pane, and the pop-out viewer which mounts the same ViewerPane).
 *
 * T561's feel is the contract: a full sweep across the surface is about a half turn,
 * and a full sweep pans about one radius. The tile got that with fixed per-pixel
 * constants tuned for its 192px width; `scale` generalises it — pass 1 for the tile
 * (byte-identical behaviour to the constants it always had) and `192 / rect.width`
 * for a larger surface, so the SWEEP stays the unit, not the pixel.
 */

/** T561: radians per CSS px at the 192px reference width. */
export const RADIANS_PER_PX = 0.016;
/** T656: stock radii per CSS px at the reference width. */
export const RADII_PER_PX = 0.005;
/** T656: one 100-unit wheel notch is e^0.15 ≈ 1.16×. */
export const ZOOM_PER_DELTA = 0.0015;
/** A wheel reporting LINES or PAGES rather than pixels, normalized to pixels. */
export const DELTA_MODE_SCALE = [1, 16, 100] as const;
/** The tile width the per-pixel constants were tuned on. */
export const ORBIT_REFERENCE_WIDTH = 192;

/** Pointer movement → orbit delta. `pan` is the shift-drag (T675: shift pans, alt is
 *  the tile's camera key); drag right walks the camera rightward around the object. */
export function orbitDeltaFor(
  dx: number,
  dy: number,
  options: { pan: boolean; scale?: number },
): { azimuth?: number; elevation?: number; panX?: number; panY?: number } {
  const scale = options.scale ?? 1;
  return options.pan
    ? { panX: dx * RADII_PER_PX * scale, panY: -dy * RADII_PER_PX * scale }
    : { azimuth: dx * RADIANS_PER_PX * scale, elevation: -dy * RADIANS_PER_PX * scale };
}

/** Wheel → multiplicative zoom factor; away-from-you moves in, exponential so a notch
 *  is worth the same proportion of the picture at every distance. */
export function zoomFactorFor(deltaY: number, deltaMode: number): number {
  const scale = DELTA_MODE_SCALE[deltaMode] ?? 1;
  return Math.exp(deltaY * scale * ZOOM_PER_DELTA);
}
