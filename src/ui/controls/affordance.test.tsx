// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { NumberField } from "./number-field.tsx";
import type { EditPhase } from "./types.ts";

/**
 * T1033 — the interaction pass over the parameter kit, gated.
 *
 * Three owner reports, one file:
 *   1. "we never know if we can edit or not"        → three states must LOOK like three states
 *   2. "the double-click to reset is weird"         → gated in `controls.test.tsx`
 *   3. "grabbing the slider is awkward. it's a bit weak" → the press must survive being deliberate
 *
 * (3) is the one with a mechanism, and it is the first `describe` below.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

function Harness({ onEmit }: { onEmit: (value: number, phase: EditPhase) => void }) {
  const [value, setValue] = useState(0);
  return (
    <NumberField
      label="Radius"
      value={value}
      spec={{ step: 1 }}
      onChange={(next, phase) => {
        setValue(next);
        onEmit(next, phase);
      }}
    />
  );
}

const surfaceOf = (): HTMLElement =>
  screen.getByRole("spinbutton", { name: "Radius" }).parentElement as HTMLElement;

/** Longer than `LADDER_HOLD_MS`, so the hold has definitely fired. */
async function holdPast(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 500));
  });
}

/**
 * THE DEFECT, MEASURED IN THE RUNNING APP before it was fixed: press a Level node's
 * Contrast field, wait 500 ms, drag 80 px, release — and the readout was still "1.00".
 * `onPointerDown`'s hold timer nulled `dragRef`, so every subsequent move landed on a dead
 * ref while a popout nobody asked for took the focus.
 *
 * That is the whole of "grabbing the slider is awkward", and it punished precisely the
 * user the fix is for: the one who presses, aims, and only then moves. A drag that begins
 * within 400 ms always worked, which is why nothing caught this — the gesture only fails
 * when it is performed deliberately.
 *
 * §V851 — the negative constant comes from RUNNING the defect, not from derivation: the
 * broken build emits NOTHING at all (`emitted` stays empty and the value stays at its
 * start), so an assertion on the moved value cannot be satisfied by the wrong answer.
 */
describe("T1033 — a press that pauses still drags", () => {
  it("keeps the gesture when the hold opens the ladder underneath it", async () => {
    const emitted: Array<[number, EditPhase]> = [];
    render(<Harness onEmit={(value, phase) => emitted.push([value, phase])} />);
    const surface = surfaceOf();

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 0 });
    await holdPast();
    // The hold did its own job: the reach is on screen.
    expect(screen.getByRole("listbox", { name: "Radius drag magnitude" })).toBeDefined();

    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 40 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 40 });

    // 40 px at 2 px per step, at the manifest's step of 1. The defect emitted [].
    expect(emitted.at(-1), "the paused press never became a drag").toEqual([20, "commit"]);
  });

  it("measures the drag from the ORIGINAL press, not from where the ladder closed", async () => {
    // If the gesture restarted at the move that dismissed the popout, its delta would be 0
    // and the value would not move — the same symptom as the defect, one layer subtler.
    // Absolute travel from the press is also what makes dragging out and back land where
    // it started, which is the property a restart would quietly cost.
    const emitted: number[] = [];
    render(<Harness onEmit={(value) => emitted.push(value)} />);
    const surface = surfaceOf();

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 100 });
    await holdPast();
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 120 });
    expect(emitted.at(-1)).toBe(10);
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 100 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 100 });
    expect(emitted.at(-1), "dragging back to the press point did not return the value").toBe(0);
  });

  it("gets the ladder out of the way once the press turns out to be a drag", async () => {
    render(<Harness onEmit={() => {}} />);
    const surface = surfaceOf();

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 0 });
    await holdPast();
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 40 });

    expect(
      screen.queryByRole("listbox", { name: "Radius drag magnitude" }),
      "a popout left open over the rows below is chrome the drag did not ask for",
    ).toBeNull();
  });

  it("still lets a STILL press keep the ladder — the case the fix could swallow", async () => {
    // Non-vacuity for all three above. Making the move win must not make the hold lose:
    // press, hold, release without travelling is the T228 gesture and it stays.
    const emitted: number[] = [];
    render(<Harness onEmit={(value) => emitted.push(value)} />);
    const surface = surfaceOf();

    fireEvent.pointerDown(surface, { button: 0, pointerId: 1, clientX: 0 });
    await holdPast();
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 0 });

    expect(screen.getByRole("listbox", { name: "Radius drag magnitude" })).toBeDefined();
    expect(emitted, "a still press wrote a value").toEqual([]);
    // And it did not fall through to click-to-type, which would blur the popout it opened.
    expect(screen.getByRole("spinbutton", { name: "Radius" }).getAttribute("readonly")).not.toBeNull();
  });
});

