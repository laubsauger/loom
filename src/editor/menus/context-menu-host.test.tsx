// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { DEFAULT_BINDINGS } from "@editor/keymap/defaults.ts";
import { KeymapProvider } from "@editor/keymap/keymap-provider.tsx";
import { createKeymapStore } from "@editor/keymap/store.ts";
import type { KeymapStore } from "@editor/keymap/store.ts";
import { ContextMenuHost } from "./context-menu-host.tsx";
import { PARAMETER_KEY_ATTRIBUTE, PARAMETER_NODE_ATTRIBUTE } from "./target.ts";
import { menuFixture, type MenuFixture } from "./test-support.ts";

/**
 * The menu host end to end (T126/T127, §V78, §V29, §V55).
 *
 * One root over the pane, the target resolved from the event, items sourced from the
 * bus registry and keys from the keymap. What these tests defend is the "three views of
 * one command set" property: a menu click must take the same path a hotkey does, and a
 * rebind must move the text in the menu.
 */

beforeAll(installDomStubs);
afterEach(cleanup);

let fixture: MenuFixture;
let store: KeymapStore;
let executed: Array<{ command: string; input: unknown }>;

beforeEach(async () => {
  fixture = await menuFixture();
  executed = [];
  const real = fixture.bus.execute.bind(fixture.bus);
  vi.spyOn(fixture.bus, "execute").mockImplementation((command, input, context) => {
    executed.push({ command, input });
    return real(command, input, context);
  });
  store = createKeymapStore({ defaults: DEFAULT_BINDINGS, storage: null, platform: "other" });
});

/** A stand-in for the canvas that renders React Flow's own DOM markers. */
function setup(selection: readonly NodeId[] = []) {
  return render(
    <KeymapProvider bus={fixture.bus} store={store} invocationContext={contextFor(alice)}>
      <ContextMenuHost bus={fixture.bus} fallbackSurface="canvas" selection={selection}>
        <div data-testid="pane">
          <div className="react-flow__node" data-id={fixture.blur}>
            <button type="button" data-testid="node-title">
              Blur
            </button>
            <div
              className="react-flow__handle"
              data-testid="port"
              data-nodeid={fixture.blur}
              data-handleid="source"
            />
          </div>
          <svg>
            <g className="react-flow__edge" data-id={fixture.edgeId}>
              <path data-testid="edge-path" />
            </g>
          </svg>
        </div>
      </ContextMenuHost>
    </KeymapProvider>,
  );
}

function openOn(testId: string): HTMLElement {
  fireEvent.contextMenu(screen.getByTestId(testId), { clientX: 40, clientY: 60 });
  return screen.getByRole("menu");
}

/** Items are found by their LABEL text; the shortcut chip beside it comes from the keymap. */
function itemNamed(label: string): HTMLElement {
  const row = screen
    .getByText(label, { selector: "span" })
    .closest("[data-menu-command],[data-menu-submenu]");
  if (row === null) throw new Error(`no menu item labelled "${label}"`);
  return row as HTMLElement;
}

describe("resolving what was clicked", () => {
  it("opens the node menu for a click inside a node, not the canvas menu", () => {
    setup();
    expect(openOn("node-title").dataset["menuSurface"]).toBe("node");
  });

  it("opens the port menu for a click on a handle inside that same node", () => {
    setup();
    expect(openOn("port").dataset["menuSurface"]).toBe("port");
  });

  it("opens the edge menu for a click on an edge", () => {
    setup();
    expect(openOn("edge-path").dataset["menuSurface"]).toBe("edge");
  });

  it("opens the canvas menu for a click on empty pane", () => {
    setup();
    expect(openOn("pane").dataset["menuSurface"]).toBe("canvas");
  });

  it("keeps ONE root for the whole pane, whatever was clicked (§V78)", () => {
    setup();
    openOn("node-title");
    // One trigger, one open menu — not a Radix root per node.
    expect(screen.getAllByTestId("context-menu-host")).toHaveLength(1);
    expect(screen.getAllByRole("menu")).toHaveLength(1);
  });
});

