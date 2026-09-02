import { beforeEach, describe, expect, it } from "vitest";

import type { NodeId } from "../types/ids.ts";
import { alice, agent, contextFor, createHarness, patch, type Harness } from "./test-support.ts";
import { CapabilityDeniedError, InvalidInvocationError, UnknownCommandError, UnknownQueryError } from "./bus.ts";
import { createCapabilityGrantStore } from "./grants.ts";

/**
 * Bus invariants: §V29 §V30 §V31 §V36 §V38 §V39.
 *
 * The augmentation below is also the test of §V39: a feature module adds a command by
 * declaration-merging `CommandMap`, with no change to the bus interface. Every adapter
 * (WebMCP, MCP server, UI) extends the surface the same way.
 */
declare module "../types/commands.ts" {
  interface CommandMap {
    "test.rename": { input: { nodeId: NodeId; label: string }; output: { ok: boolean } };
    "test.exportSomething": { input: Record<string, never>; output: { ok: boolean } };
  }
  interface QueryMap {
    "test.count": { input: Record<string, never>; output: number };
  }
}

let harness: Harness;

beforeEach(() => {
  harness = createHarness();
});

const addSolid = () =>
  harness.bus.execute(
    "graph.applyPatch",
    patch(harness.store.view.getRevision(), [
      { op: "addNode", ref: "$a", type: "test.solid", position: { x: 0, y: 0 } },
    ]),
    contextFor(alice),
  );

describe("command bus — registration surface (§V39)", () => {
  it("accepts a command registered by another module and routes it", async () => {
    harness.bus.registerCommand({
      name: "test.rename",
      handler: (input, context) => {
        const applied = context.apply({
          label: "Rename",
          recipe: (draft) => {
            const node = draft.nodes[input.nodeId];
            if (node !== undefined) node.parameters["label"] = input.label;
          },
        });
        return { status: "applied", output: { ok: applied.committed }, revision: applied.revision };
      },
    });

    const built = await addSolid();
    const nodeId = built.output.createdIds["$a"] as string;

    const result = await harness.bus.execute("test.rename", { nodeId, label: "hello" }, contextFor(alice));
    expect(result.status).toBe("applied");
    expect(harness.store.view.getGraph().nodes[nodeId]?.parameters["label"]).toBe("hello");

    // A third-party command gets the same actor stamping, revision bump and audit entry
    // as a built-in — because it went through ctx.apply (§V30, §V31).
    const audit = harness.store.view.getAudit();
    expect(audit[audit.length - 1]).toMatchObject({
      command: "test.rename",
      status: "applied",
      actor: { id: "alice" },
      revision: 2,
    });
  });

  it("lists registered commands and queries", () => {
    // Exact, not toContain: a new registration should have to be declared here.
    expect(harness.bus.listCommands()).toEqual([
      "graph.applyPatch",
      "graph.copySelection",
      "graph.cutSelection",
      "graph.duplicateSelection",
      "graph.layout",
      "graph.layoutAll",
      "graph.paste",
      "graph.redo",
      "graph.removeNodes",
      "graph.revertTransaction",
      "graph.undo",
      "node.rename",
      "node.setFormat",
      "node.setResolution",
      // T463: the graph-background flag — TD's network background as node ui state.
      "node.toggleBackground",
      "node.toggleBypass",
      "node.toggleDisplay",
      // T353: the preview PIN, split off from the switch when `P` started meaning on/off.
      "node.togglePin",
      "node.toggleRender",
      // Conditional paste: one copy that captures value + reference + binding; paste picks.
      "parameter.copy",
      "parameter.copyReference",
      "parameter.copyValue",
      "parameter.paste",
      "parameter.pulse",
      "parameter.reset",
      "parameter.setMode",
      // T272: settings are document state, so they mutate through the domain bus like
      // every other document edit rather than through a pane holding an object.
      "project.setSettings",
      "project.validate",
    ]);
    // T175: `selection.get`, `diagnostics.get`, `runtime.metrics` and `project.get` are
    // registered by `attachStateSources` and are deliberately absent here. None of them
    // is document state, so an unwired bus genuinely cannot answer them, and
    // `hasQuery(...)` staying false is what lets an adapter report that honestly instead
    // of publishing a tool that returns an empty selection nobody made.
    expect(harness.bus.listQueries()).toEqual(["graph.audit", "graph.get", "graph.history"]);
    expect(harness.bus.hasCommand("graph.applyPatch")).toBe(true);
    expect(harness.bus.hasCommand("nope")).toBe(false);
  });

  it("refuses to register the same command name twice", () => {
    expect(() =>
      harness.bus.registerCommand({
        name: "graph.applyPatch",
        handler: () => {
          throw new Error("unreachable");
        },
      }),
    ).toThrow(/already registered/);
  });

  it("throws for an unknown command or query rather than silently no-op'ing", async () => {
    await expect(
      harness.bus.execute("nope" as "graph.undo", {}, contextFor(alice)),
    ).rejects.toBeInstanceOf(UnknownCommandError);
    await expect(harness.bus.query("nope" as "graph.get", {}, contextFor(alice))).rejects.toBeInstanceOf(
      UnknownQueryError,
    );
  });
});

