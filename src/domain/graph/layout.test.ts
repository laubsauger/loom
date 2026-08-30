import { describe, expect, it } from "vitest";

import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry, type NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import { layoutGraph, placeRelative, MIN_LAYOUT_COLUMN_GAP, MIN_LAYOUT_ROW_GAP } from "./layout.ts";
import { boxGap, boxesOverlap, nodeBox } from "./node-box.ts";

/**
 * T279/T280: the deterministic tidy behind the canvas menu, the `L`/`l` keys and the
 * `layout_graph` tool — one implementation, so an agent-built graph and a
 * human-tidied one converge on the same picture (§V78, §V191).
 *
 * B84 added the geometry half. `layoutGraph` used to size a node as `node.size ?? 180×100`
 * and `node-box.ts` — measured against a real browser — says 178 wide and a height that
 * depends on whether the node previews. So the last three tests here are not about the
 * ALGORITHM at all: they are about the layout and the rest of the app agreeing on how big
 * a node is, which is what §V189's "same graph → same positions" was actually promising.
 *
 * SENSITIVITY, proved in a worktree (§V364) by restoring `node.size ?? {180, 100}`: all
 * four B84 cases below went red and the six algorithm tests above stayed green — 140 where
 * 187 is right, 260 where 258 is right, 140 where 203 is right, and "boxes 0 and 1
 * overlap". That 47px gap between 140 and 187 is the interpenetration the old model would
 * have shipped on every stacked pair, and the fourth failure is it happening.
 */

/** The whole catalogue, as every other consumer of `nodeBox` uses it. */
const catalogue: NodeRegistryView = createNodeRegistry(allNodeDefinitions).view();

function node(
  id: string,
  position = { x: 0, y: 0 },
  size?: { width: number; height: number },
  type = "test",
): GraphNode {
  return {
    id: id as NodeId,
    type,
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
    const positions = layoutGraph(graph, catalogue);
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
    expect(layoutGraph(graph, catalogue)).toEqual(layoutGraph(graph, catalogue));
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
    const positions = layoutGraph(graph, catalogue);
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
    const positions = layoutGraph(graph, catalogue);
    expect(Object.keys(positions)).toHaveLength(3);
    expect(positions["gen"]!.x).toBeLessThan(positions["fb"]!.x);
  });

  it("respects document node sizes for spacing (§V116)", () => {
    const graph = graphOf(
      [node("big", { x: 0, y: 0 }, { width: 400, height: 300 }), node("next")],
      [["big", "next"]],
    );
    const positions = layoutGraph(graph, catalogue);
    expect(positions["next"]!.x - positions["big"]!.x).toBeGreaterThanOrEqual(400);
  });

  it("moves only the requested nodes when restricted", () => {
    const graph = graphOf([node("a"), node("b")], [["a", "b"]]);
    const positions = layoutGraph(graph, catalogue, { only: new Set(["b" as NodeId]) });
    expect(positions["a"]).toBeUndefined();
    expect(positions["b"]).toBeDefined();
  });
});

/**
 * B84 — THE SIZE MODEL IS `node-box.ts`, AND THESE ARE THE NUMBERS.
 *
 * The old guess was 180 wide and 100 tall for every unsized node. A `solid` is 178×147:
 * it renders a 16:9 preview tile and a port row. So the vertical pitch the guess produced
 * was 140 where 187 is right — **47px of interpenetration on every stacked pair**, on a
 * layout whose entire job is to not do that. Exact values, not "greater than", because a
 * second size model reintroduced anywhere lands on different exact values (§V189).
 */
