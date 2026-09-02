// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ParameterDefinition } from "@domain/types/parameters.ts";
import { installDomStubs } from "../testing/install-dom-stubs.ts";
import { NumberField } from "./number-field.tsx";
import { ParameterControl } from "./parameter-control.tsx";
import type { EditPhase, NumericSpec } from "./types.ts";

beforeAll(installDomStubs);
afterEach(cleanup);

const spec: NumericSpec = { min: 0, max: 1, step: 0.01 };

type Change = [number, EditPhase];

function renderNumber(overrides: Partial<Parameters<typeof NumberField>[0]> = {}) {
  const changes: Change[] = [];
  const onChange = vi.fn((value: number, phase: EditPhase) => {
    changes.push([value, phase]);
  });
  render(
    <NumberField
      label="Radius"
      value={0.5}
      defaultValue={0.25}
      spec={spec}
      onChange={onChange}
      {...overrides}
    />,
  );
  const input = screen.getByRole("spinbutton", { name: "Radius" });
  const field = input.parentElement as HTMLElement;
  return { changes, onChange, input, field };
}

/**
 * §V20 — "param control drag ⊥ start graph pan | node drag | selection".
 *
 * This is the invariant that decides whether the tool feels professional or broken, so
 * it is tested against a stand-in for exactly the thing that would break it: an
 * ancestor with the pointer handlers React Flow attaches to a node.
 */
describe("§V20 — a control drag never becomes a node drag", () => {
  it("stops the press from reaching an ancestor drag surface", () => {
    const nodeDrag = vi.fn();
    const nodeSelect = vi.fn();
    render(
      <div onPointerDown={nodeDrag} onMouseDown={nodeSelect}>
        <NumberField label="Radius" value={0.5} defaultValue={0.25} spec={spec} onChange={vi.fn()} />
      </div>,
    );

    const field = screen.getByRole("spinbutton", { name: "Radius" }).parentElement as HTMLElement;
    fireEvent.pointerDown(field, { pointerId: 1, clientX: 10, button: 0 });
    fireEvent.pointerMove(field, { pointerId: 1, clientX: 40 });
    fireEvent.pointerUp(field, { pointerId: 1, clientX: 40 });

    expect(nodeDrag).not.toHaveBeenCalled();
    expect(nodeSelect).not.toHaveBeenCalled();
  });

  it("also carries React Flow's own nodrag opt-out, so neither mechanism is load-bearing alone", () => {
    const { field } = renderNumber();
    expect(field.className).toContain("nodrag");
  });

  it("prevents the default of the press, so the gesture cannot start a text selection", () => {
    const { field } = renderNumber();
    const notPrevented = fireEvent.pointerDown(field, { pointerId: 1, clientX: 10, button: 0 });
    expect(notPrevented).toBe(false);
  });

  it("ignores a non-primary button, leaving context menus to the canvas", () => {
    const { field, onChange } = renderNumber();
    fireEvent.pointerDown(field, { pointerId: 1, clientX: 10, button: 2 });
    fireEvent.pointerMove(field, { pointerId: 1, clientX: 60 });
    expect(onChange).not.toHaveBeenCalled();
  });
});

