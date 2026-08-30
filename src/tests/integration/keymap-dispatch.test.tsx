// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { createKeymapEngine, createKeymapStore, detectPlatform } from "@editor/keymap/index.ts";
import type { KeymapDispatch } from "@editor/keymap/index.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * Hotkey → environment → bus, end to end (T51 tasks 2 and 3).
 *
 * Track Q proved the engine resolves a key to a binding, and track B proved the bus
 * applies a command. Nothing proved the two halves are connected to the same selection:
 * the keymap reads `environment.selection`, and only the composition root can put the
 * canvas's selection there. A `b` that toggles nothing is exactly what passes both
 * unit suites and fails in the product.
 */

/**
 * jsdom has no layout engine and CodeMirror measures what it renders; the shader pane
 * mounts a real editor here. Same two gaps track H fills in its own suite.
 */
function installCodeMirrorStubs(): void {
  const range = Range.prototype as unknown as Record<string, unknown>;
  range["getClientRects"] ??= () => ({
    length: 0,
    item: () => null,
    [Symbol.iterator]: function* () {},
  });
  range["getBoundingClientRect"] ??= () => ({
    x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}),
  });
}

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
  installCodeMirrorStubs();
});
afterEach(cleanup);

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

async function mountWithNode(type = "solid") {
  const runtime = newRuntime();
  const seeded = await seed(runtime, [
    { op: "addNode", ref: "$n", type, position: { x: 0, y: 0 } },
  ]);
  const nodeId = seeded.output.createdIds["$n"] as string;

  const probe = () => Promise.resolve(NO_WEBGPU);
  const view = await act(async () =>
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />),
  );

  const element = view.container.querySelector(".react-flow__node");
  if (element === null) throw new Error("expected the seeded node to render");
  return { runtime, nodeId, element, container: view.container };
}

/** Click the node and wait for the selection to have reached the inspector. */
async function select(element: Element) {
  await act(async () => {
    fireEvent.click(element);
  });
  await waitFor(() => {
    expect(screen.queryByText("No node selected")).toBeNull();
  });
}

describe("selection flows from the canvas into the keymap environment", () => {
  it("makes a selection-scoped binding act on the selected node", async () => {
    const { runtime, nodeId, element } = await mountWithNode();
    await select(element);

    // `b` — TD's bypass, a bare key in the `graph` context, input resolved from the
    // selection. Nothing about this key is hardcoded in a component (§V52).
    await act(async () => {
      fireEvent.keyDown(element, { key: "b" });
    });

    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[nodeId]?.ui?.bypassed).toBe(true);
    });
  });

  it("does nothing when the guard has no selection to resolve", async () => {
    const { runtime, nodeId, element } = await mountWithNode();
    const before = runtime.bus.store.getRevision();

    // Never selected: `when: hasSelection` blocks the dispatch rather than sending a
    // half-formed command to the bus.
    await act(async () => {
      fireEvent.keyDown(element, { key: "b" });
    });

    expect(runtime.bus.store.getRevision()).toBe(before);
    expect(runtime.bus.store.getGraph().nodes[nodeId]?.ui?.bypassed).toBeUndefined();
  });

  it("undoes the hotkey's edit as one group (§V34)", async () => {
    const { runtime, nodeId, element } = await mountWithNode();
    await select(element);
    await act(async () => {
      fireEvent.keyDown(element, { key: "b" });
    });
    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[nodeId]?.ui?.bypassed).toBe(true);
    });

    await act(async () => {
      // `mod` is Cmd on macOS and Ctrl elsewhere — the binding is data, so the test
      // asks the same detector the engine uses rather than hardcoding a modifier.
      const mod = detectPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };
      fireEvent.keyDown(element, { key: "z", ...mod });
    });

    await waitFor(() => {
      expect(runtime.bus.store.getGraph().nodes[nodeId]?.ui?.bypassed).toBeUndefined();
    });
  });
});

describe("§V53 — a text context swallows the graph's single-key bindings", () => {
  it("does not bypass a node because the user typed 'b' in the shader editor", async () => {
    const { runtime, nodeId, element } = await mountWithNode("customWgsl");
    await select(element);

    const textPane = document.querySelector('[data-keymap-context="text"]');
    if (textPane === null) throw new Error("expected the shader pane to declare a text context");

    await act(async () => {
      fireEvent.keyDown(textPane, { key: "b" });
    });

    expect(runtime.bus.store.getGraph().nodes[nodeId]?.ui?.bypassed).toBeUndefined();
  });
});

describe("a binding whose command nothing registered", () => {
  it("reports unresolved instead of throwing or mutating", async () => {
    const { runtime, element } = await mountWithNode();
    await select(element);
    const before = runtime.bus.store.getRevision();

    // `L` — layout. Declared in the default keymap on purpose, implemented by nobody.
    expect(() => {
      fireEvent.keyDown(element, { key: "L", shiftKey: true });
    }).not.toThrow();

    expect(runtime.bus.store.getRevision()).toBe(before);
    expect(runtime.bus.hasCommand("graph.layout")).toBe(false);
  });

  it("is reported as `unresolved` by the engine, not swallowed", () => {
    const runtime = newRuntime();
    const store = createKeymapStore({ storage: null, platform: "other" });
    const dispatches: KeymapDispatch[] = [];
    const engine = createKeymapEngine({
      bus: runtime.bus,
      platform: "other",
      getResolved: store.getSnapshot,
      getEnvironment: () => ({ context: "graph", selection: ["n1"], hoveredNodeId: null }),
      getInvocationContext: () => runtime.invocation,
      onDispatch: (dispatch) => dispatches.push(dispatch),
    });

    engine.handleKey({ key: "L", shiftKey: true });
    expect(dispatches.at(-1)).toMatchObject({
      status: "unresolved",
      command: "graph.layout",
      consumed: false,
    });

    // The same table, the same engine, a command that IS registered: dispatched.
    engine.handleKey({ key: "b" });
    expect(dispatches.at(-1)).toMatchObject({ status: "dispatched", command: "node.toggleBypass" });
  });
});

/**
 * The third door (T359, §V307, §V78).
 *
 * Project settings shipped with a button and no keystroke, because it opened from a
 * `useState` toggle in the composition root while `mod+,` had named `ui.openSettings` in
 * the default keymap since T77. The binding was real, the surface was real, and nothing
 * joined them — the engine skips a command nobody registered, silently and correctly.
 *
 * This asserts the join, from the key the user presses to the dialog on screen. It is the
 * assertion the button-level test cannot make: a component test that clicks the button
 * supplies the very wiring it is checking (§V220's shared cause).
 */
describe("the settings dialog opens from its keybinding (T359)", () => {
  it("puts the dialog on screen when mod+, is pressed", async () => {
    const { element } = await mountWithNode();
    expect(screen.queryByTestId("project-settings")).toBeNull();

    // `mod` is Ctrl off macOS, which is what jsdom reports.
    await act(async () => {
      fireEvent.keyDown(element, { key: ",", ctrlKey: true });
    });

    await waitFor(() => {
      expect(screen.getByTestId("project-settings")).toBeDefined();
    });
  });
});
