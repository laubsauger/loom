// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResolvedComponent } from "@domain/parameters/resolve.ts";
import type {
  ParameterValue,
  StoredParameter,
  VectorParameter,
} from "@domain/types/parameters.ts";
import { installDomStubs } from "../testing/install-dom-stubs.ts";
import { ParameterControl } from "./parameter-control.tsx";
import type { EditPhase } from "./types.ts";

/**
 * T1026 — dragging the parameter NAME moves every channel of a compound at once, through
 * the real dispatcher the inspector mounts.
 *
 * The owner: "if we have a parameter grid and it has an X and a Y, we need some way where
 * we can move them in sync… we drag and slide over the LABEL instead of over one of the
 * inputs." TouchDesigner's own docs confirm the affordance — opening the value ladder on a
 * multi-value parameter's NAME adjusts every component, on a FIELD adjusts one.
 *
 * What is under test is the wiring, and the wiring is the invariant:
 *   §V114  one gesture, one patch per emitted value, one undo entry — never one per axis.
 *   §V113  a channel decided by its own mode is not written, at all.
 *   §V830  when the gesture cannot run, the label SAYS SO; it does not go inert.
 *   §V19   the same adjustment exists without a pointer.
 * And the regression this feature most threatens: dragging one FIELD must still move only
 * that field. Every block below asserts one of those.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

/**
 * No declared step, so `dragStepFor` derives (100 - -100)/100 = 2 per `PIXELS_PER_STEP`
 * of 2 — one pixel of travel is one unit, which makes every expectation below exact.
 */
const vector: VectorParameter = {
  type: "vector",
  label: "Offset",
  size: 2,
  default: [0, 0],
  min: -100,
  max: 100,
};

const expressionSlot: StoredParameter = {
  mode: "expression",
  bindings: { expression: { kind: "expression", source: "frame.time" } },
};

/**
 * A channel that carries its own SLOT while its mode is static — what a channel looks like
 * after it has been an expression and flipped back to Constant (§V108). It is the only
 * shape that sends a fully-editable compound down the component-addressed write, and so
 * the only one that can tell "one patch for both axes" apart from "one patch per axis".
 */
const staticSlot: StoredParameter = {
  mode: "static",
  bindings: { static: { kind: "static", value: 0 } },
};

function slottedComponents(
  names: readonly string[],
  values: readonly number[],
): readonly ResolvedComponent[] {
  return names.map((name, index) => ({
    name,
    value: values[index] ?? 0,
    mode: "static" as const,
    slot: staticSlot as never,
    diagnostic: null,
  })) as readonly ResolvedComponent[];
}

function componentsFor(
  names: readonly string[],
  values: readonly number[],
  drivenName: string | null,
): readonly ResolvedComponent[] {
  return names.map((name, index) => ({
    name,
    value: values[index] ?? 0,
    ...(name === drivenName
      ? { mode: "expression" as const, slot: expressionSlot as never }
      : { mode: "static" as const, slot: undefined }),
    diagnostic: null,
  })) as readonly ResolvedComponent[];
}

interface Harness {
  changes: [ParameterValue, EditPhase][];
  stored: ReturnType<typeof vi.fn>;
  name: HTMLButtonElement;
}

function renderVector(options: { driven?: string | null } = {}): Harness {
  const driven = options.driven ?? null;
  const changes: [ParameterValue, EditPhase][] = [];
  const stored = vi.fn();
  render(
    <ParameterControl
      parameterKey="offset"
      definition={vector}
      value={[2, 3]}
      components={componentsFor(["x", "y"], [2, 3], driven)}
      onStoredChange={stored}
      onChange={(value, phase) => changes.push([value, phase])}
    />,
  );
  return { changes, stored, name: screen.getByRole("button", { name: "Offset" }) as HTMLButtonElement };
}

const field = (name: string): HTMLInputElement =>
  screen.getByRole("spinbutton", { name }) as HTMLInputElement;

/** One press, one move, one release — the whole gesture, in pixels of horizontal travel. */
function dragBy(target: HTMLElement, deltaX: number, from = 40): void {
  fireEvent.pointerDown(target, { pointerId: 7, clientX: from, button: 0 });
  fireEvent.pointerMove(target, { pointerId: 7, clientX: from + deltaX });
  fireEvent.pointerUp(target, { pointerId: 7, clientX: from + deltaX });
}

// ---- the gesture itself ----------------------------------------------

