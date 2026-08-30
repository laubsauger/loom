import type { GraphDocument } from "../../domain/types/graph.ts";
import type { NodeId } from "../../domain/types/ids.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import { analyzeChannelEntries } from "../execution/analyze-channels.ts";
import type { TelemetrySourcePath } from "./types.ts";

/**
 * The readback budget (T278, §V185, §V144).
 *
 * §V185: readbacks are COUNTED and SHOWN. N Analyze nodes are N readbacks per frame, and
 * a user who drops twenty of them has to SEE why it got slow rather than guess. An
 * invisible cost is one that gets paid repeatedly.
 *
 * ## What is counted, and why it is a BUDGET
 *
 * Everything here is derived from the compiled plan and the document, never from a timer.
 * The number is what the graph COSTS per frame: one readback per Analyze node, sized from
 * the resource the plan actually allocates for it. That is deliberately a statement about
 * the graph rather than a count of syscalls, because it is the statement a user can act on
 * — the fix for "twenty readbacks a frame" is to delete some Analyze nodes, and that fix is
 * legible from the plan alone.
 *
 * It is paired with `performed`, the backend's own cumulative readback counter, so the two
 * can be read against each other. They answer different questions and both are worth
 * having: the budget says what the graph asks for every frame, `performed` says what has
 * actually crossed the bus since the device came up (§V7 — playback is supposed to leave
 * that at zero for everything except this sanctioned between-frames path).
 *
 * ## Why bytes and not just a count
 *
 * A count alone ranks a 16-byte reduction the same as a 4K frame grab. §V185 names both,
 * and the size is the half that says whether the cost is the round trip or the transfer.
 *
 * Nothing in this module reads a clock, allocates, or touches the GPU (§V184): it is a
 * projection over a plan that already exists.
 */

/** One thing the running graph reads back from the GPU every frame. */
export interface DeclaredReadback {
  readonly nodeId: NodeId;
  /** The plan resource whose contents cross the bus. Sized from the plan. */
  readonly resourceId: string;
  /** Why this readback exists, in words a user recognises. */
  readonly reason: string;
}

/** Enough of a plan resource to size it. `ResourceDescriptor` satisfies this. */
export interface SizedResource {
  readonly id: string;
  readonly kind: string;
  readonly stride?: number | undefined;
  readonly capacity?: number | undefined;
}

/** One row of the per-node attribution table. */
export interface ReadbackRow {
  readonly nodeId: NodeId;
  /** `Main / Bloom_1 / meter1` when the node came out of a component (§V82), else null. */
  readonly sourcePath: string | null;
  readonly reason: string;
  readonly resourceId: string;
  /**
   * Bytes crossing the bus per frame, or null when the plan names no such resource.
   *
   * Null is not zero. A declared readback whose resource is missing from the plan is a
   * real inconsistency — the node was pruned, or the plan is from before the edit — and
   * showing it as "0 B" would file that under "free" rather than under "wrong".
   */
  readonly bytes: number | null;
}

/** What the plan implies per frame, before anything has run. */
export interface ReadbackPlanBudget {
  /** Readbacks per frame. This is the number §V185 is about. */
  readonly count: number;
  /** Total bytes per frame across `rows`. Rows with unknown size contribute nothing. */
  readonly bytes: number;
  /** Sorted by node id, so the table never reshuffles between ticks. */
  readonly rows: readonly ReadbackRow[];
  /** True when at least one row could not be sized — the total is then a floor. */
  readonly incomplete: boolean;
}

export interface ReadbackBudget extends ReadbackPlanBudget {
  /**
   * `BackendStatus.readbacks` — readbacks the backend has actually performed since the
   * device came up. Null when nothing has reported one, which is a DIFFERENT reading from
   * zero: zero means a backend said "none yet", null means nobody is counting.
   */
  readonly performed: number | null;
}

export const EMPTY_READBACK_BUDGET: ReadbackBudget = Object.freeze({
  count: 0,
  bytes: 0,
  rows: [],
  incomplete: false,
  performed: null,
});

/** Bytes a resource moves when it is read whole. Null when it cannot be sized. */
function sizeOf(resource: SizedResource | undefined): number | null {
  if (resource === undefined) return null;
  const { stride, capacity } = resource;
  if (typeof stride !== "number" || typeof capacity !== "number") return null;
  if (!Number.isFinite(stride) || !Number.isFinite(capacity)) return null;
  return Math.max(0, stride) * Math.max(0, capacity);
}

export interface ReadbackBudgetInput {
  readonly declared: readonly DeclaredReadback[];
  readonly resources: readonly SizedResource[];
  /** The plan's flattened source paths, so a row inside a component names its place. */
  readonly sources: readonly TelemetrySourcePath[];
}

export function readbackPlanBudget(input: ReadbackBudgetInput): ReadbackPlanBudget {
  const byId = new Map(input.resources.map((resource) => [resource.id, resource]));
  const paths = new Map(input.sources.map((source) => [source.nodeId, source.sourcePath]));

  const rows = [...input.declared]
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.resourceId.localeCompare(b.resourceId))
    .map((entry): ReadbackRow => ({
      nodeId: entry.nodeId,
      sourcePath: paths.get(entry.nodeId) ?? null,
      reason: entry.reason,
      resourceId: entry.resourceId,
      bytes: sizeOf(byId.get(entry.resourceId)),
    }));

  let bytes = 0;
  let incomplete = false;
  for (const row of rows) {
    if (row.bytes === null) incomplete = true;
    else bytes += row.bytes;
  }

  return { count: rows.length, bytes, rows, incomplete };
}

/**
 * The readbacks an Analyze node implies (§V144).
 *
 * Today this is the whole list, and it is derived from the same function the CPU sampler
 * itself is driven by (`analyzeChannelEntries`) rather than from a second walk of the
 * graph. Two walks would be two answers to "how many readbacks does this graph do", and
 * the one on screen would be the one nobody checks.
 *
 * A second kind of per-frame readback belongs here beside it, not in a parallel counter.
 */
export function analyzeReadbacks(
  graph: GraphDocument,
  registry: NodeRegistryView,
): readonly DeclaredReadback[] {
  return analyzeChannelEntries(graph, registry).map((entry) => ({
    nodeId: entry.nodeId,
    resourceId: entry.resourceId,
    reason: `Analyze channel "${entry.channel}"`,
  }));
}
