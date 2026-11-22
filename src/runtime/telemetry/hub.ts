import { createFrameTimeline } from "./timeline.ts";
import type { NodeId } from "../../domain/types/ids.ts";
import type {
  CpuSpanResults,
  CpuTimingSource,
  FrameSpanExtent,
  FrameTimingBucket,
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
  TimingUnavailableReason,
} from "./types.ts";
import { NO_CPU_TIMING, NO_PASS_TIMING, emptyNodeTelemetry } from "./types.ts";
import { aggregateComponentTiming, aggregateNodeTiming } from "./aggregate.ts";
import type { ComponentTiming } from "./aggregate.ts";
import { spanBasePassId, spanSharedPasses } from "../backend/plan.ts";
import { EMPTY_READBACK_BUDGET, readbackPlanBudget } from "./readback.ts";
import { categoryRollups, nodeCostRows } from "./cost.ts";
import type { DeclaredReadback, ReadbackBudget, SizedResource } from "./readback.ts";

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
  publish(
    nodeId: NodeId,
    patch: {
      gpuMs?: number | null;
      /**
       * §V329's staleness, on the channel that already exists for exactly this shape
       * (T645). An async node's result age changes every frame, so it belongs beside
       * `gpuMs` — coalesced to <= 10 Hz and read by the node info popup — and NOT in the
       * problems pane, which would take sixty entries a second.
       */
      resultAgeFrames?: number | null;
      /**
       * T965 — the execution provider an inference node ACTUALLY ran on, and the wall time
       * that run took, in ms.
       *
       * On this channel rather than in a notice for `resultAgeFrames`' reason: it changes
       * with every run and a permanent banner about something that is working is noise.
       * MEASURED in the worker by walking the requested ladder one provider at a time —
       * never the node's Backend parameter, which is only ever a request (§T715/§V672).
       */
      inferenceBackend?: string | null;
      inferenceMs?: number | null;
      /** T1041 — the worker's measured `crossOriginIsolated`; false means wasm ran on
       *  ONE thread (no SharedArrayBuffer). Hosted pages without COOP/COEP land false. */
      inferenceIsolated?: boolean | null;
      /**
       * T1816b — what went IN, what the model SAW and what came OUT, in pixels: the picture,
       * the box the preprocess fitted it into, the share of that box the picture filled
       * (the rest is bars the model still pays for), and the published map. Owner: "give
       * the user clarity as to what is actually coming in, going in, coming out".
       */
      inferenceShape?: {
        readonly picture: readonly [number, number];
        readonly box: readonly [number, number];
        readonly fill: number;
        readonly output: readonly [number, number];
      } | null;
      /**
       * T1487b — the model's run state as one line ON THE NODE (still computing, could not
       * run, found nothing). Published on a transition only, never per frame.
       */
      inferenceNote?: { readonly tone: "info" | "warn" | "error"; readonly text: string } | null;
    },
  ): void;
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
  readonly resources: ReadonlyArray<SizedResource>;
  readonly order: ReadonlyArray<NodeId>;
  readonly pruned: ReadonlyArray<NodeId>;
  readonly sources: ReadonlyArray<TelemetrySourcePath>;
  readonly estimatedResourceBytes: number;
}

/** Projects a compiled plan into the static half of a telemetry snapshot. */
export interface TelemetryPlanOptions {
  readonly memoryBudgetBytes?: number | undefined;
  /**
   * What the graph reads back from the GPU every frame (T278, §V185).
   *
   * Passed in rather than derived here because the LIST is a document fact (which nodes
   * declare a readback) while the SIZE is a plan fact (what resource each one allocates),
   * and telemetry only owns the second. `analyzeReadbacks` in `./readback.ts` builds the
   * list from the same function that drives the sampler, so the panel and the sampler can
   * never disagree about how many readbacks a graph does.
   */
  readonly readbacks?: readonly DeclaredReadback[] | undefined;
  /**
   * Node id -> manifest category, for the T256 rollup. `nodeCategories` in `./cost.ts`
   * builds it. Absent, every node rolls up under "other" — which is honest (nothing has
   * said what they are) rather than a guess from the pass kind.
   */
  readonly categories?: ReadonlyMap<NodeId, string> | undefined;
}

