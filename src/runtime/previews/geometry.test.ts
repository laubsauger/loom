import { describe, expect, it } from "vitest";
import {
  MAX_TILE_SCALE,
  TILE_SIZE_LADDER,
  ladderSnap,
  rectsIntersect,
  slotScreenRect,
  subtractRects,
  tileSizeFor,
} from "./geometry.ts";
import type { PreviewRect } from "./types.ts";

describe("tile size ladder", () => {
  it("snaps UP, so a tile is downsampled into its rect and never upsampled", () => {
    expect(ladderSnap(65)).toBe(96);
    expect(ladderSnap(96)).toBe(96);
    expect(ladderSnap(1)).toBe(64);
  });

  it("clamps anything past the last step to the last step", () => {
    const last = TILE_SIZE_LADDER[TILE_SIZE_LADDER.length - 1];
    expect(ladderSnap(10_000)).toBe(last);
  });

  it("keeps the tile size constant while a node is resized inside one ladder step", () => {
    // The reason the ladder exists: a continuous physical size would reallocate a tile on
    // every frame of a resize drag, which is §V8 violated in the most expensive way going.
    // 128 * [0.8 .. 1.0] spans 102.4 .. 128, entirely inside the 96 -> 128 step.
    const sizes = [0.8, 0.85, 0.9, 0.95, 1.0].map(
      (scale) =>
        tileSizeFor({
          sourceSize: [1280, 720],
          areaLongEdge: 128 * scale,
          devicePixelRatio: 1,
          maxLongEdge: 384,
        })[0],
    );
    expect(new Set(sizes).size).toBe(1);
  });
});

describe("device pixel ratio", () => {
  it("asks for more pixels on a high-density display", () => {
    const at1 = tileSizeFor({
      sourceSize: [1280, 720],
      areaLongEdge: 96,
      devicePixelRatio: 1,
      maxLongEdge: 384,
    });
    const at2 = tileSizeFor({
      sourceSize: [1280, 720],
      areaLongEdge: 96,
      devicePixelRatio: 2,
      maxLongEdge: 384,
    });
    expect(at1[0]).toBe(96);
    expect(at2[0]).toBe(192);
  });

  it("never exceeds the cap, whatever the area and the density ask for", () => {
    const cap = 192 * MAX_TILE_SCALE;
    const size = tileSizeFor({
      sourceSize: [1280, 720],
      areaLongEdge: 192 * 2.5,
      devicePixelRatio: 3,
      maxLongEdge: cap,
    });
    expect(size[0]).toBeLessThanOrEqual(cap);
  });
});

describe("slot placement", () => {
  it("computes the screen rect from the viewport transform, without measuring anything", () => {
    const rect = slotScreenRect(
      { x: 100, y: 50, width: 192, height: 108 },
      { x: 20, y: -10, zoom: 0.5 },
    );
    expect(rect).toEqual({ x: 70, y: 15, width: 96, height: 54 });
  });

  it("detects the off-surface case that §V28 suspends", () => {
    const surface = { x: 0, y: 0, width: 800, height: 600 };
    const onScreen = slotScreenRect({ x: 0, y: 0, width: 192, height: 108 }, { x: 0, y: 0, zoom: 1 });
    const scrolledAway = slotScreenRect(
      { x: 0, y: 0, width: 192, height: 108 },
      { x: -2000, y: 0, zoom: 1 },
    );
    expect(rectsIntersect(onScreen, surface)).toBe(true);
    expect(rectsIntersect(scrolledAway, surface)).toBe(false);
  });
});

/**
 * §B174's stated gate: a FRACTIONAL dpr AND a zoom ≠ 1, together.
 *
 * Windows at 125% UI scaling reports `devicePixelRatio` 1.25; a Mac reports exactly 2, and
 * every dpr in this suite was 1, 2 or 3 before this block existed. At dpr 2 a dropped or
 * doubled factor divides evenly and still looks plausible — 1.25 is where it cannot.
 *
 * The composed claim, which no single unit was making: the tile's DESTINATION is
 * `node rect × viewport scale × dpr`, the backing store is sized from THE SAME dpr, and
 * the tile ALLOCATION uses that dpr too. The compositor multiplies `slotScreenRect`'s
 * output by `command.surface.dpr` (`vgpu-backend.presentPreviews`) and vgpu sizes the
 * surface as `round(cssPx × dpr)`, so both sides are reproduced here rather than mocked.
 *
 * ⚠ Stated honestly: this went GREEN the day it was written. The defect §B174 was filed
 * for was a measurement RACE, not this arithmetic (see `node-preview-slot-bounds.test.tsx`
 * and `scratchpad/b174/race-repro.mjs`), and a fractional dpr does not reproduce it — a
 * real Chrome at 1.25 and 1.5, static and changed live, places every tile correctly. This
 * stays as the regression guard for the composition the row asked to have pinned.
 */
