import type { LogicalExecutionPlan, RenderBackend } from "../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { PreviewFrameCommand, PreviewProgram, PreviewRuntimeHost } from "../previews/types.ts";
import type { UniformValues } from "./plan.ts";

/** Provenance of a texture sampled by a demanded dispatch. Ordinals count encoded
 * renders, independent of skipped or looping project frame indices. */
export interface DispatchSourceFrame {
  readonly renderIndex: number;
  readonly frameIndex: number;
  readonly timeSeconds: number;
}

export interface DispatchInputTiming {
  readonly renderIndex: number;
  /** Absent until a render-produced input has actually been submitted. */
  readonly source: DispatchSourceFrame | undefined;
}

/** Stops a running frame loop. Mirrors vgpu's `FrameLoopHandle` without leaking the import. */
export interface FrameLoopControl {
  stop(): void;
}

export interface FrameLoopSettings {
  /**
   * The scheduler's rate. Read through `projectFps()` (T933), so OMITTING it means the
   * project default — never "unpaced".
   *
   * It used to mean unpaced on the rAF path, which put an absent `fps` at display rate
   * while every other reader of the same absent field saw 60. No shipped document sets
   * `fps`, so that disagreement was the normal case rather than an edge one. An unpaced
   * loop is not currently wanted anywhere (the offline and headless paths drive frames
   * with `FrameDriver.step()` and never open a scheduler at all); if one is ever needed
   * it gets an explicit name here, because an absence cannot say which of two things it
   * meant.
   */
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
  /**
   * T1598b: a DRAW pass's other per-frame value (`DrawPassDescriptor.skip`) — true stops it
   * being encoded, false draws it again. Absent leaves it as it is. Still a value: nothing
   * is built or released either way.
   */
  readonly skip?: boolean;
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

/** Anything that hands out animation frames — a `Window` is one (§T1391b). */
export interface FrameSource {
  requestAnimationFrame(callback: (time: number) => void): number;
  cancelAnimationFrame(handle: number): void;
  /** A closed window never calls back; the loop falls back to its own realm then. */
  readonly closed?: boolean;
}

export interface PresentationOptions {
  /** Which compiled output this surface shows. */
  readonly outputId: string;
  readonly label?: string;
  /** Present a vec4f model-input buffer as opaque packed RGBA8 data, not a viewer. */
  readonly modelInputSize?: readonly [number, number];
  /**
   * §T1391b — how the surface's backing store is sized. `"layout"` (the default): its CSS
   * box × its window's device pixel ratio, refitted per frame, the blit scaling the source
   * into it — a viewer pane. `"source"`: exactly the presented target's size, whatever the
   * box — a perform window showing a Window Out's Width × Height 1:1, the browser scaling
   * the bitmap into the window.
   */
  readonly sizing?: "layout" | "source";
  /** Display-only coverage inspection. Raw RGB is the default for transport integrity. */
  readonly alphaDisplay?: "rgba" | "rgb";
  /**
   * VNB25: apply the sRGB display encode in the blit — the Output node's encode, for a
   * surface that shows a texture with no Output node in front of it (a native SDR output).
   * The CALLER decides from the source's published space (`nativeOutputEncodes`); the
   * backend never infers it. Absent or false is the raw copy every other surface gets.
   * Exclusive with `alphaDisplay: "rgba"`, which is a viewer inspection of encoded values.
   */
  readonly displayEncode?: boolean;
}

/**
 * What one presentation can say about itself (T739).
 *
 * Exists because "the popped-out viewer does not paint" is a question NO agent in this
 * project can answer by measurement: the browser environment has no WebGPU and Dawn has
 * no DOM, so nobody here can watch a floated canvas paint. The runtime CAN say whether it
 * is still encoding blits into that surface, and the fork the whole diagnosis hangs on —
 * painting black versus not painting at all — is exactly the difference between
 * `presentedFrames` climbing and `presentedFrames` frozen. So the unanswerable question
 * becomes a console line the owner reads, the same trick as the boot stamp.
 */
export interface PresentationReport {
  readonly id: string;
  readonly outputId: string;
  /** `getContext("webgpu")` answered AND `configure()` succeeded on this canvas. */
  readonly surfaceConfigured: boolean;
  /** The blit effect exists — i.e. a source resolved at least once. */
  readonly blitReady: boolean;
  /** A source texture is bound right now. False means the output produces nothing. */
  readonly sourceBound: boolean;
  /** Blit passes encoded for this surface since it was attached. */
  readonly presentedFrames: number;
  /** `performance.now()` of the last encoded present; null if there has never been one. */
  readonly lastPresentTime: number | null;
  /**
   * Which device generation the live surface was configured against (§V23 bumps it on
   * every rebuild). Null when there is no surface. A number BELOW the backend's current
   * `deviceGeneration` is a surface that outlived its device.
   */
  readonly deviceGeneration: number | null;
}

/** One live presentation. The same output may be presented on any number of surfaces (§V70). */
export interface PresentationHandle {
  readonly id: string;
  readonly outputId: string;
  /** Repoint this surface at a different output (pin preview, A/B, perform screens). */
  setOutput(outputId: string): void;
  /** Detaches the surface and frees the canvas for a new context. */
  dispose(): void;
  /**
   * T739 diagnostics. OPTIONAL so the many hand-written fake backends in the test suite
   * keep satisfying this interface unchanged — a diagnostic must not cost a refactor of
   * everything that ever stubbed a handle. Callers report its ABSENCE rather than
   * quietly omitting the fields (§V469: a swallowed "cannot say" reads as "nothing wrong").
   */
  describe?(): PresentationReport;
}

/** Reuse accounting for one structural compile (T143). */
export interface BuildStats {
  resourcesCreated: number;
  resourcesReused: number;
  effectsBuilt: number;
  effectsReused: number;
  /**
   * §T1507b: effects this compile ADOPTED from the ones built ahead for a bypassed Layer's
   * passes (`warmPasses`) — new to the program, built before it. Not in `effectsBuilt`.
   * Optional: a build with nothing warm never sets it.
   */
  effectsWarmed?: number;
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
export interface LoomBackend extends RenderBackend {
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
  /**
   * T552/T510: `buffers` extends an UNSCOPED clear to the point SoA pairs, zero-filled —
   * byte-identical to fresh allocation, so a cleared boundary is indistinguishable from
   * a cold open. The caller that sets it must also land the transport on frame 0: the
   * shipped kernel convention is that ctx.frameIndex == 0 MEANS "my buffers were just
   * cleared", and the two halves of that sentence must move together.
   */
  resetTemporalHistory(resourceIds?: readonly string[], options?: { buffers?: boolean; silent?: boolean }): void;