export function telemetryPlan(plan: PlanLike, options: TelemetryPlanOptions = {}): TelemetryPlan {
  const passes: TelemetryPass[] = plan.passes.map((pass) => ({
    id: pass.id,
    kind: pass.kind,
    nodeId: pass.nodeId ?? null,
    label: pass.label ?? null,
  }));
  return {
    categories: options.categories ?? new Map<NodeId, string>(),
    readback: readbackPlanBudget({
      declared: options.readbacks ?? [],
      resources: plan.resources,
      sources: plan.sources,
    }),
    passes,
    sources: plan.sources,
    resourceCount: plan.resources.length,
    estimatedResourceBytes: plan.estimatedResourceBytes,
    memoryBudgetBytes: options.memoryBudgetBytes ?? null,
    nodeCount: plan.order.length,
    prunedCount: plan.pruned.length,
  };
}

/** Uniform values are absent from this projection; compare every fact the UI reads. */
function samePlan(a: TelemetryPlan | null, b: TelemetryPlan | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (
    a.resourceCount !== b.resourceCount ||
    a.estimatedResourceBytes !== b.estimatedResourceBytes ||
    a.memoryBudgetBytes !== b.memoryBudgetBytes ||
    a.nodeCount !== b.nodeCount || a.prunedCount !== b.prunedCount ||
    a.passes.length !== b.passes.length || a.sources.length !== b.sources.length ||
    a.categories.size !== b.categories.size ||
    a.readback.count !== b.readback.count || a.readback.bytes !== b.readback.bytes ||
    a.readback.incomplete !== b.readback.incomplete || a.readback.rows.length !== b.readback.rows.length
  ) return false;
  for (const [nodeId, category] of a.categories) {
    if (b.categories.get(nodeId) !== category) return false;
  }
  for (let index = 0; index < a.passes.length; index += 1) {
    const left = a.passes[index]!;
    const right = b.passes[index]!;
    if (left.id !== right.id || left.kind !== right.kind || left.nodeId !== right.nodeId || left.label !== right.label) return false;
  }
  for (let index = 0; index < a.sources.length; index += 1) {
    const left = a.sources[index]!;
    const right = b.sources[index]!;
    if (left.nodeId !== right.nodeId || left.sourcePath !== right.sourcePath || left.path.length !== right.path.length) return false;
    for (let part = 0; part < left.path.length; part += 1) if (left.path[part] !== right.path[part]) return false;
  }
  for (let index = 0; index < a.readback.rows.length; index += 1) {
    const left = a.readback.rows[index]!;
    const right = b.readback.rows[index]!;
    if (left.nodeId !== right.nodeId || left.sourcePath !== right.sourcePath || left.reason !== right.reason ||
      left.resourceId !== right.resourceId || left.bytes !== right.bytes) return false;
  }
  return true;
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
   * `BackendStatus.readbacks` — how many readbacks the backend has actually performed
   * (T278). Null means nobody is counting, which is a different reading from zero and must
   * stay different: zero is a backend saying "none yet".
   */
  setReadbacksPerformed(count: number | null): void;
  /**
   * Why the per-frame compile runs in FULL rather than values-only, or null while the
   * fast path is live or nothing animates (T1254, `FrameCompiler.reason`). Set by the
   * compile hook when it prepares a frame compiler and again when one degrades; a
   * repeat of the current sentence notifies nobody.
   */
  setFrameCompileReason(reason: string | null): void;
  /**
   * §T1544b: one scheduled tick the frame loop HELD (its frame's timeline structure was
   * still installing). A counter and a coalesced notification, like `noteFrame` (§V16).
   */
  noteHeldTick(): void;
  /**
   * Points the hub at a CPU span source (T256). Returns a detach function. Without one
   * every `cpu` bucket reads "unavailable" — the honest state, and the one the app is in
   * until something measures encode time per pass.
   */
  attachCpuTimingSource(source: CpuTimingSource): () => void;
  /**
   * Points the hub at the backend's GPU timer. Returns a detach function. Passing a
   * source with `timestampQuery: false` puts every field into the "unavailable" reading.
   */
  attachTimingSource(source: PassTimingSource): () => void;
  /**
   * T1604b: hands the hub the backend's switch between one device render pass per RUN (the
   * default) and one per DRAW. The hub calls it with whether anybody holds a
   * `demandPassDetail` — at once, and again whenever that changes. Returns a detach
   * function. An `attach*`, so `composition-seams` requires a product call site: without
   * one the performance panel would ask and nothing would answer, and every pass of a run
   * but its first would read "shared" for as long as anyone looked.
   */
  attachPassDetailSwitch(apply: (exact: boolean) => void): () => void;
  /** One rendered frame. Counters only — no allocation, no listener call (§V16). */
  /**
   * One rendered frame (T255, §V85). `ran` is the set of node ids whose passes were
   * actually ENCODED this frame — the cook gate's answer once T254 lands. Absent means
   * "everything in the plan ran", which is the truth today (no gating exists) and
   * becomes a lie the moment it does; the parameter is the seam that keeps the popup's
   * "cooking every frame?" honest through that transition.
   */
  noteFrame(frameIndex: number, ran?: ReadonlySet<NodeId>): void;
  /**
   * T304: performance.now()-domain timestamps of recently rendered frames — the raw
   * half of the frame-clock verdict (`frame-clock.ts` judges; this only remembers).
   * Pruned to the verdict's window on every note, so it never grows.
   */
  recentFrameTimes(): readonly number[];
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

  let cpuSource: CpuTimingSource = NO_CPU_TIMING;
  let detachCpu: (() => void) | null = null;

  let plan: TelemetryPlan | null = null;
  let build: TelemetryBuildStats | null = null;
  let framesRendered = 0;
  /** §T1544b: see `noteHeldTick`. */
  let heldTicks = 0;
  let lastFrameIndex: number | null = null;
  /** T304: see `recentFrameTimes` on the interface. */
  const frameTimes: number[] = [];
  /** §T1392b: every recent frame, GPU extent and event, for the perf tab's timeline. */
  const timeline = createFrameTimeline();
  const perfNow = (): number => (typeof performance === "undefined" ? Date.now() : performance.now());
  let readbacksPerformed: number | null = null;
  let frameCompileReason: string | null = null;

  /** Most recent GPU span per pass id, ms. Only ever written from `onPassTimings`. */
  const spans = new Map<string, number>();
  /**
   * T1604b: runs whose span is SHARED right now — head pass id → how many passes after it
   * (in plan order) the span also covers. Written from the span NAMES the source delivers
   * (`spanSharedPasses`), so it follows what the device was actually asked to do, frame by
   * frame, and needs no second copy of the rule that decides what a run is.
   */
  const sharedRuns = new Map<string, number>();
  /** Plan order, to find the passes that follow a run's head. Rebuilt on setPlan. */
  let passOrder: ReadonlyMap<string, number> = new Map();
  /** T1604b: how many readers want every pass to have its own span, and the backend's switch. */
  let detailDemands = 0;
  let applyDetail: ((exact: boolean) => void) | null = null;
  /**
   * T1243: the latest submitted frame's GPU extent, summed over the vgpu frames that
   * share its submit number. Null until the source delivers one; a source that never
   * does leaves `frameBucket` on the per-pass sum, labelled as such.
   */
  let frameExtent: { submit: number | null; gpuMs: number } | null = null;
  /** T1295: timed frames the source reported as lost since the plan was set. */
  let droppedFrames = 0;
  /** Most recent CPU span per pass id, ms. Only ever written from `onCpuTimings`. */
  const cpuSpans = new Map<string, number>();
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

  /**
   * B172/§V469 — WHICH measured fact is false, never a guess about the machine.
   *
   * `not-attached` is first because it is the one that was true on the owner's Mac while
   * the panel said the adapter had withheld the feature: the device HAD granted it and
   * nothing had ever called `attachTimingSource`. An un-attached hub knows nothing about
   * any device and must not speak for one.
   */
  function unavailableReason(): TimingUnavailableReason | null {
    if (timingSource.timestampQuery) return null;
    if (timingSource === NO_PASS_TIMING) return "not-attached";
    return timingSource.timestampQueryRequested === true ? "not-granted" : "not-requested";
  }

  function indexPlan(next: TelemetryPlan | null): void {
    const active = new Set<NodeId>();
    for (const pass of next?.passes ?? []) {
      if (pass.nodeId !== null) active.add(pass.nodeId);
    }
    activeNodes = active;
    passOrder = new Map((next?.passes ?? []).map((pass, index) => [pass.id, index]));
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

  /**
   * The frame's cost (T1243).
   *
   * ## Why the per-pass spans are not summed into it any more
   *
   * They were, and the sum disagreed with the presented frame by ~10×: 88–105 ms on
   * E24 at a 10 ms rAF interval, 243–357 ms on E55 at 20–27 ms, and 4.98 → 55.2 ms
   * climbing with pass count on chain-200. Measured on Dawn/Metal with raw timestamps
   * (`scratchpad/ts-probe.ts`, 24 dependent 512² passes in one command buffer): the
   * BEGIN timestamp of every pass lands within ~0.1 ms of the command buffer's start
   * (0.000, 0.014, 0.026, 0.080, …) while the END timestamps are sequential (1.45,
   * 2.89, 4.32, …, 8.5). Apple GPUs sample pass timestamps at STAGE boundaries, and a
   * tile-based deferred renderer schedules every encoder's vertex stage up front, so
   * pass k's span is really "frame start → end of pass k". The spans NEST, and their
   * sum is ≈ (N+1)/2 × the frame — 11.7× for N = 24, which is the ratio that was
   * being shown. Not a queue wait inside a span (pass 0 begins at 0), and not preview
   * ticks leaking in (preview passes carry no span and are not in `plan.passes`).
   *
   * An empty marker pass at the end of the frame does not fix it either: with nothing
   * to wait for, its end timestamp landed at 1.5 ms of a 9 ms frame (`ts-probe2.ts`) —
   * the GPU overlaps independent passes wholesale. The only figure that is the frame is
   * earliest begin → latest end across the frame's spans, which vgpu now reports beside
   * the durations (`patches/vgpu.patch`, `Timer.onResults` second argument) and the
   * backend forwards as `FrameSpanExtent`.
   *
   * ## What the bucket carries
   *
   * `gpuMs` is that extent for the latest submit (`basis: "frame"`); `passSumMs` keeps
   * the sum so the per-pass column still adds up to something on screen. A source that
   * delivers no extent (a hand-driven fake) falls back to the sum and says so
   * (`basis: "passes"`) rather than reading null forever — every span in it is still a
   * measured GPU duration (§V86); it is the LABEL "frame" the sum never deserved.
   *
   * On a sequential GPU (no stage overlap) the two figures agree; the label costs
   * nothing there and is what stops the number from lying here.
   */
  function frameBucket(): FrameTimingBucket {
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
    const supported = timingSource.timestampQuery;
    // §V86: with no timestamp query the counts are still real and still worth showing —
    // it is only the DURATION that does not exist, and it says so rather than reading 0.
    const hasSum = supported && (measured > 0 || passes.length === 0);
    const passSumMs = hasSum ? total : null;
    if (supported && frameExtent !== null) {
      return {
        availability: "measured",
        gpuMs: frameExtent.gpuMs,
        basis: "frame",
        passSumMs,
        passCount: passes.length,
        nodeCount: nodes.size,
        droppedFrames,
      };
    }
    return {
      availability: !supported ? "unavailable" : hasSum ? "measured" : "pending",
      gpuMs: passSumMs,
      basis: "passes",
      passSumMs,
      passCount: passes.length,
      nodeCount: nodes.size,
      droppedFrames,
    };
  }

  /** The passes after `head` that share its span, in plan order (T1604b). */
  function sharersOf(head: string, count: number): string[] {
    const at = passOrder.get(head);
    if (at === undefined) return [];
    return (plan?.passes ?? []).slice(at + 1, at + 1 + count).map((pass) => pass.id);
  }

  function passRows(): ReadonlyArray<PassTimingRow> {
    const supported = timingSource.timestampQuery;
    // T1604b: which run each pass's span is shared with, when it is.
    const runOf = new Map<string, { head: string; passes: number }>();
    if (supported) {
      for (const [head, count] of sharedRuns) {
        const run = { head, passes: count + 1 };
        runOf.set(head, run);
        for (const passId of sharersOf(head, count)) runOf.set(passId, run);
      }
    }
    return (plan?.passes ?? []).map((pass): PassTimingRow => {
      const span = supported ? spans.get(pass.id) : undefined;
      const run = runOf.get(pass.id);
      return {
        passId: pass.id,
        kind: pass.kind,
        nodeId: pass.nodeId,
        sourcePath: pass.nodeId === null ? null : (sourcePathByNode.get(pass.nodeId) ?? null),
        label: pass.label,
        availability: !supported ? "unavailable" : span === undefined ? "pending" : "measured",
        gpuMs: span ?? null,
        ...(run === undefined ? {} : { run }),
      };
    });
  }

  /** Plan budget + the observed counter. The plan half is computed once, at setPlan. */
  function readbackBudget(): ReadbackBudget {
    if (plan === null) {
      return readbacksPerformed === null
        ? EMPTY_READBACK_BUDGET
        : { ...EMPTY_READBACK_BUDGET, performed: readbacksPerformed };
    }
    return { ...plan.readback, performed: readbacksPerformed };
  }

  /** Per-node cost rows, both halves (T256). Recomputed per flush, never per frame. */
  function costRows() {
    return nodeCostRows({
      passes: plan?.passes ?? [],
      sources: plan?.sources ?? [],
      gpuSpans: spans,
      cpuSpans,
      gpuAvailable: timingSource.timestampQuery,
      cpuAvailable: cpuSource.available,
      categories: plan?.categories ?? new Map<NodeId, string>(),
    });
  }

  function buildSnapshot(): TelemetrySnapshot {
    const budget = plan?.memoryBudgetBytes ?? null;
    const nodes = costRows();
    return {
      cpuTimingAvailable: cpuSource.available,
      nodes,
      categories: categoryRollups(nodes),
      timingAvailable: timingSource.timestampQuery,
      timingUnavailableReason: unavailableReason(),
      frameCompileReason,
      plan,
      build,
      framesRendered,
      heldTicks,
      lastFrameIndex,
      frame: frameBucket(),
      passes: passRows(),
      overBudget: budget !== null && plan !== null && plan.estimatedResourceBytes > budget,
      readback: readbackBudget(),
    };
  }

  return {
    setPlan(next) {
      if (next !== null) timeline.mark(perfNow(), "compile");
      if (samePlan(plan, next)) {
        // Compile marks still need the ordinary coalesced tick. Keep metadata identity
        // and measured timings when only values absent from this projection changed.
        if (next !== null) schedule();
        return;
      }
      plan = next;
      indexPlan(next);
      // Spans belong to pass ids that may no longer exist. Dropping stale ones is what
      // keeps a recompile from reporting the previous plan's cost against a new pass id.
      const live = new Set((next?.passes ?? []).map((pass) => pass.id));
      for (const passId of [...spans.keys()]) if (!live.has(passId)) spans.delete(passId);
      // T1604b: a new plan's runs are its own; what was shared is learnt again from its spans.
      sharedRuns.clear();
      // T1243: the extent belongs to a frame of the previous plan for the same reason.
      frameExtent = null;
      droppedFrames = 0;
      for (const passId of [...cpuSpans.keys()]) if (!live.has(passId)) cpuSpans.delete(passId);
      for (const nodeId of [...counters.keys()]) if (!activeNodes.has(nodeId)) counters.delete(nodeId);
      schedule();
    },

    setBuild(next) {
      build = next;
      schedule();
    },

    setReadbacksPerformed(count) {
      const next = count === null || !Number.isFinite(count) ? null : count;
      if (next === readbacksPerformed) return;
      readbacksPerformed = next;
      schedule();
    },

    setFrameCompileReason(reason) {
      if (reason === frameCompileReason) return;
      frameCompileReason = reason;
      schedule();
    },

    noteHeldTick() {
      heldTicks += 1;
      schedule();
    },

    attachCpuTimingSource(source) {
      detachCpu?.();
      cpuSource = source;
      cpuSpans.clear();
      const off = source.onCpuTimings((results: CpuSpanResults) => {
        for (const [passId, ms] of Object.entries(results)) {
          if (Number.isFinite(ms)) cpuSpans.set(passId, ms);
        }
        schedule();
      });
      detachCpu = () => {
        off();
        detachCpu = null;
        cpuSource = NO_CPU_TIMING;
        cpuSpans.clear();
        schedule();
      };
      schedule();
      return () => detachCpu?.();
    },

    attachTimingSource(source) {
      detachTiming?.();
      timingSource = source;
      spans.clear();
      frameExtent = null;
      droppedFrames = 0;
      // T1295: a lost frame is counted where the frame figure is read, so the figure can say
      // it is describing only the frames that got through.
      const offDropped =
        source.onTimingsDropped?.(() => {
          droppedFrames += 1;
          timeline.mark(perfNow(), "timing-lost");
          schedule();
        }) ?? null;
      const off = source.onPassTimings((results: PassSpanResults, frame?: FrameSpanExtent) => {
        // T1243: halves of one render (same submit) add up; a new submit replaces.
        if (frame !== undefined) {
          frameExtent =
            frameExtent !== null && frame.submit !== null && frame.submit === frameExtent.submit
              ? { submit: frame.submit, gpuMs: frameExtent.gpuMs + frame.gpuMs }
              : { submit: frame.submit, gpuMs: frame.gpuMs };
        }
        /*
         * T387: a substepped pass is encoded several times in one frame and reports one
         * span per iteration (`pass`, `pass~1`, `pass~2`, …) because vgpu allows one span
         * per name per frame. They are SUMMED onto the pass, which is what makes the cost
         * of raising Substeps visible where someone would look for it: the node's own
         * timing row. Keeping only the first would report a fifty-iteration loop as
         * costing one iteration — a node that reads cheap and is not.
         */
        const total = new Map<string, number>();
        /* T1604b: how many passes after it each span ALSO covers — 0 for a pass's own span.
           The name says so (`runSpanName`), so this follows what was encoded this frame. */
        const covers = new Map<string, number>();
        for (const [spanName, ms] of Object.entries(results)) {
          if (!Number.isFinite(ms)) continue;
          const passId = spanBasePassId(spanName);
          total.set(passId, (total.get(passId) ?? 0) + ms);
          covers.set(passId, Math.max(covers.get(passId) ?? 0, spanSharedPasses(spanName)));
        }
        for (const [passId, ms] of total) {
          spans.set(passId, ms);
          const count = covers.get(passId) ?? 0;
          if (count === 0) {
            sharedRuns.delete(passId);
            continue;
          }
          /* The run was one device pass this frame. Its other passes have no span of their
             own any more, and one left over from when they did (one pass per draw, a moment
             ago) would be added to the node's total on top of the run's. */
          sharedRuns.set(passId, count);
          for (const sharer of sharersOf(passId, count)) {
            if (!total.has(sharer)) spans.delete(sharer);
            sharedRuns.delete(sharer);
          }
        }
        if (frame !== undefined) timeline.noteGpu(perfNow(), frame.gpuMs, Object.fromEntries(total));
        schedule();
      });
      detachTiming = () => {
        off();
        offDropped?.();
        detachTiming = null;
        timingSource = NO_PASS_TIMING;
        spans.clear();
        sharedRuns.clear();
        frameExtent = null;
        droppedFrames = 0;
        schedule();
      };
      schedule();
      return () => detachTiming?.();
    },

    demandPassDetail() {
      detailDemands += 1;
      if (detailDemands === 1) applyDetail?.(true);
      let held = true;
      return () => {
        if (!held) return;
        held = false;
        detailDemands -= 1;
        if (detailDemands === 0) applyDetail?.(false);
      };
    },

    attachPassDetailSwitch(apply) {
      applyDetail = apply;
      // Whoever is already looking gets their figures from the backend that just arrived.
      apply(detailDemands > 0);
      return () => {
        if (applyDetail === apply) applyDetail = null;
      };
    },

    recentFrameTimes() {
      return [...frameTimes];
    },
    timeline(spanMs) {
      return timeline.window(perfNow(), spanMs);
    },
    noteFrame(frameIndex, ran) {
      framesRendered += 1;
      lastFrameIndex = frameIndex;
      {
        const at = perfNow();
        frameTimes.push(at);
        timeline.noteFrame(at);
        // Prune anything past double the verdict window; the array stays tiny.
        const cutoff = at - 3000;
        while (frameTimes.length > 0 && (frameTimes[0] ?? 0) < cutoff) frameTimes.shift();
      }
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
      detachCpu?.();
      if (timer !== null) clearTimeout(timer);
      timer = null;
      listeners.clear();
      spans.clear();
      frameExtent = null;
      cpuSpans.clear();
      counters.clear();
    },
  };
}
