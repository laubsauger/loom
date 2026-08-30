import type { NodeId } from "../../domain/types/ids.ts";
import type {
  PassSpanResults,
  PassTimingRow,
  PassTimingSource,
  TelemetryBuildStats,
  TelemetryPass,
  TelemetryPlan,
  TelemetrySnapshot,
  TelemetrySource,
  TelemetrySourcePath,
  TimingAvailability,
  TimingBucket,
} from "./types.ts";
import { NO_PASS_TIMING, emptyNodeTelemetry } from "./types.ts";
import { aggregateComponentTiming, aggregateNodeTiming } from "./aggregate.ts";
import type { ComponentTiming } from "./aggregate.ts";

/**
 * The metrics pipe (T41, T42, §V16).
 *
 * ## Why this exists at all
 *
 * Per-frame numbers must reach the UI without touching the document store. Routing them
 * through the store would be wrong three times over: every metric tick would bump the
 * document revision (making undo history meaningless), every tick would re-render the
 * whole node tree, and a 60 Hz metric would end up serialized into the saved project.
 * §V16 forbids all three. So the hub is an ordinary out-of-document observable that the
 * backend, the frame driver and the compiler push into, and the UI samples.
 *
 * ## Rate
 *
 * Producers push at frame rate. Consumers are notified at most once per `intervalMs`
 * (100 ms — §V16's "<= 10 Hz" is a cap, not a target). The coalescing is here, in the
 * producer, not in each consumer: a consumer that forgets to throttle would otherwise
 * silently reintroduce a 60 Hz React render, and nothing would catch it.
 *
 * The hub also mirrors per-node `gpuMs` into the graph canvas's existing per-node runtime
 * channel through `NodeMetricSink`, which is deliberately a two-method structural type
 * rather than an import: `src/runtime` must not depend on `src/editor`, and there must be
 * exactly ONE per-node channel — the canvas already owns it and already coalesces, so we
 * publish into it rather than standing up a second one for nodes to subscribe to.
 *
 * ## Timing
 *
 * Every number in here comes from `PassTimingSource`, which the backend backs with vgpu's
 * `timer(gpu)` spans. Nothing in this module reads a clock to produce a duration. When
 * the device reports no timestamp query the hub never receives a span, and every bucket
 * it hands out reads `unavailable` (§V86, §V12).
 */

/**
 * The per-node channel this hub feeds. `NodeRuntimeStore` from
 * `src/editor/graph-canvas/node-runtime.ts` satisfies it structurally.
 */
export interface NodeMetricSink {
  publish(nodeId: NodeId, patch: { gpuMs?: number | null }): void;
}

/**
 * §V16's cap. Matches `METRIC_TICK_MS` in the graph canvas's runtime channel; restated
 * rather than imported because runtime may not depend on editor.
 */
export const TELEMETRY_TICK_MS = 100;

/** A plan shaped as the compiler emits it. `CompiledGraph` satisfies this structurally. */
export interface PlanLike {
  readonly passes: ReadonlyArray<{
    readonly id: string;
    readonly kind: string;
    readonly nodeId?: string | undefined;
    readonly label?: string | undefined;
  }>;
  readonly resources: ReadonlyArray<unknown>;
  readonly order: ReadonlyArray<NodeId>;
  readonly pruned: ReadonlyArray<NodeId>;
  readonly sources: ReadonlyArray<TelemetrySourcePath>;
  readonly estimatedResourceBytes: number;
}

/** Projects a compiled plan into the static half of a telemetry snapshot. */
export function telemetryPlan(
  plan: PlanLike,
  options: { readonly memoryBudgetBytes?: number | undefined } = {},
): TelemetryPlan {
  const passes: TelemetryPass[] = plan.passes.map((pass) => ({
    id: pass.id,
    kind: pass.kind,
    nodeId: pass.nodeId ?? null,
    label: pass.label ?? null,
  }));
  return {
    passes,
    sources: plan.sources,
    resourceCount: plan.resources.length,
    estimatedResourceBytes: plan.estimatedResourceBytes,
    memoryBudgetBytes: options.memoryBudgetBytes ?? null,
    nodeCount: plan.order.length,
    prunedCount: plan.pruned.length,
  };
}

export interface TelemetryHubOptions {
  /** The graph canvas's per-node runtime channel. Omitted, node gpuMs is not mirrored. */
  readonly sink?: NodeMetricSink | undefined;
  /** Minimum gap between UI notifications, ms. Never raised above the §V16 cap silently. */
  readonly intervalMs?: number | undefined;
  /** Injected so tests drive the clock. Not a timing source — only the flush schedule. */
  readonly now?: (() => number) | undefined;
}

