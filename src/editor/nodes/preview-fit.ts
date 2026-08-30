/**
 * §V118 — the preview LETTERBOXES inside the node's preview area; it never stretches.
 *
 * The two rectangles involved have nothing to do with each other. The preview area is
 * whatever the user dragged the node to (§V116, T208); the texture's aspect is whatever
 * the graph resolves it to (§V21). A stretched preview LIES about the image — a square
 * mask shown as a wide box is a mask the user will judge, tune and ship wrong — and it
 * lies most convincingly on exactly the node someone has just resized to look at it more
 * closely.
 *
 * The result is used for BOTH halves of a tile (§V117): the region the tile is drawn
 * into, and the size it is allocated at. Sizing from the fitted box rather than from the
 * whole slot means a tile carries the pixels that are actually shown and no more — the
 * bars are not rendered, they are simply not part of the preview.
 *
 * Pure and offset-relative: `x`/`y` are measured from the region's own top-left corner,
 * so the caller adds the node position (§V112) and the viewport (§V142) exactly as it
 * already does. Nothing here knows about zoom, and it must not: this is a graph-space
 * relationship between a node's box and its texture.
 */

export interface FittedBox {
  /** Offset from the region's top-left, in the region's own units. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * The largest box with `source`'s aspect that fits inside `region`, centred.
 *
 * Degenerate inputs — a region with no area, a source with no size — fall back to the
 * region itself. There is nothing honest to letterbox against, and returning a zero box
 * would suspend the preview for a reason the user cannot see.
 */
export function fitInsideRegion(
  region: { readonly width: number; readonly height: number },
  source: readonly [number, number],
): FittedBox {
  const [sourceWidth, sourceHeight] = source;
  const full: FittedBox = { x: 0, y: 0, width: region.width, height: region.height };
  if (!(region.width > 0) || !(region.height > 0)) return full;
  if (!(sourceWidth > 0) || !(sourceHeight > 0)) return full;

  const regionAspect = region.width / region.height;
  const sourceAspect = sourceWidth / sourceHeight;
  if (regionAspect > sourceAspect) {
    // Region is wider than the image: bars left and right (pillarbox).
    const width = region.height * sourceAspect;
    return { x: (region.width - width) / 2, y: 0, width, height: region.height };
  }
  // Region is taller than the image: bars above and below.
  const height = region.width / sourceAspect;
  return { x: 0, y: (region.height - height) / 2, width: region.width, height };
}
