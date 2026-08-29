import type { ReadbackImage, ReadbackRegion } from "../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { NodeId, PortId } from "../../domain/types/ids.ts";
import type { TextureFormat } from "../../domain/types/node-definition.ts";

/**
 * Vocabulary of the export interface (T68, §V48).
 *
 * §V48 makes this module the ONE place readback happens. Everything else in the system is
 * GPU-to-GPU by construction (§V7) — previews, the viewer's tiles, the frame loop — because
 * a map-and-copy stalls the pipeline. Confining readback here is what makes that rule
 * auditable: there is a single surface to review, a single set of refusal rules, and a
 * single place where "we read pixels back while playing" can be counted.
 *
 * Nothing in this directory touches the DOM (§V63 / T92 lint) and nothing imports vgpu
 * (§V3). The GPU work arrives through the injected `ReadbackSource`; the browser-only
 * pieces (a download, a `VideoEncoder`) are injected or live in modules this one never
 * imports, so the whole interface is usable headless.
 */

export type { ReadbackImage, ReadbackRegion };

/**
 * Port-scoped output identity (§V59).
 *
 * `outputId === nodeId` is forbidden: one node can materialise several outputs, and an API
 * that bakes in the node-scoped assumption has to be rewritten rather than extended when it
 * does. T80 lifts this into `src/domain/types` as the shared `OutputRef`; the shape here is
 * structurally identical to the preview track's `PreviewOutputRef` so the merge is an import
 * change, not a rewrite.
 */
export interface OutputRef {
  readonly nodeId: NodeId;
  readonly portId: PortId;
}

/** A single-output node uses this port (§V59). */
export const DEFAULT_OUTPUT_PORT = "out";

export function outputRef(nodeId: NodeId, portId: PortId = DEFAULT_OUTPUT_PORT): OutputRef {
  return { nodeId, portId };
}

/** Stable string key for a ref. Map keys and deterministic ordering only — never an identity. */
export function outputRefKey(ref: OutputRef): string {
  return `${ref.nodeId}:${ref.portId}`;
}

export function sameOutputRef(a: OutputRef, b: OutputRef): boolean {
  return a.nodeId === b.nodeId && a.portId === b.portId;
}

/**
 * One readable output, as the export interface sees it.
 *
 * Carries both the port-scoped identity (§V59) and the backend's resource id, because the
 * backend still addresses targets by string id. Resolving one to the other is this module's
 * job, not the caller's — a caller that had to know the resource id would be back to
 * `outputId === nodeId` by another name.
 */
export interface ExportOutput {
  readonly ref: OutputRef;
  /** Id of the backing resource in the compiled plan; what `readOutput` takes today. */
  readonly resourceId: string;
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormat;
  readonly label?: string;
}

/**
 * Structural view of the compiler's `ResolvedOutput`.
 *
 * Declared rather than imported: `src/compiler/**` owns that type and the export module has
 * no business depending on the compiler's module graph. Structural typing means the real
 * `ResolvedOutput` satisfies this without either side importing the other.
 */
export interface ResolvedOutputLike {
  readonly nodeId: NodeId;
  readonly portId: PortId;
  readonly resourceId: string;
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
}

/**
 * Why pixels are being read.
 *
 * §V7 permits readback "for export, inspect or test only", and the reason decides the rules:
 * an inspect read must be a small window and may happen while the graph plays (that is the
 * viewer's cursor readout); a full-frame export read is refused during playback unless the
 * caller says otherwise, because it stalls the very loop it is sampling.
 */
export type ReadbackReason = "export" | "inspect" | "test" | "recording";

export interface ReadOptions {
  /** Omitted reads the whole output. */
  readonly region?: ReadbackRegion;
  readonly reason?: ReadbackReason;
  /** §V7. Defaults to "refuse" for full-frame reads while the frame loop is running. */
  readonly whilePlaying?: "refuse" | "allow";
}

/**
 * The GPU side of readback, injected.
 *
 * One method. The export interface resolves the ref, clamps the region, validates the
 * returned descriptor and applies the §V7 rules; the source only copies pixels. Keeping it
 * this narrow is what lets the whole interface be tested with no GPU at all, and what lets
 * the backend track change its implementation without touching this module.
 *
 * The region is always explicit — a full read is passed the output's own rectangle — so the
 * source never has to infer what "no region" means.
 */
