// @vitest-environment jsdom
import { StrictMode, useEffect, useState } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { AppShell } from "./app-shell.tsx";
import { TopBar } from "./top-bar.tsx";
import type { PaneWindow } from "./pane-window.tsx";
import {
  DEFAULT_SHELL_LAYOUT,
  LAYOUT_STORAGE_KEY,
  readLayout,
  readLayoutStore,
  zoneOf,
} from "./layout-storage.ts";
import { PANE_TREE_STORAGE_KEY, readPaneTreeStore } from "./pane-tree-storage.ts";
import { findLeaf } from "./pane-tree.ts";
import type { ShellLayout } from "./layout-storage.ts";

beforeAll(installDomStubs);
afterEach(cleanup);

function panelSize(id: string): string | null {
  return document.querySelector(`[data-panel-id="${id}"]`)?.getAttribute("data-panel-size") ?? null;
}

/** A v3 store entry holding one layout, which is what the shell mounts from. */
function storedLayout(overrides: Partial<ShellLayout> = {}): string {
  return JSON.stringify({
    version: 3,
    currentId: null,
    layouts: [],
    current: { ...DEFAULT_SHELL_LAYOUT, ...overrides },
  });
}

function zoneElement(zone: string): HTMLElement {
  // The migration skeleton names its leaves after the old zones (T404).
  const element = document.querySelector<HTMLElement>(`[data-pane-leaf="leaf-${zone}"]`);
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
    // left | centre, centre | bottom, work | sidebar, and the sidebar's own split (T426).
    expect(separators.length).toBe(4);
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
  it("writes the v4 tree with its v3 projection beside it (V311/V385)", () => {
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} />);

    expect(storage.keys().sort()).toEqual([PANE_TREE_STORAGE_KEY, LAYOUT_STORAGE_KEY].sort());
    // The projection is a faithful v3 store while the tree stays flat-expressible.
    expect(readLayout(storage).columns).toEqual(DEFAULT_SHELL_LAYOUT.columns);
  });

  it("restores stored pane sizes on mount", () => {
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: storedLayout({
        columns: [70, 30],
        mainColumns: [30, 70],
        rows: [60, 40],
        rightRows: [35, 65],
      }),
    });

    render(<AppShell storage={storage} />);

    expect(panelSize("panel-split-main-a")).toBe("30.0");
    expect(panelSize("panel-split-main-b")).toBe("70.0");
    expect(panelSize("panel-split-rows-b")).toBe("40.0");
    expect(panelSize("panel-split-columns-b")).toBe("30.0");
    expect(panelSize("panel-split-right-a")).toBe("35.0");
    expect(panelSize("panel-split-right-b")).toBe("65.0");
  });

  it("restores the stored active tab of a zone", () => {
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: storedLayout({
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
      [LAYOUT_STORAGE_KEY]: storedLayout({ mainColumns: [30, 70] }),
    });
    render(<AppShell storage={storage} />);
    expect(panelSize("panel-split-main-a")).toBe("30.0");

    fireEvent.doubleClick(screen.getByRole("separator", { name: "Resize left dock" }));

    // The stored split is the assertion that matters: it is what survives a
    // reload. Applying it to the live group needs a measured layout, which
    // jsdom cannot provide.
    expect(readLayout(storage).mainColumns).toEqual(DEFAULT_SHELL_LAYOUT.mainColumns);
  });

  it("resets sizes and the arrangement from the layout menu", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage({
      [LAYOUT_STORAGE_KEY]: storedLayout({
        columns: [60, 40],
        rows: [50, 50],
        zones: { ...DEFAULT_SHELL_LAYOUT.zones, left: [], center: ["graph", "library"] },
      }),
    });
    render(<AppShell storage={storage} />);

    // "Reset layout" is now the Default PRESET: restoring it is the same operation, and
    // one control does the job of two (§V90).
    await user.click(screen.getByRole("button", { name: "Layout" }));
    await user.click(screen.getByRole("button", { name: /^Default/ }));

    const stored = readLayout(storage);
    expect(stored.rows).toEqual(DEFAULT_SHELL_LAYOUT.rows);
    expect(stored.columns).toEqual(DEFAULT_SHELL_LAYOUT.columns);
    expect(stored.rightRows).toEqual(DEFAULT_SHELL_LAYOUT.rightRows);
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

    await movePaneVia(user, "shader editor", "Centre dock");

    expect(zoneElement("center").contains(screen.getByText("editor slot"))).toBe(true);
    expect(zoneOf(readLayout(storage), "shader")).toBe("center");

    // A reload is a fresh mount reading the same store — the arrangement is not in the
    // React tree, so this is the only honest way to assert it persisted (§V18).
    unmount();
    render(<AppShell storage={storage} shaderEditor={<div>editor slot</div>} />);
    expect(zoneElement("center").contains(screen.getByText("editor slot"))).toBe(true);
  });

  it("moves a pane by dragging its tab onto another leaf", () => {
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} inspector={<div>inspector slot</div>} />);

    const tab = screen.getByRole("tab", { name: "inspector" });
    let carried = "";
    const transfer = {
      setData: (_type: string, value: string) => {
        carried = value;
      },
      getData: () => carried,
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(tab, { dataTransfer: transfer });

    const target = document.querySelector<HTMLElement>('[data-drop-leaf="leaf-left"]');
    expect(target, "no drop target while a tab is being dragged").not.toBeNull();
    fireEvent.drop(target as HTMLElement, { dataTransfer: transfer });

    expect(zoneOf(readLayout(storage), "inspector")).toBe("left");
    expect(zoneElement("left").contains(screen.getByText("inspector slot"))).toBe(true);
    // The targets are drag-only chrome and must not linger.
    expect(document.querySelector('[data-drop-leaf="leaf-left"]')).toBeNull();
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

    await movePaneVia(user, "shader editor", "Right dock top");

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
    await movePaneVia(user, "shader editor", "Left dock");

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

  /**
   * B51 / §V334 — the float survives StrictMode's DOUBLE MOUNT.
   *
   * The app runs under `<StrictMode>` (main.tsx), so every newly mounted effect runs
   * mount → cleanup → mount. Two individually-correct decisions collided there: the
   * window is opened by NAME so re-floating focuses rather than stacks, and the close is
   * DEFERRED to a microtask so the dock can adopt the pane back in the same commit. Mount
   * B reuses the window mount A opened, and cleanup A's queued close then killed it —
   * the flash the owner saw.
   *
   * The fake `open` here reuses by name exactly the way the browser does; without that it
   * is not this bug. A single-mount test passes against the broken code, which is why
   * this shipped.
   */
  it("keeps the window mount B adopted when StrictMode's cleanup A fires late", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const byName = new Map<string, ReturnType<typeof fakeWindow>>();
    const requested: string[] = [];
    // What `window.open("", name)` actually does: a live window with that name is
    // REUSED, and only a missing or closed one is created fresh.
    const open = ({ name }: { name: string }) => {
      requested.push(name);
      const existing = byName.get(name);
      if (existing !== undefined && !existing.closed) return existing;
      const created = fakeWindow();
      byName.set(name, created);
      return created;
    };

    render(
      <StrictMode>
        <AppShell storage={storage} shaderEditor={<Probe />} openPaneWindow={open} />
      </StrictMode>,
    );

    const probe = screen.getByTestId("probe");
    await movePaneVia(user, "shader editor", "Float in its own window");
    // The deferred close is a microtask; let it land before asserting.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(requested.length, "StrictMode did not double-mount the float").toBeGreaterThan(1);
    // The window is named by the tab's minted KEY (T393): unique per pane instance.
    const child = byName.get(requested[0] ?? "");
    expect(requested[0]).toMatch(/^loom-shader-/);
    expect(child, "no window was opened for the floated pane").toBeDefined();
    expect(child?.closed, "cleanup A closed the window mount B is using").toBe(false);
    // And the pane really is living in it — a window that is merely open is not enough.
    expect(child?.document.body.contains(probe)).toBe(true);
    expect(readLayout(storage).floating).toEqual(["shader"]);
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
    expect(screen.getByRole("button", { name: "Save as…" })).toBeDefined();
  });

  it("moves a pane between zones with the keyboard alone (§V19)", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} shaderEditor={<div>editor slot</div>} />);

    // Keyboard only: focus the move trigger, open it with Enter, walk to the target.
    const trigger = screen.getByRole("button", { name: "Move shader editor" });
    trigger.focus();
    await user.keyboard("{Enter}");
    const target = screen.getByRole("button", { name: "Right dock top" });
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