  /**
   * Attaches a presentable surface to a compiled output (T87, §V64/§V70). The surface is
   * handed in — never created here — and any number of surfaces may present the same
   * output. Presenting is a GPU-to-GPU blit encoded with each frame (§V7); surfaces
   * survive plan recompiles and are re-established across device loss.
   */
  present(canvas: PresentableCanvas, options: PresentationOptions): PresentationHandle;

  /**
   * §T1391b, §V202, T303 — WHOSE animation frames drive the realtime loop.
   *
   * The loop runs on the editor window's `requestAnimationFrame`, and a browser stops
   * calling that for a hidden tab — so a show on a perform window froze the moment the
   * editor was backgrounded. Handing a perform window here makes ITS frames drive the loop
   * while it is visible; `null` returns to the editor's. Optional so hand-written fake
   * backends still satisfy the interface.
   */
  setFrameSource?(source: FrameSource | null): void;

  /**
   * T1409b — the SAME frames, for the session's other loops (node previews, viewer
   * synthesis, the Syphon/NDI pump). A request made here is answered by the source
   * `setFrameSource` set (this realm's while there is none, or once it has closed), and a
   * request still pending when the source changes moves to the new one — a request left
   * on a hidden editor's rAF would never be answered. Optional like `setFrameSource`;
   * a loop given a backend without it schedules on its own window.
   *
   * T1488b — `foreign` says WHO answers right now: true while the source `setFrameSource`
   * set (and not closed) does, false while this realm's frames do. A loop that has a
   * hidden-page fallback (T620) needs it: with the editor hidden its own rAF is parked,
   * but a request answered by a perform window is not.
   */
  readonly frames?: FrameSource & { readonly foreign: boolean };

