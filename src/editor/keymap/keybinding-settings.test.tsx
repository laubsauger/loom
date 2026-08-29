// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "../../ui/testing/install-dom-stubs.ts";
import { KeybindingSettings } from "./keybinding-settings.tsx";
import { KEYMAP_STORAGE_KEY } from "./storage.ts";
import { createKeymapStore } from "./store.ts";
import type { KeyBinding } from "./types.ts";

/** Rebinding, conflict surfacing and reset (T78, §V54, §V19). */

beforeAll(installDomStubs);
afterEach(cleanup);

const bindings: KeyBinding[] = [
  { id: "undo", keys: "mod+z", context: "global", command: "graph.undo", label: "Undo" },
  { id: "redo", keys: "mod+shift+z", context: "global", command: "graph.redo", label: "Redo" },
  {
    id: "bypass",
    keys: "b",
    context: "graph",
    command: "node.toggleBypass",
    label: "Toggle bypass",
  },
];

function setup() {
  const storage = createMemoryStorage();
  const store = createKeymapStore({ defaults: bindings, storage, platform: "other" });
  render(<KeybindingSettings store={store} isCommandAvailable={(name) => name.startsWith("graph.")} />);
  return { store, storage };
}

function rowFor(label: string): HTMLElement {
  const cell = screen.getByText(label);
  const row = cell.closest("tr");
  if (row === null) throw new Error(`No row for "${label}".`);
  return row;
}

describe("keybinding settings", () => {
  it("lists bindings with their platform-correct shortcut", () => {
    setup();
    expect(within(rowFor("Undo")).getByText("Ctrl+Z")).toBeDefined();
    expect(within(rowFor("Toggle bypass")).getByText("b")).toBeDefined();
  });

  it("marks a command no track has registered yet", () => {
    setup();
    expect(within(rowFor("Toggle bypass")).getByText("unavailable")).toBeDefined();
    expect(within(rowFor("Undo")).queryByText("unavailable")).toBeNull();
  });

  it("rebinds from a captured keystroke and persists it (§V54)", () => {
    const { store, storage } = setup();
    const row = rowFor("Undo");
    const change = within(row).getByRole("button", { name: "Change shortcut for Undo" });
    fireEvent.click(change);
    fireEvent.keyDown(change, { key: "u", code: "KeyU", ctrlKey: true });

    expect(store.getSnapshot().byId.get("undo")?.effectiveKeys).toBe("mod+u");
    expect(within(rowFor("Undo")).getByText("Ctrl+U")).toBeDefined();
    expect(within(rowFor("Undo")).getByText("custom")).toBeDefined();
    // localStorage, never the project document.
    expect(JSON.parse(storage.getItem(KEYMAP_STORAGE_KEY) ?? "{}")).toEqual({ undo: "mod+u" });
  });

  it("cancels capture on Escape without changing anything", () => {
    const { store } = setup();
    const change = within(rowFor("Undo")).getByRole("button", { name: "Change shortcut for Undo" });
    fireEvent.click(change);
    fireEvent.keyDown(change, { key: "Escape", code: "Escape" });
    expect(store.hasOverride("undo")).toBe(false);
    expect(screen.getByRole("status").textContent).toContain("cancelled");
  });

  it("surfaces a conflict naming both bindings instead of silently shadowing one", () => {
    setup();
    const change = within(rowFor("Redo")).getByRole("button", { name: "Change shortcut for Redo" });
    fireEvent.click(change);
    fireEvent.keyDown(change, { key: "z", code: "KeyZ", ctrlKey: true });

    const conflicts = screen.getByRole("list", { name: "Shortcut conflicts" });
    expect(conflicts.textContent).toContain("Ctrl+Z");
    expect(within(rowFor("Undo")).getByText(/also runs Redo/)).toBeDefined();
    expect(within(rowFor("Redo")).getByText(/also runs Undo/)).toBeDefined();
    expect(screen.getByRole("status").textContent).toContain("Conflict");
  });

  it("unbinds a shortcut and says so", () => {
    const { store } = setup();
    fireEvent.click(within(rowFor("Undo")).getByRole("button", { name: "Unbind Undo" }));
    expect(store.getSnapshot().byId.get("undo")?.isBound).toBe(false);
    expect(within(rowFor("Undo")).getByText("Unbound")).toBeDefined();
  });

  it("resets one binding without touching the others", () => {
    const { store } = setup();
    act(() => {
      store.setOverride("undo", "mod+u");
      store.setOverride("redo", "mod+y");
    });

    fireEvent.click(within(rowFor("Undo")).getByRole("button", { name: "Reset Undo to default" }));
    expect(store.getSnapshot().byId.get("undo")?.effectiveKeys).toBe("mod+z");
    expect(store.getSnapshot().byId.get("redo")?.effectiveKeys).toBe("mod+y");
  });

  it("resets the whole map", () => {
    const { store, storage } = setup();
    act(() => {
      store.setOverride("undo", "mod+u");
      store.setOverride("bypass", null);
    });

    fireEvent.click(screen.getByRole("button", { name: "Reset all" }));
    expect(store.getOverrides()).toEqual({});
    expect(storage.getItem(KEYMAP_STORAGE_KEY)).toBeNull();
    expect(within(rowFor("Undo")).getByText("Ctrl+Z")).toBeDefined();
  });

  it("disables reset-all until something has been changed", () => {
    setup();
    const resetAll = screen.getByRole("button", { name: "Reset all" });
    expect(resetAll.hasAttribute("disabled")).toBe(true);
  });

  it("filters the list", () => {
    setup();
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "bypass" } });
    expect(screen.queryByText("Undo")).toBeNull();
    expect(screen.getByText("Toggle bypass")).toBeDefined();
  });

  it("drives every action from a real button, for keyboard reach (§V19)", () => {
    setup();
    const row = rowFor("Undo");
    for (const name of ["Change shortcut for Undo", "Unbind Undo", "Reset Undo to default"]) {
      const button = within(row).getByRole("button", { name });
      expect(button.tagName).toBe("BUTTON");
    }
  });
});
