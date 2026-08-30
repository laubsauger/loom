// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import { evaluateExpression, scopeFromFrame } from "@domain/expressions/index.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { createComponentHarness, graphOf } from "@domain/components/test-support.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { DEFAULT_BINDINGS } from "@editor/keymap/defaults.ts";
import { KeymapProvider } from "@editor/keymap/keymap-provider.tsx";
import { KEYMAP_STORAGE_KEY } from "@editor/keymap/storage.ts";
import { createKeymapStore } from "@editor/keymap/store.ts";
import type { KeymapStore } from "@editor/keymap/store.ts";
import type { KeyBinding } from "@editor/keymap/types.ts";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
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
    // The CHIP, not any text saying "time": T461's note under this section names the
    // clocks in prose too, and a bare text query cannot tell a control from a sentence.
    expect(within(variables).getByRole("button", { name: /^time/ })).toBeDefined();
    // T271 — both clocks are listed, so someone can tell which one they are reading.
    // The fixture carries no wall reading, so `walltime` falls back to the timeline and
    // both chips show the same number.
    expect(within(variables).getByText("walltime")).toBeDefined();
    // timeSeconds: 2 — read out of the scope, not written into the panel.
    expect(within(variables).getAllByText("2").length).toBeGreaterThan(0);
  });
});

/**
 * The shortcuts tab is the shortcut EDITOR (T360, §V54, §V307).
 *
 * The keymap has taken overrides since T78 and nothing in the product wrote one, so a
 * user could read every binding and change none. What is proved here is that the list a
 * user READS and the list a user CHANGES are one list: the rebind goes through the store,
 * the store re-resolves, and the same rows re-render — there is no second surface holding
 * a copy that could disagree.
 */
const EDITABLE: KeyBinding[] = [
  { id: "undo", keys: "mod+z", context: "global", command: "graph.undo", label: "Undo" },
  { id: "redo", keys: "mod+shift+z", context: "global", command: "graph.redo", label: "Redo" },
];

