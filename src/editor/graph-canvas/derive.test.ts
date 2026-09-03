import { describe, expect, it } from "vitest";
import { alice, contextFor, createHarness, patch } from "@domain/commands/test-support.ts";
import type { GraphEdge, GraphNode } from "@domain/types/graph.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { LOOM_NODE_TYPE, SIGNAL_EDGE_TYPE, projectEdges, projectNodes } from "./derive.ts";

const registry = createTestRegistry().view();
const context = contextFor(alice);

async function seed() {
  const harness = createHarness("d");
  await harness.bus.execute(
    "graph.applyPatch",
    patch(
      0,
      [
        { op: "addNode", ref: "$solid", type: "test.solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$blur", type: "test.blur", position: { x: 240, y: 40 } },
        {
          op: "connect",
          ref: "$wire",
          source: { nodeId: "$solid", portId: "out" },
          target: { nodeId: "$blur", portId: "source" },
        },
      ],
      "seed",
    ),
    context,
  );
  return harness;
}

describe("V1 — React Flow's arrays are projected from the domain graph", () => {
  it("takes identity, type and position from the document", async () => {
    const { bus } = await seed();
    const graph = bus.store.getGraph();
    const nodes = projectNodes(graph.nodes);

    expect(nodes).toHaveLength(2);
    for (const node of nodes) {
      const domain = graph.nodes[node.id];
      expect(domain).toBeDefined();
      expect(node.type).toBe(LOOM_NODE_TYPE);
      expect(node.position).toEqual(domain?.position);
      // Payload is identity only: parameters and metrics never ride along (§V16).
      expect(node.data).toEqual({ nodeId: node.id });
    }
  });

  it("follows a move made through the bus", async () => {
    const { bus } = await seed();
    const [first] = projectNodes(bus.store.getGraph().nodes);
    if (first === undefined) throw new Error("expected a node");

    await bus.execute(
      "graph.applyPatch",
      patch(bus.store.getRevision(), [
        { op: "moveNodes", positions: { [first.id]: { x: 99, y: -12 } } },
      ]),
      context,
    );

    const moved = projectNodes(bus.store.getGraph().nodes, [first]);
    expect(moved[0]?.position).toEqual({ x: 99, y: -12 });
  });

  it("drops a node the document no longer has", async () => {
    const { bus } = await seed();
    const before = projectNodes(bus.store.getGraph().nodes);
    const doomed = before[0];
    if (doomed === undefined) throw new Error("expected a node");

    await bus.execute(
      "graph.applyPatch",
      patch(bus.store.getRevision(), [{ op: "removeNodes", nodeIds: [doomed.id] }]),
      context,
    );

    const after = projectNodes(bus.store.getGraph().nodes, before);
    expect(after.map((node) => node.id)).not.toContain(doomed.id);
  });

  it("keeps the in-flight drag position until the drag commits (§V15)", () => {
    const nodes: Record<string, GraphNode> = {
      n1: {
        id: "n1",
        type: "test.solid",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
      },
    };
    const dragging = projectNodes(nodes).map((node) => ({
      ...node,
      dragging: true,
      position: { x: 500, y: 500 },
    }));
    expect(projectNodes(nodes, dragging)[0]?.position).toEqual({ x: 500, y: 500 });

    const settled = dragging.map((node) => ({ ...node, dragging: false }));
    expect(projectNodes(nodes, settled)[0]?.position).toEqual({ x: 0, y: 0 });
  });
});

describe("T1102 — the document's stacking order reaches React Flow", () => {
  it("carries ui.z onto zIndex, and leaves an unraised node carrying none", async () => {
    const { bus } = await seed();
    const [first] = projectNodes(bus.store.getGraph().nodes);
    if (first === undefined) throw new Error("no nodes projected");

    // Untouched is untouched: React Flow reads an absent zIndex as 0, which is where every
    // node in every document written before this field sits.
    expect(first.zIndex).toBeUndefined();

    await bus.execute("node.bringToFront", { nodeIds: [first.id] }, context);
    const raised = projectNodes(bus.store.getGraph().nodes, [first]).find(
      (node) => node.id === first.id,
    );
    expect(raised?.zIndex).toBe(bus.store.getGraph().nodes[first.id]?.ui?.z);
    expect(raised?.zIndex ?? 0).toBeGreaterThan(0);
  });

  it("re-projects on a z change — the stale-reuse path must not swallow it", async () => {
    // The projection returns the PREVIOUS object whenever nothing it derives changed
    // (§V16), and z was not one of those things until T1102. Without this the document's
    // order would reach React Flow only when the node also happened to move or resize —
    // i.e. two stacking systems disagreeing again, which is the bug.
    const { bus } = await seed();
    const before = projectNodes(bus.store.getGraph().nodes);
    const target = before[0];
    if (target === undefined) throw new Error("no nodes projected");

    await bus.execute("node.bringToFront", { nodeIds: [target.id] }, context);
    const after = projectNodes(bus.store.getGraph().nodes, before);

    expect(after).not.toBe(before);
    expect(after.find((node) => node.id === target.id)).not.toBe(target);
    // Nothing else moved, so every other node is the same object it was.
    for (const node of after) {
      if (node.id === target.id) continue;
      expect(node).toBe(before.find((prior) => prior.id === node.id));
    }
  });
});

