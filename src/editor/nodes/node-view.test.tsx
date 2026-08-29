// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { alice, contextFor } from "@domain/commands/test-support.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import {
  CanvasFixture,
  fixtureContext,
  installFlowStubs,
  nodeProps,
  setReducedMotion,
} from "@editor/graph-canvas/testing.tsx";
import type { NodeRunStatus, NodeRuntimeStore } from "@editor/graph-canvas/node-runtime.ts";
import { NodeView } from "./node-view.tsx";
import { STATUS_LABEL } from "./status.ts";

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
beforeEach(() => setReducedMotion(false));
afterEach(cleanup);

const invocation = contextFor(alice);

interface Options {
  graph?: GraphDocument;
  renderPreview?: (nodeId: string) => React.ReactNode;
  renderControls?: (nodeId: string) => React.ReactNode;
}

/**
 * Mounts one node against a real store and a real command bus, so every edit the node
 * chrome makes is exercised through the only mutation path there is (§V29).
 */
function mountNode(type: string, options: Options = {}) {
  const store = createGraphStore({
    ids: createSequentialIdFactory("n"),
    ...(options.graph === undefined ? {} : { initialGraph: options.graph }),
  });
  const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
  const dispatched: GraphPatchOperation[][] = [];

  const seeded = Object.keys(bus.store.getGraph().nodes)[0];
  const nodeId = seeded ?? "pending";

  const { value, runtime } = fixtureContext({
    store: bus.store,
    registry: bus.registry,
    dispatch: (operations, label) => {
      dispatched.push(operations);
      void bus.execute(
        "graph.applyPatch",
        { baseRevision: bus.store.getRevision(), operations, label },
        invocation,
      );
    },
    ...(options.renderPreview === undefined ? {} : { renderPreview: options.renderPreview }),
    ...(options.renderControls === undefined ? {} : { renderControls: options.renderControls }),
  });

  const view = render(
    <CanvasFixture value={value}>
      <NodeView {...nodeProps(nodeId)} />
    </CanvasFixture>,
  );

  return { ...view, bus, runtime, nodeId, dispatched, type };
}

function graphWith(type: string, ui?: Record<string, boolean>): GraphDocument {
  return {
    revision: 1,
    nodes: {
      n1: {
        id: "n1",
        type,
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
        ...(ui === undefined ? {} : { ui }),
      },
    },
    edges: {},
    groups: {},
  };
}

async function publish(
  runtime: NodeRuntimeStore,
  nodeId: string,
  patch: Parameters<NodeRuntimeStore["publish"]>[1],
) {
  await act(async () => {
    runtime.publish(nodeId, patch);
    await new Promise((resolve) => setTimeout(resolve, 1));
  });
}

describe("V1 — the node renders the document, not a copy of it", () => {
  it("takes its title and ports from the registered definition", () => {
    const { container } = mountNode("test.composite", { graph: graphWith("test.composite") });

    expect(screen.getByTitle("Composite")).toBeDefined();
    const rows = [...container.querySelectorAll("li[data-kind]")];
    expect(rows.map((row) => row.textContent)).toEqual(["Layers", "Mask", "Out"]);
  });

  it("puts inputs on the left and outputs on the right (doc §17.2)", () => {
    const { container } = mountNode("test.blur", { graph: graphWith("test.blur") });

    const inputs = [...container.querySelectorAll('[data-handlepos="left"]')];
    const outputs = [...container.querySelectorAll('[data-handlepos="right"]')];
    expect(inputs.map((handle) => handle.getAttribute("data-handleid"))).toEqual(["source"]);
    expect(outputs.map((handle) => handle.getAttribute("data-handleid"))).toEqual(["out"]);
  });

  it("preserves an unresolved node instead of dropping it (§V10)", () => {
    const { container } = mountNode("not.installed", { graph: graphWith("not.installed") });

    const node = container.querySelector("[data-testid^='node-']");
    expect(node?.getAttribute("data-status")).toBe("error");
    expect(screen.getByText(/Unknown node type "not.installed"/)).toBeDefined();
    // No definition means no ports we could honestly draw.
    expect(container.querySelectorAll("li[data-kind]")).toHaveLength(0);
  });
});

