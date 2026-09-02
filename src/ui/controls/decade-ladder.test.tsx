// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

/**
 * T912 — THE LADDER NEEDED A WAY IN THAT ANYONE CAN SEE.
 *
 * Owner, knowing the feature exists: *"we still dont see a separate little swatch on
 * parameter hover that allows us to deliberately popout the precision selector"*. That is
 * the strongest form of a discoverability report — a user who already knows the gesture
 * still calls it weird — and it is not answered by teaching anyone the gesture. So the
 * swatch is an ADDITION: the hold above and `mod+↑/↓` above stay exactly as they are, and
 * the assertions here are about a THIRD door onto the SAME `ladderOpen`, not a
 * replacement. The `describe` above is what makes that claim; deleting either of its two
 * entry-point tests to make these pass would be the regression.
 */
function swatch(name = "Radius"): HTMLElement {
  return screen.getByRole("button", { name: `${name} drag magnitude` });
}

describe("T912 — the ladder opens from a visible affordance", () => {
  it("opens the same ladder the hold opens", () => {
    render(<Harness onEmit={() => {}} />);
    expect(screen.queryByRole("listbox")).toBeNull();

    fireEvent.click(swatch());

    expect(screen.getByRole("listbox", { name: "Radius drag magnitude" })).toBeDefined();
    expect(screen.getAllByRole("option").map((rung) => rung.textContent)).toEqual([
      "0.001", "0.01", "0.1", "1", "10", "100",
    ]);
  });

  it("shares ONE piece of state with the keyboard path, not a second ladder", () => {
    render(<Harness onEmit={() => {}} />);

    // Pick 0.01 through the swatch...
    fireEvent.click(swatch());
    fireEvent.click(screen.getByRole("option", { name: "0.01" }));
    expect(screen.queryByRole("listbox")).toBeNull();

    // ...and the keyboard path walks from THAT rung. A swatch wired to its own state
    // would show the manifest's 1 shifted to 10 here.
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Radius" }), {
      key: "ArrowUp",
      metaKey: true,
    });
    expect(
      screen.getAllByRole("option").find((rung) => rung.getAttribute("aria-selected") === "true")
        ?.textContent,
    ).toBe("0.1");
  });

  it("picks a rung that then governs the drag, exactly as the hold's rung does", () => {
    const emitted: number[] = [];
    render(<Harness onEmit={(value) => emitted.push(value)} />);
    const surface = screen.getByRole("spinbutton", { name: "Radius" }).parentElement as HTMLElement;

    fireEvent.click(swatch());
    fireEvent.click(screen.getByRole("option", { name: "0.01" }));

    fireEvent.pointerDown(surface, { button: 0, pointerId: 3, clientX: 0 });
    fireEvent.pointerMove(surface, { pointerId: 3, clientX: 20 });
    fireEvent.pointerUp(surface, { pointerId: 3, clientX: 20 });

    // 20px at 2px per step, at 0.01 per step — not the manifest's 1.
    expect(emitted.at(-1)).toBe(0.1);
  });

  it("is outside the drag surface, so it can neither drag the value nor reset it", () => {
    const emitted: number[] = [];
    render(<Harness onEmit={(value) => emitted.push(value)} />);
    const surface = screen.getByRole("spinbutton", { name: "Radius" }).parentElement as HTMLElement;

    // Structural, not incidental: `.number` carries the drag, the hold and the
    // double-click-to-reset. Nothing dispatched on the swatch can reach any of them.
    expect(surface.contains(swatch())).toBe(false);

    fireEvent.pointerDown(swatch(), { button: 0, pointerId: 4, clientX: 0 });
    fireEvent.click(swatch());
    fireEvent.doubleClick(swatch());

    expect(emitted).toEqual([]);
    expect(screen.getByRole("spinbutton", { name: "Radius" }).getAttribute("readonly")).not.toBeNull();
  });

  it("carries React Flow's nodrag opt-out, which being outside `.number` costs it", () => {
    render(<Harness onEmit={() => {}} />);
    // `.number` has the class; the swatch is not inside it, so it needs its own or a
    // press on it starts a NODE drag inside the graph (§V20, T228's belt-and-braces).
    // React Flow reads exactly this: `target.closest('.nodrag')` on the pointerdown.
    expect(swatch().className.split(/\s+/)).toContain("nodrag");
  });

  it("lets no press escape to an ancestor — the braces to nodrag's belt (§V20)", () => {
    // The other half of the opt-out, and the one that does not depend on React Flow's
    // class name staying `nodrag`: a node body listens for pointerdown to begin its drag,
    // so the swatch's press must not reach one. Asserted against a real listener on a
    // real ancestor rather than by reading the handler.
    const seen: string[] = [];
    const { container } = render(
      <div onPointerDown={() => seen.push("ancestor")}>
        <Harness onEmit={() => {}} />
      </div>,
    );
    expect(container.firstElementChild?.contains(swatch())).toBe(true);

    fireEvent.pointerDown(swatch(), { button: 0, pointerId: 5, clientX: 0 });
    expect(seen).toEqual([]);

    // Non-vacuity: the same press on the drag surface is stopped too, so the harness
    // above is genuinely wired and this is not an assertion about an inert wrapper.
    const surface = screen.getByRole("spinbutton", { name: "Radius" }).parentElement as HTMLElement;
    fireEvent.pointerDown(surface, { button: 0, pointerId: 6, clientX: 0 });
    expect(seen).toEqual([]);
    // ...whereas anywhere else in that wrapper does reach it.
    fireEvent.pointerDown(container.firstElementChild as HTMLElement, { button: 0, pointerId: 7 });
    expect(seen).toEqual(["ancestor"]);
  });

  it("is a real button in the tab order, not a hover-only mark (§V19)", () => {
    render(<Harness onEmit={() => {}} />);
    const button = swatch();
    expect(button.tagName).toBe("BUTTON");
    expect(button.getAttribute("tabindex")).toBeNull();
    expect(button.getAttribute("aria-haspopup")).toBe("listbox");
    expect(button.getAttribute("aria-expanded")).toBe("false");

    button.focus();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    expect(swatch().getAttribute("aria-expanded")).toBe("true");
  });

  it("is not offered on a parameter that cannot be edited", () => {
    render(
      <NumberField label="Radius" value={0} defaultValue={0} spec={{ step: 1 }} disabled onChange={() => {}} />,
    );
    expect(screen.queryByRole("button", { name: "Radius drag magnitude" })).toBeNull();
  });
});

