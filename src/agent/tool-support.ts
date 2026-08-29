import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { Revision } from "@domain/types/ids.ts";
import type { GraphPatchOperation, GraphPatchResult } from "@domain/types/patch.ts";

import type { DispatchResult, ToolResult, ToolRuntime, ToolStatus } from "./types.ts";

/**
 * Shared plumbing for the tool implementations.
 *
 * Every helper here is projection: a bus result in, a stable envelope out. None of it
 * decides what an edit means (§V39). The two rules it enforces on every tool:
 *
 *  - **A dry run is never reported as applied.** `graph.applyPatch` answers a dry run
 *    with status `"applied"` and a populated `createdIds` today (logged as T102). An
 *    agent reading "applied" for an edit that did not happen will build its next patch on
 *    ids that do not exist, so the adapter reports `validated` — which it can do honestly,
 *    because IT is the one that asked for the dry run — and withholds the provisional ids
 *    rather than handing back references to nodes nobody created (§V36).
 *  - **No document text is ever interpolated into a message.** Diagnostics authored here
 *    name ids and counts, never labels, type titles or shader text (§V37).
 */

export function diagnostic(
  severity: RuntimeDiagnostic["severity"],
  code: string,
  message: string,
  extra: Partial<RuntimeDiagnostic> = {},
): RuntimeDiagnostic {
  return { severity, code, message, ...extra };
}

export interface ResultExtras {
  readonly diagnostics?: readonly RuntimeDiagnostic[];
  readonly revision?: Revision | null;
  readonly undoGroupId?: string | undefined;
  readonly transactionId?: string | undefined;
  readonly proposalId?: string | undefined;
}

export function result<TData>(
  tool: string,
  status: ToolStatus,
  data: TData | null,
  extras: ResultExtras = {},
): ToolResult<TData> {
  return {
    tool,
    status,
    data,
    diagnostics: extras.diagnostics ?? [],
    revision: extras.revision ?? null,
    ...(extras.undoGroupId === undefined ? {} : { undoGroupId: extras.undoGroupId }),
    ...(extras.transactionId === undefined ? {} : { transactionId: extras.transactionId }),
    ...(extras.proposalId === undefined ? {} : { proposalId: extras.proposalId }),
  };
}

export function ok<TData>(tool: string, data: TData, extras: ResultExtras = {}): ToolResult<TData> {
  return result(tool, "ok", data, extras);
}

export function failed<TData>(
  tool: string,
  code: string,
  message: string,
  extras: ResultExtras & { suggestion?: string } = {},
): ToolResult<TData> {
  const { suggestion, ...rest } = extras;
  return result<TData>(tool, "error", null, {
    ...rest,
    diagnostics: [
      diagnostic("error", code, message, suggestion === undefined ? {} : { suggestion }),
      ...(rest.diagnostics ?? []),
    ],
  });
}

/** What every patch-backed tool returns. Mirrors `GraphPatchResult`, minus the lie. */
export interface PatchToolData {
  readonly status: "applied" | "validated" | "rejected" | "conflict";
  readonly revision: Revision;
  readonly appliedOperations: number;
  /** Patch-local temp id -> stable id (§V35). Empty on a dry run: nothing was created. */
  readonly createdIds: Record<string, string>;
  readonly undoGroupId: string | null;
}

const PATCH_STATUS: Record<DispatchResult<unknown>["status"], ToolStatus> = {
  applied: "ok",
  rejected: "rejected",
  conflict: "conflict",
};

function isPatchResult(value: unknown): value is GraphPatchResult {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<GraphPatchResult>;
  return typeof candidate.status === "string" && typeof candidate.appliedOperations === "number";
}

/**
 * Runs one command whose output is a `GraphPatchResult` and projects it.
 *
 * `graph.applyPatch`, `graph.removeNodes`, `node.rename`, `node.setResolution` and the
 * toggles all answer in this shape, because they are all the same patch path underneath —
 * which is exactly why the adapter has one projection and not five.
 */
export async function dispatchPatchCommand(
  tool: string,
  command: string,
  input: unknown,
  runtime: ToolRuntime,
): Promise<ToolResult<PatchToolData>> {
  const dispatched = await runtime.execute<unknown>(command, input);
  const output = dispatched.output;
  const patch: GraphPatchResult = isPatchResult(output)
    ? output
    : {
        status: dispatched.status,
        revision: dispatched.revision,
        appliedOperations: 0,
        diagnostics: [...dispatched.diagnostics],
        createdIds: {},
      };

  const applied = dispatched.status === "applied";
  const status: ToolStatus = applied && runtime.dryRun ? "validated" : PATCH_STATUS[dispatched.status];

  const diagnostics: RuntimeDiagnostic[] = [...dispatched.diagnostics];
  if (applied && runtime.dryRun) {
    diagnostics.push(
      diagnostic(
        "info",
        "tool.dryRun",
        `Validated ${patch.appliedOperations} operation(s); nothing was applied and no ids were created.`,
        {
          suggestion:
            "Call again without dryRun to apply. Ids are minted only by a real apply, so build follow-up work from that result.",
        },
      ),
    );
  }

  const data: PatchToolData = {
    status: applied && runtime.dryRun ? "validated" : dispatched.status,
    revision: dispatched.revision,
    appliedOperations: patch.appliedOperations,
    createdIds: applied && runtime.dryRun ? {} : { ...patch.createdIds },
    undoGroupId: dispatched.undoGroupId ?? null,
  };

  return result(tool, status, data, {
    diagnostics,
    revision: dispatched.revision,
    ...(dispatched.undoGroupId === undefined ? {} : { undoGroupId: dispatched.undoGroupId }),
  });
}

/** One-operation convenience edit, sent down the same atomic patch path (§V32). */
export async function dispatchOperations(
  tool: string,
  runtime: ToolRuntime,
  operations: readonly GraphPatchOperation[],
  options: { label: string; baseRevision?: number | undefined },
): Promise<ToolResult<PatchToolData>> {
  const baseRevision = options.baseRevision ?? (await runtime.revision());
  return dispatchPatchCommand(tool, "graph.applyPatch", {
    baseRevision,
    label: options.label,
    operations: [...operations],
  }, runtime);
}