describe("V26 — port dots carry the family colour the edges use", () => {
  it("colours every port from its own family token", () => {
    const { container } = mountNode("test.composite", { graph: graphWith("test.composite") });
    const rows = [...container.querySelectorAll("li[data-kind]")];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const kind = row.getAttribute("data-kind");
      expect(row.getAttribute("style")).toContain(`--port-color: var(--port-${kind})`);
    }
  });

  it("gives a differently typed port a different family token", () => {
    const { container } = mountNode("test.scalarF32", { graph: graphWith("test.scalarF32") });
    const row = container.querySelector("li[data-kind]");
    expect(row?.getAttribute("data-kind")).toBe("scalar");
    expect(row?.getAttribute("style")).toContain("var(--port-scalar)");
  });
});

describe("node status states are distinct (doc §17.2)", () => {
  const statuses: NodeRunStatus[] = [
    "idle",
    "compiling",
    "valid",
    "warning",
    "error",
    "device-lost",
  ];

  it("renders a distinguishable state for each", async () => {
    const seen = new Set<string>();
    for (const status of statuses) {
      const { container, runtime, nodeId, unmount } = mountNode("test.blur", {
        graph: graphWith("test.blur"),
      });
      await publish(runtime, nodeId, { status });

      const node = container.querySelector("[data-testid^='node-']");
      const dot = container.querySelector("[data-testid^='node-status-']");
      expect(node?.getAttribute("data-status")).toBe(status);
      const label = dot?.getAttribute("aria-label") ?? "";
      expect(label).toBe(`Status: ${STATUS_LABEL[status]}`);
      // Colour is never the only carrier of the state (§V19).
      seen.add(label);
      unmount();
    }
    expect(seen.size).toBe(statuses.length);
  });

  it("shows bypassed and muted as document state, separate from run status", () => {
    const bypassed = mountNode("test.blur", { graph: graphWith("test.blur", { bypassed: true }) });
    expect(
      bypassed.container.querySelector("[data-testid^='node-']")?.getAttribute("data-bypassed"),
    ).toBe("true");
    bypassed.unmount();

    const muted = mountNode("test.blur", { graph: graphWith("test.blur", { muted: true }) });
    expect(
      muted.container.querySelector("[data-testid^='node-']")?.getAttribute("data-muted"),
    ).toBe("true");
  });

  it("flags a stale output (§V9)", async () => {
    const { runtime, nodeId } = mountNode("test.blur", { graph: graphWith("test.blur") });
    await publish(runtime, nodeId, { stale: true });
    expect(screen.getByText("stale")).toBeDefined();
  });

  it("carries the shader diagnostic badge, and shows nothing while clean (§V27)", async () => {
    const { runtime, nodeId } = mountNode("test.customWgsl", {
      graph: graphWith("test.customWgsl"),
    });
    expect(screen.queryByRole("status")).toBeNull();

    await publish(runtime, nodeId, { errorCount: 2, warningCount: 1 });
    expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
      "Shader: 2 errors, 1 warnings",
    );
  });
});

describe("V42 — agent activity is visible on the node it is changing", () => {
  it("names the state and the actor", async () => {
    const { runtime, nodeId } = mountNode("test.blur", { graph: graphWith("test.blur") });
    await publish(runtime, nodeId, {
      agent: { kind: "awaiting-approval", actorLabel: "Claude", detail: "wants to rewrite WGSL" },
    });

    expect(screen.getByText("awaiting approval")).toBeDefined();
    expect(screen.getByText("Claude")).toBeDefined();
    expect(screen.getByText("wants to rewrite WGSL")).toBeDefined();
  });

  it("shows nothing when no agent is involved", () => {
    const { container } = mountNode("test.blur", { graph: graphWith("test.blur") });
    expect(container.querySelector("[data-testid^='node-']")?.getAttribute("data-agent")).toBe(
      "none",
    );
  });
});