describe("B84 — layout sizes nodes through `node-box`, not a second guess", () => {
  it("stacks a column at the measured height plus the row gap, not at 100 + gap", () => {
    // No edges: both are sources, so they share rank 0 and stack in one column.
    const graph = graphOf([node("a", { x: 0, y: 0 }, undefined, "solid"), node("b", { x: 0, y: 0 }, undefined, "solid")], []);
    const positions = layoutGraph(graph, catalogue);

    expect(nodeBox(graph.nodes["a"]!, catalogue.get("solid")).height).toBe(147);
    expect(positions["b"]!.y - positions["a"]!.y).toBe(147 + 40);
    // The number the old model would have produced, named so the regression is unmistakable.
    expect(positions["b"]!.y - positions["a"]!.y).not.toBe(100 + 40);
  });

  it("advances a column by the measured width plus the column gap, not by 180 + gap", () => {
    const graph = graphOf(
      [node("a", { x: 0, y: 0 }, undefined, "solid"), node("b", { x: 0, y: 0 }, undefined, "blur")],
      [["a", "b"]],
    );
    const positions = layoutGraph(graph, catalogue);
    expect(positions["b"]!.x - positions["a"]!.x).toBe(178 + 80);
    expect(positions["b"]!.x - positions["a"]!.x).not.toBe(180 + 80);
  });

  it("counts the port rows a node actually renders — an `add` is taller than a `blur`", () => {
    // Not decoration: `add` takes two inputs, `blur` one, and the row is 14px + 2px gap.
    // A layout blind to that stacks them as if they were the same node.
    const graph = graphOf([node("a", { x: 0, y: 0 }, undefined, "add"), node("b", { x: 0, y: 0 }, undefined, "add")], []);
    const positions = layoutGraph(graph, catalogue);
    expect(positions["b"]!.y - positions["a"]!.y).toBe(163 + 40);
  });

  /**
   * The end-to-end statement, and the one that would have caught B84 without knowing any
   * of the numbers above: a graph this function laid out must pass the gate every SHIPPED
   * example passes (`src/examples/layout.test.ts`). An auto-layout that produces a graph
   * the example gate would reject is not a layout.
   */
  it("produces a graph that clears the example gate's overlap and gutter rules (§V389)", () => {
    // Two sources on purpose: a pure chain puts every node in its own column and never
    // exercises the ROW pitch, which is the axis the old size guess was wrong on. `n6`
    // shares rank 0 with `n0`, so column 0 stacks and the vertical gutter is measured.
    const types = ["noise", "level", "threshold", "blur", "add", "output", "noise"];
    const graph = graphOf(
      types.map((type, index) => node(`n${String(index)}`, { x: 0, y: 0 }, undefined, type)),
      [
        ["n0", "n1"],
        ["n1", "n2"],
        ["n2", "n3"],
        ["n3", "n4"],
        ["n1", "n4"], // the bloom shape: the bright chain rejoins the untouched source
        ["n4", "n5"],
        ["n6", "n1"],
      ],
    );
    const positions = layoutGraph(graph, catalogue);
    const boxes = Object.entries(positions).map(([nodeId, position]) =>
      nodeBox({ ...graph.nodes[nodeId]!, position }, catalogue.get(graph.nodes[nodeId]!.type)),
    );

    expect(boxes).toHaveLength(types.length);
    // Non-vacuity for the axis that matters: at least one PAIR really is stacked, so the
    // vertical rule below is exercised rather than trivially satisfied by column pitch.
    expect(positions["n0"]!.x).toBe(positions["n6"]!.x);
    expect(positions["n0"]!.y).not.toBe(positions["n6"]!.y);
    for (let i = 0; i < boxes.length; i += 1) {
      for (let j = i + 1; j < boxes.length; j += 1) {
        const a = boxes[i]!;
        const b = boxes[j]!;
        const gap = boxGap(a, b);
        expect(boxesOverlap(a, b), `boxes ${String(i)} and ${String(j)} overlap`).toBe(false);
        expect(
          gap.x >= MIN_LAYOUT_COLUMN_GAP || gap.y >= MIN_LAYOUT_ROW_GAP,
          `boxes ${String(i)} and ${String(j)} are ${String(gap.x)}×${String(gap.y)} apart`,
        ).toBe(true);
      }
    }
  });
});

describe("placeRelative (T280)", () => {
  it("places in reading direction, offset by the anchor's size", () => {
    const graph = graphOf([node("anchor", { x: 100, y: 50 }, { width: 200, height: 120 })], []);
    expect(placeRelative(graph, catalogue, "anchor" as NodeId, "right")).toEqual({ x: 380, y: 50 });
    expect(placeRelative(graph, catalogue, "anchor" as NodeId, "below")).toEqual({ x: 100, y: 210 });
    expect(placeRelative(graph, catalogue, "anchor" as NodeId, "left").x).toBeLessThan(100);
    expect(placeRelative(graph, catalogue, "missing" as NodeId)).toEqual({ x: 0, y: 0 });
  });
});
