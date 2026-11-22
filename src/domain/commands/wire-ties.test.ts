import { beforeEach, describe, expect, it } from "vitest";

import { createTestRegistry } from "../../nodes/registry/test-nodes.ts";
import { createComponentHarness, graphOf, node } from "../components/test-support.ts";
import { NODE_WIDTH } from "../graph/node-box.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import type { GraphDocument, GraphEdge } from "../types/graph.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import { createDomainBus } from "./index.ts";
import type { SystemClipboard } from "./loom-clipboard.ts";
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

/** The wire from `source` to `target`, which every copy re-mints under a new id. */
function wireBetween(document: GraphDocument, source: string, target: string): GraphEdge | undefined {
  return Object.values(document.edges).find((edge) => edge.source.nodeId === source && edge.target.nodeId === target);
}

describe("T1821b(a) — a layout carries the ties on the wires it moves", () => {
  it("keeps a bundle tie halfway along both its wires, at the same depth beside them, in the layout's one undo step", async () => {
    // Two chains, each blur 400 to the right of its solid on the same row. A wire leaves its
    // solid's right edge, so the point halfway along either wire, and the line straight
    // below it, is x = (178 + 400) / 2 = 289: the tie there, 110 below the first wire and
    // 190 above the second, is HALFWAY along both. The layout restacks both chains.
    const halfway = (NODE_WIDTH + 400) / 2;
    const seeded = await apply([
      { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 400, y: 0 } },
      { op: "addNode", ref: "$c", type: "test.solid", position: { x: 0, y: 300 } },
      { op: "addNode", ref: "$d", type: "test.blur", position: { x: 400, y: 300 } },
      { op: "addTie", ref: "$t", position: { x: halfway, y: 150 } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b", portId: "source" }, via: ["$t"] },
      { op: "connect", source: { nodeId: "$c", portId: "out" }, target: { nodeId: "$d", portId: "source" }, via: ["$t"] },
    ]);
    const ids = seeded.output.createdIds;
    const tieId = ids["$t"] as string;
    const nodeIds = ["$a", "$b", "$c", "$d"].map((ref) => ids[ref] as string);
    const before = nodeIds.map((nodeId) => ({ ...(graph().nodes[nodeId]?.position as { x: number; y: number }) }));
    const actor = harness.store.view.getHistory(alice).undo.length;

    const laidOut = await harness.bus.execute("graph.layoutAll", {}, contextFor(alice));
    expect(laidOut.status).toBe("applied");

    // Each end of each wire moved by its own amount; the tie, halfway along both wires,
    // moved by the mean of the four — so it is still halfway along each, as deep as it was.
    const moves = nodeIds.map((nodeId, index) => ({
      x: (graph().nodes[nodeId]?.position.x as number) - (before[index]?.x as number),
      y: (graph().nodes[nodeId]?.position.y as number) - (before[index]?.y as number),
    }));
    expect(moves.some((move) => move.x !== 0 || move.y !== 0), "the layout moved nothing").toBe(true);
    const mean = { x: moves.reduce((sum, move) => sum + move.x, 0) / 4, y: moves.reduce((sum, move) => sum + move.y, 0) / 4 };
    expect(graph().ties?.[tieId]?.position).toEqual({ x: halfway + mean.x, y: 150 + mean.y });
    // Still one tie, both wires through it.
    expect(Object.values(graph().edges).map((edge) => edge.via)).toEqual([[tieId], [tieId]]);

    // One Cmd+Z puts the nodes AND the tie back.
    expect(harness.store.view.getHistory(alice).undo.length).toBe(actor + 1);
    await undo();
    expect(graph().ties?.[tieId]?.position).toEqual({ x: halfway, y: 150 });
    expect(graph().nodes[nodeIds[0] as string]?.position).toEqual(before[0]);
  });
});

