// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "../../ui/testing/install-dom-stubs.ts";
import { alice, contextFor, createHarness } from "../../domain/commands/test-support.ts";
import { KeymapProvider } from "../keymap/keymap-provider.tsx";
import { createKeymapStore } from "../keymap/store.ts";
import { DEFAULT_BINDINGS } from "../keymap/defaults.ts";
import { CommandPalette } from "./command-palette.tsx";

/**
 * The palette end to end (T79, §V55, §V29): the hotkey names a bus command, the bus
 * opens the palette, and choosing an entry runs a command back through the same bus.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

function setup(options: { open?: boolean } = {}) {
  const { bus } = createHarness();
  const executed: string[] = [];
  const realExecute = bus.execute.bind(bus);
  vi.spyOn(bus, "execute").mockImplementation((name, input, context) => {
    executed.push(name);
    return realExecute(name, input, context);
  });

  const store = createKeymapStore({
    defaults: DEFAULT_BINDINGS,
    storage: null,
    platform: "other",
  });

  render(
    <KeymapProvider bus={bus} store={store} invocationContext={contextFor(alice)}>
      <CommandPalette defaultOpen={options.open ?? false} />
    </KeymapProvider>,
  );
  return { bus, executed };
}

const modK = { key: "k", code: "KeyK", ctrlKey: true };

describe("opening", () => {
  it("opens from the mod+k binding, through the bus (§V52, §V29)", async () => {
    const { executed } = setup();
    expect(screen.queryByRole("combobox")).toBeNull();

    await act(async () => {
      fireEvent.keyDown(window, modK);
    });

    // The hotkey did not call a component handler — it executed a named command.
    expect(executed).toContain("ui.openCommandPalette");
    expect(await screen.findByRole("combobox", { name: "Search commands" })).toBeDefined();
  });

  it("registers its own command exactly once per bus", () => {
    const { bus } = setup();
    expect(bus.hasCommand("ui.openCommandPalette")).toBe(true);
    expect(bus.listCommands().filter((name) => name === "ui.openCommandPalette").length).toBe(1);
  });
});

describe("listing (§V55)", () => {
  it("lists commands registered on the bus with their current shortcut", () => {
    setup({ open: true });
    const options = screen.getAllByRole("option");
    const labels = options.map((option) => option.textContent ?? "");
    expect(labels.some((label) => label.includes("Undo") && label.includes("Ctrl+Z"))).toBe(true);
    expect(labels.some((label) => label.includes("graph.applyPatch"))).toBe(true);
  });

  it("shows a bound-but-unregistered command as unavailable rather than crashing", () => {
    setup({ open: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "play" } });
    const option = screen.getAllByRole("option")[0];
    expect(option?.textContent).toContain("transport.togglePlay");
    expect(option?.getAttribute("aria-disabled")).toBe("true");
  });

  it("does not run an unavailable command, and says why", () => {
    const { executed } = setup({ open: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "play" } });
    fireEvent.click(screen.getAllByRole("option")[0] as HTMLElement);
    expect(executed).not.toContain("transport.togglePlay");
    expect(screen.getByRole("status").textContent).toContain("not available yet");
  });
});

describe("running a command", () => {
  it("dispatches the selected command through the bus and closes", async () => {
    const { executed } = setup({ open: true });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "redo" } });

    const first = screen.getAllByRole("option")[0];
    expect(within(first as HTMLElement).getByText("graph.redo")).toBeDefined();

    await act(async () => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(executed).toContain("graph.redo");
    await waitFor(() => expect(screen.queryByRole("combobox")).toBeNull());
  });

  it("moves the active option with the arrow keys (§V19)", () => {
    setup({ open: true });
    const input = screen.getByRole("combobox");
    fireEvent.change(input, { target: { value: "graph" } });

    const before = screen.getAllByRole("option");
    expect(before[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    const after = screen.getAllByRole("option");
    expect(after[0]?.getAttribute("aria-selected")).toBe("false");
    expect(after[1]?.getAttribute("aria-selected")).toBe("true");
    expect(input.getAttribute("aria-activedescendant")).toBe(after[1]?.id);
  });

  it("reports an empty result set instead of an empty box", () => {
    setup({ open: true });
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "zzzzzz" } });
    expect(screen.queryAllByRole("option")).toEqual([]);
    expect(screen.getByText("No matching command.")).toBeDefined();
  });
});

describe("typing in the palette never reaches the graph (§V53)", () => {
  it("swallows mod+z typed in the search field", async () => {
    const { executed } = setup({ open: true });
    const input = screen.getByRole("combobox");
    await act(async () => {
      fireEvent.keyDown(input, { key: "z", code: "KeyZ", ctrlKey: true, bubbles: true });
    });
    expect(executed).not.toContain("graph.undo");
  });
});
