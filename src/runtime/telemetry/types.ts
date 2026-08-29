import type { NodeId } from "../../domain/types/ids.ts";

/**
 * Telemetry contracts (T41, T42, §V16, §V85, §V86).
 *
 * Two rules shape every type in this file.
 *
 * §V86 — a timing number is either a GPU timer span or it is absent. There is no third
 * option. CPU encode duration measures how long it took to WRITE the commands, which on a
 * real workload differs from how long the GPU spent EXECUTING them by more than an order
 * of magnitude; reporting it as "gpu ms" would send someone optimising a pass that costs
 * nothing. Timestamp query is an optional device feature (§V12), so "unavailable" is a
 * first-class state that the UI must be able to render, not an error and not a zero.
 *
 * §V16 — nothing here is document state. The hub is a side channel the compiler, the
 * backend and the frame driver push into, and the UI samples at <= 10 Hz. No telemetry
 * value is ever written through the command bus or stored on a `GraphNode`.
 */

/** vgpu's `Timer.onResults` payload: span name -> milliseconds. Span name = pass id. */
export type PassSpanResults = Readonly<Record<string, number>>;

/**
 * The backend's GPU timing surface, as telemetry needs it.
 *
 * Declared here rather than imported because §V3 keeps `timer(gpu)` inside
 * `src/runtime/backend/vgpu/`. The backend owns creating the timer, attaching a span per
 * encoded pass and forwarding `onResults`; this interface is the shape that has to come
 * back out. `timestampQuery: false` means the device has no such feature and the source
 * will never emit — which is exactly the "unavailable" reading, not "0 ms".
 */
export interface PassTimingSource {
  readonly timestampQuery: boolean;
  onPassTimings(listener: (spans: PassSpanResults) => void): () => void;
}

/** A device with no timestamp-query support. Emits nothing, ever (§V86). */
export const NO_PASS_TIMING: PassTimingSource = Object.freeze({
  timestampQuery: false,
  onPassTimings: () => () => {},
});

/**
 * Whether a timing figure exists, and why not when it does not.
 *
 * `unavailable` — the device reports no `timestampQuery` (§V12). The field reads
 *   "unavailable" forever; no amount of waiting will produce a number.
 * `pending`     — timing is supported but no span for this subject has landed yet
 *   (spans arrive one or two frames after submit, and nothing has been submitted).
 * `measured`    — `gpuMs` is a real GPU duration.
 */
export type TimingAvailability = "unavailable" | "pending" | "measured";

/** One measured (or unmeasured) cost. `gpuMs` is non-null only when `measured`. */
export interface TimingBucket {
  readonly availability: TimingAvailability;
  readonly gpuMs: number | null;
  readonly passCount: number;
  readonly nodeCount: number;
}

export function emptyBucket(availability: TimingAvailability): TimingBucket {
  return {
    availability,
    gpuMs: availability === "measured" ? 0 : null,
    passCount: 0,
    nodeCount: 0,
  };
}

/**
 * Where a flattened node came from (§V82).
 *
 * Structurally the compiler's `ComponentSource`, restated here so `src/runtime/telemetry`
 * does not depend on `src/compiler`. `CompiledGraph.sources` is assignable to this.
 */
export interface TelemetrySourcePath {
  readonly nodeId: NodeId;
  /** Enclosing instance chain as flattened ids, outermost first. Empty at the root. */
  readonly path: ReadonlyArray<NodeId>;
  /** `Main / DreamyFeedback_2 / Blur_1` — what a timing row shows. */
  readonly sourcePath: string;
}

/** One pass, as telemetry sees it. */
export interface TelemetryPass {
  readonly id: string;
  readonly kind: string;
  readonly nodeId: NodeId | null;
  readonly label: string | null;
}

