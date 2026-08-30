/**
 * Where a reference line starts and stops (T248, §V151).
 *
 * A data edge runs PORT to PORT, because that is what it is: a named output feeding a
 * named input. A reference has no port at either end — `op('blur1').par.size` names a
 * node and a parameter, and the parameter is a row in a panel, not a socket on the
 * canvas. So the line is drawn NODE EDGE to NODE EDGE, on the straight segment between
 * the two centres.
 *
 * The alternative was to attach at the parameter ROW, which is more precise and much
 * busier: it needs the node expanded to mean anything, it moves when the panel scrolls,
 * and a node driven on six parameters becomes six lines landing a few pixels apart. The
 * question the owner asked this feature to answer is "who talks to whom", which is a
 * question about NODES.
 *
 * Centres are the aim and borders are the endpoints: aiming at the centre keeps the line
 * pointing at the node as it moves, and stopping at the border keeps it from crossing the
 * node's own chrome.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Segment {
  readonly x1: number;
  readonly y1: number;
  readonly x2: number;
  readonly y2: number;
}

/** Where the ray leaving a rect's centre in direction (dx, dy) crosses its border. */
function borderOffset(halfWidth: number, halfHeight: number, dx: number, dy: number): number {
  const horizontal = dx === 0 ? Number.POSITIVE_INFINITY : halfWidth / Math.abs(dx);
  const vertical = dy === 0 ? Number.POSITIVE_INFINITY : halfHeight / Math.abs(dy);
  const offset = Math.min(horizontal, vertical);
  return Number.isFinite(offset) ? offset : 0;
}

/**
 * The visible part of the line between two node rectangles, or null when there is none.
 *
 * Null covers the two cases where a line would be a lie rather than a shape: the nodes
 * are on top of each other (nothing to connect that the eye could follow), or they
 * overlap so far that the trimmed segment has turned back on itself. Drawing a zero- or
 * negative-length line puts an arrowhead pointing the wrong way at a node — worse than
 * drawing nothing, because it is confidently wrong.
 */
export function segmentBetween(from: Rect, to: Rect): Segment | null {
  const fromCenter = { x: from.x + from.width / 2, y: from.y + from.height / 2 };
  const toCenter = { x: to.x + to.width / 2, y: to.y + to.height / 2 };
  const dx = toCenter.x - fromCenter.x;
  const dy = toCenter.y - fromCenter.y;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return null;

  const ux = dx / distance;
  const uy = dy / distance;
  const start = borderOffset(from.width / 2, from.height / 2, ux, uy);
  const end = borderOffset(to.width / 2, to.height / 2, ux, uy);
  // The two borders meet or cross: the nodes are overlapping, and there is no segment
  // between them to draw.
  if (start + end >= distance) return null;

  return {
    x1: fromCenter.x + ux * start,
    y1: fromCenter.y + uy * start,
    x2: toCenter.x - ux * end,
    y2: toCenter.y - uy * end,
  };
}

/**
 * The arrowhead at the target end, as an SVG polygon's points.
 *
 * Direction is half of "who talks to whom" — a line alone says two nodes are related and
 * leaves which one reads the other to guesswork. `size` is in the same units as the
 * segment, so the caller scales it for zoom exactly as it scales the dash pattern.
 */
export function arrowPoints(segment: Segment, size: number): string {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const distance = Math.hypot(dx, dy);
  if (distance === 0) return "";
  const ux = dx / distance;
  const uy = dy / distance;
  // Perpendicular, for the two trailing corners.
  const px = -uy;
  const py = ux;
  const baseX = segment.x2 - ux * size;
  const baseY = segment.y2 - uy * size;
  const halfWidth = size * 0.45;
  return [
    `${segment.x2.toFixed(2)},${segment.y2.toFixed(2)}`,
    `${(baseX + px * halfWidth).toFixed(2)},${(baseY + py * halfWidth).toFixed(2)}`,
    `${(baseX - px * halfWidth).toFixed(2)},${(baseY - py * halfWidth).toFixed(2)}`,
  ].join(" ");
}

/**
 * The box every drawn segment fits inside, padded (B47, T374).
 *
 * The layer used to be a ZERO-SIZED `<svg>` at the flow origin, relying on
 * `overflow: visible` to let children carrying raw flow coordinates paint outside it.
 * That does not work: an outermost `<svg>` whose viewport has zero width or height
 * renders NOTHING, and `overflow` has no say in it — the element is disabled, not
 * clipped. So every reference line was in the DOM, with a real `getBoundingClientRect`,
 * and no pixel of it was ever painted. Measured in Chromium on E10: giving the same
 * `<svg>` a non-zero box made the line appear with no other change.
 *
 * jsdom paints nothing, so no DOM assertion anywhere can see this — which is why the
 * box is computed by a function with its own test rather than left as a style.
 *
 * `padding` is the arrowhead plus the stroke, in the same units as the segments: the
 * polygon sits back from `x2` and spreads perpendicular to the line, and a stroke
 * straddles its path, so both overhang the raw endpoint box.
 */
export function segmentsBounds(
  segments: readonly Segment[],
  padding: number,
): { x: number; y: number; width: number; height: number } | null {
  if (segments.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const segment of segments) {
    minX = Math.min(minX, segment.x1, segment.x2);
    minY = Math.min(minY, segment.y1, segment.y2);
    maxX = Math.max(maxX, segment.x1, segment.x2);
    maxY = Math.max(maxY, segment.y1, segment.y2);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const pad = Number.isFinite(padding) ? Math.max(padding, 0) : 0;
  return {
    x: minX - pad,
    y: minY - pad,
    // A horizontal or vertical line has zero extent on one axis, and a zero-sized svg is
    // the whole bug — the padding is what keeps both dimensions positive.
    width: maxX - minX + pad * 2,
    height: maxY - minY + pad * 2,
  };
}

/**
 * The factor that keeps a length CONSTANT IN SCREEN PIXELS inside the zoomed viewport.
 *
 * The lines live in flow coordinates, so everything drawn there is multiplied by the
 * zoom on its way to the screen. Dividing by the zoom first cancels that — which matters
 * for exactly one reason: a 6px dash at zoom 0.2 renders at 1.2px, and a dash pattern
 * that reads as a solid line when you zoom out is the same as not having drawn a dashed
 * line at all. The distinction from a data edge has to survive at a glance AND at low
 * zoom, so the dash, the stroke and the arrowhead all go through this.
 */
export function screenScale(zoom: number): number {
  return zoom > 0 && Number.isFinite(zoom) ? 1 / zoom : 1;
}
