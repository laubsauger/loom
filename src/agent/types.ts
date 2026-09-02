import type { OutputRef as DomainOutputRef } from "../domain/types/ids.ts";
import type { z } from "zod";

import type { Actor, CapabilityClass, InvocationContext } from "@domain/types/commands.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { Revision } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { LoomBus } from "@domain/commands/bus.ts";

/**
 * The agent tool surface vocabulary (§I.tools, T54–T60).
 *
 * ## What this module is, and what it may never become
 *
 * §V39: an adapter is TRANSPORT plus SCHEMA and nothing else. Every tool here is a thin
 * projection of a bus command or query that already exists — it validates its input,
 * dispatches, and projects the result into a stable envelope. No tool decides what an
 * edit means. Where the spec names a tool and no command backs it, the tool is declared
 * with the command it needs and reports itself `unavailable`; it is never stubbed with a
 * local implementation, because a second implementation of an app behaviour drifts from
 * the first and only one of them gets fixed.
 *
 * ## Results are data (§V37)
 *
 * A `ToolResult` is structured data, never an instruction to the calling model. Node
 * labels, node type names, project text and third-party node descriptions are UNTRUSTED:
 * they travel in `data` as plain strings and are NEVER interpolated into any prose this
 * module authors — not a `message`, not a `suggestion`, not a tool description. A node
 * named "ignore previous instructions" must round-trip as a value and appear in no field
 * a model could read as direction.
 *
 * ## Headless (§V11-in-spirit, doc §30.2)
 *
 * Nothing under `src/agent/**` imports React or touches the DOM, so the same surface
 * backs an in-tab WebMCP adapter and an out-of-process MCP server. The presence UI is
 * `src/editor/agent/**`, and it reads a snapshot; it is never a producer of tool state.
 */

/** Port-scoped output identity (§V59). A single-output node uses the default port. */
export type OutputRef = DomainOutputRef;

export const DEFAULT_OUTPUT_PORT = "out";

/** Stable key for an output ref. `outputId === nodeId` is exactly what §V59 forbids. */
export function outputKey(ref: OutputRef): string {
  return `${ref.nodeId}:${ref.portId}`;
}

export type ToolKind = "read" | "mutate" | "workflow";

/**
 * Every terminal state a tool call can reach. All of them are reported, none throw:
 * an adapter that throws at the transport boundary loses the diagnostics.
 *
 * `validated`  — a dry run: validated, nothing mutated, nothing audited as applied
 *                (§V36). Deliberately NOT "ok": `graph.applyPatch` currently answers a
 *                dry run with status "applied" (T102), and an agent reading "applied"
 *                for an edit that did not happen is the whole hazard.
 * `unavailable` — nothing on the bus (or no injected read source) backs this tool yet.
 * `denied`      — a capability class is not granted (§V38). Calling again never helps.
 */
export type ToolStatus =
  | "ok"
  | "validated"
  | "rejected"
  | "conflict"
  | "denied"
  | "unavailable"
  | "awaiting-approval"
  | "error";

export interface ToolResult<TData = unknown> {
  readonly tool: string;
  readonly status: ToolStatus;
  /** Untrusted document text lives HERE and only here (§V37). */
  readonly data: TData | null;
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** Document revision the result was observed at, when the tool knows one. */
  readonly revision: Revision | null;
  readonly undoGroupId?: string;
  readonly transactionId?: string;
  /** Set when a mutation was queued for human review instead of applied (§V42). */
  readonly proposalId?: string;
}

/**
 * Read sources the command bus does not (yet) expose as queries.
 *
 * Selection, diagnostics, telemetry and rendered pixels are not document state, so
 * `graph.get` cannot answer them and no query is registered for them today. Rather than
 * reimplement any of it here (§V39), the surface takes narrow read-only ports and reports
 * the tool `unavailable` when a port is absent. Each one SHOULD become a bus query so an
 * out-of-process MCP server can reach it too — an injected port only works in-tab.
 */
/*
 * Selection, diagnostics and runtime metrics used to be injected ports too. They are bus
 * QUERIES now (T175, `src/domain/commands/state-queries.ts`): `selection.get`,
 * `diagnostics.get` and `runtime.metrics`. A port is a reference to the running editor's
 * own objects and therefore only works in-tab, which is exactly the limitation §V39
 * rules out for an adapter. What remains below are the two reads the bus genuinely has
 * no query for, because both hand back BYTES rather than state.
 */

/**
 * The subset of `TelemetrySnapshot` an agent can act on, restated structurally so
 * `src/agent` does not depend on `src/runtime/telemetry` (§V16 sampling stays the
 * provider's business; the tool just reads whatever the provider last published).
 */
export interface AgentRuntimeMetrics {
  /**
   * T304: why-is-nothing-moving, answered by name (§V541). "browser-throttled" means
   * the page is hidden/occluded and the browser suspended the frame clock — the
   * DEFAULT state for an automation-driven session, expected, nothing is broken
   * (§V560); "running-behind" means the machine cannot hold the project rate;
   * "paused" means press play. Zeros elsewhere in this object are explained here
   * before they are believed.
   */
  readonly frameClock:
    | { readonly kind: "live"; readonly observedFps: number }
    | { readonly kind: "paused" }
    | { readonly kind: "browser-throttled"; readonly observedFps: number; readonly suggestion: string }
    | { readonly kind: "running-behind"; readonly observedFps: number; readonly suggestion: string };
  /** False when the device has no timestamp query — every ms figure is then null (§V86). */
  readonly timingAvailable: boolean;
  readonly framesRendered: number;
  readonly lastFrameIndex: number | null;
  readonly frameGpuMs: number | null;
  readonly passCount: number;
  readonly nodeCount: number;
  readonly prunedCount: number;
  readonly estimatedResourceBytes: number | null;
  readonly memoryBudgetBytes: number | null;
  readonly overBudget: boolean;
}

