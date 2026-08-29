// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { AppShell } from "./app-shell.tsx";
import { TopBar } from "./top-bar.tsx";
import { DEFAULT_SHELL_LAYOUT, LAYOUT_STORAGE_KEY, readLayout } from "./layout-storage.ts";

beforeAll(installDomStubs);
afterEach(cleanup);

function panelSize(id: string): string | null {
  return document.querySelector(`[data-panel-id="${id}"]`)?.getAttribute("data-panel-size") ?? null;
}

describe("app shell layout (§I.ui)", () => {
  it("renders every pane slot the spec names", () => {
    render(
      <AppShell
        storage={createMemoryStorage()}
        nodeLibrary={<div>library slot</div>}
        graphCanvas={<div>canvas slot</div>}
        inspector={<div>inspector slot</div>}
        viewer={<div>viewer slot</div>}
        shaderEditor={<div>editor slot</div>}
      />,
    );

    expect(screen.getByText("library slot")).toBeDefined();
    expect(screen.getByText("canvas slot")).toBeDefined();
    expect(screen.getByText("inspector slot")).toBeDefined();
    expect(screen.getByText("viewer slot")).toBeDefined();
    expect(screen.getByText("editor slot")).toBeDefined();
    // Top bar: transport + fps + GPU ms + capability tier.
    expect(screen.getByRole("group", { name: "Transport" })).toBeDefined();
    expect(screen.getByLabelText("Frames per second")).toBeDefined();
    expect(screen.getByLabelText("GPU time per frame")).toBeDefined();
  });

  it("names the STATE for a slot no track has filled yet, not the pane's purpose (§V91)", () => {
    render(<AppShell storage={createMemoryStorage()} />);
    expect(screen.getByText("No canvas")).toBeDefined();
    expect(screen.getByText("No library")).toBeDefined();
  });

  it("gives every divider a focusable separator with a name", () => {
    render(<AppShell storage={createMemoryStorage()} />);
    const separators = screen.getAllByRole("separator");
    // library | graph | right, and the dock divider.
    expect(separators.length).toBe(4);
    for (const separator of separators) {
      expect(separator.getAttribute("tabindex")).toBe("0");
      expect(separator.getAttribute("aria-label")).toBeTruthy();
    }
  });
});

/**
 * V18 — pane sizes live in localStorage and never in the project document.
 * If this drifts, layouts start travelling inside `.loom.json` files.
 */
describe("V18 — layout persistence", () => {
  it("writes pane sizes to the injected store, under one key", () => {
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} />);

    expect(storage.keys()).toEqual([LAYOUT_STORAGE_KEY]);
    expect(readLayout(storage).columns).toEqual(DEFAULT_SHELL_LAYOUT.columns);
  });

  it("restores stored pane sizes on mount", () => {
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        ...DEFAULT_SHELL_LAYOUT,
        columns: [30, 40, 30],
        rows: [60, 40],
      }),
    });

    render(<AppShell storage={storage} />);

    expect(panelSize("shell-library")).toBe("30.0");
    expect(panelSize("shell-graph")).toBe("40.0");
    expect(panelSize("shell-dock")).toBe("40.0");
  });

  it("restores the stored dock tab", () => {
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({ ...DEFAULT_SHELL_LAYOUT, dockTab: "performance" }),
    });

    render(<AppShell storage={storage} />);
    expect(screen.getByRole("tab", { name: "performance" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("persists the dock tab when it changes", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} />);

    await user.click(screen.getByRole("tab", { name: "problems" }));

    expect(readLayout(storage).dockTab).toBe("problems");
  });

  it("runs without persistence when no store is available", () => {
    render(<AppShell storage={null} />);
    expect(screen.getByRole("tab", { name: "shader editor" })).toBeDefined();
  });

  it("double-clicking a divider resets that group to its default split", () => {
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({ ...DEFAULT_SHELL_LAYOUT, columns: [30, 40, 30] }),
    });
    render(<AppShell storage={storage} />);
    expect(panelSize("shell-library")).toBe("30.0");

    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize node library" }));

    // The stored split is the assertion that matters: it is what survives a
    // reload. Applying it to the live group needs a measured layout, which
    // jsdom cannot provide.
    expect(readLayout(storage).columns).toEqual(DEFAULT_SHELL_LAYOUT.columns);
  });

  it("resets the whole layout from the layout menu", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        ...DEFAULT_SHELL_LAYOUT,
        columns: [30, 40, 30],
        rows: [50, 50],
        rightRows: [70, 30],
      }),
    });
    render(<AppShell storage={storage} />);

    await user.click(screen.getByRole("button", { name: "Layout" }));
    await user.click(screen.getByRole("button", { name: "Reset layout" }));

    const stored = readLayout(storage);
    expect(stored.rows).toEqual(DEFAULT_SHELL_LAYOUT.rows);
    expect(stored.columns).toEqual(DEFAULT_SHELL_LAYOUT.columns);
    expect(stored.rightRows).toEqual(DEFAULT_SHELL_LAYOUT.rightRows);
  });
});

/**
 * V19 — everything reachable from the keyboard. The shell is the frame every
 * other track hangs controls on, so its own chrome has to pass first.
 */
describe("V19 — keyboard reachability", () => {
  it("walks the top bar in visual order with Tab", async () => {
    const user = userEvent.setup();
    const noop = () => {};
    render(
      <AppShell
        storage={createMemoryStorage()}
        topBar={<TopBar onPlayPause={noop} onStep={noop} onResetTime={noop} />}
      />,
    );

    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Play" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Step one frame" }));
    await user.tab();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Reset time" }));
  });

  it("reaches the layout menu and its pane toggles with the keyboard alone", async () => {
    const user = userEvent.setup();
    render(<AppShell storage={createMemoryStorage()} />);

    const trigger = screen.getByRole("button", { name: "Layout" });
    trigger.focus();
    await user.keyboard("{Enter}");

    const toggle = screen.getByRole("button", { name: "Bottom dock" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Reset layout" })).toBeDefined();
  });

  it("moves between dock tabs with the arrow keys", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} />);

    screen.getByRole("tab", { name: "shader editor" }).focus();
    await user.keyboard("{ArrowRight}");

    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "problems" }));
    expect(readLayout(storage).dockTab).toBe("problems");
  });

  it("keeps focus on a divider so it can be resized from the keyboard", async () => {
    const user = userEvent.setup();
    render(<AppShell storage={createMemoryStorage()} />);

    const separator = screen.getByRole("separator", { name: "Resize bottom dock" });
    separator.focus();
    expect(document.activeElement).toBe(separator);

    await user.keyboard("{ArrowUp}");
    expect(document.activeElement).toBe(separator);
  });
});
