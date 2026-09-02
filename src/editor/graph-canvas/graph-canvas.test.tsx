// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { alice, contextFor, createHarness, patch } from "@domain/commands/test-support.ts";
import type { LoomBus } from "@domain/commands/bus.ts";
import { GraphCanvas } from "./graph-canvas.tsx";
import { createNodeRuntimeStore } from "./node-runtime.ts";
import { installFlowStubs, setReducedMotion } from "./testing.tsx";

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
beforeEach(() => setReducedMotion(false));
afterEach(cleanup);

const invocation = contextFor(alice);

async function apply(bus: LoomBus, operations: Parameters<typeof patch>[1], label?: string) {
  await act(async () => {
    await bus.execute(
      "graph.applyPatch",
      patch(bus.store.getRevision(), operations, label),
      invocation,
    );
  });
}

async function mountCanvas() {
  const { bus } = createHarness("c");
  const runtime = createNodeRuntimeStore({ intervalMs: 0 });
  await apply(
    bus,
    [
      { op: "addNode", ref: "$solid", type: "test.solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$blur", type: "test.blur", position: { x: 240, y: 40 } },
      {
        op: "connect",
        source: { nodeId: "$solid", portId: "out" },
        target: { nodeId: "$blur", portId: "source" },
      },
    ],
    "seed",
  );

  const view = render(<GraphCanvas bus={bus} invocation={invocation} runtime={runtime} />);
  return { ...view, bus, runtime };
}

describe("V1 — the canvas is a view of the domain graph", () => {
  it("renders one node per document node, titled with its NAME (§V129, T221)", async () => {
    const { container } = await mountCanvas();

    await waitFor(() => {
      expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);
    });
    // Since T221 every created node carries its unique auto-number name (`solid1`) as
    // its label, and the header shows the label — the registry title is the fallback
    // for legacy unnamed nodes only.
    expect(screen.getByTitle("solid1")).toBeDefined();
    expect(screen.getByTitle("blur1")).toBeDefined();
  });

  it("shows a node that appeared in the document while it was mounted", async () => {
    const { bus, container } = await mountCanvas();
    await apply(bus, [
      { op: "addNode", ref: "$c", type: "test.composite", position: { x: 400, y: 0 } },
    ]);

    await waitFor(() => {
      expect(container.querySelectorAll(".react-flow__node")).toHaveLength(3);
    });
    expect(screen.getByTitle("composite1")).toBeDefined();
  });

  it("drops a node the document removed, and its incident edges with it (§V40)", async () => {
    const { bus, container } = await mountCanvas();
    const solid = Object.values(bus.store.getGraph().nodes).find(
      (node) => node.type === "test.solid",
    );
    if (solid === undefined) throw new Error("expected the solid node");

    await apply(bus, [{ op: "removeNodes", nodeIds: [solid.id] }]);

    await waitFor(() => {
      expect(container.querySelectorAll(".react-flow__node")).toHaveLength(1);
    });
    expect(container.querySelectorAll(".react-flow__edge")).toHaveLength(0);
  });

  it("follows a position the document changed", async () => {
    const { bus, container } = await mountCanvas();
    const blur = Object.values(bus.store.getGraph().nodes).find((node) => node.type === "test.blur");
    if (blur === undefined) throw new Error("expected the blur node");

    await apply(bus, [{ op: "moveNodes", positions: { [blur.id]: { x: 512, y: 96 } } }]);

    await waitFor(() => {
      const node = container.querySelector(`.react-flow__node[data-id="${blur.id}"]`);
      const transform = node?.getAttribute("style") ?? "";
      expect(transform).toMatch(/translate\(512px,\s*96px\)/);
    });
  });

  it("mutates nothing on its own — mounting a canvas is not an edit", async () => {
    const { bus } = await mountCanvas();
    const revision = bus.store.getRevision();
    const audit = bus.store.getAudit().length;

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5));
    });

    expect(bus.store.getRevision()).toBe(revision);
    expect(bus.store.getAudit()).toHaveLength(audit);
  });
});

describe("selection and hover leave the canvas for the keymap (T77)", () => {
  it("reports the selected node ids and the hovered node", async () => {
    const { bus } = createHarness("s");
    const selections: ReadonlyArray<readonly string[]>[] = [];
    const hovers: Array<string | null> = [];
    await apply(bus, [{ op: "addNode", ref: "$s", type: "test.solid", position: { x: 0, y: 0 } }]);

    const { container } = render(
      <GraphCanvas
        bus={bus}
        invocation={invocation}
        onSelectionChange={(ids) => selections.push([ids])}
        onHoveredNodeChange={(id) => hovers.push(id)}
      />,
    );
    const node = container.querySelector(".react-flow__node");
    if (node === null) throw new Error("expected a node element");

    fireEvent.mouseEnter(node);
    fireEvent.mouseLeave(node);
    expect(hovers).toEqual([expect.any(String), null]);

    fireEvent.click(node);
    await waitFor(() => {
      expect(selections.at(-1)?.[0]).toHaveLength(1);
    });
  });
});

describe("V26 — the projected edge carries the source port's family", () => {
  it("paints the rendered edge with the source output port's token", async () => {
    const { container } = await mountCanvas();

    await waitFor(() => {
      expect(container.querySelectorAll(".react-flow__edge-path").length).toBeGreaterThan(0);
    });
    const path = container.querySelector(".react-flow__edge-path");
    // test.solid's "out" port is texture2d, so the wire leaving it is texture2d-hued.
    expect(path?.getAttribute("style")).toContain("--edge-color: var(--port-texture2d)");
  });

  it("is a static hairline while no pass has reported GPU time", async () => {
    const { container } = await mountCanvas();
    await waitFor(() => {
      expect(container.querySelectorAll(".react-flow__edge-path").length).toBeGreaterThan(0);
    });
    expect(container.querySelector('[data-testid^="edge-flow-"]')).toBeNull();
  });

  it("starts flowing when the source pass reports time, and stops under reduced motion", async () => {
    const { bus, runtime, container } = await mountCanvas();
    const solid = Object.values(bus.store.getGraph().nodes).find(
      (node) => node.type === "test.solid",
    );
    if (solid === undefined) throw new Error("expected the solid node");

    await act(async () => {
      runtime.publish(solid.id, { gpuMs: 6 });
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
    expect(container.querySelector('[data-testid^="edge-flow-"]')).not.toBeNull();

    cleanup();
    setReducedMotion(true);
    const reduced = render(<GraphCanvas bus={bus} invocation={invocation} runtime={runtime} />);
    await waitFor(() => {
      expect(reduced.container.querySelectorAll(".react-flow__edge-path").length).toBeGreaterThan(0);
    });
    expect(reduced.container.querySelector('[data-testid^="edge-flow-"]')).toBeNull();
  });
});
