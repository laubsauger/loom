import { describe, expect, it } from "vitest";

import type { GraphDocument, GraphEdge, GraphNode } from "@domain/types/graph.ts";
import type { EdgeId, NodeId } from "@domain/types/ids.ts";
import { overNode } from "@nodes/definitions/composite.ts";
import { solidNode } from "@nodes/definitions/solid.ts";
import { pointGridNode } from "@nodes/definitions/point-generators.ts";
import { textureToAttributeNode } from "@nodes/definitions/points.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { connectDropOperations } from "./connect-drop.ts";

/**
 * What a connection dropped on a socket MEANS (T695, T1049, §V13, §V14a).
 *
 * This lived inside `graph-canvas.tsx` until the Connections panel needed the same answer.
 * It is gated here rather than only through either caller because it is now the SHARED
 * rule: a change that suits the panel and breaks the canvas has to fail somewhere that is
 * not a canvas test nobody thought to run.
 *
 * The behavioural claims about the canvas's own gesture stay where they were
 * (`graph-canvas` tests, `edge-order.test.ts`'s T695 block); these are the rules the two
 * surfaces now share, including the one the canvas never needed — a refusal that can be
 * SAID, because the panel has a named row to say it about.
 */

const registry = createNodeRegistry([
  overNode,
  solidNode,
  pointGridNode,
  textureToAttributeNode,
]).view();

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

