import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphEdge, GraphNode } from "@domain/types/graph.ts";
import type { EdgeId, NodeId } from "@domain/types/ids.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { connectionModel, movedOrder } from "./connections.ts";

/**
 * The Connections row model (T1049).
 *
 * Against the REAL node manifests, not a fixture registry: the socket names this list
 * shows are the ones the node draws on the canvas ("Behind 1", "Behind 2"), and a private
 * fixture with a port called `in2` would pass while the panel and the node disagreed about
 * what the user is pointing at.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

function node(id: string, type: string, label?: string): GraphNode {
  return {
    id: id as NodeId,
    type,
    definitionVersion: registry.get(type)?.version ?? 1,
    position: { x: 0, y: 0 },
    parameters: {},
    ...(label === undefined ? {} : { label }),
  };
}

function edge(
  id: string,
  from: [string, string],
  to: [string, string],
  order?: number,
): GraphEdge {
  return {
    id: id as EdgeId,
    source: { nodeId: from[0] as NodeId, portId: from[1] },
    target: { nodeId: to[0] as NodeId, portId: to[1] },
    ...(order === undefined ? {} : { order }),
  };
}

function document(nodes: GraphNode[], edges: GraphEdge[]): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges: Object.fromEntries(edges.map((entry) => [entry.id, entry])),
    groups: {},
  };
}

/**
 * THREE layers, never two (§V854).
 *
 * A two-edge fixture cannot tell "moved to position 1" apart from "reversed", so it would
 * pass a reorder that is arithmetically wrong in the most likely way. Three distinguishes
 * them: [a,b,c] moved 2→0 is [c,a,b]; reversed is [c,b,a].
 */
function threeLayers(): GraphDocument {
  return document(
    [
      node("na", "solid", "red1"),
      node("nb", "solid", "green1"),
      node("nc", "solid", "blue1"),
      node("front", "solid", "front1"),
      node("comp", "over", "over1"),
    ],
    [
      edge("ef", ["front", "out"], ["comp", "in1"]),
      edge("ea", ["na", "out"], ["comp", "in2"], 0),
      edge("eb", ["nb", "out"], ["comp", "in2"], 1),
      edge("ec", ["nc", "out"], ["comp", "in2"], 2),
    ],
  );
}

const layerGroup = (graph: GraphDocument) =>
  connectionModel(graph, registry, "comp" as NodeId).inputs.find((group) => group.portId === "in2");

