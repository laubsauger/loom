import { describe, expect, it } from "vitest";
import { createPointerSource, normalizedPointer } from "./pointer.ts";

/**
 * The pointer's coordinate contract (T324, §V236, §V182).
 *
 * Every number here is a decision the ruling made explicitly, and each one is wrong in a
 * different way if reversed — so each gets a test rather than a comment.
 */

const RECT = { left: 100, top: 50, width: 200, height: 100 };

describe("normalizedPointer — 0..1 across the VIEWER's rect, v DOWN (§V236)", () => {
  it("puts the origin at the rect's top-left, not the window's", () => {
    // The rect is offset by (100, 50): a window-normalised answer would report the cursor
    // somewhere else entirely, and would move every time the user resized a pane.
    expect(normalizedPointer({ x: 100, y: 50 }, RECT)).toEqual({ x: 0, y: 0 });
    expect(normalizedPointer({ x: 300, y: 150 }, RECT)).toEqual({ x: 1, y: 1 });
  });

  it("measures v DOWNWARD, matching the uv convention shaders read", () => {
    // Our fragment coordinate and the `uv` generator both run v down. A flipped v here
    // would put the cursor's reflection on screen — visibly wrong, and only at the top or
    // bottom of a gesture, which is exactly the kind of thing that ships.
    const upper = normalizedPointer({ x: 200, y: 75 }, RECT);
    const lower = normalizedPointer({ x: 200, y: 125 }, RECT);
    expect(upper?.y).toBeCloseTo(0.25, 12);
    expect(lower?.y).toBeCloseTo(0.75, 12);
    expect(lower?.y).toBeGreaterThan(upper?.y ?? 0);
  });

  it("returns null OUTSIDE the rect rather than clamping (§V236's hold)", () => {
    // Null is what makes "hold" possible: the publisher writes nothing, so the last real
    // position stands. A clamped edge value would be a position the cursor is not at,
    // reported as though it were.
    expect(normalizedPointer({ x: 99, y: 100 }, RECT)).toBeNull();
    expect(normalizedPointer({ x: 301, y: 100 }, RECT)).toBeNull();
    expect(normalizedPointer({ x: 200, y: 49 }, RECT)).toBeNull();
    expect(normalizedPointer({ x: 200, y: 151 }, RECT)).toBeNull();
  });

  it("refuses a degenerate rect instead of dividing by zero", () => {
    // A pane that is laid out but not yet measured has width 0. NaN reaching a uniform is
    // a shader that renders nothing, with no error anywhere to explain it.
    expect(normalizedPointer({ x: 0, y: 0 }, { left: 0, top: 0, width: 0, height: 100 })).toBeNull();
    expect(normalizedPointer({ x: 0, y: 0 }, { left: 0, top: 0, width: 200, height: 0 })).toBeNull();
  });
});

describe("PointerSource — a partial write leaves the rest alone", () => {
  it("holds what it is not told about, which is what makes 'hold' work at all", () => {
    const source = createPointerSource();
    source.set({ x: 0.25, y: 0.75, buttons: 1 });
    expect(source.state).toEqual({ x: 0.25, y: 0.75, buttons: 1 });

    // A button release with no movement must not move the cursor.
    source.set({ buttons: 0 });
    expect(source.state).toEqual({ x: 0.25, y: 0.75, buttons: 0 });
  });
});