export interface ReadbackSource {
  read(target: ExportOutput, region: ReadbackRegion): Promise<ReadbackImage>;
}

/** Counters, so "did playback stay GPU-to-GPU" is a question with an answer (§V7, §V48). */
export interface ExportStats {
  readonly readbacks: number;
  /** Reads that happened while the frame loop was running. Recording is the expected case. */
  readonly duringPlayback: number;
  readonly refused: number;
  readonly bytesRead: number;
}

export interface ExportInterfaceOptions {
  readonly source: ReadbackSource;
  /** Read per call, so a recompile changes the catalogue without re-wiring anything. */
  readonly outputs: () => ReadonlyArray<ExportOutput>;
  /** True while the frame loop is running. Absent means "not playing". */
  readonly isPlaying?: () => boolean;
  readonly onDiagnostic?: (diagnostic: RuntimeDiagnostic) => void;
  /**
   * Largest window an "inspect" read may take while playing, in pixels. The viewer's
   * readout is 1x1; anything approaching a frame is an export read wearing a disguise.
   */
  readonly maxLiveInspectPixels?: number;
}

/**
 * What the export interface offers. The agent track, the viewer and the recorder all
 * consume this; nothing else in the system is allowed to read pixels back at all (§V48).
 */
export interface ExportInterface {
  /** Every readable output of the current plan, port-scoped (§V59). */
  listOutputs(): ReadonlyArray<ExportOutput>;
  /** `null` for an unknown ref — a caller enumerating outputs should not have to catch. */
  describe(ref: OutputRef): ExportOutput | null;
  /** Descriptor plus bytes, always (§V60). Throws `ExportError` on refusal or unknown ref. */
  read(ref: OutputRef, options?: ReadOptions): Promise<ReadbackImage>;
  readonly stats: ExportStats;
}

/**
 * A refusal or failure that a caller can act on.
 *
 * Carries the diagnostic rather than only a message: an agent tool result is structured data
 * (§V37), and "why was this refused" must survive the trip without being re-parsed out of
 * English.
 */
export class ExportError extends Error {
  readonly diagnostic: RuntimeDiagnostic;

  constructor(diagnostic: RuntimeDiagnostic) {
    super(diagnostic.message);
    this.name = "ExportError";
    this.diagnostic = diagnostic;
  }
}

/** Stable codes. The problems tab, agent tools and tests all key off these (§I.diag). */
export const ExportDiagnosticCode = {
  unknownOutput: "export/unknown-output",
  readbackDuringPlayback: "export/readback-during-playback",
  liveReadTooLarge: "export/live-read-too-large",
  regionOutOfBounds: "export/region-out-of-bounds",
  malformedReadback: "export/malformed-readback",
  unsupportedFormat: "export/unsupported-format",
  recordingFrameGap: "export/recording-frame-gap",
  recordingDuplicateFrame: "export/recording-duplicate-frame",
  recordingOutOfOrder: "export/recording-out-of-order",
  recordingBacklog: "export/recording-backlog",
  recordingFailed: "export/recording-failed",
  encoderUnavailable: "export/encoder-unavailable",
} as const;

export type ExportDiagnosticCodeValue =
  (typeof ExportDiagnosticCode)[keyof typeof ExportDiagnosticCode];

export function exportDiagnostic(
  severity: RuntimeDiagnostic["severity"],
  code: ExportDiagnosticCodeValue,
  message: string,
  extra: Partial<RuntimeDiagnostic> = {},
): RuntimeDiagnostic {
  return { ...extra, severity, code, message };
}

/**
 * A file handed OUT of the runtime. `src/runtime/**` may not touch the DOM (§V63), so
 * saving one is the app layer's job — this is the payload it is handed, not a download.
 */
export interface ExportFile {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: Uint8Array;
}

/** Injected by whoever owns the DOM. The runtime never constructs a download itself. */
export type FileSink = (file: ExportFile) => void | Promise<void>;
