import type { RenderBackend } from "../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { PreviewFrameCommand, PreviewProgram, PreviewRuntimeHost } from "../previews/types.ts";
import type { UniformValues } from "./plan.ts";

/** Stops a running frame loop. Mirrors vgpu's `FrameLoopHandle` without leaking the import. */
export interface FrameLoopControl {
  stop(): void;
}

export interface FrameLoopSettings {
  /** Cap the scheduler. Omit to run at display rate (raf) or 60 (timer). */
  readonly fps?: number;
  /**
   * How ticks are driven (T109). "raf" (default) uses the display clock and only runs
   * where rAF exists; "timer" drives frames off setInterval, which is what a worker
   * without rAF, a Node process, or a backgrounded tab that must keep rendering needs.
   * Same frame path either way — the scheduler is a transport detail (§V49).
   */
  readonly scheduler?: "raf" | "timer";
}

/**
 * A uniform-value update. The type carries values and nothing else — no shader source, no
 * bindings, no sizes — so this path structurally cannot request a recompile (§V5, §T17).
 */
export interface UniformUpdate {
  readonly passId: string;
  readonly values: UniformValues;
}

/**
 * Anything the runtime can present into (T87, §V64/§V70): an on-screen canvas, an
 * `OffscreenCanvas` transferred from another window or into a worker, or a test stub.
 * Structural on purpose — the runtime never touches the DOM, it is HANDED a surface.
 */
export interface PresentableCanvas {
  width: number;
  height: number;
  getContext(contextId: "webgpu", options?: unknown): unknown;
}

export interface PresentationOptions {
  /** Which compiled output this surface shows. */
  readonly outputId: string;
  readonly label?: string;
}

/** One live presentation. The same output may be presented on any number of surfaces (§V70). */
export interface PresentationHandle {
  readonly id: string;
  readonly outputId: string;
  /** Repoint this surface at a different output (pin preview, A/B, perform screens). */
  setOutput(outputId: string): void;
  /** Detaches the surface and frees the canvas for a new context. */
  dispose(): void;
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
  /** Frames the cook gate skipped outright (T254, cookPolicy "auto"). Optional: older fakes omit it. */
  readonly framesSkipped?: number;
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

  /**
   * Clears feedback history (§V22, §V23). No argument = every ping-pong pair (the
   * device-loss semantics). With `resourceIds`, ONLY those pairs are cleared (T215) —
   * what a pulse-based Feedback reset (§V126) and `runtime.resetFeedback` key on.
   * Unknown ids are reported, never silently skipped.
   */
  resetTemporalHistory(resourceIds?: readonly string[]): void;

  /**
   * Attaches a presentable surface to a compiled output (T87, §V64/§V70). The surface is
   * handed in — never created here — and any number of surfaces may present the same
   * output. Presenting is a GPU-to-GPU blit encoded with each frame (§V7); surfaces
   * survive plan recompiles and are re-established across device loss.
   */
  present(canvas: PresentableCanvas, options: PresentationOptions): PresentationHandle;

  /**
   * Creates the preview system's runtime host on a shared surface (T161, doc §12.2):
   * tile passes sample the MAIN program's outputs as external bindings, render into
   * pooled tile targets, and composite to the surface at per-tile viewports — GPU to
   * GPU throughout (§V7). Survives recompiles and device loss like present() does.
   */
  previewHost(canvas: PresentableCanvas): PreviewHostHandle;

  /**
   * Validates WGSL standalone (T195, §V27) — no plan, no target, no render. Safe to
   * call from an editor's debounce while the frame loop runs; it allocates nothing the
   * frame guard cares about. Returns line/column-mapped diagnostics.
   */
  compileShader(source: string, options?: { label?: string }): Promise<ShaderCompileResult>;

  /**
   * Reads a storage buffer back (T125, §V48): a bufferPair reads its READ half — the
   * last COMPLETED frame, coherent with what consumers saw. Counted as a readback;
   * never called from the playback loop. Point-attribute windows go through the export
   * interface built on this, not around it.
   */
  readBuffer(resourceId: string): Promise<ArrayBuffer>;

