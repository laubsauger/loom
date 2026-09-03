import { beforeEach, describe, expect, it } from "vitest";

import { resolveParameterSchema } from "../parameters/resolve.ts";
import { createNodeReferenceReader } from "../parameters/node-references.ts";
import type { GraphNode } from "../types/graph.ts";
import { validateStoredParameter } from "../parameters/validate.ts";
import type { PulseParameter } from "../types/parameters.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createGraphStore } from "../graph/store.ts";
import { createDomainBus } from "./index.ts";
import type { LoomBus } from "./bus.ts";
import { alice, contextFor, createHarness, patch, type Harness } from "./test-support.ts";

/**
 * Firing a pulse (T214, §V123, §V124, §V125).
 *
 * The claim under test is the awkward one: a pulse is a MUTATION that leaves no trace in
 * the document. It has to be audited (§V31) and it must not be undoable (§V124), and
 * those two pull in opposite directions — everything else in the bus writes an audit
 * entry precisely because it wrote an undo group.
 */

declare module "../types/commands.ts" {
  interface CommandMap {
    "test.clearHistory": { input: { nodeIds?: readonly string[] }; output: { cleared: number } };
  }
}

const context = contextFor(alice);

const rgba = { kind: "texture2d", sample: "float", channels: 4 } as const;

/**
 * A node whose pulse points at the stub below.
 *
 * Declared here rather than by retargeting the shared `test.feedback` fixture: node
 * manifests are module-level singletons, and a test that edits one leaks into every
 * other test in the run.
 */
const pulsingNode: NodeDefinition = {
  type: "test.pulsing",
  version: 1,
  title: "Pulsing",
  category: "temporal",
  inputs: [{ id: "in", label: "In", type: rgba }],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {
    decay: { type: "number", label: "Decay", default: 0.9 },
    resetPulse: {
      type: "pulse",
      label: "Reset",
      fires: "test.clearHistory",
      input: { nodeIds: ["$node"] },
    },
  },
  temporal: { outputs: ["out"], resetOn: ["device", "load"] },
  stateful: { reset: true, deterministicReplay: true, checkpoint: false, randomAccess: false },
  compile: () => ({ passes: [] }),
};

function createPulseHarness(): Harness {
  const store = createGraphStore({
    ids: createSequentialIdFactory("p"),
    now: () => "2026-08-30T00:00:00.000Z",
  });
  const { bus } = createDomainBus({ store, registry: createNodeRegistry([pulsingNode]).view() });
  return { bus, store };
}

async function addNode(bus: LoomBus, type: string): Promise<string> {
  const result = await bus.execute(
    "graph.applyPatch",
    patch(bus.store.getRevision(), [
      { op: "addNode", ref: "$fb", type, position: { x: 0, y: 0 } },
    ]),
    context,
  );
  const id = result.output.createdIds["$fb"];
  if (id === undefined) throw new Error(`the ${type} node was not created`);
  return id;
}

describe("parameter.pulse", () => {
  let harness: Harness;
  let fired: Array<{ nodeIds?: readonly string[] }>;

  beforeEach(() => {
    harness = createPulseHarness();
    fired = [];
    // Stands in for `runtime.resetFeedback`, which the app registers over a live
    // backend. The pulse's own contract is that it names a command and the bus finds it.
    harness.bus.registerCommand({
      name: "test.clearHistory",
      handler: (input) => {
        fired.push(input);
        return { status: "applied", output: { cleared: input.nodeIds?.length ?? 0 } };
      },
    });
  });

  it("fires the command its manifest names, scoped to the firing node", async () => {
    const nodeId = await addNode(harness.bus, "test.pulsing");

    const result = await harness.bus.execute(
      "parameter.pulse",
      { nodeId, parameterKey: "resetPulse" },
      context,
    );

    expect(result.status).toBe("applied");
    expect(result.output.fired).toBe("test.clearHistory");
    // `$node` in the manifest input became this node's id (§V123).
    expect(fired).toEqual([{ nodeIds: [nodeId] }]);
  });

  it("is AUDITED but leaves the document untouched (§V31, §V124)", async () => {
    const nodeId = await addNode(harness.bus, "test.pulsing");
    const revisionBefore = harness.bus.store.getRevision();
    const auditBefore = harness.bus.store.getAudit().length;
    const historyBefore = harness.bus.store.getHistory(alice).undo.length;

    await harness.bus.execute("parameter.pulse", { nodeId, parameterKey: "resetPulse" }, context);

    const entries = harness.bus.store.getAudit();
    expect(entries).toHaveLength(auditBefore + 1);
    expect(entries[entries.length - 1]).toMatchObject({
      command: "parameter.pulse",
      status: "applied",
      actor: alice,
    });
    // Nothing to undo and nothing to save: a cleared buffer is not in the document.
    expect(harness.bus.store.getRevision()).toBe(revisionBefore);
    expect(harness.bus.store.getHistory(alice).undo).toHaveLength(historyBefore);
  });

  it("undo after a pulse rolls back the EDIT before it, not the pulse", async () => {
    const nodeId = await addNode(harness.bus, "test.pulsing");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        { op: "setParameters", nodeId, parameters: { decay: 0.25 } },
      ]),
      context,
    );
    await harness.bus.execute("parameter.pulse", { nodeId, parameterKey: "resetPulse" }, context);

    const undone = await harness.bus.execute("graph.undo", {}, context);

    expect(undone.status).toBe("applied");
    // The parameter edit came back, which is only true if the pulse never entered history.
    expect(harness.bus.store.getGraph().nodes[nodeId]?.parameters["decay"]).toBe(0.9);
  });

  it("refuses loudly when the command it names is not registered", async () => {
    // The shipped fixture's pulse names `runtime.resetFeedback`, which only the app
    // registers over a live backend — so on a domain-only bus it is genuinely missing.
    const plain = createHarness("unregistered");
    const nodeId = await addNode(plain.bus, "test.feedback");

    const result = await plain.bus.execute(
      "parameter.pulse",
      { nodeId, parameterKey: "resetPulse" },
      context,
    );

    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("parameter.pulse.unregistered");
    // A pulse that silently did nothing is the exact failure this indirection prevents.
    expect(fired).toEqual([]);
  });

  it("refuses a key that is not a pulse", async () => {
    const nodeId = await addNode(harness.bus, "test.pulsing");
    const result = await harness.bus.execute(
      "parameter.pulse",
      { nodeId, parameterKey: "decay" },
      context,
    );
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("parameter.pulse.type");
  });

  it("a dry run reports what would fire and fires nothing (§V36)", async () => {
    const nodeId = await addNode(harness.bus, "test.pulsing");
    const auditBefore = harness.bus.store.getAudit().length;

    const result = await harness.bus.execute(
      "parameter.pulse",
      { nodeId, parameterKey: "resetPulse" },
      { ...context, dryRun: true },
    );

    expect(result.status).toBe("validated");
    expect(result.output.fired).toBe("test.clearHistory");
    expect(fired).toEqual([]);
    expect(harness.bus.store.getAudit()).toHaveLength(auditBefore);
  });
});

