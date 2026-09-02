import { describe, expect, it } from "vitest";

import { createDomainBus } from "../../domain/commands/index.ts";
import type { LoomBus } from "../../domain/commands/bus.ts";
import type { HistorySummary } from "../../domain/commands/graph-commands.ts";
import { createSequentialIdFactory } from "../../domain/graph/ids.ts";
import { createGraphStore } from "../../domain/graph/store.ts";
import type { GraphStore } from "../../domain/graph/store.ts";
import type { Actor, AuditEntry, InvocationContext } from "../../domain/types/commands.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { GraphPatch, GraphPatchOperation, GraphPatchResult } from "../../domain/types/patch.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";

/**
 * T61 — the patch contract, gated end to end through the real bus (§V32, §V33, §V36, §V41).
 *
 * The unit suites under `src/domain/commands/**` and `src/domain/graph/**` already cover
 * each rule against the store directly. What they cannot see is the seam a caller actually
 * uses: `bus.execute("graph.applyPatch", …)` with an `InvocationContext`, where the bus
 * owns the audit entry for a mutation that did NOT happen and the dry-run suppression.
 * This file exercises exactly that seam, and only claims that are false if the seam is
 * wrong rather than the store.
 *
 * ## The trap each test is written against
 *
 * - Atomicity: "the bad operation was not applied" is not the claim. The claim is that
 *   NOTHING was — including the two operations that had already mutated the draft — and
 *   that the revision did not move. A test checking only the failing op passes against a
 *   partial apply.
 * - Conflict: it is not enough that a stale patch is refused. §V33 refuses it IFF it
 *   overlaps, and forbids rebasing. The interesting case, and the one that decides whether
 *   an agent can work beside a live human at all, is the stale patch that must SUCCEED.
 * - dryRun: "the tool returned validated" proves nothing about the store. The assertions
 *   are on revision, document identity and the audit log — the three places a mutation
 *   would show up.
 * - Audit completeness: a log that records successes is not an audit. Every rejected and
 *   conflicting attempt must appear too, and a dry run must appear nowhere.
 * - Actor-local undo: "undo removed something" is satisfied by an undo that erased another
 *   actor's work, which §V41 forbids outright.
 */

const HUMAN: Actor = { kind: "human", id: "flo" };
const AGENT: Actor = { kind: "agent", id: "claude", label: "Claude" };

function invocation(actor: Actor): InvocationContext {
  // `capabilities` is advisory only — the bus authorizes from its own grant store (§V67),
  // and it is deliberately empty here so nothing in this file can self-grant (§V38).
  return { actor, projectId: "acceptance", capabilities: [] };
}

interface Fixture {
  readonly bus: LoomBus;
  readonly store: GraphStore;
}

function fixture(): Fixture {
  const store = createGraphStore({
    ids: createSequentialIdFactory("n"),
    now: () => "2026-08-29T00:00:00.000Z",
  });
  const registry = createNodeRegistry(allNodeDefinitions).view();
  return { bus: createDomainBus({ store, registry }).bus, store };
}

function patch(
  baseRevision: number,
  operations: GraphPatchOperation[],
  label?: string,
): GraphPatch {
  return { baseRevision, operations, ...(label === undefined ? {} : { label }) };
}

function applyPatch(
  bus: LoomBus,
  actor: Actor,
  input: GraphPatch,
  options: { dryRun?: boolean } = {},
) {
  return bus.execute("graph.applyPatch", input, {
    ...invocation(actor),
    ...(options.dryRun === undefined ? {} : { dryRun: options.dryRun }),
  });
}

function auditOf(store: GraphStore): readonly AuditEntry[] {
  return store.view.getAudit();
}

function historyOf(bus: LoomBus, actor: Actor): Promise<HistorySummary> {
  return bus.query("graph.history", {}, invocation(actor));
}

/** Two nodes and no edges. Enough to have disjoint entities to aim patches at. */
async function seedTwoNodes(bus: LoomBus, store: GraphStore): Promise<[string, string]> {
  const result = await applyPatch(
    bus,
    HUMAN,
    patch(store.view.getRevision(), [
      { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "solid", position: { x: 200, y: 0 } },
    ]),
  );
  const output = result.output as GraphPatchResult;
  const a = output.createdIds["$a"];
  const b = output.createdIds["$b"];
  if (a === undefined || b === undefined) throw new Error("seed patch created no ids");
  return [a, b];
}

