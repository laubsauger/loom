// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { AppShell } from "./app-shell.tsx";
import { AppRuntimeContext } from "./app-context.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { LayoutStorage } from "./layout-storage.ts";
import {
  DEFAULT_LAYOUT_ID,
  DEFAULT_SHELL_LAYOUT,
  LAYOUT_STORAGE_KEY,
  readLayoutStore,
} from "./layout-storage.ts";
import { readPaneTreeStore } from "./pane-tree-storage.ts";
import { DEFAULT_PANE_TREE, leavesOf } from "./pane-tree.ts";
import { OPEN_LAYOUTS_COMMAND, RESET_LAYOUT_COMMAND } from "./layout-commands.ts";

/**
 * T436 / §V307 — the layout menu is opened by a COMMAND.
 *
 * §V307's whole point is three doors for the price of one: the top bar's button, the
 * command palette and a rebindable key. Registering is not the same as being INVOCABLE
 * (§V342) and neither proves the handler does anything (§B48), so these run against the
 * composed app with NO GPU — the shape of §B48, where a registration inside a
 * backend-gated effect left two keys and two buttons dead — and assert the EFFECT: the
 * menu is on screen, the layout actually changed.
 *
 * What this does NOT assert: a default KEY. `ui.openLayouts` ships unbound on purpose —
 * see the report and `layout-commands.ts`. A binding would be a fourth thing for the
 * hotkey audit to check and it is not needed to reach the menu.
 *
 * The shell is mounted inside the runtime provider rather than through `App`, because
 * `App` also registers the WebMCP surface against a browser global and that leaks into
 * every other file in the worker. The registration under test is the SHELL's, and it sits
 * in no backend-gated effect — mounting it with no GPU and no backend at all is the §B48
 * condition either way.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

async function mountApp(storage: LayoutStorage): Promise<AppRuntime> {
  const runtime = createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
  await act(async () => {
    render(
      <AppRuntimeContext.Provider value={runtime}>
        <AppShell storage={storage} />
      </AppRuntimeContext.Provider>,
    );
  });
  return runtime;
}

describe("T436 — the layout menu's bus commands", () => {
  it("registers both commands at a GPU-less mount (§B48)", async () => {
    const runtime = await mountApp(createMemoryStorage());
    expect(runtime.bus.hasCommand(OPEN_LAYOUTS_COMMAND)).toBe(true);
    expect(runtime.bus.hasCommand(RESET_LAYOUT_COMMAND)).toBe(true);
  });

  it("opens the menu — the surface is on screen, not merely dispatched to", async () => {
    const runtime = await mountApp(createMemoryStorage());
    expect(screen.queryByRole("button", { name: "Save as…" })).toBeNull();

    await act(async () => {
      await runtime.bus.execute(OPEN_LAYOUTS_COMMAND, {}, runtime.invocation);
    });

    // The verbs the menu exists for are reachable, which is what "opened" has to mean.
    expect(screen.getByRole("button", { name: "Save as…" })).toBeDefined();
    expect(screen.getByRole("button", { name: /^Default/ })).toBeDefined();
  });

  it("resets a rearranged shell back to the default, sizes and all", async () => {
    // Boot on a layout that is NOT the default, so the reset has real work to do.
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        version: 3,
        currentId: null,
        layouts: [],
        current: {
          ...DEFAULT_SHELL_LAYOUT,
          rows: [40, 60],
          zones: { ...DEFAULT_SHELL_LAYOUT.zones, left: ["library", "components", "shader"], bottom: ["problems", "performance", "examples", "agent"] },
        },
      }),
    });
    const runtime = await mountApp(storage);
    expect(readLayoutStore(storage).current.zones.left).toContain("shader");

    await act(async () => {
      await runtime.bus.execute(RESET_LAYOUT_COMMAND, {}, runtime.invocation);
    });

    /*
     * T927: asserted on the v5 TREE store. `layout.reset` restores the Default PRESET,
     * which is now the tree default — and that arrangement has no faithful v3
     * projection, so the v3 key is removed (V385) and `readLayoutStore` would answer
     * with its own stock fallback. That fallback happens to equal the old expectation,
     * i.e. this gate would have gone green whether or not the reset ran at all.
     */
    const after = readPaneTreeStore(storage);
    expect(after.current).toEqual(DEFAULT_PANE_TREE);
    expect(after.currentId).toBe(DEFAULT_LAYOUT_ID);
    // The rearrangement the shell booted on is genuinely gone.
    expect(
      leavesOf(after.current.root).find((leaf) => leaf.tabs.some((tab) => tab.role === "shader"))?.id,
    ).toBe("leaf-bottom");
  });
});