describe("a pulse can never be stored armed (§V124)", () => {
  const pulse: PulseParameter = { type: "pulse", label: "Reset", fires: "test.clearHistory" };

  it("refuses a bare `true`", () => {
    expect(validateStoredParameter("resetPulse", pulse, true)?.code).toBe("parameter.pulse.stored");
  });

  it("refuses an armed static payload inside a mode envelope", () => {
    const slot = { mode: "static" as const, bindings: { static: { kind: "static" as const, value: true } } };
    expect(validateStoredParameter("resetPulse", pulse, slot)?.code).toBe("parameter.pulse.stored");
  });

  it("accepts a disarmed one, and an expression that drives it (§V125)", () => {
    expect(validateStoredParameter("resetPulse", pulse, false)).toBeNull();
    expect(
      validateStoredParameter("resetPulse", pulse, {
        mode: "expression",
        bindings: { expression: { kind: "expression", source: "frame % 120" } },
      }),
    ).toBeNull();
  });
});

describe("a fresh node stores no pulse at all (§V124)", () => {
  it("omits pulses from the manifest defaults", async () => {
    const harness = createHarness("defaults");
    const nodeId = await addNode(harness.bus, "test.feedback");
    const stored = harness.bus.store.getGraph().nodes[nodeId]?.parameters ?? {};
    expect(Object.keys(stored).sort()).toEqual(["decay", "reset"]);
  });
});

/* ====================================================================================
 * The parameter context menu's commands (T246, §V148, §V149)
 * ================================================================================= */

const menuNode: NodeDefinition = {
  type: "test.menu",
  version: 1,
  title: "Menu",
  category: "test",
  inputs: [],
  outputs: [{ id: "out", label: "Out", type: rgba }],
  parameters: {
    radius: { type: "number", label: "Radius", default: 4, min: 0, max: 64 },
    amount: { type: "number", label: "Amount", default: 1, min: 0, max: 64 },
    tint: { type: "color", label: "Tint", default: [1, 1, 1, 1], space: "display" },
    title: { type: "string", label: "Title", default: "" },
  },
  compile: () => ({ passes: [] }),
};

function createMenuHarness(copied: string[] = []): Harness {
  const store = createGraphStore({
    ids: createSequentialIdFactory("m"),
    now: () => "2026-08-30T00:00:00.000Z",
  });
  const { bus } = createDomainBus({
    store,
    registry: createNodeRegistry([menuNode]).view(),
    clipboard: (text) => copied.push(text),
  });
  return { bus, store };
}

async function named(bus: LoomBus, name: string): Promise<string> {
  const nodeId = await addNode(bus, "test.menu");
  await bus.execute(
    "graph.applyPatch",
    patch(bus.store.getRevision(), [{ op: "setNodeLabel", nodeId, label: name }]),
    context,
  );
  return nodeId;
}

function storedOf(harness: Harness, nodeId: string, key: string): unknown {
  return harness.bus.store.getGraph().nodes[nodeId]?.parameters[key];
}

