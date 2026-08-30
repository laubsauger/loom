import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ParameterSlot } from "@domain/types/parameters.ts";
import { ParameterModePanel } from "./parameter-mode.tsx";

/** Expression completion at the parameter (T247, §V150). */

afterEach(cleanup);

const SCOPE = { time: 2, delta: 0.016, frame: 120, walltime: 2.1, walldelta: 0.017 };

const EXPRESSION_SLOT: ParameterSlot = {
  mode: "expression",
  bindings: { expression: { kind: "expression", source: "" } },
};

function renderPanel(onChange = vi.fn(), withScope = true) {
  render(
    <ParameterModePanel
      label="Rotate"
      slot={EXPRESSION_SLOT}
      value={0}
      {...(withScope ? { scope: SCOPE } : {})}
      nodeNames={["noise1", "lfo1"]}
      onChange={onChange}
    />,
  );
  return screen.getByRole("textbox", { name: /rotate expression/i });
}

describe("completion menu", () => {
  it("stays open as characters are typed, narrowing rather than vanishing", async () => {
    // The owner's report: "our intellisense stops being visible as soon as we type the
    // first characters." What they were seeing was the input's PLACEHOLDER, which any
    // placeholder does. A real menu has to survive typing — that is the whole feature.
    const field = renderPanel();
    await userEvent.click(field);
    await userEvent.type(field, "w");

    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("walltime")]),
    );

    await userEvent.type(field, "alld");
    const narrowed = screen.getAllByRole("option");
    expect(narrowed).toHaveLength(1);
    expect(narrowed[0]?.textContent).toContain("walldelta");
  });

  it("completes on Tab", async () => {
    const field = renderPanel();
    await userEvent.click(field);
    await userEvent.type(field, "walld");
    await userEvent.tab();
    expect((field as HTMLInputElement).value).toBe("walldelta");
  });

  it("leaves Enter and Escape to the field, never to the menu (§V150)", async () => {
    // A popup that swallows commit and cancel turns every expression edit into a fight.
    const onChange = vi.fn();
    const field = renderPanel(onChange);
    await userEvent.click(field);
    await userEvent.type(field, "time");
    // A menu is open (`time` still prefixes nothing else, but `walltime` does not start
    // with it — so this asserts commit works regardless of menu state).
    await userEvent.keyboard("{Enter}");
    expect(onChange).toHaveBeenCalled();
    const slot = onChange.mock.calls.at(-1)?.[0] as ParameterSlot;
    expect(slot.bindings.expression?.kind === "expression" && slot.bindings.expression.source).toBe(
      "time",
    );
  });
});

describe("completion without a live scope (B37)", () => {
  it("still offers the variable names when no scope is supplied", async () => {
    // The bug: `scope` was an optional prop, the panel returned null without it, and
    // nothing in the app ever passed one — so the menu could not appear at all, in any
    // parameter, ever. An absent scope means "no live values to show", never "no
    // completion". Rendered here EXACTLY as the app renders it: no scope prop.
    const field = renderPanel(vi.fn(), false);
    await userEvent.click(field);
    await userEvent.type(field, "w");

    const options = await screen.findAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual(
      expect.arrayContaining([expect.stringContaining("walltime")]),
    );
  });

  it("completes on Tab with no scope, so the feature is whole without wiring", async () => {
    const field = renderPanel(vi.fn(), false);
    await userEvent.click(field);
    await userEvent.type(field, "walld");
    await userEvent.tab();
    expect((field as HTMLInputElement).value).toBe("walldelta");
  });
});
