/**
 * Runtime telemetry (§P track L — T41, T42, T146).
 *
 * What other tracks need from here:
 *  - `createTelemetryHub({ sink })` in the composition root, handed the graph canvas's
 *    `NodeRuntimeStore` as its sink. One hub per app.
 *  - `hub.setPlan(telemetryPlan(compiled, { memoryBudgetBytes }))` after each compile.
 *  - `hub.attachTimingSource(source)` with the backend's GPU timer surface (§V86).
 *  - `hub.noteFrame(frame.frameIndex)` from `FrameDriver.onFrame`.
 *  - `hub.setBuild(backend.status.lastBuild ?? null)` after a structural build.
 *
 * Nothing here imports React, touches the DOM, or writes to the document store (§V16).
 */

export { NO_CPU_TIMING, NO_PASS_TIMING, emptyBucket, emptyNodeTelemetry } from "./types.ts";
export type {
  CpuSpanResults,
  CpuTimingSource,
  NodeTelemetry,
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

export { aggregateComponentTiming, aggregateNodeTiming } from "./aggregate.ts";
export type { AggregateInput, ComponentTiming } from "./aggregate.ts";

export { TELEMETRY_TICK_MS, createTelemetryHub, telemetryPlan } from "./hub.ts";
export type {
  NodeMetricSink,
  PlanLike,
  TelemetryHub,
  TelemetryHubOptions,
  TelemetryPlanOptions,
} from "./hub.ts";

export {
  UNAVAILABLE_COST,
  UNCATEGORISED,
  categoryRollups,
  costBucket,
  nodeCategories,
  nodeCostRows,
} from "./cost.ts";
export type { CategoryRollup, CostBucket, CostInput, NodeCostRow } from "./cost.ts";

export { EMPTY_READBACK_BUDGET, analyzeReadbacks, readbackPlanBudget } from "./readback.ts";
export type {
  DeclaredReadback,
  ReadbackBudget,
  ReadbackBudgetInput,
  ReadbackPlanBudget,
  ReadbackRow,
  SizedResource,
} from "./readback.ts";
