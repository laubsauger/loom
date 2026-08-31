import { describe, expect, it } from "vitest";

import { backgroundRect, backgroundTiles, graphBackgroundMarks } from "./use-graph-background.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { ResolvedOutput } from "@compiler/index.ts";

/**
 * T463 — the graph background's pure halves. The GPU half is the same preview system
 * every tile uses (T185/T252) on a second canvas; what is NEW and therefore pinned
 * here is which nodes qualify, in which order, and how the image sits in the pane.
 */

function doc(nodes: Record<string, { background?: boolean }>): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(
      Object.entries(nodes).map(([id, ui]) => [
        id,
        {
          id,
          type: "noise",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: {},
          ...(ui.background === undefined ? {} : { ui: { background: ui.background } }),
        },
      ]),
    ),
    edges: {},
    groups: {},
  } as never;
}

const row = (nodeId: string): ResolvedOutput =>
  ({
    nodeId,
    portId: "out",
    resourceId: `target:${nodeId}:out`,
    resourceKind: "target",
    size: [640, 360],
    format: "rgba8unorm",
    space: "linear",
    temporal: false,
  }) as never;

describe("graphBackgroundMarks (T463)", () => {
  it("lists ONLY flagged nodes, in document order, with their materialized rows", () => {
    const graph = doc({ a: {}, b: { background: true }, c: { background: true }, d: { background: false } });
    const marks = graphBackgroundMarks(graph, [row("c")]);
    expect(marks.map((mark) => mark.nodeId)).toEqual(["b", "c"]);
    // b is flagged but not yet materialized — present with no row, so the caller can
    // still register its sink (T252's materialize-on-watch dance).
    expect(marks[0]?.output).toBeUndefined();
    expect(marks[1]?.output?.resourceId).toBe("target:c:out");
  });

  it("an unmarked document yields nothing — zero cost when nothing is flagged (V309)", () => {
    expect(graphBackgroundMarks(doc({ a: {}, b: {} }), [row("a")])).toEqual([]);
  });
});

describe("backgroundRect letterboxes, never stretches (§V118)", () => {
  it("centres a wide output in a taller pane", () => {
    const rect = backgroundRect({ width: 1000, height: 1000 }, [640, 360]);
    expect(rect.width).toBe(1000);
    expect(rect.height).toBe(562.5);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe((1000 - 562.5) / 2);
  });

  it("centres a tall output in a wider pane", () => {
    const rect = backgroundRect({ width: 1000, height: 500 }, [360, 640]);
    expect(rect.height).toBe(500);
    expect(rect.width).toBe(281.25);
    expect(rect.y).toBe(0);
  });
});

/**
 * T677 — SEVERAL marked nodes TILE the pane. The owner: "tile them to have them share the
 * space thats there without changing their aspect or cropping things. just like TD does
 * it".
 *
 * The three claims are asserted SEPARATELY, because they fail separately and a single
 * "looks right" assertion would let two of them rot:
 *
 *  (1) SHARES THE SPACE — the tiles do not overlap, and the layout is the BEST-FIT grid
 *      rather than a fixed column count. The best-fit claim is checked against the
 *      brute-force maximum over every row count, so a hard-coded 2 columns fails it.
 *  (2) KEEPS ITS ASPECT — every tile's width / height equals its source's, exactly. No
 *      code path here can scale the two axes differently, and this is what pins that.
 *  (3) NO CROPPING — every tile lies wholly inside the pane.
 *
 * The fixture is a NON-16:9 project (4:5 portrait) on a wide pane, on purpose: with a
 * 16:9 source in a 16:9 pane, "shares the space" and "keeps its aspect" produce the same
 * numbers and neither can fail on its own.
 */
