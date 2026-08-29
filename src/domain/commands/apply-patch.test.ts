import { beforeEach, describe, expect, it } from "vitest";

import type { GraphDocument } from "../types/graph.ts";
import type { GraphPatchOperation } from "../types/patch.ts";
import { alice, bob, contextFor, createHarness, patch, type Harness } from "./test-support.ts";

/**
 * `graph.applyPatch` invariants: §V13 §V14 §V32 §V33 §V34 §V35 §V36 §V40.
 * This is the command every agent edit funnels through, so each rule gets a test that
 * fails loudly if the behaviour regresses.
 */

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

const ctx = (actor = alice, overrides = {}) => contextFor(actor, overrides);

const addSolid = (ref: string, x = 0): GraphPatchOperation => ({
  op: "addNode",
  ref: ref as `$${string}`,
  type: "test.solid",
  position: { x, y: 0 },
});

async function apply(operations: GraphPatchOperation[], options: { actor?: typeof alice; dryRun?: boolean; base?: number; label?: string } = {}) {
  const base = options.base ?? harness.store.view.getRevision();
  return harness.bus.execute(
    "graph.applyPatch",
    patch(base, operations, options.label),
    ctx(options.actor ?? alice, options.dryRun === true ? { dryRun: true } : {}),
  );
}

const graph = (): GraphDocument => harness.store.view.getGraph();
const nodeCount = (): number => Object.keys(graph().nodes).length;
const edgeCount = (): number => Object.keys(graph().edges).length;

describe("graph.applyPatch — temp ids and undo grouping (§V34, §V35)", () => {
  it("adds three nodes and wires them in one patch, returning stable ids", async () => {
    const result = await apply([
      addSolid("$a", 0),
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } },
      { op: "addNode", ref: "$c", type: "test.composite", position: { x: 400, y: 0 } },
      { op: "connect", ref: "$e1", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b", portId: "source" } },
      { op: "connect", source: { nodeId: "$b", portId: "out" }, target: { nodeId: "$c", portId: "layers" } },
    ], { label: "Build chain" });

    expect(result.status).toBe("applied");
    expect(result.output.appliedOperations).toBe(5);

    // §V35: every temp id resolved to a stable id and came back in createdIds.
    const created = result.output.createdIds;
    expect(Object.keys(created).sort()).toEqual(["$a", "$b", "$c", "$e1"]);
    for (const ref of ["$a", "$b", "$c"]) {
      const id = created[ref];
      expect(id).toBeDefined();
      expect(id?.startsWith("$")).toBe(false);
      expect(graph().nodes[id as string]).toBeDefined();
    }
    expect(graph().edges[created["$e1"] as string]).toBeDefined();
    expect(edgeCount()).toBe(2);

    // §V34: one patch is one undo group, whatever the operation count.
    const history = harness.store.view.getHistory(alice);
    expect(history.undo).toHaveLength(1);
    expect(history.undo[0]?.id).toBe(result.output.undoGroupId);
    expect(history.undo[0]?.label).toBe("Build chain");
  });

  it("undoes the whole patch as one group and redoes it", async () => {
    const result = await apply([
      addSolid("$a"),
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b", portId: "source" } },
    ]);
    expect(result.status).toBe("applied");
    expect(nodeCount()).toBe(2);

    const undone = await harness.bus.execute("graph.undo", {}, ctx());
    expect(undone.status).toBe("applied");
    expect(nodeCount()).toBe(0);
    expect(edgeCount()).toBe(0);

    const redone = await harness.bus.execute("graph.redo", {}, ctx());
    expect(redone.status).toBe("applied");
    expect(nodeCount()).toBe(2);
    expect(edgeCount()).toBe(1);
  });

  it("rejects a temp id that no earlier operation created", async () => {
    const result = await apply([
      { op: "connect", source: { nodeId: "$ghost", portId: "out" }, target: { nodeId: "$other", portId: "source" } },
    ]);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("patch.unresolvedRef");
  });

  it("rejects reusing one temp id twice", async () => {
    const result = await apply([addSolid("$a"), addSolid("$a", 100)]);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.some((d) => d.code === "patch.duplicateRef")).toBe(true);
    expect(nodeCount()).toBe(0);
  });
});

