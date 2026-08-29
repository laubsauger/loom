import type { NodeId } from "../../domain/types/ids.ts";
import type {
  ComponentTimingView,
  TelemetryPass,
  TelemetrySourcePath,
  TimingAvailability,
  TimingBucket,
} from "./types.ts";
import { emptyBucket } from "./types.ts";

/**
 * Component timing aggregation (T146, §V87, §V82).
 *
 * A component compiles by FLATTENING into the parent graph (§V82): the instance node
 * itself emits no pass at all, and its internals become ordinary nodes carrying a source
 * path — `Main / DreamyFeedback_2 / Blur_1`. So "how expensive is this component" cannot
 * be answered by looking up the instance's own pass; there is no such pass. It is
 * answered by summing the flattened passes whose source path runs through the instance.
 *
 * The split the spec asks for, and what each half means:
 *
 *   own      passes authored DIRECTLY in this component's graph. `path` ends at us.
 *   children passes that came from component instances nested inside us. `path` contains
 *            us but continues past us — at any depth, so two levels down still counts.
 *   total    own + children. The number the user actually asked for.
 *
 * Reporting only `own` would be the wrong answer for the common case: a Bloom component
 * whose work is three nested Blur instances would read as ~0 ms, which is a lie about
 * where the frame went. Reporting only `total` hides the fact that a component is cheap
 * itself and expensive because of what it contains. Both, plus the split, is the answer.
 *
 * Timing follows §V86 throughout: a bucket is `measured` only when a real GPU span
 * contributed to it, `pending` when its passes exist but no span has landed, and
 * `unavailable` when the device has no timestamp query at all. Never a zero standing in
 * for a missing measurement.
 */

export type ComponentTiming = ComponentTimingView;

export interface AggregateInput {
  /** Passes in the running plan. Only those with a `nodeId` can be attributed. */
  readonly passes: ReadonlyArray<TelemetryPass>;
  /** Flattened node -> where it came from. Empty for a project with no components. */
  readonly sources: ReadonlyArray<TelemetrySourcePath>;
  /** Most recent GPU span per pass id, in ms. Absent = not measured yet (§V86). */
  readonly spans: ReadonlyMap<string, number>;
  /** False when the device reports no timestamp query — every bucket is unavailable. */
  readonly timingAvailable: boolean;
  /**
   * Nodes the plan kept (§V25). Node counts are taken from this rather than from the
   * whole flattened graph: a pruned node costs nothing and must not inflate the count.
   */
  readonly keptNodes?: ReadonlySet<NodeId> | undefined;
}

/** Accumulator, resolved into a `TimingBucket` once every pass has been visited. */
interface Tally {
  passCount: number;
  measuredMs: number;
  measuredPasses: number;
  nodes: Set<NodeId>;
}

function newTally(): Tally {
  return { passCount: 0, measuredMs: 0, measuredPasses: 0, nodes: new Set() };
}

function resolve(tally: Tally, timingAvailable: boolean): TimingBucket {
  const availability: TimingAvailability = !timingAvailable
    ? "unavailable"
    : tally.measuredPasses > 0 || tally.passCount === 0
      ? "measured"
      : "pending";
  return {
    availability,
    // A subject with no passes genuinely costs 0 ms; that is a fact, not a fabrication.
    // A subject WITH passes and no landed span has no number yet, and says so.
    gpuMs: availability === "measured" ? tally.measuredMs : null,
    passCount: tally.passCount,
    nodeCount: tally.nodes.size,
  };
}

function add(tally: Tally, pass: TelemetryPass, spans: ReadonlyMap<string, number>): void {
  tally.passCount += 1;
  if (pass.nodeId !== null) tally.nodes.add(pass.nodeId);
  const span = spans.get(pass.id);
  if (span === undefined) return;
  tally.measuredMs += span;
  tally.measuredPasses += 1;
}

function merge(a: Tally, b: Tally): Tally {
  const nodes = new Set(a.nodes);
  for (const node of b.nodes) nodes.add(node);
  return {
    passCount: a.passCount + b.passCount,
    measuredMs: a.measuredMs + b.measuredMs,
    measuredPasses: a.measuredPasses + b.measuredPasses,
    nodes,
  };
}

/**
 * Where a flattened node sits relative to `instanceId`.
 *
 * `path` is the enclosing instance chain, outermost first, in FLATTENED ids: a node at
 * `Main / A_1 / B_1 / Blur` has path `["a1", "a1/b1"]`. So the last element naming us is
 * "authored directly inside us", and us appearing anywhere earlier is "inside something
 * nested within us" — which is what makes two-levels-deep fall out with no special case.
 */
function placeOf(
  path: ReadonlyArray<NodeId>,
  instanceId: NodeId,
): "own" | "children" | "outside" {
  const last = path.length === 0 ? undefined : path[path.length - 1];
  if (last === instanceId) return "own";
  return path.includes(instanceId) ? "children" : "outside";
}

/**
 * Aggregates the flattened passes belonging to one component instance (§V87).
 *
 * `instanceId` is the instance's id in the FLATTENED graph — `feedback1` at the root,
 * `feedback1/blur2` for an instance nested one level in. That is the same id the source
 * paths are built from, so nesting needs no extra bookkeeping.
 */
export function aggregateComponentTiming(
  instanceId: NodeId,
  input: AggregateInput,
): ComponentTiming {
  const { passes, sources, spans, timingAvailable, keptNodes } = input;

  const pathByNode = new Map<NodeId, ReadonlyArray<NodeId>>();
  for (const source of sources) {
    if (keptNodes !== undefined && !keptNodes.has(source.nodeId)) continue;
    pathByNode.set(source.nodeId, source.path);
  }

  const own = newTally();
  const children = newTally();

  for (const pass of passes) {
    if (pass.nodeId === null) continue;
    const path = pathByNode.get(pass.nodeId);
    if (path === undefined) continue;
    const place = placeOf(path, instanceId);
    if (place === "own") add(own, pass, spans);
    else if (place === "children") add(children, pass, spans);
  }

  // Node counts come from the flattened node set, not from "nodes that emitted a pass":
  // a node inside the component that compiles to nothing is still a node the user placed
  // there, and TD's node count answers "what is in here", not "what cooked".
  for (const [nodeId, path] of pathByNode) {
    const place = placeOf(path, instanceId);
    if (place === "own") own.nodes.add(nodeId);
    else if (place === "children") children.nodes.add(nodeId);
  }

  return {
    own: resolve(own, timingAvailable),
    children: resolve(children, timingAvailable),
    total: resolve(merge(own, children), timingAvailable),
  };
}

/** The plain-node case: own passes only, no children, total == own. */
export function aggregateNodeTiming(nodeId: NodeId, input: AggregateInput): ComponentTiming {
  const own = newTally();
  own.nodes.add(nodeId);
  for (const pass of input.passes) {
    if (pass.nodeId !== nodeId) continue;
    add(own, pass, input.spans);
  }
  const bucket = resolve(own, input.timingAvailable);
  return {
    own: bucket,
    children: emptyBucket(input.timingAvailable ? "measured" : "unavailable"),
    total: bucket,
  };
}
