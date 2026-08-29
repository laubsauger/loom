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
    expect(screen.getByLabelText(accessibleName, { exact: false })).toBeDefined();
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