describe("§B174 fractional dpr with a zoom ≠ 1", () => {
  const DPR = 1.25;
  const ZOOM = 0.8;
  /** The node's own preview slot, in graph px — what `PreviewSlotBounds` publishes. */
  const SLOT = { x: 300, y: 160, width: 192, height: 108 };
  const VIEWPORT = { x: 37, y: -14, zoom: ZOOM };

  /** vgpu's own surface sizing: `round(clientWidth × dpr)` (`node_modules/vgpu/dist/surface.js`). */
  const storeSize = (cssPx: number, dpr: number): number => Math.round(cssPx * dpr);
  /** The compositor's own: `viewport = dest × command.surface.dpr`. */
  const deviceRect = (rect: { x: number; y: number; width: number; height: number }, dpr: number) => ({
    x: rect.x * dpr,
    y: rect.y * dpr,
    width: rect.width * dpr,
    height: rect.height * dpr,
  });

  it("puts the destination at node rect × viewport scale × dpr, in the store's own units", () => {
    const dest = deviceRect(slotScreenRect(SLOT, VIEWPORT), DPR);

    // ONE expression, spelled out: nothing here divides by dpr, and nothing squares zoom.
    expect(dest).toEqual({
      x: (SLOT.x * ZOOM + VIEWPORT.x) * DPR,
      y: (SLOT.y * ZOOM + VIEWPORT.y) * DPR,
      width: SLOT.width * ZOOM * DPR,
      height: SLOT.height * ZOOM * DPR,
    });

    // And it lands inside the surface the same dpr sized — the property that fails the
    // moment the two stop sharing a factor. A 1000×600 CSS pane is 1250×750 device px.
    const store = { width: storeSize(1000, DPR), height: storeSize(600, DPR) };
    expect(store).toEqual({ width: 1250, height: 750 });
    expect(dest.x).toBeGreaterThanOrEqual(0);
    expect(dest.y).toBeGreaterThanOrEqual(0);
    expect(dest.x + dest.width).toBeLessThanOrEqual(store.width);
    expect(dest.y + dest.height).toBeLessThanOrEqual(store.height);
  });

  it("allocates from the same fractional dpr — the tile is not sized for a dpr of 1 or 2", () => {
    // §V142: the ALLOCATION reads the node's own area, never the zoom. 192 × 1.25 = 240,
    // which snaps UP to 256 — a step neither dpr 1 (192) nor dpr 2 (384) can produce, so
    // this assertion cannot pass by an integer-dpr accident.
    const tile = tileSizeFor({
      sourceSize: [1920, 1080],
      areaLongEdge: SLOT.width,
      devicePixelRatio: DPR,
      maxLongEdge: 192 * MAX_TILE_SCALE,
    });
    expect(tile[0]).toBe(256);
    expect(tile[0]).toBeGreaterThanOrEqual(SLOT.width * DPR);
  });
});

/**
 * T1102 — the clip a tile is drawn through.
 *
 * These are stated as PROPERTIES of the returned region rather than as an expected list of
 * rectangles, and that is deliberate: which four pieces the subtraction happens to emit is
 * an implementation detail, while "the tile paints everywhere it should and nowhere an
 * occluder sits" is the claim the compositor and the user actually depend on. A test
 * pinned to a piece list would go red on a cheaper decomposition that is just as correct.
 */
