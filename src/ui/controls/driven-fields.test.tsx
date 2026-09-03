// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ResolvedComponent } from "@domain/parameters/resolve.ts";
import type {
  ColorParameter,
  ParameterValue,
  StoredParameter,
  VectorParameter,
} from "@domain/types/parameters.ts";
import { installDomStubs } from "../testing/install-dom-stubs.ts";
import { NumberField } from "./number-field.tsx";
import { ParameterControl } from "./parameter-control.tsx";
import type { EditPhase } from "./types.ts";

/**
 * §V830 (T988) — a parameter that is not its own static value says so POSITIVELY, keeps
 * updating, and stays reachable.
 *
 * The owner: "All kinds of inputs that are somehow bound, that have an expression active
 * in whatever way, or are somehow not their static value — they do need to update to
 * whatever's coming in there. They can't stay static or be disabled-looking. They need to
 * make clear that they ARE driven."
 *
 * What shipped was `disabled`. Refusing the edit was right — a drag the resolver
 * overwrites on the next frame is a lie — but `disabled` is the browser's word for inert
 * and unimportant: it dimmed the number to `--text-disabled`, dropped the field out of tab
 * order and told a screen reader to skip it, for the ONE moving value on the panel. And
 * grey is also what broken, loading, unsupported and not-licensed look like, so the state
 * could not be read off the pixel at all.
 *
 * Every assertion below is one half of that pair: the edit is still refused, AND the field
 * is still a field. A test that only checked the refusal would pass on the shipped bug.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const vector: VectorParameter = {
  type: "vector",
  label: "Offset",
  size: 2,
  default: [1, 2],
  min: -100,
  max: 100,
};

const color: ColorParameter = {
  type: "color",
  label: "Tint",
  default: [1, 1, 1, 1],
  space: "display",
};

/** A stored slot that is not a bare value — what makes a channel carry its own mode. */
const expressionSlot: StoredParameter = {
  mode: "expression",
  bindings: { expression: { kind: "expression", source: "frame.time" } },
};

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

const field = (name: string): HTMLInputElement =>
  screen.getByRole("spinbutton", { name }) as HTMLInputElement;

// ---- the leaf control ------------------------------------------------

describe("§V830 — NumberField refuses the edit without going inert", () => {
  function renderDriven(props: { drivenBy?: string; disabled?: boolean } = {}) {
    const changes: [number, EditPhase][] = [];
    render(
      <NumberField
        label="Radius"
        value={0.5}
        spec={{ min: 0, max: 1, step: 0.01 }}
        {...props}
        onChange={(value, phase) => changes.push([value, phase])}
      />,
    );
    const input = field("Radius");
    return { changes, input, box: input.parentElement as HTMLElement };
  }

  it("is NOT disabled: focusable, announced, and legible", () => {
    const { input } = renderDriven({ drivenBy: "Expression" });

    // The whole point. `disabled` here is the bug, not the feature.
    expect(input.disabled).toBe(false);
    expect(input.getAttribute("aria-readonly")).toBe("true");
    // The value is still announced as a value, not skipped as chrome.
    expect(input.getAttribute("aria-valuenow")).toBe("0.5");

    input.focus();
    expect(document.activeElement, "a driven field must stay in the tab order").toBe(input);
  });

  it("carries a POSITIVE mark naming what drives it, not just the absence of editing", () => {
    const { box } = renderDriven({ drivenBy: "Expression" });
    const mark = box.parentElement?.querySelector("[title]");
    // "E" — the same letter the Expression mode button shows.
    expect(mark?.textContent).toBe("E");
    expect(mark?.getAttribute("title")).toBe("Radius — Expression");
    // And the field says so structurally, so the styling has something to hang on.
    expect(box.getAttribute("data-driven")).toBe("true");
  });

  it("still refuses every gesture that would write", () => {
    const { changes, input, box } = renderDriven({ drivenBy: "Expression" });

    fireEvent.pointerDown(box, { pointerId: 1, clientX: 10, button: 0 });
    fireEvent.pointerMove(box, { pointerId: 1, clientX: 90 });
    fireEvent.pointerUp(box, { pointerId: 1, clientX: 90 });
    fireEvent.doubleClick(box);
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyUp(input, { key: "ArrowUp" });
    // The synthetic write a `readOnly` attribute alone would not stop.
    fireEvent.change(input, { target: { value: "0.9" } });
    fireEvent.blur(input);

    expect(changes, "a driven field emitted a value the resolver would overwrite").toEqual([]);
  });

  it("leaves an ordinary field editable — the case the refusal could swallow", () => {
    const { changes, input, box } = renderDriven();
    expect(box.getAttribute("data-driven")).toBe("false");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyUp(input, { key: "ArrowUp" });
    expect(changes.at(-1)?.[0]).toBeCloseTo(0.51, 6);
  });

  it("keeps `disabled` meaning disabled — the two states are not merged", () => {
    // §V146 and friends still need a genuinely unavailable control, and it must still
    // read as one: out of the tab order, no driven mark.
    const { input, box } = renderDriven({ disabled: true });
    expect(input.disabled).toBe(true);
    expect(box.getAttribute("data-driven")).toBe("false");
  });
});

// ---- through the real dispatcher, which is what the inspector mounts ----