describe("copy (T246)", () => {
  it("copies the EFFECTIVE value, which is what the user can see", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        {
          op: "setParameters",
          nodeId,
          parameters: {
            radius: {
              mode: "expression",
              bindings: { expression: { kind: "expression", source: "3 + 4" } },
            },
          },
        },
      ]),
      context,
    );

    const result = await harness.bus.execute(
      "parameter.copyValue",
      { nodeId, parameterKey: "radius" },
      context,
    );
    // 7, not the stored expression text: copying off a driven parameter is only ever
    // done to get the number.
    expect(result.output.text).toBe("7");
  });

  it("mirrors what it copied to the system clipboard, when one was supplied (§V148)", async () => {
    const copied: string[] = [];
    const harness = createMenuHarness(copied);
    const nodeId = await named(harness.bus, "blur1");

    await harness.bus.execute("parameter.copyReference", { nodeId, parameterKey: "radius" }, context);

    // The string has to be able to LEAVE the app, or it can never reach an expression field.
    expect(copied).toEqual(["op('blur1').par.radius"]);
  });

  it("refuses to reference an unnamed node rather than inventing a name (§V127)", async () => {
    const harness = createMenuHarness();
    const nodeId = await addNode(harness.bus, "test.menu");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [{ op: "setNodeLabel", nodeId, label: null }]),
      context,
    );

    const result = await harness.bus.execute(
      "parameter.copyReference",
      { nodeId, parameterKey: "radius" },
      context,
    );
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("parameter.reference.unnamed");
  });
});

describe("copy → paste → the value is the source's (§V148)", () => {
  /**
   * The round trip the invariant asks for, run all the way through the resolver — which
   * is what a control shows AND what the compiler reads (§V61). A same-node reference
   * becomes a `bind`, and a bind resolves everywhere today.
   */
  it("a reference pasted onto a sibling resolves to the source parameter's value", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        { op: "setParameters", nodeId, parameters: { radius: 12 } },
      ]),
      context,
    );

    const copied = await harness.bus.execute(
      "parameter.copyReference",
      { nodeId, parameterKey: "radius" },
      context,
    );
    const pasted = await harness.bus.execute(
      "parameter.paste",
      { nodeId, parameterKey: "amount" },
      context,
    );
    expect(pasted.status).toBe("applied");

    const node = harness.bus.store.getGraph().nodes[nodeId];
    if (node === undefined) throw new Error("the node vanished");
    const resolved = resolveParameterSchema(node, menuNode.parameters);
    expect(resolved.get("amount")?.value).toBe(12);
    // And the source value MOVES with it: this is a reference, not a copy of a number.
    expect(copied.output.text).toBe("op('blur1').par.radius");
  });

  it("the reference reaches the same value when pasted as TEXT, not through the bus", async () => {
    // The other door §V148 cares about: a string that went out to the system clipboard
    // and came back through a paste has to be read by the same command.
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        { op: "setParameters", nodeId, parameters: { radius: 9 } },
      ]),
      context,
    );

    await harness.bus.execute(
      "parameter.paste",
      { nodeId, parameterKey: "amount", text: " op('blur1').par.radius " },
      context,
    );

    const node = harness.bus.store.getGraph().nodes[nodeId];
    if (node === undefined) throw new Error("the node vanished");
    expect(resolveParameterSchema(node, menuNode.parameters).get("amount")?.value).toBe(9);
  });

  it("refuses a self-reference instead of storing a cycle", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await harness.bus.execute("parameter.copyReference", { nodeId, parameterKey: "radius" }, context);
    const result = await harness.bus.execute(
      "parameter.paste",
      { nodeId, parameterKey: "radius" },
      context,
    );
    expect(result.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.code).toBe("parameter.reference.self");
  });

  /**
   * §V148's round trip, COMPLETE across nodes (T316).
   *
   * This test used to assert the opposite — that a cross-node reference stored correctly
   * and then failed loudly, because `evaluate.ts` could not read `op()` yet. The loud
   * failure was the right behaviour to have while the read path did not exist (§V148
   * narrowed the claim rather than pretending), and it is the wrong behaviour now: the
   * invariant asks for copy → paste → evaluate == the source's value, and that is what
   * is asserted here.
   */
  it("copies a reference across nodes and reads the source's value back (§V148, T316)", async () => {
    const harness = createMenuHarness();
    const source = await named(harness.bus, "blur1");
    const target = await named(harness.bus, "blur2");

    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        { op: "setParameters", nodeId: source, parameters: { radius: 17 } },
      ]),
      context,
    );

    await harness.bus.execute("parameter.copyReference", { nodeId: source, parameterKey: "radius" }, context);
    await harness.bus.execute("parameter.paste", { nodeId: target, parameterKey: "amount" }, context);

    const stored = storedOf(harness, target, "amount");
    expect(stored).toMatchObject({
      mode: "expression",
      bindings: { expression: { source: "op('blur1').par.radius" } },
    });

    const graph = harness.bus.store.getGraph();
    const node = graph.nodes[target];
    if (node === undefined) throw new Error("the node vanished");

    // The reader is the seam (§V61): resolving WITHOUT one still reports, because a
    // caller that cannot see the graph must not invent a number.
    const unreadable = resolveParameterSchema(node, menuNode.parameters);
    expect(unreadable.get("amount")?.diagnostic?.code).toBe("parameter.expression");

    // With it, the round trip closes: the pasted reference is worth what it points at.
    const resolved = resolveParameterSchema(node, menuNode.parameters, {
      nodes: createNodeReferenceReader({ graph, schemaOf: () => menuNode.parameters }),
    });
    expect(resolved.get("amount")?.diagnostic).toBeNull();
    expect(resolved.get("amount")?.value).toBe(17);

    // ...and it TRACKS the source rather than having copied it: editing `blur1` moves
    // `blur2`, which is the difference between a reference and a paste of a value.
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        { op: "setParameters", nodeId: source, parameters: { radius: 4 } },
      ]),
      context,
    );
    const after = harness.bus.store.getGraph();
    const moved = resolveParameterSchema(after.nodes[target] as GraphNode, menuNode.parameters, {
      nodes: createNodeReferenceReader({ graph: after, schemaOf: () => menuNode.parameters }),
    });
    expect(moved.get("amount")?.value).toBe(4);
  });
});