describe("subtractRects — where a tile may still paint (T1102)", () => {
  const TILE: PreviewRect = { x: 100, y: 100, width: 200, height: 100 };

  /** Samples the clip on a grid: true iff some piece contains the point. */
  const covers = (pieces: ReadonlyArray<PreviewRect>, x: number, y: number): boolean =>
    pieces.some(
      (piece) =>
        x >= piece.x && x < piece.x + piece.width && y >= piece.y && y < piece.y + piece.height,
    );

  const totalArea = (pieces: ReadonlyArray<PreviewRect>): number =>
    pieces.reduce((sum, piece) => sum + piece.width * piece.height, 0);

  it("returns the whole rect when nothing is in front of it", () => {
    expect(subtractRects(TILE, [])).toEqual([TILE]);
    // An occluder that misses is not an occluder, whichever side it misses on.
    expect(subtractRects(TILE, [{ x: 0, y: 0, width: 100, height: 100 }])).toEqual([TILE]);
  });

  it("returns NOTHING when a node in front covers the tile — not the whole rect", () => {
    // The distinction the compositor reads: [] means composite nothing, [rect] means
    // composite everything. Conflating them is the difference between a hidden preview
    // and one painted over the node that hides it.
    expect(subtractRects(TILE, [{ x: 0, y: 0, width: 1000, height: 1000 }])).toEqual([]);
  });

  it("keeps every pixel outside the occluder and drops every pixel inside it", () => {
    // A node overlapping the tile's right half, hanging off the top and bottom edges.
    const occluder: PreviewRect = { x: 200, y: 50, width: 300, height: 200 };
    const pieces = subtractRects(TILE, [occluder]);

    for (let x = TILE.x; x < TILE.x + TILE.width; x += 5) {
      for (let y = TILE.y; y < TILE.y + TILE.height; y += 5) {
        const inside =
          x >= occluder.x &&
          x < occluder.x + occluder.width &&
          y >= occluder.y &&
          y < occluder.y + occluder.height;
        expect(covers(pieces, x, y), `(${x},${y}) inside=${String(inside)}`).toBe(!inside);
      }
    }
    // Exactly the left half survives: 100 × 100 of the tile's 200 × 100.
    expect(totalArea(pieces)).toBe(100 * 100);
  });

  it("emits DISJOINT pieces, so the compositor cannot double-blend an overlap", () => {
    // A hole punched in the middle — the case that produces all four strips at once, and
    // the one where a naive top/bottom/left/right split double-counts the corners.
    const pieces = subtractRects(TILE, [{ x: 150, y: 120, width: 40, height: 40 }]);
    expect(totalArea(pieces)).toBe(200 * 100 - 40 * 40);
    for (const [a, first] of pieces.entries()) {
      for (const [b, second] of pieces.entries()) {
        if (a >= b) continue;
        expect(rectsIntersect(first, second), `pieces ${a} and ${b} overlap`).toBe(false);
      }
    }
  });

  it("subtracts several occluders, and the result is independent of their order", () => {
    const a: PreviewRect = { x: 90, y: 90, width: 60, height: 200 };
    const b: PreviewRect = { x: 250, y: 90, width: 60, height: 200 };
    const forward = subtractRects(TILE, [a, b]);
    const backward = subtractRects(TILE, [b, a]);
    expect(totalArea(forward)).toBe(totalArea(backward));
    // Two vertical bites out of the ends leave the middle band: x 150..250.
    expect(totalArea(forward)).toBe(100 * 100);
    expect(covers(forward, 200, 150)).toBe(true);
    expect(covers(forward, 120, 150)).toBe(false);
    expect(covers(forward, 280, 150)).toBe(false);
  });

  it("does not blow up on a pile: the bound degrades to overdraw, never to a hang", () => {
    // 4^n pieces is the naive bound, so forty overlapping nodes must not be attempted.
    // What the cap costs is that some occluders stop being subtracted — the pre-T1102
    // behaviour in a corner — and what it buys is that this call returns at all.
    const many = Array.from({ length: 40 }, (_unused, index) => ({
      x: 100 + index * 3,
      y: 100 + index * 2,
      width: 7,
      height: 5,
    }));
    const started = Date.now();
    const pieces = subtractRects(TILE, many);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(pieces.length).toBeGreaterThan(0);
    // And the pieces are still a subset of the tile, whatever the cap dropped.
    for (const piece of pieces) {
      expect(piece.x).toBeGreaterThanOrEqual(TILE.x);
      expect(piece.y).toBeGreaterThanOrEqual(TILE.y);
      expect(piece.x + piece.width).toBeLessThanOrEqual(TILE.x + TILE.width);
      expect(piece.y + piece.height).toBeLessThanOrEqual(TILE.y + TILE.height);
    }
  });
});