/**
 * The grab surface, as a STRUCTURE rather than as a rendered box.
 *
 * jsdom lays nothing out, so `getBoundingClientRect` here is 0×0 for every element and a
 * measured assertion would pass against a 1px target. What this environment can check
 * honestly is (a) which element the gesture is mounted on and (b) the declaration that
 * makes that element taller than the field it draws. Both are the change.
 */
describe("T1033 — the grab surface is the host, and it is taller than the field", () => {
  it("captures the pointer on the host, so the gesture's extent is the host's", () => {
    const captured: number[] = [];
    render(<Harness onEmit={() => {}} />);
    const field = surfaceOf();
    const host = field.parentElement as HTMLElement;
    host.setPointerCapture = (pointerId: number) => {
      captured.push(pointerId);
    };
    field.setPointerCapture = () => {
      throw new Error("the field must not capture: it is 4px shorter than the target");
    };

    fireEvent.pointerDown(field, { button: 0, pointerId: 7, clientX: 0 });
    expect(captured, "the press was captured by the painted field, not the grab band").toEqual([7]);
  });

  it("tells the cursor which of the three answers this field gives", () => {
    const { rerender } = render(
      <NumberField label="Radius" value={0} spec={{ step: 1 }} onChange={() => {}} />,
    );
    const host = () => surfaceOf().parentElement as HTMLElement;
    expect(host().getAttribute("data-grab")).toBe("drag");

    rerender(
      <NumberField label="Radius" value={0} spec={{ step: 1 }} drivenBy="Expression" onChange={() => {}} />,
    );
    // §V830: a driven field must not advertise a gesture it is about to refuse — including
    // on the 4px of grab band that is not the field itself.
    expect(host().getAttribute("data-grab")).toBe("none");

    rerender(<NumberField label="Radius" value={0} spec={{ step: 1 }} disabled onChange={() => {}} />);
    expect(host().getAttribute("data-grab")).toBe("none");
  });
});

/*
 * ---- the declarations -------------------------------------------------------------
 *
 * Comments are stripped first: several of them quote CSS, and a naive rule scanner reads
 * `.ladder { min-width: 100% }` inside a docblock as a rule.
 */
const CSS = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "controls.module.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const RULES = [...CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
  selectors: (match[1] ?? "").split(",").map((part) => part.trim().replace(/\s+/g, " ")),
  body: match[2] ?? "",
}));

function rule(selector: string): string {
  const found = RULES.filter((entry) => entry.selectors.includes(selector));
  if (found.length === 0) throw new Error(`no \`${selector}\` rule in controls.module.css`);
  return found.map((entry) => entry.body).join(";");
}

const declares = (selector: string, property: string, value: string): boolean =>
  new RegExp(`${property}\\s*:\\s*${value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*[;}]?`).test(
    `${rule(selector)};`,
  );

/**
 * §V830 + T1033 — THREE STATES, THREE APPEARANCES.
 *
 * Editable, driven and unavailable were two appearances before this: an unavailable field
 * kept `--line`, the exact border an editable one rests at, and changed only its text
 * colour. So "can I edit this" had no answer in the frame, which is the owner's report.
 *
 * The vocabulary is the app's own, not a new one: `.outline` in `button.module.css` has
 * used `--line` → `--line-hot` + `--bg-hover` for hover since T37, and `--signal` has meant
 * "live" everywhere since the palette was written.
 */
