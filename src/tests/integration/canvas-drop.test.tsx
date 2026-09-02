// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { NODE_DRAG_MIME } from "@editor/library/index.ts";
import type { NodeDragPayload } from "@editor/library/index.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { App } from "../../app/app.tsx";
import { AppRuntimeContext } from "../../app/app-context.ts";
import { KeymapProvider } from "@editor/keymap/index.ts";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { GraphPane } from "../../app/graph-pane.tsx";
import type { GraphActions, PortDragOrigin } from "../../app/graph-pane.tsx";
import { LibraryPane } from "../../app/side-panes.tsx";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * The two channels that only exist once the panes are wired together (T51 task 4):
 * a definition dragged out of the library becoming a node on the canvas, and the
 * in-flight port drag the library filters on (§V13).
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const NO_WEBGPU: GpuStatus = { kind: "unavailable", reason: "No WebGPU in this environment." };

const RGBA = { kind: "texture2d", sample: "float", channels: 4 } as const;

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester" },
  });
}

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

/** The slice of `DataTransfer` the payload reader actually touches. */
function dataTransferWith(payload: NodeDragPayload | null) {
  return {
    dropEffect: "none",
    effectAllowed: "all",
    getData: (format: string) =>
      payload !== null && format === NODE_DRAG_MIME ? JSON.stringify(payload) : "",
    setData: () => {},
  };
}

async function mountGraphPane(portDrag: PortDragOrigin | null, runtime: AppRuntime) {
  const actionsRef = createRef<GraphActions | null>();
  const view = await act(async () =>
    render(
      <AppRuntimeContext.Provider value={runtime}>
        <KeymapProvider bus={runtime.bus} invocationContext={runtime.invocation}>
        <GraphPane
          selection={[]}
      onSelectionChange={() => {}}
          onHoveredNodeChange={() => {}}
          portDrag={portDrag}
          onPortDragChange={() => {}}
          onPatchResult={() => {}}
          actionsRef={actionsRef}
        />
        </KeymapProvider>
      </AppRuntimeContext.Provider>,
    ),
  );
  const surface = view.container.querySelector('[data-keymap-context="graph"]');
  if (surface === null) throw new Error("expected the graph surface to declare its context");
  return { surface, actionsRef };
}

describe("dropping a definition on the canvas", () => {
  it("adds the node through the bus", async () => {
    const runtime = newRuntime();
    const { surface } = await mountGraphPane(null, runtime);

    await act(async () => {
      fireEvent.drop(surface, { dataTransfer: dataTransferWith({ type: "solid" }) });
    });

    await waitFor(() => {
      expect(Object.values(runtime.bus.store.getGraph().nodes)).toHaveLength(1);
    });
    expect(Object.values(runtime.bus.store.getGraph().nodes)[0]?.type).toBe("solid");
  });

  it("wires the new node to the port the drag came from, in one patch (§V32, §V34)", async () => {
    const runtime = newRuntime();
    const seeded = await seed(runtime, [
      { op: "addNode", ref: "$s", type: "solid", position: { x: 0, y: 0 } },
    ]);
    const solid = seeded.output.createdIds["$s"] as string;

    const origin: PortDragOrigin = {
      nodeId: solid,
      portId: "out",
      type: RGBA,
      direction: "output",
    };
    const { surface } = await mountGraphPane(origin, runtime);

    await act(async () => {
      fireEvent.drop(surface, {
        dataTransfer: dataTransferWith({
          type: "output",
          connectTo: { portId: "input", direction: "input" },
        }),
      });
    });

    await waitFor(() => {
      expect(Object.values(runtime.bus.store.getGraph().edges)).toHaveLength(1);
    });
    const edge = Object.values(runtime.bus.store.getGraph().edges)[0];
    expect(edge?.source).toEqual({ nodeId: solid, portId: "out" });
    expect(edge?.target.portId).toBe("input");
    // One patch, so one undo group: undoing puts the graph back where it started.
    await act(async () => {
      await runtime.bus.execute("graph.undo", {}, runtime.invocation);
    });
    expect(Object.values(runtime.bus.store.getGraph().nodes)).toHaveLength(1);
    expect(Object.values(runtime.bus.store.getGraph().edges)).toHaveLength(0);
  });

  it("never writes a non-finite position, whatever the viewport says (§V66)", async () => {
    const runtime = newRuntime();
    // A canvas with no layout — a collapsed pane, the first frame, this DOM — has no
    // zoom, and the screen→graph projection divides by it. NaN here would serialize to
    // null and make the saved document unloadable.
    const { surface } = await mountGraphPane(null, runtime);

    await act(async () => {
      fireEvent.drop(surface, { dataTransfer: dataTransferWith({ type: "solid" }) });
    });

    await waitFor(() => {
      expect(Object.values(runtime.bus.store.getGraph().nodes)).toHaveLength(1);
    });
    const position = Object.values(runtime.bus.store.getGraph().nodes)[0]?.position;
    expect(Number.isFinite(position?.x)).toBe(true);
    expect(Number.isFinite(position?.y)).toBe(true);
  });

  it("ignores a drag that is not ours", async () => {
    const runtime = newRuntime();
    const { surface } = await mountGraphPane(null, runtime);

    await act(async () => {
      fireEvent.drop(surface, { dataTransfer: dataTransferWith(null) });
    });

    expect(Object.values(runtime.bus.store.getGraph().nodes)).toHaveLength(0);
  });
});