describe("V16 — metrics reach the node without touching the document", () => {
  it("shows per-pass GPU time and leaves the graph revision alone", async () => {
    const { bus, runtime, nodeId } = mountNode("test.blur", { graph: graphWith("test.blur") });
    const before = bus.store.getRevision();

    expect(screen.getByLabelText("GPU time for this pass").textContent).toBe("—");
    await publish(runtime, nodeId, { gpuMs: 3.25 });

    expect(screen.getByLabelText("GPU time for this pass").textContent).toBe("3.25 ms");
    expect(bus.store.getRevision()).toBe(before);
  });
});

describe("V20 — a drag on embedded node chrome never becomes a node drag", () => {
  it("opts every embedded control out of React Flow's drag and pan filters", () => {
    const { container } = mountNode("test.blur", {
      graph: graphWith("test.blur", { preview: true }),
      renderPreview: () => <div>preview</div>,
      renderControls: () => <button type="button">radius</button>,
    });

    // React Flow refuses to start a drag or a pan when the pressed element is inside
    // `.nodrag` / `.nopan`. This is that predicate, evaluated the same way.
    for (const name of ["Bypass", "Mute", "Preview"]) {
      const control = screen.getByRole("button", { name });
      expect(control.closest(".nodrag")).not.toBeNull();
      expect(control.closest(".nopan")).not.toBeNull();
    }
    expect(screen.getByText("preview").closest(".nodrag")).not.toBeNull();
    expect(screen.getByText("radius").closest(".nodrag")).not.toBeNull();

    // The title bar, by contrast, must still drag the node.
    const title = container.querySelector("header");
    expect(title?.closest(".nodrag")).toBeNull();
  });

  it("swallows the press so an ancestor drag handler never sees it", () => {
    const ancestor = vi.fn();
    const store = createGraphStore({ initialGraph: graphWith("test.blur") });
    const { bus } = createDomainBus({ store, registry: createTestRegistry().view() });
    const { value } = fixtureContext({ store: bus.store, registry: bus.registry });

    render(
      <CanvasFixture value={value}>
        <div onPointerDown={ancestor} onMouseDown={ancestor}>
          <NodeView {...nodeProps("n1")} />
        </div>
      </CanvasFixture>,
    );

    fireEvent.mouseDown(screen.getByRole("button", { name: "Bypass" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Bypass" }));
    expect(ancestor).not.toHaveBeenCalled();

    // A press on the node body itself still reaches the ancestor — otherwise dragging
    // a node would be broken, which is the opposite failure.
    fireEvent.mouseDown(screen.getByTitle("Blur"));
    expect(ancestor).toHaveBeenCalled();
  });
});

describe("V29 — node chrome mutates only through the command bus", () => {
  it("bypasses and un-bypasses through a graph patch", async () => {
    const { bus, dispatched } = mountNode("test.blur", { graph: graphWith("test.blur") });

    fireEvent.click(screen.getByRole("button", { name: "Bypass" }));
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.bypassed).toBe(true);
    });
    expect(dispatched[0]).toEqual([{ op: "setNodeUi", nodeId: "n1", ui: { bypassed: true } }]);

    fireEvent.click(screen.getByRole("button", { name: "Bypass" }));
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.bypassed).toBe(false);
    });
  });

  it("mutes through the bus too, and reflects the document back", async () => {
    const { bus } = mountNode("test.blur", { graph: graphWith("test.blur") });

    fireEvent.click(screen.getByRole("button", { name: "Mute" }));
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.muted).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Mute" }).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("preview slot (§V28)", () => {
  it("stays absent until the node asks for a preview", async () => {
    const { bus, container } = mountNode("test.blur", {
      graph: graphWith("test.blur"),
      renderPreview: () => <div>tile</div>,
    });
    expect(container.querySelector("[data-testid^='node-preview-']")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Preview" }));
    await waitFor(() => {
      expect(bus.store.getGraph().nodes["n1"]?.ui?.preview).toBe(true);
    });
    expect(screen.getByText("tile")).toBeDefined();
  });
});
