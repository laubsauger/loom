import type { GraphDocument } from "../../domain/types/graph.ts";
import type { NodeId } from "../../domain/types/ids.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { TelemetryPass, TelemetrySourcePath, TimingAvailability } from "./types.ts";

/**
 * Per-node CPU and GPU cost, with category rollups (T256, §V86).
 *
 * The one thing Notch's profiler does better than TD's: both halves of a node's cost on
 * the same row. TD shows cook time; Notch shows CPU and GPU side by side, and the pair is
 * what tells you WHICH machine the frame is waiting on. A node that costs 8 ms of GPU and
 * nothing on the CPU wants a cheaper shader; one that costs 8 ms of CPU and nothing on the
 * GPU is being re-encoded when it should not be. A single blended number cannot say which,
 * and neither can two numbers on two different screens.
 *
 * ## The §V86 boundary, restated because this is where it gets tested
 *
 * §V86 says a node's timing comes from GPU timer spans and never from CPU encode duration.
 * That rule survives here intact, and the way it survives is that the two are NEVER mixed:
 * they are separate columns with separate labels, separate availability, and they are never
 * summed. What §V86 forbids is a CPU number wearing the GPU label — a stand-in that sends
 * someone optimising a pass that costs nothing. Showing CPU as CPU is the opposite of that.
 *
 * ## Why "unavailable" and not zero, for both halves
 *
 * `timestamp-query` is optional (§V12) and unavailable on some devices — headless Dawn
 * reports it as an info diagnostic rather than an error, so a build can look entirely
 * healthy and still measure nothing. A zero in that cell reads as FREE, and someone will
 * spend an afternoon optimising the node above it. So an absent measurement is a WORD in
 * every path through this module, and the sum of a set of unmeasured nodes is absent too
 * rather than 0.000 ms.
 *
 * Nothing here reads a clock (§V44): every number arrives from a span source the backend
 * owns, and this module only groups what it is given.
 */

/**
 * One cost, measured or not.
 *
 * Deliberately NOT `TimingBucket`: that type's number is called `gpuMs`, and putting CPU
 * milliseconds in a field with that name is precisely the confusion §V86 exists to stop —
 * it would be one careless read away from being rendered under the GPU label.
 */
export interface CostBucket {
  readonly availability: TimingAvailability;
  /** Non-null only when `availability` is "measured". */
  readonly ms: number | null;
}

export const UNAVAILABLE_COST: CostBucket = Object.freeze({
  availability: "unavailable",
  ms: null,
});

export function costBucket(available: boolean, ms: number | null): CostBucket {
  if (!available) return UNAVAILABLE_COST;
  return ms === null ? { availability: "pending", ms: null } : { availability: "measured", ms };
}

/** Categories a node can roll up under. The node manifest's own `category`. */
export const UNCATEGORISED = "other";

/** One node's cost, both halves. */
export interface NodeCostRow {
  readonly nodeId: NodeId;
  /** `Main / Bloom_1 / blur1` when the node came out of a component (§V82), else null. */
  readonly sourcePath: string | null;
  readonly label: string | null;
  readonly category: string;
  /** Passes this node owns. A Blur is two; the unit of the row is the NODE. */
  readonly passCount: number;
  readonly cpu: CostBucket;
  readonly gpu: CostBucket;
}

/** One category's total, over the nodes in it. */
export interface CategoryRollup {
  readonly category: string;
  readonly nodeCount: number;
  readonly passCount: number;
  readonly cpu: CostBucket;
  readonly gpu: CostBucket;
}

export interface CostInput {
  readonly passes: readonly TelemetryPass[];
  readonly sources: readonly TelemetrySourcePath[];
  /** Latest GPU span per pass id, ms. */
  readonly gpuSpans: ReadonlyMap<string, number>;
  /** Latest CPU span per pass id, ms. */
  readonly cpuSpans: ReadonlyMap<string, number>;
  readonly gpuAvailable: boolean;
  readonly cpuAvailable: boolean;
  /** Node id -> manifest category. Missing ids roll up under `UNCATEGORISED`. */
  readonly categories: ReadonlyMap<NodeId, string>;
}

