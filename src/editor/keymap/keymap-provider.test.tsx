// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "../../ui/testing/install-dom-stubs.ts";
import { alice, contextFor, createHarness } from "../../domain/commands/test-support.ts";
import { KEYMAP_CONTEXT_ATTRIBUTE } from "./context.ts";
import { KeyHint } from "./key-hint.tsx";
import { KeymapProvider } from "./keymap-provider.tsx";
import { createKeymapStore } from "./store.ts";
import type { KeyBinding } from "./types.ts";

/** The React layer: one window listener, and the display API menus consume (§V55). */

beforeAll(installDomStubs);
afterEach(cleanup);

const bindings: KeyBinding[] = [
  { id: "undo", keys: "mod+z", context: "global", command: "graph.undo", label: "Undo" },
  {
    id: "bypass",
    keys: "b",
    context: "graph",
    command: "graph.redo",
    label: "Toggle bypass",
  },
];

function setup(children?: React.ReactNode) {
  const { bus } = createHarness();
  const executed: string[] = [];
  const realExecute = bus.execute.bind(bus);
  vi.spyOn(bus, "execute").mockImplementation((name, input, context) => {
    executed.push(name);
    return realExecute(name, input, context);
  });
  const store = createKeymapStore({ defaults: bindings, storage: null, platform: "other" });

  render(
    <KeymapProvider bus={bus} store={store} invocationContext={contextFor(alice)}>
      <div {...{ [KEYMAP_CONTEXT_ATTRIBUTE]: "graph" }} data-testid="canvas">
        <button type="button">node</button>
        <input aria-label="rename" />
      </div>
      {children}
    </KeymapProvider>,
  );
  return { bus, executed, store };
}

describe("window listener", () => {
  it("dispatches a global binding", async () => {
    const { executed } = setup();
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", code: "KeyZ", ctrlKey: true });
    });
    expect(executed).toEqual(["graph.undo"]);
  });

  it("resolves the pane context from the DOM, not from a prop nobody remembered to pass", async () => {
    const { executed } = setup();
    await act(async () => {
      fireEvent.keyDown(screen.getByRole("button", { name: "node" }), {
        key: "b",
        code: "KeyB",
        bubbles: true,
      });
    });
    expect(executed).toEqual(["graph.redo"]);
  });

  it("does not fire a graph binding from a text field inside the graph (§V53)", async () => {
    const { executed } = setup();
    await act(async () => {
      fireEvent.keyDown(screen.getByLabelText("rename"), { key: "b", code: "KeyB", bubbles: true });
    });
    expect(executed).toEqual([]);
  });

  it("leaves a key alone once something closer has handled it", async () => {
    const { executed } = setup();
    await act(async () => {
      const event = new KeyboardEvent("keydown", {
        key: "z",
        code: "KeyZ",
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      });
      event.preventDefault();
      window.dispatchEvent(event);
    });
    expect(executed).toEqual([]);
  });
});

describe("KeyHint (§V55)", () => {
  it("renders the current shortcut for a command", () => {
    setup(<KeyHint command="graph.undo" data-testid="hint" />);
    expect(screen.getByTestId("hint").textContent).toBe("Ctrl+Z");
  });

  it("follows a rebind instead of going stale", () => {
    const { store } = setup(<KeyHint command="graph.undo" data-testid="hint" />);
    act(() => {
      store.setOverride("undo", "mod+u");
    });
    expect(screen.getByTestId("hint").textContent).toBe("Ctrl+U");
  });

  it("renders nothing for a command with no binding", () => {
    setup(<KeyHint command="project.save" data-testid="hint" />);
    expect(screen.queryByTestId("hint")).toBeNull();
  });

  it("can be asked for a binding id instead of a command", () => {
    setup(<KeyHint bindingId="bypass" data-testid="hint" />);
    expect(screen.getByTestId("hint").textContent).toBe("b");
  });
});