describe("graph.applyPatch — atomicity (§V32)", () => {
  it("leaves the document completely untouched when the third operation is invalid", async () => {
    const before = graph();
    const beforeRevision = before.revision;

    const result = await apply([
      addSolid("$a"),
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } },
      // Invalid: no such node type. Operations 1 and 2 must not survive.
      { op: "addNode", ref: "$c", type: "test.doesNotExist", position: { x: 400, y: 0 } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b", portId: "source" } },
    ]);

    expect(result.status).toBe("rejected");
    expect(result.output.appliedOperations).toBe(0);
    expect(result.diagnostics[0]?.code).toBe("node.unknownType");

    // Identity, not just deep equality: no new document object was published at all.
    expect(graph()).toBe(before);
    expect(graph().revision).toBe(beforeRevision);
    expect(nodeCount()).toBe(0);
    expect(harness.store.view.getHistory(alice).undo).toHaveLength(0);
  });

  it("rolls back operations that already mutated the draft before the failure", async () => {
    const seed = await apply([addSolid("$a")]);
    const nodeId = seed.output.createdIds["$a"] as string;
    const revisionAfterSeed = graph().revision;
    const snapshot = graph();

    const result = await apply([
      { op: "moveNodes", positions: { [nodeId]: { x: 999, y: 999 } } },
      { op: "setParameters", nodeId, parameters: { amount: 0.25 } },
      // Invalid third operation: amount has max 1.
      { op: "setParameters", nodeId, parameters: { amount: 42 } },
    ]);

    expect(result.status).toBe("rejected");
    expect(graph()).toBe(snapshot);
    expect(graph().revision).toBe(revisionAfterSeed);
    expect(graph().nodes[nodeId]?.position).toEqual({ x: 0, y: 0 });
    expect(graph().nodes[nodeId]?.parameters["amount"]).toBe(0.5);
  });

  it("rejects the whole patch when a later connect is type-incompatible", async () => {
    const result = await apply([
      addSolid("$a"),
      { op: "addNode", ref: "$s", type: "test.scalarI32", position: { x: 100, y: 0 } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$s", portId: "in" } },
    ]);
    expect(result.status).toBe("rejected");
    expect(nodeCount()).toBe(0);
  });
});

describe("graph.applyPatch — conflict (§V33)", () => {
  it("reports conflict for a stale baseRevision and never rebases", async () => {
    await apply([addSolid("$a")]);
    const currentRevision = graph().revision;
    expect(currentRevision).toBe(1);
    const snapshot = graph();

    const result = await apply([addSolid("$b")], { base: 0 });

    expect(result.status).toBe("conflict");
    expect(result.output.status).toBe("conflict");
    expect(result.output.appliedOperations).toBe(0);
    expect(result.output.revision).toBe(currentRevision);
    expect(result.diagnostics[0]?.code).toBe("patch.conflict");
    expect(graph()).toBe(snapshot);
    expect(nodeCount()).toBe(1);
  });

  it("reports conflict for a baseRevision ahead of the document too", async () => {
    const result = await apply([addSolid("$a")], { base: 99 });
    expect(result.status).toBe("conflict");
    expect(nodeCount()).toBe(0);
  });

  it("records the conflict in the audit log (§V31)", async () => {
    await apply([addSolid("$a")]);
    await apply([addSolid("$b")], { base: 0 });
    const audit = harness.store.view.getAudit();
    expect(audit.map((entry) => entry.status)).toEqual(["applied", "conflict"]);
    expect(audit[1]?.actor.id).toBe("alice");
    expect(audit[1]?.command).toBe("graph.applyPatch");
  });
});

describe("graph.applyPatch — dryRun (§V36)", () => {
  it("validates without mutating and without an applied audit entry", async () => {
    const before = graph();
    const result = await apply(
      [addSolid("$a"), { op: "addNode", ref: "$b", type: "test.blur", position: { x: 1, y: 1 } }],
      { dryRun: true },
    );

    expect(result.status).toBe("applied");
    expect(result.output.appliedOperations).toBe(2);
    expect(result.diagnostics.some((d) => d.code === "patch.dryRun")).toBe(true);

    expect(graph()).toBe(before);
    expect(graph().revision).toBe(0);
    expect(nodeCount()).toBe(0);
    expect(harness.store.view.getAudit()).toHaveLength(0);
    expect(harness.store.view.getHistory(alice).undo).toHaveLength(0);
  });

  it("reports diagnostics for an invalid patch without mutating or auditing", async () => {
    const before = graph();
    const result = await apply([{ op: "addNode", ref: "$a", type: "nope", position: { x: 0, y: 0 } }], {
      dryRun: true,
    });

    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("node.unknownType");
    expect(graph()).toBe(before);
    expect(harness.store.view.getAudit()).toHaveLength(0);
  });
});

