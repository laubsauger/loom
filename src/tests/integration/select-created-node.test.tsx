// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { detectPlatform } from "@editor/keymap/index.ts";
import { selectCreatedNodes } from "@editor/selection/select-created.ts";
import { NODE_DRAG_MIME } from "@editor/library/index.ts";
import type { NodeDragPayload } from "@editor/library/index.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * "A node the USER just added becomes the selection" — through the real app, from the
 * surfaces a person actually uses.
 *
 * The behaviour is one rule (`@editor/selection/select-created.ts`) reached from several
 * doors, so what has to be proved is not that a setter fired but that the canvas is
 * SHOWING the new node as selected afterwards, from every door — and, just as much, that
 * the three cases which look identical to the bus do NOT select: an agent's edit, an undo
 * that puts a deleted node back, and opening a document.
 *
 * The selection is read back the way the user sees it: React Flow's `selected` class on
 * the node element, plus the inspector, which is the other consumer of the same fact.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

/** The same project, edited by a model instead of by the person at the keyboard. */
function asAgent(runtime: AppRuntime): InvocationContext {
  return { ...runtime.invocation, actor: { kind: "agent", id: "assistant", label: "Assistant" } };
}

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

async function mountApp(runtime: AppRuntime) {
  const probe = () => Promise.resolve(NO_WEBGPU);
  const view = await act(async () =>
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />),
  );
  const surface = view.container.querySelector('[data-keymap-context="graph"]');
  if (surface === null) throw new Error("expected the graph surface to declare its context");
  return { view, surface };
}

/** What the canvas is DRAWING as selected — the thing a user can see. */
function selectedIds(container: HTMLElement): string[] {
  return [...container.querySelectorAll(".react-flow__node.selected")]
    .map((element) => element.getAttribute("data-id") ?? "")
    .sort();
}

function nodeElement(container: HTMLElement, nodeId: string): Element {
  const element = container.querySelector(`.react-flow__node[data-id="${nodeId}"]`);
  if (element === null) throw new Error(`expected node ${nodeId} to render`);
  return element;
}

/** `mod` is Cmd on macOS and Ctrl elsewhere; the bindings are data, so ask the detector. */
const MOD = detectPlatform() === "mac" ? { metaKey: true } : { ctrlKey: true };

/** The slice of `DataTransfer` the library's payload reader actually touches. */
function dataTransferWith(payload: NodeDragPayload) {
  return {
    dropEffect: "none",
    effectAllowed: "all",
    getData: (format: string) => (format === NODE_DRAG_MIME ? JSON.stringify(payload) : ""),
    setData: () => {},
  };
}

describe("a node the user adds becomes the selection", () => {
  it("selects a definition dropped out of the library", async () => {
    const runtime = newRuntime();
    const { view, surface } = await mountApp(runtime);

    await act(async () => {
      fireEvent.drop(surface, { dataTransfer: dataTransferWith({ type: "solid" }) });
    });

    const added = await waitFor(() => {
      const ids = Object.keys(runtime.bus.store.getGraph().nodes);
      expect(ids).toHaveLength(1);
      return ids[0] as string;
    });
    // The point of the whole task: the canvas is drawing the new node as the selection.
    await waitFor(() => {
      expect(selectedIds(view.container)).toEqual([added]);
    });
    // And the other consumer of the same fact agrees — the inspector is showing it.
    expect(screen.queryByText("No node selected")).toBeNull();

    /*
     * And it stayed VIEW state. T1102 made this worth asserting: React Flow elevates the
     * selected node, so the new node does come to the front — but `ui.z` is the persisted
     * stacking order and only `node.bringToFront` writes it. If creating a node also wrote
     * one, `]` would be a no-op on a fresh node and every saved file would grow an entry
     * nobody asked for. One revision for the add, none for the selection.
     */
    expect(runtime.bus.store.getGraph().nodes[added]?.ui?.z).toBeUndefined();
    const settled = runtime.bus.store.getRevision();
    await act(async () => {
      await runtime.bus.execute(
        "graph.selectNodes",
        { nodeIds: [added as NodeId] },
        runtime.invocation,
      );
    });
    expect(runtime.bus.store.getRevision()).toBe(settled);
  });

  it("selects every node a paste created, and only those (§V101)", async () => {
    const runtime = newRuntime();
    const seeded = await seed(runtime, [
      { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "solid", position: { x: 200, y: 0 } },
    ]);
    const first = seeded.output.createdIds["$a"] as string;
    const second = seeded.output.createdIds["$b"] as string;
    const { view, surface } = await mountApp(runtime);

    // Select both the honest way — `mod+a` — so the copy is made from the selection the
    // user can see rather than from ids the test invented. Fired at the GRAPH surface,
    // which is what declares the `graph` keymap context these bindings live in (§V53).
    await act(async () => {
      fireEvent.keyDown(surface, { key: "a", ...MOD });
    });
    await waitFor(() => {
      expect(selectedIds(view.container)).toEqual([first, second].sort());
    });

    await act(async () => {
      fireEvent.keyDown(surface, { key: "c", ...MOD });
    });
    await act(async () => {
      fireEvent.keyDown(surface, { key: "v", ...MOD });
    });

    const copies = await waitFor(() => {
      const ids = Object.keys(runtime.bus.store.getGraph().nodes).filter(
        (id) => id !== first && id !== second,
      );
      expect(ids).toHaveLength(2);
      return ids.sort();
    });
    // Both copies, and neither original: a paste hands you the thing you can now move.
    await waitFor(() => {
      expect(selectedIds(view.container)).toEqual(copies);
    });
  });
});

