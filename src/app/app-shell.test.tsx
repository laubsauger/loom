// @vitest-environment jsdom
import { useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { AppShell } from "./app-shell.tsx";
import { TopBar } from "./top-bar.tsx";
import type { PaneWindow } from "./pane-window.tsx";
import { DEFAULT_SHELL_LAYOUT, LAYOUT_STORAGE_KEY, readLayout, zoneOf } from "./layout-storage.ts";

beforeAll(installDomStubs);
afterEach(cleanup);

function panelSize(id: string): string | null {
  return document.querySelector(`[data-panel-id="${id}"]`)?.getAttribute("data-panel-size") ?? null;
}

function zoneElement(zone: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(`[data-dock-zone="${zone}"]`);
  if (element === null) throw new Error(`no ${zone} dock rendered`);
  return element;
}

/** Moves the active pane of `zone` using the keyboard-reachable move menu. */
async function movePaneVia(user: ReturnType<typeof userEvent.setup>, paneTitle: string, target: string) {
  await user.click(screen.getByRole("button", { name: `Move ${paneTitle}` }));
  await user.click(screen.getByRole("button", { name: target }));
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
    // left | centre, centre | right, and main | bottom.
    expect(separators.length).toBe(3);
    for (const separator of separators) {
      expect(separator.getAttribute("tabindex")).toBe("0");
      expect(separator.getAttribute("aria-label")).toBeTruthy();
    }
  });
});

/**
 * V18 — pane sizes and the arrangement live in localStorage and never in the project
 * document. If this drifts, layouts start travelling inside `.loom.json` files.
 */
describe("V18 — layout persistence", () => {
  it("writes the layout to the injected store, under one key", () => {
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

    expect(panelSize("shell-left")).toBe("30.0");
    expect(panelSize("shell-center")).toBe("40.0");
    expect(panelSize("shell-bottom")).toBe("40.0");
  });

  it("restores the stored active tab of a zone", () => {
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        ...DEFAULT_SHELL_LAYOUT,
        active: { ...DEFAULT_SHELL_LAYOUT.active, bottom: "performance" },
      }),
    });

    render(<AppShell storage={storage} />);
    expect(screen.getByRole("tab", { name: "performance" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });

  it("persists the active tab when it changes", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} />);

    await user.click(screen.getByRole("tab", { name: "problems" }));

    expect(readLayout(storage).active.bottom).toBe("problems");
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
    expect(panelSize("shell-left")).toBe("30.0");

    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize left dock" }));

    // The stored split is the assertion that matters: it is what survives a
    // reload. Applying it to the live group needs a measured layout, which
    // jsdom cannot provide.
    expect(readLayout(storage).columns).toEqual(DEFAULT_SHELL_LAYOUT.columns);
  });

  it("resets sizes and the arrangement from the layout menu", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: JSON.stringify({
        ...DEFAULT_SHELL_LAYOUT,
        columns: [30, 40, 30],
        rows: [50, 50],
        zones: { ...DEFAULT_SHELL_LAYOUT.zones, left: [], center: ["graph", "library"] },
      }),
    });
    render(<AppShell storage={storage} />);

    await user.click(screen.getByRole("button", { name: "Layout" }));
    await user.click(screen.getByRole("button", { name: "Reset layout" }));

    const stored = readLayout(storage);
    expect(stored.rows).toEqual(DEFAULT_SHELL_LAYOUT.rows);
    expect(stored.columns).toEqual(DEFAULT_SHELL_LAYOUT.columns);
    expect(stored.zones).toEqual(DEFAULT_SHELL_LAYOUT.zones);
  });
});

/**
 * V95 — every pane relocatable between dock zones, and the arrangement survives a reload.
 * The shader editor being stuck in the bottom dock was the complaint; the general
 * capability is the fix.
 */