function edge(id: string, from: [string, string], to: [string, string], order?: number): GraphEdge {
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

/** Three layers on one variadic port, plus a spare source that is not wired yet. */
function threeLayers(): GraphDocument {
  return document(
    [
      node("na", "solid", "red1"),
      node("nb", "solid", "green1"),
      node("nc", "solid", "blue1"),
      node("nd", "solid", "spare1"),
      node("comp", "over", "over1"),
    ],
    [
      edge("ea", ["na", "out"], ["comp", "in2"], 0),
      edge("eb", ["nb", "out"], ["comp", "in2"], 1),
      edge("ec", ["nc", "out"], ["comp", "in2"], 2),
    ],
  );
}

const drop = (
  graph: GraphDocument,
  source: [string, string],
  target: { nodeId: string; portId: string; slot?: number },
  moving?: string,
) =>
  connectDropOperations({
    graph,
    registry,
    source: { nodeId: source[0] as NodeId, portId: source[1] },
    target: { ...target, nodeId: target.nodeId as NodeId },
    ...(moving === undefined ? {} : { moving: moving as EdgeId }),
  });

describe("a drop on a variadic socket (T695)", () => {
  it("REPLACES the wire in that socket, in place, leaving the count and the others alone", () => {
    // Both halves are one claim and neither survives alone. Getting only the COUNT right is
    // an append with an extra delete — three layers in, three out, and the new wire at the
    // bottom of a stack the user aimed at the middle of.
    const result = drop(threeLayers(), ["nd", "out"], { nodeId: "comp", portId: "in2", slot: 1 });
    expect(result.kind).toBe("connect");
    if (result.kind !== "connect") return;
    expect(result.operations).toEqual([
      { op: "disconnect", edgeIds: ["eb"] },
      {
        op: "connect",
        source: { nodeId: "nd", portId: "out" },
        target: { nodeId: "comp", portId: "in2" },
        order: 1,
      },
    ]);
  });

  it("APPENDS when the socket named is the spare one past the end", () => {
    // The spare resolves to no edge, so the drop arrives with no order and lands where a
    // new layer belongs. This is the gesture the one-socket port could not express at all.
    const result = drop(threeLayers(), ["nd", "out"], { nodeId: "comp", portId: "in2", slot: 3 });
    expect(result.kind).toBe("connect");
    if (result.kind !== "connect") return;
    expect(result.operations).toHaveLength(1);
    expect(result.operations[0]).not.toHaveProperty("order");
  });

  it("does nothing when the wire dropped is already the one in that socket", () => {
    // Not a rewire: a disconnect-then-reconnect would spend a revision, an audit entry and
    // a new edge id to arrive exactly where it started.
    expect(drop(threeLayers(), ["nb", "out"], { nodeId: "comp", portId: "in2", slot: 1 }).kind).toBe(
      "unchanged",
    );
  });
});

describe("moving an EXISTING wire (T1049's re-target)", () => {
  it("frees the wire first, so the port it lands on counts the sockets right", () => {
    // Without the moving edge in the same patch, the panel would leave the old connection
    // in place and the node would gain a layer instead of moving one.
    const result = drop(threeLayers(), ["nc", "out"], { nodeId: "comp", portId: "in1" }, "ec");
    expect(result.kind).toBe("connect");
    if (result.kind !== "connect") return;
    expect(result.operations[0]).toEqual({ op: "disconnect", edgeIds: ["ec"] });
    expect(result.label).toBe("Move connection");
  });

  it("does not count the wire being moved as an occupant to displace", () => {
    // The subtle one: `in1` is an ordinary port, so the displacement scan runs. If it saw
    // the edge already queued for disconnection it would emit it twice — and a patch that
    // disconnects the same edge twice is describing a graph that does not exist.
    const graph = document(
      [node("na", "solid", "red1"), node("comp", "over", "over1")],
      [edge("ea", ["na", "out"], ["comp", "in1"])],
    );
    const result = drop(graph, ["na", "out"], { nodeId: "comp", portId: "in1" }, "ea");
    expect(result.kind).toBe("connect");
    if (result.kind !== "connect") return;
    const disconnects = result.operations.filter((op) => op.op === "disconnect");
    expect(disconnects).toEqual([{ op: "disconnect", edgeIds: ["ea"] }]);
  });

  it("lands on the socket the user AIMED at when moving down inside its own port", () => {
    // The off-by-one the disconnect creates: freeing slot 0 compacts everything above it,
    // so aiming at slot 2 while holding slot 0 must resolve to 1 or the wire arrives one
    // place late — the failure that counts right and wires wrong.
    const result = drop(threeLayers(), ["na", "out"], { nodeId: "comp", portId: "in2", slot: 2 }, "ea");
    expect(result.kind).toBe("connect");
    if (result.kind !== "connect") return;
    expect(result.operations.at(-1)).toMatchObject({ op: "connect", order: 1 });
  });
});

describe("a drop that cannot mean anything (§V13, §V288)", () => {
  it("refuses an incompatible pair and NAMES both types", () => {
    // §V13: exact match, no implicit conversion — a near miss is a missing node, and a
    // gesture is the last place to invent one. §V288: the refusal says WHICH two types did
    // not meet, because "invalid connection" tells the user nothing they can act on.
    const graph = document(
      [node("tex", "solid", "solid1"), node("mix", "textureToAttribute", "attr1")],
      [],
    );
    const result = drop(graph, ["tex", "out"], { nodeId: "mix", portId: "points" });
    expect(result.kind).toBe("refused");
    if (result.kind !== "refused") return;
    expect(result.diagnostic.code).toBe("connect.incompatible");
    expect(result.diagnostic.message).toContain("texture2d");
    expect(result.diagnostic.message).toContain("pointset");
    // §B170: the wire's own end is named, not addressed.
    expect(result.diagnostic.message).toContain("solid1");
  });

  it("accepts the SAME source on the port that does fit, so the refusal is about the types", () => {
    // §V854's precondition: a refusal proves nothing unless the fixture can also succeed.
    // Same document, same source, the other port — and it connects.
    const graph = document(
      [node("tex", "solid", "solid1"), node("mix", "textureToAttribute", "attr1")],
      [],
    );
    expect(drop(graph, ["tex", "out"], { nodeId: "mix", portId: "texture" }).kind).toBe("connect");
  });
});
