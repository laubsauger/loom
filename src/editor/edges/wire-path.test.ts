import { describe, expect, it } from "vitest";
import { Position, getBezierPath } from "@xyflow/react";
import { createEdgeGeometry, distanceToCubic, parseCubicPath } from "./edge-geometry.ts";
import { WIRE_STYLE_DEFAULT, wirePath, wirePathFromInput, wireSegment, wireSegments, type WirePoint } from "./wire-path.ts";

/**
 * The wire shapes of T1820b.
 *
 * The owner's complaint was a picture — fan-outs drawn as "straight shots" crossing the
 * nodes of the next column — so the tests are about that picture: which boxes a wire runs
 * through, where it can be grabbed, what the earlier look was byte for byte. The control
 * constants are free to move as long as these hold.
 */

const bezier = (from: WirePoint, to: WirePoint): string =>
  getBezierPath({
    sourceX: from.x,
    sourceY: from.y,
    sourcePosition: Position.Right,
    targetX: to.x,
    targetY: to.y,
    targetPosition: Position.Left,
  })[0];

/** Points along the drawn wire, read back from its path exactly as the hit test reads it. */
function samples(path: string, count = 400): WirePoint[] {
  const cubic = parseCubicPath(path);
  if (cubic === null) throw new Error(`unreadable path ${path}`);
  return Array.from({ length: count + 1 }, (_, index) => {
    const t = index / count;
    const u = 1 - t;
    return {
      x: u * u * u * cubic.p0.x + 3 * u * u * t * cubic.c0.x + 3 * u * t * t * cubic.c1.x + t * t * t * cubic.p1.x,
      y: u * u * u * cubic.p0.y + 3 * u * u * t * cubic.c0.y + 3 * u * t * t * cubic.c1.y + t * t * t * cubic.p1.y,
    };
  });
}

const inside = (point: WirePoint, box: { x: number; y: number; width: number; height: number }): boolean =>
  point.x > box.x && point.x < box.x + box.width && point.y > box.y && point.y < box.y + box.height;

describe("the wire styles (T1820b)", () => {
  it("is curved by default", () => {
    expect(WIRE_STYLE_DEFAULT).toBe("curved");
  });

  it("keeps the earlier look byte for byte as `gentle`, forward and backward", () => {
    // Someone who liked the old wires gets exactly them back — not an approximation.
    for (const [from, to] of [
      [{ x: 0, y: 0 }, { x: 200, y: 100 }],
      [{ x: 10.5, y: -3 }, { x: 110.25, y: 400 }],
      [{ x: 200, y: 0 }, { x: 0, y: 100 }],
    ] as const) {
      expect(wirePath("gentle", [from, to])).toBe(bezier(from, to));
    }
  });

  it("routes a fan-out AROUND the next column's nodes where the old wire cut through one", () => {
    // The owner's picture: one output feeding a node in the next column and one beyond it.
    // The old wire to the far node is a diagonal that runs straight through the near one;
    // the curved wire leaves level, turns in the gap and arrives level, clear of it.
    const output = { x: 120, y: 330 };
    const far = { x: 380, y: 40 };
    const nearNode = { x: 260, y: 120, width: 90, height: 40 };
    const through = (path: string) => samples(path).filter((point) => inside(point, nearNode)).length;
    expect(through(wirePath("gentle", [output, far]))).toBeGreaterThan(0);
    expect(through(wirePath("curved", [output, far]))).toBe(0);
  });

  it("leaves and enters its ports level, however far it drops", () => {
    const segment = wireSegment("curved", { x: 0, y: 0 }, { x: 100, y: 400 });
    expect(segment.c0.y).toBe(0);
    expect(segment.c1.y).toBe(400);
    expect(segment.c0.x).toBeGreaterThan(0);
    expect(segment.c1.x).toBeLessThan(100);
  });

  it("draws `straight` as the straight line between the ports", () => {
    const from = { x: 0, y: 0 };
    const to = { x: 300, y: 120 };
    for (const point of samples(wirePath("straight", [from, to]))) {
      // On the chord y = 0.4 x, to rounding.
      expect(point.y - 0.4 * point.x).toBeCloseTo(0, 9);
    }
  });

  it("can be grabbed where it is drawn: a point on the curved wire off the old line is a hit", () => {
    // §V14c, held against the curve actually drawn. This point is on the curved wire and
    // 50 px from where the gentle wire ran — a hit test still reading the old shape would
    // refuse a drop the person aimed squarely at the wire they see.
    const from = { x: 0, y: 0 };
    const to = { x: 100, y: 400 };
    const curved = wirePath("curved", [from, to]);
    const onCurve = samples(curved, 4)[1] as WirePoint; // t = 0.25
    const gentle = parseCubicPath(wirePath("gentle", [from, to]));
    expect(gentle).not.toBeNull();
    if (gentle !== null) expect(distanceToCubic(gentle, onCurve)).toBeGreaterThan(40);

    const geometry = createEdgeGeometry();
    geometry.publish("wire", curved);
    expect(geometry.nearest(onCurve, 12)).toBe("wire");
    geometry.publish("wire", wirePath("gentle", [from, to]));
    expect(geometry.nearest(onCurve, 12)).toBeNull();
  });

  it("writes a wire pulled out of an INPUT from that input, the same shape either way", () => {
    // The wire in the hand starts at the port held (React Flow's connection line always did).
    const output = { x: 0, y: 0 };
    const input = { x: 120, y: 300 };
    const fromInput = wirePathFromInput("curved", [output, input]);
    expect(fromInput.startsWith("M120,300 ")).toBe(true);
    const forward = parseCubicPath(wirePath("curved", [output, input]));
    const backward = parseCubicPath(fromInput);
    expect(backward).toEqual(forward === null ? null : { p0: forward.p1, c0: forward.c1, c1: forward.c0, p1: forward.p0 });
  });

  it("passes through each tie, level, as one segment per leg", () => {
    // T1821b: a tie is a bend point the wire goes THROUGH, in from the left and out to the
    // right, so wires sharing a tie converge to one strand there.
    const points = [{ x: 0, y: 0 }, { x: 150, y: 300 }, { x: 400, y: 320 }];
    for (const style of ["curved", "gentle", "straight"] as const) {
      const segments = wireSegments(style, points);
      expect(segments).toHaveLength(2);
      expect(segments[0]?.p1).toEqual(points[1]);
      expect(segments[1]?.p0).toEqual(points[1]);
    }
    const [into, out] = wireSegments("curved", points);
    expect(into?.c1.y).toBe(300);
    expect(out?.c0.y).toBe(300);
  });
});
