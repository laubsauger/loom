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

describe("graph.applyPatch — conflict is entity overlap, not staleness (§V33, T107)", () => {
  it("reports conflict when the patch touches a node someone else has since changed", async () => {
    const built = await apply([addSolid("$a")]);
    const nodeId = built.output.createdIds["$a"] as string;
    const base = graph().revision;

    // Bob edits the node. Alice's patch, built before that, targets the same node.
    await apply([{ op: "setNodeLabel", nodeId, label: "bob was here" }], { actor: bob });
    const currentRevision = graph().revision;
    const snapshot = graph();

    const result = await apply([{ op: "setNodeLabel", nodeId, label: "alice" }], { base });

    expect(result.status).toBe("conflict");
    expect(result.output.status).toBe("conflict");
    expect(result.output.appliedOperations).toBe(0);
    expect(result.output.revision).toBe(currentRevision);
    expect(result.diagnostics[0]?.code).toBe("patch.conflict");
    // The overlapping entity is NAMED, so the caller knows what to re-read.
    expect(result.diagnostics[0]?.message).toContain(`node:${nodeId}`);
    expect(graph()).toBe(snapshot);
  });

  /**
   * The case that makes the invariant worth having: a human dragging a node writes a
   * revision every frame, so an agent patch built 20ms ago is always stale. If staleness
   * alone were a conflict, the agent could never land an edit while anyone touches the
   * canvas — which is the T62 gate passing in a quiet room and failing in a real one.
   */
  it("applies a stale patch that touches nothing the newer edits touched", async () => {
    const built = await apply([addSolid("$a")]);
    const dragged = built.output.createdIds["$a"] as string;
    const base = graph().revision;

    // A 60Hz drag of one node: many revisions, all on that node only.
    for (let frame = 0; frame < 8; frame += 1) {
      await apply([{ op: "moveNodes", positions: { [dragged]: { x: frame, y: 0 } } }], { actor: bob });
    }
    expect(graph().revision).toBe(base + 8);

    // The agent's patch was built against `base` and adds a disjoint node.
    const result = await apply([addSolid("$b", 500)], { base });

    expect(result.status).toBe("applied");
    expect(nodeCount()).toBe(2);
    // Applied, but not silently: the stale base is reported (§V33 forbids a QUIET rebase,
    // and nothing was rebased — the operations went in exactly as written).
    expect(result.diagnostics.some((d) => d.code === "patch.staleBase")).toBe(true);
    expect(graph().nodes[dragged]?.position.x).toBe(7);
  });

  it("conflicts when a value-only patch targets a node a structural patch removed", async () => {
    const built = await apply([addSolid("$a"), { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } }]);
    const removed = built.output.createdIds["$a"] as string;
    const kept = built.output.createdIds["$b"] as string;
    const base = graph().revision;

    await apply([{ op: "removeNodes", nodeIds: [removed] }], { actor: bob });

    const overlapping = await apply(
      [{ op: "setNodeUi", nodeId: removed, ui: { bypassed: true } }],
      { base },
    );
    expect(overlapping.status).toBe("conflict");

    // The same value-only edit on the surviving node is not in anyone's way.
    const disjoint = await apply([{ op: "setNodeUi", nodeId: kept, ui: { bypassed: true } }], { base });
    expect(disjoint.status).toBe("applied");
    expect(graph().nodes[kept]?.ui?.bypassed).toBe(true);
  });

  it("conflicts when another actor already occupied the input port a connect wants", async () => {
    const built = await apply([
      addSolid("$a"),
      { op: "addNode", ref: "$b", type: "test.solid", position: { x: 0, y: 200 } },
      { op: "addNode", ref: "$t", type: "test.blur", position: { x: 400, y: 0 } },
    ]);
    const first = built.output.createdIds["$a"] as string;
    const second = built.output.createdIds["$b"] as string;
    const target = built.output.createdIds["$t"] as string;
    const base = graph().revision;

    await apply(
      [{ op: "connect", source: { nodeId: first, portId: "out" }, target: { nodeId: target, portId: "source" } }],
      { actor: bob },
    );

    // §V14 is decided by the edges already landing on that port, so the edge Bob just
    // created is part of what this patch touches even though it never names it.
    const result = await apply(
      [{ op: "connect", source: { nodeId: second, portId: "out" }, target: { nodeId: target, portId: "source" } }],
      { base },
    );
    expect(result.status).toBe("conflict");
    expect(edgeCount()).toBe(1);
  });

  it("reports conflict for a baseRevision ahead of the document too", async () => {
    const result = await apply([addSolid("$a")], { base: 99 });
    expect(result.status).toBe("conflict");
    expect(nodeCount()).toBe(0);
  });

  it("records the conflict in the audit log (§V31)", async () => {
    const built = await apply([addSolid("$a")]);
    const nodeId = built.output.createdIds["$a"] as string;
    const base = graph().revision;
    await apply([{ op: "setNodeLabel", nodeId, label: "bob" }], { actor: bob });
    await apply([{ op: "setNodeLabel", nodeId, label: "alice" }], { base });

    const audit = harness.store.view.getAudit();
    expect(audit.map((entry) => entry.status)).toEqual(["applied", "applied", "conflict"]);
    expect(audit[2]?.actor.id).toBe("alice");
    expect(audit[2]?.command).toBe("graph.applyPatch");
  });
});