describe("running an item (§V29)", () => {
  it("dispatches the named command through the bus with target-derived input", async () => {
    setup();
    openOn("node-title");
    await act(async () => {
      fireEvent.click(itemNamed("Copy"));
    });
    expect(executed).toContainEqual({
      command: "graph.copySelection",
      input: { nodeIds: [fixture.blur] },
    });
  });

  it("acts on the whole selection when the clicked node is part of it", async () => {
    setup([fixture.solid, fixture.blur]);
    openOn("node-title");
    await act(async () => {
      fireEvent.click(itemNamed("Duplicate"));
    });
    expect(executed).toContainEqual({
      command: "graph.duplicateSelection",
      input: { nodeIds: [fixture.solid, fixture.blur].sort() },
    });
  });

  it("really deletes the clicked edge", async () => {
    setup();
    openOn("edge-path");
    await act(async () => {
      fireEvent.click(itemNamed("Delete"));
    });
    expect(fixture.bus.store.getGraph().edges[fixture.edgeId]).toBeUndefined();
  });
});

/**
 * T524/B107 — the WHOLE add-node path, depth 2 included, through to a node IN THE
 * GRAPH at the click position. The break the owner hit lived below every existing
 * test: depth-1 rows dispatched fine, and no test ever walked Add node → category →
 * leaf and then looked at the DOCUMENT. Per §V461 the assertion is one only success
 * can satisfy: a node of the CHOSEN type at the CLICKED position — never "the graph
 * is non-empty".
 */
/**
 * T524/B107, the CAUSE pinned — and B120, its NARROWING: a submenu must survive focus
 * straying DURING A POINTER PRESS on its own contents, and at no other time. Radix's
 * SubContent closes on "focus outside", detected via a React-capture flag — and under
 * React 19.2's focus ordering, a pointerdown on an item inside a NESTED sub set focus
 * before the flag, so the parent sub read its own child as outside and closed
 * mid-press; pointerup then found nothing to select. Keyboard always worked, which is
 * why 21 green tests missed it.
 *
 * The first fix vetoed focus-outside UNCONDITIONALLY, and that fixed "closes too
 * eagerly" by shipping "never closes": browsing category A → B → C stacked every
 * submenu, because the focus-outside that closes A when B opens is the LEGITIMATE
 * close (B120). The veto now holds only while a pointer press is active inside the
 * submenu's own React subtree.
 *
 * HONESTY (V461's spirit): jsdom cannot replay the exact React-19.2 pointer ordering —
 * the composed depth-2 test above passed while the browser failed. What jsdom CAN do
 * is fire a real focusin from a node outside the React tree, which drives the same
 * dismissable-layer path the regression came through — once mid-press (must survive)
 * and once with no press (must close). A fixture that only checked one half would pass
 * in both the blanket-veto world and the no-veto world (§V461).
 */
describe("a submenu survives stray focus mid-press, and ONLY mid-press (T524/B107, B120)", () => {
  it("keeps the submenu open during a press inside it, and lets the same focus close it after release", async () => {
    setup();
    const outside = document.createElement("button");
    document.body.appendChild(outside);
    try {
      openOn("pane");
      await act(async () => {
        fireEvent.pointerMove(itemNamed("Add node"));
        fireEvent.click(itemNamed("Add node"));
      });
      expect(itemNamed("filter")).toBeDefined();

      // MID-PRESS: pointerdown on a row inside the sub, release not yet fired — the
      // T524 shape. Stray focus must not close it.
      await act(async () => {
        fireEvent.pointerDown(itemNamed("filter"));
        outside.focus();
        fireEvent.focusIn(outside);
      });
      expect(itemNamed("filter")).toBeDefined();

      // RELEASED: the identical stray focus is now the legitimate dismissable-layer
      // close. A blanket veto (the B120 bug) keeps the sub open here.
      await act(async () => {
        fireEvent.pointerUp(itemNamed("filter"));
        outside.focus();
        fireEvent.focusIn(outside);
      });
      expect(screen.queryByText("filter", { selector: "span" })).toBeNull();
    } finally {
      outside.remove();
    }
  });
});