describe("what must NOT take the selection", () => {
  it("leaves the human's selection alone when an AGENT adds a node", async () => {
    const runtime = newRuntime();
    const seeded = await seed(runtime, [
      { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
    ]);
    const solid = seeded.output.createdIds["$a"] as string;
    const { view } = await mountApp(runtime);

    await act(async () => {
      fireEvent.click(nodeElement(view.container, solid));
    });
    await waitFor(() => {
      expect(selectedIds(view.container)).toEqual([solid]);
    });

    // The bus sees this exactly as it sees the drop in the test above — same command,
    // same patch, same `createdIds`. Only the actor differs, and that is the whole rule:
    // a model building a graph must not seize the screen of the person at the keyboard.
    const added = await act(async () =>
      runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          operations: [{ op: "addNode", ref: "$bot", type: "solid", position: { x: 400, y: 0 } }],
          label: "agent add",
        },
        asAgent(runtime),
      ),
    );
    const agentNode = added.output.createdIds["$bot"] as string;

    // The node arrived — this is not passing because nothing happened.
    await waitFor(() => {
      expect(nodeElement(view.container, agentNode)).toBeTruthy();
    });
    expect(selectedIds(view.container)).toEqual([solid]);
  });

  /**
   * The test above passes STRUCTURALLY: `agent/tools/mutate.ts` reaches the bus without
   * going through any door that calls `selectCreatedNodes`, so the actor check inside it
   * is never consulted and deleting the check does not turn that test red — measured.
   *
   * A guard nothing can reach is a guard nobody knows is broken, and the structure it
   * relies on is one refactor from changing (an in-app agent surface routing a tool
   * through `useRunCommand` would inherit "select what you created" silently). So the
   * guard is exercised at its own seam, with ONE result object handed to it twice: the
   * only difference between the two calls is the actor, and the outcome differs.
   */
  it("selects for a human and not for an agent, from the SAME applied result", async () => {
    const runtime = newRuntime();
    const seeded = await seed(runtime, [
      { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
    ]);
    const solid = seeded.output.createdIds["$a"] as string;
    const { view } = await mountApp(runtime);

    await act(async () => {
      fireEvent.click(nodeElement(view.container, solid));
    });
    await waitFor(() => {
      expect(selectedIds(view.container)).toEqual([solid]);
    });

    const added = await act(async () =>
      runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          operations: [{ op: "addNode", ref: "$n", type: "solid", position: { x: 400, y: 0 } }],
          label: "add",
        },
        runtime.invocation,
      ),
    );
    const created = added.output.createdIds["$n"] as string;
    await waitFor(() => {
      expect(nodeElement(view.container, created)).toBeTruthy();
    });

    await act(async () => {
      await selectCreatedNodes(runtime.bus, asAgent(runtime), added);
    });
    expect(selectedIds(view.container)).toEqual([solid]);

    await act(async () => {
      await selectCreatedNodes(runtime.bus, runtime.invocation, added);
    });
    await waitFor(() => {
      expect(selectedIds(view.container)).toEqual([created]);
    });
  });

  it("does not select a node that UNDO put back", async () => {
    const runtime = newRuntime();
    const seeded = await seed(runtime, [
      { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
    ]);
    const solid = seeded.output.createdIds["$a"] as string;
    const { view, surface } = await mountApp(runtime);

    await act(async () => {
      fireEvent.click(nodeElement(view.container, solid));
    });
    await waitFor(() => {
      expect(selectedIds(view.container)).toEqual([solid]);
    });

    await act(async () => {
      await runtime.bus.execute("graph.removeNodes", { nodeIds: [solid] }, runtime.invocation);
    });
    await waitFor(() => {
      expect(Object.keys(runtime.bus.store.getGraph().nodes)).toHaveLength(0);
    });

    // `mod+z` through the same keymap door `mod+v` used above. Undo restores the node
    // from the store's recorded entities rather than replaying an `addNode`, so it reports
    // no `createdIds` — which is why "the user added a node" is false here by the SHAPE of
    // the answer rather than by a list of command names somebody has to keep current.
    await act(async () => {
      fireEvent.keyDown(surface, { key: "z", ...MOD });
    });
    await waitFor(() => {
      expect(Object.keys(runtime.bus.store.getGraph().nodes)).toEqual([solid]);
    });
    expect(selectedIds(view.container)).toEqual([]);
  });

  it("selects nothing when a document is opened (§V101 — load is not an edit)", async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "solid", position: { x: 200, y: 0 } },
    ]);
    // The app mounts onto a document that already has nodes — the shape of opening a file
    // or an example, which replaces the runtime rather than patching (`project.open`).
    const { view } = await mountApp(runtime);

    await waitFor(() => {
      expect(view.container.querySelectorAll(".react-flow__node")).toHaveLength(2);
    });
    expect(selectedIds(view.container)).toEqual([]);
    expect(screen.queryByText("No node selected")).not.toBeNull();
  });
});
