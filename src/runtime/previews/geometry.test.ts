import { describe, expect, it } from "vitest";
import {
  MAX_TILE_SCALE,
  TILE_SIZE_LADDER,
  ladderSnap,
  rectsIntersect,
  slotScreenRect,
  tileSizeFor,
} from "./geometry.ts";

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