describe("command bus — actor identity (§V30)", () => {
  it("rejects an invocation with no actor id", async () => {
    await expect(
      harness.bus.execute("graph.applyPatch", patch(0, []), contextFor({ kind: "human", id: "" })),
    ).rejects.toBeInstanceOf(InvalidInvocationError);
  });

  it("rejects an invocation with no projectId", async () => {
    await expect(
      harness.bus.execute("graph.applyPatch", patch(0, []), contextFor(alice, { projectId: "" })),
    ).rejects.toBeInstanceOf(InvalidInvocationError);
  });

  it("records which actor made each change, human or agent", async () => {
    await addSolid();
    await harness.bus.execute(
      "graph.applyPatch",
      patch(harness.store.view.getRevision(), [
        { op: "addNode", ref: "$b", type: "test.blur", position: { x: 10, y: 0 } },
      ]),
      contextFor(agent),
    );
    expect(harness.store.view.getAudit().map((entry) => entry.actor.kind)).toEqual(["human", "agent"]);
  });
});

describe("command bus — capability gating (§V38)", () => {
  beforeEach(() => {
    harness.bus.registerCommand({
      name: "test.exportSomething",
      requiredCapabilities: ["export"],
      handler: () => ({ status: "applied", output: { ok: true } }),
      rejectionOutput: () => ({ ok: false }),
    });
  });

  it("rejects a command whose capability was never granted", async () => {
    const result = await harness.bus.execute("test.exportSomething", {}, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.output.ok).toBe(false);
    expect(result.diagnostics[0]?.code).toBe("capability.denied");
    expect(harness.store.view.getAudit()[0]).toMatchObject({ status: "rejected", command: "test.exportSomething" });
  });

  it("runs the command when the BUS-OWNED store granted the capability (T90)", async () => {
    harness.bus.grants.grant(alice, "export");
    const result = await harness.bus.execute("test.exportSomething", {}, contextFor(alice));
    expect(result.status).toBe("applied");
    expect(result.output.ok).toBe(true);
  });

  it("§V38: caller-supplied context capabilities grant NOTHING — the self-grant hole is closed", async () => {
    // Exactly what a rogue adapter would try: fabricate the grant on the invocation.
    const context = contextFor(alice, {
      capabilities: [{ capability: "export", grantedAt: "2026-01-01T00:00:00.000Z" }],
    });
    const result = await harness.bus.execute("test.exportSomething", {}, context);
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.code).toBe("capability.denied");
  });

  it("ignores an expired grant, with the clock injected rather than wall time", async () => {
    let clock = Date.parse("2026-01-01T00:00:00.000Z");
    const grants = createCapabilityGrantStore({ now: () => clock });
    const fresh = createHarness({ grants });
    fresh.bus.registerCommand({
      name: "test.exportSomething",
      requiredCapabilities: ["export"],
      handler: () => ({ status: "applied", output: { ok: true } }),
      rejectionOutput: () => ({ ok: false }),
    });

    fresh.bus.grants.grant(alice, "export", { expiresAt: "2026-01-02T00:00:00.000Z" });
    const before = await fresh.bus.execute("test.exportSomething", {}, contextFor(alice));
    expect(before.status).toBe("applied");

    clock = Date.parse("2026-01-03T00:00:00.000Z");
    const after = await fresh.bus.execute("test.exportSomething", {}, contextFor(alice));
    expect(after.status).toBe("rejected");
  });

  it("refuses an unparseable expiresAt at grant time instead of treating it as forever", () => {
    expect(() => harness.bus.grants.grant(alice, "export", { expiresAt: "not a date" })).toThrow(/expiresAt/);
  });

  it("revocation takes effect immediately", async () => {
    harness.bus.grants.grant(alice, "export");
    harness.bus.grants.revoke(alice, "export");
    const result = await harness.bus.execute("test.exportSomething", {}, contextFor(alice));
    expect(result.status).toBe("rejected");
  });

  it("throws when a gated command cannot produce a typed rejection value", async () => {
    const fresh = createHarness();
    fresh.bus.registerCommand({
      name: "test.exportSomething",
      requiredCapabilities: ["recording"],
      handler: () => ({ status: "applied", output: { ok: true } }),
    });
    await expect(fresh.bus.execute("test.exportSomething", {}, contextFor(alice))).rejects.toBeInstanceOf(
      CapabilityDeniedError,
    );
  });
});