describe("paste a value (T246)", () => {
  it("lands the copied number on another parameter", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        { op: "setParameters", nodeId, parameters: { radius: 21 } },
      ]),
      context,
    );

    await harness.bus.execute("parameter.copyValue", { nodeId, parameterKey: "radius" }, context);
    await harness.bus.execute("parameter.paste", { nodeId, parameterKey: "amount" }, context);

    expect(storedOf(harness, nodeId, "amount")).toBe(21);
  });

  it("refuses a value the target's manifest does not accept, rather than coercing it", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await harness.bus.execute("parameter.copyValue", { nodeId, parameterKey: "tint" }, context);

    const result = await harness.bus.execute(
      "parameter.paste",
      { nodeId, parameterKey: "radius" },
      context,
    );
    // Pasting a colour onto a number must say so, not quietly land the red channel.
    expect(result.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.code).toBe("parameter.type");
  });

  it("says the clipboard is empty rather than doing nothing", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    const result = await harness.bus.execute(
      "parameter.paste",
      { nodeId, parameterKey: "radius" },
      context,
    );
    expect(result.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.code).toBe("parameter.clipboard.empty");
  });
});

/* ====================================================================================
 * Copy captures everything; PASTE decides (T1004 — §V108, §V148, §V288)
 *
 * The owner's design point, and TouchDesigner's: deciding at COPY time asks the user to
 * predict what they will want when they get to the other node, and they cannot. So one
 * copy captures the value snapshot, the reference and the active binding, and the three
 * paste rows each land a DIFFERENT member of that one payload.
 *
 * Every test below asserts WHICH MEMBER landed, never merely that a paste happened: an
 * implementation that pasted the value where the reference belongs stores something, and
 * a test asserting `status === "applied"` would sign it off.
 * ================================================================================= */

/** A parameter running `3 + 4` — worth 7, carrying an expression binding. */
async function withExpressionOn(
  harness: Harness,
  nodeId: string,
  key: string,
  source: string,
): Promise<void> {
  await harness.bus.execute(
    "graph.applyPatch",
    patch(harness.bus.store.getRevision(), [
      {
        op: "setParameters",
        nodeId,
        parameters: {
          [key]: {
            mode: "expression",
            bindings: {
              expression: { kind: "expression", source },
              static: { kind: "static", value: 2 },
            },
          },
        },
      },
    ]),
    context,
  );
}

/**
 * A target that already HOLDS something in a mode it is not running — the §V108 corner
 * mark's promise, and the thing every paste below must leave standing.
 */
async function withRetainedExpression(
  harness: Harness,
  nodeId: string,
  key: string,
): Promise<void> {
  await harness.bus.execute(
    "graph.applyPatch",
    patch(harness.bus.store.getRevision(), [
      {
        op: "setParameters",
        nodeId,
        parameters: {
          [key]: {
            mode: "static",
            bindings: {
              static: { kind: "static", value: 5 },
              expression: { kind: "expression", source: "40 + 2" },
            },
          },
        },
      },
    ]),
    context,
  );
}

