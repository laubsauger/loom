import type { z } from "zod";

import type { LoomBus } from "@domain/commands/bus.ts";
import type { HistorySummary } from "@domain/commands/graph-commands.ts";
import type { Actor, CapabilityClass, InvocationContext } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { Revision } from "@domain/types/ids.ts";

import { capabilitiesForTool } from "./capabilities.ts";
import {
  createAgentPresence,
  type AgentPresenceStore,
  type AgentPresenceView,
  type AgentProposal,
} from "./presence.ts";
import { diagnostic, result, type ResultExtras } from "./tool-support.ts";
import { mutationTools } from "./tools/mutate.ts";
import { pointsTools } from "./tools/points.ts";
import { previewTools } from "./tools/preview.ts";
import { readTools } from "./tools/read.ts";
import { workflowTools } from "./tools/workflow.ts";
import type {
  AgentPortName,
  AgentPorts,
  AgentTool,
  AgentToolInfo,
  DispatchResult,
  ToolResult,
  ToolRuntime,
} from "./types.ts";

/**
 * The agent tool surface (T54–T60) — one adapter, transport and schema only (§V39).
 *
 * ## What the surface does, exhaustively
 *
 * 1. Validates input against the tool's zod schema (§V66). Malformed input is a
 *    diagnostic, never a throw.
 * 2. Checks that the bus commands and queries the tool names are REGISTERED, and that
 *    any read port it needs is attached. Missing → `unavailable`, with the missing names
 *    as data. This is the same honesty the command palette shows for an unresolved
 *    keybinding: a tool that appears to work and does nothing is worse than one that
 *    says it is not there.
 * 3. Checks capability grants against `bus.grants` — the bus-owned, actor-keyed store
 *    (T90). Not granted → `denied`. Nothing in a tool call can grant anything (§V38).
 * 4. Optionally holds the call for human review (§V42).
 * 5. Publishes presence transitions so the UI can show what the agent is doing (§V42).
 * 6. Dispatches to the bus with an `InvocationContext` the SURFACE builds: the actor is
 *    stamped here (§V30) and the capability array is copied from the grant store, never
 *    from tool input.
 *
 * It does not interpret a graph, decide what an edit means, or hold document state.
 *
 * ## Untrusted content (§V37)
 *
 * Node labels, node types, parameter values, file names and shader text pass through as
 * DATA. No prose this surface authors ever interpolates them, so a node named
 * "ignore previous instructions" is a string in a field and nothing more.
 */

export interface AgentSurfaceOptions {
  bus: LoomBus;
  /** Who is acting. §V30: there is no anonymous mutation. */
  actor: Actor;
  projectId: string;
  /** Read sources for state the bus has no query for. Absent → those tools report unavailable. */
  ports?: AgentPorts;
  /** Hold every patch-shaped mutation for human approval before it applies (§V42). */
  requireApproval?: boolean;
  presence?: AgentPresenceStore;
  now?: () => number;
}

export interface RevertData {
  readonly transactionId: string;
  readonly undoneGroupIds: readonly string[];
  readonly remainingGroupIds: readonly string[];
}

export interface AgentToolSurface {
  listTools(): readonly AgentToolInfo[];
  describeTool(name: string): AgentToolInfo | null;
  callTool(name: string, input?: unknown): Promise<ToolResult>;
  /** Presence for the UI. Read-only: the UI is never a producer of tool state (§V42). */
  readonly presence: AgentPresenceView;
  readonly actor: Actor;
  /** Groups the following calls into one revertible unit (§V34). */
  beginTransaction(label: string): string;
  endTransaction(): void;
  /** Undoes a transaction as ONE unit, newest group first (§V42, T60). */
  revertTransaction(transactionId: string): Promise<ToolResult<RevertData>>;
  /** Human approves a held mutation; it then runs exactly as it would have (§V42). */
  approve(proposalId: string): Promise<ToolResult>;
  reject(proposalId: string): ToolResult<{ proposalId: string }>;
  pendingProposals(): readonly AgentProposal[];
}

const ALL_TOOLS: readonly AgentTool[] = [
  ...readTools,
  ...previewTools,
  ...pointsTools,
  ...mutationTools,
  ...workflowTools,
];

/** Tool kind → the presence state the UI shows while it runs (§V42). */
const ACTIVITY = { read: "planning", mutate: "editing", workflow: "compiling" } as const;