describe("backgroundTiles: several backgrounds share the pane (T677)", () => {
  const PANE = { width: 1200, height: 700 };
  /** 4:5 portrait — the project aspect, not the pane's. */
  const PORTRAIT: readonly [number, number] = [800, 1000];
  const many = (count: number) => Array.from({ length: count }, () => PORTRAIT);

  it("one background is EXACTLY the old letterbox — a single mark is untouched (§V309)", () => {
    expect(backgroundTiles(PANE, [PORTRAIT])).toEqual([backgroundRect(PANE, PORTRAIT)]);
    expect(backgroundTiles(PANE, [])).toEqual([]);
  });

  it("keeps every source's aspect exactly, and crops nothing, for 2 through 6 tiles", () => {
    for (const count of [2, 3, 4, 5, 6]) {
      const tiles = backgroundTiles(PANE, many(count));
      expect(tiles).toHaveLength(count);
      for (const tile of tiles) {
        // (2) aspect — 0.8 exactly, to floating-point tolerance and not "about right".
        expect(tile.width / tile.height, `n=${count}`).toBeCloseTo(0.8, 10);
        // (3) no crop.
        expect(tile.x, `n=${count}`).toBeGreaterThanOrEqual(-1e-9);
        expect(tile.y, `n=${count}`).toBeGreaterThanOrEqual(-1e-9);
        expect(tile.x + tile.width, `n=${count}`).toBeLessThanOrEqual(PANE.width + 1e-9);
        expect(tile.y + tile.height, `n=${count}`).toBeLessThanOrEqual(PANE.height + 1e-9);
      }
      // (1) no overlap, pairwise.
      for (let a = 0; a < count; a += 1) {
        for (let b = a + 1; b < count; b += 1) {
          const one = tiles[a]!;
          const two = tiles[b]!;
          const overlaps =
            one.x < two.x + two.width - 1e-9 &&
            two.x < one.x + one.width - 1e-9 &&
            one.y < two.y + two.height - 1e-9 &&
            two.y < one.y + one.height - 1e-9;
          expect(overlaps, `n=${count} tiles ${a} and ${b} overlap`).toBe(false);
        }
      }
    }
  });

  it("picks the BEST-FIT grid, not a fixed column count", () => {
    const aspect = PORTRAIT[0] / PORTRAIT[1];
    for (const count of [2, 3, 4, 5, 6, 7, 8]) {
      const tiles = backgroundTiles(PANE, many(count));
      let bruteForce = 0;
      for (let rows = 1; rows <= count; rows += 1) {
        const columns = Math.ceil(count / rows);
        bruteForce = Math.max(bruteForce, Math.min(PANE.width / columns, (PANE.height / rows) * aspect));
      }
      expect(tiles[0]!.width, `n=${count}`).toBeCloseTo(bruteForce, 9);
    }
    // And concretely, so the property test cannot pass vacuously. In a 1200×700 pane,
    // four 4:5 tiles go 4 × 1 at 300 wide — height binds at 375, which still fits —
    // while FIVE go 3 × 2 at 280, because a single row of five would be only 240. A
    // fixed column count cannot produce both, which is the point of the best fit.
    expect(backgroundTiles(PANE, many(4))[0]!.width).toBeCloseTo(300, 9);
    expect(backgroundTiles(PANE, many(5))[0]!.width).toBeCloseTo(280, 9);
  });

  it("letterboxes an odd aspect inside its own cell rather than stretching it (§V118)", () => {
    // A per-node resolution override (§V50) is enough to make one background a different
    // shape from the rest. It must get bars, never a stretch and never a crop.
    const odd: readonly [number, number] = [1000, 250];
    const tiles = backgroundTiles(PANE, [PORTRAIT, PORTRAIT, odd]);
    expect(tiles[0]!.width / tiles[0]!.height).toBeCloseTo(0.8, 10);
    expect(tiles[2]!.width / tiles[2]!.height).toBeCloseTo(4, 10);
    // It is narrower in height than its cell, and no wider than it.
    expect(tiles[2]!.height).toBeLessThan(tiles[0]!.height);
    expect(tiles[2]!.width).toBeLessThanOrEqual(tiles[0]!.width + 1e-9);
  });

  it("centres a short final row against the rows above it", () => {
    // Five 4:5 tiles land 3 × 2, so the second row holds two and is SHORT. Centred, not
    // left-aligned — which is what "shares the space" looks like when the count is not a
    // multiple of the column count.
    const tiles = backgroundTiles(PANE, many(5));
    const fullRowCentre = (tiles[0]!.x + tiles[2]!.x + tiles[2]!.width) / 2;
    const shortRowCentre = (tiles[3]!.x + tiles[4]!.x + tiles[4]!.width) / 2;
    expect(shortRowCentre).toBeCloseTo(fullRowCentre, 9);
    expect(shortRowCentre).toBeCloseTo(PANE.width / 2, 9);
    // And it IS a second row: the last two sit below the first three.
    expect(tiles[3]!.y).toBeGreaterThan(tiles[0]!.y + tiles[0]!.height - 1e-9);
  });
});