describe("one copy, three pastes (T1004)", () => {
  it("lands the VALUE SNAPSHOT — the number, not the expression that made it", async () => {
    const harness = createMenuHarness();
    const source = await named(harness.bus, "blur1");
    const target = await named(harness.bus, "blur2");
    await withExpressionOn(harness, source, "radius", "3 + 4");
    await withRetainedExpression(harness, target, "amount");

    await harness.bus.execute("parameter.copy", { nodeId: source, parameterKey: "radius" }, context);
    const pasted = await harness.bus.execute(
      "parameter.paste",
      { nodeId: target, parameterKey: "amount", as: "value" },
      context,
    );
    expect(pasted.status).toBe("applied");

    // 7 — what the source was WORTH at copy time. Not "3 + 4", which is what a paste of
    // the binding would have landed, and not `op('blur1').par.radius`, which is what a
    // paste of the reference would have landed. Those are the two swaps this pins down.
    expect(storedOf(harness, target, "amount")).toMatchObject({
      mode: "static",
      bindings: { static: { kind: "static", value: 7 } },
    });
    // §V108: the target's retained expression is STILL THERE. A paste that wiped it
    // would make the corner mark a lie exactly where a user experiments most.
    expect(storedOf(harness, target, "amount")).toMatchObject({
      bindings: { expression: { kind: "expression", source: "40 + 2" } },
    });
    // And it is a SNAPSHOT: moving the source leaves the pasted number where it was.
    await withExpressionOn(harness, source, "radius", "3 + 40");
    const node = harness.bus.store.getGraph().nodes[target];
    if (node === undefined) throw new Error("the node vanished");
    expect(resolveParameterSchema(node, menuNode.parameters).get("amount")?.value).toBe(7);
  });

  it("lands the REFERENCE — a live pointer, not the number it was worth", async () => {
    const harness = createMenuHarness();
    const source = await named(harness.bus, "blur1");
    const target = await named(harness.bus, "blur2");
    await withExpressionOn(harness, source, "radius", "3 + 4");
    await withRetainedExpression(harness, target, "amount");

    await harness.bus.execute("parameter.copy", { nodeId: source, parameterKey: "radius" }, context);
    await harness.bus.execute(
      "parameter.paste",
      { nodeId: target, parameterKey: "amount", as: "reference" },
      context,
    );

    // `op('blur1').par.radius`, NOT `3 + 4` (the binding) and NOT `7` (the value).
    expect(storedOf(harness, target, "amount")).toMatchObject({
      mode: "expression",
      bindings: { expression: { kind: "expression", source: "op('blur1').par.radius" } },
    });
    // §V108: the target's own retained static rode through the mode change.
    expect(storedOf(harness, target, "amount")).toMatchObject({
      bindings: { static: { kind: "static", value: 5 } },
    });

    // The difference that makes it a reference: the target MOVES when the source does.
    const read = (): unknown => {
      const graph = harness.bus.store.getGraph();
      const node = graph.nodes[target];
      if (node === undefined) throw new Error("the node vanished");
      return resolveParameterSchema(node, menuNode.parameters, {
        nodes: createNodeReferenceReader({ graph, schemaOf: () => menuNode.parameters }),
      }).get("amount")?.value;
    };
    expect(read()).toBe(7);
    await withExpressionOn(harness, source, "radius", "3 + 40");
    expect(read()).toBe(43);
  });

  it("lands the BINDING — the source's own expression, evaluated here", async () => {
    const harness = createMenuHarness();
    const source = await named(harness.bus, "blur1");
    const target = await named(harness.bus, "blur2");
    await withExpressionOn(harness, source, "radius", "3 + 4");
    await withRetainedExpression(harness, target, "amount");

    await harness.bus.execute("parameter.copy", { nodeId: source, parameterKey: "radius" }, context);
    await harness.bus.execute(
      "parameter.paste",
      { nodeId: target, parameterKey: "amount", as: "binding" },
      context,
    );

    // The SOURCE TEXT `3 + 4`, not the reference and not the number. This is the member
    // that is a copy of the authoring rather than of the result.
    expect(storedOf(harness, target, "amount")).toMatchObject({
      mode: "expression",
      bindings: { expression: { kind: "expression", source: "3 + 4" } },
    });
    // §V108: only the mode being pasted is overwritten; the retained static survives.
    expect(storedOf(harness, target, "amount")).toMatchObject({
      bindings: { static: { kind: "static", value: 5 } },
    });

    // ...and it is a COPY of the authoring, so it does NOT track the source.
    await withExpressionOn(harness, source, "radius", "3 + 40");
    const node = harness.bus.store.getGraph().nodes[target];
    if (node === undefined) throw new Error("the node vanished");
    expect(resolveParameterSchema(node, menuNode.parameters).get("amount")?.value).toBe(7);
  });

  it("carries all three members whichever COPY row was clicked", async () => {
    // The design point itself: "Copy value" then "Paste reference" works, because the
    // decision belongs to paste. Only the SYSTEM clipboard string was chosen at copy.
    const copied: string[] = [];
    const harness = createMenuHarness(copied);
    const source = await named(harness.bus, "blur1");
    const target = await named(harness.bus, "blur2");
    await withExpressionOn(harness, source, "radius", "3 + 4");

    await harness.bus.execute("parameter.copyValue", { nodeId: source, parameterKey: "radius" }, context);
    // One string went out, and it is the VALUE — that choice is still made at copy time,
    // because a system clipboard holds exactly one.
    expect(copied).toEqual(["7"]);

    await harness.bus.execute(
      "parameter.paste",
      { nodeId: target, parameterKey: "amount", as: "binding" },
      context,
    );
    expect(storedOf(harness, target, "amount")).toMatchObject({
      mode: "expression",
      bindings: { expression: { kind: "expression", source: "3 + 4" } },
    });
  });

  it("mirrors the REFERENCE outward, so the copied parameter can leave the app (§V148)", async () => {
    const copied: string[] = [];
    const harness = createMenuHarness(copied);
    const nodeId = await named(harness.bus, "blur1");
    await harness.bus.execute("parameter.copy", { nodeId, parameterKey: "radius" }, context);
    expect(copied).toEqual(["op('blur1').par.radius"]);
  });

  it("still captures from an UNNAMED node, mirroring the value it cannot reference", async () => {
    // `copyReference` refuses here (§V127) because the string is its whole product.
    // `parameter.copy` captured a value and a binding regardless, so refusing would
    // throw away two members over the absence of a third.
    const copied: string[] = [];
    const harness = createMenuHarness(copied);
    const nodeId = await addNode(harness.bus, "test.menu");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        { op: "setNodeLabel", nodeId, label: null },
        { op: "setParameters", nodeId, parameters: { radius: 33 } },
      ]),
      context,
    );

    const copy = await harness.bus.execute("parameter.copy", { nodeId, parameterKey: "radius" }, context);
    expect(copy.status).toBe("applied");
    expect(copied).toEqual(["33"]);

    await harness.bus.execute(
      "parameter.paste",
      { nodeId, parameterKey: "amount", as: "value" },
      context,
    );
    expect(storedOf(harness, nodeId, "amount")).toBe(33);
  });

  it("keeps ONE answer for a same-node reference: the bind that resolves locally", async () => {
    // `as: "reference"` and the legacy default run the same branch (§V109) — a sibling
    // reference is stored as the bind that already resolves everywhere (§V61).
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        { op: "setParameters", nodeId, parameters: { radius: 12 } },
      ]),
      context,
    );

    await harness.bus.execute("parameter.copy", { nodeId, parameterKey: "radius" }, context);
    await harness.bus.execute(
      "parameter.paste",
      { nodeId, parameterKey: "amount", as: "reference" },
      context,
    );
    expect(storedOf(harness, nodeId, "amount")).toMatchObject({
      mode: "bind",
      bindings: { bind: { kind: "bind", ref: "radius" } },
    });
  });
});