/**
 * T426 — the right sidebar runs the FULL height of the window.
 *
 * ## What this suite does NOT prove (§V339)
 *
 * jsdom paints nothing and computes no layout, so nothing here can show that the sidebar
 * is taller than it used to be. `getBoundingClientRect` is all zeroes and a "full height"
 * assertion against it would be green on a completely broken shell — that is exactly the
 * failure §B54 shipped for months.
 *
 * What IS checkable here is the STRUCTURE that produces the height: the sidebar is a
 * sibling of the whole work area rather than a child of the row above the bottom dock, so
 * there is nothing in the tree that could cut it short. The pixels are asserted in
 * `src/tests/e2e/layout.spec.ts`, in a real browser, by measuring boxes.
 */
describe("T426 — the right sidebar is a full-height column", () => {
  function panel(id: string): HTMLElement {
    const element = document.querySelector<HTMLElement>(`[data-panel-id="${id}"]`);
    if (element === null) throw new Error(`no ${id} panel rendered`);
    return element;
  }

  it("hangs the sidebar off the ROOT split, not off the row the bottom dock truncates", () => {
    render(<AppShell storage={createMemoryStorage()} />);

    const work = panel("panel-split-columns-a");
    // The bottom dock lives inside the work area…
    expect(work.contains(panel("panel-split-rows-b"))).toBe(true);
    // …and the sidebar does not, which is the whole of T426.
    expect(work.contains(panel("panel-split-columns-b"))).toBe(false);
  });

  it("splits the sidebar horizontally, viewer above inspector", () => {
    render(
      <AppShell
        storage={createMemoryStorage()}
        viewer={<div>viewer slot</div>}
        inspector={<div>inspector slot</div>}
      />,
    );

    expect(zoneElement("right").contains(screen.getByText("viewer slot"))).toBe(true);
    expect(zoneElement("rightBottom").contains(screen.getByText("inspector slot"))).toBe(true);
    // Two sections of one column: both are inside the sidebar panel, stacked.
    expect(panel("panel-split-columns-b").contains(zoneElement("right"))).toBe(true);
    expect(panel("panel-split-columns-b").contains(zoneElement("rightBottom"))).toBe(true);
  });

  it("leaves the bottom dock spanning the left and centre columns", () => {
    render(<AppShell storage={createMemoryStorage()} shaderEditor={<div>editor slot</div>} />);
    // The shader editor keeps the width it had; narrowing it was never asked for.
    const work = panel("panel-split-columns-a");
    expect(work.contains(zoneElement("left"))).toBe(true);
    expect(work.contains(zoneElement("bottom"))).toBe(true);
  });

  it("gives the sidebar's own divider a name, so it can be resized from the keyboard", () => {
    render(<AppShell storage={createMemoryStorage()} />);
    const separator = screen.getByRole("separator", { name: "Resize sidebar split" });
    expect(separator.getAttribute("tabindex")).toBe("0");
  });
});

