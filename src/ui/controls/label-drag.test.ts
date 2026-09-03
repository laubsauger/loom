import { describe, expect, it } from "vitest";
import { valueFromDrag } from "./drag-math.ts";
import {
  describeLabelDrag,
  movableMask,
  valuesFromLabelDrag,
  valuesFromLabelNudge,
  type LabelDragChannel,
} from "./label-drag.ts";
import type { NumericSpec } from "./types.ts";

/**
 * T1026 — the maths of dragging a parameter's NAME to move every channel at once.
 *
 * The pure half. What is asserted here is the DESIGN DECISION, not the arithmetic: that
 * the gesture is additive (preserving differences, not ratios), that it is bit-identical
 * to the one a single field runs, and that a channel decided by another mode is left
 * exactly where it was. Each of those is a thing a future change could quietly reverse.
 */

/** No declared step: `dragStepFor` derives (100 - -100)/100 = 2 per `PIXELS_PER_STEP`. */
const spec: NumericSpec = { min: -100, max: 100 };

const statics = (...names: string[]): readonly LabelDragChannel[] =>
  names.map((name) => ({ name, drivenBy: null }));

describe("T1026 — a label drag is ADDITIVE, and is the field's own drag", () => {
  it("moves every channel by the same delta, preserving the DIFFERENCE not the ratio", () => {
    const next = valuesFromLabelDrag({
      startValues: [2, 3],
      channels: statics("x", "y"),
      deltaX: 2,
      spec,
      modifier: "normal",
    });

    // 2px of travel is one `dragStepFor` of 2, so both channels gain exactly 2.
    expect(next).toEqual([4, 5]);
    // The load-bearing assertion: the gap is what survives. A proportional gesture would
    // have produced [4, 6] here — same first channel, different second — so this fails the
    // moment someone swaps the maths for a ratio.
    expect(next[1]! - next[0]!).toBe(3 - 2);
  });

  it("is the SAME function a single field's drag runs — not a second calibration", () => {
    const startValues = [1, -4, 0.5];
    const channels = statics("x", "y", "z");
    for (const modifier of ["fine", "normal", "coarse"] as const) {
      for (const deltaX of [-37, -3, 0, 11, 250]) {
        const together = valuesFromLabelDrag({ startValues, channels, deltaX, spec, modifier });
        const alone = startValues.map((startValue) =>
          valueFromDrag({ startValue, deltaX, spec, modifier }),
        );
        // Criterion: the name must not feel like a differently-geared control. If the two
        // ever diverge, dragging "Offset" and dragging "Offset x" disagree about x.
        expect(together, `${modifier} @ ${deltaX}px`).toEqual(alone);
      }
    }
  });

  it("clamps each channel into the declared range independently", () => {
    // The reason the docblock refuses a ratio: once y pins at max, an aspect the gesture
    // promised would already be gone, silently. Additive drift is at least visible.
    const next = valuesFromLabelDrag({
      startValues: [0, 90],
      channels: statics("x", "y"),
      deltaX: 40,
      spec,
      modifier: "normal",
    });
    expect(next).toEqual([40, 100]);
  });

  it("leaves a channel that another mode decides exactly where it was", () => {
    const channels: readonly LabelDragChannel[] = [
      { name: "x", drivenBy: null },
      { name: "y", drivenBy: "Expression" },
      { name: "z", drivenBy: null },
    ];
    const next = valuesFromLabelDrag({
      startValues: [1, 2, 3],
      channels,
      deltaX: 10,
      spec,
      modifier: "normal",
    });
    // y is byte-identical, and x and z moved by the full step — a gesture that "shared"
    // the delta with the driven channel, or scaled it down, would fail here too.
    expect(next).toEqual([11, 2, 13]);
    expect(movableMask(channels)).toEqual([true, false, true]);
  });

  it("nudges every eligible channel by one step, and no driven one", () => {
    const channels: readonly LabelDragChannel[] = [
      { name: "x", drivenBy: null },
      { name: "y", drivenBy: "Bind" },
    ];
    expect(
      valuesFromLabelNudge({ values: [1, 2], channels, direction: 1, spec, modifier: "normal" }),
    ).toEqual([3, 2]);
    expect(
      valuesFromLabelNudge({ values: [1, 2], channels, direction: -1, spec, modifier: "normal" }),
    ).toEqual([-1, 2]);
  });
});

describe("§V830 — the label states what it will and will not move", () => {
  it("names the channels it moves", () => {
    expect(describeLabelDrag(statics("x", "y"))).toBe("Drag the name to move x and y together.");
    expect(describeLabelDrag(statics("x", "y", "z"))).toBe(
      "Drag the name to move x, y and z together.",
    );
  });

  it("names the channel it will NOT move, and what owns it", () => {
    const text = describeLabelDrag([
      { name: "x", drivenBy: null },
      { name: "y", drivenBy: "Expression" },
    ]);
    // A partial gesture that said nothing would be the interface quietly doing less than
    // the user asked, which is the whole of §V830's complaint.
    expect(text).toBe("Drag the name to move x together; y (Expression) stays with its own mode.");
  });

  it("explains the refusal rather than going silent when nothing can move", () => {
    const text = describeLabelDrag([
      { name: "x", drivenBy: "Bind" },
      { name: "y", drivenBy: "Expression" },
    ]);
    expect(text).toBe(
      "Every channel is decided by its own mode — x (Bind) and y (Expression) — so dragging the name cannot move them.",
    );
    // Never "disabled", never blank: the sentence has to name both modes.
    expect(text).toContain("Bind");
    expect(text).toContain("Expression");
  });
});