describe("a paste that cannot complete refuses BY NAME (§V288, T1004)", () => {
  it("says the copied parameter is a constant rather than hiding Paste binding", async () => {
    const harness = createMenuHarness();
    const source = await named(harness.bus, "blur1");
    const target = await named(harness.bus, "blur2");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        { op: "setParameters", nodeId: source, parameters: { radius: 11 } },
      ]),
      context,
    );

    await harness.bus.execute("parameter.copy", { nodeId: source, parameterKey: "radius" }, context);
    const result = await harness.bus.execute(
      "parameter.paste",
      { nodeId: target, parameterKey: "amount", as: "binding" },
      context,
    );

    expect(result.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.code).toBe("parameter.paste.noBinding");
    // The refusal SAYS WHAT IT NEEDED, which is the whole difference from a missing row.
    expect(result.output.diagnostics[0]?.message).toContain("constant");
    // ...and nothing was written: `amount` is still the manifest default.
    expect(storedOf(harness, target, "amount")).toBe(1);
  });

  it("says an unnamed source cannot be referenced rather than hiding Paste reference", async () => {
    const harness = createMenuHarness();
    const source = await addNode(harness.bus, "test.menu");
    const target = await named(harness.bus, "blur2");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [{ op: "setNodeLabel", nodeId: source, label: null }]),
      context,
    );

    await harness.bus.execute("parameter.copy", { nodeId: source, parameterKey: "radius" }, context);
    const result = await harness.bus.execute(
      "parameter.paste",
      { nodeId: target, parameterKey: "amount", as: "reference" },
      context,
    );

    expect(result.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.code).toBe("parameter.paste.noReference");
    expect(result.output.diagnostics[0]?.suggestion).toContain("Name the node");
    expect(storedOf(harness, target, "amount")).toBe(1);
  });

  it("refuses a REFERENCE that would have to reshape a colour into a number", async () => {
    // The type question the value path already answers, asked of the pointer paths: an
    // expression resolves to ONE value of the target's shape, so `op('x').par.tint` on a
    // number is a category error — and it would otherwise surface much later, as a
    // diagnostic on a parameter the user does not remember touching.
    const harness = createMenuHarness();
    const source = await named(harness.bus, "blur1");
    const target = await named(harness.bus, "blur2");

    await harness.bus.execute("parameter.copy", { nodeId: source, parameterKey: "tint" }, context);
    const result = await harness.bus.execute(
      "parameter.paste",
      { nodeId: target, parameterKey: "amount", as: "reference" },
      context,
    );

    expect(result.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.code).toBe("parameter.paste.shape");
    // Names BOTH sides and the fix (§V113's component reference).
    expect(result.output.diagnostics[0]?.message).toContain("tint");
    expect(result.output.diagnostics[0]?.suggestion).toContain("op('blur1').par.tint.r");
    expect(storedOf(harness, target, "amount")).toBe(1);
  });

  it("refuses a BINDING of the wrong shape too, not only a reference", async () => {
    const harness = createMenuHarness();
    const source = await named(harness.bus, "blur1");
    const target = await named(harness.bus, "blur2");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        {
          op: "setParameters",
          nodeId: source,
          parameters: {
            tint: { mode: "bind", bindings: { bind: { kind: "bind", ref: "other" } } },
          },
        },
      ]),
      context,
    );

    await harness.bus.execute("parameter.copy", { nodeId: source, parameterKey: "tint" }, context);
    const result = await harness.bus.execute(
      "parameter.paste",
      { nodeId: target, parameterKey: "amount", as: "binding" },
      context,
    );

    expect(result.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.code).toBe("parameter.paste.shape");
  });

  it("still refuses a VALUE the target's manifest cannot hold (unchanged, T246)", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await harness.bus.execute("parameter.copy", { nodeId, parameterKey: "tint" }, context);
    const result = await harness.bus.execute(
      "parameter.paste",
      { nodeId, parameterKey: "radius", as: "value" },
      context,
    );
    expect(result.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.code).toBe("parameter.type");
  });

  it("allows a same-shape paste across types, because an expression really does coerce", async () => {
    // The guard is arity, not identity: `radius` → `amount` are both scalars and the
    // paste lands. A guard that also swallowed this would be testing nothing legitimate.
    const harness = createMenuHarness();
    const source = await named(harness.bus, "blur1");
    const target = await named(harness.bus, "blur2");
    await harness.bus.execute("parameter.copy", { nodeId: source, parameterKey: "radius" }, context);
    const result = await harness.bus.execute(
      "parameter.paste",
      { nodeId: target, parameterKey: "amount", as: "reference" },
      context,
    );
    expect(result.status).toBe("applied");
  });
});