describe("T1026 — dragging the name moves every channel together", () => {
  it("moves x and y by the same delta, in ONE patch per value and one commit", () => {
    const { changes, name } = renderVector();

    dragBy(name, 10);

    // Every channel gained 10 (10px / 2px-per-step * step 2), so [2,3] -> [12,13].
    expect(changes.map(([value]) => value)).toEqual([
      [12, 13],
      [12, 13],
    ]);
    // §V114/§V15: the tuple travels as ONE value, and the gesture closes with exactly one
    // commit. Two entries here (live, then commit) is one undo entry; four would be four
    // patches, which is the shape this invariant exists to forbid.
    expect(changes.map(([, phase]) => phase)).toEqual(["live", "commit"]);
    // Additive, not proportional: proportional from [2,3] would have made the second
    // channel 18, and the difference is what the user watched stay put.
    const [last] = changes.at(-1) as [readonly number[], EditPhase];
    expect(last[1] - last[0]).toBe(1);
  });

  it("§V114 — writes BOTH channels in a single patch, never one patch per channel", () => {
    // The case that can actually tell the two apart: both channels carry their own slot,
    // so the write is component-addressed and has two keys to place. One `onStoredChange`
    // call is one `GraphPatch` is one undo entry; two calls would make undoing a single
    // drag take two presses and leave the vector half-moved in between.
    const stored = vi.fn();
    render(
      <ParameterControl
        parameterKey="offset"
        definition={vector}
        value={[2, 3]}
        components={slottedComponents(["x", "y"], [2, 3])}
        onStoredChange={stored}
        onChange={vi.fn()}
      />,
    );

    dragBy(screen.getByRole("button", { name: "Offset" }), 10);

    expect(stored).toHaveBeenCalledTimes(2);
    expect(stored.mock.calls.map((call) => call[1])).toEqual(["live", "commit"]);
    for (const call of stored.mock.calls) {
      const entries = call[0] as Record<string, StoredParameter>;
      expect(Object.keys(entries).sort()).toEqual(["offset.x", "offset.y"]);
      expect(entries["offset.x"]).toMatchObject({
        bindings: { static: { kind: "static", value: 12 } },
      });
      expect(entries["offset.y"]).toMatchObject({
        bindings: { static: { kind: "static", value: 13 } },
      });
    }
  });

  it("moves x by exactly what dragging the x FIELD by the same travel moves it", () => {
    // Criterion: the name is not a second, differently-geared control. If these disagree,
    // a user who learns one gesture has not learned the other.
    const viaName = renderVector();
    dragBy(viaName.name, 24);
    const [fromName] = viaName.changes.at(-1) as [readonly number[], EditPhase];
    cleanup();

    const viaField = renderVector();
    dragBy(field("Offset x").parentElement as HTMLElement, 24);
    const [fromField] = viaField.changes.at(-1) as [readonly number[], EditPhase];

    expect(fromName[0]).toBe(fromField[0]);
    expect(fromName[0]).toBe(26);
  });

  it("is absolute: dragging out and back returns to the value it started from", () => {
    const { changes, name } = renderVector();
    fireEvent.pointerDown(name, { pointerId: 7, clientX: 40, button: 0 });
    fireEvent.pointerMove(name, { pointerId: 7, clientX: 120 });
    fireEvent.pointerMove(name, { pointerId: 7, clientX: 40 });
    fireEvent.pointerUp(name, { pointerId: 7, clientX: 40 });

    // A gesture that accumulated per-move deltas — or that re-read the value it had just
    // written — would drift away and never come home.
    expect(changes.at(-1)?.[0]).toEqual([2, 3]);
  });

  it("still lets the name CLICK to disclose the modes, and a drag never does", () => {
    const { name } = renderVector();
    expect(name.getAttribute("aria-expanded")).toBe("false");

    // A press that never travelled the threshold is a click, exactly as on a number field.
    fireEvent.pointerDown(name, { pointerId: 1, clientX: 40, button: 0 });
    fireEvent.pointerMove(name, { pointerId: 1, clientX: 41 });
    fireEvent.pointerUp(name, { pointerId: 1, clientX: 41 });
    fireEvent.click(name);
    expect(name.getAttribute("aria-expanded")).toBe("true");

    // ...and one that did travel must not also toggle the panel shut behind the values.
    dragBy(name, 20);
    fireEvent.click(name);
    expect(name.getAttribute("aria-expanded")).toBe("true");
  });
});

// ---- the regression this feature threatens ---------------------------

