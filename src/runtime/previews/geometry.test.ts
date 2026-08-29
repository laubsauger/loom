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

  it("keeps the tile size constant across a zoom range inside one ladder step", () => {
    // The reason the ladder exists: a continuous physical size would reallocate every tile on
    // every frame of a zoom gesture, which is §V8 violated in the most expensive way going.
    // 128 * [0.8 .. 1.0] spans 102.4 .. 128, entirely inside the 96 -> 128 step.
    const sizes = [0.8, 0.85, 0.9, 0.95, 1.0].map(
      (zoom) =>
        tileSizeFor({
          sourceSize: [1280, 720],
          onScreenLongEdge: 128 * zoom,
          devicePixelRatio: 1,
          maxLongEdge: 384,
        })[0],
    );
    expect(new Set(sizes).size).toBe(1);
  });
});

describe("device pixel ratio and zoom multiply", () => {
  it("asks for more pixels on a high-density display", () => {
    const at1 = tileSizeFor({
      sourceSize: [1280, 720],
      onScreenLongEdge: 96,
      devicePixelRatio: 1,
      maxLongEdge: 384,
    });
    const at2 = tileSizeFor({
      sourceSize: [1280, 720],
      onScreenLongEdge: 96,
      devicePixelRatio: 2,
      maxLongEdge: 384,
    });
    expect(at1[0]).toBe(96);
    expect(at2[0]).toBe(192);
  });

  it("never exceeds the cap, whatever zoom and density ask for", () => {
    const cap = 192 * MAX_TILE_SCALE;
    const size = tileSizeFor({
      sourceSize: [1280, 720],
      onScreenLongEdge: 192 * 2.5,
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