  /**
   * Creates the preview system's runtime host on a shared surface (T161, doc §12.2):
   * tile passes sample the MAIN program's outputs as external bindings, render into
   * pooled tile targets, and composite to the surface at per-tile viewports — GPU to
   * GPU throughout (§V7). Survives recompiles and device loss like present() does.
   */
  previewHost(canvas: PresentableCanvas): PreviewHostHandle;

  /**
   * §T1507b — builds AHEAD what `plan` has and the installed program does not, so a later
   * structural compile that brings those passes in adopts them instead of building them.
   * `plan` is the plan the graph would have with every bypassed Layer on; the switch-on
   * compile then reflects no WGSL and creates no pipeline for them. Nothing is allocated,
   * rendered or read back for what is held, and `null` drops all of it. Resolves with the
   * pass ids held once this call has built what it will. Optional: only a backend with a
   * device has anything to build ahead.
   */
  warmPasses?(plan: LogicalExecutionPlan | null): Promise<readonly string[]>;

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
   *
   * T1243: the second argument is the FRAME the spans came from — its GPU extent and
   * which submit it was. The per-pass spans are not summable into a frame figure (they
   * overlap on Apple GPUs, see `GpuFrameTiming`), so the frame figure arrives beside
   * them, measured from the same timestamps. Optional in the signature only so a
   * listener that wants the per-pass spans alone stays a one-argument function.
   */
  onGpuTimings(
    listener: (spans: Readonly<Record<string, number>>, frame?: GpuFrameTiming) => void,
  ): () => void;

  /**
   * T1295: every timed frame whose results will never arrive — see `GpuTimingDrop`. With it,
   * results plus drops account for every timed frame the backend submitted, so an absence
   * can always be told from a wait. Optional so a backend with no GPU timer need not stub it.
   */
  onGpuTimingsDropped?(listener: (drop: GpuTimingDrop) => void): () => void;

  /**
   * Per-pass CPU ENCODE time in milliseconds, keyed by PASS ID (T256, §V86, §V844).
   *
   * The other half of a node's cost, and a DIFFERENT measurement: this is how long it
   * took to WRITE the commands, which on a real workload differs from how long the GPU
   * spent EXECUTING them by more than an order of magnitude. The two never mix and a CPU
   * number never appears under a GPU label — the PAIR is what says which machine the
   * frame is waiting on, which neither number says alone.
   *
   * Required, not optional, and for the reason the `cpu ms` column read "unavailable" on
   * every machine for the whole life of T256: nothing implemented `CpuTimingSource`, so
   * there was nothing to attach. An optional method is how that happens again.
   *
   * Emitted once per encoded frame, synchronously — unlike the GPU spans, which come back
   * a few frames later. Costs nothing while no listener is registered.
   */
  onCpuTimings(listener: (spans: Readonly<Record<string, number>>) => void): () => void;

