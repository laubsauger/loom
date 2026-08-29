import type { RenderBackend } from "../../domain/types/backend.ts";
import type { UniformValues } from "./plan.ts";

/** Stops a running frame loop. Mirrors vgpu's `FrameLoopHandle` without leaking the import. */
export interface FrameLoopControl {
  stop(): void;
}

export interface FrameLoopSettings {
  /** Cap the scheduler. Omit to run at display rate. */
  readonly fps?: number;
}

/**
 * A uniform-value update. The type carries values and nothing else — no shader source, no
 * bindings, no sizes — so this path structurally cannot request a recompile (§V5, §T17).
 */
export interface UniformUpdate {
  readonly passId: string;
  readonly values: UniformValues;
}

/** Reuse accounting for one structural compile (T143). */
export interface BuildStats {
  resourcesCreated: number;
  resourcesReused: number;
  effectsBuilt: number;
  effectsReused: number;
}

export interface BackendStatus {
  readonly initialized: boolean;
  readonly disposed: boolean;
  /** True after device loss until a rebuild succeeds. No work is submitted while halted (§V23). */
  readonly halted: boolean;
  /** Increments on every successful device creation, including post-loss rebuilds. */
  readonly deviceGeneration: number;
  /** Number of times temporal (feedback) history was cleared (§V23). */
  readonly temporalResets: number;
  /** Number of times GPU resources were built. A uniform update must never move this (§V5). */
  readonly resourceBuilds: number;
  /** Frames actually submitted. */
  readonly framesSubmitted: number;
  /** Readbacks performed. Playback must leave this at zero (§V7, §V48). */
  readonly readbacks: number;
  /**
   * §V9: true when the latest compile attempt failed and the retained program from an
   * earlier compile is what is still rendering. The UI flags the output as stale.
   */
  readonly stale: boolean;
  /**
   * What the most recent structural compile did (T143, §V22): unchanged resources and
   * effects are carried over — a carried ping-pong keeps its feedback contents.
   */
  readonly lastBuild?: BuildStats | undefined;
  /** Estimated GPU memory of the current program's targets, in bytes (§V24 reporting). */
  readonly estimatedResourceBytes: number;
}

/**
 * `RenderBackend` plus the pieces the runtime needs that the frozen contract does not name:
 * a scheduler seam, the uniform-only update path, and observable status.
 */
export interface ShaderloomBackend extends RenderBackend {
  readonly status: BackendStatus;

  /**
   * Runs `onFrame` once per scheduled tick with a GPU frame already open, so `render()`
   * calls made inside encode into that frame. No resources are allocated here (§V8).
   */
  loop(onFrame: () => void, settings?: FrameLoopSettings): FrameLoopControl;

  /** Writes uniform values in place. Never rebuilds pipelines or targets (§V5). */
  updateUniforms(update: UniformUpdate): void;

  /** Clears every ping-pong pair. Called automatically on device loss (§V22, §V23). */
  resetTemporalHistory(): void;

  /**
   * Re-attempts device recovery after automatic rebuilds gave up (§V23). Resolves when
   * the attempt settles; check `status.halted` for the outcome. No-op while healthy.
   */
  recover(): Promise<void>;
}
