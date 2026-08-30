import { describe, expect, it } from "vitest";
import { fitInsideRegion } from "./preview-fit.ts";

/**
 * §V118's arithmetic, in the cases the composed test cannot stage.
 *
 * The gesture-level proof — that the ALLOCATED tile and the DRAWN rect agree — lives in
 * `src/tests/integration/preview-letterbox.test.tsx`. What is here is the other
 * orientation, and the degenerate inputs a real first frame produces.
 */

describe("fitInsideRegion (§V118)", () => {
  it("pillarboxes a tall image in a wide region", () => {
    // 16:9 region, square image: bars left and right, image fills the height.
    expect(fitInsideRegion({ width: 160, height: 90 }, [512, 512])).toEqual({
      x: 35,
      y: 0,
      width: 90,
      height: 90,
    });
  });

  it("letterboxes a wide image in a tall region", () => {
    // The mirror case, which a resized node makes ordinary rather than exotic (T208).
    expect(fitInsideRegion({ width: 100, height: 200 }, [1920, 1080])).toEqual({
      x: 0,
      y: 71.875,
      width: 100,
      height: 56.25,
    });
  });

  it("changes nothing when the aspects already agree", () => {
    // No bars, and — because the tile is sized from this box — no wasted allocation.
    expect(fitInsideRegion({ width: 320, height: 180 }, [1920, 1080])).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 180,
    });
  });

  it("falls back to the region when there is nothing to fit against", () => {
    // A slot measured before layout, or an output whose size has not resolved yet. A
    // zero-sized box would suspend the preview as `too-small` (§V28) for a reason the
    // user cannot see and would never guess.
    expect(fitInsideRegion({ width: 160, height: 90 }, [0, 0])).toEqual({
      x: 0,
      y: 0,
      width: 160,
      height: 90,
    });
    expect(fitInsideRegion({ width: 0, height: 0 }, [512, 512])).toEqual({
      x: 0,
      y: 0,
      width: 0,
      height: 0,
    });
  });
});
