import type { AudioFeatures, FrameEvaluationInput } from "./frame.ts";
import type { RuntimeDiagnostic } from "./diagnostics.ts";
import type { TextureFormat } from "./node-definition.ts";

/** Capability tiers, discovered at init and never assumed (§V12). Baseline is Tier B (§C). */
export type CapabilityTier = "A" | "B" | "C";

export interface BackendCapabilities {
  tier: CapabilityTier;
  features: ReadonlyArray<string>;
  formats: ReadonlyArray<TextureFormat>;
  timestampQuery: boolean;
  /**
   * B172 (§V469): whether the device request ASKED for `timestamp-query`. Absent/false
   * with `timestampQuery: false` means WE did not ask; true with `timestampQuery: false`
   * means the adapter does not offer it. Two different facts, and only the second is the
   * device's — so the diagnostic and the panel copy must not conflate them.
   */
  timestampQueryRequested?: boolean;
  limits: Readonly<Record<string, number>>;
}

export interface BackendInitOptions {
  /** Omitted for headless/offline execution — the plan renders without a surface (§V47). */
  canvas?: HTMLCanvasElement;
  powerPreference?: "low-power" | "high-performance";
  requiredFeatures?: ReadonlyArray<string>;
}

/** Shapes owned by the compiler track; opaque at the contract boundary. */
export interface LogicalExecutionPlan {
  readonly passes: ReadonlyArray<unknown>;
  readonly resources: ReadonlyArray<unknown>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

export interface CompiledExecutionPlan {
  readonly id: string;
  readonly logical: LogicalExecutionPlan;
}

export interface FrameInputs {
  frame: FrameEvaluationInput;
  pointer: { x: number; y: number; buttons: number };
  /** T414: the frame's audio features. Absent = no audio input this session (silence). */
  audio?: AudioFeatures;
  resolution: readonly [number, number];
}

/**
 * §V60 — a readback is bytes PLUS everything needed to interpret them.
 *
 * A bare `Uint8Array` is uninterpretable: `rgba16float` needs the format to decode at all,
 * and every API that copies a texture to a buffer pads rows to an alignment, so
 * `width * bytesPerPixel` is the wrong offset for row 1 onwards. Both are silent failures —
 * shifted colours, or half-floats read as bytes — which is why the descriptor is the type
 * rather than a convention.
 *
 * Owned here (not in the export module) so the backend and the export interface name the
 * same shape: `RenderBackend.readOutput` returns it (T82/T173, landed).
 */
export interface ReadbackImage {
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormat;
  /** Bytes per row. NOT necessarily `width * bytesPerPixel` — rows are commonly padded. */
  readonly rowStride: number;
  readonly bytes: Uint8Array;
}

/**
 * Sub-rectangle of an output, in pixels from the top-left.
 *
 * Present so a 1x1 pixel probe does not have to pull a whole frame across the bus (§V7,
 * §V48): the right permission with the wrong implementation is still a stall.
 */
export interface ReadbackRegion {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The sole vgpu boundary. All direct vgpu imports live behind this (§V3, §V10). */
export interface RenderBackend {
  initialize(options: BackendInitOptions): Promise<BackendCapabilities>;
  compile(plan: LogicalExecutionPlan): Promise<CompiledExecutionPlan>;
  render(plan: CompiledExecutionPlan, frame: FrameInputs): void;
  resize(outputId: string, size: readonly [number, number]): void;
  /** Readback is isolated here and behind the export interface — never in playback (§V7, §V48). */
  /**
   * §V48/§V60: the ONLY readback. Returns the full descriptor — bytes are
   * uninterpretable without width/format/rowStride. `region` crops server-side so a
   * 1×1 pixel probe is expressible; rows in the result are tightly packed.
   */
  readOutput(outputId: string, region?: ReadbackRegion): Promise<ReadbackImage>;
  onDiagnostic(listener: (diagnostic: RuntimeDiagnostic) => void): () => void;
  dispose(): void;
}