describe("T1821b(b) — a copy keeps the routes of the wires it copies", () => {
  /** solid → blur through `$t`; a second solid → blur through the same tie; one more wire out of the copy. */
  async function routed() {
    const seeded = await apply([
      { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 600, y: 0 } },
      { op: "addNode", ref: "$c", type: "test.solid", position: { x: 0, y: 300 } },
      { op: "addNode", ref: "$d", type: "test.blur", position: { x: 600, y: 300 } },
      { op: "addTie", ref: "$t", position: { x: 300, y: 150 } },
      { op: "addTie", ref: "$u", position: { x: 450, y: -60 } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b", portId: "source" }, via: ["$t", "$u"] },
      { op: "connect", source: { nodeId: "$c", portId: "out" }, target: { nodeId: "$d", portId: "source" }, via: ["$t"] },
    ]);
    const ids = seeded.output.createdIds;
    return { a: ids["$a"] as string, b: ids["$b"] as string, t: ids["$t"] as string, u: ids["$u"] as string };
  }

  /** The copy of a → b made at offset (20, 40): its route, and where its ties are. */
  function copiedRoute(document: GraphDocument) {
    const at = (x: number, y: number) => Object.values(document.nodes).find((each) => each.position.x === x && each.position.y === y)?.id;
    const copyA = at(20, 40);
    const copyB = at(620, 40);
    const wire = copyA === undefined || copyB === undefined ? undefined : wireBetween(document, copyA, copyB);
    return {
      via: wire?.via,
      positions: (wire?.via ?? []).map((tieId) => document.ties?.[tieId]?.position),
    };
  }

  it("duplicates a routed wire through NEW ties, offset like the nodes, and leaves the originals' ties carrying what they carried", async () => {
    const originals = await routed();
    const before = harness.store.view.getHistory(alice).undo.length;
    const result = await harness.bus.execute("graph.duplicateSelection", { nodeIds: [originals.a, originals.b], offset: { x: 20, y: 40 } }, contextFor(alice));
    expect(result.status).toBe("applied");

    const copy = copiedRoute(graph());
    expect(copy.positions).toEqual([{ x: 320, y: 190 }, { x: 470, y: -20 }]);
    expect(copy.via).toHaveLength(2);
    expect(copy.via).not.toContain(originals.t);
    expect(copy.via).not.toContain(originals.u);
    // The original wires still run through the original ties, where they were.
    expect(wireBetween(graph(), originals.a, originals.b)?.via).toEqual([originals.t, originals.u]);
    expect(graph().ties?.[originals.t]?.position).toEqual({ x: 300, y: 150 });
    // The copy and its route are one undo step.
    expect(harness.store.view.getHistory(alice).undo.length).toBe(before + 1);
    await undo();
    expect(Object.keys(graph().ties ?? {}).sort()).toEqual([originals.t, originals.u].sort());
  });

  it("pastes a copied route, and a second paste makes its own ties", async () => {
    const originals = await routed();
    await harness.bus.execute("graph.copySelection", { nodeIds: [originals.a, originals.b] }, contextFor(alice));
    const pasted = await harness.bus.execute("graph.paste", { offset: { x: 20, y: 40 } }, contextFor(alice));
    expect(pasted.status).toBe("applied");
    expect(copiedRoute(graph()).positions).toEqual([{ x: 320, y: 190 }, { x: 470, y: -20 }]);
    const tiesAfterOne = Object.keys(graph().ties ?? {}).length;
    await harness.bus.execute("graph.paste", { offset: { x: 900, y: 900 } }, contextFor(alice));
    expect(Object.keys(graph().ties ?? {}).length).toBe(tiesAfterOne + 2);
  });

  it("carries the route through the SYSTEM clipboard into another window", async () => {
    const clip = { text: null as string | null, loom: null as string | null };
    const clipboard: SystemClipboard = {
      write(text, loom) {
        clip.text = text;
        clip.loom = loom ?? null;
      },
      read: async () => ({ text: clip.text, loom: clip.loom }),
    };
    const windowWith = (prefix: string) =>
      createDomainBus({ registry: createTestRegistry().view(), ids: createSequentialIdFactory(prefix), systemClipboard: clipboard }).bus;
    const first = windowWith("w1");
    const seeded = await first.execute(
      "graph.applyPatch",
      patch(first.store.getRevision(), [
        { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$b", type: "test.blur", position: { x: 600, y: 0 } },
        { op: "addTie", ref: "$t", position: { x: 300, y: 150 } },
        { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b", portId: "source" }, via: ["$t"] },
      ]),
      contextFor(alice),
    );
    const ids = seeded.output.createdIds;
    await first.execute("graph.copySelection", { nodeIds: [ids["$a"] as string, ids["$b"] as string] }, contextFor(alice));

    const second = windowWith("w2");
    const pasted = await second.execute("graph.paste", { offset: { x: 10, y: 10 } }, contextFor(alice));
    expect(pasted.status).toBe("applied");
    const [wire] = Object.values(second.store.getGraph().edges);
    expect(wire?.via).toHaveLength(1);
    expect(second.store.getGraph().ties?.[wire?.via?.[0] as string]?.position).toEqual({ x: 310, y: 160 });
  });
});

describe("T1821b(b) — save as component: inside routes go in, crossing routes stay outside", () => {
  it("takes an inside wire's tie into the component, keeps a crossing wire's tie on its outer half, and undoes as one step", async () => {
    const initial: GraphDocument = {
      ...graphOf(
        [
          node("ext", "test.solid", {}, { position: { x: 0, y: 0 } }),
          node("first", "test.blur", {}, { position: { x: 400, y: 0 } }),
          node("second", "test.blur", {}, { position: { x: 800, y: 0 } }),
          node("after", "test.blur", {}, { position: { x: 1200, y: 0 } }),
        ],
        {
          in: { id: "in", source: { nodeId: "ext", portId: "out" }, target: { nodeId: "first", portId: "source" }, via: ["ti_in"] },
          mid: { id: "mid", source: { nodeId: "first", portId: "out" }, target: { nodeId: "second", portId: "source" }, via: ["ti_mid"] },
          out: { id: "out", source: { nodeId: "second", portId: "out" }, target: { nodeId: "after", portId: "source" }, via: ["ti_out"] },
        },
      ),
      ties: {
        ti_in: { id: "ti_in", position: { x: 290, y: 200 } },
        ti_mid: { id: "ti_mid", position: { x: 690, y: -150 } },
        ti_out: { id: "ti_out", position: { x: 1090, y: 200 } },
      },
    };
    const components = createComponentHarness("s", initial);
    const saved = await components.bus.execute("component.saveSelection", { componentId: "tied", nodeIds: ["first", "second"], name: "Tied" }, contextFor(alice));
    expect(saved.status, saved.diagnostics?.map((diagnostic) => diagnostic.message).join("; ")).toBe("applied");
    const instance = saved.output.instanceNodeId as string;

    // Inside: the wire between the two saved nodes keeps its route, through a tie the
    // component's own graph holds where it was drawn.
    const definition = components.components.latest("tied");
    expect(definition?.graph.edges["mid"]?.via).toEqual(["ti_mid"]);
    expect(definition?.graph.ties).toEqual({ ti_mid: { id: "ti_mid", position: { x: 690, y: -150 } } });
    // The halves the In and Out made inside are unrouted.
    for (const edge of Object.values(definition?.graph.edges ?? {})) {
      if (edge.id !== "mid") expect(edge.via, edge.id).toBeUndefined();
    }

    // Outside: each crossing wire's route is on the wire that now meets the instance, and the
    // inside tie is gone from the parent (§V1040), the others where they were.
    const parent = components.store.view.getGraph();
    expect(wireBetween(parent, "ext", instance)?.via).toEqual(["ti_in"]);
    expect(wireBetween(parent, instance, "after")?.via).toEqual(["ti_out"]);
    expect(parent.ties).toEqual({ ti_in: initial.ties?.["ti_in"], ti_out: initial.ties?.["ti_out"] });

    await components.bus.execute("graph.undo", {}, contextFor(alice));
    const restored = components.store.view.getGraph();
    expect(restored.ties).toEqual(initial.ties);
    expect(restored.edges["mid"]?.via).toEqual(["ti_mid"]);
    expect(restored.edges["in"]?.via).toEqual(["ti_in"]);
  });
});