describe("Add node, all the way to the graph (T524)", () => {
  it("clicking a leaf two levels deep lands a node of that type at the click position", async () => {
    setup();
    openOn("pane");
    await act(async () => {
      fireEvent.pointerMove(itemNamed("Add node"));
      fireEvent.click(itemNamed("Add node"));
    });
    await act(async () => {
      fireEvent.pointerMove(itemNamed("filter"));
      fireEvent.click(itemNamed("filter"));
    });
    await act(async () => {
      fireEvent.click(itemNamed("Blur"));
    });

    const nodes = Object.values(fixture.bus.store.getGraph().nodes).filter(
      (node) => node.type === "test.blur",
    );
    // One MORE than the fixture's own blur — the one this click created.
    expect(nodes.length).toBeGreaterThanOrEqual(2);
    const added = nodes.find((node) => node.id !== fixture.blur);
    expect(added).toBeDefined();
    // The CLICK position, projected — never (0,0), which is where a lost target lands.
    expect(added?.position.x).not.toBe(0);
  });

  it("browsing to a sibling category closes the previous one — at most ONE submenu per level (B120)", async () => {
    // The SECOND property, which the depth-2 walk above cannot see: it walks one
    // branch, and the B120 stacking bug only shows when a second branch opens while
    // the first is up. §V461: the fixture must assert the first is GONE, not merely
    // that the second is open — a blanket focus-outside veto passes the weaker check.
    setup();
    openOn("pane");
    await act(async () => {
      fireEvent.pointerMove(itemNamed("Add node"));
      fireEvent.click(itemNamed("Add node"));
    });
    await act(async () => {
      fireEvent.pointerMove(itemNamed("filter"));
      fireEvent.click(itemNamed("filter"));
    });
    expect(itemNamed("Blur")).toBeDefined();

    // Browse to the sibling. No pointer press is active, so nothing may veto the close.
    await act(async () => {
      fireEvent.pointerMove(itemNamed("generator"));
      fireEvent.click(itemNamed("generator"));
    });
    expect(itemNamed("Solid")).toBeDefined(); // the sibling opened —
    expect(screen.queryByText("Blur", { selector: "span" })).toBeNull(); // — and the first closed
  });
});

describe("commands nobody has registered yet", () => {
  it("renders them disabled and says why, instead of hiding them", () => {
    setup();
    openOn("pane");
    // Was "Layout" until B84 registered `graph.layoutAll`. `ui.openNodeSearch` is the
    // remaining canvas row with no command behind it — and unlike layout, the surface it
    // names does not exist either, so §V354 is satisfied by leaving it disabled.
    const planned = itemNamed("Search nodes…");
    expect(planned.getAttribute("aria-disabled")).toBe("true");
    expect(planned.getAttribute("title")).toContain("not available yet");
    expect(within(planned).getByText("unavailable")).toBeDefined();
  });

  it("does not throw and does not dispatch when one is clicked", async () => {
    setup();
    openOn("pane");
    await act(async () => {
      fireEvent.click(itemNamed("Frame all"));
    });
    expect(executed.map((entry) => entry.command)).not.toContain("view.frameAll");
  });

  it("still shows the shortcut the keymap has for them (§V55)", () => {
    setup();
    openOn("pane");
    // `view.frameAll` is bound to Shift+F but unregistered: the binding is real even
    // though the command is not, and hiding it would make the keymap look emptier
    // than it is.
    expect(itemNamed("Frame all").textContent).toContain("F");
  });
});

describe("shortcut text comes from the keymap, never from the label (§V55)", () => {
  it("shows the current binding and updates when it is rebound", async () => {
    setup();
    openOn("node-title");
    expect(itemNamed("Copy").textContent).toContain("Ctrl+C");

    // The anti-drift property: a label containing "Ctrl+C" would now be a lie.
    await act(async () => {
      expect(store.setOverride("graph.copy", "mod+shift+y")).toEqual({ status: "ok" });
    });

    const copy = itemNamed("Copy");
    expect(copy.textContent).toContain("Ctrl+Shift+Y");
    expect(copy.textContent).not.toContain("Ctrl+C");
  });

  it("shows no chip at all for a command with no binding", () => {
    setup();
    openOn("port");
    // Nothing binds "insert conversion"; the item renders without inventing a key.
    expect(itemNamed("Insert conversion node…").textContent).toBe(
      "Insert conversion node…unavailable",
    );
  });
});

describe("toggles show their state", () => {
  it("renders bypass, mute and preview as checkboxes reflecting the node", async () => {
    setup();
    openOn("node-title");
    expect(itemNamed("Bypass").getAttribute("role")).toBe("menuitemcheckbox");
    expect(itemNamed("Bypass").getAttribute("aria-checked")).toBe("false");

    await act(async () => {
      fireEvent.click(itemNamed("Bypass"));
    });
    expect(executed).toContainEqual({
      command: "node.toggleBypass",
      input: { nodeIds: [fixture.blur] },
    });

    // Re-opening reads a fresh snapshot, so the checkmark follows the document.
    openOn("node-title");
    expect(itemNamed("Bypass").getAttribute("aria-checked")).toBe("true");
    expect(itemNamed("Mute").getAttribute("aria-checked")).toBe("false");
  });
});

