import type { FrameEvaluationInput } from "./frame.ts";
import type { RuntimeDiagnostic } from "./diagnostics.ts";
import type { TextureFormat } from "./node-definition.ts";

/** Capability tiers, discovered at init and never assumed (§V12). Baseline is Tier B (§C). */
export type CapabilityTier = "A" | "B" | "C";

export interface BackendCapabilities {
  tier: CapabilityTier;
  features: ReadonlyArray<string>;
  formats: ReadonlyArray<TextureFormat>;
  timestampQuery: boolean;
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
 * same shape: T82 changes `RenderBackend.readOutput` to return this.
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
  readOutput(outputId: string): Promise<Uint8Array>;
  onDiagnostic(listener: (diagnostic: RuntimeDiagnostic) => void): () => void;
  dispose(): void;
}