describe("the port-drag channel narrows the library (§V13)", () => {
  it("offers only the definitions that can accept the dragged output", async () => {
    const runtime = newRuntime();
    const origin: PortDragOrigin = {
      nodeId: "whatever",
      portId: "out",
      type: RGBA,
      direction: "output",
    };

    render(
      <AppRuntimeContext.Provider value={runtime}>
        <KeymapProvider bus={runtime.bus} invocationContext={runtime.invocation}>
        <LibraryPane portDrag={origin} onClearPortDrag={() => {}} actions={() => null} />
        </KeymapProvider>
      </AppRuntimeContext.Provider>,
    );

    // Solid has no inputs, so it cannot complete this edge and must not be offered.
    expect(screen.queryByText("Solid")).toBeNull();
    expect(screen.getByText("Output")).toBeDefined();
    expect(screen.getByText("Custom WGSL")).toBeDefined();
  });

  it("shows the whole catalogue again when no port drag is in flight", () => {
    const runtime = newRuntime();

    render(
      <AppRuntimeContext.Provider value={runtime}>
        <KeymapProvider bus={runtime.bus} invocationContext={runtime.invocation}>
        <LibraryPane portDrag={null} onClearPortDrag={() => {}} actions={() => null} />
        </KeymapProvider>
      </AppRuntimeContext.Provider>,
    );

    expect(screen.getByText("Solid")).toBeDefined();
    expect(screen.getByText("Output")).toBeDefined();
  });
});

describe("graph.selectAll", () => {
  it("is a real bus command that moves the canvas selection", async () => {
    const runtime = newRuntime();
    await seed(runtime, [
      { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "output", position: { x: 240, y: 0 } },
    ]);
    const probe = () => Promise.resolve(NO_WEBGPU);
    await act(async () => {
      render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
    });
    expect(screen.getByText("No node selected")).toBeDefined();

    const result = await act(async () =>
      runtime.bus.execute("graph.selectAll", {}, runtime.invocation),
    );

    expect(result.status).toBe("applied");
    expect(result.output.nodeIds).toHaveLength(2);
    // It reached the tree: the inspector now has a subject.
    await waitFor(() => {
      expect(screen.queryByText("No node selected")).toBeNull();
    });
  });

  /**
   * T969(b) — SELECT-ALL SELECTS WHAT THE USER IS LOOKING AT, INCLUDING INSIDE A COMPONENT.
   *
   * Owner, second report: "cmd+a is not selecting all nodes in the graph visibly as a frame
   * selection would, and it doesn't really do anything when manually called in the ui" —
   * noticed while standing inside `holo1`, a component instance.
   *
   * The wiring all READ correctly, which is why this is measured rather than reviewed.
   * `defaults.ts` binds `mod+a`, `selection-commands.ts` registers the command, and
   * `graph-pane.tsx` sets `selected: true` on the matching React Flow nodes. TWO things
   * were wrong and only at depth, so every root-level test stayed green:
   *
   *  1. The command read `context.graph.nodes` — the ROOT document — while the canvas was
   *     showing the component's internals, so it asked for ids React Flow does not hold.
   *  2. The canvas registered its handler on the SESSION bus only, while `KeymapProvider`
   *     dispatches on the root bus. Diving in vacated the root holder and the command
   *     answered `selection.noCanvas`: an `info` rejection no surface shows.
   *
   * MEASURED BEFORE THE FIX: `applied` with 1 id at the root, then `rejected` with
   * `selection.noCanvas` after one `graph.diveIn` — a command that reports refusal nobody
   * surfaces, which is exactly what a dead key looks like.
   *
   * The assertion is on the INNER graph's ids, not just on "applied": a version that
   * reported the parent's nodes would be equally green against a status check and equally
   * useless to the person looking at the canvas.
   */
  it("selects the component's OWN nodes when the canvas is inside one", async () => {
    const runtime = newRuntime();
    const placed = await runtime.bus.execute(
      "component.instantiate",
      { componentId: "bloom", position: { x: 0, y: 0 } },
      runtime.invocation,
    );
    expect(placed.output.ok, placed.diagnostics.map((d) => d.message).join("; ")).toBe(true);
    const instance = placed.output.nodeId as NodeId;

    const probe = () => Promise.resolve(NO_WEBGPU);
    await act(async () => {
      render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
    });

    // At the root the canvas holds exactly the one instance node.
    const atRoot = await act(async () =>
      runtime.bus.execute("graph.selectAll", {}, runtime.invocation),
    );
    expect(atRoot.status).toBe("applied");
    expect(atRoot.output.nodeIds).toEqual([instance]);

    await act(async () => {
      await runtime.bus.execute("graph.diveIn", { nodeId: instance }, runtime.invocation);
    });

    /*
     * Inside. Bloom's internals are the nodes to select, and the instance node — the only
     * thing the ROOT graph holds — must not be among them, which is what separates "reads
     * the canvas" from "reads whichever graph the bus happens to carry".
     */
    const inside = await act(async () =>
      runtime.bus.execute("graph.selectAll", {}, runtime.invocation),
    );
    expect(
      inside.status,
      inside.diagnostics.map((d) => `${d.code}: ${d.message}`).join("; "),
    ).toBe("applied");
    expect(inside.output.nodeIds).not.toContain(instance);
    expect(inside.output.nodeIds.length).toBeGreaterThan(1);
    const internals = Object.keys(
      runtime.components.get("bloom" as never, 1)?.graph.nodes ?? {},
    ).sort();
    expect(internals.length).toBeGreaterThan(1);
    expect([...inside.output.nodeIds].sort()).toEqual(internals);
  });
});
