import { beforeEach, describe, expect, it } from "vitest";

import type { GraphDocument } from "../types/graph.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import {
  compareEdgeOrder,
  incomingEdgesInOrder,
  parseHandleId,
  variadicHandleId,
} from "../graph/edge-order.ts";
import { operationClass, patchTouchedEntities } from "./patch-scope.ts";
import { alice, contextFor, createHarness, patch, type Harness } from "./test-support.ts";

/**
 * Variadic input ORDER (T225, §V131).
 *
 * The claim under test is not "edges can be sorted". It is that the order is a DOCUMENT
 * fact the user controls, rather than a side effect of which edge happened to be drawn
 * first — because for Over and Composite the layer order IS the operation, so an order
 * nobody chose is a wrong answer nobody can fix.
 */

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

const graph = (): GraphDocument => harness.store.view.getGraph();

async function apply(operations: GraphPatchOperation[], actor = alice) {
  return harness.bus.execute(
    "graph.applyPatch",
    patch(harness.store.view.getRevision(), operations),
    contextFor(actor),
  );
}

const solid = (ref: string, x = 0): GraphPatchOperation => ({
  op: "addNode",
  ref: ref as `$${string}`,
  type: "test.solid",
  position: { x, y: 0 },
});

/** Three solids into one variadic port, in the order a, b, c. Returns their edge ids. */
async function threeLayers(): Promise<{ comp: string; edges: string[] }> {
  const result = await apply([
    solid("$a"),
    solid("$b", 100),
    solid("$c", 200),
    { op: "addNode", ref: "$comp", type: "test.composite", position: { x: 400, y: 0 } },
    { op: "connect", ref: "$ea", ...wireBody("$a", "$comp") },
    { op: "connect", ref: "$eb", ...wireBody("$b", "$comp") },
    { op: "connect", ref: "$ec", ...wireBody("$c", "$comp") },
  ]);
  expect(result.status).toBe("applied");
  const ids = result.output?.createdIds ?? {};
  return {
    comp: ids["$comp"] as string,
    edges: [ids["$ea"] as string, ids["$eb"] as string, ids["$ec"] as string],
  };
}

function wireBody(from: string, to: string) {
  return {
    source: { nodeId: from as `$${string}`, portId: "out" },
    target: { nodeId: to as `$${string}`, portId: "layers" },
  } as const;
}

const orderOf = (edgeId: string): number | undefined => graph().edges[edgeId]?.order;