export interface TelemetryHub extends TelemetrySource {
  /** Static plan facts. Called once per compile, never per frame. */
  setPlan(plan: TelemetryPlan | null): void;
  /** `BackendStatus.lastBuild` after a structural build (T143). */
  setBuild(build: TelemetryBuildStats | null): void;
  /**
   * Points the hub at the backend's GPU timer. Returns a detach function. Passing a
   * source with `timestampQuery: false` puts every field into the "unavailable" reading.
   */
  attachTimingSource(source: PassTimingSource): () => void;
  /** One rendered frame. Counters only — no allocation, no listener call (§V16). */
  /**
   * One rendered frame (T255, §V85). `ran` is the set of node ids whose passes were
   * actually ENCODED this frame — the cook gate's answer once T254 lands. Absent means
   * "everything in the plan ran", which is the truth today (no gating exists) and
   * becomes a lie the moment it does; the parameter is the seam that keeps the popup's
   * "cooking every frame?" honest through that transition.
   */
  noteFrame(frameIndex: number, ran?: ReadonlySet<NodeId>): void;
  /** Component aggregate over flattened source paths (T146, §V87). */
  componentTiming(instanceId: NodeId): ComponentTiming;
  /** Plain-node aggregate: own passes only. */
  nodeTiming(nodeId: NodeId): ComponentTiming;
  dispose(): void;
}

interface NodeCounters {
  framesRendered: number;
  lastRenderedFrame: number | null;
}

