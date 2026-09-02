import { describe, expect, it } from "vitest";
import { TILE_SIZE_LADDER } from "@runtime/previews/index.ts";
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

  /**
   * T540 — THE SLOT IS 16:9 AND A 16:9 OUTPUT FILLS IT, WITH NOTHING SHOWING THROUGH.
   *
   * The owner: "theres an extra border inside the area of the preview that needs to go."
   * MEASURED before choosing a cause, at 4.9× zoom on E4: 4 device px of ground down the
   * left, 5 down the right, and a 1015×571 tile inside a 1024×576 slot.
   *
   * It was NOT T490's ladder — every rung is exactly 16:9 for a 1280×720 source (384→216,
   * 576→324, 864→486, 1152→648, all integral). It was `.preview`: `aspect-ratio: 16 / 9`
   * under the global `border-box`, so the hairline BELOW the tile came out of the 16:9
   * height and the box this function is handed was 16:(9 − hairline). A 16:9 output
   * letterboxed inside it by half a pixel per side — invisible at 1:1, a band at zoom.
   *
   * `.preview` is `box-sizing: content-box` now, so the ratio governs the box the tile is
   * fitted into. This pins the arithmetic of that; `node-box.spec.ts` pins the same
   * numbers against a real browser, and `layout.test.ts` against the model.
   */
  it("a 16:9 output fills a 16:9 slot exactly — no bars at all (T540)", () => {
    // The real slot at the shipped node width: 178 − 2px node border = 176 content px,
    // and 176 × 9/16 = 99 exactly. Both numbers measured in Chrome.
    const slot = { width: 176, height: 99 };
    expect(slot.width / slot.height).toBeCloseTo(16 / 9, 12);
    expect(fitInsideRegion(slot, [1280, 720])).toEqual({ x: 0, y: 0, width: 176, height: 99 });
    // Every ladder rung a budgeted tile can land on, for the same source — read from
    // the ladder itself, because T891 added two rungs above 1152 and a copied list is
    // how a test quietly stops covering what it names (§V723).
    for (const rung of TILE_SIZE_LADDER) {
      const tile: readonly [number, number] = [rung, Math.round((rung * 720) / 1280)];
      expect([rung, fitInsideRegion(slot, tile)]).toEqual([
        rung,
        { x: 0, y: 0, width: 176, height: 99 },
      ]);
    }
    // SENSITIVITY, as arithmetic: the box it used to be handed — one hairline shorter —
    // is what put the band on screen. Naming the wrong number is what keeps it named.
    const beforeT540 = { width: 176, height: 98 };
    const fitted = fitInsideRegion(beforeT540, [1280, 720]);
    expect(fitted.width).toBeLessThan(beforeT540.width);
    expect(fitted.x).toBeGreaterThan(0);
  });

  /**
   * And the letterbox that MUST stay: a synthesized preview is square (T502 — the base
   * tile, 384×384), and squeezing it into a 16:9 slot would misrepresent the picture on
   * exactly the node someone opened to look at it (§V118). The ground showing beside a
   * square preview is the letterbox doing its job, not T540's band.
   */
  it("a square preview still letterboxes inside the 16:9 slot (§V118)", () => {
    const fitted = fitInsideRegion({ width: 176, height: 99 }, [384, 384]);
    expect(fitted).toEqual({ x: (176 - 99) / 2, y: 0, width: 99, height: 99 });
  });
});