describe("a payload that crossed the system clipboard as TEXT (§V148, T1004)", () => {
  it("reads a reference back through the same command", async () => {
    const harness = createMenuHarness();
    const source = await named(harness.bus, "blur1");
    const target = await named(harness.bus, "blur2");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        { op: "setParameters", nodeId: source, parameters: { radius: 9 } },
      ]),
      context,
    );

    await harness.bus.execute(
      "parameter.paste",
      { nodeId: target, parameterKey: "amount", as: "reference", text: " op('blur1').par.radius " },
      context,
    );
    expect(storedOf(harness, target, "amount")).toMatchObject({
      mode: "expression",
      bindings: { expression: { kind: "expression", source: "op('blur1').par.radius" } },
    });
  });

  it("refuses malformed JSON cleanly instead of throwing", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    const result = await harness.bus.execute(
      "parameter.paste",
      { nodeId, parameterKey: "amount", as: "value", text: "[1, 2," },
      context,
    );
    // `JSON.parse` throws on this; the command must convert that into a refusal, because
    // a paste of someone else's clipboard is the ordinary case, not an exceptional one.
    expect(result.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.code).toBe("parameter.clipboard.unreadable");
  });

  it("refuses a FOREIGN payload by type rather than storing it", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    const result = await harness.bus.execute(
      "parameter.paste",
      { nodeId, parameterKey: "amount", as: "value", text: '{"kind":"something/else","v":1}' },
      context,
    );
    expect(result.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.code).toBe("parameter.type");
    // Untouched: still the manifest default, not the JSON text.
    expect(storedOf(harness, nodeId, "amount")).toBe(1);
  });

  it("says text carries no binding rather than pasting the string as one", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    const result = await harness.bus.execute(
      "parameter.paste",
      { nodeId, parameterKey: "amount", as: "binding", text: "op('blur1').par.radius" },
      context,
    );
    expect(result.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.code).toBe("parameter.paste.noBinding");
  });

  it("refuses to land a reference STRING as a literal value", async () => {
    // The silent-success failure this module's header is about: `op('a').par.b` is also a
    // perfectly good string, and a `Title` that says so references nothing.
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    const result = await harness.bus.execute(
      "parameter.paste",
      { nodeId, parameterKey: "title", as: "value", text: "op('blur1').par.radius" },
      context,
    );
    expect(result.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.code).toBe("parameter.paste.textIsReference");
    // The literal `op('blur1').par.radius` did NOT land in the string parameter.
    expect(storedOf(harness, nodeId, "title")).toBe("");
  });
});

describe("reset restores value AND mode (§V149)", () => {
  async function withExpression(harness: Harness, nodeId: string): Promise<void> {
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        {
          op: "setParameters",
          nodeId,
          parameters: {
            radius: {
              mode: "expression",
              bindings: {
                expression: { kind: "expression", source: "8" },
                static: { kind: "static", value: 30 },
              },
            },
          },
        },
      ]),
      context,
    );
  }

  it("puts the value back AND the mode back to Constant", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await withExpression(harness, nodeId);

    const result = await harness.bus.execute(
      "parameter.reset",
      { nodeId, parameterKey: "radius" },
      context,
    );

    expect(result.status).toBe("applied");
    expect(storedOf(harness, nodeId, "radius")).toMatchObject({
      mode: "static",
      bindings: { static: { value: 4 } },
    });
  });

  it("SAYS what it cleared instead of silently dropping authored work", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await withExpression(harness, nodeId);

    const result = await harness.bus.execute(
      "parameter.reset",
      { nodeId, parameterKey: "radius" },
      context,
    );

    expect(result.output.clearedMode).toBe("expression");
    const said = result.diagnostics.find((entry) => entry.code === "parameter.reset.cleared");
    expect(said?.message).toContain("expression");
  });

  it("KEEPS the retained expression — clearing the mode is not clearing its memory", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await withExpression(harness, nodeId);

    await harness.bus.execute("parameter.reset", { nodeId, parameterKey: "radius" }, context);

    // §V108's corner mark promises the expression is still on its own button. A reset
    // that wiped it would make that mark a lie exactly where a user most needs it.
    expect(storedOf(harness, nodeId, "radius")).toMatchObject({
      bindings: { expression: { source: "8" } },
    });
  });

  it("says nothing when there was nothing to clear", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        { op: "setParameters", nodeId, parameters: { radius: 12 } },
      ]),
      context,
    );

    const result = await harness.bus.execute(
      "parameter.reset",
      { nodeId, parameterKey: "radius" },
      context,
    );
    expect(result.output.clearedMode).toBeNull();
    expect(storedOf(harness, nodeId, "radius")).toBe(4);
  });

  it("resets every CHANNEL of a compound in ONE patch (§V113, §V114)", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        {
          op: "setParameters",
          nodeId,
          parameters: {
            tint: [0.2, 0.2, 0.2, 1],
            "tint.g": {
              mode: "expression",
              bindings: { expression: { kind: "expression", source: "0.5" } },
            },
          },
        },
      ]),
      context,
    );
    const before = harness.bus.store.getRevision();

    await harness.bus.execute("parameter.reset", { nodeId, parameterKey: "tint" }, context);

    // One revision bump: a colour reset is one undo entry, not five.
    expect(harness.bus.store.getRevision()).toBe(before + 1);
    expect(storedOf(harness, nodeId, "tint")).toEqual([1, 1, 1, 1]);
    // The channel that was driving itself is Constant again — otherwise the swatch would
    // still not show the default and the user would have "reset" twice.
    expect(storedOf(harness, nodeId, "tint.g")).toMatchObject({ mode: "static" });
  });
});