describe("V16 — the projection is referentially stable", () => {
  it("returns the same array when nothing it derives changed", async () => {
    const { bus } = await seed();
    const graph = bus.store.getGraph();
    const first = projectNodes(graph.nodes);
    expect(projectNodes(graph.nodes, first)).toBe(first);

    const edges = projectEdges(graph.edges, graph.nodes, registry);
    expect(projectEdges(graph.edges, graph.nodes, registry, edges)).toBe(edges);
  });

  it("keeps untouched node objects identical when one node moves", async () => {
    const { bus } = await seed();
    const before = projectNodes(bus.store.getGraph().nodes);
    const [moved, untouched] = before;
    if (moved === undefined || untouched === undefined) throw new Error("expected two nodes");

    await bus.execute(
      "graph.applyPatch",
      patch(bus.store.getRevision(), [
        { op: "moveNodes", positions: { [moved.id]: { x: 7, y: 7 } } },
      ]),
      context,
    );

    const after = projectNodes(bus.store.getGraph().nodes, before);
    expect(after[0]).not.toBe(moved);
    // The other node's component must not re-render because a sibling moved.
    expect(after[1]).toBe(untouched);
  });
});

describe("V26 — the edge carries the source port's family, resolved from the registry", () => {
  it("reads the family off the source output port", async () => {
    const { bus } = await seed();
    const graph = bus.store.getGraph();
    const edges = projectEdges(graph.edges, graph.nodes, registry);

    expect(edges).toHaveLength(1);
    const edge = edges[0];
    if (edge === undefined) throw new Error("expected an edge");
    expect(edge.type).toBe(SIGNAL_EDGE_TYPE);

    const domain = graph.edges[edge.id];
    if (domain === undefined) throw new Error("expected a domain edge");
    const sourceNode = graph.nodes[domain.source.nodeId];
    const port = registry.port(sourceNode?.type ?? "", domain.source.portId, "output");
    expect(edge.data?.portKind).toBe(port?.type.kind);
    expect(edge.data?.portKind).toBe("texture2d");
    // The pass whose GPU time drives the animation is the SOURCE pass.
    expect(edge.data?.sourceNodeId).toBe(domain.source.nodeId);
  });

  it("reports no family — rather than an arbitrary one — for an unresolved node (§V10)", () => {
    const nodes: Record<string, GraphNode> = {
      ghost: {
        id: "ghost",
        type: "not.installed",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {},
      },
      blur: {
        id: "blur",
        type: "test.blur",
        definitionVersion: 1,
        position: { x: 100, y: 0 },
        parameters: {},
      },
    };
    const edges: Record<string, GraphEdge> = {
      e1: {
        id: "e1",
        source: { nodeId: "ghost", portId: "out" },
        target: { nodeId: "blur", portId: "source" },
      },
    };
    expect(projectEdges(edges, nodes, registry)[0]?.data?.portKind).toBeNull();
  });

  it("marks the edge inactive when its source pass is bypassed or muted", async () => {
    const { bus } = await seed();
    const graph = bus.store.getGraph();
    const edge = projectEdges(graph.edges, graph.nodes, registry)[0];
    if (edge === undefined) throw new Error("expected an edge");
    expect(edge.data?.inactive).toBe(false);

    await bus.execute(
      "graph.applyPatch",
      patch(bus.store.getRevision(), [
        { op: "setNodeUi", nodeId: edge.data?.sourceNodeId ?? "", ui: { bypassed: true } },
      ]),
      context,
    );

    const next = bus.store.getGraph();
    expect(projectEdges(next.edges, next.nodes, registry)[0]?.data?.inactive).toBe(true);
  });
});