/**
 * T436 — named layouts: save, name, update, restore, delete.
 *
 * The assertion that carries the task is UPDATE ≠ SAVE AS. An "update" that appends is
 * how a layout list becomes forty near-duplicates, so the test that matters is the one
 * counting entries after an update.
 */
describe("T436 — named layouts", () => {
  /** Idempotent: the trigger TOGGLES, and clicking an entry leaves the menu open. */
  async function openMenu(user: ReturnType<typeof userEvent.setup>) {
    if (screen.queryByRole("button", { name: "Save as…" }) !== null) return;
    await user.click(screen.getByRole("button", { name: "Layout" }));
  }

  async function saveAs(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(screen.getByRole("button", { name: "Save as…" }));
    await user.type(screen.getByRole("textbox", { name: "New layout name" }), name);
    await user.click(screen.getByRole("button", { name: "Save" }));
  }

  it("lists the built-in presets, with T426's arrangement selected on a fresh install", async () => {
    const user = userEvent.setup();
    render(<AppShell storage={createMemoryStorage()} />);
    await openMenu(user);

    expect(screen.getByRole("button", { name: /^Default/ }).getAttribute("aria-current")).toBe(
      "true",
    );
    // T470: Classic is gone — Default is the one preset that ships.
    expect(screen.queryByRole("button", { name: /^Classic/ })).toBeNull();
  });

  it("saves the live arrangement under a name and persists it across a reload", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const { unmount } = render(<AppShell storage={storage} shaderEditor={<div>editor slot</div>} />);

    await movePaneVia(user, "shader editor", "Centre dock");
    await openMenu(user);
    await saveAs(user, "Shader work");

    expect(readLayoutStore(storage).layouts.map((entry) => entry.name)).toEqual(["Shader work"]);

    unmount();
    render(<AppShell storage={storage} />);
    await openMenu(user);
    expect(screen.getByRole("button", { name: /^Shader work/ })).toBeDefined();
  });

  it("UPDATE overwrites the selected layout and does not add a second entry", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} shaderEditor={<div>editor slot</div>} />);

    await openMenu(user);
    await saveAs(user, "Mine");
    // Rearrange, then update: the entry changes, the list does not grow.
    await movePaneVia(user, "shader editor", "Left dock");
    await openMenu(user);
    await user.click(screen.getByRole("button", { name: "Update" }));

    const saved = readLayoutStore(storage).layouts;
    expect(saved, "Update appended instead of overwriting").toHaveLength(1);
    expect(saved[0]?.layout.zones.left).toContain("shader");
  });

  it("offers UPDATE only once the live arrangement has actually drifted", async () => {
    const user = userEvent.setup();
    render(<AppShell storage={createMemoryStorage()} shaderEditor={<div>editor slot</div>} />);

    await openMenu(user);
    await saveAs(user, "Mine");
    await openMenu(user);
    // Nothing has changed since the save, so there is nothing to update.
    expect(screen.getByRole("button", { name: "Update" }).hasAttribute("disabled")).toBe(true);

    await user.keyboard("{Escape}");
    await movePaneVia(user, "shader editor", "Left dock");
    await openMenu(user);
    expect(screen.getByRole("button", { name: "Update" }).hasAttribute("disabled")).toBe(false);
  });

  it("cannot update, rename or delete a PRESET — a built-in is never lost", async () => {
    const user = userEvent.setup();
    render(<AppShell storage={createMemoryStorage()} />);
    await openMenu(user);
    await user.click(screen.getByRole("button", { name: /^Default/ }));
    await openMenu(user);

    for (const verb of ["Update", "Rename", "Delete"]) {
      expect(
        screen.getByRole("button", { name: verb }).hasAttribute("disabled"),
        `${verb} is offered for a preset`,
      ).toBe(true);
    }
  });

  it("renames a saved layout in place", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} />);

    await openMenu(user);
    await saveAs(user, "First");
    await openMenu(user);
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.clear(screen.getByRole("textbox", { name: "Layout name" }));
    await user.type(screen.getByRole("textbox", { name: "Layout name" }), "Second");
    await user.click(screen.getByRole("button", { name: "Rename" }));

    const saved = readLayoutStore(storage).layouts;
    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toBe("Second");
  });

  it("deletes a saved layout without rearranging the shell", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} shaderEditor={<div>editor slot</div>} />);

    await movePaneVia(user, "shader editor", "Left dock");
    await openMenu(user);
    await saveAs(user, "Doomed");
    await openMenu(user);
    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(readLayoutStore(storage).layouts).toEqual([]);
    // The room is unchanged; only the bookmark went.
    expect(zoneElement("left").contains(screen.getByText("editor slot"))).toBe(true);
  });

  it("restores a saved layout, putting the panes back where that layout had them", async () => {
    const user = userEvent.setup();
    render(<AppShell storage={createMemoryStorage()} shaderEditor={<div>editor slot</div>} />);

    await movePaneVia(user, "shader editor", "Left dock");
    await openMenu(user);
    await saveAs(user, "Editor left");
    await movePaneVia(user, "shader editor", "Centre dock");
    expect(zoneElement("center").contains(screen.getByText("editor slot"))).toBe(true);

    await openMenu(user);
    await user.click(screen.getByRole("button", { name: /^Editor left/ }));

    expect(zoneElement("left").contains(screen.getByText("editor slot"))).toBe(true);
  });

});