/**
 * The popout's WIDTH, the other half of T912.
 *
 * ## Why this reads CSS instead of measuring the box
 *
 * jsdom applies no stylesheet and lays nothing out, so every `getBoundingClientRect` in
 * this file is 0×0 — a rendered assertion here would pass against a ladder stretched to
 * the full width of the input, which is precisely the defect. The honest thing this
 * environment can check is the DECLARATION that produced the width, and the declaration
 * is the whole bug: `min-width: 100%` made the popout *at least* as wide as the field, so
 * a panel of six short magnitudes rendered as a `<select>` over the input.
 *
 * The rendered comparison — popout narrower than the field, in a real browser with real
 * fonts — is `precision-swatch.spec.ts`.
 */
const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "controls.module.css"),
  "utf8",
);

function declarations(selector: string): string {
  const match = new RegExp(`(^|\\})[^{}]*\\${selector}\\s*\\{([^}]*)\\}`, "m").exec(CSS);
  if (match === null) throw new Error(`no \`${selector}\` rule in controls.module.css`);
  return match[2] ?? "";
}

describe("T912 — the popout is sized to its content, not to the field", () => {
  it("never claims a minimum width taken from the field", () => {
    expect(
      /min-width\s*:\s*100%/.test(declarations(".ladder")),
      "`.ladder { min-width: 100% }` forces the popout to at least the input's width, " +
        "which is what makes it read as that input's <select>",
    ).toBe(false);
  });

  it("takes its width from the six rungs", () => {
    expect(/width\s*:\s*max-content\s*;/.test(declarations(".ladder"))).toBe(true);
  });

  it("bounds the popout by the field rather than stretching to it", () => {
    // `max-width` is a ceiling for a hypothetical long rung, NOT the minimum coming back
    // under a different name — a rule with both is no better than the bug.
    const rules = declarations(".ladder");
    expect(/max-width\s*:\s*100%/.test(rules)).toBe(true);
    expect(/min-width\s*:/.test(rules)).toBe(false);
  });
});
