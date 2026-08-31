import { describe, expect, it } from "vitest";
import { gridLevel } from "./graph-grid.ts";

/**
 * T717 — the grid's level-of-detail, asserted as the property it exists for.
 *
 * The row is about a grid that "doesnt become useless at further zoom outs", and useless
 * has a precise meaning here: the SCREEN spacing between dots left the range a person can
 * read as a grid. So the assertions are about `gap * zoom`, swept across the whole zoom
 * range, rather than a handful of remembered gap values — a table of expected gaps would
 * pass just as happily with the cross-fade deleted or the octave inverted.
 */

/** React Flow's configured range on this canvas (`graph-canvas.tsx`). */
const MIN_ZOOM = 0.05;
const MAX_ZOOM = 8;
const BASE_GAP = 16;

/** A dense logarithmic sweep — the boundaries are where quantisation misbehaves. */
function zoomSweep(): number[] {
  const zooms: number[] = [];
  for (let i = 0; i <= 400; i++) {
    zooms.push(MIN_ZOOM * (MAX_ZOOM / MIN_ZOOM) ** (i / 400));
  }
  // And the exact octave boundaries, where `ceil` changes its mind.
  for (const level of [-3, -2, -1, 0, 1, 2, 3, 4]) zooms.push(2 ** -level);
  return zooms;
}

describe("T717 — the dot grid adapts its density to the zoom", () => {
  it("keeps the on-screen dot spacing inside one octave at every zoom", () => {
    // The claim, stated as a range: never tighter than the designed pitch (which is what
    // made it a wash when zoomed out) and never looser than twice it (which is what made
    // it too sparse to read). A fixed gap fails this at both ends.
    for (const zoom of zoomSweep()) {
      const screenSpacing = gridLevel(zoom).gap * zoom;
      expect(screenSpacing).toBeGreaterThanOrEqual(BASE_GAP - 1e-9);
      expect(screenSpacing).toBeLessThan(BASE_GAP * 2 + 1e-9);
    }
  });

  it("keeps the drawn dot the same size on screen at every zoom", () => {
    /*
     * The half that the spacing arithmetic alone does not give you, and that a numeric
     * check alone did not catch — it took a screenshot. React Flow scales `size` by the
     * zoom, so at zoom 0.16 a fixed size of 1.5 draws a 0.24px dot: the spacing was
     * correct, every number looked right, and the graph was a flat ground with no grid on
     * it at all. §V655's shape exactly, so this asserts the thing a viewer can see.
     */
    for (const zoom of zoomSweep()) {
      const { dotSize } = gridLevel(zoom);
      expect(dotSize * zoom).toBeCloseTo(1.5, 9);
    }
  });

  it("would FAIL for a fixed gap, which is the state this replaces", () => {
    // Non-vacuity, and the honest form of it: the sweep really does exercise zooms where
    // the old behaviour was broken, so a green tick above means something changed.
    const fixed = zoomSweep().map((zoom) => BASE_GAP * zoom);
    expect(Math.min(...fixed)).toBeLessThan(BASE_GAP);
    expect(Math.max(...fixed)).toBeGreaterThan(BASE_GAP * 2);
  });

  it("hands over between layers with no jump in spacing at an octave boundary", () => {
    /*
     * The pop this row's design exists to avoid, stated as what a viewer sees.
     *
     * Zooming OUT across a boundary, the quantised gap doubles — that is the jump. What
     * stops it being visible is that the newly-doubled coarse layer arrives alongside a
     * fine layer at full opacity sitting on exactly the pitch the coarse layer occupied a
     * moment earlier. The dots a person sees are in the same places, at the same tone,
     * on both sides of the line.
     *
     * (Where the two layers coincide the fine dot is drawn over an already-opaque coarse
     * dot in the same colour, so a coincident dot cannot darken — which is what lets the
     * fine layer carry a partial opacity without the shared positions pulsing.)
     */
    for (const level of [-2, -1, 0, 1, 2, 3]) {
      const boundary = 2 ** -level;
      // Zoomed IN a hair from the boundary — the tight side, still in the lower octave.
      const zoomedIn = gridLevel(boundary * 1.0001);
      // Zoomed OUT a hair — the level has just incremented and the gap has just doubled.
      const zoomedOut = gridLevel(boundary * 0.9999);

      expect(zoomedOut.gap).toBeCloseTo(zoomedIn.gap * 2, 6);
      // The pitch the viewer was looking at survives the crossing, at full strength...
      expect(zoomedOut.fineGap).toBeCloseTo(zoomedIn.gap, 6);
      expect(zoomedOut.fineOpacity).toBeGreaterThan(0.99);
      // ...and on the tight side nothing else is drawn to vanish at the boundary.
      expect(zoomedIn.fineOpacity).toBeLessThan(0.01);
    }
  });

  it("fades the fine layer monotonically across an octave, never stepping", () => {
    // Inside one octave the fade must be continuous — a step here is the pop moved from
    // the spacing into the opacity, which looks just as wrong while zooming.
    let previous = gridLevel(0.51).fineOpacity;
    for (let zoom = 0.51; zoom <= 0.99; zoom += 0.01) {
      const current = gridLevel(zoom).fineOpacity;
      expect(current).toBeGreaterThanOrEqual(previous - 1e-9);
      expect(Math.abs(current - previous)).toBeLessThan(0.05);
      previous = current;
    }
    expect(previous).toBeGreaterThan(0.9);
  });

  it("survives the unlaid-out pane rather than dividing by its zero zoom", () => {
    // §V66: zoom is 0 before layout, and -log2(0) is Infinity — an Infinite gap draws no
    // grid at all, silently, which is exactly the class of bug this file is guarding.
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const level = gridLevel(bad);
      expect(Number.isFinite(level.gap)).toBe(true);
      expect(level.gap).toBeGreaterThan(0);
      expect(Number.isFinite(level.fineOpacity)).toBe(true);
    }
  });
});
