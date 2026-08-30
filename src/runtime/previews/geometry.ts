import type { PreviewRect } from "./types.ts";

/**
 * Tile sizing and placement arithmetic (design note §3, §4).
 *
 * Pure functions, no DOM. The editor supplies the viewport transform and the device pixel
 * ratio; nothing here reads a global, both because `src/runtime/**` is lint-banned from
 * `window` (T92, §V63) and because a preview rect computed from data is testable while one
 * measured from a live layout is not.
 */

/**
 * Physical tile sizes we are willing to allocate.
 *
 * A node's preview area is continuous (nodes are resizable, §V117), so an exact
 * `area * dpr` would reallocate a tile on every frame of a resize drag — §V8 violated in
 * the most expensive way available. Steps are roughly 1.5x apart: a resize crosses a
 * handful of them, and the worst-case sharpness error inside a step is invisible at
 * thumbnail scale. Zoom is not in that input at all — see `TileSizeInput.areaLongEdge`.
 */
export const TILE_SIZE_LADDER: ReadonlyArray<number> = [64, 96, 128, 192, 256, 384, 576, 864, 1152];

/** Below this on-screen size a preview shows nothing a person can read (§V28 `too-small`). */
export const MIN_ONSCREEN_LONG_EDGE_CSS = 24;

/**
 * BASE cap, as a multiple of `ProjectSettings.previewLongEdge`.
 *
 * The headroom is for device pixel ratio: dpr 2 on a `previewLongEdge` of 192 asks for 384,
 * and a preview that ignored dpr would be visibly soft on every retina display. This is what
 * every preview is guaranteed when the graph is busy — the sizing floor of the T490 budget.
 */
export const MAX_TILE_SCALE = 2;

/**
 * BOOST cap, as a multiple of `previewLongEdge` — the honest ceiling of the T490 budget.
 *
 * "Past the cap it goes soft; the honest answer is the viewer pane" was sound while
 * previews were badges and the zoom stopped at 2.5×. The owner zooms in TO INSPECT and the
 * range now reaches 8×, so an on-screen preview may take a bigger tile — but only while
 * the shared pixel budget has room (`createPreviewScheduler`), and never past this. At the
 * default 192 that is 1152 device px; beyond it the viewer pane remains the answer, and
 * saying so beats implying unlimited (V328).
 */
export const MAX_TILE_BOOST_SCALE = 6;

/**
 * First ladder step at or above `value`.
 *
 * Snapping UP rather than to nearest, on purpose: a tile is filtered down into its destination
 * rect, and downsampling looks fine while upsampling is what reads as broken.
 */
export function ladderSnap(value: number, ladder: ReadonlyArray<number> = TILE_SIZE_LADDER): number {
  const first = ladder[0];
  if (first === undefined) return Math.max(1, Math.round(value));
  for (const step of ladder) {
    if (value <= step) return step;
  }
  return ladder[ladder.length - 1] ?? first;
}

export interface TileSizeInput {
  /** Source output size in pixels, which fixes the aspect ratio. */
  readonly sourceSize: readonly [number, number];
  /**
   * The preview area's long edge in the NODE's own CSS px — the slot's size inside the node
   * box, which the viewport transform never touches (§V117: a resized node buys a bigger
   * tile). For the viewer pane it is the pane's own size.
   *
   * T490 amended B13's rule rather than repealing it: zoom MAY buy a bigger tile now, but
   * only through the scheduler's budgeted, ladder-quantised, hysteresis-guarded path — never
   * by feeding a raw on-screen size here. A tile sized straight from the screen rect is
   * reallocated as the camera moves, and one reallocation blanks EVERY preview for a frame
   * (B13, §V142). Within a ladder step, zoom still scales with CSS alone.
   */
  readonly areaLongEdge: number;
  readonly devicePixelRatio: number;
  /** Hard cap in device px, before ladder snapping. See `MAX_TILE_SCALE`. */
  readonly maxLongEdge: number;
}

/**
 * Physical tile size in device pixels.
 *
 * dpr and the node's preview area MULTIPLY. Dropping dpr is how a preview ends up blurry;
 * dropping the cap is how it ends up ruinously expensive; letting zoom in is B13.
 */
export function tileSizeFor(input: TileSizeInput): readonly [number, number] {
  const { sourceSize, areaLongEdge, devicePixelRatio, maxLongEdge } = input;
  const requested = Math.max(0, areaLongEdge) * Math.max(devicePixelRatio, 1);
  const capped = Math.min(requested, Math.max(1, maxLongEdge));
  const snapped = ladderSnap(capped);

  const [sw, sh] = sourceSize;
  const width = Math.max(1, sw);
  const height = Math.max(1, sh);
  if (width >= height) {
    return [snapped, Math.max(1, Math.round((snapped * height) / width))];
  }
  return [Math.max(1, Math.round((snapped * width) / height)), snapped];
}

/** The graph viewport transform React Flow reports. */
export interface ViewportTransform {
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

/** A node's preview slot, in graph-space coordinates. */
export interface SlotBox {
  /** `GraphNode.position` plus the slot's offset inside the node's CSS box. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Screen rect of a preview slot, computed rather than measured.
 *
 * The naive version calls `getBoundingClientRect()` per slot per frame; with dozens of slots
 * inside a transformed subtree that is dozens of forced layouts during the one gesture where
 * the browser is already busiest. Everything below is arithmetic on values we already hold.
 */
export function slotScreenRect(slot: SlotBox, viewport: ViewportTransform): PreviewRect {
  const zoom = viewport.zoom;
  return {
    x: slot.x * zoom + viewport.x,
    y: slot.y * zoom + viewport.y,
    width: slot.width * zoom,
    height: slot.height * zoom,
  };
}

export function rectsIntersect(a: PreviewRect, b: PreviewRect): boolean {
  return (
    a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y
  );
}

export function rectArea(rect: PreviewRect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

export function rectLongEdge(rect: PreviewRect): number {
  return Math.max(rect.width, rect.height);
}
