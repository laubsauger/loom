import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

import type { GraphPatchOperation } from "../types/patch.ts";
import { alice, bob, contextFor, createHarness, patch, type Harness } from "../commands/test-support.ts";
import { actorKeyOf } from "./store.ts";

/**
 * Store invariants: §V1 §V11 §V15 §V29 §V30 §V31 §V41.
 */

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

const graph = () => harness.store.view.getGraph();

async function applyAs(actor = alice, operations: GraphPatchOperation[] = [], overrides = {}) {
  return harness.bus.execute(
    "graph.applyPatch",
    patch(harness.store.view.getRevision(), operations),
    contextFor(actor, overrides),
  );
}

const addSolid = (ref: string, x = 0): GraphPatchOperation => ({
  op: "addNode",
  ref: ref as `$${string}`,
  type: "test.solid",
  position: { x, y: 0 },
});

describe("graph store — headless source of truth (§V1, §V11)", () => {
  it("imports no React and no @xyflow anywhere in the domain layer", () => {
    const files = [
      "./store.ts",
      "./port-compat.ts",
      "./ids.ts",
      "../commands/bus.ts",
      "../commands/apply-patch.ts",
      "../commands/graph-commands.ts",
      "../parameters/validate.ts",
      "../rng/rng.ts",
      "../../nodes/registry/registry.ts",
    ];
    for (const relative of files) {
      const source = readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
      expect(source, relative).not.toMatch(/from\s+["'](react|react-dom|@xyflow)/);
    }
  });

  it("runs entirely in Node: a full edit round-trip with no DOM", async () => {
    const result = await applyAs(alice, [addSolid("$a")]);
    expect(result.status).toBe("applied");
    expect(graph().revision).toBe(1);
    expect(Object.keys(graph().nodes)).toHaveLength(1);
  });
});

describe("graph store — the bus is the only mutation path (§V29)", () => {
  it("freezes published state so a direct mutation throws instead of silently succeeding", async () => {
    await applyAs(alice, [addSolid("$a")]);
    const document = graph();

    expect(() => {
      (document.nodes as Record<string, unknown>)["hacked"] = { id: "hacked" };
    }).toThrow(TypeError);

    const node = Object.values(document.nodes)[0];
    expect(() => {
      (node as { position: { x: number } }).position.x = 500;
    }).toThrow(TypeError);

    expect(Object.keys(graph().nodes)).toHaveLength(1);
  });

  it("exposes only read accessors on the view handed to the UI", () => {
    const view = harness.store.view as unknown as Record<string, unknown>;
    for (const forbidden of ["setState", "apply", "undo", "redo"]) {
      expect(view[forbidden]).toBeUndefined();
    }
  });
});

describe("graph store — actor identity and audit (§V30, §V31)", () => {
  it("refuses to mutate without an actor id", async () => {
    await expect(
      harness.bus.execute("graph.applyPatch", patch(0, [addSolid("$a")]), contextFor({ kind: "human", id: "  " })),
    ).rejects.toThrow(/actor id/);
    expect(harness.store.view.getRevision()).toBe(0);
    expect(harness.store.view.getAudit()).toHaveLength(0);
  });

  it("refuses a direct store apply without an actor id", () => {
    expect(() =>
      harness.store.internals.apply({
        actor: { kind: "agent", id: "" },
        command: "test",
        recipe: (draft) => {
          draft.nodes["x"] = { id: "x", type: "test.solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} };
        },
      }),
    ).toThrow(/§V30/);
  });

  it("writes one audit entry per mutation, carrying actor, revision and undo group", async () => {
    const first = await applyAs(alice, [addSolid("$a")]);
    const second = await applyAs(bob, [addSolid("$b", 100)]);

    const audit = harness.store.view.getAudit();
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({
      revision: 1,
      status: "applied",
      command: "graph.applyPatch",
      actor: { id: "alice" },
      undoGroupId: first.output.undoGroupId,
    });
    expect(audit[1]).toMatchObject({
      revision: 2,
      status: "applied",
      actor: { id: "bob" },
      undoGroupId: second.output.undoGroupId,
    });
    expect(audit.every((entry) => typeof entry.timestamp === "string")).toBe(true);
  });

  it("audits undo as its own entry", async () => {
    await applyAs(alice, [addSolid("$a")]);
    await harness.bus.execute("graph.undo", {}, contextFor(alice));
    const audit = harness.store.view.getAudit();
    expect(audit).toHaveLength(2);
    expect(audit[1]?.command).toBe("graph.undo");
    expect(audit[1]?.status).toBe("applied");
    expect(audit[1]?.revision).toBe(2);
  });

  it("keeps the revision monotonic across applies and undos", async () => {
    await applyAs(alice, [addSolid("$a")]);
    await applyAs(alice, [addSolid("$b", 10)]);
    await harness.bus.execute("graph.undo", {}, contextFor(alice));
    await harness.bus.execute("graph.redo", {}, contextFor(alice));
    expect(graph().revision).toBe(4);
    expect(harness.store.view.getAudit().map((e) => e.revision)).toEqual([1, 2, 3, 4]);
  });
});

describe("graph store — drag coalescing (§V15)", () => {
  it("collapses one continuous drag into a single undo entry while applying live values", async () => {
    const built = await applyAs(alice, [addSolid("$a")]);
    const nodeId = built.output.createdIds["$a"] as string;
    const startRevision = graph().revision;

    const transactionId = "drag-1";
    for (let step = 1; step <= 10; step += 1) {
      const result = await harness.bus.execute(
        "graph.applyPatch",
        patch(harness.store.view.getRevision(), [
          { op: "moveNodes", positions: { [nodeId]: { x: step * 10, y: 0 } } },
        ]),
        contextFor(alice, { transactionId }),
      );
      expect(result.status).toBe("applied");
      // §V15: intermediate values are live, not buffered until drag end.
      expect(graph().nodes[nodeId]?.position.x).toBe(step * 10);
    }

    // Every step bumped the revision...
    expect(graph().revision).toBe(startRevision + 10);
    // ...but the drag is one history entry, not ten.
    const history = harness.store.view.getHistory(alice);
    expect(history.undo).toHaveLength(2); // the add, then the whole drag
    expect(history.undo[1]?.transactionId).toBe(transactionId);

    await harness.bus.execute("graph.undo", {}, contextFor(alice));
    // One undo returns to where the drag started, not to step 9.
    expect(graph().nodes[nodeId]?.position.x).toBe(0);
  });

  it("keeps separate transactions as separate undo entries", async () => {
    const built = await applyAs(alice, [addSolid("$a")]);
    const nodeId = built.output.createdIds["$a"] as string;

    for (const transactionId of ["drag-1", "drag-2"]) {
      await harness.bus.execute(
        "graph.applyPatch",
        patch(harness.store.view.getRevision(), [
          { op: "moveNodes", positions: { [nodeId]: { x: transactionId === "drag-1" ? 50 : 90, y: 0 } } },
        ]),
        contextFor(alice, { transactionId }),
      );
    }

    expect(harness.store.view.getHistory(alice).undo).toHaveLength(3);
    await harness.bus.execute("graph.undo", {}, contextFor(alice));
    expect(graph().nodes[nodeId]?.position.x).toBe(50);
  });

  it("does not coalesce mutations that carry no transaction id", async () => {
    const built = await applyAs(alice, [addSolid("$a")]);
    const nodeId = built.output.createdIds["$a"] as string;
    await applyAs(alice, [{ op: "moveNodes", positions: { [nodeId]: { x: 5, y: 0 } } }]);
    await applyAs(alice, [{ op: "moveNodes", positions: { [nodeId]: { x: 9, y: 0 } } }]);
    expect(harness.store.view.getHistory(alice).undo).toHaveLength(3);
  });
});

describe("graph store — actor-local undo (§V41)", () => {
  it("undoes only the calling actor's work", async () => {
    const fromAlice = await applyAs(alice, [addSolid("$a")]);
    const fromBob = await applyAs(bob, [addSolid("$b", 200)]);
    const aliceNode = fromAlice.output.createdIds["$a"] as string;
    const bobNode = fromBob.output.createdIds["$b"] as string;

    const undone = await harness.bus.execute("graph.undo", {}, contextFor(alice));
    expect(undone.status).toBe("applied");

    // Alice's node is gone; Bob's most recent work survives untouched.
    expect(graph().nodes[aliceNode]).toBeUndefined();
    expect(graph().nodes[bobNode]).toBeDefined();
    expect(harness.store.view.getHistory(bob).undo).toHaveLength(1);
    expect(harness.store.view.getHistory(alice).undo).toHaveLength(0);
  });

  it("reports nothing to undo for an actor with no history", async () => {
    await applyAs(alice, [addSolid("$a")]);
    const result = await harness.bus.execute("graph.undo", {}, contextFor(bob));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("history.empty");
    expect(Object.keys(graph().nodes)).toHaveLength(1);
  });

  it("skips an entity another actor has edited more recently rather than erasing their work", async () => {
    const built = await applyAs(alice, [addSolid("$a")]);
    const nodeId = built.output.createdIds["$a"] as string;

    await applyAs(alice, [{ op: "setParameters", nodeId, parameters: { amount: 0.25 } }]);
    await applyAs(bob, [{ op: "setParameters", nodeId, parameters: { amount: 0.75 } }]);

    const undone = await harness.bus.execute("graph.undo", {}, contextFor(alice));
    expect(undone.status).toBe("applied");
    // Bob's newer value stands: undo must not silently revert another actor's edit.
    expect(graph().nodes[nodeId]?.parameters["amount"]).toBe(0.75);
    expect(undone.diagnostics.some((d) => d.code === "history.blocked")).toBe(true);
  });

  it("keys history by actor kind as well as id", () => {
    expect(actorKeyOf({ kind: "human", id: "x" })).not.toBe(actorKeyOf({ kind: "agent", id: "x" }));
  });

  it("lets an agent and a human undo independently", async () => {
    const agentActor = { kind: "agent" as const, id: "claude" };
    const fromAgent = await applyAs(agentActor, [addSolid("$a")]);
    const fromHuman = await applyAs(alice, [addSolid("$h", 300)]);

    await harness.bus.execute("graph.undo", {}, contextFor(agentActor));
    expect(graph().nodes[fromAgent.output.createdIds["$a"] as string]).toBeUndefined();
    expect(graph().nodes[fromHuman.output.createdIds["$h"] as string]).toBeDefined();

    await harness.bus.execute("graph.undo", {}, contextFor(alice));
    expect(Object.keys(graph().nodes)).toHaveLength(0);
  });

  it("blocks redo, not only undo, from clobbering another actor's newer edit", async () => {
    const built = await applyAs(alice, [addSolid("$a")]);
    const nodeId = built.output.createdIds["$a"] as string;

    await applyAs(alice, [{ op: "setParameters", nodeId, parameters: { amount: 0.25 } }]);
    await applyAs(bob, [{ op: "setParameters", nodeId, parameters: { amount: 0.75 } }]);

    // Alice's undo is blocked (bob owns the entity) and lands the group on her redo stack.
    await harness.bus.execute("graph.undo", {}, contextFor(alice));
    expect(graph().nodes[nodeId]?.parameters["amount"]).toBe(0.75);

    // Redoing must not re-apply alice's 0.25 over bob's 0.75.
    const redone = await harness.bus.execute("graph.redo", {}, contextFor(alice));
    expect(redone.status).toBe("applied");
    expect(graph().nodes[nodeId]?.parameters["amount"]).toBe(0.75);
    expect(redone.diagnostics.some((d) => d.code === "history.blocked")).toBe(true);
  });
});

describe("graph store — restore keeps referential integrity (§V40, §V41)", () => {
  it("keeps a node whose undo would strand another actor's edge", async () => {
    const source = await applyAs(alice, [addSolid("$a")]);
    const sourceId = source.output.createdIds["$a"] as string;
    const blur = await applyAs(alice, [
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } },
    ]);
    const blurId = blur.output.createdIds["$b"] as string;

    await applyAs(bob, [
      { op: "connect", source: { nodeId: sourceId, portId: "out" }, target: { nodeId: blurId, portId: "source" } },
    ]);

    // Alice undoes the blur node's creation; bob's edge points at it.
    const undone = await harness.bus.execute("graph.undo", {}, contextFor(alice));
    expect(undone.status).toBe("applied");
    expect(graph().nodes[blurId]).toBeDefined();
    expect(Object.keys(graph().edges)).toHaveLength(1);
    expect(undone.diagnostics.some((d) => d.code === "history.integrity")).toBe(true);
    // No dangling edge either way round.
    for (const edge of Object.values(graph().edges)) {
      expect(graph().nodes[edge.source.nodeId]).toBeDefined();
      expect(graph().nodes[edge.target.nodeId]).toBeDefined();
    }
  });

  it("skips re-adding an edge whose endpoint no longer exists", async () => {
    const source = await applyAs(alice, [addSolid("$a")]);
    const sourceId = source.output.createdIds["$a"] as string;
    const blur = await applyAs(alice, [
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } },
    ]);
    const blurId = blur.output.createdIds["$b"] as string;
    await applyAs(alice, [
      { op: "connect", source: { nodeId: sourceId, portId: "out" }, target: { nodeId: blurId, portId: "source" } },
    ]);

    // Alice retracts the connection, bob deletes the source node, alice redoes.
    await harness.bus.execute("graph.undo", {}, contextFor(alice));
    await applyAs(bob, [{ op: "removeNodes", nodeIds: [sourceId] }]);

    const redone = await harness.bus.execute("graph.redo", {}, contextFor(alice));
    expect(redone.status).toBe("applied");
    expect(Object.keys(graph().edges)).toHaveLength(0);
    expect(redone.diagnostics.some((d) => d.code === "history.integrity")).toBe(true);
  });

  it("still cascades cleanly when the same actor's group holds both the node and its edges", async () => {
    // One patch adds two nodes and the edge between them: undo removes all three
    // together, so integrity blocking must not trigger.
    const built = await applyAs(alice, [
      addSolid("$a"),
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b", portId: "source" } },
    ]);
    expect(built.status).toBe("applied");
    expect(Object.keys(graph().edges)).toHaveLength(1);

    const undone = await harness.bus.execute("graph.undo", {}, contextFor(alice));
    expect(undone.status).toBe("applied");
    expect(undone.diagnostics).toHaveLength(0);
    expect(Object.keys(graph().nodes)).toHaveLength(0);
    expect(Object.keys(graph().edges)).toHaveLength(0);

    const redone = await harness.bus.execute("graph.redo", {}, contextFor(alice));
    expect(redone.status).toBe("applied");
    expect(Object.keys(graph().nodes)).toHaveLength(2);
    expect(Object.keys(graph().edges)).toHaveLength(1);
  });
});