describe("T1033 — an editable field, a driven field and an unavailable one look different", () => {
  it("lifts an editable field under the pointer, in the app's own hover colour", () => {
    const hover = '.number:hover:not([data-disabled="true"]):not([data-driven="true"])';
    expect(declares(hover, "background", "var(--bg-hover)")).toBe(true);
    expect(declares(hover, "border-color", "var(--line-hot)")).toBe(true);
  });

  it("excludes the two fields that would refuse the edit the hover promises", () => {
    // The guard is the point, not an optimisation: §V830's driven field is legible, live
    // and NOT editable, and a control that lights up under the pointer and then declines
    // is worse than one that never lit.
    const hovers = RULES.flatMap((entry) => entry.selectors).filter(
      (selector) => selector.startsWith(".number:hover") || selector.startsWith(".number:active"),
    );
    expect(hovers.length).toBeGreaterThan(0);
    for (const selector of hovers) {
      expect(selector, `${selector} lights a field that refuses the gesture`).toContain(
        ':not([data-driven="true"])',
      );
      expect(selector).toContain(':not([data-disabled="true"])');
    }
  });

  it("keeps the driven field amber and framed — it is live, not broken", () => {
    expect(declares('.number[data-driven="true"]', "border-color", "var(--signal)")).toBe(true);
  });

  it("takes the frame and the well away from a field nobody can reach", () => {
    const off = '.number[data-disabled="true"]';
    expect(declares(off, "border-color", "transparent")).toBe(true);
    expect(declares(off, "background", "none")).toBe(true);
    // NOT `--line`: that is where an editable field rests, and matching it is the defect.
    expect(/border-color\s*:\s*var\(--line\)/.test(rule(off))).toBe(false);
  });

  it("gives the same three answers on every other control in the kit", () => {
    // The owner's complaint is partly that each control type answered differently. A
    // switch, a select, a text field and a stop button now all lift on hover and all drop
    // the frame when unavailable.
    for (const selector of [".select", ".switch", ".pulse", ".stopButton", ".text"]) {
      expect(declares(`${selector}:disabled`, "border-color", "transparent"), selector).toBe(true);
      expect(declares(`${selector}:disabled`, "background", "none"), selector).toBe(true);
    }
    for (const selector of [
      ".select:hover:not(:disabled)",
      ".switch:hover:not(:disabled)",
      ".pulse:hover:not(:disabled)",
      ".stopButton:hover:not(:disabled)",
      ".text:hover:not(:disabled):not(:read-only)",
      ".hex:hover:not(:disabled):not(:read-only)",
    ]) {
      expect(declares(selector, "background", "var(--bg-hover)"), selector).toBe(true);
    }
  });

  it("stops painting the §V830 amber seam onto DISABLED text fields", () => {
    // CSS `:read-only` matches any input that is not user-alterable — a disabled input
    // included — so the driven seam was landing on every disabled text and hex field in
    // the kit. Amber is reserved for a value that is moving; an unreachable control is the
    // one state it certainly is not.
    const readOnly = RULES.flatMap((entry) => entry.selectors).filter(
      (selector) => selector === ".text:read-only" || selector === ".hex:read-only",
    );
    expect(readOnly, "an unguarded :read-only rule paints disabled fields amber").toEqual([]);
    expect(declares(".text:read-only:not(:disabled)", "border-color", "var(--signal)")).toBe(true);
  });
});

describe("T1033 — the focus ring is no longer clipped away", () => {
  it("draws it on the field, which is the box that is not clipping", () => {
    // base.css puts `:focus-visible` on the focused element. Here that is the `<input>`,
    // inside a box with `overflow: hidden` — so the ring rendered as two amber slivers at
    // the field's left and right edges and clicking in to type looked like nothing had
    // happened. An outline on `.number` is drawn outside its own border box, so this
    // element's `overflow` cannot reach it.
    expect(/overflow\s*:\s*hidden/.test(rule(".number"))).toBe(true);
    expect(declares(".numberInput:focus", "outline", "none")).toBe(true);
    expect(declares(".number:focus-within", "outline", "var(--focus-ring-width) solid var(--focus-ring)")).toBe(
      true,
    );
  });
});

describe("T1033 — the grab band grows the target without moving the paint", () => {
  it("takes the row's dead padding as hit area and gives back exactly as much", () => {
    // 20px of field in a 24px row: `--space-1` above it and 2px below were unreachable.
    // The padding claims them; the negative margin returns them, so nothing shifts and no
    // two rows' bands overlap.
    expect(declares(".numberHost", "padding-block", "var(--space-1)")).toBe(true);
    expect(declares(".numberHost", "margin-block", "calc(-1 * var(--space-1))")).toBe(true);
  });

  it("puts the drag cursor on the band, keyed to what the field will accept", () => {
    expect(declares('.numberHost[data-grab="drag"]', "cursor", "ew-resize")).toBe(true);
    expect(declares('.numberHost[data-grab="drag"]', "touch-action", "none")).toBe(true);
    // No rule for `none`: an unavailable or driven field's band inherits the default
    // arrow, which is the honest answer (§V830).
    expect(RULES.flatMap((entry) => entry.selectors)).not.toContain('.numberHost[data-grab="none"]');
  });
});