  /**
   * Per-pass GPU timings in milliseconds, keyed by PASS ID (T163, §V16) — node and
   * component attribution key on that. Fires only when the device has timestamp-query
   * (§V12: `capabilities.timestampQuery`); without it, no listener ever fires and every
   * timing surface honestly reads "unavailable". Results arrive asynchronously, a few
   * frames after the work they measure.
   */
  onGpuTimings(listener: (spans: Readonly<Record<string, number>>) => void): () => void;

  /**
   * Re-attempts device recovery after automatic rebuilds gave up (§V23). Resolves when
   * the attempt settles; check `status.halted` for the outcome. No-op while healthy.
   */
  recover(): Promise<void>;

  /**
   * The cook policy (T249, §V157): `"always"` renders every pass every frame;
   * `"auto"` MAY skip work — and is REQUIRED to be byte-identical to `"always"` at
   * every frame index, which the cook oracle enforces. Ships before any gating exists
   * (today the two are literally the same code path) and stays forever: it is the
   * permanent bisect switch when someone suspects cooking in the wild.
   */
  setCookPolicy(policy: CookPolicy): void;

  /**
   * Binds a CPU-side frame producer to a `sourceId` (T229, §V135). Every
   * `externalTexture` resource declaring that sourceId uploads from this source — on
   * frame-ready, never per render frame (§V136). Returns the unregister function.
   * Registration order is free: a source may arrive before or after the plan compiles,
   * and a texture with no source simply keeps its contents (black until the first
   * frame). Re-registering a sourceId replaces the previous source.
   */
  registerMediaSource(sourceId: string, source: MediaSource): () => void;
}

/** §V157: "auto" must be byte-identical to "always" at EVERY frame index. */
export type CookPolicy = "always" | "auto";

/**
 * One decoded frame offered by a media source (T229).
 *
 * `frameId` is monotonic per source; an unchanged id means "nothing new" and the
 * backend uploads NOTHING (§V136) — a 30fps video in a 60fps graph uploads 30 times.
 * Exactly one of `bytes` / `image` is set: `bytes` is tightly packed rows in the
 * declared texture format (works everywhere, mock and Dawn included); `image` is the
 * browser fast path (ImageBitmap, VideoFrame, canvas — anything
 * `copyExternalImageToTexture` takes), typed `unknown` so this contract never drags DOM
 * types into headless code.
 */
export interface MediaSourceFrame {
  readonly frameId: number;
  readonly bytes?: Uint8Array;
  readonly image?: unknown;
}

/**
 * A frame producer behind a `sourceId` (T229, T231). Deliberately shaped for LIVE
 * sources as much as files: pull-based (`currentFrame()` answers with whatever is
 * newest — no seek, no duration, no demand-driven decode), frames arrive on the
 * source's own schedule, and a stream may end without being closed (webcam unplugged,
 * capture permission revoked) — `ended` flips and the texture keeps its last contents.
 * Transport concerns (play/pause/seek for files) live on the SOURCE's owner, not here.
 */
export interface MediaSource {
  /** Latest decoded frame, or undefined before the first one. */
  currentFrame(): MediaSourceFrame | undefined;
  /** True once no further frames will ever come. Optional: absent means "unknown/live". */
  readonly ended?: boolean;
}

/**
 * Standalone WGSL validation (T195, §V27): a shader checked WITHOUT a plan, a target or
 * a render — what makes iterating on a shader in isolation possible at all.
 */
export interface ShaderCompileResult {
  /** True when validation RAN and reported no errors. Never true on an unvalidating device. */
  readonly ok: boolean;
  /**
   * Whether the device could report compilation info at all. The mock device cannot —
   * `ok: false, validated: false` there means "unknown", not "broken", and the editor
   * should say so rather than paint red.
   */
  readonly validated: boolean;
  /** §V27: messages carry source line/column so the editor can mark the exact spot. */
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

/** The preview track's injected seam, plus the lifecycle the backend owns. */
export interface PreviewHostHandle extends PreviewRuntimeHost {
  dispose(): void;
  /**
   * Counters of the latest tile-resource build (T257, §V162): a program change must
   * REUSE surviving tiles, not blank them. Diagnostic surface; undefined before the
   * first build.
   */
  readonly lastBuildStats?: BuildStats | undefined;
}

export type { PreviewFrameCommand, PreviewProgram, PreviewRuntimeHost };
