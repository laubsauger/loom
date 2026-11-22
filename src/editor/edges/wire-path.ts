/**
 * The shape of a data wire (T1820b): where its two bezier controls go, for each of the
 * person's three wire styles, through every tie the wire is routed through (T1821b).
 *
 * Pure: points and a style in, cubic segments and an SVG path out. `SignalEdge` draws the
 * path, the wire in the hand draws the same function's answer, and `edge-geometry.ts`
 * parses the drawn path back for hit-testing — so what the person sees, what a release
 * lands on and what a dragged wire looks like are one shape.
 *
 * ## Why not React Flow's `getBezierPath`
 *
 * Its `curvature` argument only ever reaches a BACKWARD wire. A forward wire's controls
 * sit at half the HORIZONTAL distance (`calculateControlOffset` in `@xyflow/system`:
 * `distance >= 0 ? 0.5 * distance : curvature * 25 * sqrt(-distance)`), so a wire that
 * drops 400 px into the next column 100 px over leaves its port with a 50 px hook and is
 * a straight diagonal for the rest of its run — the "straight shots" the owner saw cross
 * each other in every fan-out. No curvature value changes that, which is why this module
 * places the controls itself.
 *
 * ## The styles
 *
 *  - `curved` (the default): the control reach grows with the VERTICAL drop as well as
 *    the horizontal run, so a wire leaves its port level, turns through the middle of
 *    the gap and arrives level — Unreal's and TouchDesigner's look. Wires fanning out of
 *    one port run together before they part instead of leaving as a spray of rays.
 *  - `gentle`: React Flow's default bezier, byte for byte the drawing before T1820b.
 *  - `straight`: a straight line between each pair of points (Nuke's pipes).
 *
 * Every style is written as cubic segments, a straight one with its controls on the
 * chord, so the hit test has one form to read whatever the person picked.
 */

export interface WirePoint {
  readonly x: number;
  readonly y: number;
}

/** One cubic bezier segment: start, two controls, end. */
export interface WireCubic {
  readonly p0: WirePoint;
  readonly c0: WirePoint;
  readonly c1: WirePoint;
  readonly p1: WirePoint;
}

export type WireStyle = "curved" | "gentle" | "straight";

/** In the order the menu lists them and `view.setWireStyle` cycles through them. */
export const WIRE_STYLES: readonly WireStyle[] = ["curved", "gentle", "straight"];

export const WIRE_STYLE_DEFAULT: WireStyle = "curved";

export function isWireStyle(value: unknown): value is WireStyle {
  return typeof value === "string" && (WIRE_STYLES as readonly string[]).includes(value);
}

/**
 * `curved`'s reach per unit of VERTICAL drop. 0.45 makes a wire that drops four times
 * further than it travels sideways turn through a near-vertical middle rather than cut
 * the corner; the horizontal half (0.5) is React Flow's own, so a level wire is drawn
 * exactly as `gentle` draws it.
 */
const CURVED_REACH_OF_DROP = 0.45;
const CURVED_REACH_OF_RUN = 0.5;
/** The smallest reach a `curved` wire leaves its port with, in graph pixels. */
const CURVED_MIN_REACH = 24;

/**
 * A wire whose end lies BEHIND its start (an output wired back into a node to its left)
 * has to loop around. React Flow's reach there is `0.25 * 25 * sqrt(run)`; `curved`
 * doubles it and adds part of the drop, so the loop clears the two nodes it joins
 * instead of passing through their port rows.
 */
const GENTLE_BACKWARD = 0.25 * 25;
const CURVED_BACKWARD = 2 * GENTLE_BACKWARD;
/**
 * A backward leg takes less of its drop than a forward one: the drop only has to clear the
 * loop, and a leg into a tie placed just right of its next point (a tie dragged below the
 * nodes it joins) otherwise loops wider than the gap it closes.
 */
const CURVED_BACKWARD_REACH_OF_DROP = 0.25;

/** How far each control sits from its end, along the port's horizontal. */
export function controlReach(style: WireStyle, from: WirePoint, to: WirePoint): number {
  const run = to.x - from.x;
  const drop = Math.abs(to.y - from.y);
  if (style === "gentle") return run >= 0 ? 0.5 * run : GENTLE_BACKWARD * Math.sqrt(-run);
  if (run >= 0) return Math.max(CURVED_MIN_REACH, CURVED_REACH_OF_RUN * run + CURVED_REACH_OF_DROP * drop);
  return CURVED_BACKWARD * Math.sqrt(-run) + CURVED_BACKWARD_REACH_OF_DROP * drop;
}

/**
 * One segment from `from` (leaving to the right, as an output does) to `to` (arriving
 * from the left, as an input does). A tie is passed through the same way: in from the
 * left, out to the right.
 */
export function wireSegment(style: WireStyle, from: WirePoint, to: WirePoint): WireCubic {
  if (style === "straight") {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    return {
      p0: from,
      c0: { x: from.x + dx / 3, y: from.y + dy / 3 },
      c1: { x: from.x + (2 * dx) / 3, y: from.y + (2 * dy) / 3 },
      p1: to,
    };
  }
  const reach = controlReach(style, from, to);
  return { p0: from, c0: { x: from.x + reach, y: from.y }, c1: { x: to.x - reach, y: to.y }, p1: to };
}

/** The segments of a wire through `points`: its output, each tie in order, its input. */
export function wireSegments(style: WireStyle, points: readonly WirePoint[]): WireCubic[] {
  const segments: WireCubic[] = [];
  for (let index = 1; index < points.length; index += 1) {
    segments.push(wireSegment(style, points[index - 1] as WirePoint, points[index] as WirePoint));
  }
  return segments;
}

/**
 * The SVG path of those segments: one `M`, then one `C` per segment.
 *
 * Numbers are written as JavaScript prints them, the form React Flow's helper wrote and
 * `parseWirePath` reads (`-?digits.digits`, with an exponent for the rare tiny value).
 */
export function wirePath(style: WireStyle, points: readonly WirePoint[]): string {
  const segments = wireSegments(style, points);
  const first = segments[0];
  if (first === undefined) return "";
  let path = `M${first.p0.x},${first.p0.y}`;
  for (const segment of segments) {
    path += ` C${segment.c0.x},${segment.c0.y} ${segment.c1.x},${segment.c1.y} ${segment.p1.x},${segment.p1.y}`;
  }
  return path;
}

/**
 * The same wire written from its INPUT end: the shape `wirePath` draws for `points`, with
 * the path starting at the last point. A wire pulled out of an input is held at that input,
 * so its path starts there, as React Flow's connection line always did.
 */
export function wirePathFromInput(style: WireStyle, points: readonly WirePoint[]): string {
  const segments = wireSegments(style, points).reverse();
  const first = segments[0];
  if (first === undefined) return "";
  let path = `M${first.p1.x},${first.p1.y}`;
  for (const segment of segments) {
    path += ` C${segment.c1.x},${segment.c1.y} ${segment.c0.x},${segment.c0.y} ${segment.p0.x},${segment.p0.y}`;
  }
  return path;
}