/**
 * V311 — an existing user's arrangement survives the reshape.
 *
 * This is the migration seen from the shell rather than from the record: the app boots
 * against a v2 entry and what is on screen is what they left there.
 */
describe("V311 — a v2 layout still opens on what the user arranged", () => {
  it("mounts the NEW DEFAULT and keeps a customised v2 arrangement as a named layout", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage({
      "shaderloom.shell.layout.v2": JSON.stringify({
        rows: [50, 50],
        columns: [20, 50, 30],
        zones: {
          left: ["library", "components", "shader"],
          center: ["graph"],
          right: ["inspector", "viewer"],
          bottom: ["problems", "performance", "examples", "agent"],
        },
        active: { left: "shader", center: "graph", right: "viewer", bottom: "problems" },
        floating: [],
      }),
    });

    render(<AppShell storage={storage} shaderEditor={<div>editor slot</div>} />);

    // T466: the app opens on the NEW default — the owner reported twice that they never
    // saw it, because migrating and SELECTING their old arrangement made it unreachable.
    // The editor is where this build puts it, not where v2 left it.
    expect(zoneElement("left").contains(screen.queryByText("editor slot") ?? document.body)).toBe(
      false,
    );

    // And nothing is lost: their arrangement is a row in the menu, one click away.
    await user.click(screen.getByRole("button", { name: "Layout" }));
    expect(screen.getByRole("button", { name: /^Saved layout/ })).toBeDefined();
    // And v2's key is gone — the v4 tree and its v3 projection hold the layout.
    expect(storage.keys().sort()).toEqual([PANE_TREE_STORAGE_KEY, LAYOUT_STORAGE_KEY].sort());
  });
});