describe("graph.applyPatch — connection rules (§V13, §V14)", () => {
  it("refuses near-miss port types with a suggestion to insert a conversion node", async () => {
    const cases: Array<{ from: [string, string]; to: [string, string] }> = [
      { from: ["test.scalarF32", "out"], to: ["test.scalarI32", "in"] },
      { from: ["test.vec2", "out"], to: ["test.vec3", "in"] },
      { from: ["test.depth", "out"], to: ["test.blur", "source"] },
      { from: ["test.solid", "out"], to: ["test.mono", "source"] },
    ];

    for (const testCase of cases) {
      harness = createHarness();
      const result = await apply([
        { op: "addNode", ref: "$a", type: testCase.from[0], position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$b", type: testCase.to[0], position: { x: 100, y: 0 } },
        { op: "connect", source: { nodeId: "$a", portId: testCase.from[1] }, target: { nodeId: "$b", portId: testCase.to[1] } },
      ]);
      expect(result.status, `${testCase.from[0]} -> ${testCase.to[0]}`).toBe("rejected");
      expect(result.diagnostics.some((d) => d.code === "port.incompatible")).toBe(true);
      expect(edgeCount()).toBe(0);
    }
  });

  it("rejects a second edge into a non-variadic input (§V14)", async () => {
    const built = await apply([
      addSolid("$a"),
      addSolid("$b", 100),
      { op: "addNode", ref: "$blur", type: "test.blur", position: { x: 300, y: 0 } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$blur", portId: "source" } },
    ]);
    expect(built.status).toBe("applied");
    const b = built.output.createdIds["$b"] as string;
    const blur = built.output.createdIds["$blur"] as string;

    const second = await apply([
      { op: "connect", source: { nodeId: b, portId: "out" }, target: { nodeId: blur, portId: "source" } },
    ]);

    expect(second.status).toBe("rejected");
    expect(second.diagnostics[0]?.code).toBe("port.occupied");
    expect(edgeCount()).toBe(1);
  });

  it("allows many edges into a variadic input (§V14)", async () => {
    const result = await apply([
      addSolid("$a"),
      addSolid("$b", 100),
      addSolid("$c", 200),
      { op: "addNode", ref: "$comp", type: "test.composite", position: { x: 400, y: 0 } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$comp", portId: "layers" } },
      { op: "connect", source: { nodeId: "$b", portId: "out" }, target: { nodeId: "$comp", portId: "layers" } },
      { op: "connect", source: { nodeId: "$c", portId: "out" }, target: { nodeId: "$comp", portId: "layers" } },
    ]);
    expect(result.status).toBe("applied");
    expect(edgeCount()).toBe(3);
  });

  it("leaves output fan-out unbounded (§V14)", async () => {
    const result = await apply([
      addSolid("$a"),
      { op: "addNode", ref: "$b1", type: "test.blur", position: { x: 100, y: 0 } },
      { op: "addNode", ref: "$b2", type: "test.blur", position: { x: 100, y: 100 } },
      { op: "addNode", ref: "$b3", type: "test.blur", position: { x: 100, y: 200 } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b1", portId: "source" } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b2", portId: "source" } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b3", portId: "source" } },
    ]);
    expect(result.status).toBe("applied");
    expect(edgeCount()).toBe(3);
  });

  it("rejects an exact duplicate edge even on a variadic input", async () => {
    const built = await apply([
      addSolid("$a"),
      { op: "addNode", ref: "$comp", type: "test.composite", position: { x: 400, y: 0 } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$comp", portId: "layers" } },
    ]);
    const a = built.output.createdIds["$a"] as string;
    const comp = built.output.createdIds["$comp"] as string;

    const again = await apply([
      { op: "connect", source: { nodeId: a, portId: "out" }, target: { nodeId: comp, portId: "layers" } },
    ]);
    expect(again.status).toBe("rejected");
    expect(again.diagnostics[0]?.code).toBe("edge.duplicate");
  });

  it("rejects unknown port ids and connecting an input to an input", async () => {
    const built = await apply([addSolid("$a"), { op: "addNode", ref: "$b", type: "test.blur", position: { x: 1, y: 1 } }]);
    const a = built.output.createdIds["$a"] as string;
    const b = built.output.createdIds["$b"] as string;

    const missingPort = await apply([
      { op: "connect", source: { nodeId: a, portId: "nope" }, target: { nodeId: b, portId: "source" } },
    ]);
    expect(missingPort.status).toBe("rejected");
    expect(missingPort.diagnostics[0]?.code).toBe("port.missing");

    // "source" is an input on test.blur, so it can never be an edge source.
    const wrongDirection = await apply([
      { op: "connect", source: { nodeId: b, portId: "source" }, target: { nodeId: b, portId: "source" } },
    ]);
    expect(wrongDirection.status).toBe("rejected");
    expect(wrongDirection.diagnostics[0]?.code).toBe("port.missing");
  });
});

describe("graph.applyPatch — deletion (§V40)", () => {
  const buildChain = async (h: Harness) => {
    harness = h;
    return apply([
      addSolid("$a"),
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 100, y: 0 } },
      { op: "addNode", ref: "$c", type: "test.composite", position: { x: 200, y: 0 } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$b", portId: "source" } },
      { op: "connect", source: { nodeId: "$b", portId: "out" }, target: { nodeId: "$c", portId: "layers" } },
      { op: "connect", source: { nodeId: "$a", portId: "out" }, target: { nodeId: "$c", portId: "mask" } },
    ]);
  };

  it("removes every incident edge with the node", async () => {
    const built = await buildChain(harness);
    const b = built.output.createdIds["$b"] as string;
    expect(edgeCount()).toBe(3);

    const removed = await apply([{ op: "removeNodes", nodeIds: [b] }]);
    expect(removed.status).toBe("applied");
    expect(nodeCount()).toBe(2);
    // Both the edge into $b and the edge out of $b are gone; the a->c edge survives.
    expect(edgeCount()).toBe(1);
    const survivor = Object.values(graph().edges)[0];
    expect(survivor?.target.portId).toBe("mask");
  });

  it("produces an identical document for any actor performing the same deletion", async () => {
    const first = createHarness();
    const builtFirst = await buildChain(first);
    const nodeId = builtFirst.output.createdIds["$b"] as string;
    await apply([{ op: "removeNodes", nodeIds: [nodeId] }], { actor: alice });
    const afterAlice = first.store.view.getGraph();

    const second = createHarness();
    await buildChain(second);
    await apply([{ op: "removeNodes", nodeIds: [nodeId] }], { actor: bob });
    const afterBob = second.store.view.getGraph();

    expect(afterAlice.nodes).toEqual(afterBob.nodes);
    expect(afterAlice.edges).toEqual(afterBob.edges);
    expect(afterAlice.revision).toBe(afterBob.revision);
  });

  it("rejects deleting a node that does not exist", async () => {
    const built = await buildChain(harness);
    const before = graph();
    const result = await apply([
      { op: "removeNodes", nodeIds: [built.output.createdIds["$a"] as string, "not-a-node"] },
    ]);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("node.missing");
    expect(graph()).toBe(before);
  });

  it("restores nodes and their edges on undo", async () => {
    const built = await buildChain(harness);
    const b = built.output.createdIds["$b"] as string;
    await apply([{ op: "removeNodes", nodeIds: [b] }]);
    expect(edgeCount()).toBe(1);

    await harness.bus.execute("graph.undo", {}, ctx());
    expect(nodeCount()).toBe(3);
    expect(edgeCount()).toBe(3);
  });
});

describe("graph.applyPatch — parameters and shader source", () => {
  it("fills manifest defaults and applies provided parameters", async () => {
    const result = await apply([
      { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 }, parameters: { amount: 0.25 } },
    ]);
    const node = graph().nodes[result.output.createdIds["$a"] as string];
    expect(node?.parameters["amount"]).toBe(0.25);
    expect(node?.parameters["color"]).toEqual([0, 0, 0, 1]);
    expect(node?.definitionVersion).toBe(1);
  });

  it("rejects unknown parameter names and wrong types", async () => {
    const unknown = await apply([
      { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 }, parameters: { nope: 1 } },
    ]);
    expect(unknown.status).toBe("rejected");
    expect(unknown.diagnostics[0]?.code).toBe("parameter.unknown");

    const wrongType = await apply([
      { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 }, parameters: { amount: "loud" } },
    ]);
    expect(wrongType.status).toBe("rejected");
    expect(wrongType.diagnostics[0]?.code).toBe("parameter.type");
  });

  it("sets shader source only on a node that declares a source parameter", async () => {
    const built = await apply([
      { op: "addNode", ref: "$w", type: "test.customWgsl", position: { x: 0, y: 0 } },
      addSolid("$s", 100),
    ]);
    const wgsl = built.output.createdIds["$w"] as string;
    const solid = built.output.createdIds["$s"] as string;

    const ok = await apply([{ op: "setShaderSource", nodeId: wgsl, source: "fn fs() {}" }]);
    expect(ok.status).toBe("applied");
    expect(graph().nodes[wgsl]?.parameters["source"]).toBe("fn fs() {}");

    const bad = await apply([{ op: "setShaderSource", nodeId: solid, source: "fn fs() {}" }]);
    expect(bad.status).toBe("rejected");
    expect(bad.diagnostics[0]?.code).toBe("node.notShaderAuthorable");
  });

  it("rejects unknown ui keys", async () => {
    const built = await apply([addSolid("$a")]);
    const id = built.output.createdIds["$a"] as string;

    expect((await apply([{ op: "setNodeUi", nodeId: id, ui: { collapsed: true } }])).status).toBe("applied");
    expect(graph().nodes[id]?.ui?.collapsed).toBe(true);

    const bad = await apply([{ op: "setNodeUi", nodeId: id, ui: { rotation: 90 } }]);
    expect(bad.status).toBe("rejected");
    expect(bad.diagnostics[0]?.code).toBe("node.ui.unknown");
  });
});
