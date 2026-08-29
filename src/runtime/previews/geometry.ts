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
 * Zoom is continuous, so an exact `previewLongEdge * zoom * dpr` would reallocate every tile
 * on every frame of a zoom gesture — §V8 violated in the most expensive way available. Steps
 * are roughly 1.5x apart: a zoom gesture crosses a handful of them, and the worst-case
 * sharpness error inside a step is invisible at thumbnail scale.
 */
export const TILE_SIZE_LADDER: ReadonlyArray<number> = [64, 96, 128, 192, 256, 384];

/** Below this on-screen size a preview shows nothing a person can read (§V28 `too-small`). */
export const MIN_ONSCREEN_LONG_EDGE_CSS = 24;

/**
 * Cap, as a multiple of `ProjectSettings.previewLongEdge`.
 *
 * Uncapped, dpr 2 at the graph's max zoom of 2.5 asks for a 960 px "thumbnail" costing 3.7 MB.
 * Past the cap a zoomed-in node preview goes deliberately soft; the honest answer to "let me
 * see this properly" is the large viewer pane (T36), which renders at its own size.
 */
export const MAX_TILE_SCALE = 2;

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
   * How large the tile actually is on screen, CSS px on its long edge. For a node slot that
   * is `previewLongEdge * zoom`; for the viewer pane it is the pane's own size. Taking the
   * measured on-screen size rather than re-deriving it from zoom means one code path serves
   * both, and neither can drift from what the user is looking at.
   */
  readonly onScreenLongEdge: number;
  readonly devicePixelRatio: number;
  /** Hard cap in device px, before ladder snapping. See `MAX_TILE_SCALE`. */
  readonly maxLongEdge: number;
}

/**
 * Physical tile size in device pixels.
 *
 * dpr and on-screen size MULTIPLY, and on-screen size already carries the graph zoom. Treating
 * either as "the" scale is how a preview ends up blurry (drop dpr) or ruinously expensive
 * (drop the cap).
 */
export function tileSizeFor(input: TileSizeInput): readonly [number, number] {
  const { sourceSize, onScreenLongEdge, devicePixelRatio, maxLongEdge } = input;
  const requested = Math.max(0, onScreenLongEdge) * Math.max(devicePixelRatio, 1);
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