describe("command bus — dryRun reaches every command (§V36)", () => {
  it("makes ctx.apply a no-op for a third-party command", async () => {
    harness.bus.registerCommand({
      name: "test.rename",
      handler: (input, context) => {
        const applied = context.apply({
          label: "Rename",
          recipe: (draft) => {
            const node = draft.nodes[input.nodeId];
            if (node !== undefined) node.parameters["label"] = input.label;
          },
        });
        return { status: "applied", output: { ok: applied.committed }, revision: applied.revision };
      },
    });

    const built = await addSolid();
    const nodeId = built.output.createdIds["$a"] as string;
    const before = harness.store.view.getGraph();

    const result = await harness.bus.execute(
      "test.rename",
      { nodeId, label: "nope" },
      contextFor(alice, { dryRun: true }),
    );

    // The handler was told the mutation did not commit, and the document is identical.
    expect(result.output.ok).toBe(false);
    expect(harness.store.view.getGraph()).toBe(before);
    expect(harness.store.view.getAudit()).toHaveLength(1); // only the addSolid above
  });

  it("does not audit an undo dry run", async () => {
    await addSolid();
    const result = await harness.bus.execute("graph.undo", {}, contextFor(alice, { dryRun: true }));
    // §V36/T102: a dry run reports "validated" — it did not undo anything.
    expect(result.status).toBe("validated");
    expect(result.output.undoGroupId).not.toBeNull();
    expect(harness.store.view.getRevision()).toBe(1);
    expect(harness.store.view.getAudit()).toHaveLength(1);
  });
});

describe("command bus — queries", () => {
  it("returns the current document and audit log", async () => {
    await addSolid();
    const document = await harness.bus.query("graph.get", {}, contextFor(alice));
    expect(Object.keys(document.nodes)).toHaveLength(1);
    expect(document.revision).toBe(1);

    const audit = await harness.bus.query("graph.audit", {}, contextFor(alice));
    expect(audit).toHaveLength(1);
  });

  it("reports per-actor history", async () => {
    await addSolid();
    const mine = await harness.bus.query("graph.history", {}, contextFor(alice));
    expect(mine.undo).toHaveLength(1);
    expect(mine.undo[0]?.command).toBe("graph.applyPatch");

    const theirs = await harness.bus.query("graph.history", {}, contextFor(agent));
    expect(theirs.undo).toHaveLength(0);
  });

  it("does not mutate anything", async () => {
    await addSolid();
    const before = harness.store.view.getGraph();
    await harness.bus.query("graph.get", {}, contextFor(alice));
    expect(harness.store.view.getGraph()).toBe(before);
    expect(harness.store.view.getAudit()).toHaveLength(1);
  });

  it("supports a query registered by another module", async () => {
    harness.bus.registerQuery({
      name: "test.count",
      handler: (_input, context) => Object.keys(context.graph.nodes).length,
    });
    await addSolid();
    expect(await harness.bus.query("test.count", {}, contextFor(alice))).toBe(1);
  });
});