describe("switching modes from the menu (§V107, §V108)", () => {
  it("switches to Expression, seeded with the value you were looking at", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        { op: "setParameters", nodeId, parameters: { radius: 12 } },
      ]),
      context,
    );

    await harness.bus.execute(
      "parameter.setMode",
      { nodeId, parameterKey: "radius", mode: "expression" },
      context,
    );

    expect(storedOf(harness, nodeId, "radius")).toMatchObject({
      mode: "expression",
      bindings: { expression: { source: "12" }, static: { value: 12 } },
    });
  });

  it("refuses Bind from a menu, because a menu cannot ask for the ref", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    const result = await harness.bus.execute(
      "parameter.setMode",
      { nodeId, parameterKey: "radius", mode: "bind" },
      context,
    );
    // An empty bind ref is refused at write time, so seeding one would make the menu
    // item silently inert — the failure T204's buttons already learned the hard way.
    expect(result.status).toBe("rejected");
    expect(result.output.diagnostics[0]?.code).toBe("parameter.mode.payload");
  });

  it("refuses Map BY NAME — a named refusal teaches what the mode needs, a missing item nothing (B45, §V288)", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    const result = await harness.bus.execute(
      "parameter.setMode",
      { nodeId, parameterKey: "radius", mode: "map" },
      context,
    );
    expect(result.status).toBe("rejected");
    const diagnostic = result.output.diagnostics[0];
    expect(diagnostic?.code).toBe("parameter.mode.payload");
    // The refusal names the mode — this is the menu's fifth item doing its teaching.
    expect(diagnostic?.message).toContain("map");
  });

  it("keeps the payload of the mode it left (§V108)", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "blur1");
    await harness.bus.execute(
      "parameter.setMode",
      { nodeId, parameterKey: "radius", mode: "expression" },
      context,
    );
    await harness.bus.execute(
      "parameter.setMode",
      { nodeId, parameterKey: "radius", mode: "static" },
      context,
    );
    expect(storedOf(harness, nodeId, "radius")).toMatchObject({
      mode: "static",
      bindings: { expression: { source: "4" } },
    });
  });
});

/**
 * T1008 — COMMANDS ADDRESS COMPOUND COMPONENTS. §V113 declares `color.g` / `t.x`
 * component-addressable and the STORE honours it (the inspector's channel rows write
 * dotted keys daily) — but `locate()` looked keys up as `schema[key]`, which holds only
 * base keys, so every command door refused `parameter.unknown` on a key the document
 * demonstrably carries. Both directions matter: the copy must capture what the CHANNEL
 * ROW SHOWS (a component that follows its compound has no slot of its own, and resolving
 * the dotted key against the derived scalar's default would copy the DECLARED default
 * off a channel visibly holding something else), and a genuinely wrong component must
 * still refuse.
 */
describe("compound component addressing (T1008)", () => {
  it("copies the component the channel row shows — the compound's live value, not the default", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "grade1");
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.bus.store.getRevision(), [
        { op: "setParameters", nodeId, parameters: { tint: [0.25, 0.8, 0.5, 1] } },
      ]),
      context,
    );
    const result = await harness.bus.execute(
      "parameter.copyValue",
      { nodeId, parameterKey: "tint.g" },
      context,
    );
    // 0.8 — the visible channel. The pre-T1008 refusal was parameter.unknown; the
    // subtler wrong answer would be 1 (tint's declared default component).
    expect(result.status).toBe("applied");
    expect(result.output.text).toBe("0.8");
  });

  it("copyReference on a component writes the §V113 dotted reference", async () => {
    const copied: string[] = [];
    const harness = createMenuHarness(copied);
    const nodeId = await named(harness.bus, "grade1");
    const result = await harness.bus.execute(
      "parameter.copyReference",
      { nodeId, parameterKey: "tint.g" },
      context,
    );
    expect(result.status).toBe("applied");
    expect(result.output.text).toBe("op('grade1').par.tint.g");
  });

  it("paste lands on the dotted key the store already honours", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "grade1");
    const pasted = await harness.bus.execute(
      "parameter.paste",
      { nodeId, parameterKey: "tint.g", text: "0.5" },
      context,
    );
    expect(pasted.status).toBe("applied");
    expect(storedOf(harness, nodeId, "tint.g")).toBe(0.5);
  });

  it("still refuses a component the compound does not have, and a dot on a scalar", async () => {
    const harness = createMenuHarness();
    const nodeId = await named(harness.bus, "grade1");
    const wrongComponent = await harness.bus.execute(
      "parameter.copyValue",
      { nodeId, parameterKey: "tint.q" },
      context,
    );
    expect(wrongComponent.status).toBe("rejected");
    expect(wrongComponent.diagnostics[0]?.code).toBe("parameter.unknown");
    const scalarDot = await harness.bus.execute(
      "parameter.copyValue",
      { nodeId, parameterKey: "radius.x" },
      context,
    );
    expect(scalarDot.status).toBe("rejected");
    expect(scalarDot.diagnostics[0]?.code).toBe("parameter.unknown");
  });
});