/** Sums spans for a set of pass ids. Null when the source has produced none of them. */
function sumSpans(
  passIds: readonly string[],
  spans: ReadonlyMap<string, number>,
): number | null {
  let total = 0;
  let measured = 0;
  for (const passId of passIds) {
    const span = spans.get(passId);
    if (span === undefined) continue;
    total += span;
    measured += 1;
  }
  return measured === 0 ? null : total;
}

/**
 * Per-node rows, sorted by node id so the table never reshuffles between ticks.
 *
 * Sorting by cost would be more useful and is wrong: the rows update at 10 Hz, and a table
 * that reorders itself under the pointer cannot be read, let alone clicked.
 */
export function nodeCostRows(input: CostInput): readonly NodeCostRow[] {
  const byNode = new Map<NodeId, { passIds: string[]; label: string | null }>();
  for (const pass of input.passes) {
    if (pass.nodeId === null) continue;
    const entry = byNode.get(pass.nodeId);
    if (entry === undefined) byNode.set(pass.nodeId, { passIds: [pass.id], label: pass.label });
    else {
      entry.passIds.push(pass.id);
      entry.label ??= pass.label;
    }
  }

  const paths = new Map(input.sources.map((source) => [source.nodeId, source.sourcePath]));

  return [...byNode.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([nodeId, entry]): NodeCostRow => ({
      nodeId,
      sourcePath: paths.get(nodeId) ?? null,
      label: entry.label,
      category: input.categories.get(nodeId) ?? UNCATEGORISED,
      passCount: entry.passIds.length,
      cpu: costBucket(input.cpuAvailable, sumSpans(entry.passIds, input.cpuSpans)),
      gpu: costBucket(input.gpuAvailable, sumSpans(entry.passIds, input.gpuSpans)),
    }));
}

/** Adds two buckets. Absent + absent stays absent; a measured half carries the sum. */
function addCost(left: CostBucket, right: CostBucket): CostBucket {
  if (left.ms === null && right.ms === null) {
    // Both absent. Keep the WORSE reading: "unavailable" outranks "pending", because a
    // category containing one unmeasurable node has an unmeasurable total, and calling
    // that "measuring…" would promise a number that is never coming.
    const availability: TimingAvailability =
      left.availability === "unavailable" || right.availability === "unavailable"
        ? "unavailable"
        : "pending";
    return { availability, ms: null };
  }
  return { availability: "measured", ms: (left.ms ?? 0) + (right.ms ?? 0) };
}

/**
 * Category totals, sorted by category name.
 *
 * The rollup is the answer to "where did the frame go" at the altitude someone starts at:
 * a project with sixty nodes has maybe six categories, and "filters cost 11 ms" narrows
 * the search before any individual row has to be read.
 */
export function categoryRollups(rows: readonly NodeCostRow[]): readonly CategoryRollup[] {
  const byCategory = new Map<string, CategoryRollup>();
  for (const row of rows) {
    const current = byCategory.get(row.category);
    if (current === undefined) {
      byCategory.set(row.category, {
        category: row.category,
        nodeCount: 1,
        passCount: row.passCount,
        cpu: row.cpu,
        gpu: row.gpu,
      });
      continue;
    }
    byCategory.set(row.category, {
      category: row.category,
      nodeCount: current.nodeCount + 1,
      passCount: current.passCount + row.passCount,
      cpu: addCost(current.cpu, row.cpu),
      gpu: addCost(current.gpu, row.gpu),
    });
  }
  return [...byCategory.values()].sort((a, b) => a.category.localeCompare(b.category));
}

/**
 * Node id -> manifest category, for the rollup (T256).
 *
 * Built from a document rather than from the plan, because the plan carries pass ids and
 * node ids and never a node type. Feed it the FLATTENED document (T629): the plan's pass
 * ids name flattened inner nodes (`instance/inner`), so categories built from the raw
 * document rolled every component internal up under `other` — invisible exactly when a
 * component contains the animated subgraph dominating the frame. T615 put the flat
 * document in the app's hands; before that this attribution was impossible outside the
 * compiler.
 */
export function nodeCategories(
  graph: GraphDocument,
  registry: NodeRegistryView,
): ReadonlyMap<NodeId, string> {
  const categories = new Map<NodeId, string>();
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    if (node === undefined) continue;
    const category = registry.get(node.type)?.category;
    if (typeof category === "string" && category !== "") categories.set(nodeId, category);
  }
  return categories;
}