  /**
   * T1604b: one device render pass PER DRAW again, so each draw's GPU span is its own.
   *
   * By default a run of a node's draws into one target is ONE device render pass
   * (`renderPassRuns`), with one span the run's passes share. That is the cheap frame and
   * the picture is the same either way; this is for a person measuring a pass, and whoever
   * shows per-pass figures asks for it while they are on screen. Same plan, same picture,
   * nothing rebuilt. Optional so a backend without runs need not stub it.
   */
  setExactPassTiming?(exact: boolean): void;

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
   * T1329b — HOLD EVERY SURFACE'S BACKING STORE WHILE A PANE-RESIZE GESTURE IS LIVE.
   *
   * Assigning `canvas.width`/`height` is not a resize: it reallocates the drawing buffer
   * and CLEARS it, and a WebGPU canvas has no valid swapchain texture again until the next
   * present lands. A layout-backed surface is sized from its CSS box once per frame, so a
   * pane divider dragged across 40 frames reallocates 40 times — measured on E32 Pasture
   * (77 nodes): 40 writes on the preview surface and 40 on the graph background, every one
   * of them from the per-frame sizing, and frame pacing tracked the count (median gap
   * 20–30 ms against 10–11 ms for a divider that could not move).
   *
   * While held, the backing store keeps the size it has and the browser scales the existing
   * bitmap into the changing box — so the picture is momentarily soft or slightly stretched
   * instead of blanking, and that is the deliberate trade. Releasing the hold resizes every
   * surface once, immediately.
   *
   * It is a GESTURE hold, not a debounce: the caller states when the drag begins and ends,
   * so nothing has to guess at a settling time, and a hold that is never released is a bug
   * with an obvious cause rather than a silently stale picture.
   */
  setSurfaceResizeHold(held: boolean): void;

  /**
   * Binds a CPU-side frame producer to a `sourceId` (T229, §V135). Every
   * `externalTexture` resource declaring that sourceId uploads from this source — on
   * frame-ready, never per render frame (§V136). Returns the unregister function.
   * Registration order is free: a source may arrive before or after the plan compiles,
   * and a texture with no source simply keeps its contents (black until the first
   * frame). Re-registering a sourceId replaces the previous source.
   */
  registerMediaSource(sourceId: string, source: MediaSource): () => void;

  /**
   * Registers demand for a CPU-consumed compute input. Evaluated before each matching
   * dispatch, with the exact frame passed to render(), before either timing span starts.
   * The consumer reserves that frame here and consumes it after submission. Returning
   * false skips only this dispatch; its previous buffer contents remain unchanged.
   * Registration may precede compilation. A replacement owns the pass until unregistered.
   */
  registerDispatchGate(passId: string, gate: (frame: FrameEvaluationInput, timing: DispatchInputTiming) => boolean): () => void;
}

/** §V157: "auto" must be byte-identical to "always" at EVERY frame index. */
/**
 * T1243: one submitted frame's GPU extent — the earliest pass begin to the latest pass
 * end among the passes that carried a timer span in that vgpu frame, in milliseconds.
 *
 * `submit` is the backend's `status.framesSubmitted` value the frame counts as (the
 * value AFTER the `render()` that encoded it). A `render()` is one vgpu frame on both
 * paths since §T1707b; through vgpu 0.5.0 the direct path split it around compute
 * dispatches, and those frames shared one `submit`.
 * `null` only if the frame was encoded outside `render()`, which no path does today.
 *
 * Not covered by the extent, by construction of what carries a span: presentation
 * blits, and repeats of looped passes past the timer's per-frame capacity. It is the
 * plan's work, render passes and kernels, not the whole submit.
 */
export interface GpuFrameTiming {
  readonly gpuMs: number;
  readonly submit: number | null;
}

/**
 * T1295: one frame whose GPU timing will NEVER arrive through `onGpuTimings`.
 *
 * Without it a lost frame is indistinguishable from one whose results have not landed yet,
 * and the export path lost most of them: vgpu's query ring has three staging slots and drops
 * rather than blocks, and through vgpu 0.5.0 the export path submitted one frame per compute
 * segment — so every segment past the third of one render, and every frame of a run that
 * never yields to the event loop, reported nothing. `staging-busy` is that; `abandoned` is a frame whose timer a
 * failed pass discarded, or that never reached the queue. `spans` is how many it carried.
 */
export interface GpuTimingDrop {
  readonly submit: number | null;
  readonly reason: "staging-busy" | "abandoned";
  readonly spans: number;
}

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
  /**
   * VNB13: the image's first row is its BOTTOM (OpenGL's origin), so the upload flips it.
   * Syphon surfaces are laid out that way — every OpenGL publisher (Resolume, TouchDesigner,
   * VDMX) draws with a bottom-left origin — while a VideoFrame is read top row first.
   */
  readonly flipY?: boolean;
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
