import type { CompiledGraph, ResolvedOutput } from "@compiler/index.ts";
import type { ColorSpace } from "@compiler/color-space.ts";
import type { GraphDocument, GraphNode, NodeResolutionOverride, NodeFormatOverride } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { FormatPolicy, ResolutionPolicy, TextureFormat } from "@domain/types/node-definition.ts";
import { isComponentNodeType, parseComponentNodeType } from "@domain/components/index.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { estimateResourceBytes } from "@runtime/backend/plan.ts";
import type { ResourceDescriptor } from "@runtime/backend/plan.ts";
import { aggregateComponentTiming } from "@runtime/telemetry/index.ts";
import type { ComponentTiming, NodeTelemetry, TelemetrySource } from "@runtime/telemetry/index.ts";
import { emptyBucket, emptyNodeTelemetry } from "@runtime/telemetry/index.ts";
import type { AgentActivity, NodeRunStatus, NodeRuntimeSnapshot } from "@editor/graph-canvas/index.ts";
import { IDLE_RUNTIME } from "@editor/graph-canvas/index.ts";

/**
 * The node info model — TouchDesigner's middle-click popup, as data (T145, §I.info, §V85).
 *
 * TD splits these numbers across two places: the MMB popup (cook time, "is it cooking
 * every frame") and the Info CHOP / TOP class (resolution, format, GPU memory, counters).
 * Asking a user to know which surface holds which fact is the part worth not copying, so
 * this is one model feeding one surface.
 *
 * ## §V85 — nothing here collects anything
 *
 * Every field is read out of state that already exists for another reason: the compiled
 * plan, the telemetry hub's spans and counters, and the graph canvas's per-node runtime
 * channel. There is no new subscription, no readback (§V7), no bus call and no document
 * write. `buildNodeInfo` is a pure function of a snapshot, which is also what makes the
 * popup renderable from a fixture with no GPU anywhere in sight.
 *
 * ## Beyond TD
 *
 * Three fields TD does not have, each because we hit the confusion they prevent:
 * colour space (§V56/§V57 — "why does this look washed out" is a space question),
 * the resolution/format SOURCE (an override and an inherited policy produce the same
 * number and want opposite fixes), and `stale` (§V9 — the picture on screen is from the
 * last plan that compiled, not from the graph as it currently reads).
 */

/** Which of the three precedence levels decided a resolved value (§V50, §V51). */
export type DecisionSource = "override" | "policy" | "default";

export interface Decision {
  readonly source: DecisionSource;
  /** Short human account: "override · 1/2 of input", "policy · inherit", "default". */
  readonly detail: string;
}

export interface NodeOutputInfo {
  readonly portId: string;
  readonly resourceId: string;
  readonly temporal: boolean;
  readonly resolution: readonly [number, number];
  /** width / height, or null for a degenerate size. */
  readonly aspect: number | null;
  readonly format: TextureFormat;
  readonly space: ColorSpace;
  readonly estimatedBytes: number;
}

export interface NodeInfo {
  readonly nodeId: NodeId;
  /** What the node is called on the canvas. */
  readonly label: string;
  readonly type: string;
  /** The definition's title, or the raw type for an unresolved placeholder (§V10). */
  readonly typeTitle: string;
  /** True for a component instance: the timing split below is then the point (§V87). */
  readonly isComponent: boolean;
  readonly componentId: string | null;
  readonly componentVersion: number | null;
  /** `Main / DreamyFeedback_2 / Blur_1` when the node came out of a component (§V82). */
  readonly sourcePath: string | null;

  /** Primary output — TD's TOP class fields describe this one. Null when nothing is materialized. */
  readonly output: NodeOutputInfo | null;
  /** Every materialized output, for a node that emits more than one. */
  readonly outputs: ReadonlyArray<NodeOutputInfo>;
  readonly resolutionDecision: Decision;
  readonly formatDecision: Decision;
  /** Sum over this node's materialized outputs (§V24 reporting). */
  readonly estimatedBytes: number;

  /** own / children / total (§V87). For a plain node, children is empty and total == own. */
  readonly timing: ComponentTiming;
  readonly framesRendered: number;
  readonly renderedThisFrame: boolean;
  readonly lastRenderedFrame: number | null;

  readonly status: NodeRunStatus;
  readonly message: string | null;
  readonly errorCount: number;
  readonly warningCount: number;
  /** §V9 — what is on screen came from the last plan that compiled, not from this graph. */
  readonly stale: boolean;
  readonly bypassed: boolean;
  readonly muted: boolean;
  /** §V25 — no active sink reaches this node, so it does no work at all. */
  readonly pruned: boolean;
  readonly agent: AgentActivity | null;
  /** False when no device timestamp query exists: every gpuMs above reads null (§V86). */
  readonly timingAvailable: boolean;
}