describe("graph.applyPatch — dryRun (§V36, T102)", () => {
  it("answers `validated`, mints no ids, and writes no audit entry", async () => {
    const before = graph();
    const result = await apply(
      [addSolid("$a"), { op: "addNode", ref: "$b", type: "test.blur", position: { x: 1, y: 1 } }],
      { dryRun: true },
    );

    // NOT "applied": a caller told "applied" for an edit that did not happen builds its
    // next patch on ids nobody minted (T102).
    expect(result.status).toBe("validated");
    expect(result.output.status).toBe("validated");
    expect(result.output.appliedOperations).toBe(2);
    expect(result.output.createdIds).toEqual({});
    expect(result.diagnostics.some((d) => d.code === "patch.dryRun")).toBe(true);

    expect(graph()).toBe(before);
    expect(graph().revision).toBe(0);
    expect(nodeCount()).toBe(0);
    expect(harness.store.view.getAudit()).toHaveLength(0);
    expect(harness.store.view.getHistory(alice).undo).toHaveLength(0);
  });

  /**
   * The concrete hazard T102 names: a dry run followed by the real thing must not
   * produce two different id sets, and the dry run must not consume ids from the factory
   * to make that happen.
   */
  it("does not consume ids, so the real apply mints the ids a caller can rely on", async () => {
    await apply([addSolid("$a")], { dryRun: true });
    const real = await apply([addSolid("$a")]);

    const created = real.output.createdIds["$a"];
    expect(created).toBeDefined();
    expect(graph().nodes[created as string]).toBeDefined();
    // The very first minted node id, exactly as if the dry run had never run.
    expect(created).toBe("nd_t1");
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

/**
 * §V66 / T89 + T176: the patch is untrusted input.
 *
 * Every case below used to leave the boundary through a raw `TypeError` — no diagnostic,
 * no audit entry, and an unhandled rejection at whatever called `bus.execute`. A caller
 * that sends garbage must get an answer, and the log must show that something was
 * refused (§V31).
 */
describe("graph.applyPatch — structural validation of untrusted input (§V66)", () => {
  /** Bypasses the typed helper on purpose: this is what arrives over a transport. */
  const raw = async (patch: unknown, options: { dryRun?: boolean } = {}) =>
    harness.bus.execute(
      "graph.applyPatch",
      patch as Parameters<typeof harness.bus.execute<"graph.applyPatch">>[1],
      ctx(alice, options.dryRun === true ? { dryRun: true } : {}),
    );

  it("rejects an addNode with no position instead of throwing, and audits the rejection", async () => {
    const before = graph();
    const result = await raw({
      baseRevision: 0,
      operations: [{ op: "addNode", ref: "$a", type: "test.solid" }],
    });

    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("patch.malformed");
    // The path is what makes a rejected batch fixable.
    expect(result.diagnostics[0]?.message).toContain("operations.0.position");
    expect(graph()).toBe(before);

    // §V31: a refusal is a log entry, not silence.
    const audit = harness.store.view.getAudit();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ command: "graph.applyPatch", status: "rejected", actor: { id: "alice" } });
  });

  /**
   * §V66's second clause, and the reason it is worth a rule of its own: `NaN` survives
   * every `typeof` check, `JSON.stringify` turns it into `null`, and `null` fails the
   * node schema on load — so the document saves and then refuses to reopen. The damage
   * is discovered days later, by which time the session that caused it is gone.
   */
  it("refuses a non-finite position rather than writing a document that cannot reload", async () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY]) {
      harness = createHarness();
      const result = await raw({
        baseRevision: 0,
        operations: [{ op: "addNode", ref: "$a", type: "test.solid", position: { x: bad, y: 0 } }],
      });
      expect(result.status).toBe("rejected");
      expect(result.diagnostics[0]?.code).toBe("patch.malformed");
      expect(nodeCount()).toBe(0);
      expect(JSON.stringify({ x: bad })).toBe('{"x":null}');
    }
  });

  it("refuses a non-finite position on moveNodes too", async () => {
    const built = await apply([addSolid("$a")]);
    const nodeId = built.output.createdIds["$a"] as string;
    const before = graph();

    const result = await raw({
      baseRevision: graph().revision,
      operations: [{ op: "moveNodes", positions: { [nodeId]: { x: 10, y: Number.NaN } } }],
    });

    expect(result.status).toBe("rejected");
    expect(graph()).toBe(before);
  });

  it("rejects an unknown operation, an unknown key and a malformed patch envelope", async () => {
    const cases: unknown[] = [
      { baseRevision: 0, operations: [{ op: "deleteEverything", nodeIds: ["a"] }] },
      // A typo'd key is a caller mistake worth reporting: dropping it silently is how
      // `positon` becomes a node at the origin.
      { baseRevision: 0, operations: [{ op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 }, positon: 1 }] },
      { baseRevision: 0, operations: "not an array" },
      { baseRevision: -1, operations: [] },
      { operations: [] },
      null,
      "nonsense",
    ];
    for (const patchInput of cases) {
      harness = createHarness();
      const result = await raw(patchInput);
      expect(result.status).toBe("rejected");
      expect(result.diagnostics[0]?.code).toBe("patch.malformed");
      expect(harness.store.view.getAudit()).toHaveLength(1);
    }
  });

  it("writes no audit entry when a malformed patch arrives as a dry run (§V36)", async () => {
    const result = await raw({ baseRevision: 0, operations: [{ op: "addNode" }] }, { dryRun: true });
    expect(result.status).toBe("rejected");
    expect(harness.store.view.getAudit()).toHaveLength(0);
  });

  /**
   * Defence in depth for §V31: even a command whose handler has a defect must leave a
   * trace and answer its caller, rather than surfacing as an unhandled rejection.
   */
  it("turns a throwing handler into an audited rejection", async () => {
    harness.bus.registerCommand({
      name: "test.rename",
      handler: () => {
        throw new TypeError("boom");
      },
      rejectionOutput: () => ({ ok: false }),
    });

    const result = await harness.bus.execute("test.rename", { nodeId: "x", label: "y" }, ctx());
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("command.failed");
    // The error's TYPE only: its message may quote untrusted document text (§V37).
    expect(result.diagnostics[0]?.message).toContain("TypeError");
    expect(result.diagnostics[0]?.message).not.toContain("boom");
    expect(harness.store.view.getAudit().at(-1)).toMatchObject({
      command: "test.rename",
      status: "rejected",
    });
  });
});

