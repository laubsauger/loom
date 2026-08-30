import { describe, expect, it } from "vitest";

import { arrowPoints, screenScale, segmentBetween, segmentsBounds } from "./reference-geometry.ts";
import { referenceLinesOf } from "./reference-lines.tsx";
import type { ParameterDependency } from "@domain/graph/parameter-dependencies.ts";

/**
 * The shape of a reference line (T248), as arithmetic rather than as a screenshot.
 *
 * The claim the picture makes — "this node is read by that one" — is only true if the
 * line starts and ends on the two nodes and points the right way. Both are numbers, so
 * both get asserted instead of eyeballed.
 */

const rect = (x: number, y: number, width = 100, height = 60) => ({ x, y, width, height });

describe("segmentBetween", () => {
  it("stops at each node's BORDER, on the line between their centres", () => {
    // Centres at (50,30) and (350,30): a horizontal run, so the endpoints are the right
    // border of one and the left border of the other.
    const segment = segmentBetween(rect(0, 0), rect(300, 0));
    expect(segment).toEqual({ x1: 100, y1: 30, x2: 300, y2: 30 });
  });

  it("leaves through the TOP or BOTTOM when the nodes are stacked", () => {
    const segment = segmentBetween(rect(0, 0), rect(0, 300));
    expect(segment).toEqual({ x1: 50, y1: 60, x2: 50, y2: 300 });
  });

  it("draws nothing when the nodes overlap", () => {
    // The borders have met: any segment left would be inside the node chrome, and an
    // arrowhead there points at the middle of a box rather than at its edge.
    expect(segmentBetween(rect(0, 0), rect(20, 10))).toBeNull();
  });

  it("draws nothing when the nodes are exactly on top of each other", () => {
    // No direction exists, so there is no line to draw and no way to aim an arrow.
    expect(segmentBetween(rect(40, 40), rect(40, 40))).toBeNull();
  });
});

describe("arrowPoints", () => {
  it("puts the tip AT the target end, with the base behind it", () => {
    const points = arrowPoints({ x1: 0, y1: 0, x2: 100, y2: 0 }, 10);
    const [tip, left, right] = points.split(" ");
    expect(tip).toBe("100.00,0.00");
    // Both trailing corners sit one arrow-length back, split either side of the line.
    expect(left).toBe("90.00,4.50");
    expect(right).toBe("90.00,-4.50");
  });

  it("turns with the line, so direction survives any layout", () => {
    const points = arrowPoints({ x1: 0, y1: 0, x2: 0, y2: 100 }, 10);
    expect(points.split(" ")[0]).toBe("0.00,100.00");
    // Pointing down: the base is ABOVE the tip, which a horizontal formula would miss.
    expect(points).toContain("90.00");
  });

  it("returns nothing for a zero-length segment rather than a degenerate triangle", () => {
    expect(arrowPoints({ x1: 5, y1: 5, x2: 5, y2: 5 }, 10)).toBe("");
  });
});

describe("screenScale", () => {
  it("keeps a dash the same size ON SCREEN at every zoom", () => {
    // The claim, as arithmetic: dash length x scale x zoom is constant. Without it a 6px
    // dash renders at 1.2px when zoomed out to 0.2 and the line reads as SOLID — which
    // is the same as never having drawn a dashed line.
    const DASH = 6;
    for (const zoom of [0.2, 0.5, 1, 2.5]) {
      expect(DASH * screenScale(zoom) * zoom).toBeCloseTo(DASH, 10);
    }
  });

  it("falls back to 1 rather than dividing by a zoom that cannot be one", () => {
    expect(screenScale(0)).toBe(1);
    expect(screenScale(Number.NaN)).toBe(1);
  });
});

describe("referenceLinesOf", () => {
  const dependency = (
    from: string,
    to: string,
    parameterKey: string,
    kind: ParameterDependency["kind"] = "reference",
  ): ParameterDependency => ({ from, to, parameterKey, kind, address: to });

  it("points the arrow the way the DATA runs: read node → reading node", () => {
    // `b` reads `a`, so the line runs a → b, the same direction a wire would.
    const [line] = referenceLinesOf([dependency("b", "a", "gain")]);
    expect(line?.source).toBe("a");
    expect(line?.target).toBe("b");
  });

  it("collapses many parameters between the same pair into ONE line", () => {
    // Six parameters driven by one LFO is one relationship. Six stacked identical lines
    // look like one line and cost six times as much to draw.
    const lines = referenceLinesOf([
      dependency("b", "a", "gain", "driven"),
      dependency("b", "a", "size", "driven"),
      dependency("b", "a", "color.r", "driven"),
    ]);
    expect(lines).toHaveLength(1);
    expect(lines[0]?.parameterKeys).toEqual(["gain", "size", "color.r"]);
  });

  it("keeps the two RELATIONSHIPS apart even between the same pair", () => {
    // They are drawn differently and mean different things; merging them would hide one.
    const lines = referenceLinesOf([
      dependency("b", "a", "gain", "driven"),
      dependency("b", "a", "size", "reference"),
    ]);
    expect(lines.map((line) => line.kind).sort()).toEqual(["driven", "reference"]);
  });
});

/**
 * The box the layer needs to be PAINTED AT ALL (B47, T374).
 *
 * A zero-width or zero-height outermost `<svg>` renders nothing — the element is
 * disabled, not clipped, so `overflow: visible` cannot rescue it. That is what shipped:
 * every reference line was in the DOM with a real client rect and no pixel of it was ever
 * drawn. jsdom paints nothing, so no DOM assertion can see the difference; the box is
 * arithmetic, and this is where the arithmetic is held.
 */
describe("the layer's box (§V151, B47)", () => {
  it("covers both endpoints of every segment", () => {
    const box = segmentsBounds(
      [
        { x1: -462, y1: 242, x2: -260, y2: 125 },
        { x1: 40, y1: -80, x2: 900, y2: 600 },
      ],
      0,
    );
    expect(box).toEqual({ x: -462, y: -80, width: 1362, height: 680 });
  });

  it("is never zero on either axis for a straight horizontal or vertical line", () => {
    // The case that would reintroduce the bug on one axis: a line with no extent in y
    // gives a zero-height svg, and a zero-height svg draws nothing.
    const horizontal = segmentsBounds([{ x1: 0, y1: 50, x2: 400, y2: 50 }], 8);
    expect(horizontal?.height).toBeGreaterThan(0);
    expect(horizontal?.width).toBeGreaterThan(0);

    const vertical = segmentsBounds([{ x1: 50, y1: 0, x2: 50, y2: 400 }], 8);
    expect(vertical?.width).toBeGreaterThan(0);
    expect(vertical?.height).toBeGreaterThan(0);
  });

  it("pads outward on all four sides, so an arrowhead is not sliced off", () => {
    const box = segmentsBounds([{ x1: 100, y1: 100, x2: 200, y2: 200 }], 10);
    expect(box).toEqual({ x: 90, y: 90, width: 120, height: 120 });
  });

  it("has no box when there is nothing to draw", () => {
    expect(segmentsBounds([], 10)).toBeNull();
  });
});
