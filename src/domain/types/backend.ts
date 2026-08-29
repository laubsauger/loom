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