/**
 * T104 (§V29): groups and the viewport were undoable but uncreatable — the store records
 * group changes in its undo groups, and no operation could write one.
 */
describe("graph.applyPatch — groups and viewport (T104)", () => {
  it("creates a group over nodes made in the same patch and hands back its id (§V35)", async () => {
    const result = await apply([
      addSolid("$a"),
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } },
      {
        op: "addGroup",
        ref: "$g",
        label: "Chain",
        bounds: { x: -20, y: -20, width: 400, height: 200 },
        color: "#334",
        members: ["$a", "$b"],
      },
    ]);

    expect(result.status).toBe("applied");
    const groupId = result.output.createdIds["$g"] as string;
    expect(groupId).toBeDefined();
    const group = graph().groups[groupId];
    expect(group?.label).toBe("Chain");
    expect(group?.color).toBe("#334");
    expect(group?.members).toEqual(
      [result.output.createdIds["$a"], result.output.createdIds["$b"]].sort(),
    );
  });

  it("undoes and redoes a group as one unit (§V34)", async () => {
    const built = await apply([
      addSolid("$a"),
      { op: "addGroup", ref: "$g", label: "One", bounds: { x: 0, y: 0, width: 10, height: 10 }, members: ["$a"] },
    ]);
    const groupId = built.output.createdIds["$g"] as string;
    expect(Object.keys(graph().groups)).toHaveLength(1);

    await harness.bus.execute("graph.undo", {}, ctx());
    expect(graph().groups[groupId]).toBeUndefined();
    expect(nodeCount()).toBe(0);

    await harness.bus.execute("graph.redo", {}, ctx());
    expect(graph().groups[groupId]?.label).toBe("One");
  });

  it("edits a group's fields, clears its colour with null, and deletes it without its nodes", async () => {
    const built = await apply([
      addSolid("$a"),
      { op: "addGroup", ref: "$g", label: "One", bounds: { x: 0, y: 0, width: 10, height: 10 }, color: "#f00", members: ["$a"] },
    ]);
    const groupId = built.output.createdIds["$g"] as string;

    await apply([
      { op: "setGroup", groupId, label: "Renamed", bounds: { x: 5, y: 5, width: 20, height: 20 }, color: null },
    ]);
    const group = graph().groups[groupId];
    expect(group?.label).toBe("Renamed");
    expect(group?.bounds).toEqual({ x: 5, y: 5, width: 20, height: 20 });
    expect(group?.color).toBeUndefined();
    // Untouched fields are left alone by a partial update.
    expect(group?.members).toHaveLength(1);

    const removed = await apply([{ op: "removeGroups", groupIds: [groupId] }]);
    expect(removed.status).toBe("applied");
    expect(graph().groups[groupId]).toBeUndefined();
    // A group is a label over members: deleting it never deletes the nodes.
    expect(nodeCount()).toBe(1);
  });

  it("refuses a group whose member does not exist, and an edit to a group that does not", async () => {
    const missingMember = await apply([
      { op: "addGroup", ref: "$g", label: "x", bounds: { x: 0, y: 0, width: 1, height: 1 }, members: ["nope"] },
    ]);
    expect(missingMember.status).toBe("rejected");
    expect(missingMember.diagnostics[0]?.code).toBe("node.missing");
    expect(Object.keys(graph().groups)).toHaveLength(0);

    const missingGroup = await apply([{ op: "setGroup", groupId: "nope", label: "x" }]);
    expect(missingGroup.status).toBe("rejected");
    expect(missingGroup.diagnostics[0]?.code).toBe("group.missing");
  });

  it("drops a deleted node out of its group (§V40) and keeps the group", async () => {
    const built = await apply([
      addSolid("$a"),
      { op: "addNode", ref: "$b", type: "test.blur", position: { x: 200, y: 0 } },
      { op: "addGroup", ref: "$g", label: "Both", bounds: { x: 0, y: 0, width: 1, height: 1 }, members: ["$a", "$b"] },
    ]);
    const groupId = built.output.createdIds["$g"] as string;
    const removed = built.output.createdIds["$a"] as string;

    await apply([{ op: "removeNodes", nodeIds: [removed] }]);
    expect(graph().groups[groupId]?.members).toEqual([built.output.createdIds["$b"]]);
  });

  it("round-trips the viewport and clears it with null, for an actor that may (T315)", async () => {
    // §V38/T315: `setViewport` is the one operation in this union that is capability
    // gated, because it moves the camera of whoever is looking at the app rather than
    // editing the document. The composition root grants it to the human it constructs;
    // a bare domain bus grants nothing, so the test says who it is acting as.
    harness.bus.grants.grant(alice, "viewportControl");

    const set = await apply([{ op: "setViewport", viewport: { x: -120, y: 40, zoom: 1.5 } }]);
    expect(set.status).toBe("applied");
    expect(graph().viewport).toEqual({ x: -120, y: 40, zoom: 1.5 });

    await apply([{ op: "setViewport", viewport: null }]);
    expect(graph().viewport).toBeUndefined();
  });

  it("refuses the viewport to an actor without the grant, and refuses the WHOLE patch (§V38, §V32)", async () => {
    const before = graph().revision;
    const refused = await apply([
      { op: "moveNodes", positions: {} },
      { op: "setViewport", viewport: { x: 1, y: 2, zoom: 3 } },
    ]);

    expect(refused.status).toBe("rejected");
    expect(refused.output.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "capability.denied",
    );
    expect(graph().viewport).toBeUndefined();
    // Atomic: the operation beside it did not land either, so "all or none" stays true
    // in exactly the case where a caller most needs to know what happened.
    expect(graph().revision).toBe(before);
  });

  it("refuses a viewport with a non-finite coordinate or a non-positive zoom (§V66)", async () => {
    for (const viewport of [
      { x: Number.NaN, y: 0, zoom: 1 },
      { x: 0, y: 0, zoom: 0 },
      { x: 0, y: 0, zoom: -1 },
    ]) {
      const result = await harness.bus.execute(
        "graph.applyPatch",
        { baseRevision: graph().revision, operations: [{ op: "setViewport", viewport }] },
        ctx(),
      );
      expect(result.status).toBe("rejected");
      expect(graph().viewport).toBeUndefined();
    }
  });
});