/**
 * T405 — two tabs of ONE role are two INSTANCES: each holds its own state, which is
 * what makes a second viewer with its own output picker true by construction rather
 * than by plumbing. The backend side of the claim (two surfaces on one output are two
 * blits of one texture) is pinned in `present-parity.gpu.test.ts`.
 */
describe("T405 — a second pane of one role is its own instance", () => {
  function CounterProbe() {
    const [count, setCount] = useState(0);
    return (
      <button type="button" data-testid="counter" onClick={() => setCount(count + 1)}>
        {`count:${count}`}
      </button>
    );
  }

  it("splitting in a second viewer gives it INDEPENDENT state", async () => {
    const user = userEvent.setup();
    render(<AppShell storage={createMemoryStorage()} viewer={<CounterProbe />} />);

    // One viewer to start; bump its counter.
    const first = screen.getByTestId("counter");
    await user.click(first);
    expect(first.textContent).toBe("count:1");

    // Split the right dock and put a SECOND viewer in the fresh leaf.
    const rightLeaf = zoneElement("right");
    await user.click(within(rightLeaf).getByRole("button", { name: "Split or close this pane area" }));
    await user.click(screen.getByRole("button", { name: "Split down" }));
    await user.click(screen.getByRole("button", { name: /^viewer$/ }));

    const counters = screen.getAllByTestId("counter");
    expect(counters).toHaveLength(2);
    // The first kept its state; the second starts fresh — two fibers, two states.
    expect(counters.map((counter) => counter.textContent).sort()).toEqual(["count:0", "count:1"]);

    await user.click(counters.find((counter) => counter.textContent === "count:0") as HTMLElement);
    expect(counters.map((counter) => counter.textContent).sort()).toEqual(["count:1", "count:1"]);
    // Still independent: bumping one did not move the other.
    const [a, b] = screen.getAllByTestId("counter");
    expect(a?.textContent).toBe("count:1");
    expect(b?.textContent).toBe("count:1");
  });
});

/**
 * V340 — the role picker on an EXISTING tab: the pane keeps its identity (place, size,
 * window name), only what it shows changes. The model half is pinned in pane-tree.test;
 * this is the control reaching it.
 */
describe("V340 — a pane can change what it shows without moving", () => {
  it("switching the viewer tab to problems keeps the leaf and the key", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} viewer={<div>viewer slot</div>} problems={<div>problems slot</div>} />);

    const rightLeaf = zoneElement("right");
    const before = rightLeaf.querySelector('[data-pane-tab]')?.getAttribute("data-pane-tab");
    await user.click(within(rightLeaf).getByRole("button", { name: "Move viewer" }));
    // T837: the "show instead" role buttons announce their intent now, so a screen reader
    // hears "Show problems here instead" rather than a bare "problems".
    await user.click(screen.getByRole("button", { name: "Show problems here instead" }));

    // Same leaf, same KEY — a different face on the same pane.
    const after = zoneElement("right").querySelector('[data-pane-tab]');
    expect(after?.getAttribute("data-pane-tab")).toBe(before);
    expect(after?.getAttribute("data-pane-role")).toBe("problems");
    // TWO problems panes now exist (the bottom dock's and this one) — legal by design.
    const instances = screen.getAllByText("problems slot");
    expect(instances).toHaveLength(2);
    expect(instances.some((element) => zoneElement("right").contains(element))).toBe(true);
  });
});

/**
 * T835 — the owner: "seems like we currently cant add a new tab to an existing pane,
 * only show instead but not add."
 *
 * `addTab` always worked; it was reachable through ONE control, the EMPTY-pane picker,
 * so a leaf that already had a tab could only SWAP (V340's `assignRole`, which keeps the
 * key). These pin the second door and, just as importantly, that it stayed a SECOND one:
 * adding must not quietly become a swap, and the swap must not start minting keys.
 */
