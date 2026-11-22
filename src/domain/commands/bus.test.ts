import { beforeEach, describe, expect, it } from "vitest";

import type { NodeId } from "../types/ids.ts";
import { alice, agent, contextFor, createHarness, patch, type Harness } from "./test-support.ts";
import { CapabilityDeniedError, createCommandBus, InvalidCommandInputError, InvalidInvocationError, UnknownCommandError, UnknownQueryError, type CommandRegistration } from "./bus.ts";
import { createCapabilityGrantStore } from "./grants.ts";
import { z } from "zod";
import { ANY_INPUT, NO_INPUT, nodeIdInput, canvasNodeIdInput } from "./input-schema.ts";

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
      inSession: "definition",
      inputSchema: z.object({ nodeId: z.string(), label: z.string() }).strict(),
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
      "channel.copy",
      // T1619b: a control back to its default, and its value made the default.
      "control.reset",
      "control.resetAll",
      "control.setAllDefaults",
      "control.setDefault",
      // T1500b: a cue list's GO / BACK / fire / standby are document edits too.
      "cue.back",
      "cue.fire",
      "cue.go",
      "cue.setStandby",
      "graph.applyPatch",
      "graph.copySelection",
      "graph.cutSelection",
      "graph.duplicateSelection",
      "graph.layout",
      "graph.layoutAll",
      "graph.paste",
      "graph.redo",
      "graph.removeNodes",
      // T1821b: a wire routed through a tie.
      "graph.rerouteEdge",
      "graph.revertTransaction",
      "graph.undo",
      // T1534b: a Grid Warp's row/column insert and delete at a place on its surface.
      "gridWarp.deleteLine",
      "gridWarp.insertLine",
      // T1102: stacking order among overlapping nodes, persisted in `ui.z`.
      "node.bringToFront",
      "node.rename",
      "node.setChannelMask",
      "node.setFormat",
      "node.setResolution",
      // Bar or curve in a value node's body, persisted in `ui.valuePlotMode`.
      "node.setValuePlotMode",
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
      // T1641b: how a stored key the node does not declare leaves a document.
      "parameter.removeUndeclared",
      "parameter.reset",
      // T1184: the other half of the pair — reset is a claim about the node TYPE,
      // revert is a claim about THIS FILE (the value the document was opened with).
      "parameter.revert",
      "parameter.setMode",
      "photoMapping.create",
      // T1496b: a preset bank's Store and Recall are document edits, so every bus has them.
      // T1502b: and Delete beside them.
      "preset.delete",
      // T1505b: a bank beside a look moved into its component (refused by name with no catalogue).
      "preset.moveIntoComponent",
      "preset.recall",
      "preset.store",
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
    // T1500b: `cue.list` reads the document, so an unwired bus CAN answer it.
    expect(harness.bus.listQueries()).toEqual(["cue.list", "graph.audit", "graph.get", "graph.history"]);
    expect(harness.bus.hasCommand("graph.applyPatch")).toBe(true);
    expect(harness.bus.hasCommand("nope")).toBe(false);
  });

  it("refuses to register the same command name twice", () => {
    expect(() =>
      harness.bus.registerCommand({
        name: "graph.applyPatch",
        inSession: "definition",
        inputSchema: ANY_INPUT("a duplicate registration, refused before it could run"),
        handler: () => {
          throw new Error("unreachable");
        },
      }),
    ).toThrow(/already registered/);
  });

  it("explicitly refreshes schema and handler without replacing the document or undo history", async () => {
    const original = {
      name: "test.rename" as const,
      inSession: "definition" as const,
      inputSchema: z.object({ nodeId: z.string(), label: z.literal("old") }).strict(),
      handler: () => ({ status: "applied" as const, output: { ok: true } }),
    };
    harness.bus.registerCommand(original);
    const built = await addSolid();
    const nodeId = built.output.createdIds["$a"]!;
    const graph = harness.store.view.getGraph();
    const store = harness.bus.store;
    await expect(harness.bus.execute("test.rename", { nodeId, label: "new" }, contextFor(alice)))
      .rejects.toBeInstanceOf(InvalidCommandInputError);
    harness.bus.replaceCommand({ ...original,
      inputSchema: z.object({ nodeId: z.string(), label: z.string() }).strict(),
      handler: () => ({ status: "applied", output: { ok: false } }),
    });
    expect(harness.bus.store).toBe(store);
    expect(harness.store.view.getGraph()).toBe(graph);
    expect((await harness.bus.execute("test.rename", { nodeId, label: "new" }, contextFor(alice))).output).toEqual({ ok: false });
    await harness.bus.execute("graph.undo", {}, contextFor(alice));
    expect(harness.store.view.getGraph().nodes[nodeId]).toBeUndefined();
  });

  it("refuses to replace missing or inherited commands", async () => {
    const original: CommandRegistration<"test.exportSomething"> = {
      name: "test.exportSomething", inSession: "app", inputSchema: NO_INPUT,
      handler: () => ({ status: "applied", output: { ok: true } }),
    };
    expect(() => harness.bus.replaceCommand(original)).toThrow(/not owned/);
    harness.bus.registerCommand(original);
    const session = createCommandBus({ parent: harness.bus });
    expect(session.hasCommand(original.name)).toBe(true);
    expect(() => session.replaceCommand(original)).toThrow(/not owned/);
    expect((await session.execute(original.name, {}, contextFor(alice))).output).toEqual({ ok: true });
  });

  it("keeps the old schema and handler when replacement registration is invalid", async () => {
    const original: CommandRegistration<"test.rename"> = {
      name: "test.rename", inSession: "definition",
      inputSchema: z.object({ nodeId: z.string(), label: z.literal("old") }).strict(),
      handler: () => ({ status: "applied", output: { ok: true } }),
    };
    harness.bus.registerCommand(original);
    expect(() => harness.bus.replaceCommand({ ...original, inputSchema: undefined } as never)).toThrow(/without an inputSchema/);
    expect(() => harness.bus.replaceCommand({ ...original, inSession: undefined } as never)).toThrow(/without saying/);
    expect(() => harness.bus.replaceCommand({ ...original, inSession: "app" })).toThrow(/cannot change its inSession/);
    expect(() => harness.bus.replaceCommand({ ...original, requiredCapabilities: ["export"] })).toThrow(/cannot change its requiredCapabilities/);
    expect(harness.bus.inputSchemaOf(original.name)).toBe(original.inputSchema);
    await expect(harness.bus.execute(original.name, { nodeId: "n", label: "new" }, contextFor(alice)))
      .rejects.toBeInstanceOf(InvalidCommandInputError);
    expect((await harness.bus.execute(original.name, { nodeId: "n", label: "old" }, contextFor(alice))).output).toEqual({ ok: true });
  });

  it("preserves instance address and refusal validation during replacement", async () => {
    const original: CommandRegistration<"test.rename"> = {
      name: "test.rename", inSession: "instance",
      inputSchema: z.object({ nodeId: nodeIdInput, label: canvasNodeIdInput }).strict(),
      rejectionOutput: () => ({ ok: false }),
      handler: () => ({ status: "applied", output: { ok: true } }),
    };
    harness.bus.registerCommand(original);
    expect(() => harness.bus.replaceCommand({ ...original, rejectionOutput: undefined } as never)).toThrow(/has no rejectionOutput/);
    expect(() => harness.bus.replaceCommand({ ...original,
      inputSchema: z.object({ nodeId: z.string(), label: z.string() }).strict(),
    })).toThrow(/every string of its input is a node address/);
    expect(harness.bus.inputSchemaOf(original.name)).toBe(original.inputSchema);
    expect((await harness.bus.execute(original.name, { nodeId: "n", label: "old" }, contextFor(alice))).output).toEqual({ ok: true });
  });

  it("preserves capability requirements and accepts equivalent capability sets", async () => {
    const original: CommandRegistration<"test.exportSomething"> = {
      name: "test.exportSomething", inSession: "app", inputSchema: NO_INPUT,
      requiredCapabilities: ["export", "localFile"],
      handler: () => ({ status: "applied", output: { ok: true } }),
    };
    harness.bus.registerCommand(original);
    expect(() => harness.bus.replaceCommand({ ...original, requiredCapabilities: ["localFile"] })).toThrow(/requiredCapabilities/);
    expect(() => harness.bus.replaceCommand({ ...original, requiredCapabilities: [] })).toThrow(/requiredCapabilities/);
    harness.bus.replaceCommand({ ...original, requiredCapabilities: ["localFile", "export"] });
    await expect(harness.bus.execute(original.name, {}, contextFor(alice))).rejects.toBeInstanceOf(CapabilityDeniedError);
    harness.bus.grants.grant(alice, "export");
    await expect(harness.bus.execute(original.name, {}, contextFor(alice))).rejects.toBeInstanceOf(CapabilityDeniedError);
    harness.bus.grants.grant(alice, "localFile");
    expect((await harness.bus.execute(original.name, {}, contextFor(alice))).output).toEqual({ ok: true });
  });

  it("preserves the complete definition hand-up declaration", () => {
    const original: CommandRegistration<"test.rename"> = {
      name: "test.rename", inSession: { definition: true, handsUp: "An explicit project action" },
      inputSchema: z.object({ nodeId: z.string(), label: z.string() }).strict(),
      handler: () => ({ status: "applied", output: { ok: true } }),
    };
    harness.bus.registerCommand(original);
    harness.bus.replaceCommand({ ...original, inSession: { definition: true, handsUp: "An explicit project action" } });
    expect(() => harness.bus.replaceCommand({ ...original, inSession: { definition: true, handsUp: "Anything" } })).toThrow(/cannot change its inSession/);
    expect(() => harness.bus.replaceCommand({ ...original, inSession: "definition" })).toThrow(/cannot change its inSession/);
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
      inSession: "app",
      inputSchema: NO_INPUT,
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
      inSession: "app",
      inputSchema: NO_INPUT,
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
      inSession: "app",
      inputSchema: NO_INPUT,
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
      inSession: "definition",
      inputSchema: z.object({ nodeId: z.string(), label: z.string() }).strict(),
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

/**
 * §T1556b — the bus parses a command's input before the handler runs, so every door gets one
 * refusal: the same rejected result, the same audit entry, the same sentence.
 */
describe("command bus — input schemas (§T1556b)", () => {
  const renameSchema = z.object({ nodeId: z.string().min(1), label: z.string() }).strict();

  it("refuses input its schema rejects, naming command and field; the handler never runs and the refusal is audited", async () => {
    let ran = 0;
    harness.bus.registerCommand({
      name: "test.rename",
      inSession: "definition",
      inputSchema: renameSchema,
      handler: () => {
        ran += 1;
        return { status: "applied", output: { ok: true } };
      },
      rejectionOutput: () => ({ ok: false }),
    });
    const result = await harness.bus.execute("test.rename", { nodeId: "n1", label: 7 } as never, contextFor(alice));
    expect(ran).toBe(0);
    expect(result.status).toBe("rejected");
    expect(result.output).toEqual({ ok: false });
    expect(result.diagnostics).toEqual([
      {
        severity: "error",
        code: "command.input",
        message: 'Input to "test.rename" is invalid at label (invalid_type): Expected string, received number',
      },
    ]);
    expect(harness.store.view.getAudit()).toMatchObject([{ command: "test.rename", status: "rejected", actor: { id: "alice" } }]);
  });

  it("refuses an unknown key: a typo is reported, not dropped", async () => {
    harness.bus.registerCommand({
      name: "test.rename",
      inSession: "definition",
      inputSchema: renameSchema,
      handler: () => ({ status: "applied", output: { ok: true } }),
      rejectionOutput: () => ({ ok: false }),
    });
    const result = await harness.bus.execute("test.rename", { nodeId: "n1", label: "x", lable: "y" } as never, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics[0]?.message).toContain("Unrecognized key(s) in object: 'lable'");
  });

  it("hands the handler the input AS SENT once it passes: the schema is a gate, not a transform", async () => {
    let seen: unknown = null;
    harness.bus.registerCommand({
      name: "test.rename",
      inSession: "definition",
      inputSchema: renameSchema,
      handler: (input) => {
        seen = input;
        return { status: "applied", output: { ok: true } };
      },
    });
    const sent = { nodeId: "n1", label: "x" };
    await harness.bus.execute("test.rename", sent, contextFor(alice));
    expect(seen).toBe(sent);
  });

  it("a dry run is refused the same way and records nothing (§V36)", async () => {
    harness.bus.registerCommand({
      name: "test.rename",
      inSession: "definition",
      inputSchema: renameSchema,
      handler: () => ({ status: "applied", output: { ok: true } }),
      rejectionOutput: () => ({ ok: false }),
    });
    const result = await harness.bus.execute("test.rename", {} as never, contextFor(alice, { dryRun: true }));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics.map((diagnostic) => diagnostic.code)).toEqual(["command.input", "command.input"]);
    expect(harness.store.view.getAudit()).toHaveLength(0);
  });

  it("with no rejectionOutput it throws the same sentences — after the audit entry exists (the capability path's rule)", async () => {
    harness.bus.registerCommand({
      name: "test.rename",
      inSession: "definition",
      inputSchema: renameSchema,
      handler: () => ({ status: "applied", output: { ok: true } }),
    });
    const thrown = await harness.bus.execute("test.rename", { nodeId: "", label: "x" }, contextFor(alice)).catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(InvalidCommandInputError);
    expect((thrown as InvalidCommandInputError).message).toBe(
      'Input to "test.rename" is invalid at nodeId (too_small): String must contain at least 1 character(s)',
    );
    expect(harness.store.view.getAudit()).toMatchObject([{ command: "test.rename", status: "rejected" }]);
  });

  it("ANY_INPUT is the named escape: the bus passes the input through to the handler", async () => {
    let seen: unknown = null;
    harness.bus.registerCommand({
      name: "test.rename",
      inSession: "definition",
      inputSchema: ANY_INPUT("a test of the escape"),
      handler: (input) => {
        seen = input;
        return { status: "applied", output: { ok: true } };
      },
    });
    await harness.bus.execute("test.rename", { anything: true } as never, contextFor(alice));
    expect(seen).toEqual({ anything: true });
    expect(() => ANY_INPUT("  ")).toThrow(/reason/);
  });

  it("refuses a registration that cast its way past the required schema", () => {
    expect(() =>
      (harness.bus.registerCommand as unknown as (registration: unknown) => void)({
        name: "test.rename",
        handler: () => ({ status: "applied", output: { ok: true } }),
      }),
    ).toThrow(/without an inputSchema/);
    expect(harness.bus.hasCommand("test.rename")).toBe(false);
  });

  it("lists at most ten issues, then says how many more — a 10 000-operation patch is one refusal, not 10 000", async () => {
    const operations = Array.from({ length: 25 }, () => ({ op: "addNode", ref: "$a", type: "test.solid" }));
    const result = await harness.bus.execute("graph.applyPatch", { baseRevision: 0, operations } as never, contextFor(alice));
    expect(result.status).toBe("rejected");
    expect(result.diagnostics).toHaveLength(11);
    expect(result.diagnostics[10]?.message).toBe('Input to "graph.applyPatch" has 15 further problem(s), not listed.');
  });
});