describe("graph.applyPatch — bind cycles refused at write time (T205, §V110)", () => {
  const bind = (ref: string) => ({ mode: "bind", bindings: { bind: { kind: "bind", ref } } });

  it("rejects a patch whose slots close a loop, discarding the whole draft", async () => {
    const seed = await apply([addSolid("$a")]);
    const nodeId = seed.output.createdIds["$a"] as string;
    const snapshot = graph();

    const result = await apply([
      { op: "setParameters", nodeId, parameters: { amount: bind("label"), label: bind("amount") } as never },
    ]);

    expect(result.status).toBe("rejected");
    expect(result.diagnostics.some((d) => d.code === "parameter.bindCycle")).toBe(true);
    expect(graph()).toBe(snapshot);
  });

  it("rejects a loop that closes through a parameter the patch never touched", async () => {
    const seed = await apply([addSolid("$a")]);
    const nodeId = seed.output.createdIds["$a"] as string;

    const first = await apply([
      { op: "setParameters", nodeId, parameters: { amount: bind("label") } as never },
    ]);
    expect(first.status).toBe("applied");

    // Only `label` is in this patch; the cycle needs the `amount` already stored.
    const second = await apply([
      { op: "setParameters", nodeId, parameters: { label: bind("amount") } as never },
    ]);
    expect(second.status).toBe("rejected");
    expect(second.diagnostics.some((d) => d.code === "parameter.bindCycle")).toBe(true);
  });

  it("accepts an acyclic slot patch — modes are ordinary parameter writes (§V114)", async () => {
    const seed = await apply([addSolid("$a")]);
    const nodeId = seed.output.createdIds["$a"] as string;

    const result = await apply([
      {
        op: "setParameters",
        nodeId,
        parameters: {
          amount: { mode: "expression", bindings: { expression: { kind: "expression", source: "time" } } },
          "color.r": { mode: "static", bindings: { static: { kind: "static", value: 1 } } },
        } as never,
      },
    ]);
    expect(result.status).toBe("applied");
  });
});