describe("T835 — a pane that already has a tab can gain another", () => {
  /** The minimum `openPaneWindow` contract: a document to move the pane's DOM into. */
  function floatWindow(): PaneWindow {
    return {
      document: document.implementation.createHTMLDocument("floating pane"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      close: () => undefined,
    };
  }

  it("adds a tab beside the existing one, whose key and role are untouched", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} viewer={<div>viewer slot</div>} problems={<div>problems slot</div>} />);

    const before = [...zoneElement("right").querySelectorAll("[data-pane-tab]")].map((tab) =>
      tab.getAttribute("data-pane-tab"),
    );
    expect(before).toHaveLength(1);

    await user.click(within(zoneElement("right")).getByRole("button", { name: "Add a tab to this area" }));
    await user.click(screen.getByRole("button", { name: "Add problems as a new tab" }));

    const after = [...zoneElement("right").querySelectorAll("[data-pane-tab]")];
    expect(after).toHaveLength(2);
    // ADDED, not swapped: the tab that was here keeps its key AND its face (§V340).
    expect(after[0]?.getAttribute("data-pane-tab")).toBe(before[0]);
    expect(after[0]?.getAttribute("data-pane-role")).toBe("viewer");
    expect(after[0]?.getAttribute("aria-selected")).toBe("false");
    // The new one is a fresh key and it is the one you are looking at.
    expect(after[1]?.getAttribute("data-pane-tab")).not.toBe(before[0]);
    expect(after[1]?.getAttribute("data-pane-role")).toBe("problems");
    expect(after[1]?.getAttribute("aria-selected")).toBe("true");
    expect(zoneElement("right").contains(screen.getAllByText("problems slot")[1] ?? null)).toBe(true);

    // And it survives the round trip through storage, not just this render.
    const leaf = findLeaf(readPaneTreeStore(storage).current, "leaf-right");
    expect(leaf?.tabs.map((tab) => tab.role)).toEqual(["viewer", "problems"]);
    expect(leaf?.active).toBe(leaf?.tabs[1]?.key);
  });

  it("leaves the EMPTY-pane picker as the only add control on an empty leaf", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} viewer={<div>viewer slot</div>} />);

    await user.click(
      within(zoneElement("right")).getByRole("button", { name: "Split or close this pane area" }),
    );
    await user.click(screen.getByRole("button", { name: "Split down" }));

    const picker = screen.getByTestId(/^leaf-picker-/);
    const emptyLeaf = picker.closest("[data-pane-leaf]") as HTMLElement;
    // One question, asked once: the strip's + would be a second copy of the picker.
    expect(within(emptyLeaf).queryByRole("button", { name: "Add a tab to this area" })).toBeNull();

    await user.click(within(picker).getByRole("button", { name: /^viewer$/ }));

    // The original path still assigns into the empty leaf — and now that it HAS a tab,
    // the + is how it gains a second one.
    const filled = screen.getAllByText("viewer slot")[1]?.closest("[data-pane-leaf]") as HTMLElement;
    expect(filled.querySelectorAll("[data-pane-tab]")).toHaveLength(1);
    expect(within(filled).getByRole("button", { name: "Add a tab to this area" })).toBeDefined();
  });

  it("adds a tab to a leaf whose pane is FLOATED, without unfloating it (§V97)", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    const child = floatWindow();
    render(
      <AppShell
        storage={storage}
        viewer={<div>viewer slot</div>}
        performance={<div>performance slot</div>}
        openPaneWindow={() => child}
      />,
    );

    const viewerSlot = screen.getByText("viewer slot");
    await movePaneVia(user, "viewer", "Float in its own window");
    expect(readPaneTreeStore(storage).current.floating.map((tab) => tab.role)).toEqual(["viewer"]);

    // T705(b): the floated tab STAYS in its leaf, so the strip — and its + — are there.
    const before = zoneElement("right").querySelector("[data-pane-tab]")?.getAttribute("data-pane-tab");
    await user.click(within(zoneElement("right")).getByRole("button", { name: "Add a tab to this area" }));
    await user.click(screen.getByRole("button", { name: "Add performance as a new tab" }));

    const after = [...zoneElement("right").querySelectorAll("[data-pane-tab]")];
    expect(after).toHaveLength(2);
    expect(after[0]?.getAttribute("data-pane-tab")).toBe(before);
    expect(after[1]?.getAttribute("data-pane-role")).toBe("performance");
    // The floated pane is still floated, still the same live DOM in the child window.
    // (Read from the TREE, not the v3 projection: a second tab in a leaf is exactly what
    // makes the layout unprojectable, so the v3 record is cleared by design — §V385.)
    expect(readPaneTreeStore(storage).current.floating.map((tab) => tab.role)).toEqual(["viewer"]);
    expect(child.document.body.contains(viewerSlot)).toBe(true);
  });
});

/**
 * T854 — the owner: "seems like we still cant close a tab in a pane individually."
 *
 * The same shape as T835. `closeTab` shipped and `onCloseTab` was wired, but only into
 * the move menu, which renders for the ACTIVE tab — so a background tab had no route out
 * at all without first being selected. These pin the door, and that it is still a
 * DIFFERENT door from the leaf's "Close area": one takes a tab, the other takes the area
 * and every tab in it (§V340).
 */