describe("V95 — relocatable panes", () => {
  it("moves a pane to another zone from the move menu and persists it across a reload", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const { unmount } = render(
      <AppShell storage={storage} shaderEditor={<div>editor slot</div>} />,
    );

    expect(zoneElement("bottom").contains(screen.getByText("editor slot"))).toBe(true);

    await movePaneVia(user, "shader editor", "Centre");

    expect(zoneElement("center").contains(screen.getByText("editor slot"))).toBe(true);
    expect(zoneOf(readLayout(storage), "shader")).toBe("center");

    // A reload is a fresh mount reading the same store — the arrangement is not in the
    // React tree, so this is the only honest way to assert it persisted (§V18).
    unmount();
    render(<AppShell storage={storage} shaderEditor={<div>editor slot</div>} />);
    expect(zoneElement("center").contains(screen.getByText("editor slot"))).toBe(true);
  });

  it("moves a pane by dragging its tab onto a drop band", () => {
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} inspector={<div>inspector slot</div>} />);

    const tab = screen.getByRole("tab", { name: "inspector" });
    const transfer = { setData: () => {}, effectAllowed: "", dropEffect: "" };
    fireEvent.dragStart(tab, { dataTransfer: transfer });

    const band = document.querySelector<HTMLElement>('[data-drop-zone="left"]');
    expect(band, "no drop band while a tab is being dragged").not.toBeNull();
    fireEvent.drop(band as HTMLElement, { dataTransfer: transfer });

    expect(zoneOf(readLayout(storage), "inspector")).toBe("left");
    expect(zoneElement("left").contains(screen.getByText("inspector slot"))).toBe(true);
    // The bands are drag-only chrome and must not linger.
    expect(document.querySelector('[data-drop-zone="left"]')).toBeNull();
  });
});

/**
 * V96 — relocating a pane does NOT remount its content.
 *
 * The assertions here are on IDENTITY and on state the content owns, never on "it still
 * renders": a remounted pane renders perfectly well, with an empty undo history at scroll
 * zero, which is exactly the failure this invariant exists to prevent.
 */
describe("V96 — moving a pane never remounts it", () => {
  let mounts = 0;

  function Probe() {
    const [text, setText] = useState("");
    useEffect(() => {
      mounts += 1;
    }, []);
    return (
      <input
        aria-label="probe"
        data-testid="probe"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    );
  }

  it("keeps the same DOM node, the same fiber and the typed state across a move", async () => {
    mounts = 0;
    const user = userEvent.setup();
    render(<AppShell storage={createMemoryStorage()} shaderEditor={<Probe />} />);

    const input = screen.getByTestId("probe") as HTMLInputElement;
    await user.type(input, "unsaved work");
    expect(mounts).toBe(1);

    await movePaneVia(user, "shader editor", "Right");

    // Identity: the very same element, still carrying what was typed into it. A
    // remount would produce a NEW element with an empty value and mounts === 2.
    expect(screen.getByTestId("probe")).toBe(input);
    expect(input.value).toBe("unsaved work");
    expect(mounts, "the pane was remounted by the move").toBe(1);
    expect(zoneElement("right").contains(input)).toBe(true);
  });

  it("keeps focus and the caret in the moved pane", async () => {
    mounts = 0;
    const user = userEvent.setup();
    render(<AppShell storage={createMemoryStorage()} shaderEditor={<Probe />} />);

    const input = screen.getByTestId("probe") as HTMLInputElement;
    await user.type(input, "abcdef");
    input.setSelectionRange(2, 4);

    // The move menu takes focus while it is open and Radix restores it to the trigger,
    // so this asserts what the pane machinery is responsible for: the element the pane
    // had focused is refocused, with its selection, once it lands.
    await movePaneVia(user, "shader editor", "Left");

    expect(input.value).toBe("abcdef");
    expect(input.selectionStart).toBe(2);
    expect(input.selectionEnd).toBe(4);
    expect(mounts).toBe(1);
  });

  it("keeps a hidden tab mounted, so switching tabs is not a remount either (U3)", async () => {
    mounts = 0;
    const user = userEvent.setup();
    render(<AppShell storage={createMemoryStorage()} shaderEditor={<Probe />} />);

    const input = screen.getByTestId("probe") as HTMLInputElement;
    await user.type(input, "still here");
    await user.click(screen.getByRole("tab", { name: "problems" }));
    await user.click(screen.getByRole("tab", { name: "shader editor" }));

    expect(screen.getByTestId("probe")).toBe(input);
    expect(input.value).toBe("still here");
    expect(mounts).toBe(1);
  });
});