export interface NodeInfoRequest {
  readonly nodeId: NodeId;
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  /** The plan currently running, or null before the first successful compile. */
  readonly compiled: CompiledGraph | null;
  /** Per-node runtime channel snapshot (status, diagnostics counts, agent, stale). */
  readonly runtime?: NodeRuntimeSnapshot | undefined;
  /** The telemetry hub's read side. Null renders every timing field as unavailable. */
  readonly telemetry?: TelemetrySource | null | undefined;
}

const HUMAN_FORMAT: Readonly<Record<TextureFormat, string>> = {
  rgba8unorm: "8-bit RGBA",
  "rgba8unorm-srgb": "8-bit RGBA, sRGB-encoded",
  rgba16float: "16-bit float RGBA",
  r32float: "32-bit float, single channel",
  depth24plus: "24-bit depth",
};

export function formatLabel(format: TextureFormat): string {
  return HUMAN_FORMAT[format];
}

const HUMAN_SPACE: Readonly<Record<ColorSpace, string>> = {
  linear: "linear (working space)",
  encoded: "encoded (display-referred)",
  data: "data (no colour conversion)",
};

export function spaceLabel(space: ColorSpace): string {
  return HUMAN_SPACE[space];
}

/**
 * Which level decided the resolution.
 *
 * This MIRRORS the precedence in `src/compiler/resolution.ts`: an override that is not
 * `auto` wins, else the definition's policy, else inherit-the-input. It is three lines
 * because that is genuinely all the precedence is — but it is still a mirror, and
 * `ResolvedOutput` carrying the compiler's own `ResolutionOutcome.source` would remove
 * the possibility of the two drifting. That is a request on the compiler track, recorded
 * here rather than papered over.
 */
export function resolutionDecision(
  override: NodeResolutionOverride | undefined,
  policy: ResolutionPolicy | undefined,
): Decision {
  if (override !== undefined && override.mode !== "auto") {
    return { source: "override", detail: `override · ${describeResolutionOverride(override)}` };
  }
  if (policy !== undefined) return { source: "policy", detail: `node policy · ${policy.kind}` };
  return { source: "default", detail: "default · follows the primary input" };
}

function describeResolutionOverride(override: NodeResolutionOverride): string {
  switch (override.mode) {
    case "auto":
      return "auto";
    case "project":
      return "project resolution";
    case "input":
      return `input${override.input === undefined ? "" : ` "${override.input}"`}`;
    case "scale":
      return `${override.factor}x input`;
    case "fixed":
      return `fixed ${override.width}x${override.height}`;
    case "fit":
      return `fit ${override.width}x${override.height}`;
    case "limit":
      return `limit ${override.width}x${override.height}`;
  }
}

/** Same precedence, for the pixel format (§V51). */
export function formatDecision(
  override: NodeFormatOverride | undefined,
  policy: FormatPolicy | undefined,
): Decision {
  if (override !== undefined && override.mode !== "auto") {
    return { source: "override", detail: `override · ${describeFormatOverride(override)}` };
  }
  if (policy !== undefined) return { source: "policy", detail: `node policy · ${policy.kind}` };
  return { source: "default", detail: "default · follows the primary input" };
}

function describeFormatOverride(override: NodeFormatOverride): string {
  switch (override.mode) {
    case "auto":
      return "auto";
    case "project":
      return "project format";
    case "input":
      return `input${override.input === undefined ? "" : ` "${override.input}"`}`;
    case "fixed":
      return override.format;
  }
}

function aspectOf(size: readonly [number, number]): number | null {
  const [width, height] = size;
  return height > 0 && width > 0 ? width / height : null;
}

/** Bytes for one output, taken from the plan's own resource descriptor when there is one. */
function bytesForOutput(
  output: ResolvedOutput,
  resources: ReadonlyArray<ResourceDescriptor>,
): number {
  const descriptor = resources.find((resource) => resource.id === output.resourceId);
  if (descriptor !== undefined) return estimateResourceBytes([descriptor]);
  // A pointset marker owns no texture; its memory is the producer's buffer pairs,
  // which the resource list above already accounts for (T121/T176).
  if (output.resourceKind === "pointset") return 0;
  // No descriptor: estimate from what the compiler resolved, so a node still reports a
  // size rather than a blank. Same function the plan and the backend use (§V24).
  return estimateResourceBytes([
    {
      kind: output.resourceKind,
      id: output.resourceId,
      size: output.size,
      format: output.format,
    },
  ]);
}