describe("T61 — a patch is all or nothing (§V32)", () => {
  it("leaves the document and the revision untouched when a later operation is invalid", async () => {
    const { bus, store } = fixture();
    const before = store.view.getGraph();

    const result = await applyPatch(
      bus,
      AGENT,
      patch(before.revision, [
        { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$b", type: "level", position: { x: 200, y: 0 } },
        // Third operation fails: no such node type is registered.
        { op: "addNode", ref: "$c", type: "definitely.not.a.node", position: { x: 400, y: 0 } },
      ]),
    );

    expect(result.status).toBe("rejected");
    const output = result.output as GraphPatchResult;
    expect(output.appliedOperations).toBe(0);
    expect(output.createdIds).toEqual({});

    // The two operations BEFORE the failure had already written into the draft. The
    // claim is that none of that survived — a partial apply would leave $a behind.
    const after = store.view.getGraph();
    expect(after).toEqual(before);
    expect(after.revision).toBe(before.revision);
    expect(Object.keys(after.nodes)).toEqual([]);

    // A rejection is still an event: it must be undoable-adjacent to nothing, and must
    // not have pushed a history group (§V34 — a group with no effect is a trap).
    expect((await historyOf(bus, AGENT)).undo).toEqual([]);
  });

  it("rejects the whole patch when a connection in it is illegal (§V13)", async () => {
    const { bus, store } = fixture();
    const before = store.view.getGraph();

    const result = await applyPatch(
      bus,
      AGENT,
      patch(before.revision, [
        { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$b", type: "solid", position: { x: 200, y: 0 } },
        // Solid declares no input port at all.
        { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b", portId: "input" } },
      ]),
    );

    expect(result.status).toBe("rejected");
    expect(store.view.getGraph()).toEqual(before);
  });
});

describe("T61 — a stale base conflicts on overlap, and only on overlap (§V33)", () => {
  it("refuses a stale patch that touches an entity someone else changed, and never rebases", async () => {
    const { bus, store } = fixture();
    const [a] = await seedTwoNodes(bus, store);
    const staleRevision = store.view.getRevision();

    // The human moves node A. The agent's patch was built before that and also aims at A.
    await applyPatch(bus, HUMAN, patch(staleRevision, [{ op: "moveNodes", positions: { [a]: { x: 50, y: 50 } } }]));
    const afterHuman = store.view.getGraph();

    const conflicted = await applyPatch(
      bus,
      AGENT,
      patch(staleRevision, [{ op: "moveNodes", positions: { [a]: { x: 900, y: 900 } } }]),
    );

    expect(conflicted.status).toBe("conflict");
    expect(conflicted.diagnostics.map((d) => d.code)).toContain("patch.conflict");
    // ⊥ silent rebase: the human's value stands, untouched.
    expect(store.view.getGraph()).toEqual(afterHuman);
    expect(store.view.getGraph().nodes[a]?.position).toEqual({ x: 50, y: 50 });
  });

  it("applies a stale patch whose entities nobody touched — the case a 60 Hz drag would starve", async () => {
    const { bus, store } = fixture();
    const [a, b] = await seedTwoNodes(bus, store);

    // The agent reads the graph here and starts building a patch against node B.
    const agentBase = store.view.getRevision();

    // Meanwhile the human drags node A for a second. Every frame is a revision, which is
    // exactly why "stale means conflict" makes an agent unable to land anything.
    for (let frame = 0; frame < 60; frame += 1) {
      await applyPatch(
        bus,
        HUMAN,
        patch(store.view.getRevision(), [{ op: "moveNodes", positions: { [a]: { x: frame, y: 0 } } }]),
      );
    }
    expect(store.view.getRevision()).toBeGreaterThan(agentBase);

    // The agent dispatches a STRUCTURAL patch, sixty revisions stale, aimed at B alone.
    const applied = await applyPatch(
      bus,
      AGENT,
      patch(agentBase, [
        { op: "addNode", ref: "$fx", type: "level", position: { x: 400, y: 0 } },
        { op: "connect", source: { nodeId: b, portId: "out" }, target: { nodeId: "$fx", portId: "input" } },
      ]),
      );

    expect(
      applied.status,
      "a stale patch touching nothing anyone else touched was refused: an agent cannot edit beside a live human (§V33)",
    ).toBe("applied");
    // Applied verbatim, not rebased: the human's drag is still there and so is the new node.
    expect(store.view.getGraph().nodes[a]?.position).toEqual({ x: 59, y: 0 });
    const fxId = (applied.output as GraphPatchResult).createdIds["$fx"];
    expect(fxId).toBeDefined();
    // …and it says so rather than doing it quietly.
    expect(applied.diagnostics.map((d) => d.code)).toContain("patch.staleBase");
  });

  it("refuses a base revision that is ahead of the document", async () => {
    const { bus, store } = fixture();
    const result = await applyPatch(
      bus,
      AGENT,
      patch(store.view.getRevision() + 5, [
        { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
      ]),
    );
    expect(result.status).toBe("conflict");
    expect(Object.keys(store.view.getGraph().nodes)).toEqual([]);
  });
});

describe("T61 — dryRun validates and mutates nothing (§V36)", () => {
  it("moves no revision, writes no node and writes no audit entry", async () => {
    const { bus, store } = fixture();
    const before = store.view.getGraph();
    const auditBefore = auditOf(store).length;

    const result = await applyPatch(
      bus,
      AGENT,
      patch(before.revision, [
        { op: "addNode", ref: "$a", type: "noise", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$b", type: "output", position: { x: 200, y: 0 } },
        { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b", portId: "input" } },
      ]),
      { dryRun: true },
    );

    expect(result.diagnostics.map((d) => d.code)).toContain("patch.dryRun");
    // The three places a mutation could hide.
    expect(store.view.getGraph()).toEqual(before);
    expect(store.view.getRevision()).toBe(before.revision);
    expect(auditOf(store)).toHaveLength(auditBefore);
    expect((await historyOf(bus, AGENT)).undo).toEqual([]);
  });

  it("reports the diagnostics of an invalid patch without mutating or auditing", async () => {
    const { bus, store } = fixture();
    const before = store.view.getGraph();

    const result = await applyPatch(
      bus,
      AGENT,
      patch(before.revision, [
        { op: "addNode", ref: "$a", type: "no.such.type", position: { x: 0, y: 0 } },
      ]),
      { dryRun: true },
    );

    expect(result.diagnostics.some((d) => d.severity === "error")).toBe(true);
    expect(store.view.getGraph()).toEqual(before);
    expect(auditOf(store)).toEqual([]);
  });
});

describe("T61 — the audit records every attempt, exactly once (§V31)", () => {
  it("logs applied, rejected and conflicting mutations, and nothing for a dry run", async () => {
    const { bus, store } = fixture();

    // 1. applied
    const seeded = await applyPatch(
      bus,
      HUMAN,
      patch(store.view.getRevision(), [
        { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
      ]),
      );
    const a = (seeded.output as GraphPatchResult).createdIds["$a"] ?? "";
    const staleRevision = store.view.getRevision();

    // 2. applied (by the other actor, so the conflict below is a real overlap)
    await applyPatch(
      bus,
      AGENT,
      patch(staleRevision, [{ op: "moveNodes", positions: { [a]: { x: 10, y: 10 } } }]),
    );

    // 3. conflict — stale AND overlapping
    await applyPatch(
      bus,
      HUMAN,
      patch(staleRevision, [{ op: "moveNodes", positions: { [a]: { x: 99, y: 99 } } }]),
    );

    // 4. rejected — current base, invalid operation
    await applyPatch(
      bus,
      HUMAN,
      patch(store.view.getRevision(), [{ op: "removeNodes", nodeIds: ["nope"] }]),
    );

    // 5. dry run — must leave no trace at all
    await applyPatch(
      bus,
      HUMAN,
      patch(store.view.getRevision(), [
        { op: "addNode", ref: "$z", type: "solid", position: { x: 0, y: 0 } },
      ]),
      { dryRun: true },
    );

    const log = auditOf(store);
    expect(log.map((entry) => entry.status)).toEqual([
      "applied",
      "applied",
      "conflict",
      "rejected",
    ]);
    expect(log.map((entry) => entry.actor)).toEqual([HUMAN, AGENT, HUMAN, HUMAN]);
    // §V30: no anonymous mutation reaches the log, and every entry names its command.
    expect(log.every((entry) => entry.command === "graph.applyPatch")).toBe(true);
    expect(log.every((entry) => entry.actor.id.length > 0)).toBe(true);
    // Only the two that changed the document carry an undo group.
    expect(log.filter((entry) => entry.undoGroupId !== undefined)).toHaveLength(2);
  });

  it("refuses to mutate for an actor-less invocation, and logs nothing", async () => {
    const { bus, store } = fixture();
    await expect(
      bus.execute(
        "graph.applyPatch",
        patch(store.view.getRevision(), [
          { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
        ]),
        { projectId: "acceptance" } as unknown as InvocationContext,
      ),
    ).rejects.toThrow();
    expect(auditOf(store)).toEqual([]);
    expect(Object.keys(store.view.getGraph().nodes)).toEqual([]);
  });
});

describe("T61 — undo is actor-local (§V41)", () => {
  it("undoes the calling actor's group and never the other actor's newer work", async () => {
    const { bus, store } = fixture();

    const humanPatch = await applyPatch(
      bus,
      HUMAN,
      patch(
        store.view.getRevision(),
        [{ op: "addNode", ref: "$h", type: "solid", position: { x: 0, y: 0 } }],
        "Human adds a Solid",
      ),
    );
    const humanNode = (humanPatch.output as GraphPatchResult).createdIds["$h"] ?? "";

    const agentPatch = await applyPatch(
      bus,
      AGENT,
      patch(store.view.getRevision(), [
        { op: "addNode", ref: "$a", type: "noise", position: { x: 200, y: 0 } },
      ]),
    );
    const agentNode = (agentPatch.output as GraphPatchResult).createdIds["$a"] ?? "";

    // Each actor sees only their own stack.
    expect((await historyOf(bus, HUMAN)).undo).toHaveLength(1);
    expect((await historyOf(bus, AGENT)).undo).toHaveLength(1);

    const undone = await bus.execute("graph.undo", {}, invocation(AGENT));
    expect(undone.status).toBe("applied");

    const graph: GraphDocument = store.view.getGraph();
    // The agent's node is gone; the human's is untouched. An undo that took the most
    // RECENT edit regardless of owner would also remove the agent's node here, so the
    // assertion that matters is the second one.
    expect(graph.nodes[agentNode]).toBeUndefined();
    expect(graph.nodes[humanNode], "the agent's undo erased the human's work (§V41)").toBeDefined();

    expect((await historyOf(bus, AGENT)).undo).toEqual([]);
    expect((await historyOf(bus, HUMAN)).undo).toHaveLength(1);

    // §V41: the undo is itself an audited mutation.
    expect(auditOf(store).map((entry) => entry.command)).toContain("graph.undo");
  });

  it("keeps a blocked undo on the stack rather than consuming it (§V41)", async () => {
    const { bus, store } = fixture();

    const agentPatch = await applyPatch(
      bus,
      AGENT,
      patch(store.view.getRevision(), [
        { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
      ]),
    );
    const node = (agentPatch.output as GraphPatchResult).createdIds["$a"] ?? "";

    // The human edits the same entity afterwards. Undoing the agent's add would now
    // erase a newer edit belonging to someone else.
    await applyPatch(
      bus,
      HUMAN,
      patch(store.view.getRevision(), [{ op: "moveNodes", positions: { [node]: { x: 40, y: 40 } } }]),
    );

    const blocked = await bus.execute("graph.undo", {}, invocation(AGENT));
    expect(blocked.status).toBe("rejected");
    // The node survives, and — the part that is easy to get wrong — so does the entry.
    expect(store.view.getGraph().nodes[node]).toBeDefined();
    expect(
      (await historyOf(bus, AGENT)).undo,
      "a blocked undo consumed its history entry, so the work can never be undone",
    ).toHaveLength(1);
  });
});
