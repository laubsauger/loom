/**
 * T717 — the graph's dot grid, at a density that survives the zoom range.
 *
 * The grid was a fixed 16 graph-unit pitch, and the canvas zooms from 0.05 to 8. At the
 * far end that is a dot every 0.8 screen pixels — a flat wash carrying no information —
 * and at 8x it is a dot every 128px, too sparse to read as a grid at all. The owner:
 * "we probably should adapt the grid size of the background of the chart to the zoom
 * level so it doesnt become useless at further zoom outs?"
 *
 * ## Why two layers rather than one adaptive gap
 *
 * The obvious fix is one octave-quantised gap, and it POPS. `2^ceil(-log2(zoom))` steps
 * by a factor of two at each octave boundary, so the whole grid visibly doubles or halves
 * its spacing mid-pinch — a glitch while zooming reads worse than a grid that is merely
 * useless at the extremes, and it happens right in the middle of the range people use.
 *
 * So there are two layers: a COARSE one at the quantised gap, always opaque, and a FINE
 * one at half that, fading in across the octave. The cross-fade is what makes the
 * boundary continuous, and it is continuous by construction rather than by tuning —
 * at the moment the level increments, the coarse gap doubles and the new fine layer
 * lands on exactly the pitch the old coarse layer had, at exactly the opacity it had.
 * Nothing jumps; one set of dots dissolves in while another dissolves out.
 *
 * §T463's properties are unchanged: this renders in React Flow's own negative-z slot,
 * above the ground and beneath every node and edge, and it is not dimmed — full
 * brightness was the owner's explicit call, on the grounds that TouchDesigner does not
 * dim its network background either. The fine layer's opacity is LOD, not a dim: the
 * coarse layer it hands over to is always fully opaque.
 */

/** Graph units between dots at zoom 1 — the pitch the grid is designed around. */
const BASE_GAP = 16;

/**
 * The dot's radius on SCREEN, in pixels, held constant at every zoom.
 *
 * React Flow scales `size` by the viewport zoom along with everything else, so a fixed
 * size is a dot that shrinks as you zoom out. Adapting only the GAP looks correct in the
 * numbers and is still invisible in the app: measured at zoom 0.16 the spacing was a
 * healthy 20.5 screen px while each dot was 1.5 × 0.16 = 0.24px — sub-pixel, antialiased
 * to nothing, a flat ground. That is T708's "the dots dont really show" returning at the
 * far end of the zoom range, and it is why this row needs both halves: constant spacing
 * AND constant dot size. Dividing by zoom cancels React Flow's scaling exactly.
 */
const DOT_SCREEN_PX = 1.5;

/**
 * How far the quantised gap may be pushed. React Flow clamps zoom to [0.05, 8], which
 * needs levels -3..5; the bounds are wider than that so a future zoom range does not
 * silently produce a one-pixel gap (a pattern tile of ~0 is a solid fill, and an enormous
 * one is no grid at all).
 */
const MIN_LEVEL = -6;
const MAX_LEVEL = 8;

export interface GridLevel {
  /** Graph units between coarse dots. Always visible. */
  gap: number;
  /** Graph units between fine dots — half the coarse pitch. */
  fineGap: number;
  /** 0 at the tight end of the octave, 1 at the loose end. */
  fineOpacity: number;
  /** Graph units, chosen so the drawn dot is DOT_SCREEN_PX on screen at this zoom. */
  dotSize: number;
}

/**
 * The level-of-detail for a zoom, as a pure function so the octave invariant can be
 * asserted over a sweep rather than spot-checked at a few zooms.
 *
 * The invariant that matters: `gap * zoom` — the SCREEN spacing, which is the only thing
 * a person actually sees — stays inside [BASE_GAP, 2 * BASE_GAP) at every zoom. That is
 * the whole point of the row, and it is a property, not a value.
 */
export function gridLevel(zoom: number): GridLevel {
  // §V66: an unlaid-out pane reports zoom 0, and log2(0) is -Infinity. Fall back to the
  // designed pitch rather than to a gap of Infinity, which draws nothing at all.
  const safeZoom = Number.isFinite(zoom) && zoom > 0 ? zoom : 1;
  const octaves = -Math.log2(safeZoom);
  const level = Math.min(MAX_LEVEL, Math.max(MIN_LEVEL, Math.ceil(octaves)));
  const gap = BASE_GAP * 2 ** level;
  return {
    gap,
    fineGap: gap / 2,
    /*
     * `level - octaves` is 0 where the coarse dots are at their tightest on screen (the
     * fine layer would be half of BASE_GAP, too dense, so it is invisible) and approaches
     * 1 where they are at their loosest (the fine layer is exactly BASE_GAP, so it is
     * fully drawn). Clamped because `level` is clamped: past the ends of the range the
     * difference stops tracking the octave and would otherwise run outside [0, 1].
     */
    fineOpacity: Math.min(1, Math.max(0, level - octaves)),
    dotSize: DOT_SCREEN_PX / safeZoom,
  };
}
