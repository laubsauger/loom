import type { AuditEntry } from "../types/commands.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { GraphPatch, GraphPatchResult } from "../types/patch.ts";
import type { Revision } from "../types/ids.ts";
import type { LoomBus } from "./bus.ts";
import { applyGraphPatch } from "./apply-patch.ts";

/**
 * Built-in graph commands and queries.
 *
 * The command and query registries are extended by declaration merging, which is what
 * keeps every adapter — UI, WebMCP, MCP server, tests — transport-only (§V39). Other
 * tracks add their commands the same way, from their own module.
 */
declare module "../types/commands.ts" {
  interface CommandMap {
    /** Actor-local undo of that actor's most recent undo group (§V41). */
    "graph.undo": { input: Record<string, never>; output: HistoryCommandOutput };
    "graph.redo": { input: Record<string, never>; output: HistoryCommandOutput };
    /** Undo every group of one transaction as a single unit (§V34, §V42, T177). */
    "graph.revertTransaction": { input: RevertTransactionInput; output: RevertTransactionOutput };
  }

  interface QueryMap {
    /** Mutation log, newest last (§V31). */
    "graph.audit": { input: { limit?: number }; output: AuditEntry[] };
    /** Undo/redo stacks for the calling actor (§V41). */
    "graph.history": { input: Record<string, never>; output: HistorySummary };
  }
}

export interface HistoryCommandOutput {
  undoGroupId: string | null;
  label: string | null;
  revision: Revision;
}

export interface HistoryGroupSummary {
  id: string;
  label: string;
  command: string;
  revisionBefore: Revision;
  revisionAfter: Revision;
  /**
   * The transaction this group belongs to, or null (T177, §V34, §V42).
   *
   * `UndoGroup` has carried this since transactions landed; the summary dropped it, so
   * "revert that agent's transaction as one unit" could only be answered by an adapter
   * keeping its OWN ledger of which undo groups belonged to which transaction — a second
   * copy of state the store already holds, which drifts the moment a group coalesces or
   * a reload discards the ledger. Exposing it makes the store the single source, and
   * `graph.revertTransaction` below is the operation that ledger existed to fake.
   */
  transactionId: string | null;
}

export interface HistorySummary {
  actorKey: string;
  undo: HistoryGroupSummary[];
  redo: HistoryGroupSummary[];
}

export interface RevertTransactionInput {
  transactionId: string;
}

export interface RevertTransactionOutput {
  transactionId: string;
  /** Undo groups actually reverted, newest first — the order they were undone in. */
  undoneGroupIds: string[];
  /** Groups of this transaction still on the undo stack. Empty means fully reverted. */
  remainingGroupIds: string[];
  revision: Revision;
}