describe("the shortcuts tab edits the keymap (T360)", () => {
  const editable = (storage: ReturnType<typeof createMemoryStorage> | null = null): KeymapStore =>
    createKeymapStore({ defaults: EDITABLE, storage, platform: "other" });

  async function openEditor(store: KeymapStore) {
    await openHelp(store);
    return screen.findByRole("dialog");
  }

  const keysButton = (label: string): HTMLElement =>
    screen.getByRole("button", { name: `Change shortcut for ${label}` });

  it("rebinds from the next keystroke, and the list it was read from moves", async () => {
    const store = editable();
    const dialog = await openEditor(store);
    expect(within(dialog).getByText("Ctrl+Z")).toBeDefined();

    fireEvent.click(keysButton("Undo"));
    fireEvent.keyDown(keysButton("Undo"), { key: "u", code: "KeyU", ctrlKey: true });

    expect(store.getSnapshot().byId.get("undo")?.effectiveKeys).toBe("mod+u");
    await waitFor(() => {
      expect(within(screen.getByRole("dialog")).getByText("Ctrl+U")).toBeDefined();
    });
    // The old key is gone from the list, not merely joined by the new one.
    expect(within(screen.getByRole("dialog")).queryByText("Ctrl+Z")).toBeNull();
  });

  it("persists the override to local storage, never to the document (§V18)", async () => {
    const storage = createMemoryStorage();
    const store = editable(storage);
    await openEditor(store);

    fireEvent.click(keysButton("Undo"));
    fireEvent.keyDown(keysButton("Undo"), { key: "u", code: "KeyU", ctrlKey: true });

    expect(JSON.parse(storage.getItem(KEYMAP_STORAGE_KEY) ?? "{}")).toEqual({ undo: "mod+u" });
  });

  it("names the command already holding the chord instead of stealing it in silence", async () => {
    const store = editable();
    await openEditor(store);

    fireEvent.click(keysButton("Redo"));
    fireEvent.keyDown(keysButton("Redo"), { key: "z", code: "KeyZ", ctrlKey: true });

    // Applied — refusing would strand anyone swapping two keys through a third — and
    // said out loud, naming the other side. Both are needed: a silent steal leaves the
    // user believing a key still works that no longer does.
    expect(store.getSnapshot().byId.get("redo")?.effectiveKeys).toBe("mod+z");
    const status = within(screen.getByRole("dialog")).getByRole("status");
    expect(status.textContent).toContain("Ctrl+Z");
    expect(status.textContent).toContain("Undo");
    // And the rows say so on their own, for anyone who reads the list later.
    await waitFor(() => {
      expect(within(screen.getByRole("dialog")).getAllByText("conflict").length).toBe(2);
    });
  });

  it("cancels on Escape and keeps the panel open — one press, one job (§V302)", async () => {
    const store = editable();
    await openEditor(store);

    fireEvent.click(keysButton("Undo"));
    fireEvent.keyDown(keysButton("Undo"), { key: "Escape", code: "Escape" });

    expect(store.hasOverride("undo")).toBe(false);
    // Dismissing in the same press would hide the cancel: the user never sees the row
    // they were editing again.
    expect(screen.queryByRole("dialog")).not.toBeNull();
    expect(within(screen.getByRole("dialog")).getByRole("status").textContent).toContain(
      "cancelled",
    );
  });

  it("unbinds on Backspace — 'no shortcut' is a state, not an absence", async () => {
    const store = editable();
    await openEditor(store);

    fireEvent.click(keysButton("Undo"));
    fireEvent.keyDown(keysButton("Undo"), { key: "Backspace", code: "Backspace" });

    expect(store.getSnapshot().byId.get("undo")?.isBound).toBe(false);
    await waitFor(() => {
      expect(within(screen.getByRole("dialog")).getByText("unbound")).toBeDefined();
    });
  });

  it("offers a reset only on a row the user changed, and restores that row alone", async () => {
    const store = editable();
    await openEditor(store);
    expect(screen.queryByRole("button", { name: "Reset shortcut for Undo" })).toBeNull();

    act(() => {
      store.setOverride("undo", "mod+u");
      store.setOverride("redo", "mod+y");
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Reset shortcut for Undo" })).toBeDefined();
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset shortcut for Undo" }));
    expect(store.getSnapshot().byId.get("undo")?.effectiveKeys).toBe("mod+z");
    expect(store.getSnapshot().byId.get("redo")?.effectiveKeys).toBe("mod+y");
  });

  it("puts every action on a real button, so the keymap is editable from the keyboard (§V19)", async () => {
    const store = editable();
    await openEditor(store);
    expect(keysButton("Undo").tagName).toBe("BUTTON");

    act(() => {
      store.setOverride("undo", "mod+u");
    });
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: "Reset shortcut for Undo" }).tagName,
      ).toBe("BUTTON");
    });
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
    fireEvent.click(
      within(screen.getByRole("region", { name: "Variables" })).getByRole("button", {
        name: /^time/,
      }),
    );
    expect(inserted).toEqual(["time"]);
  });

  it("offers a starter that already answers 'drive this from time'", () => {
    const inserted: string[] = [];
    render(<ExpressionHelp source="" scope={scope} onInsert={(text) => inserted.push(text)} />);
    const starters = screen.getByRole("region", { name: "Starters" });
    fireEvent.click(within(starters).getByText("time * 0.25"));
    expect(inserted).toEqual(["time * 0.25"]);
  });

  it("lists functions with their CALL SHAPE, and only ones the evaluator accepts", () => {
    render(<ExpressionHelp source="" scope={scope} />);
    const functions = screen.getByRole("region", { name: "Functions" });
    const listed = within(functions).queryAllByRole("button");
    // T370: the shape is the useful half. `clamp` alone does not tell you it takes three
    // arguments, which is the only thing about it anyone gets wrong.
    expect(listed.map((button) => button.textContent)).toContain("clamp(x, low, high)");
    // §V150: nothing here may be a name the grammar rejects. Every chip is run.
    for (const button of listed) {
      const signature = button.textContent ?? "";
      const name = signature.slice(0, signature.indexOf("("));
      expect(name).not.toBe("");
      const arity = signature === `${name}()` ? 0 : signature.split(",").length;
      const call = `${name}(${Array.from({ length: arity }, () => "1").join(", ")})`;
      expect(evaluateExpression(call).ok, call).toBe(true);
    }
  });

  it("is read-only when no field is listening", () => {
    render(<ExpressionHelp source="" scope={scope} />);
    const variables = screen.getByRole("region", { name: "Variables" });
    for (const button of within(variables).getAllByRole("button")) {
      expect(button.hasAttribute("disabled")).toBe(true);
    }
  });
});