describe("T854 — every tab carries its own close", () => {
  it("closes a NON-ACTIVE tab without selecting it first", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} />);

    // The bottom leaf holds five tabs. Make one that is NOT first the active one, so
    // "did the click select before closing?" has a visible answer: a close that ran
    // through selection would hand active back to tabs[0] (shader editor).
    const bottom = zoneElement("bottom");
    await user.click(within(bottom).getByRole("tab", { name: "problems" }));
    expect(findLeaf(readPaneTreeStore(storage).current, "leaf-bottom")?.active).toBe(
      findLeaf(readPaneTreeStore(storage).current, "leaf-bottom")?.tabs[1]?.key,
    );

    await user.click(within(bottom).getByRole("button", { name: "Close examples" }));

    const leaf = findLeaf(readPaneTreeStore(storage).current, "leaf-bottom");
    expect(leaf?.tabs.map((tab) => tab.role)).toEqual(["shader", "problems", "performance", "agent"]);
    // Untouched: the tab you were looking at is still the tab you are looking at.
    expect(leaf?.active).toBe(leaf?.tabs[1]?.key);
    expect(within(zoneElement("bottom")).getByRole("tab", { name: "problems" }).getAttribute("aria-selected")).toBe("true");
    expect(within(zoneElement("bottom")).queryByRole("tab", { name: "examples" })).toBeNull();
  });

  it("closing the ACTIVE tab leaves a sensible active tab behind", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} shaderEditor={<div>editor slot</div>} problems={<div>problems slot</div>} />);

    const bottom = zoneElement("bottom");
    expect(within(bottom).getByRole("tab", { name: "shader editor" }).getAttribute("aria-selected")).toBe("true");
    await user.click(within(bottom).getByRole("button", { name: "Close shader editor" }));

    // `closeTab`'s own rule, reached through the strip: active falls to the first
    // remaining tab, never to null while tabs remain.
    const leaf = findLeaf(readPaneTreeStore(storage).current, "leaf-bottom");
    expect(leaf?.tabs.map((tab) => tab.role)).toEqual(["problems", "performance", "examples", "agent"]);
    expect(leaf?.active).toBe(leaf?.tabs[0]?.key);
    const after = zoneElement("bottom");
    expect(within(after).getByRole("tab", { name: "problems" }).getAttribute("aria-selected")).toBe("true");
    expect(after.contains(screen.getByText("problems slot"))).toBe(true);
  });

  it("closing the LAST tab empties the leaf and asks what it should show — it does not close the area", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} viewer={<div>viewer slot</div>} />);

    // The right leaf holds exactly one tab, so this is the "only tab" case.
    await user.click(within(zoneElement("right")).getByRole("button", { name: "Close viewer" }));

    // The AREA survives with no tabs — the leaf-stays policy `closeTab` already had,
    // not a second policy invented at the affordance. Closing the leaf is still its own,
    // explicit act, so the × can never strand a user in a vanished pane.
    const leaf = findLeaf(readPaneTreeStore(storage).current, "leaf-right");
    expect(leaf?.tabs).toEqual([]);
    expect(leaf?.active).toBeNull();
    expect(screen.getByTestId("leaf-picker-leaf-right")).toBeDefined();
    expect(screen.queryByText("viewer slot")).toBeNull();
  });

  it("keeps the tab's close and the LEAF's close as two different acts (§V340)", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} />);

    // One × takes ONE tab; the leaf and its sibling tab stay.
    await user.click(within(zoneElement("left")).getByRole("button", { name: "Close node library" }));
    expect(findLeaf(readPaneTreeStore(storage).current, "leaf-left")?.tabs.map((tab) => tab.role)).toEqual([
      "components",
    ]);
    expect(document.querySelector('[data-pane-leaf="leaf-left"]')).not.toBeNull();

    // "Close area" still takes the whole area with the tab still in it — unchanged.
    await user.click(
      within(zoneElement("left")).getByRole("button", { name: "Split or close this pane area" }),
    );
    await user.click(screen.getByRole("button", { name: "Close area" }));
    expect(findLeaf(readPaneTreeStore(storage).current, "leaf-left")).toBeUndefined();
    expect(document.querySelector('[data-pane-leaf="leaf-left"]')).toBeNull();
  });
});

/**
 * T486 (V423) — the owner's trap, walked in the shell: close the bottom AREA, then
 * bring it back from the layout menu. A control that lists what is PRESENT cannot
 * restore what is ABSENT, so the menu offers closed ROLES — the possibility space —
 * and restoring one re-splits the area it lived in.
 */
/**
 * T494 — creating an area that DOES NOT EXIST. Both owner reports were one gap through
 * two doors: the menu listed only what existed, and every drop target was a band on an
 * existing leaf, so a closed edge area was gone for good. The menu door is exercised
 * here end to end; the drag door shares the identical tree operation (pinned in
 * pane-tree.test.ts), so the two cannot disagree about ratios or anchors.
 */