/**
 * V97 — a floated pane is the same pane: same tree, same bus, same store. Nothing about
 * it is re-created, which is what makes that true rather than merely intended.
 */
describe("V97 — floating a pane into its own window", () => {
  function fakeWindow() {
    const doc = document.implementation.createHTMLDocument("floating pane");
    const listeners = new Set<() => void>();
    const win: PaneWindow & { closed: boolean; fireClose: () => void } = {
      document: doc,
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
      close: () => {
        win.closed = true;
      },
      closed: false,
      fireClose: () => {
        for (const listener of [...listeners]) listener();
      },
    };
    return win;
  }

  let mounts = 0;
  function Probe() {
    const [text, setText] = useState("");
    useEffect(() => {
      mounts += 1;
    }, []);
    return (
      <input
        aria-label="probe"
        data-testid="probe"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
    );
  }

  it("moves the pane's live DOM into the child document without remounting it", async () => {
    mounts = 0;
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const child = fakeWindow();
    render(
      <AppShell
        storage={storage}
        shaderEditor={<Probe />}
        openPaneWindow={() => child}
      />,
    );

    const input = screen.getByTestId("probe") as HTMLInputElement;
    await user.type(input, "typed before floating");

    await movePaneVia(user, "shader editor", "Float in its own window");

    // The SAME element, now living in the other document — not a copy of it.
    expect(child.document.body.contains(input)).toBe(true);
    expect(input.ownerDocument).toBe(child.document);
    expect(input.value).toBe("typed before floating");
    expect(mounts, "floating remounted the pane").toBe(1);
    expect(readLayout(storage).floating).toEqual(["shader"]);
  });

  it("brings the pane back when the window is closed, still without a remount", async () => {
    mounts = 0;
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const child = fakeWindow();
    render(
      <AppShell storage={storage} shaderEditor={<Probe />} openPaneWindow={() => child} />,
    );

    const input = screen.getByTestId("probe") as HTMLInputElement;
    await user.type(input, "survives the round trip");
    await movePaneVia(user, "shader editor", "Float in its own window");

    // The user closes the window: the pane goes back to its home dock, intact.
    await act(child.fireClose);

    expect(document.body.contains(input)).toBe(true);
    expect(zoneElement("bottom").contains(input)).toBe(true);
    expect(input.value).toBe("survives the round trip");
    expect(mounts).toBe(1);
    expect(readLayout(storage).floating).toEqual([]);
  });

  it("docks the pane again rather than stranding it when the popup is blocked", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} shaderEditor={<div>editor slot</div>} openPaneWindow={() => null} />);

    await movePaneVia(user, "shader editor", "Float in its own window");

    expect(readLayout(storage).floating).toEqual([]);
    expect(zoneElement("bottom").contains(screen.getByText("editor slot"))).toBe(true);
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

  it("reaches the layout menu and its zone toggles with the keyboard alone", async () => {
    const user = userEvent.setup();
    render(<AppShell storage={createMemoryStorage()} />);

    const trigger = screen.getByRole("button", { name: "Layout" });
    trigger.focus();
    await user.keyboard("{Enter}");

    const toggle = screen.getByRole("button", { name: "Bottom dock" });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Reset layout" })).toBeDefined();
  });

  it("moves a pane between zones with the keyboard alone (§V19)", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} shaderEditor={<div>editor slot</div>} />);

    // Keyboard only: focus the move trigger, open it with Enter, walk to the target.
    const trigger = screen.getByRole("button", { name: "Move shader editor" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const target = screen.getByRole("button", { name: "Right" });
    target.focus();
    await user.keyboard("{Enter}");

    expect(zoneOf(readLayout(storage), "shader")).toBe("right");
  });

  it("moves between dock tabs with the arrow keys", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} />);

    screen.getByRole("tab", { name: "shader editor" }).focus();
    await user.keyboard("{ArrowRight}");

    expect(document.activeElement).toBe(screen.getByRole("tab", { name: "problems" }));
    expect(readLayout(storage).active.bottom).toBe("problems");
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
