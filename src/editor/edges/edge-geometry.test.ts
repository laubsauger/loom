import { describe, expect, it } from "vitest";
import { Position, getBezierPath } from "@xyflow/react";
import { createEdgeGeometry, distanceToCubic, parseCubicPath } from "./edge-geometry.ts";

/**
 * The two rules the composed drop test cannot isolate (§V14b, §V14c).
 *
 * The gesture itself is proved end to end in `src/tests/integration/edge-drop.test.tsx`.
 * What is here is the arithmetic underneath it, in the cases a single-wire fixture cannot
 * produce: crossing wires, and a path shape this module does not understand.
 */

const bezier = (from: [number, number], to: [number, number]): string =>
  getBezierPath({
    sourceX: from[0],
    sourceY: from[1],
    sourcePosition: Position.Right,
    targetX: to[0],
    targetY: to[1],
    targetPosition: Position.Left,
  })[0];

describe("edge geometry (§V14c)", () => {
  it("reads the control points out of React Flow's own path rather than re-deriving them", () => {
    // The point of parsing: the curve tested is BYTE-FOR-BYTE the curve drawn, so the hit
    // area cannot drift from the wire if the library changes its curvature.
    const cubic = parseCubicPath(bezier([0, 0], [200, 100]));
    expect(cubic).not.toBeNull();
    if (cubic === null) return;
    expect(cubic.p0).toEqual({ x: 0, y: 0 });
    expect(cubic.p1).toEqual({ x: 200, y: 100 });
    // Distance to a point known to be ON the curve is ~0 — the sampler follows the real
    // shape, not the straight line between the endpoints.
    expect(distanceToCubic(cubic, { x: 0, y: 0 })).toBeCloseTo(0, 6);
    expect(distanceToCubic(cubic, { x: 100, y: 50 })).toBeLessThan(1);
    // ...and the CHORD is not the curve. A backward edge — target to the LEFT of its
    // source, which is what a feedback wire looks like — bows well outside the straight
    // line between its endpoints. This point sits on that bow: it is a hit here, and a
    // hit test that measured to the chord would miss it by 13px and refuse the drop.
    const backward = parseCubicPath(bezier([200, 0], [0, 100]));
    expect(backward).not.toBeNull();
    if (backward !== null) expect(distanceToCubic(backward, { x: 213, y: 4 })).toBeLessThan(1);
  });

  it("is not a target at all when the path shape is one it cannot read", () => {
    // Degrading to "no drop target" is the honest failure. Guessing at a shape this
    // module does not understand would mean dropping on a wire that is somewhere else.
    expect(parseCubicPath("M0,0 L200,100")).toBeNull();
    const geometry = createEdgeGeometry();
    geometry.publish("e1", "M0,0 L200,100");
    expect(geometry.nearest({ x: 100, y: 50 }, 20)).toBeNull();
  });

  it("picks the NEAREST wire where wires cross, not the first one registered", () => {
    const geometry = createEdgeGeometry();
    geometry.publish("aaa", bezier([0, 0], [200, 0]));
    geometry.publish("zzz", bezier([0, 60], [200, 60]));

    // Under a crossing, the one you meant is the one your cursor is closest to. First-wins
    // would answer "aaa" here and would be wrong roughly half the time in a real graph.
    expect(geometry.nearest({ x: 100, y: 55 }, 20)).toBe("zzz");
    expect(geometry.nearest({ x: 100, y: 5 }, 20)).toBe("aaa");
  });

  it("stops being a target the moment it stops being drawn", () => {
    const geometry = createEdgeGeometry();
    geometry.publish("e1", bezier([0, 0], [200, 0]));
    expect(geometry.nearest({ x: 100, y: 0 }, 20)).toBe("e1");
    geometry.clear("e1");
    expect(geometry.nearest({ x: 100, y: 0 }, 20)).toBeNull();
  });

  it("honours the tolerance rather than snapping to whatever is closest", () => {
    const geometry = createEdgeGeometry();
    geometry.publish("e1", bezier([0, 0], [200, 0]));
    expect(geometry.nearest({ x: 100, y: 10 }, 12)).toBe("e1");
    // A drop on empty canvas 200px from every wire is a drop on empty canvas.
    expect(geometry.nearest({ x: 100, y: 200 }, 12)).toBeNull();
  });
});
