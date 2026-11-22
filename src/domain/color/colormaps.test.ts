import { describe, expect, it } from "vitest";
import { COLORMAPS, COLORMAP_IDS, COLORMAP_WGSL, colormapIndex, colormapRgb } from "./colormaps.ts";

/**
 * Owner 2026-11-22 — colour maps for depth previews. The table is shared by the node preview
 * (WGSL) and the photo surface (CPU), so its values are pinned here against the published
 * maps' own end points, and its direction against what a depth map needs: near (high) red
 * in Turbo and Spectral.
 */
const byte = (id: (typeof COLORMAP_IDS)[number], t: number) => colormapRgb(id, t).map((value) => Math.round(value * 255));
const luminance = ([r, g, b]: readonly number[]) => 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;

describe("the shared colour maps", () => {
  it("runs Turbo and Spectral blue (far, low) to red (near, high)", () => {
    // A tenth in from each end: Turbo's polynomial fit is dark and nearly neutral at its very
    // ends (0.14, 0.09, 0.11 at 0), where the published map is too.
    for (const id of ["turbo", "spectral"] as const) {
      const [lowR, , lowB] = colormapRgb(id, 0.1);
      const [highR, , highB] = colormapRgb(id, 0.9);
      expect(lowB, id).toBeGreaterThan(lowR);
      expect(highR, id).toBeGreaterThan(highB);
    }
  });

  it("ends Spectral exactly on ColorBrewer's two outer classes", () => {
    expect(byte("spectral", 0)).toEqual([0x5e, 0x4f, 0xa2]);
    expect(byte("spectral", 1)).toEqual([0x9e, 0x01, 0x42]);
  });

  it("matches the published Viridis and Inferno end points to within the fits' own error", () => {
    const near = (got: readonly number[], want: readonly number[]) =>
      got.forEach((value, index) => expect(Math.abs(value - want[index]!)).toBeLessThanOrEqual(8));
    near(byte("viridis", 0), [68, 1, 84]);
    near(byte("viridis", 1), [253, 231, 37]);
    near(byte("inferno", 0), [0, 0, 4]);
    near(byte("inferno", 1), [252, 255, 164]);
  });

  it("makes Viridis and Inferno brighter at every step, the property they are chosen for", () => {
    for (const id of ["viridis", "inferno"] as const) {
      let previous = -1;
      for (let step = 0; step <= 64; step += 1) {
        const current = luminance(colormapRgb(id, step / 64));
        expect(current, `${id} at ${step}`).toBeGreaterThan(previous);
        previous = current;
      }
    }
  });

  it("clamps out-of-range and non-finite values to the ends", () => {
    expect(colormapRgb("turbo", -2)).toEqual(colormapRgb("turbo", 0));
    expect(colormapRgb("turbo", 5)).toEqual(colormapRgb("turbo", 1));
    expect(colormapRgb("turbo", Number.NaN)).toEqual(colormapRgb("turbo", 0));
  });

  it("numbers the maps for the shader from 1, 0 being the picture, and emits one function each", () => {
    expect(colormapIndex("none")).toBe(0);
    expect(COLORMAP_IDS.map(colormapIndex)).toEqual([1, 2, 3, 4]);
    for (let index = 1; index <= COLORMAPS.length; index += 1) {
      expect(COLORMAP_WGSL).toContain(`fn colormap${index}(x: f32) -> vec3f`);
      expect(COLORMAP_WGSL).toContain(`case ${index}u: { return colormap${index}(x); }`);
    }
  });
});