describe("§V113/§V830 — a compound's driven CHANNEL, through ParameterControl", () => {
  function renderVector(liveValue?: ParameterValue) {
    const changes: [ParameterValue, EditPhase][] = [];
    const stored = vi.fn();
    const view = render(
      <ParameterControl
        parameterKey="offset"
        definition={vector}
        value={[1, 2]}
        {...(liveValue === undefined ? {} : { liveValue })}
        components={componentsFor(["x", "y"], [1, 2], "y")}
        onStoredChange={stored}
        onChange={(value, phase) => changes.push([value, phase])}
      />,
    );
    return { changes, stored, view };
  }

  it("marks the driven axis and leaves its sibling fully editable", () => {
    const { changes, stored } = renderVector();

    const y = field("Offset y");
    expect(y.disabled, "the driven axis must not be disabled").toBe(false);
    expect(y.getAttribute("aria-readonly")).toBe("true");
    expect(y.parentElement?.getAttribute("data-driven")).toBe("true");

    const x = field("Offset x");
    expect(x.disabled).toBe(false);
    expect(x.getAttribute("aria-readonly")).toBeNull();
    expect(x.parentElement?.getAttribute("data-driven")).toBe("false");

    // y refuses...
    fireEvent.change(y, { target: { value: "9" } });
    fireEvent.blur(y);
    expect(changes).toEqual([]);
    expect(stored).not.toHaveBeenCalled();

    // ...and x, whose own mode IS static, still writes. This is the §V113 seat the whole
    // per-component model exists for, and a blanket refusal would have taken it away.
    fireEvent.change(x, { target: { value: "7" } });
    fireEvent.blur(x);
    expect(stored).toHaveBeenCalledTimes(1);
    const entries = stored.mock.calls[0]?.[0] as Record<string, StoredParameter>;
    expect(entries["offset.x"]).toMatchObject({ bindings: { static: { kind: "static", value: 7 } } });
  });

  it("shows the LIVE value in the driven axis, and keeps showing the stored one elsewhere", () => {
    // T893's live sample arrives as the whole compound tuple; §V830's job is that the
    // driven axis renders it instead of sitting on the retained number.
    const { view } = renderVector([1, 42]);
    expect(field("Offset y").value).toBe("42");
    expect(field("Offset x").value).toBe("1");

    view.rerender(
      <ParameterControl
        parameterKey="offset"
        definition={vector}
        value={[1, 2]}
        liveValue={[1, 77]}
        components={componentsFor(["x", "y"], [1, 2], "y")}
        onStoredChange={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    // It KEEPS moving — one update would be a coincidence, not a live readout.
    expect(field("Offset y").value).toBe("77");
  });

  it("locks the colour's all-or-nothing writers without disabling the readout", () => {
    render(
      <ParameterControl
        parameterKey="tint"
        definition={color}
        value={[1, 0.5, 0, 1]}
        components={componentsFor(["r", "g", "b", "a"], [1, 0.5, 0, 1], "g")}
        onStoredChange={vi.fn()}
        onChange={vi.fn()}
      />,
    );

    // The hex field writes all four channels, so it refuses — as a READ-ONLY field, which
    // still shows the colour that is actually on screen and still takes focus.
    const hex = screen.getByRole("textbox", { name: "Tint hex" }) as HTMLInputElement;
    expect(hex.disabled).toBe(false);
    expect(hex.readOnly).toBe(true);
    expect(hex.getAttribute("aria-readonly")).toBe("true");

    // The swatch stays operable: opening the panel to LOOK at a driven colour's channels
    // is the request, and a disabled trigger made that impossible.
    const swatch = screen.getByRole("button", { name: "Tint — edit channels" }) as HTMLButtonElement;
    expect(swatch.disabled).toBe(false);
  });
});

describe("§V830 — a driven STRING is read-only, not disabled", () => {
  it("keeps the text legible and focusable while refusing the edit", () => {
    const changes: [ParameterValue, EditPhase][] = [];
    render(
      <ParameterControl
        parameterKey="name"
        definition={{ type: "string", label: "Name", default: "idle" }}
        value="idle"
        liveValue="running"
        slot={expressionSlot as never}
        onStoredChange={vi.fn()}
        onChange={(value, phase) => changes.push([value, phase])}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement;
    // It shows what is IN EFFECT, which is the whole complaint: a bound input that sits
    // on its stored value tells the user nothing about what is running.
    expect(input.value).toBe("running");
    expect(input.disabled).toBe(false);
    expect(input.readOnly).toBe(true);
    input.focus();
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: "typed" } });
    fireEvent.blur(input);
    expect(changes).toEqual([]);
  });
});

describe("§V830 — the row says which mode is deciding the value", () => {
  it("badges the mode by name rather than leaving grey to mean four things", () => {
    render(
      <ParameterControl
        parameterKey="size"
        definition={{ type: "number", label: "Size", default: 4, min: 0, max: 10 }}
        value={4}
        slot={expressionSlot as never}
        onStoredChange={vi.fn()}
        onChange={vi.fn()}
      />,
    );
    expect(screen.getByTitle(/^expr — /)).toHaveProperty("textContent", "expr");
    // ...and the field beneath it is the driven one, not a disabled one.
    expect(field("Size").disabled).toBe(false);
    expect(field("Size").getAttribute("aria-readonly")).toBe("true");
  });
});
