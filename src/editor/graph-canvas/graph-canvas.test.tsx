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

  it("renders the document's stacking order as an inline z-index (T1102)", async () => {
    /*
     * The assumption BOTH halves of T1102 stand on, pinned where it can break loudly.
     *
     * The preview compositor takes its tile order from these elements' inline `zIndex`
     * (`app/graph-pane.tsx`), and the browser stacks the chrome by the same declaration.
     * That is what makes one order instead of two — and it is a property of React Flow's
     * renderer, not of our code, so an upgrade that moved the number somewhere else would
     * silently return the app to the bug this fixes: chrome layering one way, previews
     * the other, with every unit test still green.
     */
    const { bus, container } = await mountCanvas();
    const blur = Object.values(bus.store.getGraph().nodes).find((node) => node.type === "test.blur");
    if (blur === undefined) throw new Error("expected the blur node");
    const element = () => container.querySelector<HTMLElement>(`.react-flow__node[data-id="${blur.id}"]`);
    // Untouched: no stacking order in the document, nothing forced into the style.
    expect(Number.parseInt(element()?.style.zIndex ?? "", 10) || 0).toBe(0);

    await act(async () => {
      await bus.execute("node.bringToFront", { nodeIds: [blur.id] }, invocation);
    });

    await waitFor(() => {
      expect(Number.parseInt(element()?.style.zIndex ?? "", 10)).toBe(
        bus.store.getGraph().nodes[blur.id]?.ui?.z,
      );
    });
    // And it is above the node nobody raised — the claim, rather than the number.
    const solid = Object.values(bus.store.getGraph().nodes).find((node) => node.type === "test.solid");
    const solidZ =
      Number.parseInt(
        container.querySelector<HTMLElement>(`.react-flow__node[data-id="${solid?.id}"]`)?.style
          .zIndex ?? "",
        10,
      ) || 0;
    expect(Number.parseInt(element()?.style.zIndex ?? "", 10)).toBeGreaterThan(solidZ);
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

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * T1177 — THE BADGE READS THE SELECTION AS IT IS *NOW*, THOUGH NOTHING RE-RENDERED
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The canvas context used to hand every node the selection ARRAY, so clicking a node
 * changed the context value's identity and repainted every `NodeView` and every
 * `SignalEdge` on screen — a context read is not something `React.memo` can protect a
 * component from, and at 120 nodes that was 6.3x the cost of the same click at 4.
 *
 * It hands down a GETTER now, and nothing above a node re-renders when the selection
 * moves. Which is the whole risk: a node that does not re-render is a node that could be
 * holding a selection from two clicks ago, and §V101's rule ("a badge press acts on the
 * whole selection when this node is in it") would then act on the WRONG SET — quietly, and
 * on somebody else's nodes.
 *
 * So this asserts the behaviour rather than the render count (§B181: "it did not
 * re-render" is equally true of the fix and of the bug). Select two, press a badge, and
 * both flip; select one, press it again WITH NO RE-RENDER IN BETWEEN, and only that one
 * does. A captured array passes the first half and fails the second.
 */
describe("T1177 — a badge press reads the CURRENT selection (§V101)", () => {
  it("follows the selection from two nodes down to one", async () => {
    const { bus } = createHarness("sel");
    await apply(
      bus,
      [
        { op: "addNode", ref: "$a", type: "test.blur", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$b", type: "test.blur", position: { x: 240, y: 0 } },
      ],
      "seed",
    );
    const seen: Array<readonly string[]> = [];
    const { container } = render(<GraphCanvas bus={bus} invocation={invocation} onSelectionChange={(ids) => seen.push(ids)} />);
    await waitFor(() => {
      expect(container.querySelectorAll(".react-flow__node")).toHaveLength(2);
    });
    const nodes = [...container.querySelectorAll(".react-flow__node")] as HTMLElement[];
    const idOf = (element: HTMLElement) => element.getAttribute("data-id") ?? "";
    const [first, second] = nodes as [HTMLElement, HTMLElement];
    const bypassedIn = (element: HTMLElement) =>
      bus.store.getGraph().nodes[idOf(element)]?.ui?.bypassed === true;

    // Both selected, through `graph.selectNodes` — the command the palette, the keymap and
    // "select what was just pasted" all run (§V78). A multi-select is what §V101 is about,
    // and this is the door that produces one without depending on a modifier key.
    await act(async () => {
      await bus.execute(
        "graph.selectNodes",
        { nodeIds: [idOf(first), idOf(second)] as never },
        invocation,
      );
      await new Promise((resolve) => setTimeout(resolve, 4));
    });

    const badgeIn = (element: HTMLElement) => {
      const button = [...element.querySelectorAll("button")].find(
        (candidate) => candidate.getAttribute("aria-label") === "Bypass",
      );
      if (button === undefined) throw new Error("no Bypass badge on that node");
      return button;
    };

    expect(seen.at(-1)).toHaveLength(2);
    await act(async () => {
      fireEvent.click(badgeIn(first));
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
    await waitFor(() => {
      expect(bypassedIn(first)).toBe(true);
      // §V101: the press reached the OTHER node because both were selected.
      expect(bypassedIn(second)).toBe(true);
    });

    // Now select only the second, and press ITS badge. Nothing above the node re-rendered
    // when the selection changed — a node holding the previous array would flip both back.
    await act(async () => {
      await bus.execute("graph.selectNodes", { nodeIds: [idOf(second)] as never }, invocation);
      await new Promise((resolve) => setTimeout(resolve, 4));
    });
    await act(async () => {
      fireEvent.click(badgeIn(second));
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
    await waitFor(() => {
      expect(bypassedIn(second)).toBe(false);
    });
    // The load-bearing half: the first node kept the state it had, because it was no
    // longer in the selection the press acted on.
    expect(bypassedIn(first)).toBe(true);
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
    const { bus, container } = await mountCanvas();
    await act(async () => {
      await bus.execute("ui.toggleEdgeFlow", { show: true }, invocation);
    });
    await waitFor(() => {
      expect(container.querySelectorAll(".react-flow__edge-path").length).toBeGreaterThan(0);
    });
    expect(container.querySelector('[data-testid^="edge-flow-"]')).toBeNull();
  });

  it("draws no moving layer at all until the Debug row asks for it (T1013)", async () => {
    // The default a user meets. Same measurement as the test below; the only difference is
    // that nobody asked for the animation, and the owner asked for that to be the default.
    const { bus, runtime, container } = await mountCanvas();
    const solid = Object.values(bus.store.getGraph().nodes).find(
      (node) => node.type === "test.solid",
    );
    if (solid === undefined) throw new Error("expected the solid node");
    await act(async () => {
      runtime.publish(solid.id, { gpuMs: 6 });
      await new Promise((resolve) => setTimeout(resolve, 2));
    });
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

    // T1013: the animation is a debug view now, off unless asked for. Through the BUS
    // COMMAND rather than the store, because that is the only door the menu row has and a
    // test that reached past it would not notice the command going dead (§V78).
    await act(async () => {
      await bus.execute("ui.toggleEdgeFlow", { show: true }, invocation);
    });
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