describe("variadic input order (T225, §V131)", () => {
  it("appends each new edge to the end of the port rather than renumbering the others", async () => {
    // The only placement that does not reinterpret the layers already wired. Inserting a
    // new layer at the front — or anywhere derived from ids — would silently change what
    // an existing composite renders the moment someone adds a fourth input.
    const { edges } = await threeLayers();
    expect(edges.map(orderOf)).toEqual([0, 1, 2]);
  });

  it("gives an ordinary input port no order at all", async () => {
    // A number that means nothing is worse than no number: it would show up in every
    // saved document and invite code to read an order where there is no choice to make.
    const result = await apply([
      solid("$a"),
      { op: "addNode", ref: "$blur", type: "test.blur", position: { x: 200, y: 0 } },
      { op: "connect", ref: "$e", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$blur", portId: "source" } },
    ]);
    const edgeId = result.output?.createdIds["$e"] as string;
    expect(graph().edges[edgeId]?.order).toBeUndefined();
  });

  it("keeps the user's order when it disagrees with creation order", async () => {
    // The whole point of the field. After a reorder the edge IDS still sort in creation
    // order — nothing about identity changed — and the document's answer is the one that
    // counts. If this ever falls back to id order, a rewired composite renders the layers
    // in the order they were drawn, which is precisely the bug §V131 exists to prevent.
    const { comp, edges } = await threeLayers();
    const [a, b, c] = edges;
    const result = await apply([
      { op: "reorderEdges", nodeId: comp, portId: "layers", edgeIds: [c as string, a as string, b as string] },
    ]);
    expect(result.status).toBe("applied");

    expect([orderOf(c as string), orderOf(a as string), orderOf(b as string)]).toEqual([0, 1, 2]);
    expect(incomingEdgesInOrder(graph(), comp, "layers").map((edge) => edge.id)).toEqual([c, a, b]);
    // Identity is untouched: sorted by id these are still a, b, c.
    expect([...edges].sort()).toEqual(edges);
  });

  it("refuses a reorder that does not name exactly the port's edges", async () => {
    // A caller working from a stale reading is describing a graph that no longer exists.
    // Reconciling — appending the edges it forgot, ignoring the ones it invented — would
    // produce an order nobody asked for, and the caller would never learn it was wrong.
    const { comp, edges } = await threeLayers();
    const before = edges.map(orderOf);

    const short = await apply([
      { op: "reorderEdges", nodeId: comp, portId: "layers", edgeIds: [edges[1] as string, edges[0] as string] },
    ]);
    expect(short.status).toBe("rejected");
    expect(short.diagnostics[0]?.code).toBe("edge.orderMismatch");

    const duplicated = await apply([
      { op: "reorderEdges", nodeId: comp, portId: "layers", edgeIds: [edges[0] as string, edges[0] as string, edges[1] as string] },
    ]);
    expect(duplicated.status).toBe("rejected");

    // §V32: a rejected patch leaves the document byte-identical.
    expect(edges.map(orderOf)).toEqual(before);
  });

  it("compacts the survivors when an edge is removed, so the next connect lands last", async () => {
    // Not cosmetic. `connect` appends at the port's current COUNT, so a gap would hand the
    // next layer a position another edge still holds — two layers claiming to be third,
    // resolved by an id tiebreak nobody chose. Densities also keep the index the UI shows
    // (T227) honest: "input 2" with no input 1 is a bug report waiting to happen.
    const { comp, edges } = await threeLayers();
    const [a, b, c] = edges;

    await apply([{ op: "disconnect", edgeIds: [b as string] }]);
    expect([orderOf(a as string), orderOf(c as string)]).toEqual([0, 1]);

    const added = await apply([
      solid("$d", 300),
      { op: "connect", ref: "$ed", source: { nodeId: "$d", portId: "out" }, target: { nodeId: comp, portId: "layers" } },
    ]);
    const d = added.output?.createdIds["$ed"] as string;
    expect(orderOf(d)).toBe(2);
    expect(incomingEdgesInOrder(graph(), comp, "layers").map((edge) => edge.id)).toEqual([a, c, d]);
  });

  it("compacts when the node upstream of one layer is deleted (§V40)", async () => {
    // The cascade deletes the edge; the port it fed is still there and still ordered.
    const { edges } = await threeLayers();
    const [a, b, c] = edges;
    const sourceOfA = graph().edges[a as string]?.source.nodeId as string;

    await apply([{ op: "removeNodes", nodeIds: [sourceOfA] }]);
    expect(graph().edges[a as string]).toBeUndefined();
    expect([orderOf(b as string), orderOf(c as string)]).toEqual([0, 1]);
  });

  it("refuses to order a port that takes one edge", async () => {
    // "Which is first" is not a question an ordinary port has an answer to, and accepting
    // the operation would write a number the compiler is right to ignore.
    const result = await apply([
      solid("$a"),
      { op: "addNode", ref: "$blur", type: "test.blur", position: { x: 200, y: 0 } },
      { op: "connect", ref: "$e", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$blur", portId: "source" } },
    ]);
    const blur = result.output?.createdIds["$blur"] as string;
    const edgeId = result.output?.createdIds["$e"] as string;

    const rejected = await apply([
      { op: "reorderEdges", nodeId: blur, portId: "source", edgeIds: [edgeId] },
    ]);
    expect(rejected.status).toBe("rejected");
    expect(rejected.diagnostics[0]?.code).toBe("port.notVariadic");
  });
});

describe("a connection dropped on an occupied socket (T695)", () => {
  it("replaces the layer in that socket IN PLACE, leaving the count and the others alone", async () => {
    // The two halves are one claim and neither survives alone. A patch that only got the
    // COUNT right is an append with an extra delete: three layers in, three layers out,
    // and the user's new wire sitting at the bottom of a stack they aimed at the middle
    // of. A patch that only got the ORDER right would have dropped or duplicated a layer.
    const { comp, edges } = await threeLayers();
    const [a, b, c] = edges;

    const result = await apply([
      solid("$d", 300),
      { op: "disconnect", edgeIds: [b as string] },
      {
        op: "connect",
        ref: "$ed",
        source: { nodeId: "$d", portId: "out" },
        target: { nodeId: comp, portId: "layers" },
        // The socket the user released over. Without it the disconnect above compacts
        // a and c to 0 and 1 and this appends at 2.
        order: 1,
      },
    ]);
    expect(result.status).toBe("applied");
    const d = result.output?.createdIds["$ed"] as string;

    const after = incomingEdgesInOrder(graph(), comp, "layers");
    expect(after).toHaveLength(3);
    expect(after.map((edge) => edge.id)).toEqual([a, d, c]);
    // Dense, so the next drop resolves to the socket the user can see (T225).
    expect(after.map((edge) => edge.order)).toEqual([0, 1, 2]);
    expect(graph().edges[b as string]).toBeUndefined();
  });

  it("appends when the socket named is the empty one past the end", async () => {
    // The spare socket is the append gesture, and it resolves to no edge — so the drop
    // arrives with no order at all and lands where a new layer belongs. Naming a slot
    // that no longer exists is clamped the same way rather than refused: the user has
    // already released the pointer, and an off-by-one they cannot see is not their bug.
    const { comp, edges } = await threeLayers();
    const result = await apply([
      solid("$d", 300),
      { op: "connect", ref: "$ed", source: { nodeId: "$d", portId: "out" }, target: { nodeId: comp, portId: "layers" }, order: 9 },
    ]);
    const d = result.output?.createdIds["$ed"] as string;
    expect(incomingEdgesInOrder(graph(), comp, "layers").map((edge) => edge.id)).toEqual([
      ...edges,
      d,
    ]);
    expect(orderOf(d)).toBe(3);
  });

  it("takes the FIRST socket when that is the one aimed at", async () => {
    // Order 0 is the boundary the half-step placement has to get right: there is no
    // edge below it to sort against, so a naive "insert before" that clamped at zero
    // would tie with the layer already there and let the id tiebreak decide.
    const { comp, edges } = await threeLayers();
    const [a, b, c] = edges;
    const result = await apply([
      solid("$d", 300),
      { op: "disconnect", edgeIds: [a as string] },
      { op: "connect", ref: "$ed", source: { nodeId: "$d", portId: "out" }, target: { nodeId: comp, portId: "layers" }, order: 0 },
    ]);
    const d = result.output?.createdIds["$ed"] as string;
    expect(incomingEdgesInOrder(graph(), comp, "layers").map((edge) => edge.id)).toEqual([d, b, c]);
  });
});

describe("socket identity (T695)", () => {
  it("round-trips a port through its handle id, and leaves a plain port id alone", () => {
    // Every handle id in the editor goes through `parseHandleId`, including the plain
    // ones — an ordinary port and every output still carry their bare id, and a parser
    // that mangled those would refuse every non-variadic connection in the app.
    expect(parseHandleId(variadicHandleId("in2", 0))).toEqual({ portId: "in2", slot: 0 });
    expect(parseHandleId(variadicHandleId("layers", 12))).toEqual({ portId: "layers", slot: 12 });
    expect(parseHandleId("in2")).toEqual({ portId: "in2", slot: undefined });
    // Not a slot: no digits. The port keeps its whole name rather than being truncated
    // to something the registry would answer `undefined` for.
    expect(parseHandleId("odd#name")).toEqual({ portId: "odd#name", slot: undefined });
  });
});

describe("edge order as a shared rule", () => {
  it("sorts an edge with no order last, which is how old documents keep compiling", () => {
    // §V68: the field is additive. Every edge in a document written before it existed
    // falls through to the id comparison — exactly the order the compiler used then — and
    // an edge minted by a path that does not assign one appends instead of displacing
    // layers someone deliberately arranged.
    const ordered = [
      { id: "e-z", order: 0 },
      { id: "e-a" },
      { id: "e-m", order: 1 },
      { id: "e-b" },
    ].sort(compareEdgeOrder);
    expect(ordered.map((edge) => edge.id)).toEqual(["e-z", "e-m", "e-a", "e-b"]);
  });

  it("breaks a tie by id so every actor computes the same order (§V40)", () => {
    // Two edges claiming one position cannot come out of the patch layer, but a
    // hand-edited document can say it. Deterministic beats correct-looking here.
    const ordered = [
      { id: "e-b", order: 1 },
      { id: "e-a", order: 1 },
    ].sort(compareEdgeOrder);
    expect(ordered.map((edge) => edge.id)).toEqual(["e-a", "e-b"]);
  });
});

describe("reorder in the conflict model (§V33)", () => {
  it("is structural and contends with everything else on that port", async () => {
    // It creates and destroys nothing, but it ASSERTS what the port contains: a reorder
    // computed against three layers must not land on four. Classified as a value edit it
    // would sail past a concurrent connect and rearrange a graph the caller never saw.
    const { comp, edges } = await threeLayers();
    const operation: GraphPatchOperation = {
      op: "reorderEdges",
      nodeId: comp,
      portId: "layers",
      edgeIds: [edges[2] as string, edges[1] as string, edges[0] as string],
    };
    expect(operationClass(operation)).toBe("structural");

    const touched = patchTouchedEntities([operation], graph());
    for (const edgeId of edges) expect(touched).toContain(`edge:${edgeId}`);
    expect(touched).toContain(`node:${comp}`);
  });
});