function describeOutput(
  output: ResolvedOutput,
  resources: ReadonlyArray<ResourceDescriptor>,
): NodeOutputInfo {
  return {
    portId: output.portId,
    resourceId: output.resourceId,
    temporal: output.temporal,
    resolution: output.size,
    aspect: aspectOf(output.size),
    format: output.format,
    space: output.space,
    estimatedBytes: bytesForOutput(output, resources),
  };
}

function unavailableTiming(): ComponentTiming {
  const bucket = emptyBucket("unavailable");
  return { own: bucket, children: bucket, total: bucket };
}

/** Nodes the plan kept, for §V25-correct counting inside a component. */
function keptNodeSet(compiled: CompiledGraph | null): ReadonlySet<NodeId> | undefined {
  return compiled === null ? undefined : new Set(compiled.order);
}

/**
 * Builds the popup's model. Pure: hand it a fixture and it renders without a GPU.
 */
export function buildNodeInfo(request: NodeInfoRequest): NodeInfo {
  const { nodeId, graph, registry, compiled } = request;
  const node: GraphNode | undefined = graph.nodes[nodeId];
  const runtime = request.runtime ?? IDLE_RUNTIME;
  const telemetry = request.telemetry ?? null;

  const definition = node === undefined ? undefined : registry.get(node.type);
  const type = node?.type ?? nodeId;
  const component = isComponentNodeType(type) ? parseComponentNodeType(type) : null;

  const snapshot = telemetry?.snapshot() ?? null;
  const timingAvailable = snapshot?.timingAvailable ?? false;

  const nodeTelemetry: NodeTelemetry =
    telemetry?.nodeTelemetry(nodeId) ??
    emptyNodeTelemetry(nodeId, timingAvailable ? "pending" : "unavailable");

  const timing = computeTiming({
    nodeId,
    isComponent: component !== null,
    compiled,
    telemetry,
    timingAvailable,
  });

  const outputs = (compiled?.outputs ?? [])
    .filter((output) => output.nodeId === nodeId)
    .map((output) => describeOutput(output, compiled?.resources ?? []));

  const sourcePath =
    nodeTelemetry.sourcePath ??
    compiled?.sources.find((source) => source.nodeId === nodeId)?.sourcePath ??
    null;

  return {
    nodeId,
    label: node?.label ?? definition?.title ?? type,
    type,
    typeTitle: definition?.title ?? type,
    isComponent: component !== null,
    componentId: component?.componentId ?? null,
    componentVersion: component?.version ?? null,
    sourcePath,

    output: outputs[0] ?? null,
    outputs,
    resolutionDecision: resolutionDecision(node?.resolution, definition?.resolutionPolicy),
    formatDecision: formatDecision(node?.format, definition?.formatPolicy),
    estimatedBytes: outputs.reduce((total, output) => total + output.estimatedBytes, 0),

    timing,
    framesRendered: nodeTelemetry.framesRendered,
    renderedThisFrame: nodeTelemetry.renderedThisFrame,
    lastRenderedFrame: nodeTelemetry.lastRenderedFrame,

    status: runtime.status,
    message: runtime.message,
    errorCount: runtime.errorCount,
    warningCount: runtime.warningCount,
    stale: runtime.stale,
    bypassed: node?.ui?.bypassed === true,
    muted: node?.ui?.muted === true,
    pruned: compiled !== null && compiled.pruned.includes(nodeId),
    agent: runtime.agent,
    timingAvailable,
  };
}

function computeTiming(args: {
  nodeId: NodeId;
  isComponent: boolean;
  compiled: CompiledGraph | null;
  telemetry: TelemetrySource | null;
  timingAvailable: boolean;
}): ComponentTiming {
  const { nodeId, isComponent, compiled, telemetry, timingAvailable } = args;
  if (telemetry === null) return unavailableTiming();

  // The hub already holds the plan and the spans, so the aggregate is a read, not a
  // recomputation from scratch (§V85). It is asked for the component split only when the
  // subject IS a component — a plain node's "children" is meaningless, not zero-by-luck.
  if (!isComponent) return telemetry.nodeTiming(nodeId);

  // A component instance is flattened away, so its passes are found by source path. The
  // hub can answer this directly; the fallback covers a caller holding only a plan.
  const viaHub = telemetry.componentTiming(nodeId);
  if (viaHub.total.passCount > 0 || compiled === null) return viaHub;

  return aggregateComponentTiming(nodeId, {
    passes: compiled.passes.map((pass) => ({
      id: pass.id,
      kind: pass.kind,
      nodeId: "nodeId" in pass && pass.nodeId !== undefined ? pass.nodeId : null,
      label: "label" in pass && pass.label !== undefined ? pass.label : null,
    })),
    sources: compiled.sources,
    spans: new Map(),
    timingAvailable,
    keptNodes: keptNodeSet(compiled),
  });
}
