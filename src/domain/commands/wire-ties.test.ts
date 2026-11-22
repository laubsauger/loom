import { beforeEach, describe, expect, it } from "vitest";

import type { GraphDocument } from "../types/graph.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import { operationClass } from "./patch-scope.ts";
import { REROUTE_EDGE_COMMAND } from "./wire-tie-commands.ts";
import { alice, contextFor, createHarness, patch, type Harness } from "./test-support.ts";

/**
 * Wire ties (T1821b, §V1040, docs/wire-ties-design-2026-11-21.md).
 *
 * A tie is a point wires are routed through. What the person relies on, and what each test
 * pins: a route is document state that undoes as one step with the gesture that made it; a
 * tie lives exactly as long as a wire passes it; removing one never disconnects anything;
 * several wires can share one; and a wrong route is refused rather than half-written.
 */

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

const graph = (): GraphDocument => harness.store.view.getGraph();

async function apply(operations: GraphPatchOperation[]) {
  return harness.bus.execute("graph.applyPatch", patch(harness.store.view.getRevision(), operations), contextFor(alice));
}

const undo = () => harness.bus.execute("graph.undo", {}, contextFor(alice));
const redo = () => harness.bus.execute("graph.redo", {}, contextFor(alice));

/** Two solids, each wired into its own blur: two wires, `$ea` and `$eb`. */
async function twoWires(): Promise<{ ea: string; eb: string; a: string; blurA: string }> {
  const result = await apply([
    { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$b", type: "test.solid", position: { x: 0, y: 300 } },
    { op: "addNode", ref: "$blurA", type: "test.blur", position: { x: 600, y: 0 } },
    { op: "addNode", ref: "$blurB", type: "test.blur", position: { x: 600, y: 300 } },
    { op: "connect", ref: "$ea", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$blurA", portId: "source" } },
    { op: "connect", ref: "$eb", source: { nodeId: "$b", portId: "out" }, target: { nodeId: "$blurB", portId: "source" } },
  ]);
  expect(result.status).toBe("applied");
  const ids = result.output.createdIds;
  return { ea: ids["$ea"] as string, eb: ids["$eb"] as string, a: ids["$a"] as string, blurA: ids["$blurA"] as string };
}

describe("a tie on a wire (§V1040)", () => {
  it("routes the wire through it, and one undo takes tie and route away together", async () => {
    const { ea } = await twoWires();
    const result = await apply([
      { op: "addTie", ref: "$t", position: { x: 300, y: 150 } },
      { op: "setEdgeVia", edgeId: ea, via: ["$t"] },
    ]);
    expect(result.status).toBe("applied");
    const tieId = result.output.createdIds["$t"] as string;
    expect(graph().ties?.[tieId]?.position).toEqual({ x: 300, y: 150 });
    expect(graph().edges[ea]?.via).toEqual([tieId]);

    expect((await undo()).status).toBe("applied");
    expect(graph().ties).toBeUndefined();
    expect(graph().edges[ea]?.via).toBeUndefined();
    expect((await redo()).status).toBe("applied");
    expect(graph().edges[ea]?.via).toEqual([tieId]);
    expect(graph().ties?.[tieId]?.position).toEqual({ x: 300, y: 150 });
  });

  it("does not keep a tie no wire passes, and says so", async () => {
    await twoWires();
    const result = await apply([{ op: "addTie", ref: "$t", position: { x: 1, y: 2 } }]);
    expect(result.status).toBe("applied");
    expect(graph().ties).toBeUndefined();
    expect(result.output.diagnostics.map((diagnostic) => diagnostic.code)).toContain("tie.unused");
  });

  it("goes with the last wire through it, and comes back with it on undo", async () => {
    const { ea } = await twoWires();
    const tied = await apply([
      { op: "addTie", ref: "$t", position: { x: 300, y: 150 } },
      { op: "setEdgeVia", edgeId: ea, via: ["$t"] },
    ]);
    const tieId = tied.output.createdIds["$t"] as string;
    await apply([{ op: "disconnect", edgeIds: [ea] }]);
    expect(graph().ties).toBeUndefined();
    await undo();
    expect(graph().edges[ea]?.via).toEqual([tieId]);
    expect(graph().ties?.[tieId]).toBeDefined();
  });

  it("removing a tie releases its wires and disconnects nothing", async () => {
    const { ea, eb } = await twoWires();
    const tied = await apply([
      { op: "addTie", ref: "$t", position: { x: 300, y: 150 } },
      { op: "setEdgeVia", edgeId: ea, via: ["$t"] },
      { op: "setEdgeVia", edgeId: eb, via: ["$t"] },
    ]);
    const tieId = tied.output.createdIds["$t"] as string;
    const before = graph().edges;
    expect((await apply([{ op: "removeTies", tieIds: [tieId] }])).status).toBe("applied");
    expect(graph().ties).toBeUndefined();
    for (const edgeId of [ea, eb]) {
      expect(graph().edges[edgeId]?.via).toBeUndefined();
      expect(graph().edges[edgeId]?.source).toEqual(before[edgeId]?.source);
      expect(graph().edges[edgeId]?.target).toEqual(before[edgeId]?.target);
    }
  });

  it("moves as a layout edit, like a node", async () => {
    const { ea } = await twoWires();
    const tied = await apply([
      { op: "addTie", ref: "$t", position: { x: 300, y: 150 } },
      { op: "setEdgeVia", edgeId: ea, via: ["$t"] },
    ]);
    const tieId = tied.output.createdIds["$t"] as string;
    const moved = await apply([{ op: "moveTies", positions: { [tieId]: { x: 320, y: 90 } } }]);
    expect(moved.status).toBe("applied");
    expect(graph().ties?.[tieId]?.position).toEqual({ x: 320, y: 90 });
    expect(operationClass({ op: "moveTies", positions: {} })).toBe("value");
    await undo();
    expect(graph().ties?.[tieId]?.position).toEqual({ x: 300, y: 150 });
  });

  it("refuses a route through a tie that is not there, or through one tie twice, and writes nothing", async () => {
    const { ea } = await twoWires();
    const revision = harness.store.view.getRevision();
    const missing = await apply([{ op: "setEdgeVia", edgeId: ea, via: ["ti_nowhere"] }]);
    expect(missing.status).toBe("rejected");
    expect(missing.diagnostics.map((diagnostic) => diagnostic.code)).toContain("tie.missing");
    const twice = await apply([
      { op: "addTie", ref: "$t", position: { x: 0, y: 0 } },
      { op: "setEdgeVia", edgeId: ea, via: ["$t", "$t"] },
    ]);
    expect(twice.status).toBe("rejected");
    expect(twice.diagnostics.map((diagnostic) => diagnostic.code)).toContain("tie.repeated");
    expect(harness.store.view.getRevision()).toBe(revision);
    expect(graph().ties).toBeUndefined();
  });

  it("lets a wire be born routed, which is how a splice keeps its route", async () => {
    const { a, blurA, ea } = await twoWires();
    const result = await apply([
      { op: "disconnect", edgeIds: [ea] },
      { op: "addTie", ref: "$t", position: { x: 300, y: 50 } },
      { op: "connect", ref: "$e", source: { nodeId: a, portId: "out" }, target: { nodeId: blurA, portId: "source" }, via: ["$t"] },
    ]);
    expect(result.status).toBe("applied");
    const edgeId = result.output.createdIds["$e"] as string;
    expect(graph().edges[edgeId]?.via).toEqual([result.output.createdIds["$t"]]);
  });
});

describe("graph.rerouteEdge — the door the edge menu and the double-click share", () => {
  it("puts a new tie on a wire, as one undo step", async () => {
    const { ea } = await twoWires();
    const result = await harness.bus.execute(REROUTE_EDGE_COMMAND, { edgeIds: [ea], position: { x: 300, y: 40 } }, contextFor(alice));
    expect(result.status).toBe("applied");
    const tieId = result.output.createdIds["$tie"] as string;
    expect(graph().edges[ea]?.via).toEqual([tieId]);
    await undo();
    expect(graph().ties).toBeUndefined();
  });

  it("binds two wires from different outputs into one tie — the zip tie", async () => {
    const { ea, eb } = await twoWires();
    const made = await harness.bus.execute(REROUTE_EDGE_COMMAND, { edgeIds: [ea], position: { x: 300, y: 150 } }, contextFor(alice));
    const tieId = made.output.createdIds["$tie"] as string;
    const joined = await harness.bus.execute(REROUTE_EDGE_COMMAND, { edgeIds: [eb], tieId }, contextFor(alice));
    expect(joined.status).toBe("applied");
    expect(graph().edges[ea]?.via).toEqual([tieId]);
    expect(graph().edges[eb]?.via).toEqual([tieId]);
    expect(Object.keys(graph().ties ?? {})).toEqual([tieId]);
  });

  it("places a second tie where it lengthens the route least, or where the canvas says", async () => {
    const { ea } = await twoWires();
    // The wire runs from x≈178 to x=600. A tie near the input end, then one near the output.
    const late = await harness.bus.execute(REROUTE_EDGE_COMMAND, { edgeIds: [ea], position: { x: 500, y: 40 } }, contextFor(alice));
    const lateId = late.output.createdIds["$tie"] as string;
    const early = await harness.bus.execute(REROUTE_EDGE_COMMAND, { edgeIds: [ea], position: { x: 250, y: 40 } }, contextFor(alice));
    const earlyId = early.output.createdIds["$tie"] as string;
    expect(graph().edges[ea]?.via).toEqual([earlyId, lateId]);
    // The canvas knows which leg was double-clicked and says so: index 2 = after both.
    const placed = await harness.bus.execute(REROUTE_EDGE_COMMAND, { edgeIds: [ea], position: { x: 250, y: 90 }, index: 2 }, contextFor(alice));
    expect(graph().edges[ea]?.via).toEqual([earlyId, lateId, placed.output.createdIds["$tie"]]);
  });

  it("refuses an ambiguous or stale request by name", async () => {
    const { ea, eb } = await twoWires();
    const both = await harness.bus.execute(REROUTE_EDGE_COMMAND, { edgeIds: [ea], position: { x: 0, y: 0 }, tieId: "ti_x" }, contextFor(alice));
    expect(both.diagnostics[0]?.code).toBe("tie.target");
    const indexed = await harness.bus.execute(REROUTE_EDGE_COMMAND, { edgeIds: [ea, eb], position: { x: 0, y: 0 }, index: 0 }, contextFor(alice));
    expect(indexed.diagnostics[0]?.code).toBe("tie.index");
    const stale = await harness.bus.execute(REROUTE_EDGE_COMMAND, { edgeIds: ["ed_gone"], position: { x: 0, y: 0 } }, contextFor(alice));
    expect(stale.diagnostics[0]?.code).toBe("edge.missing");
  });
});