describe("T494 — an absent edge area spawns back", () => {
  it("offers no edge rows while all three edges are held (V423)", async () => {
    const user = userEvent.setup();
    render(<AppShell storage={createMemoryStorage()} />);
    await user.click(screen.getByRole("button", { name: "Layout" }));
    expect(screen.queryByRole("button", { name: /^New (left|right|bottom) pane$/ })).toBeNull();
  });

  it("door two: dragging a tab shows the absent edge's drop zone, and dropping spawns the area", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} viewer={<div>viewer slot</div>} />);

    // Make the bottom absent.
    const bottom = zoneElement("bottom");
    await user.click(within(bottom).getByRole("button", { name: "Split or close this pane area" }));
    await user.click(screen.getByRole("button", { name: "Close area" }));
    // No strip while nothing drags — drag-only chrome.
    expect(document.querySelector('[data-edge="bottom"]')).toBeNull();

    let carried = "";
    const transfer = {
      setData: (_type: string, value: string) => {
        carried = value;
      },
      getData: () => carried,
      effectAllowed: "",
      dropEffect: "",
    };
    fireEvent.dragStart(screen.getByRole("tab", { name: "viewer" }), { dataTransfer: transfer });

    // Only the ABSENT edge offers itself.
    const strip = document.querySelector<HTMLElement>('[data-edge="bottom"]');
    expect(strip, "no bottom drop zone while a tab is being dragged").not.toBeNull();
    expect(document.querySelector('[data-edge="left"]')).toBeNull();
    fireEvent.drop(strip as HTMLElement, { dataTransfer: transfer });

    // The area exists, holding the dropped tab — the SAME operation the menu row runs.
    expect(document.querySelector('[data-edge="bottom"]')).toBeNull();
    const persisted = readPaneTreeStore(storage);
    const root = persisted.current.root;
    if (root.kind !== "split" || root.direction !== "column") throw new Error("no bottom area spawned");
    const fresh = root.second;
    if (fresh.kind !== "leaf") throw new Error("bottom is not a leaf");
    expect(fresh.tabs.map((tab) => tab.role)).toEqual(["viewer"]);
    expect(screen.getByText("viewer slot")).toBeDefined();
  });

  it("close the bottom area, spawn it empty from the menu, assign it a role", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} />);

    const bottom = zoneElement("bottom");
    await user.click(within(bottom).getByRole("button", { name: "Split or close this pane area" }));
    await user.click(screen.getByRole("button", { name: "Close area" }));

    // The edge is now offerable — and ONLY that edge.
    await user.click(screen.getByRole("button", { name: "Layout" }));
    expect(screen.queryByRole("button", { name: "New left pane" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New right pane" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "New bottom pane" }));

    // A fresh EMPTY leaf spans the bottom: the role picker renders (T406's empty state),
    // and the edge stops being offered.
    expect(screen.getByText("What should this pane show?")).toBeDefined();
    await user.click(screen.getByRole("button", { name: "Layout" }));
    expect(screen.queryByRole("button", { name: "New bottom pane" })).toBeNull();
  });
});

describe("T486 — a closed area comes back through the layout menu", () => {
  it("close every bottom tab's area, restore the shader from the menu, the bar returns", async () => {
    const user = userEvent.setup();
    const storage = createMemoryStorage();
    render(<AppShell storage={storage} shaderEditor={<div>editor slot</div>} />);

    // Close the bottom area from its own menu.
    const bottom = zoneElement("bottom");
    await user.click(within(bottom).getByRole("button", { name: "Split or close this pane area" }));
    await user.click(screen.getByRole("button", { name: "Close area" }));
    expect(document.querySelector('[data-pane-leaf="leaf-bottom"]')).toBeNull();
    expect(screen.queryByText("editor slot")).toBeNull();

    // The layout menu offers the closed roles — and ONLY the closed ones.
    await user.click(screen.getByRole("button", { name: "Layout" }));
    expect(screen.queryByRole("button", { name: "Restore graph" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Restore shader editor" }));

    // A fresh bottom area exists again, holding a live shader editor.
    const restored = document.querySelector('[data-pane-leaf^="leaf-"] [data-pane-role="shader"]');
    expect(restored).not.toBeNull();
    expect(screen.getByText("editor slot")).toBeDefined();
    // And it persisted: a reload reads the restored arrangement back.
    const persisted = readPaneTreeStore(storage);
    let hasShader = false;
    const walk = (node: (typeof persisted.current)["root"]): void => {
      if (node.kind === "leaf") {
        hasShader ||= node.tabs.some((tab) => tab.role === "shader");
        return;
      }
      walk(node.first);
      walk(node.second);
    };
    walk(persisted.current.root);
    expect(hasShader).toBe(true);
  });
});
