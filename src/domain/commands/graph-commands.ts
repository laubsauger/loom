import type { AuditEntry } from "../types/commands.ts";
import type { GraphDocument } from "../types/graph.ts";
import type { GraphPatch, GraphPatchResult } from "../types/patch.ts";
import type { Revision } from "../types/ids.ts";
import type { ShaderloomBus } from "./bus.ts";
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
}

export interface HistorySummary {
  actorKey: string;
  undo: HistoryGroupSummary[];
  redo: HistoryGroupSummary[];
}

/** Registers `graph.applyPatch`, `graph.undo`, `graph.redo` and the graph queries. */
export function registerGraphCommands(bus: ShaderloomBus): void {
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
        return {
          status: "applied",
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
          status: "applied",
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
        }));
      return {
        actorKey: `${context.actor.kind}:${context.actor.id}`,
        undo: summarise(history.undo),
        redo: summarise(history.redo),
      };
    },
  });
}
