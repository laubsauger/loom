import { beforeEach, describe, expect, it } from "vitest";

import { validateStoredParameter } from "../parameters/validate.ts";
import type { PulseParameter } from "../types/parameters.ts";
import type { NodeDefinition } from "../types/node-definition.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createGraphStore } from "../graph/store.ts";
import { createDomainBus } from "./index.ts";
import type { ShaderloomBus } from "./bus.ts";
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

async function addNode(bus: ShaderloomBus, type: string): Promise<string> {
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
