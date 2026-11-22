import { describe, expect, it } from "vitest";
import type { GraphDocument } from "@domain/types/graph.ts";
import { joinTieOperations, mergeTiesOperations, moveTieOperations, splitRoute } from "./tie-gestures.ts";

/**
 * The tie gestures' meanings in the cases the composed canvas test does not reach
 * (T1821b): a wire already through BOTH ties of a merge, a join on a later leg, a drop that
 * moved nothing, and the split of a route under a splice. The gestures themselves run end to
 * end in `tests/integration/wire-ties-canvas.test.tsx`.
 */

function graph(): GraphDocument {
  const end = (nodeId: string) => ({ nodeId, portId: "out" });
  return {
    revision: 1,
    nodes: {},
    edges: {
      both: { id: "both", source: end("a"), target: end("b"), via: ["t1", "t2", "t3"] },
      one: { id: "one", source: end("c"), target: end("d"), via: ["t1"] },
      none: { id: "none", source: end("e"), target: end("f") },
    },
    groups: {},
    ties: {
      t1: { id: "t1", position: { x: 0, y: 0 } },
      t2: { id: "t2", position: { x: 100, y: 0 } },
      t3: { id: "t3", position: { x: 200, y: 0 } },
    },
  };
}

describe("tie gestures (T1821b)", () => {
  it("merges a tie into another without routing a wire through the same tie twice", () => {
    const operations = mergeTiesOperations(graph(), "t1", "t3");
    expect(operations).toEqual([
      // Already through t3: it simply loses t1, keeping its place at t3.
      { op: "setEdgeVia", edgeId: "both", via: ["t2", "t3"] },
      // Through t1 only: it now passes t3 where it passed t1.
      { op: "setEdgeVia", edgeId: "one", via: ["t3"] },
      { op: "removeTies", tieIds: ["t1"] },
    ]);
    expect(mergeTiesOperations(graph(), "t1", "t1")).toEqual([]);
  });

  it("joins a wire to a tie at the leg it was dropped on, and moves the tie there", () => {
    expect(joinTieOperations(graph(), "t2", "one", 1, { x: 5, y: 6 })).toEqual([
      { op: "moveTies", positions: { t2: { x: 5, y: 6 } } },
      { op: "setEdgeVia", edgeId: "one", via: ["t1", "t2"] },
    ]);
    // A wire already through it is not routed twice; the drop only moves the tie.
    expect(joinTieOperations(graph(), "t2", "both", 0, { x: 5, y: 6 })).toEqual([
      { op: "moveTies", positions: { t2: { x: 5, y: 6 } } },
    ]);
  });

  it("writes nothing for a drop where the tie already was", () => {
    expect(moveTieOperations(graph(), "t1", { x: 0, y: 0 })).toEqual([]);
  });

  it("splits a route at the spliced leg: earlier ties upstream, the rest downstream", () => {
    const edge = graph().edges["both"];
    if (edge === undefined) throw new Error("fixture");
    expect(splitRoute(edge, 0)).toEqual({ upstream: [], downstream: ["t1", "t2", "t3"] });
    expect(splitRoute(edge, 2)).toEqual({ upstream: ["t1", "t2"], downstream: ["t3"] });
    expect(splitRoute(edge, 3)).toEqual({ upstream: ["t1", "t2", "t3"], downstream: [] });
  });
});
