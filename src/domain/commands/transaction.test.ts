import { beforeEach, describe, expect, it } from "vitest";

import type { GraphPatchOperation } from "../types/patch.ts";
import { agent, alice, contextFor, createHarness, patch, type Harness } from "./test-support.ts";

/**
 * T177 (§V34, §V42): a transaction is revertible as one unit, from the bus.
 *
 * "Undo everything that agent just did" was only answerable by an adapter that kept its
 * own ledger of which undo groups belonged to which transaction — state the store
 * already holds, copied into a place that cannot survive a reload and that an
 * out-of-process MCP server cannot build at all.
 */

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

const inTransaction = (transactionId: string, actor = agent) =>
  contextFor(actor, { transactionId });

const apply = async (
  operations: GraphPatchOperation[],
  options: { transactionId?: string; actor?: typeof alice; label?: string } = {},
) =>
  harness.bus.execute(
    "graph.applyPatch",
    patch(harness.store.view.getRevision(), operations, options.label),
    options.transactionId === undefined
      ? contextFor(options.actor ?? agent)
      : inTransaction(options.transactionId, options.actor ?? agent),
  );

const solid = (ref: string, x: number): GraphPatchOperation => ({
  op: "addNode",
  ref: ref as `$${string}`,
  type: "test.solid",
  position: { x, y: 0 },
});

const nodeCount = () => Object.keys(harness.store.view.getGraph().nodes).length;

describe("graph.history — transactionId (T177)", () => {
  it("reports which transaction each undo group belongs to", async () => {
    await apply([solid("$a", 0)], { transactionId: "txn-1", label: "First" });
    // A second patch in the same transaction with an explicit split: two groups, one id.
    await apply([solid("$b", 100)], { transactionId: "txn-1", label: "Second" });
    await apply([solid("$c", 200)], { label: "Loose" });

    const history = await harness.bus.query("graph.history", {}, contextFor(agent));
    expect(history.undo.map((group) => group.transactionId)).toEqual(["txn-1", null]);
    expect(history.undo.map((group) => group.label)).toEqual(["First", "Loose"]);
  });
});

describe("graph.revertTransaction (T177, §V34)", () => {
  it("restores exactly the operations of that transaction and nothing else", async () => {
    // A human edit first: it must survive the revert untouched (§V41).
    const human = await harness.bus.execute(
      "graph.applyPatch",
      patch(0, [solid("$h", -100)], "Human node"),
      contextFor(alice),
    );
    const humanNode = human.output.createdIds["$h"] as string;

    // An earlier agent transaction. It is below txn-1 on the stack and must be left
    // exactly where it is.
    const earlier = await apply([solid("$c", 200)], { transactionId: "txn-2" });
    const earlierNode = earlier.output.createdIds["$c"] as string;

    await apply([solid("$a", 0)], { transactionId: "txn-1" });
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.store.view.getRevision(), [solid("$b", 100)], "Second"),
      inTransaction("txn-1"),
    );
    const beforeRevert = nodeCount();

    const result = await harness.bus.execute(
      "graph.revertTransaction",
      { transactionId: "txn-1" },
      contextFor(agent),
    );

    expect(result.status).toBe("applied");
    expect(result.output.remainingGroupIds).toEqual([]);
    expect(result.output.undoneGroupIds.length).toBeGreaterThan(0);

    const graph = harness.store.view.getGraph();
    // txn-2's node and the human's node are still there; txn-1's two are gone.
    expect(Object.keys(graph.nodes)).toHaveLength(beforeRevert - 2);
    expect(graph.nodes[humanNode]).toBeDefined();
    expect(graph.nodes[earlierNode]).toBeDefined();
  });

  it("stops at a group outside the transaction instead of reverting past it", async () => {
    await apply([solid("$a", 0)], { transactionId: "txn-1" });
    // A later edit by the SAME actor, outside the transaction, sits on top of the stack.
    await apply([solid("$b", 100)]);

    const result = await harness.bus.execute(
      "graph.revertTransaction",
      { transactionId: "txn-1" },
      contextFor(agent),
    );

    expect(result.status).toBe("rejected");
    expect(result.output.undoneGroupIds).toEqual([]);
    expect(result.output.remainingGroupIds).toHaveLength(1);
    expect(result.diagnostics.some((d) => d.code === "transaction.partialRevert")).toBe(true);
    // Nothing was undone: reverting past the newer group would lose work nobody asked
    // to lose.
    expect(nodeCount()).toBe(2);
  });

  it("rejects an unknown transaction without touching the document", async () => {
    await apply([solid("$a", 0)], { transactionId: "txn-1" });
    const before = harness.store.view.getGraph();

    const result = await harness.bus.execute(
      "graph.revertTransaction",
      { transactionId: "nope" },
      contextFor(agent),
    );

    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("transaction.empty");
    expect(harness.store.view.getGraph()).toBe(before);
  });

  it("is actor-local: one actor cannot revert another's transaction (§V41)", async () => {
    await apply([solid("$a", 0)], { transactionId: "txn-1", actor: agent });

    const result = await harness.bus.execute(
      "graph.revertTransaction",
      { transactionId: "txn-1" },
      contextFor(alice),
    );

    expect(result.status).toBe("rejected");
    expect(nodeCount()).toBe(1);
  });

  it("reports what it would revert on a dry run and reverts nothing (§V36)", async () => {
    await apply([solid("$a", 0)], { transactionId: "txn-1" });

    const result = await harness.bus.execute(
      "graph.revertTransaction",
      { transactionId: "txn-1" },
      contextFor(agent, { dryRun: true }),
    );

    expect(result.status).toBe("validated");
    expect(result.output.undoneGroupIds).toEqual([]);
    expect(result.output.remainingGroupIds).toHaveLength(1);
    expect(nodeCount()).toBe(1);
    expect(harness.store.view.getAudit().filter((entry) => entry.status !== "applied")).toHaveLength(0);
  });
});