describe("T1026 — dragging one FIELD still moves only that field", () => {
  it("leaves the sibling axis exactly where it was", () => {
    const { changes } = renderVector();

    dragBy(field("Offset x").parentElement as HTMLElement, 10);

    expect(changes.at(-1)?.[0]).toEqual([12, 3]);
    cleanup();

    const other = renderVector();
    dragBy(field("Offset y").parentElement as HTMLElement, 10);
    expect(other.changes.at(-1)?.[0]).toEqual([2, 13]);
  });

  it("still commits a typed entry into one axis alone", () => {
    const { changes } = renderVector();
    const x = field("Offset x");
    fireEvent.change(x, { target: { value: "9" } });
    fireEvent.blur(x);
    expect(changes.at(-1)?.[0]).toEqual([9, 3]);
  });
});

// ---- §V113: a channel with its own mode -------------------------------

describe("§V113/§V830 — a partially driven compound", () => {
  it("writes only the static channel, in one patch, and never the driven one", () => {
    const { changes, stored, name } = renderVector({ driven: "y" });

    dragBy(name, 10);

    // The write is component-addressed because y carries a slot, and `offset.y` is ABSENT:
    // writing it back — even to the value it already shows — would put the resolver's live
    // sample into the retained constant a flip to Constant restores (§V108).
    expect(stored).toHaveBeenCalledTimes(2);
    for (const call of stored.mock.calls) {
      const entries = call[0] as Record<string, StoredParameter>;
      // §V114: one call carries the whole edit. One key per axis in separate calls would
      // be one undo entry per axis.
      expect(Object.keys(entries)).toEqual(["offset.x"]);
      expect(entries["offset.x"]).toMatchObject({
        bindings: { static: { kind: "static", value: 12 } },
      });
    }
    expect(stored.mock.calls.map((call) => call[1])).toEqual(["live", "commit"]);
    // And nothing went down the whole-compound path, which would have rewritten y.
    expect(changes).toEqual([]);
  });

  it("says on the label which axis it moves and which it leaves alone", () => {
    const { name } = renderVector({ driven: "y" });
    expect(name.getAttribute("title")).toContain(
      "Drag the name to move x together; y (Expression) stays with its own mode.",
    );
    // §V830: the affordance is explained, not disabled.
    expect(name.disabled).toBe(false);
  });

  it("refuses the gesture — with a reason — when every axis is driven", () => {
    const changes: [ParameterValue, EditPhase][] = [];
    const stored = vi.fn();
    render(
      <ParameterControl
        parameterKey="offset"
        definition={vector}
        value={[2, 3]}
        components={[
          ...componentsFor(["x"], [2], "x"),
          ...componentsFor(["y"], [3], "y"),
        ]}
        onStoredChange={stored}
        onChange={(value, phase) => changes.push([value, phase])}
      />,
    );
    const name = screen.getByRole("button", { name: "Offset" }) as HTMLButtonElement;

    dragBy(name, 40);
    expect(stored).not.toHaveBeenCalled();
    expect(changes).toEqual([]);

    // Not inert: the name still discloses the modes, still takes focus, and says why the
    // drag did nothing. Silence here is the §V830 failure.
    expect(name.disabled).toBe(false);
    expect(name.getAttribute("title")).toContain("cannot move them");
    fireEvent.click(name);
    expect(name.getAttribute("aria-expanded")).toBe("true");
  });
});

// ---- §V19: without a pointer ------------------------------------------

describe("§V19 — the same adjustment from the keyboard", () => {
  it("steps every eligible axis on the focused name, committing once on key-up", () => {
    const { changes, name } = renderVector();
    name.focus();
    expect(document.activeElement).toBe(name);

    fireEvent.keyDown(name, { key: "ArrowUp" });
    fireEvent.keyUp(name, { key: "ArrowUp" });

    expect(changes).toEqual([
      [[4, 5], "live"],
      [[4, 5], "commit"],
    ]);
  });

  it("keeps a held repeat inside one undo group, then commits where it landed", () => {
    const { changes, name } = renderVector();
    fireEvent.keyDown(name, { key: "ArrowDown" });
    fireEvent.keyDown(name, { key: "ArrowDown" });
    fireEvent.keyUp(name, { key: "ArrowDown" });

    // Two repeats of one step each, reported live, and exactly one commit closing them.
    expect(changes.map(([, phase]) => phase)).toEqual(["live", "live", "commit"]);
    expect(changes.at(-1)?.[0]).toEqual([-2, -1]);
  });

  it("does not step an axis another mode decides", () => {
    const { stored, name } = renderVector({ driven: "y" });
    fireEvent.keyDown(name, { key: "ArrowUp" });
    fireEvent.keyUp(name, { key: "ArrowUp" });

    const entries = stored.mock.calls.at(-1)?.[0] as Record<string, StoredParameter>;
    expect(Object.keys(entries)).toEqual(["offset.x"]);
    expect(entries["offset.x"]).toMatchObject({
      bindings: { static: { kind: "static", value: 4 } },
    });
  });
});