export function createTelemetryHub(options: TelemetryHubOptions = {}): TelemetryHub {
  const intervalMs = options.intervalMs ?? TELEMETRY_TICK_MS;
  const now = options.now ?? (() => Date.now());
  const sink = options.sink;

  let timingSource: PassTimingSource = NO_PASS_TIMING;
  let detachTiming: (() => void) | null = null;

  let plan: TelemetryPlan | null = null;
  let build: TelemetryBuildStats | null = null;
  let framesRendered = 0;
  let lastFrameIndex: number | null = null;

  /** Most recent GPU span per pass id, ms. Only ever written from `onPassTimings`. */
  const spans = new Map<string, number>();
  const counters = new Map<NodeId, NodeCounters>();
  /** Node ids that have at least one pass in the current plan. Rebuilt on setPlan. */
  let activeNodes: ReadonlySet<NodeId> = new Set();
  let keptNodes: ReadonlySet<NodeId> = new Set();
  let sourcePathByNode: ReadonlyMap<NodeId, string> = new Map();

  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastFlush = Number.NEGATIVE_INFINITY;
  /** Set when something changed since the last flush. Prevents empty notifications. */
  let dirty = false;
  let disposed = false;

  let cached: TelemetrySnapshot | null = null;

  function availability(): TimingAvailability {
    return timingSource.timestampQuery ? "measured" : "unavailable";
  }

  function indexPlan(next: TelemetryPlan | null): void {
    const active = new Set<NodeId>();
    for (const pass of next?.passes ?? []) {
      if (pass.nodeId !== null) active.add(pass.nodeId);
    }
    activeNodes = active;
    keptNodes = new Set(next === null ? [] : plansKeptNodes(next));
    const paths = new Map<NodeId, string>();
    for (const source of next?.sources ?? []) paths.set(source.nodeId, source.sourcePath);
    sourcePathByNode = paths;
  }

  function plansKeptNodes(next: TelemetryPlan): ReadonlyArray<NodeId> {
    // `nodeCount` is a count, not a list; the nodes telemetry can name are the ones that
    // actually appear in the plan (as a pass owner or as a flattened source entry).
    const ids = new Set<NodeId>();
    for (const pass of next.passes) if (pass.nodeId !== null) ids.add(pass.nodeId);
    for (const source of next.sources) ids.add(source.nodeId);
    return [...ids];
  }

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function flush(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    lastFlush = now();
    if (!dirty) return;
    dirty = false;
    cached = null;

    // Mirror per-node GPU time into the canvas's existing per-node channel. Nodes with no
    // measured span get `null`, which is what "no timing" renders as — never 0 (§V86).
    if (sink !== undefined) {
      for (const nodeId of activeNodes) {
        sink.publish(nodeId, { gpuMs: nodeOwnBucket(nodeId).gpuMs });
      }
    }
    notify();
  }

  function schedule(): void {
    dirty = true;
    if (disposed || timer !== null) return;
    const wait = Math.max(0, intervalMs - (now() - lastFlush));
    timer = setTimeout(flush, wait);
  }

  function nodeOwnBucket(nodeId: NodeId): TimingBucket {
    return aggregateNodeTiming(nodeId, aggregateInput()).own;
  }

  function aggregateInput() {
    return {
      passes: plan?.passes ?? [],
      sources: plan?.sources ?? [],
      spans,
      timingAvailable: timingSource.timestampQuery,
      keptNodes,
    };
  }

  function frameBucket(): TimingBucket {
    const passes = plan?.passes ?? [];
    let total = 0;
    let measured = 0;
    const nodes = new Set<NodeId>();
    for (const pass of passes) {
      if (pass.nodeId !== null) nodes.add(pass.nodeId);
      const span = spans.get(pass.id);
      if (span === undefined) continue;
      total += span;
      measured += 1;
    }
    // §V86: with no timestamp query the counts are still real and still worth showing —
    // it is only the DURATION that does not exist, and it says so rather than reading 0.
    const has = timingSource.timestampQuery && (measured > 0 || passes.length === 0);
    return {
      availability: !timingSource.timestampQuery ? "unavailable" : has ? "measured" : "pending",
      gpuMs: has ? total : null,
      passCount: passes.length,
      nodeCount: nodes.size,
    };
  }

  function passRows(): ReadonlyArray<PassTimingRow> {
    const supported = timingSource.timestampQuery;
    return (plan?.passes ?? []).map((pass): PassTimingRow => {
      const span = supported ? spans.get(pass.id) : undefined;
      return {
        passId: pass.id,
        kind: pass.kind,
        nodeId: pass.nodeId,
        sourcePath: pass.nodeId === null ? null : (sourcePathByNode.get(pass.nodeId) ?? null),
        label: pass.label,
        availability: !supported ? "unavailable" : span === undefined ? "pending" : "measured",
        gpuMs: span ?? null,
      };
    });
  }

  function buildSnapshot(): TelemetrySnapshot {
    const budget = plan?.memoryBudgetBytes ?? null;
    return {
      timingAvailable: timingSource.timestampQuery,
      plan,
      build,
      framesRendered,
      lastFrameIndex,
      frame: frameBucket(),
      passes: passRows(),
      overBudget: budget !== null && plan !== null && plan.estimatedResourceBytes > budget,
    };
  }

  return {
    setPlan(next) {
      plan = next;
      indexPlan(next);
      // Spans belong to pass ids that may no longer exist. Dropping stale ones is what
      // keeps a recompile from reporting the previous plan's cost against a new pass id.
      const live = new Set((next?.passes ?? []).map((pass) => pass.id));
      for (const passId of [...spans.keys()]) if (!live.has(passId)) spans.delete(passId);
      for (const nodeId of [...counters.keys()]) if (!activeNodes.has(nodeId)) counters.delete(nodeId);
      schedule();
    },

    setBuild(next) {
      build = next;
      schedule();
    },

    attachTimingSource(source) {
      detachTiming?.();
      timingSource = source;
      spans.clear();
      const off = source.onPassTimings((results: PassSpanResults) => {
        for (const [passId, ms] of Object.entries(results)) {
          if (Number.isFinite(ms)) spans.set(passId, ms);
        }
        schedule();
      });
      detachTiming = () => {
        off();
        detachTiming = null;
        timingSource = NO_PASS_TIMING;
        spans.clear();
        schedule();
      };
      schedule();
      return () => detachTiming?.();
    },

    noteFrame(frameIndex, ran) {
      framesRendered += 1;
      lastFrameIndex = frameIndex;
      for (const nodeId of ran ?? activeNodes) {
        if (!activeNodes.has(nodeId)) continue; // a stale caller set never invents nodes
        const entry = counters.get(nodeId);
        if (entry === undefined) counters.set(nodeId, { framesRendered: 1, lastRenderedFrame: frameIndex });
        else {
          entry.framesRendered += 1;
          entry.lastRenderedFrame = frameIndex;
        }
      }
      schedule();
    },

    snapshot() {
      cached ??= buildSnapshot();
      return cached;
    },

    nodeTelemetry(nodeId) {
      if (plan === null) return emptyNodeTelemetry(nodeId, availability());
      const entry = counters.get(nodeId);
      return {
        nodeId,
        own: nodeOwnBucket(nodeId),
        framesRendered: entry?.framesRendered ?? 0,
        renderedThisFrame:
          activeNodes.has(nodeId) &&
          entry !== undefined &&
          entry.lastRenderedFrame === lastFrameIndex,
        lastRenderedFrame: entry?.lastRenderedFrame ?? null,
        sourcePath: sourcePathByNode.get(nodeId) ?? null,
      };
    },

    componentTiming(instanceId) {
      return aggregateComponentTiming(instanceId, aggregateInput());
    },

    nodeTiming(nodeId) {
      return aggregateNodeTiming(nodeId, aggregateInput());
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      disposed = true;
      detachTiming?.();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      listeners.clear();
      spans.clear();
      counters.clear();
    },
  };
}