describe("when guards", () => {
  it("disables disconnect on a port with nothing connected", async () => {
    setup();
    openOn("port");
    expect(itemNamed("Disconnect").getAttribute("aria-disabled")).toBeNull();

    await act(async () => {
      fireEvent.click(itemNamed("Disconnect"));
    });
    expect(fixture.bus.store.getGraph().edges[fixture.edgeId]).toBeUndefined();

    openOn("port");
    const disconnect = itemNamed("Disconnect");
    expect(disconnect.getAttribute("aria-disabled")).toBe("true");
    expect(disconnect.getAttribute("title")).toContain("Nothing is connected");
  });
});

describe("the parameter menu", () => {
  function setupInspector() {
    return render(
      <KeymapProvider bus={fixture.bus} store={store} invocationContext={contextFor(alice)}>
        <ContextMenuHost bus={fixture.bus}>
          <div {...{ [PARAMETER_NODE_ATTRIBUTE]: fixture.blur }}>
            <div data-testid="row" {...{ [PARAMETER_KEY_ATTRIBUTE]: "radius" }}>
              Radius
            </div>
            <div data-testid="chrome">Inspector chrome</div>
          </div>
        </ContextMenuHost>
      </KeymapProvider>,
    );
  }

  it("resets an overridden parameter to the definition default", async () => {
    await fixture.bus.execute(
      "graph.applyPatch",
      {
        baseRevision: fixture.bus.store.getRevision(),
        label: "edit",
        operations: [{ op: "setParameters", nodeId: fixture.blur, parameters: { radius: 12 } }],
      },
      contextFor(alice),
    );
    setupInspector();
    openOn("row");
    await act(async () => {
      fireEvent.click(itemNamed("Reset to default"));
    });
    expect(fixture.bus.store.getGraph().nodes[fixture.blur]?.parameters["radius"]).toBe(4);
  });

  it("disables the reset when the value is already the default", () => {
    setupInspector();
    openOn("row");
    expect(itemNamed("Reset to default").getAttribute("aria-disabled")).toBe("true");
  });

  it("opens no menu at all where nothing is addressable", () => {
    setupInspector();
    fireEvent.contextMenu(screen.getByTestId("chrome"), { clientX: 4, clientY: 4 });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});

describe("the add-node submenu", () => {
  function openSubmenu(label: string): void {
    // Radix opens a submenu from its trigger on Enter as well as on hover (§V19).
    fireEvent.keyDown(itemNamed(label), { key: "Enter" });
  }

  it("adds the chosen node type under the cursor, in graph space", async () => {
    render(
      <KeymapProvider bus={fixture.bus} store={store} invocationContext={contextFor(alice)}>
        <ContextMenuHost
          bus={fixture.bus}
          fallbackSurface="canvas"
          // What React Flow's `screenToFlowPosition` does for the real canvas.
          toGraphPosition={(client) => ({ x: client.x * 2, y: client.y * 2 })}
        >
          <div data-testid="pane" />
        </ContextMenuHost>
      </KeymapProvider>,
    );

    fireEvent.contextMenu(screen.getByTestId("pane"), { clientX: 40, clientY: 60 });
    openSubmenu("Add node");
    await waitFor(() => expect(itemNamed("filter")).toBeDefined());
    openSubmenu("filter");
    await waitFor(() => expect(itemNamed("Blur")).toBeDefined());

    const before = new Set(Object.keys(fixture.bus.store.getGraph().nodes));
    await act(async () => {
      fireEvent.click(itemNamed("Blur"));
    });

    const added = Object.values(fixture.bus.store.getGraph().nodes).find(
      (node) => !before.has(node.id),
    );
    expect(added?.type).toBe("test.blur");
    expect(added?.position).toEqual({ x: 80, y: 120 });
  });
});

describe("keyboard (§V19)", () => {
  it("moves through items with the arrow keys", async () => {
    setup();
    const menu = openOn("node-title");
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement?.textContent).toContain("Bypass");

    fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement?.textContent).toContain("Mute"));

    fireEvent.keyDown(document.activeElement ?? menu, { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement?.textContent).toContain("Bypass"));
  });

  it("closes on Escape and returns focus to where it was", async () => {
    setup();
    const anchor = screen.getByTestId("node-title");
    anchor.focus();
    const menu = openOn("node-title");
    expect(document.activeElement).not.toBe(anchor);

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
    // §V19 — the keyboard user is put back where they were, not on the document body.
    expect(document.activeElement).toBe(anchor);
  });
});
