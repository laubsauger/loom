// @vitest-environment jsdom
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import {
  DECADE_LADDER,
  decadeForModifier,
  decimalsForDecade,
  defaultDecade,
  normalizeAtDecade,
  shiftDecade,
  valueFromDrag,
} from "./drag-math.ts";
import { NumberField } from "./number-field.tsx";
import type { EditPhase, NumericSpec } from "./types.ts";

/**
 * T228 / §V133 / §V134 — the magnitude ladder.
 *
 * Precision spans decades, and three fixed modifier levels cannot: the same field has to
 * reach 0.0001 and 100 without the user going and editing a `step`. The ladder makes the
 * reach a thing you PICK and, more importantly, a thing you can SEE — which is what beats
 * adding a fourth modifier key nobody would remember.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const spec: NumericSpec = { min: 0, max: 100, step: 1 };

describe("§V133 — the ladder covers the decades the modifiers cannot", () => {
  it("offers a fixed set of rungs, identical in every field", () => {
    expect([...DECADE_LADDER]).toEqual([0.001, 0.01, 0.1, 1, 10, 100]);
  });

  it("starts a field on the rung the manifest step implies — a default, not a cap", () => {
    expect(defaultDecade({ step: 1 })).toBe(1);
    expect(defaultDecade({ step: 0.05 })).toBe(0.01);
    expect(defaultDecade({ step: 250 })).toBe(100);
    // Below the ladder: the finest rung, so the field is still draggable.
    expect(defaultDecade({ step: 0.00001 })).toBe(0.001);
  });

  it("still gives the modifiers ±1 decade, now measured from the chosen rung", () => {
    expect(decadeForModifier(0.1, "fine")).toBe(0.01);
    expect(decadeForModifier(0.1, "normal")).toBe(0.1);
    expect(decadeForModifier(0.1, "coarse")).toBe(1);
    // NOT clamped to the ladder: the finest rung plus shift is how 0.0001 is reached,
    // and putting it out of reach would defeat the invariant the ladder exists for.
    expect(decadeForModifier(0.001, "fine")).toBeCloseTo(0.0001, 10);
    expect(decadeForModifier(100, "coarse")).toBe(1000);
  });

  it("reaches 0.0001 and 100 from ONE field, which is the whole requirement", () => {
    const wide: NumericSpec = { step: 1 };
    const fine = valueFromDrag({ startValue: 0, deltaX: 2, spec: wide, modifier: "fine", decade: 0.001 });
    expect(fine).toBe(0.0001);
    const coarse = valueFromDrag({ startValue: 0, deltaX: 2, spec: wide, modifier: "coarse", decade: 100 });
    expect(coarse).toBe(1000);
  });

  it("leaves the drag untouched when no rung has been picked", () => {
    const before = valueFromDrag({ startValue: 10, deltaX: 20, spec, modifier: "normal" });
    expect(before).toBe(20);
  });
});

describe("§V134 — reach must not cost exactness", () => {
  it("lands every value on the chosen decade's grid", () => {
    for (const decade of DECADE_LADDER) {
      const value = normalizeAtDecade(0.1234567, { }, decade);
      const steps = value / decade;
      expect(Math.abs(steps - Math.round(steps))).toBeLessThan(1e-9);
    }
  });

  it("writes 0.3 rather than 0.30000000000000004 — the failure this exists to prevent", () => {
    expect(normalizeAtDecade(0.1 + 0.2, {}, 0.1)).toBe(0.3);
    expect(String(normalizeAtDecade(0.1 + 0.2, {}, 0.1))).toBe("0.3");
  });

  it("treats the manifest precision as a floor, never a ceiling", () => {
    // A `precision: 2` parameter dragged at 0.001 must still resolve 0.001 — capping at
    // the declared precision would round every rung to the same number and the ladder
    // would silently do nothing.
    expect(decimalsForDecade({ precision: 2 }, 0.001)).toBe(3);
    expect(decimalsForDecade({ precision: 4 }, 1)).toBe(4);
    expect(normalizeAtDecade(0.002, { precision: 2 }, 0.001)).toBe(0.002);
  });

  it("keeps clamping to the declared range", () => {
    expect(normalizeAtDecade(500, { min: 0, max: 100 }, 10)).toBe(100);
    expect(normalizeAtDecade(-5, { min: 0, max: 100 }, 10)).toBe(0);
  });

  it("walks the ladder without drifting off it", () => {
    expect(shiftDecade(1, 2)).toBe(100);
    expect(shiftDecade(1, -3)).toBe(0.001);
    expect(shiftDecade(0.01, 1)).toBe(0.1);
  });
});

function Harness({ onEmit }: { onEmit: (value: number, phase: EditPhase) => void }) {
  const [value, setValue] = useState(0);
  return (
    <NumberField
      label="Radius"
      value={value}
      defaultValue={0}
      spec={{ step: 1 }}
      onChange={(next, phase) => {
        setValue(next);
        onEmit(next, phase);
      }}
    />
  );
}

describe("§V133/§V19 — the ladder is reachable, and picking a rung changes the drag", () => {
  it("appears on press-and-hold and marks the rung the field is on", async () => {
    render(<Harness onEmit={() => {}} />);
    const surface = screen.getByRole("spinbutton", { name: "Radius" }).parentElement as HTMLElement;

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 0 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });

    const ladder = screen.getByRole("listbox", { name: "Radius drag magnitude" });
    expect(ladder).toBeDefined();
    const rungs = screen.getAllByRole("option");
    expect(rungs.map((rung) => rung.textContent)).toEqual(["0.001", "0.01", "0.1", "1", "10", "100"]);
    expect(rungs.find((rung) => rung.getAttribute("aria-selected") === "true")?.textContent).toBe("1");
  });

  it("drags at the picked rung afterwards", async () => {
    const emitted: number[] = [];
    render(<Harness onEmit={(value) => emitted.push(value)} />);
    const surface = screen.getByRole("spinbutton", { name: "Radius" }).parentElement as HTMLElement;

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 0 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    fireEvent.click(screen.getByRole("option", { name: "0.01" }));

    fireEvent.pointerDown(surface, { button: 0, pointerId: 2, clientX: 0 });
    fireEvent.pointerMove(surface, { pointerId: 2, clientX: 20 });
    fireEvent.pointerUp(surface, { pointerId: 2, clientX: 20 });

    // 20px at 2px per step, at 0.01 per step — not the manifest's 1.
    expect(emitted.at(-1)).toBe(0.1);
  });

  it("opens from the keyboard too, so the reach is not pointer-only (§V19)", () => {
    render(<Harness onEmit={() => {}} />);
    const field = screen.getByRole("spinbutton", { name: "Radius" });
    fireEvent.keyDown(field, { key: "ArrowDown", metaKey: true });

    const rungs = screen.getAllByRole("option");
    expect(rungs.find((rung) => rung.getAttribute("aria-selected") === "true")?.textContent).toBe("0.1");
  });

  it("does not begin a drag or a text edit when the hold opened the ladder", async () => {
    const emitted: number[] = [];
    render(<Harness onEmit={(value) => emitted.push(value)} />);
    const surface = screen.getByRole("spinbutton", { name: "Radius" }).parentElement as HTMLElement;

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 0 });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 500));
    });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 0 });

    expect(emitted).toEqual([]);
    expect(screen.getByRole("spinbutton", { name: "Radius" }).getAttribute("readonly")).not.toBeNull();
  });
});