describe("graph.applyPatch — op() reference cycles refused at write time (T331, §V152)", () => {
  const expression = (source: string) => ({
    mode: "expression",
    bindings: { expression: { kind: "expression", source } },
  });

  /** Two named solids, `solid1` and `solid2`. */
  async function twoNodes(): Promise<[string, string]> {
    const seed = await apply([addSolid("$a"), addSolid("$b", 100)]);
    return [seed.output.createdIds["$a"] as string, seed.output.createdIds["$b"] as string];
  }

  it("refuses the patch that CLOSES a cross-node loop, and names the path", async () => {
    const [a, b] = await twoNodes();
    // One direction is fine on its own: `solid1` reading `solid2` is a normal reference.
    const first = await apply([
      { op: "setParameters", nodeId: a, parameters: { amount: expression("op('solid2').par.amount") } as never },
    ]);
    expect(first.status).toBe("applied");

    const snapshot = graph();
    const second = await apply([
      { op: "setParameters", nodeId: b, parameters: { amount: expression("op('solid1').par.amount") } as never },
    ]);

    expect(second.status).toBe("rejected");
    const cycle = second.diagnostics.find((d) => d.code === "parameter.referenceCycle");
    expect(cycle?.message).toContain("solid2.amount → solid1.amount → solid2");
    // §V32: the draft is discarded whole, so the document never holds the cycle. This is
    // the point of the gate — the runtime guard that NAMES the loop is a mitigation, and
    // §V244 says a mitigation must not become the reason the gate never gets built.
    expect(graph()).toBe(snapshot);
  });

  it("refuses a node that references ITSELF through op()", async () => {
    const [a] = await twoNodes();
    const result = await apply([
      { op: "setParameters", nodeId: a, parameters: { amount: expression("op('solid1').par.amount") } as never },
    ]);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.some((d) => d.code === "parameter.referenceCycle")).toBe(true);
  });

  it("still accepts an acyclic cross-node reference", async () => {
    const [, b] = await twoNodes();
    const result = await apply([
      { op: "setParameters", nodeId: b, parameters: { amount: expression("op('solid1').par.amount * 2") } as never },
    ]);
    expect(result.status).toBe("applied");
  });

  /**
   * T342 — the hole T331 left: an edge appears when a reference is WRITTEN, and also when
   * a NAME starts resolving. `op('foo')` sitting dangling is not a dependency; the moment
   * something is called `foo` it becomes one, and no `setParameters` was involved.
   */
  it("refuses a RENAME that makes a dangling reference close a loop", async () => {
    const [a, b] = await twoNodes();
    // `solid2` reads a name nothing holds yet — legal, and reported at resolution, not
    // refused: an expression must be writable before its target exists.
    const dangling = await apply([
      { op: "setParameters", nodeId: b, parameters: { amount: expression("op('target').par.amount") } as never },
    ]);
    expect(dangling.status).toBe("applied");
    // `solid1` reads `solid2`, so the loop needs only one more thing: a node called
    // `target`, which is what this rename would make `solid1`.
    const half = await apply([
      { op: "setParameters", nodeId: a, parameters: { amount: expression("op('solid2').par.amount") } as never },
    ]);
    expect(half.status).toBe("applied");

    const snapshot = graph();
    const result = await apply([{ op: "setNodeLabel", nodeId: a, label: "target" }]);

    expect(result.status).toBe("rejected");
    expect(result.diagnostics.some((d) => d.code === "parameter.referenceCycle")).toBe(true);
    // The name did not land either: §V32, and the reason the check runs on the draft.
    expect(graph()).toBe(snapshot);
    expect(graph().nodes[a]?.label).toBe("solid1");
  });

  it("refuses a CREATE whose auto-name reclaims one a dangling reference points at", async () => {
    // §V129 numbers from what is free, with no memory of what still references the name a
    // deleted node held. So a fresh node can be born already referenced.
    const [a] = await twoNodes();
    await apply([
      { op: "setParameters", nodeId: a, parameters: { amount: expression("op('solid3').par.amount") } as never },
    ]);

    const result = await apply([
      {
        op: "addNode",
        ref: "$c",
        type: "test.solid",
        position: { x: 200, y: 0 },
        parameters: { amount: expression("op('solid1').par.amount") },
      } as never,
    ]);

    expect(result.status).toBe("rejected");
    expect(result.diagnostics.some((d) => d.code === "parameter.referenceCycle")).toBe(true);
  });

  it("still allows a rename that only makes a dangling reference RESOLVE", async () => {
    // The non-vacuity of the two above: naming a node something an expression already
    // reads is the normal way a reference starts working, and must stay ordinary.
    const [a, b] = await twoNodes();
    await apply([
      { op: "setParameters", nodeId: b, parameters: { amount: expression("op('target').par.amount") } as never },
    ]);
    const result = await apply([{ op: "setNodeLabel", nodeId: a, label: "target" }]);
    expect(result.status).toBe("applied");
    expect(graph().nodes[a]?.label).toBe("target");
  });

  it("still allows CLEARING a name, which can only remove edges", async () => {
    const [a, b] = await twoNodes();
    await apply([
      { op: "setParameters", nodeId: b, parameters: { amount: expression("op('solid1').par.amount") } as never },
    ]);
    const result = await apply([{ op: "setNodeLabel", nodeId: a, label: null }]);
    expect(result.status).toBe("applied");
    // Stranded, not refused — the right shape for a reference that stops resolving.
    expect(result.diagnostics.some((d) => d.code === "node.name.stranded")).toBe(true);
  });
});