/** Registers `graph.applyPatch`, `graph.undo`, `graph.redo` and the graph queries. */
export function registerGraphCommands(bus: LoomBus): void {
  bus.registerCommand({
    name: "graph.applyPatch",
    description: "Atomically apply a list of graph operations (§V32).",
    handler: (input: GraphPatch, context) => applyGraphPatch(input, context),
    rejectionOutput: (_input, diagnostics, revision): GraphPatchResult => ({
      status: "rejected",
      revision,
      appliedOperations: 0,
      diagnostics,
      createdIds: {},
    }),
  });

  bus.registerCommand({
    name: "graph.undo",
    description: "Undo this actor's most recent undo group.",
    handler: (_input, context) => {
      const history = context.store.getHistory(context.actor);
      const group = history.undo[history.undo.length - 1];
      if (group === undefined) {
        return {
          status: "rejected",
          revision: context.store.getRevision(),
          diagnostics: [
            { severity: "info", code: "history.empty", message: "Nothing to undo for this actor." },
          ],
          output: { undoGroupId: null, label: null, revision: context.store.getRevision() },
        };
      }
      if (context.dryRun) {
        // §V36/T102: "validated", never "applied" — nothing moved on the history stack.
        return {
          status: "validated",
          revision: context.store.getRevision(),
          diagnostics: [
            {
              severity: "info",
              code: "history.dryRun",
              message: `Dry run: would undo "${group.label}".`,
            },
          ],
          output: { undoGroupId: group.id, label: group.label, revision: context.store.getRevision() },
        };
      }
      const outcome = context.undoLast();
      return {
        status: outcome.status,
        revision: outcome.revision,
        diagnostics: outcome.diagnostics,
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
        output: {
          undoGroupId: outcome.undoGroupId ?? null,
          label: group.label,
          revision: outcome.revision,
        },
      };
    },
  });

  bus.registerCommand({
    name: "graph.redo",
    description: "Redo this actor's most recently undone group.",
    handler: (_input, context) => {
      const history = context.store.getHistory(context.actor);
      const group = history.redo[history.redo.length - 1];
      if (group === undefined) {
        return {
          status: "rejected",
          revision: context.store.getRevision(),
          diagnostics: [
            { severity: "info", code: "history.empty", message: "Nothing to redo for this actor." },
          ],
          output: { undoGroupId: null, label: null, revision: context.store.getRevision() },
        };
      }
      if (context.dryRun) {
        return {
          status: "validated",
          revision: context.store.getRevision(),
          diagnostics: [
            {
              severity: "info",
              code: "history.dryRun",
              message: `Dry run: would redo "${group.label}".`,
            },
          ],
          output: { undoGroupId: group.id, label: group.label, revision: context.store.getRevision() },
        };
      }
      const outcome = context.redoLast();
      return {
        status: outcome.status,
        revision: outcome.revision,
        diagnostics: outcome.diagnostics,
        ...(outcome.undoGroupId === undefined ? {} : { undoGroupId: outcome.undoGroupId }),
        output: {
          undoGroupId: outcome.undoGroupId ?? null,
          label: group.label,
          revision: outcome.revision,
        },
      };
    },
  });

  /**
   * Revert a transaction as ONE unit (T177, §V34, §V42).
   *
   * "Undo everything that agent just did" is the review gate's central affordance, and
   * until now the only way to answer it was for the adapter to remember which undo
   * groups it had seen come back from which tool call. That ledger is a second copy of
   * state the store already holds — it does not survive a reload, it cannot see a group
   * that coalesced, and an out-of-process MCP server has no way to build one at all.
   *
   * The loop stops as soon as the top of the stack is NOT part of the transaction: undo
   * is actor-local and strictly stack-ordered (§V41), so reverting past a foreign group
   * would undo work the user never asked to lose. Whatever is left is reported rather
   * than forced — `remainingGroupIds` is the honest answer to "why is that node still
   * there".
   */
  bus.registerCommand({
    name: "graph.revertTransaction",
    description: "Undo every undo group belonging to one transaction, newest first (§V34).",
    handler: (input, context) => {
      const revisionNow = (): Revision => context.store.getRevision();
      const groupsOf = (): string[] =>
        context.store
          .getHistory(context.actor)
          .undo.filter((group) => group.transactionId === input.transactionId)
          .map((group) => group.id);

      const owned = groupsOf();
      if (owned.length === 0) {
        return {
          status: "rejected",
          revision: revisionNow(),
          diagnostics: [
            {
              severity: "info",
              code: "transaction.empty",
              // The id came from the caller; no document text is quoted (§V37).
              message: `This actor's undo history holds no group for transaction "${input.transactionId}".`,
              suggestion: "Read graph.history and match on transactionId.",
            },
          ],
          output: {
            transactionId: input.transactionId,
            undoneGroupIds: [],
            remainingGroupIds: [],
            revision: revisionNow(),
          },
        };
      }

      if (context.dryRun) {
        return {
          status: "validated",
          revision: revisionNow(),
          diagnostics: [
            {
              severity: "info",
              code: "transaction.dryRun",
              message: `Dry run: ${owned.length} undo group(s) belong to this transaction; nothing was reverted.`,
            },
          ],
          output: {
            transactionId: input.transactionId,
            undoneGroupIds: [],
            remainingGroupIds: owned,
            revision: revisionNow(),
          },
        };
      }

      const remaining = new Set(owned);
      const undone: string[] = [];
      const diagnostics: RuntimeDiagnostic[] = [];

      while (remaining.size > 0) {
        const history = context.store.getHistory(context.actor);
        const top = history.undo[history.undo.length - 1];
        if (top === undefined || top.transactionId !== input.transactionId) break;
        const outcome = context.undoLast();
        diagnostics.push(...outcome.diagnostics);
        // A blocked step (§V41: another actor owns those entities now) keeps its entry
        // and would loop forever if we retried it.
        if (outcome.status !== "applied") break;
        remaining.delete(top.id);
        undone.push(top.id);
      }

      if (remaining.size > 0) {
        diagnostics.push({
          severity: "warning",
          code: "transaction.partialRevert",
          message: `Reverted ${undone.length} of ${owned.length} edit group(s); the rest are no longer at the top of this actor's history.`,
          suggestion: "Undo the newer edits first, or revert those groups individually.",
        });
      }

      return {
        // Something was reverted, so the document changed and this is an applied
        // mutation; `remainingGroupIds` — not the status — is what says the unit was
        // incomplete. A revert that moved nothing at all is a rejection.
        status: undone.length > 0 ? "applied" : "rejected",
        revision: revisionNow(),
        diagnostics,
        output: {
          transactionId: input.transactionId,
          undoneGroupIds: undone,
          remainingGroupIds: [...remaining],
          revision: revisionNow(),
        },
      };
    },
    rejectionOutput: (input, _diagnostics, revision): RevertTransactionOutput => ({
      transactionId: input.transactionId,
      undoneGroupIds: [],
      remainingGroupIds: [],
      revision,
    }),
  });

  bus.registerQuery({
    name: "graph.get",
    description: "The current graph document.",
    handler: (_input, context): GraphDocument => context.graph,
  });

  bus.registerQuery({
    name: "graph.audit",
    description: "Mutation audit log (§V31).",
    handler: (input, context): AuditEntry[] => {
      const entries = [...context.store.getAudit()];
      const limit = input.limit;
      return limit === undefined ? entries : entries.slice(-Math.max(0, limit));
    },
  });

  bus.registerQuery({
    name: "graph.history",
    description: "Undo and redo stacks for the calling actor (§V41).",
    handler: (_input, context): HistorySummary => {
      const history = context.store.getHistory(context.actor);
      const summarise = (groups: typeof history.undo): HistoryGroupSummary[] =>
        groups.map((group) => ({
          id: group.id,
          label: group.label,
          command: group.command,
          revisionBefore: group.revisionBefore,
          revisionAfter: group.revisionAfter,
          transactionId: group.transactionId ?? null,
        }));
      return {
        actorKey: `${context.actor.kind}:${context.actor.id}`,
        undo: summarise(history.undo),
        redo: summarise(history.redo),
      };
    },
  });
}