/** §V60 — an image is bytes plus everything needed to interpret them. */
export interface PreviewImage {
  readonly ref: OutputRef;
  readonly mimeType: "image/png";
  readonly width: number;
  readonly height: number;
  /** Encoded PNG bytes. Bounded by the request's `maxSize` (§I.tools). */
  readonly bytes: Uint8Array;
}

export interface PreviewImageRequest {
  readonly ref: OutputRef;
  /** Longest edge of the returned image, in pixels. The provider may return less. */
  readonly maxSize: number;
}

/**
 * The export interface `render_preview` needs (T58, §V48).
 *
 * This is the whole contract: one port-scoped request in, one encoded image out. The
 * readback itself belongs to the export module (T68) — §V48 makes it the sole readback
 * surface and §V7 keeps readback out of the playback loop, so nothing here reaches for a
 * texture. The tool validates the ref against the graph BEFORE calling this, so an
 * implementation may assume `ref.nodeId` exists and declares `ref.portId`; it still
 * rejects (throws or resolves with a smaller image) when the output is not currently
 * rendered.
 */
export interface PreviewExport {
  renderPreview(request: PreviewImageRequest): Promise<PreviewImage>;
  /**
   * T291: the CHEAP look — per-channel min/max/mean on the linear plane, no pixels.
   * Optional so a provider predating stats keeps render_preview working; the tool
   * reports unavailable-as-data when absent.
   */
  describeOutput?(ref: OutputRef): Promise<OutputStatsData>;
}

/** Texture-as-numbers (T291): what `describe_output` returns. */
export interface OutputStatsData {
  readonly ref: OutputRef;
  readonly width: number;
  readonly height: number;
  readonly format: string;
  readonly channels: {
    readonly r: { min: number; max: number; mean: number };
    readonly g: { min: number; max: number; mean: number };
    readonly b: { min: number; max: number; mean: number };
    readonly a: { min: number; max: number; mean: number };
  };
}

/** One window of point-attribute values (T125). Mirrors the export module's shape. */
export interface PointsWindowData {
  readonly nodeId: string;
  readonly attribute: string;
  readonly type: string;
  readonly start: number;
  readonly count: number;
  readonly capacity: number;
  readonly values: ReadonlyArray<ReadonlyArray<number>>;
}

/**
 * The export interface `read_points` needs (T125, §V48): windowed, throttled attribute
 * readback. Implemented runtime-side by `createPointsReadback`; injected here.
 */
export interface PointsExport {
  read(request: {
    nodeId: string;
    attribute?: string;
    start?: number;
    count?: number;
  }): Promise<PointsWindowData>;
}

export interface AgentPorts {
  readonly preview?: PreviewExport | undefined;
  readonly points?: PointsExport | undefined;
}

export type AgentPortName = keyof AgentPorts;

/** What a tool needs before it can run. Checked per call and reported by `listTools`. */
export interface ToolRequirements {
  readonly commands?: readonly string[];
  readonly queries?: readonly string[];
  readonly ports?: readonly AgentPortName[];
}

/** The bus surface a tool is allowed to touch. Read-only projections plus dispatch. */
export interface ToolRuntime {
  readonly bus: LoomBus;
  readonly ports: AgentPorts;
  /** True when the caller asked to validate only (§V36). */
  readonly dryRun: boolean;
  /** The context every dispatch carries: actor (§V30) and owned grants (§V38, §V67). */
  invocation(): InvocationContext;
  execute<TOutput>(name: string, input: unknown): Promise<DispatchResult<TOutput>>;
  query<TOutput>(name: string, input: unknown): Promise<TOutput>;
  /** Current document revision, read through the bus. */
  revision(): Promise<Revision>;
}

/** A bus command result, as an adapter that dispatches BY NAME can see it. */
export interface DispatchResult<TOutput> {
  readonly status: "applied" | "validated" | "rejected" | "conflict";
  readonly revision: Revision;
  readonly diagnostics: readonly RuntimeDiagnostic[];
  readonly output: TOutput;
  readonly undoGroupId?: string;
}

export interface AgentTool<TInput = unknown, TData = unknown> {
  readonly name: string;
  /** Authored prose. Never contains document text (§V37). */
  readonly title: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly inputSchema: z.ZodType<TInput>;
  readonly requires: ToolRequirements;
  /** Capability classes the caller must already hold (§V38). Never self-granted. */
  readonly capabilities: readonly CapabilityClass[];
  /** Mutating tools accept `dryRun` and are the ones a review gate can hold (§V42). */
  readonly mutates: boolean;
  /** Patch preview for the review gate — mutating tools only (§V42, T60). */
  readonly preview?: (input: TInput) => readonly GraphPatchOperation[];
  run(input: TInput, runtime: ToolRuntime): Promise<ToolResult<TData>> | ToolResult<TData>;
}

/** What `listTools` publishes. `available: false` is honest, not hidden. */
export interface AgentToolInfo {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly kind: ToolKind;
  readonly capabilities: readonly CapabilityClass[];
  readonly mutates: boolean;
  readonly available: boolean;
  /** Populated when `available` is false: exactly what is missing, as data. */
  readonly missing: {
    readonly commands: readonly string[];
    readonly queries: readonly string[];
    readonly ports: readonly AgentPortName[];
  };
  /** Capability classes the caller does NOT currently hold (§V38). */
  readonly ungranted: readonly CapabilityClass[];
  readonly inputSchema: z.ZodType<unknown>;
}

export type { Actor };