describe("the Connections row model (T1049)", () => {
  it("names the node at the other end by its LABEL, and falls back to the id only when there is none (§B170)", () => {
    // The whole reason this panel is worth having is that you can read it. An id is a
    // receipt the user never typed; B170 shipped two dead examples out of exactly this
    // confusion, in the other direction.
    const graph = threeLayers();
    const nameless = { ...(graph.nodes["nb"] as GraphNode) };
    delete nameless.label;
    const withNameless = document(
      [...Object.values(graph.nodes).filter((entry) => entry.id !== "nb"), nameless],
      Object.values(graph.edges),
    );

    const rows = layerGroup(withNameless)?.rows ?? [];
    expect(rows.map((row) => row.peerName)).toEqual(["red1", "nb", "blue1"]);
    // And the id is still carried, because the panel has to be able to ADDRESS the node
    // even while it NAMES it — the two are different fields, which is B170's ruling.
    expect(rows.map((row) => row.peerNodeId)).toEqual(["na", "nb", "nc"]);
  });

  it("reads the layers in the DOCUMENT's order, not the order the edges were written", () => {
    // The claim §V131 exists for. The edges are keyed a, b, c and ordered c, a, b; a model
    // that fell back to key order would look perfectly plausible and describe a different
    // picture from the one the compiler renders.
    const graph = threeLayers();
    const reordered = document(Object.values(graph.nodes), [
      edge("ef", ["front", "out"], ["comp", "in1"]),
      edge("ea", ["na", "out"], ["comp", "in2"], 1),
      edge("eb", ["nb", "out"], ["comp", "in2"], 2),
      edge("ec", ["nc", "out"], ["comp", "in2"], 0),
    ]);
    expect(layerGroup(reordered)?.rows.map((row) => row.peerName)).toEqual([
      "blue1",
      "red1",
      "green1",
    ]);
  });

  it("sorts an edge that predates the order field LAST, so an old document still reads right (§V68)", () => {
    // Documents saved before T225 carry no `order` at all. If those sorted FIRST — or in
    // key order — this panel would invite the user to "fix" an arrangement the compiler
    // never had, and the fix would move a layer that was already where it belonged.
    const graph = document(Object.values(threeLayers().nodes), [
      edge("ef", ["front", "out"], ["comp", "in1"]),
      edge("ea", ["na", "out"], ["comp", "in2"]),
      edge("eb", ["nb", "out"], ["comp", "in2"], 1),
      edge("ec", ["nc", "out"], ["comp", "in2"], 0),
    ]);
    expect(layerGroup(graph)?.rows.map((row) => row.peerName)).toEqual(["blue1", "green1", "red1"]);
  });

  it("names each socket the way the NODE draws it, so the row and the socket are the same thing", () => {
    // `node-view.tsx` labels a variadic socket `${port.label} ${slot + 1}`. A second
    // naming scheme here (0-based, or the port id) would leave the user matching "in2 #1"
    // in the panel against "Behind 2" on the node.
    const rows = layerGroup(threeLayers())?.rows ?? [];
    expect(rows.map((row) => row.socket)).toEqual(["Behind 1", "Behind 2", "Behind 3"]);
    // An ordinary port has no slot to say: one wire, one name.
    const front = connectionModel(threeLayers(), registry, "comp" as NodeId).inputs.find(
      (group) => group.portId === "in1",
    );
    expect(front?.rows.map((row) => row.socket)).toEqual(["Front"]);
  });

  it("offers reorder ONLY where the document has an order to change", () => {
    // Three claims, and each one is a gesture that would otherwise be refused by the patch
    // layer: an ordinary port rejects `reorderEdges` outright (`port.notVariadic`), and a
    // single wire has no arrangement at all. A grip on either is a control that cannot act.
    const model = connectionModel(threeLayers(), registry, "comp" as NodeId);
    expect(model.inputs.find((group) => group.portId === "in2")?.orderable).toBe(true);
    expect(model.inputs.find((group) => group.portId === "in1")?.orderable).toBe(false);

    const single = document(
      [node("na", "solid", "red1"), node("comp", "over", "over1")],
      [edge("ea", ["na", "out"], ["comp", "in2"], 0)],
    );
    expect(
      connectionModel(single, registry, "comp" as NodeId).inputs.find(
        (group) => group.portId === "in2",
      )?.orderable,
    ).toBe(false);
  });

  it("lists consumers on the out side and tells you WHICH socket of each one it feeds", () => {
    // The asymmetry, as data. An output fans out and has no order of its own, so the fact
    // worth carrying is the peer's slot: "this wire is layer 2 of over1" is the thing you
    // opened the panel to find out, and it is changed from over1, not from here.
    const graph = threeLayers();
    const model = connectionModel(graph, registry, "nb" as NodeId);
    expect(model.inputs).toEqual([]);
    expect(model.outputs).toHaveLength(1);
    const [only] = model.outputs[0]?.rows ?? [];
    expect(only?.peerName).toBe("over1");
    expect(only?.peerPort).toBe("Behind 2");
    // No `orderable` on this side, at all — not a false one (see the module docblock).
    expect(model.outputs[0]).not.toHaveProperty("orderable");
  });

  it("counts nothing when nothing is wired, so the panel can say so instead of drawing an empty box (§V91)", () => {
    const lonely = document([node("na", "solid", "red1")], []);
    expect(connectionModel(lonely, registry, "na" as NodeId).total).toBe(0);
    expect(connectionModel(threeLayers(), registry, "comp" as NodeId).total).toBe(4);
  });

  it("still shows a wire landing on a port no installed definition declares (§V10, §V91)", () => {
    // An uninstalled node package leaves real edges on a node whose manifest is missing.
    // Dropping those rows would tell the user the node is unwired while the compiler is
    // still folding them; showing them un-reorderable is the honest answer.
    const graph = document(
      [node("na", "solid", "red1"), node("mystery", "not.installed", "thing1")],
      [edge("ea", ["na", "out"], ["mystery", "whatever"])],
    );
    const model = connectionModel(graph, registry, "mystery" as NodeId);
    expect(model.inputs).toHaveLength(1);
    expect(model.inputs[0]?.orderable).toBe(false);
    expect(model.inputs[0]?.rows[0]?.socket).toBe("whatever");
    expect(model.inputs[0]?.rows[0]?.peerName).toBe("red1");
  });
});

describe("the reorder a dragged row asks for", () => {
  const ids = ["a", "b", "c"] as EdgeId[];

  it("moves ONE row and leaves the rest in their relative order", () => {
    // §V854: with three rows, "move 2 to the front" and "reverse" are different answers.
    // With two they are the same answer, and a test on two proves nothing about either.
    expect(movedOrder(ids, 2, 0)).toEqual(["c", "a", "b"]);
    expect(movedOrder(ids, 0, 2)).toEqual(["b", "c", "a"]);
    expect(movedOrder(ids, 1, 0)).toEqual(["b", "a", "c"]);
  });

  it("asks for NOTHING when the row would not move", () => {
    // A drag wanders over its own row constantly. Sending a patch for each pass would
    // spend a document revision — and an audit entry — on a picture nobody changed.
    expect(movedOrder(ids, 1, 1)).toBeNull();
    expect(movedOrder(ids, 3, 0)).toBeNull();
    expect(movedOrder(ids, -1, 0)).toBeNull();
    expect(movedOrder([], 0, 0)).toBeNull();
  });

  it("clamps a move past either end instead of refusing it", () => {
    // The pointer is already released, or the arrow key is being held at the last row.
    // Refusing leaves the user pressing a key that silently does nothing; clamping does
    // what they can see they asked for — the ruling `edge-order.ts` makes for a drop past
    // the last socket.
    expect(movedOrder(ids, 0, 9)).toEqual(["b", "c", "a"]);
    expect(movedOrder(ids, 2, -4)).toEqual(["c", "a", "b"]);
  });
});
