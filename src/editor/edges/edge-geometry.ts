import type { EdgeId } from "@domain/types/ids.ts";

/**
 * Where every edge actually IS, so an edge can be a drop target (T212, T213, §V14b, §V14c).
 *
 * ## Why the geometry is published rather than recomputed
 *
 * An edge on screen is a cubic bezier whose endpoints come from React Flow's measured
 * handle positions — data this module has no access to and no business duplicating. So
 * the edge component publishes THE PATH IT DREW, and the hit test reads it back. One
 * source of truth: whatever the user sees is what they can drop on, including while a
 * node is mid-drag and the wire is following it.
 *
 * The path string React Flow's `getBezierPath` returns is exactly one cubic segment
 * (`M p0 C c0 c1 p1`), so parsing it recovers the control points EXACTLY rather than
 * re-deriving them from a curvature constant that could drift out of step with the
 * library's own.
 *
 * ## Why a store and not React state
 *
 * Edge geometry changes on every frame of a node drag. Putting it in React state would
 * re-render the canvas at pointer rate for a value only a drop handler ever reads — the
 * same mistake §V16 exists to prevent, and the same shape as `preview-slot-bounds.ts`.
 * A plain map, written on render, read once per gesture.
 *
 * Coordinates are GRAPH space throughout, never screen space: the drop point is
 * projected into graph space by the canvas (`screenToFlowPosition`), so nothing here
 * carries zoom and a hit test is the same at any camera (§V142).
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** One cubic bezier segment: start, two controls, end. */
export interface EdgeCubic {
  readonly p0: Point;
  readonly c0: Point;
  readonly c1: Point;
  readonly p1: Point;
}

/**
 * §V14c — the invisible margin around the stroke, in CSS pixels.
 *
 * "~10px each side" of a 1px line, the same principle as §V99's port pad: a wire is a
 * target you aim at with a whole arm, not a hairline you have to pixel-hunt. Callers
 * divide by the zoom to get the graph-space tolerance, so the target stays this size on
 * screen however far the camera is pulled back.
 */
export const EDGE_HIT_TOLERANCE_PX = 12;

/**
 * Samples per curve for the distance test.
 *
 * A bezier's distance function has no cheap closed form, so the curve is walked as a
 * polyline and the distance is taken to the nearest SEGMENT (not to the nearest sampled
 * point, which would under-report by up to half a segment length and make the hit area
 * lumpy along the curve). Sixteen segments keeps the chord error well under a pixel for
 * edges at any length a graph actually contains.
 */
const SAMPLES = 16;

const NUMBER = "(-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)";
const CUBIC_PATH = new RegExp(
  `^M${NUMBER},${NUMBER}\\s*C${NUMBER},${NUMBER}\\s+${NUMBER},${NUMBER}\\s+${NUMBER},${NUMBER}$`,
  "i",
);

/**
 * Parses the single-cubic path React Flow's bezier helper emits.
 *
 * Returns null for anything else — a smooth-step path, a straight path, a future edge
 * shape — rather than guessing. An edge whose geometry cannot be read is simply not a
 * drop target, which degrades to today's behaviour instead of to a wrong drop.
 */
export function parseCubicPath(path: string): EdgeCubic | null {
  const match = CUBIC_PATH.exec(path.trim());
  if (match === null) return null;
  const numbers = match.slice(1, 9).map(Number);
  if (numbers.some((value) => !Number.isFinite(value))) return null;
  const [x0, y0, cx0, cy0, cx1, cy1, x1, y1] = numbers as [
    number, number, number, number, number, number, number, number,
  ];
  return {
    p0: { x: x0, y: y0 },
    c0: { x: cx0, y: cy0 },
    c1: { x: cx1, y: cy1 },
    p1: { x: x1, y: y1 },
  };
}

function pointAt(cubic: EdgeCubic, t: number): Point {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return {
    x: a * cubic.p0.x + b * cubic.c0.x + c * cubic.c1.x + d * cubic.p1.x,
    y: a * cubic.p0.y + b * cubic.c0.y + c * cubic.c1.y + d * cubic.p1.y,
  };
}

/** Distance from a point to a line SEGMENT (not the infinite line through it). */
function distanceToSegment(point: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const t =
    lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared));
  const cx = a.x + t * dx;
  const cy = a.y + t * dy;
  return Math.hypot(point.x - cx, point.y - cy);
}

/** Shortest distance from `point` to the drawn curve, in the same units as the curve. */
export function distanceToCubic(cubic: EdgeCubic, point: Point): number {
  let previous = cubic.p0;
  let best = Number.POSITIVE_INFINITY;
  for (let step = 1; step <= SAMPLES; step += 1) {
    const next = step === SAMPLES ? cubic.p1 : pointAt(cubic, step / SAMPLES);
    const distance = distanceToSegment(point, previous, next);
    if (distance < best) best = distance;
    previous = next;
  }
  return best;
}

export interface EdgeGeometryStore {
  /** Called by the edge component with the path it just drew. */
  publish(edgeId: EdgeId, path: string): void;
  clear(edgeId: EdgeId): void;
  /**
   * The edge nearest `point` within `tolerance`, or null.
   *
   * Nearest rather than first: wires cross, and under a crossing the one you meant is
   * the one your cursor is closest to. `skip` excludes edges that cannot be the answer
   * for this gesture — the ones already attached to the node being dropped (T213).
   */
  nearest(point: Point, tolerance: number, skip?: (edgeId: EdgeId) => boolean): EdgeId | null;
}

export function createEdgeGeometry(): EdgeGeometryStore {
  const curves = new Map<EdgeId, EdgeCubic>();
  return {
    publish(edgeId, path) {
      const cubic = parseCubicPath(path);
      if (cubic === null) curves.delete(edgeId);
      else curves.set(edgeId, cubic);
    },
    clear(edgeId) {
      curves.delete(edgeId);
    },
    nearest(point, tolerance, skip) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
      let bestId: EdgeId | null = null;
      let best = tolerance;
      // Sorted, so two edges at the same distance resolve the same way every time
      // rather than by map insertion order (§V40's determinism, applied to a gesture).
      for (const edgeId of [...curves.keys()].sort()) {
        if (skip?.(edgeId) === true) continue;
        const cubic = curves.get(edgeId);
        if (cubic === undefined) continue;
        const distance = distanceToCubic(cubic, point);
        if (distance <= best) {
          best = distance;
          bestId = edgeId;
        }
      }
      return bestId;
    },
  };
}