/**
 * The zod input schema of one tool, for adapters that must SPEAK schema — an MCP
 * server's `tools/list` publishes JSON Schema derived from exactly this (T290, §V39).
 * The surface itself stays transport-free (§V192); this is a read of what already
 * exists, not a new declaration.
 */
export function toolInputSchema(name: string): z.ZodType<unknown> | null {
  return ALL_TOOLS.find((tool) => tool.name === name)?.inputSchema ?? null;
}

export function createAgentToolSurface(options: AgentSurfaceOptions): AgentToolSurface {
  const { bus, actor, projectId } = options;
  const ports: AgentPorts = options.ports ?? {};
  const now = options.now ?? (() => Date.now());
  const presence =
    options.presence ?? createAgentPresence({ actor, ...(options.now === undefined ? {} : { now }) });

  const tools = new Map<string, AgentTool>(ALL_TOOLS.map((tool) => [tool.name, tool]));
  const held = new Map<string, { tool: AgentTool; input: unknown }>();

  let transactionId: string | undefined;
  let transactionCount = 0;
  let proposalCount = 0;

  const invocation = (dryRun: boolean): InvocationContext => ({
    actor,
    projectId,
    // Copied from the AUTHORITY, not from the caller: the bus reads `bus.grants` and
    // ignores this field, so it can inform a handler without being forgeable (§V38, T90).
    capabilities: [...bus.grants.list(actor)],
    ...(transactionId === undefined ? {} : { transactionId }),
    ...(dryRun ? { dryRun: true } : {}),
  });

  /**
   * Dispatch by NAME. An adapter cannot name every track's `CommandMap` augmentation —
   * the tool list is data, and `project.save` is declared in the composition root — so
   * the one cast in this file lives here, behind zod-validated input and a
   * `hasCommand`/`hasQuery` check.
   */
  const dispatch = {
    async execute<TOutput>(name: string, input: unknown, dryRun: boolean): Promise<DispatchResult<TOutput>> {
      const execute = bus.execute as unknown as (
        commandName: string,
        commandInput: unknown,
        context: InvocationContext,
      ) => Promise<DispatchResult<TOutput>>;
      return execute(name, input, invocation(dryRun));
    },
    async query<TOutput>(name: string, input: unknown): Promise<TOutput> {
      const query = bus.query as unknown as (
        queryName: string,
        queryInput: unknown,
        context: InvocationContext,
      ) => Promise<TOutput>;
      return query(name, input, invocation(false));
    },
  };

  const runtimeFor = (dryRun: boolean): ToolRuntime => ({
    bus,
    ports,
    dryRun,
    invocation: () => invocation(dryRun),
    execute: (name, input) => dispatch.execute(name, input, dryRun),
    query: (name, input) => dispatch.query(name, input),
    async revision(): Promise<Revision> {
      const graph = await dispatch.query<{ revision: Revision }>("graph.get", {});
      return graph.revision;
    },
  });

  const missingFor = (
    tool: AgentTool,
  ): { commands: string[]; queries: string[]; ports: AgentPortName[] } => ({
    commands: (tool.requires.commands ?? []).filter((name) => !bus.hasCommand(name)),
    queries: (tool.requires.queries ?? []).filter((name) => !bus.hasQuery(name)),
    ports: (tool.requires.ports ?? []).filter((name) => ports[name] === undefined),
  });

  const ungrantedFor = (tool: AgentTool): CapabilityClass[] =>
    [...tool.capabilities, ...capabilitiesForTool(tool.name)]
      .filter((capability, index, all) => all.indexOf(capability) === index)
      .filter((capability) => !bus.grants.has(actor, capability));

  const infoFor = (tool: AgentTool): AgentToolInfo => {
    const missing = missingFor(tool);
    return {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      kind: tool.kind,
      capabilities: [...tool.capabilities, ...capabilitiesForTool(tool.name)].filter(
        (capability, index, all) => all.indexOf(capability) === index,
      ),
      mutates: tool.mutates,
      available:
        missing.commands.length === 0 && missing.queries.length === 0 && missing.ports.length === 0,
      missing,
      ungranted: ungrantedFor(tool),
      inputSchema: tool.inputSchema as z.ZodType<unknown>,
    };
  };

  function readDryRun(input: unknown): boolean {
    if (typeof input !== "object" || input === null) return false;
    return (input as { dryRun?: unknown }).dryRun === true;
  }

  async function runTool(tool: AgentTool, parsed: unknown): Promise<ToolResult> {
    const dryRun = readDryRun(parsed);
    presence.setActivity(ACTIVITY[tool.kind], tool.name);
    try {
      const outcome = (await tool.run(parsed, runtimeFor(dryRun))) as ToolResult;
      if (outcome.revision !== null) presence.observeRevision(outcome.revision);
      if (
        transactionId !== undefined &&
        outcome.undoGroupId !== undefined &&
        outcome.status === "ok"
      ) {
        presence.recordUndoGroup(transactionId, outcome.undoGroupId);
      }
      return outcome.transactionId === undefined && transactionId !== undefined
        ? { ...outcome, transactionId }
        : outcome;
    } catch (thrown) {
      // A transport boundary that throws loses its diagnostics. Everything is reported.
      return result(tool.name, "error", null, {
        diagnostics: [
          diagnostic("error", "tool.failed", `The "${tool.name}" tool did not complete.`, {
            suggestion: nameOfThrown(thrown),
          }),
        ],
      });
    } finally {
      presence.setActivity(
        presence.snapshot().proposals.some((proposal) => proposal.status === "pending")
          ? "awaiting-approval"
          : "idle",
        tool.name,
      );
    }
  }

  function unavailableResult(tool: AgentTool): ToolResult {
    const missing = missingFor(tool);
    const parts: RuntimeDiagnostic[] = [];
    if (missing.commands.length > 0) {
      parts.push(
        diagnostic(
          "error",
          "tool.unavailableCommand",
          `"${tool.name}" needs a bus command that is not registered: ${missing.commands.join(", ")}.`,
          { suggestion: "The track that owns that surface registers it; nothing here can stand in for it." },
        ),
      );
    }
    if (missing.queries.length > 0) {
      parts.push(
        diagnostic(
          "error",
          "tool.unavailableQuery",
          `"${tool.name}" needs a bus query that is not registered: ${missing.queries.join(", ")}.`,
        ),
      );
    }
    if (missing.ports.length > 0) {
      parts.push(
        diagnostic(
          "error",
          "tool.unavailablePort",
          `"${tool.name}" needs a read source that is not attached: ${missing.ports.join(", ")}.`,
          { suggestion: "The composition root injects it; it is not something a tool can create." },
        ),
      );
    }
    return result(tool.name, "unavailable", null, { diagnostics: parts });
  }

  function deniedResult(tool: AgentTool, ungranted: readonly CapabilityClass[]): ToolResult {
    return result(tool.name, "denied", null, {
      diagnostics: [
        diagnostic(
          "error",
          "capability.denied",
          `"${tool.name}" requires an ungranted capability: ${ungranted.join(", ")}.`,
          {
            suggestion:
              "Only the user can grant it, through the app's confirm flow. Calling this tool again cannot grant it (§V38).",
          },
        ),
      ],
    });
  }

  async function call(name: string, input: unknown): Promise<ToolResult> {
    const tool = tools.get(name);
    if (tool === undefined) {
      return result(name, "error", null, {
        diagnostics: [
          diagnostic("error", "tool.unknown", `No tool named "${name}".`, {
            suggestion: "Call list_tools for the tool names this surface publishes.",
          }),
        ],
      });
    }

    const parsed = tool.inputSchema.safeParse(input ?? {});
    if (!parsed.success) {
      return result(tool.name, "error", null, {
        diagnostics: parsed.error.issues.map((issue) =>
          diagnostic(
            "error",
            "tool.input",
            `Input to "${tool.name}" is invalid at ${issue.path.join(".") || "(root)"}: ${issue.code}.`,
          ),
        ),
      });
    }

    const missing = missingFor(tool);
    if (missing.commands.length > 0 || missing.queries.length > 0 || missing.ports.length > 0) {
      return unavailableResult(tool);
    }

    const ungranted = ungrantedFor(tool);
    if (ungranted.length > 0) return deniedResult(tool, ungranted);

    // §V42: a mutation the user asked to review is HELD, visibly, not applied quietly.
    // Undo and redo are exempt: they only move this actor's own history (§V41), so there
    // is no patch to review and holding them would strand the reviewer.
    if (
      options.requireApproval === true &&
      tool.mutates &&
      tool.preview !== undefined &&
      !readDryRun(parsed.data)
    ) {
      proposalCount += 1;
      const proposalId = `proposal-${proposalCount}`;
      const baseRevision = await runtimeFor(false).revision();
      held.set(proposalId, { tool, input: parsed.data });
      presence.addProposal({
        id: proposalId,
        tool: tool.name,
        label: tool.title,
        baseRevision,
        operations: tool.preview(parsed.data),
        transactionId,
      });
      return result(tool.name, "awaiting-approval", null, {
        revision: baseRevision,
        proposalId,
        diagnostics: [
          diagnostic("info", "tool.awaitingApproval", `"${tool.name}" is waiting for the user to approve it.`),
        ],
      });
    }

    return runTool(tool, parsed.data);
  }

  return {
    actor,
    presence,

    listTools: () => ALL_TOOLS.map(infoFor),
    describeTool: (name) => {
      const tool = tools.get(name);
      return tool === undefined ? null : infoFor(tool);
    },

    callTool: call,

    beginTransaction(label) {
      transactionCount += 1;
      transactionId = `txn-${transactionCount}`;
      presence.openTransaction(transactionId, label);
      return transactionId;
    },

    endTransaction() {
      if (transactionId !== undefined) presence.closeTransaction(transactionId, "committed");
      transactionId = undefined;
    },

    async revertTransaction(id): Promise<ToolResult<RevertData>> {
      const transaction = presence
        .snapshot()
        .transactions.find((candidate) => candidate.id === id);
      if (transaction === undefined) {
        return result<RevertData>("revert_transaction", "error", null, {
          diagnostics: [
            diagnostic("error", "transaction.unknown", `No agent transaction with id "${id}".`),
          ],
        });
      }

      const remaining = new Set(transaction.undoGroupIds);
      const undone: string[] = [];
      const diagnostics: RuntimeDiagnostic[] = [];

      // Undo is actor-local and pops this actor's newest group (§V41), so the loop stops
      // as soon as the top of the stack is not part of the transaction — reverting past
      // it would undo work that was never in the unit the user asked to revert.
      while (remaining.size > 0) {
        const history = await dispatch.query<HistorySummary>("graph.history", {});
        const top = history.undo[history.undo.length - 1];
        if (top === undefined || !remaining.has(top.id)) break;
        const dispatched = await dispatch.execute<unknown>("graph.undo", {}, false);
        if (dispatched.status !== "applied") {
          diagnostics.push(...dispatched.diagnostics);
          break;
        }
        remaining.delete(top.id);
        undone.push(top.id);
        presence.observeRevision(dispatched.revision);
      }

      presence.closeTransaction(id, remaining.size === 0 ? "reverted" : "partially-reverted");
      if (remaining.size > 0) {
        diagnostics.push(
          diagnostic(
            "warning",
            "transaction.partialRevert",
            `${undone.length} of ${transaction.undoGroupIds.length} edit groups were reverted; the rest are no longer at the top of this actor's history.`,
          ),
        );
      }

      const extras: ResultExtras = { diagnostics, transactionId: id };
      return result<RevertData>(
        "revert_transaction",
        remaining.size === 0 ? "ok" : "rejected",
        { transactionId: id, undoneGroupIds: undone, remainingGroupIds: [...remaining] },
        extras,
      );
    },

    async approve(proposalId): Promise<ToolResult> {
      const entry = held.get(proposalId);
      const resolved = presence.resolveProposal(proposalId, "approved");
      if (entry === undefined || resolved === null) {
        return result(proposalId, "error", null, {
          diagnostics: [
            diagnostic("error", "proposal.unknown", `No pending proposal with id "${proposalId}".`),
          ],
        });
      }
      held.delete(proposalId);
      const outcome = await runTool(entry.tool, entry.input);
      if (outcome.status !== "ok" && outcome.status !== "validated") {
        presence.resolveProposal(proposalId, "failed");
      }
      return { ...outcome, proposalId };
    },

    reject(proposalId) {
      const resolved = presence.resolveProposal(proposalId, "rejected");
      held.delete(proposalId);
      if (resolved === null) {
        return result<{ proposalId: string }>(proposalId, "error", null, {
          diagnostics: [
            diagnostic("error", "proposal.unknown", `No pending proposal with id "${proposalId}".`),
          ],
        });
      }
      return result("reject_proposal", "ok", { proposalId }, { proposalId });
    },

    pendingProposals: () =>
      presence.snapshot().proposals.filter((proposal) => proposal.status === "pending"),
  };
}

/** The error's constructor name only — never its message, which may quote document text. */
function nameOfThrown(thrown: unknown): string {
  if (thrown instanceof Error) return `The bus raised ${thrown.name}.`;
  return "The bus raised a non-Error value.";
}