/** Static facts about the plan currently running. Set at compile, never per frame. */
export interface TelemetryPlan {
  readonly passes: ReadonlyArray<TelemetryPass>;
  readonly sources: ReadonlyArray<TelemetrySourcePath>;
  readonly resourceCount: number;
  readonly estimatedResourceBytes: number;
  /** `settings.limits.memoryBudgetBytes`, or null when no budget is in force (§V24). */
  readonly memoryBudgetBytes: number | null;
  /** Nodes the plan kept, and nodes it pruned (§V25). */
  readonly nodeCount: number;
  readonly prunedCount: number;
}

/** Reuse accounting from the last structural build (T143). Mirrors `BackendStatus.lastBuild`. */
export interface TelemetryBuildStats {
  readonly resourcesCreated: number;
  readonly resourcesReused: number;
  readonly effectsBuilt: number;
  readonly effectsReused: number;
}

/** One row of the performance tab's per-pass table. */
export interface PassTimingRow {
  readonly passId: string;
  readonly kind: string;
  readonly nodeId: NodeId | null;
  /** Source path when the node came out of a component, else null (§V82). */
  readonly sourcePath: string | null;
  readonly label: string | null;
  readonly availability: TimingAvailability;
  readonly gpuMs: number | null;
}

/** Everything the performance tab shows, sampled at <= 10 Hz (§V16). */
export interface TelemetrySnapshot {
  /** False when the device has no timestamp query. Every gpuMs is then null (§V86). */
  readonly timingAvailable: boolean;
  readonly plan: TelemetryPlan | null;
  readonly build: TelemetryBuildStats | null;
  /** Frames the driver actually rendered since the hub was created. */
  readonly framesRendered: number;
  readonly lastFrameIndex: number | null;
  /** Sum of the most recent span for every pass. Null unless at least one was measured. */
  readonly frame: TimingBucket;
  readonly passes: ReadonlyArray<PassTimingRow>;
  /** True when `estimatedResourceBytes` exceeds the project budget (§V24). */
  readonly overBudget: boolean;
}

/** Per-node telemetry, the numbers TD's Info CHOP would show (§I node info). */
export interface NodeTelemetry {
  readonly nodeId: NodeId;
  /** Own passes only — a component instance aggregates separately (§V87). */
  readonly own: TimingBucket;
  /** Frames in which this node had at least one pass in the running plan. */
  readonly framesRendered: number;
  /** Was it in the most recently rendered frame? TD's `cooked_this_frame`. */
  readonly renderedThisFrame: boolean;
  /** `frameIndex` of the last frame it rendered in, or null. TD's `cook_frame`. */
  readonly lastRenderedFrame: number | null;
  readonly sourcePath: string | null;
}

export function emptyNodeTelemetry(nodeId: NodeId, availability: TimingAvailability): NodeTelemetry {
  return {
    nodeId,
    own: emptyBucket(availability === "measured" ? "pending" : availability),
    framesRendered: 0,
    renderedThisFrame: false,
    lastRenderedFrame: null,
    sourcePath: null,
  };
}

/**
 * Read side of the hub. This is all the UI is ever given (§V85).
 *
 * Every method is a pure read over state the hub already holds — there is no `record`,
 * no `measure` and no way to make the UI a producer of telemetry.
 */
export interface TelemetrySource {
  snapshot(): TelemetrySnapshot;
  nodeTelemetry(nodeId: NodeId): NodeTelemetry;
  /** Own passes only. `children` is empty and `total === own` (see `./aggregate.ts`). */
  nodeTiming(nodeId: NodeId): ComponentTimingView;
  /** own / children / total over the instance's flattened source paths (§V87). */
  componentTiming(instanceId: NodeId): ComponentTimingView;
  /** Notified at most once per metric tick (§V16). */
  subscribe(listener: () => void): () => void;
}

/**
 * The own/children/total split, restated structurally so `TelemetrySource` does not have
 * to import from `./aggregate.ts` (which imports this file). `ComponentTiming` there is
 * this exact shape.
 */
export interface ComponentTimingView {
  readonly own: TimingBucket;
  readonly children: TimingBucket;
  readonly total: TimingBucket;
}
