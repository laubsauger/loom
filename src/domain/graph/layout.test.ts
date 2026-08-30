import { describe, expect, it } from "vitest";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import { layoutGraph, placeRelative } from "./layout.ts";

/**
 * T279/T280: the deterministic tidy behind the canvas menu, the L key and the
 * `layout_graph` tool — one implementation, so an agent-built graph and a
 * human-tidied one converge on the same picture (§V78).
 */

function node(id: string, position = { x: 0, y: 0 }, size?: { width: number; height: number }): GraphNode {
  return {
    id: id as NodeId,
    type: "test",
    definitionVersion: 1,
    position,
    parameters: {},
    ...(size === undefined ? {} : { size }),
  };
}

function graphOf(nodes: GraphNode[], edges: Array<[string, string]>): GraphDocument {
  const edgeRecord: Record<string, unknown> = {};
  edges.forEach(([source, target], index) => {
    edgeRecord[`e${index}`] = {
      id: `e${index}`,
      source: { nodeId: source, portId: "out" },
      target: { nodeId: target, portId: "in" },
    };
  });
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((n) => [n.id, n])),
    edges: edgeRecord,
    groups: {},
  } as unknown as GraphDocument;
}

describe("layoutGraph (T279)", () => {
  it("ranks by depth: data flows strictly left to right", () => {
    const graph = graphOf(
      [node("a"), node("b"), node("c"), node("d")],
      [
        ["a", "b"],
        ["b", "c"],
        ["a", "d"],
        ["d", "c"], // c is depth 2 via either path
      ],
    );
    const positions = layoutGraph(graph);
    expect(positions["a"]!.x).toBeLessThan(positions["b"]!.x);
    expect(positions["b"]!.x).toBeLessThan(positions["c"]!.x);
    expect(positions["b"]!.x).toBe(positions["d"]!.x); // same rank, same column
  });

  it("is deterministic: same document, same picture, every time", () => {
    const graph = graphOf(
      [node("z"), node("m"), node("a"), node("k")],
      [
        ["z", "m"],
        ["a", "m"],
        ["m", "k"],
      ],
    );
    expect(layoutGraph(graph)).toEqual(layoutGraph(graph));
  });

  it("orders a rank by producer barycenter, so parallel chains do not cross", () => {
    // Two chains: a→x, b→y, with a above b. x should stay above y.
    const graph = graphOf(
      [node("a"), node("b"), node("x"), node("y")],
      [
        ["a", "x"],
        ["b", "y"],
      ],
    );
    const positions = layoutGraph(graph);
    // Sources sort by id: a before b, so a is higher (smaller y).
    expect(positions["a"]!.y).toBeLessThan(positions["b"]!.y);
    expect(positions["x"]!.y).toBeLessThan(positions["y"]!.y); // followed their producers
  });

  it("survives a feedback cycle: the back-edge is ignored for ranking", () => {
    const graph = graphOf(
      [node("gen"), node("fb"), node("out")],
      [
        ["gen", "fb"],
        ["fb", "out"],
        ["out", "fb"], // temporal back-edge
      ],
    );
    const positions = layoutGraph(graph);
    expect(Object.keys(positions)).toHaveLength(3);
    expect(positions["gen"]!.x).toBeLessThan(positions["fb"]!.x);
  });

  it("respects document node sizes for spacing (§V116)", () => {
    const graph = graphOf(
      [node("big", { x: 0, y: 0 }, { width: 400, height: 300 }), node("next")],
      [["big", "next"]],
    );
    const positions = layoutGraph(graph);
    expect(positions["next"]!.x - positions["big"]!.x).toBeGreaterThanOrEqual(400);
  });

  it("moves only the requested nodes when restricted", () => {
    const graph = graphOf([node("a"), node("b")], [["a", "b"]]);
    const positions = layoutGraph(graph, { only: new Set(["b" as NodeId]) });
    expect(positions["a"]).toBeUndefined();
    expect(positions["b"]).toBeDefined();
  });
});

describe("placeRelative (T280)", () => {
  it("places in reading direction, offset by the anchor's size", () => {
    const graph = graphOf([node("anchor", { x: 100, y: 50 }, { width: 200, height: 120 })], []);
    expect(placeRelative(graph, "anchor" as NodeId, "right")).toEqual({ x: 380, y: 50 });
    expect(placeRelative(graph, "anchor" as NodeId, "below")).toEqual({ x: 100, y: 210 });
    expect(placeRelative(graph, "anchor" as NodeId, "left").x).toBeLessThan(100);
    expect(placeRelative(graph, "missing" as NodeId)).toEqual({ x: 0, y: 0 });
  });
});
