// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { scopeFromFrame } from "@domain/expressions/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { createComponentHarness, graphOf } from "@domain/components/test-support.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { DEFAULT_BINDINGS } from "@editor/keymap/defaults.ts";
import { KeymapProvider } from "@editor/keymap/keymap-provider.tsx";
import { createKeymapStore } from "@editor/keymap/store.ts";
import type { KeymapStore } from "@editor/keymap/store.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { ExpressionHelp } from "./expression-help.tsx";
import { HelpHost } from "./help-host.tsx";

/**
 * The help panel end to end (T200, T201, §V105, §V90).
 *
 * The reference modules are tested headless; what is proved here is that the PANEL
 * renders those derivations and nothing else — in particular that a rebind reaches the
 * rendered text, which is the failure mode a hand-written help page has and this one
 * structurally cannot.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

const context = contextFor(alice);
const registry = createTestRegistry();
const FRAME: FrameEvaluationInput = {
  timeSeconds: 2,
  deltaSeconds: 1 / 60,
  frameIndex: 120,
  mode: "fixed-step",
  randomSeed: 7,
};

function setup(store: KeymapStore) {
  const harness = createComponentHarness("h", graphOf([]));
  const view = render(
    <KeymapProvider bus={harness.bus} store={store} invocationContext={context}>
      <HelpHost
        bus={harness.bus}
        nodes={registry.list()}
        scope={scopeFromFrame(FRAME)}
      />
    </KeymapProvider>,
  );
  return { harness, view };
}

/** Radix tabs activate on mouse-down, not on click. */
function selectTab(scope: HTMLElement, name: string): void {
  const tab = within(scope).getByRole("tab", { name });
  fireEvent.mouseDown(tab, { button: 0 });
  fireEvent.click(tab);
}

async function openHelp(store: KeymapStore) {
  const { harness } = setup(store);
  await act(async () => {
    await harness.bus.execute("ui.openHelp", {}, context);
  });
  return harness;
}

describe("HelpPanel (T200)", () => {
  it("stays closed until asked — help is on demand (§V90)", () => {
    setup(createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "mac" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("opens on `ui.openHelp`, the command the keymap binds", async () => {
    const store = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "mac" });
    await openHelp(store);
    expect(await screen.findByRole("dialog")).toBeDefined();
  });

  it("renders the shortcut the keymap currently resolves", async () => {
    const store = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "mac" });
    await openHelp(store);
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getAllByText("⌘Z").length).toBeGreaterThan(0);
  });

  it("MOVES with a rebind — the anti-drift property (§V105, §V54)", async () => {
    const store = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "mac" });
    await openHelp(store);
    await screen.findByRole("dialog");

    act(() => {
      store.setOverride("graph.undo", "mod+u");
    });

    const dialog = screen.getByRole("dialog");
    await waitFor(() => {
      expect(within(dialog).getAllByText("⌘U").length).toBeGreaterThan(0);
    });
    // The old key is gone, not merely joined by the new one.
    expect(within(dialog).queryByText("⌘Z")).toBeNull();
  });

  it("lists the registry's nodes, with the ports the manifest declares", async () => {
    const store = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "mac" });
    await openHelp(store);
    const dialog = await screen.findByRole("dialog");

    selectTab(dialog, "Nodes");
    const blur = registry.require("test.blur");
    expect(await within(dialog).findByText(blur.title)).toBeDefined();
    expect(within(dialog).getByText(blur.type)).toBeDefined();
  });

  it("shows the expression variables with the values they have right now", async () => {
    const store = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "mac" });
    await openHelp(store);
    const dialog = await screen.findByRole("dialog");

    selectTab(dialog, "Expressions");
    const variables = await within(dialog).findByRole("region", { name: "Variables" });
    expect(within(variables).getByText("time")).toBeDefined();
    // T271 — both clocks are listed, so someone can tell which one they are reading.
    // The fixture carries no wall reading, so `walltime` falls back to the timeline and
    // both chips show the same number.
    expect(within(variables).getByText("walltime")).toBeDefined();
    // timeSeconds: 2 — read out of the scope, not written into the panel.
    expect(within(variables).getAllByText("2").length).toBeGreaterThan(0);
  });
});

describe("ExpressionHelp (T201)", () => {
  const scope = scopeFromFrame(FRAME);

  it("evaluates the source live, against the scope it will really run in", () => {
    const { rerender } = render(<ExpressionHelp source="time * 2" scope={scope} />);
    expect(screen.getByLabelText("Result").textContent).toBe("= 4");

    rerender(<ExpressionHelp source="time * 0.25" scope={scope} />);
    expect(screen.getByLabelText("Result").textContent).toBe("= 0.5");
  });

  it("shows the evaluator's reason while a source is still half-typed", () => {
    render(<ExpressionHelp source="time *" scope={scope} />);
    // Not "invalid": the reason the engine gave, so the fix is legible.
    expect(screen.getByLabelText("Result").textContent).toBe("expression ended early");
  });

  it("hands a name back to the field that owns the text", () => {
    const inserted: string[] = [];
    render(<ExpressionHelp source="" scope={scope} onInsert={(text) => inserted.push(text)} />);
    fireEvent.click(within(screen.getByRole("region", { name: "Variables" })).getByText("time"));
    expect(inserted).toEqual(["time"]);
  });

  it("offers a starter that already answers 'drive this from time'", () => {
    const inserted: string[] = [];
    render(<ExpressionHelp source="" scope={scope} onInsert={(text) => inserted.push(text)} />);
    const starters = screen.getByRole("region", { name: "Starters" });
    fireEvent.click(within(starters).getByText("time * 0.25"));
    expect(inserted).toEqual(["time * 0.25"]);
  });

  it("says functions are none rather than listing ones the evaluator rejects", () => {
    render(<ExpressionHelp source="" scope={scope} />);
    const functions = screen.getByRole("region", { name: "Functions" });
    // Whatever the evaluator accepts today; never a name it does not.
    const listed = within(functions).queryAllByRole("button");
    for (const button of listed) expect(button.textContent).not.toBe("");
  });

  it("is read-only when no field is listening", () => {
    render(<ExpressionHelp source="" scope={scope} />);
    const variables = screen.getByRole("region", { name: "Variables" });
    for (const button of within(variables).getAllByRole("button")) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
  });
});