describe("graph.applyPatch — names as identifiers (T221/T222, §V128/§V129)", () => {
  it("auto-names created nodes uniquely, in patch order", async () => {
    const result = await apply([addSolid("$a"), addSolid("$b", 100)]);
    const a = graph().nodes[result.output.createdIds["$a"] as string];
    const b = graph().nodes[result.output.createdIds["$b"] as string];
    expect(a?.label).toBe("solid1");
    expect(b?.label).toBe("solid2");
  });

  it("suffixes a colliding rename instead of rejecting, and says so", async () => {
    const created = await apply([addSolid("$a"), addSolid("$b", 100)]);
    const bId = created.output.createdIds["$b"] as string;
    const result = await apply([{ op: "setNodeLabel", nodeId: bId, label: "solid1" }]);
    expect(result.status).toBe("applied");
    expect(graph().nodes[bId]?.label).toBe("solid12");
    expect(result.diagnostics.some((d) => d.code === "node.name.suffixed")).toBe(true);
  });

  it("a rename rewrites every expression reference in the SAME patch (§V128)", async () => {
    const created = await apply([addSolid("$a"), addSolid("$b", 100)]);
    const aId = created.output.createdIds["$a"] as string;
    const bId = created.output.createdIds["$b"] as string;
    await apply([
      {
        op: "setParameters",
        nodeId: bId,
        parameters: {
          amount: {
            mode: "expression",
            bindings: { expression: { kind: "expression", source: "op('solid1').par.amount" } },
          },
        } as never,
      },
    ]);

    const renamed = await apply([{ op: "setNodeLabel", nodeId: aId, label: "backdrop" }]);
    expect(renamed.status).toBe("applied");
    expect(renamed.diagnostics.some((d) => d.code === "node.name.referencesRewritten")).toBe(true);
    expect(JSON.stringify(graph().nodes[bId]?.parameters["amount"])).toContain("op('backdrop')");
  });

  it("warns when clearing a name that expressions still reference", async () => {
    const created = await apply([addSolid("$a"), addSolid("$b", 100)]);
    const aId = created.output.createdIds["$a"] as string;
    const bId = created.output.createdIds["$b"] as string;
    await apply([
      {
        op: "setParameters",
        nodeId: bId,
        parameters: {
          amount: {
            mode: "expression",
            bindings: { expression: { kind: "expression", source: "op('solid1').par.amount" } },
          },
        } as never,
      },
    ]);
    const cleared = await apply([{ op: "setNodeLabel", nodeId: aId, label: null }]);
    expect(cleared.status).toBe("applied");
    expect(cleared.diagnostics.some((d) => d.code === "node.name.stranded")).toBe(true);
  });
});
