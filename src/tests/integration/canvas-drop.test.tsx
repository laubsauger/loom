// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import { NODE_DRAG_MIME } from "@editor/library/index.ts";
import type { NodeDragPayload } from "@editor/library/index.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
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
});