describe("dragging a number (doc §8.1)", () => {
  it("applies live values during the drag and exactly one commit at the end (§V15)", () => {
    const { field, changes } = renderNumber();

    fireEvent.pointerDown(field, { pointerId: 1, clientX: 0, button: 0 });
    fireEvent.pointerMove(field, { pointerId: 1, clientX: 10 });
    fireEvent.pointerMove(field, { pointerId: 1, clientX: 20 });
    fireEvent.pointerUp(field, { pointerId: 1, clientX: 20 });

    const phases = changes.map(([, phase]) => phase);
    expect(phases.filter((phase) => phase === "live").length).toBeGreaterThan(0);
    expect(phases.filter((phase) => phase === "commit")).toEqual(["commit"]);
    // 20 px at 2 px/step of 0.01 → +0.10.
    expect(changes.at(-1)?.[0]).toBeCloseTo(0.6, 6);
  });

  it("does not move at all below the click threshold, so a click stays a click", () => {
    const { field, onChange } = renderNumber();
    fireEvent.pointerDown(field, { pointerId: 1, clientX: 0, button: 0 });
    fireEvent.pointerMove(field, { pointerId: 1, clientX: 2 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("applies the shift and alt modifiers mid-drag", () => {
    const { field, changes } = renderNumber();
    fireEvent.pointerDown(field, { pointerId: 1, clientX: 0, button: 0 });
    fireEvent.pointerMove(field, { pointerId: 1, clientX: 20, shiftKey: true });
    const fine = changes.at(-1)?.[0] ?? 0;
    fireEvent.pointerMove(field, { pointerId: 1, clientX: 20, altKey: true });
    const coarse = changes.at(-1)?.[0] ?? 0;
    expect(fine).toBeLessThan(coarse);
    expect(fine).toBeCloseTo(0.51, 6);
    expect(coarse).toBe(1); // clamped at the manifest maximum
  });
});

describe("double-click resets to the manifest default (doc §8.1)", () => {
  it("commits the default value", () => {
    const { field, changes } = renderNumber();
    fireEvent.doubleClick(field);
    expect(changes).toEqual([[0.25, "commit"]]);
  });

  it("normalises the default through the same range rules", () => {
    const { field, changes } = renderNumber({ defaultValue: 99 });
    fireEvent.doubleClick(field);
    expect(changes).toEqual([[1, "commit"]]);
  });
});

/**
 * §V19 — every interactive control is keyboard reachable and operable. A numeric
 * control that only responds to a drag is unusable without a mouse.
 */
describe("§V19 — keyboard operation", () => {
  it("nudges with the arrow keys and commits once the key is released", () => {
    const { input, changes } = renderNumber();
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyUp(input, { key: "ArrowUp" });

    expect(changes.map(([, phase]) => phase)).toEqual(["live", "live", "commit"]);
    // A held key repeats; the whole repeat is one undo entry, ending at the last value.
    expect(changes.at(-1)?.[0]).toBeCloseTo(0.52, 6);
  });

  it("pages by ten steps and jumps to the range ends", () => {
    const { input, changes } = renderNumber();
    fireEvent.keyDown(input, { key: "PageDown" });
    expect(changes.at(-1)?.[0]).toBeCloseTo(0.4, 6);

    fireEvent.keyDown(input, { key: "End" });
    expect(changes.at(-1)).toEqual([1, "commit"]);
    fireEvent.keyDown(input, { key: "Home" });
    expect(changes.at(-1)).toEqual([0, "commit"]);
  });

  it("exposes its value to assistive technology as a spinbutton", () => {
    const { input } = renderNumber({ unit: "px" });
    expect(input.getAttribute("aria-valuenow")).toBe("0.5");
    expect(input.getAttribute("aria-valuemin")).toBe("0");
    expect(input.getAttribute("aria-valuemax")).toBe("1");
    expect(input.getAttribute("aria-valuetext")).toBe("0.50 px");
  });

  it("lets editing keys reach the graph keymap, but keeps the keys it handles (§V53)", () => {
    const graphKeys = vi.fn();
    render(
      <div onKeyDown={graphKeys}>
        <NumberField label="Radius" value={0.5} defaultValue={0.25} spec={spec} onChange={vi.fn()} />
      </div>,
    );
    const input = screen.getByRole("spinbutton", { name: "Radius" });

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(graphKeys).not.toHaveBeenCalled();

    // mod+z is not this control's key — undo must still work while a field has focus.
    fireEvent.keyDown(input, { key: "z", metaKey: true });
    expect(graphKeys).toHaveBeenCalledTimes(1);
  });
});

describe("typed entry (doc §8.1)", () => {
  const enterTextMode = (field: HTMLElement): void => {
    fireEvent.pointerDown(field, { pointerId: 1, clientX: 5, button: 0 });
    fireEvent.pointerUp(field, { pointerId: 1, clientX: 5 });
  };

  it("opens on a click that did not become a drag", () => {
    const { field, input, onChange } = renderNumber();
    enterTextMode(field);
    expect(document.activeElement).toBe(input);
    expect(input).not.toHaveProperty("readOnly", true);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("evaluates arithmetic and commits the normalised result", () => {
    const { field, input, changes } = renderNumber();
    enterTextMode(field);
    fireEvent.change(input, { target: { value: "1/4" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changes).toEqual([[0.25, "commit"]]);
  });

  it("rejects nonsense without throwing and without writing to the document", () => {
    const { field, input, onChange } = renderNumber();
    enterTextMode(field);
    fireEvent.change(input, { target: { value: "not a number" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("abandons the edit on Escape", () => {
    const { field, input, onChange } = renderNumber();
    enterTextMode(field);
    fireEvent.change(input, { target: { value: "0.9" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onChange).not.toHaveBeenCalled();
    expect((input as HTMLInputElement).value).toBe("0.50");
  });

  it("opens from the keyboard too, so typing never requires a pointer (§V19)", () => {
    const { input, changes } = renderNumber();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.change(input, { target: { value: "0.75" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changes).toEqual([[0.75, "commit"]]);
  });
});

/**
 * §B159 / §V776 — "seems like we cant type numbers into our sliders even after selecting.
 * nothing happens when typing."
 *
 * ## What was measured, in the running app, before the fix
 *
 * Two candidates were filed and only one of them was real. Driven in Chromium against the
 * dev server, on a Noise node's Amplitude field showing `1.00`:
 *
 *   quick click              → readonly GONE, focused, typing lands   ✅
 *   click with 2px of jitter → readonly GONE (under the 3px threshold) ✅
 *   click with 4px of jitter → a drag, value 1.00 → 1.20 (by design)
 *   focus, then press `5`    → readonly PRESENT, value still `1.00`   ❌
 *
 * So the CLICK path was never broken; the field simply swallowed the keystroke. The
 * `<input>` is `readOnly` until an edit is open, and the keydown's `default: return`
 * dropped every printable key, so a focused field gave no character and no refusal.
 *
 * The fix is the behaviour every DAW and spreadsheet has: the keystroke that STARTS the
 * edit is the FIRST CHARACTER OF IT. That is the half these gates pin — a control that
 * opened text entry but seeded it with the OLD value would satisfy "typing works" and
 * still lose the digit the user pressed.
 */
describe("§B159 — a focused field accepts the first keystroke (§V776)", () => {
  /** Wide enough that 5 is a value rather than a clamp, so the commit is unambiguous. */
  const wide: NumericSpec = { min: 0, max: 10, step: 1 };

  it("opens text entry CONTAINING the digit that was typed, not the old value", () => {
    const { input } = renderNumber({ spec: wide, value: 2 });
    expect((input as HTMLInputElement).readOnly).toBe(true);

    fireEvent.keyDown(input, { key: "5" });

    expect((input as HTMLInputElement).readOnly).toBe(false);
    // The keystroke IS the edit. `"2"` here would mean the digit was discarded in favour
    // of the old value, which is the half of §V776 that "typing works" does not cover.
    expect((input as HTMLInputElement).value).toBe("5");
  });

  it("commits the typed number on Enter", () => {
    const { input, changes } = renderNumber({ spec: wide, value: 2 });
    fireEvent.keyDown(input, { key: "5" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changes).toEqual([[5, "commit"]]);
  });

  it("starts on a sign or a decimal point too, so -0.5 is reachable", () => {
    const { input } = renderNumber({ spec: { min: -1, max: 1, step: 0.01 }, value: 0.25 });
    fireEvent.keyDown(input, { key: "-" });
    expect((input as HTMLInputElement).value).toBe("-");
    fireEvent.keyDown(input, { key: "Escape" });

    fireEvent.keyDown(input, { key: "." });
    expect((input as HTMLInputElement).value).toBe(".");
  });

  it("leaves every OTHER key to the graph keymap — undo still works here (§V53)", () => {
    const graphKeys = vi.fn();
    render(
      <div onKeyDown={graphKeys}>
        <NumberField label="Radius" value={0.5} defaultValue={0.25} spec={spec} onChange={vi.fn()} />
      </div>,
    );
    const input = screen.getByRole("spinbutton", { name: "Radius" }) as HTMLInputElement;

    // A bare letter is nobody's number. It must not open an edit, and it must still reach
    // the keymap: half the app's hotkeys are single letters and a focused field is a
    // normal place to be standing when one is pressed.
    fireEvent.keyDown(input, { key: "z" });
    expect(input.readOnly).toBe(true);
    expect(graphKeys).toHaveBeenCalledTimes(1);

    // mod+5 is a chord, not a digit — the keymap owns it, and no edit opens.
    fireEvent.keyDown(input, { key: "5", metaKey: true });
    expect(input.readOnly).toBe(true);
    expect(graphKeys).toHaveBeenCalledTimes(2);
  });

  it("keeps the click path working: a press under the drag threshold still types", () => {
    const { field, input, onChange } = renderNumber();
    // 2px — the measured jitter of a real click, below DRAG_THRESHOLD_PX.
    fireEvent.pointerDown(field, { pointerId: 1, clientX: 5, button: 0 });
    fireEvent.pointerMove(field, { pointerId: 1, clientX: 7 });
    fireEvent.pointerUp(field, { pointerId: 1, clientX: 7 });
    expect((input as HTMLInputElement).readOnly).toBe(false);
    expect(document.activeElement).toBe(input);
    expect(onChange).not.toHaveBeenCalled();
  });
});

/**
 * T38 — the inspector is manifest-driven. Every member of the `ParameterDefinition`
 * union must produce a control, or a node that declares one becomes partly invisible.
 */
describe("manifest-driven dispatch covers every ParameterDefinition variant", () => {
  const variants: Array<[string, ParameterDefinition, string]> = [
    ["number", { type: "number", label: "Radius", default: 4, min: 0, max: 64, unit: "px" }, "Radius"],
    ["boolean", { type: "boolean", label: "Enabled", default: true }, "Enabled"],
    [
      "enum",
      {
        type: "enum",
        label: "Mode",
        default: "over",
        options: [
          { value: "over", label: "Over" },
          { value: "add", label: "Add" },
        ],
      },
      "Mode",
    ],
    ["color", { type: "color", label: "Tint", default: [1, 0, 0, 1], space: "display" }, "Tint hex"],
    ["vector", { type: "vector", label: "Offset", size: 2, default: [0, 0] }, "Offset x"],
    ["string", { type: "string", label: "Note", default: "" }, "Note"],
    ["asset", { type: "asset", label: "Image", kind: "image" }, "Image"],
    ["curve", { type: "curve", label: "Falloff", default: [{ x: 0, y: 0 }] }, "Falloff curve, 1 point"],
  ];

  it.each(variants)("renders a %s control", (_kind, definition, accessibleName) => {
    render(
      <ParameterControl
        parameterKey="p"
        definition={definition}
        value={undefined}
        onChange={vi.fn()}
      />,
    );
    // EXACT, not substring. The table above already spells each control's whole
    // accessible name, so `{ exact: false }` bought nothing and cost precision: T912's
    // magnitude swatch is named "<label> drag magnitude", so a substring query for
    // "Radius" matched the field AND its affordance and the row failed as ambiguous.
    // A row that renders a control plus an affordance is not a dispatch failure.
    expect(screen.getByLabelText(accessibleName)).toBeDefined();
  });

  it("falls back to the manifest default when the stored value does not fit", () => {
    render(
      <ParameterControl
        parameterKey="radius"
        definition={{ type: "number", label: "Radius", default: 4, min: 0, max: 64 }}
        // A stale document, an older schema, or an agent mid-patch.
        value={"nonsense" as unknown as number}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByRole("spinbutton", { name: "Radius" }).getAttribute("aria-valuenow")).toBe("4");
  });

  it("shows the declared range and unit (doc §8.1)", () => {
    render(
      <ParameterControl
        parameterKey="radius"
        definition={{ type: "number", label: "Radius", default: 4, min: 0, max: 64, unit: "px" }}
        value={4}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByText("0…64")).toBeDefined();
    expect(screen.getAllByText("px").length).toBeGreaterThan(0);
  });

  it("keeps node-embedded controls compact: no hints, no descriptions (doc §8.1)", () => {
    render(
      <ParameterControl
        parameterKey="radius"
        definition={{
          type: "number",
          label: "Radius",
          default: 4,
          min: 0,
          max: 64,
          description: "Blur radius in pixels",
        }}
        value={4}
        variant="node"
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText("0…64")).toBeNull();
    expect(screen.queryByText("Blur radius in pixels")).toBeNull();
  });

  it("toggles a boolean through the bus as a single commit", () => {
    const onChange = vi.fn();
    render(
      <ParameterControl
        parameterKey="enabled"
        definition={{ type: "boolean", label: "Enabled", default: false }}
        value={false}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByRole("switch", { name: "Enabled" }));
    expect(onChange).toHaveBeenCalledWith(true, "commit");
  });

  it("selects an enum option as a single commit", () => {
    const onChange = vi.fn();
    render(
      <ParameterControl
        parameterKey="mode"
        definition={{
          type: "enum",
          label: "Mode",
          default: "over",
          options: [
            { value: "over", label: "Over" },
            { value: "add", label: "Add" },
          ],
        }}
        value="over"
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText("Mode"), { target: { value: "add" } });
    expect(onChange).toHaveBeenCalledWith("add", "commit");
  });

  it("edits one axis of a vector without disturbing the others", () => {
    const onChange = vi.fn();
    render(
      <ParameterControl
        parameterKey="offset"
        definition={{ type: "vector", label: "Offset", size: 3, default: [0, 0, 0], step: 0.1 }}
        value={[1, 2, 3]}
        onChange={onChange}
      />,
    );
    fireEvent.keyDown(screen.getByRole("spinbutton", { name: "Offset y" }), { key: "ArrowUp" });
    expect(onChange).toHaveBeenCalledWith([1, 2.1, 3], "live");
  });

  it("writes a colour hex back in the parameter's own space", () => {
    const onChange = vi.fn();
    render(
      <ParameterControl
        parameterKey="tint"
        definition={{ type: "color", label: "Tint", default: [0, 0, 0, 1], space: "display" }}
        value={[0, 0, 0, 1]}
        onChange={onChange}
      />,
    );
    const hex = screen.getByLabelText("Tint hex");
    fireEvent.change(hex, { target: { value: "#ff0000" } });
    fireEvent.keyDown(hex, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith([1, 0, 0, 1], "commit");
  });
});

/**
 * T368 — the clamp, forecast where the expression is WRITTEN.
 *
 * The E13 case: `transform.r` is ±360, and `time * 7` is correct at t=0 and a stopped
 * rotation from t≈51. The runtime warning arrives at frame 3100 and the live editor
 * discards per-frame diagnostics, so the moment that matters is this one — the panel is
 * open and the expression is being typed.
 *
 * Rendered through `ParameterControl`, deliberately: the range comes from the manifest
 * and only the control has it. A test that handed `range` to the panel itself would pass
 * with the wiring absent, which is §V220's whole failure mode.
 */
describe("expression clamp forecast (T368)", () => {
  const ROTATE: ParameterDefinition = { type: "number", label: "Rotate", default: 0, min: -360, max: 360 };

  const openModes = (source: string) => {
    render(
      <ParameterControl
        parameterKey="r"
        definition={ROTATE}
        value={0}
        slot={{ mode: "expression", bindings: { expression: { kind: "expression", source } } }}
        onStoredChange={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
  };

  it("says WHEN a monotone expression will stop moving, and what to write instead", () => {
    openModes("time * 7");
    const status = screen.getByRole("status");
    // The moment, not just the fact: 360 / 7 = 51.4s.
    expect(status.textContent).toContain("51");
    expect(status.textContent).toContain("360");
    // The remedy is expression text, in this parameter's numbers, ready to be typed.
    expect(status.textContent).toContain("mod(time * 7, 360)");
    expect(status.textContent).toContain("clamp(time * 7, -360, 360)");
  });

  it("says nothing once the expression wraps — the message is the diagnosis, not decoration", () => {
    openModes("mod(time * 7, 360)");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("says nothing for a parameter the manifest does not bound", () => {
    // `renderInstances.rotate` and `eye` are unbounded: nothing to forecast, and a
    // permanent line under every expression field is exactly what §V90 forbids.
    render(
      <ParameterControl
        parameterKey="rotate"
        definition={{ type: "number", label: "Rotate", default: 0 }}
        value={0}
        slot={{ mode: "expression", bindings: { expression: { kind: "expression", source: "time * 7" } } }}
        onStoredChange={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    expect(screen.queryByRole("status")).toBeNull();
  });
});

/**
 * T370 — what the grammar is FOR, taught where it is refused.
 *
 * `sin(time)` is the first thing anyone types into an expression field. It works now; the
 * teaching case is the next name out — and the answer has to be the boundary, not "no".
 */
describe("expression grammar refusals teach the boundary (T370)", () => {
  it("names every function the grammar does have when it refuses one it does not", () => {
    render(
      <ParameterControl
        parameterKey="r"
        definition={{ type: "number", label: "Rotate", default: 0, min: -360, max: 360 }}
        value={0}
        slot={{ mode: "expression", bindings: { expression: { kind: "expression", source: "time" } } }}
        onStoredChange={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    const field = screen.getByRole("textbox", { name: /rotate expression/i });
    fireEvent.change(field, { target: { value: "smoothstep(0, 1, time)" } });
    fireEvent.keyDown(field, { key: "Enter" });

    const status = screen.getByRole("status");
    expect(status.textContent).toContain("smoothstep");
    for (const name of ["clamp", "mod", "sin"]) expect(status.textContent).toContain(name);
  });

  it("accepts the oscillation everyone reaches for first", () => {
    const onStoredChange = vi.fn();
    render(
      <ParameterControl
        parameterKey="r"
        definition={{ type: "number", label: "Rotate", default: 0, min: -360, max: 360 }}
        value={0}
        slot={{ mode: "expression", bindings: { expression: { kind: "expression", source: "time" } } }}
        onStoredChange={onStoredChange}
        onChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Rotate" }));
    const field = screen.getByRole("textbox", { name: /rotate expression/i });
    fireEvent.change(field, { target: { value: "sin(time) * 180" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(onStoredChange).toHaveBeenCalledWith(
      { r: { mode: "expression", bindings: { expression: { kind: "expression", source: "sin(time) * 180" } } } },
      "commit",
    );
  });
});

/**
 * T543 — the asset row gives the FILENAME the width. The session-only caveat is true
 * and worth saying ONCE — in the tooltip, which carries it at every width — not as row
 * chrome that fought the name and the button until all three ellipsized.
 */
describe("asset row layout (T543)", () => {
  it("shows no inline session caveat; the tooltip carries it", () => {
    render(
      <ParameterControl
        parameterKey="file"
        definition={{ type: "asset", label: "Audio file", kind: "audio" }}
        value={"blob:x#track.wav"}
        onChange={vi.fn()}
      />,
    );
    expect(screen.queryByText(/this session only/)).toBeNull();
    const row = screen.getByRole("group", { name: "Audio file" });
    expect(row.getAttribute("title")).toContain("this session only");
    expect(row.getAttribute("title")).toContain("track.wav");
    // The filename is rendered in full for the row to ellipsize by CSS, never pre-cut.
    expect(screen.getByText("track.wav")).toBeDefined();
  });
});

/**
 * T652 — clicking a numeric field and clicking away must not change its value.
 *
 * T648 fixed the MANIFESTS — every starter component's published default now declares a
 * step that holds it, and the catalogue's remaining 27 are frozen as a ratchet (§V597).
 * This is the FIELD, which is where the loss actually happens and which no manifest can
 * reach: the 27 are still live in the product, and so are the 19 vector components T648's
 * walk cannot see.
 *
 * `beginTextEntry` seeds the input with `formatNumber(value)`, and blurring ran that
 * string straight back through the commit path — parsed, quantised, emitted — for a user
 * who typed nothing. Since a derived step's grid is an artifact of the declared range
 * rather than an author's statement, the author's own value routinely is not on it, so
 * the "no-op" changed the number: measured across the catalogue, 46 of 300 numeric
 * defaults could not survive a click and a click away.
 *
 * §V461 — THE SPEC HERE IS THE FIXTURE AND IT IS LOAD-BEARING. The file's shared `spec`
 * is `{ min: 0, max: 1, step: 0.01 }`, on which 0.5 sits perfectly and every assertion
 * below would pass whether or not anything was fixed. These use `transform.s`'s real
 * shape — a 2-vector on -8..8 with NO declared step, whose derived grid is 0.16 anchored
 * at -8 and lands on 0.96 and 1.12 and never on 1 — which is the measured instance. A
 * later simplification back to the tidy 0..1 spec re-blinds this completely.
 *
 * The catalogue-wide half (every default survives its own reset, on every shape) is in
 * `tests/guardrails/parameter-precision.test.ts`, beside T648's own gate.
 */
describe("T652 — an untouched numeric field commits nothing", () => {
  /** `transform.s`: the real spec, and the reason it can distinguish (§V461). */
  const offGrid: NumericSpec = { min: -8, max: 8, range: "soft" };

  const openField = (field: HTMLElement): void => {
    fireEvent.pointerDown(field, { pointerId: 1, clientX: 5, button: 0 });
    fireEvent.pointerUp(field, { pointerId: 1, clientX: 5 });
  };

  it("survives a click and a click away", () => {
    const { field, input, onChange } = renderNumber({ value: 1, defaultValue: 1, spec: offGrid });
    openField(field);
    fireEvent.blur(input);
    // Not "emitted 1" — emitted NOTHING. A field that re-commits its own value on every
    // blur writes an undo entry for a glance, which is its own bug (§V29).
    expect(onChange).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-valuenow")).toBe("1");
  });

  it("survives a click and Enter, which loses the value the same way", () => {
    // Guarded in `commitText` rather than in the blur handler precisely so these two
    // cannot disagree: Enter on an untouched field destroyed the value too, just less
    // accidentally, and a fix that only covered blur would be a gate with a hole in it.
    const { field, input, onChange } = renderNumber({ value: 1, defaultValue: 1, spec: offGrid });
    openField(field);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("still commits when the user actually types something", () => {
    // NON-VACUITY for both cases above: the same fixture, one keystroke different, does
    // all the work. A guard that swallowed real entries would pass them and fail here.
    const { field, input, changes } = renderNumber({ value: 1, defaultValue: 1, spec: offGrid });
    openField(field);
    fireEvent.change(input, { target: { value: "2" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changes.at(-1)?.[1]).toBe("commit");
    // 2, not 2.08. This assertion read 2.08 until T989, pinning the other half of the same
    // bug: the derived 0.16 grid — a number chosen so a full-range drag is 200 px — was a
    // lattice typed entry had to land on, so a user who typed "2" got 2.08. T652 stopped
    // the field committing numbers nobody entered; T989 stops it altering the ones they do.
    expect(changes.at(-1)?.[0]).toBe(2);
  });

  it("keeps a typed value finer than the drag granularity (T989)", () => {
    // The owner's report, on this file's own off-grid fixture: entry precision must not be
    // the drag's precision. 2.03 is inside one 0.16-wide rung and used to snap to 2.08.
    const { field, input, changes } = renderNumber({ value: 1, defaultValue: 1, spec: offGrid });
    openField(field);
    fireEvent.change(input, { target: { value: "2.03" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(changes.at(-1)?.[0]).toBe(2.03);
  });

  it("resets to the number the author wrote, not to the nearest grid point", () => {
    // The other half: `onDoubleClick` ran the DEFAULT through `normalizeValue`, so
    // double-clicking a Transform's Scale to reset it committed 0.96.
    const { field, changes } = renderNumber({ value: 3, defaultValue: 1, spec: offGrid });
    fireEvent.doubleClick(field);
    expect(changes.at(-1)).toEqual([1, "commit"]);
  });
});
