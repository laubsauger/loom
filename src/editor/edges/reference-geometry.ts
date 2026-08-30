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
