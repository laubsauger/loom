import { effect, frame, frameLoop, sampler, surface, timer, uniforms } from "vgpu";
import type { Draw, Effect, Frame, PingPongTargets, StorageBuffer, Surface, SurfaceCanvas, Target, Timer, TimerSpan } from "vgpu";
import { nativeInputTransportSize, NATIVE_INPUT_PACK_WGSL } from "../../models/native-input-layout.ts";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import { absTimeSecondsOf } from "../../../domain/types/frame.ts";
import type { FrameEvaluationInput } from "../../../domain/types/frame.ts";
// T933: the ONE place the project rate's default is applied. The scheduler is the third
// reader of `fps` after the settings pane and the clock, and it used to be the one that
// read the raw field.
import { projectFps } from "../../../domain/types/graph.ts";
import type {
  BackendCapabilities,
  BackendInitOptions,
  CompiledExecutionPlan,
} from "../../../domain/types/backend.ts";
import type {
  BackendStatus,
  DispatchInputTiming,
  DispatchSourceFrame,
  BuildStats,
  FrameLoopSettings,
  GpuFrameTiming,
  GpuTimingDrop,
  // Ours, NOT the DOM's Media Source Extensions global of the same name — without this
  // import the code below would silently typecheck against the wrong interface.
  CookPolicy,
  MediaSource,
  PresentableCanvas,
  PresentationHandle,
  PresentationOptions,
  FrameSource,
  PresentationReport,
  PreviewFrameCommand,
  PreviewHostHandle,
  PreviewProgram,
  LoomBackend,
} from "../backend-types.ts";
import {
  BackendDiagnosticCode,
  backendDiagnostic,
  createDiagnosticHub,
  describeError,
} from "../diagnostics.ts";
import { bufferRegionProblem, encodeBufferRows } from "../buffer-write.ts";
import type { BufferRegionValues, BufferWritePassDescriptor } from "../plan.ts";
import { createFrameGuard } from "../frame-guard.ts";
import { createPacedGate } from "../frame-pacing.ts";
import {
  MAX_KERNEL_STEPS,
  MAX_TIMED_SPANS_PER_FRAME,
  bytesPerPixelFor,
  estimateResourceBytes,
  expandLoops,
  iterationSpanName,
  passStructureKey,
  planStructureSignature,
  resourceStructureKey,
  planSkippedDraws,
  planUniformValues,
  rateSubsteps,
  readExecutionPlan,
  renderPassRuns,
  runSpanName,
  type DrawPassDescriptor,
  type KernelStepRate,
  type PassDescriptor,
  type RenderPassRun,
  type BufferBindingDescriptor,
  type TextureBindingDescriptor,
  type ResourceDescriptor,
  type UniformValues,
} from "../plan.ts";
import { dispatchFrameUniforms, dispatchStepUniforms, sharedUniformsFromFrame } from "../shared-uniforms.ts";
import type { DispatchStep } from "../shared-uniforms.ts";
import { authoredPosition, type AuthoredPosition, type WgslSourceMap } from "../wgsl-source-map.ts";
import { describeCapabilities, meetsBaseline } from "./capabilities.ts";
import { browserGpuHost, type GpuHost, type GpuSession } from "./gpu-host.ts";
import { preparedShader } from "./prepared-shader.ts";
import { BLIT_WGSL, ENCODE_BLIT_WGSL, RGBA_BLIT_WGSL } from "./presentation-shaders.ts";
import {
  ResourceBuildError,
  bufferRegion,
  buildResources,
  emptyCarryOver,
  noExternalResources,
  regionOf,
  toMutable,
  type CarryOver,
  type ExternalResources,
  type PassBuildVerdict,
  type ResourceSet,
} from "./resources.ts";
import { createWarmEffects, type WarmEffects } from "./warm-effects.ts";
import { createEnvironmentPreparation } from "./environment-preparation.ts";

/**
 * The vgpu adapter: the only implementation of `RenderBackend`, and the only place in the
 * codebase that touches vgpu at all (§V3, §I.backend).
 *
 * Design notes that carry invariants:
 *  - §V5: `compile()` keys resource construction on a structural signature that *excludes*
 *    uniform values. A parameter change produces an identical signature and therefore
 *    cannot reach the build path — recompilation is not merely discouraged, it is
 *    unreachable. `updateUniforms()` accepts values and nothing else.
 *  - §V8: every allocation goes through a frame guard that throws while a frame is open,
 *    and pipelines are built with `compileSync()` at compile time.
 *  - §V23: device loss halts submission before anything else, reports a structured
 *    diagnostic, rebuilds from the retained plan (the compiled form of the domain graph)
 *    and clears temporal history.
 *  - §V47: no surface is ever created. The plan renders into offscreen targets whether or
 *    not a canvas was supplied, so headless is the same code path, not a variant.
 */

export interface VgpuBackendOptions {
  /** Device-acquisition seam: browser by default, `mockGpuHost()` in tests. */
  readonly host?: GpuHost;
  /** Rebuild automatically after device loss. Default true (§V23). */
  readonly recoverFromDeviceLoss?: boolean;
  /** Rebuild attempts per recovery before giving up and waiting for `recover()`. Default 3. */
  readonly maxRebuildAttempts?: number;
  /** Injectable backoff between rebuild attempts; deterministic in tests. */
  readonly retryDelay?: (attempt: number) => Promise<void>;
}

/** A rendering exception storm means something structural broke; stop before attempt 4. */
const MAX_CONSECUTIVE_FRAME_ERRORS = 3;

/**
 * B186 — what "history is gone" writes, and it is spelled out because vgpu's default is
 * not it: a target with no `clearColor` clears to `[0, 0, 0, 1]`, and a pair that reads
 * back opaque is not what a fresh allocation looks like (WebGPU zeroes new textures,
 * alpha included). `clearTemporalHistory` promises the two are the same state.
 */
const CLEARED_HISTORY = [0, 0, 0, 0] as const;

const defaultRetryDelay = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));


/** `LoomBackend` plus a settle hook for shutdown and deterministic tests. */
export interface VgpuBackend extends LoomBackend {
  /** The report from the live device. Undefined before `initialize()`. */
  readonly capabilities: BackendCapabilities | undefined;
  /** Resolves once any in-flight device recovery has finished. */
  whenSettled(): Promise<void>;
  /** T1604b: this backend has runs, so the switch is always there (optional on `LoomBackend`). */
  setExactPassTiming(exact: boolean): void;
}

/** Intrinsic copy extent; element CSS dimensions never describe video/image pixels. */
function externalImageSize(image: unknown): readonly [number, number] | undefined {
  if (typeof image !== "object" || image === null) return undefined;
  const source = image as Record<string, unknown>;
  const keys = "videoWidth" in source ? ["videoWidth", "videoHeight"]
    : "naturalWidth" in source ? ["naturalWidth", "naturalHeight"]
      : "displayWidth" in source ? ["displayWidth", "displayHeight"] : ["width", "height"];
  const width = source[keys[0]!];
  const height = source[keys[1]!];
  return typeof width === "number" && Number.isInteger(width) && width > 0 &&
    typeof height === "number" && Number.isInteger(height) && height > 0 ? [width, height] : undefined;
}

interface Program {
  preparations?: ReturnType<typeof createEnvironmentPreparation>;
  readonly id: string;
  /** Mutable: `resize()` reconciles both so the compile cache never diverges from the GPU (R4). */
  signature: string;
  resourceDescriptors: ReadonlyArray<ResourceDescriptor>;
  readonly passes: ReadonlyArray<PassDescriptor>;
  readonly textureFrames: Map<string, DispatchSourceFrame>;
  /**
   * T387: plan order with every substep region expanded — the order the ENCODER walks.
   *
   * Kept beside `passes` rather than replacing it, because the two answer different
   * questions. `passes` is what EXISTS (one entry per pass; what resources are built from,
   * what uniforms are flushed to, what the recompile classifier diffs). `encodePasses` is
   * what HAPPENS this frame, and the same pass object appears in it once per iteration.
   * Building resources from the expanded list would build the same pipeline fifty times.
   */
  encodePasses: ReadonlyArray<PassDescriptor> | undefined;
  /**
   * T425: live per-loop iteration counts, keyed by loopId. Seeded from the plan's
   * declared counts; `updateUniforms` on a loop-begin pass overwrites one, and the
   * encoder re-expands when a count changes — a substep count is a VALUE.
   */
  readonly loopCounts: Map<string, number>;
  /** T1583b: a kernel region's live iterations per substep, by loopId, beside its count. */
  readonly loopIterations: Map<string, number>;
  /**
   * T1585b: the live rate of a kernel region whose substeps follow the frame, by loopId.
   * `render()` turns it into that frame's count (`rateSubsteps`) before anything is
   * written or encoded; a region with no entry runs the count it was given.
   */
  readonly loopRates: Map<string, KernelStepRate>;
  /**
   * T1598b: the draw passes NOT encoded this frame (`DrawPassDescriptor.skip`), by pass id.
   * Seeded from the plan and moved by `updateUniforms`, like a loop's count.
   */
  readonly skipped: Set<string>;
  /**
   * T1604b: which device render pass each draw belongs to — its run (`renderPassRuns`, read
   * off the plan as written, so a loop marker ends one) and its place in it. Structure:
   * built with the program and never moved by a value.
   */
  readonly runs: ReadonlyMap<string, { readonly run: RenderPassRun; readonly at: number }>;
  /**
   * T1583b: the dispatches a kernel region steps, by DISPATCH pass id. Read off the plan
   * whenever it is installed or its values move (`prepare` is a value).
   */
  stepped: ReadonlyMap<string, SteppedDispatch>;
  /**
   * T1583b: what each stepped dispatch runs THIS render and how far it has got. Decided
   * once per render, where the per-run uniforms are written, and read by the encoder — so
   * the number of blocks written and the number of runs encoded cannot disagree.
   */
  readonly stepRuns: Map<string, { readonly total: number; done: number }>;
  readonly compiled: CompiledExecutionPlan;
  /** Latest uniform values per pass, including live updates. Survives a device rebuild. */
  readonly liveUniforms: Map<string, UniformValues>;
  resources: ResourceSet;
  /** Resource → pass → bindings. Built outside frames; a swap visits only its consumers. */
  textureConsumers: BindingConsumers<TextureBindingDescriptor>;
  bufferConsumers: BindingConsumers<BufferBindingDescriptor>;
  /** externalTexture resource ids whose contents changed THIS frame (T253, §V136). */
  mediaDirty?: ReadonlySet<string>;
  /**
   * T254 (§V156, statically derived): true when ANY pass must run every frame — it
   * reads the clock (shared-frame or kernel-frame binding) or touches evolving state
   * (ping-pong, buffer pair, external texture). A plan where this is false is FULLY
   * STATIC: with nothing dirty, re-encoding it redraws identical pixels, so under
   * cookPolicy "auto" the frame is skipped outright. §V155 is safe by construction —
   * a stateful pass makes the plan every-frame, so nothing skippable has state.
   */
  everyFrame: boolean;
  /** T510: an unscoped buffers clear happened; the next render's dispatches read firstRun = 1u. */
  pendingBufferClear: boolean;
  /** Something changed since the last encoded frame: uniforms, a compile, a reset. */
  dirty: boolean;
}

/** T1583b: one dispatch a kernel region steps — see `KernelStepsDescriptor` in plan.ts. */
interface SteppedDispatch {
  readonly loopId: string;
  /** The pair swapped between runs. */
  readonly pair: string;
  /** Runs to keep uniform slots ready for, whatever the live count is. */
  readonly prepare: number;
  /** Where each run's own uniform block binds; absent, the runs share the pass's values. */
  readonly uniformBinding: string | undefined;
  /** The node a diagnostic about these runs names. */
  readonly nodeId: string | undefined;
}

function steppedDispatches(passes: ReadonlyArray<PassDescriptor>): Map<string, SteppedDispatch> {
  const out = new Map<string, SteppedDispatch>();
  passes.forEach((pass, index) => {
    if (pass.kind !== "loop" || pass.edge !== "begin" || pass.steps === undefined) return;
    // `readExecutionPlan` refused every other shape: the body is one dispatch.
    const body = passes[index + 1];
    if (body === undefined || body.kind !== "dispatch") return;
    out.set(body.id, {
      loopId: pass.loopId,
      pair: pass.steps.pair,
      prepare: pass.steps.prepare,
      uniformBinding: body.uniformBinding,
      nodeId: body.nodeId,
    });
  });
  return out;
}

/**
 * T1583b — ONE UNIFORM BLOCK PER RUN of a stepped dispatch (assessment risk 2).
 *
 * The runs of one frame differ only in uniform values: the run index, `firstRun`, the seed.
 * With ONE block rewritten between dispatches, what each run reads depends on vgpu
 * submitting every `dispatch()` as its own command buffer the moment it is called — true
 * today and not promised: under one encoder per frame the writes would all land before the
 * first dispatch, and every run would read the last index. So each run binds a block of its
 * own, every block is written BEFORE the first dispatch is encoded, and the order things
 * reach the queue in stops mattering.
 *
 * Separate blocks, not one buffer read at dynamic offsets: vgpu's bind path passes no
 * offsets (`set-core.js` hands `setBindGroup` an empty list) and its uniform packer is
 * private, so dynamic offsets would cost a new patch to vgpu and a second copy of its
 * packing rules here. A block per run needs neither.
 *
 * Run 0 is the pass's own block, so a kernel run once per frame owns nothing here. Keyed by
 * the compute pipeline because that is the true owner — a block adopts that pipeline's
 * `KernelFrame` layout and lives in its bind groups — which also makes carry-over free: a
 * carried pipeline arrives with its slots, a replaced one takes them with it
 * (`releaseResourcesExcept`).
 */
interface StepSlots {
  /** Run `r >= 1` reads `blocks[r - 1]`. */
  readonly blocks: Array<{ set(values: Record<string, unknown>): void }>;
  /** The run whose block the pipeline's uniform binding points at now. */
  bound: number;
}

const stepSlotsOf = new WeakMap<object, StepSlots>();

type BindingConsumers<T> = ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<T>>>;

function indexBindingConsumers<T extends { readonly resourceId: string }>(
  bindingsByPass: ReadonlyMap<string, ReadonlyArray<T>>,
): BindingConsumers<T> {
  const consumers = new Map<string, Map<string, T[]>>();
  for (const [passId, bindings] of bindingsByPass) {
    for (const binding of bindings) {
      let passes = consumers.get(binding.resourceId);
      if (passes === undefined) {
        passes = new Map();
        consumers.set(binding.resourceId, passes);
      }
      let matching = passes.get(passId);
      if (matching === undefined) {
        matching = [];
        passes.set(passId, matching);
      }
      matching.push(binding);
    }
  }
  return consumers;
}

interface LoopRegistration {
  readonly onFrame: () => void;
  readonly settings: FrameLoopSettings;
  handle: { stop(): void } | undefined;
  stopped: boolean;
}

/**
 * One attached presentation surface (T87, §V64/§V70). The canvas is retained so the
 * surface can be re-established on a fresh device after loss; the blit is rebound
 * whenever the source object changes (recompile replacing a target, output switch).
 */
interface PresentationState {
  readonly id: string;
  readonly canvas: PresentableCanvas;
  readonly label: string | undefined;
  readonly modelInputSize?: readonly [number, number];
  /** §T1391b: `"source"` = backing store is the presented target's size, never the box's. */
  readonly sizing: "layout" | "source";
  readonly alphaDisplay: "rgba" | "rgb";
  /** VNB25: the blit applies the display encode (a native SDR output). Fixed for its life. */
  readonly displayEncode: boolean;
  outputId: string;
  surface: Surface | undefined;
  blit: Effect | undefined;
  /** The exact object currently bound as the blit source, for change detection. */
  boundSource: Target | PingPongTargets | StorageBuffer | undefined;
  disposed: boolean;
  /**
   * T739 diagnostics. `surfaceGeneration` is which device `surface` was configured
   * against, read only while `surface` exists so a stale value can never be reported.
   * The counter and timestamp are what separate "painting black" from "not painting at
   * all" — the fork nobody in this project can see with their own eyes.
   */
  surfaceGeneration: number | undefined;
  presentedFrames: number;
  lastPresentTime: number | undefined;
}

/**
 * VNB13 — an image's bytes with its rows in the opposite order: a bottom-first frame as the
 * top-first one a texture is written from. `scratch` is reused when it is the right size, so
 * a source that sends bottom-first bytes every frame allocates once.
 */
export function rowsReversed(bytes: Uint8Array, bytesPerRow: number, rows: number, scratch?: Uint8Array): Uint8Array {
  const length = bytesPerRow * rows;
  const out = scratch !== undefined && scratch.byteLength === length ? scratch : new Uint8Array(length);
  for (let row = 0; row < rows; row += 1) {
    const from = (rows - 1 - row) * bytesPerRow;
    out.set(bytes.subarray(from, from + bytesPerRow), row * bytesPerRow);
  }
  return out;
}

export function createVgpuBackend(options: VgpuBackendOptions = {}): VgpuBackend {
  /** VNB13: the buffer `rowsReversed` writes into, kept between frames. */
  let flipScratch: Uint8Array | undefined;
  const host = options.host ?? browserGpuHost();
  const recover = options.recoverFromDeviceLoss ?? true;
  const maxRebuildAttempts = options.maxRebuildAttempts ?? 3;
  const retryDelay = options.retryDelay ?? defaultRetryDelay;
  const hub = createDiagnosticHub();
  const guard = createFrameGuard();

  let session: GpuSession | undefined;
  let initOptions: BackendInitOptions | undefined;
  let capabilities: BackendCapabilities | undefined;
  let program: Program | undefined;
  let currentFrame: Frame | undefined;
  let recovery: Promise<void> | undefined;
  const loops = new Set<LoopRegistration>();

  let disposed = false;
  let halted = false;
  let deviceGeneration = 0;
  let temporalResets = 0;
  let resourceBuilds = 0;
  let framesSubmitted = 0;
  /** Frames the T254 idle gate skipped outright under cookPolicy "auto". */
  let framesSkipped = 0;
  let readbacks = 0;
  let planCounter = 0;
  /** §V9: latest compile attempt failed; the retained program is what still renders. */
  let stale = false;
  let estimatedBytes = 0;
  let consecutiveFrameErrors = 0;
  let lastBuildStats: BuildStats | undefined;
  const presentations = new Map<string, PresentationState>();
  /** §V157: the permanent bisect switch. Read by the render loop's T254 idle gate (§V156). */
  let cookPolicy: CookPolicy = "always";
  /** sourceId → frame producer (T229, §V135). Backend-lifetime: survives recompiles and device loss. */
  const mediaSources = new Map<string, { source: MediaSource; token: object }>();
  const mediaExtentFailures = new Map<string, string>();
  const dispatchGates = new Map<string, { gate: (frame: FrameEvaluationInput, timing: DispatchInputTiming) => boolean }>();
  let presentationCounter = 0;
  let presentSampler: GPUSampler | undefined;
  /** GPU pass timer (T163). Exists only when the device has timestamp-query (§V12). */
  let gpuTimer: Timer | undefined;
  const timingListeners = new Set<
    (spans: Readonly<Record<string, number>>, frame: GpuFrameTiming) => void
  >();
  /** T1295: the frames `timingListeners` will never hear about, with why. */
  const droppedTimingListeners = new Set<(drop: GpuTimingDrop) => void>();
  /**
   * T1243: which submit each timed vgpu frame belongs to, keyed by the frame object the
   * spans were attached to. vgpu hands that object back with the results (patched
   * `Timer.onResults`, second argument), which is what lets an asynchronous result be
   * tied to the `render()` that encoded it without a FIFO that a dropped or abandoned
   * frame could desynchronise. Weak: a frame that never reports is simply forgotten.
   */
  const timedFrames = new WeakMap<Frame, number>();
  /**
   * T256 (§V86, §V844) — the CPU half of a node's cost: how long ENCODING each pass took.
   *
   * `CpuTimingSource` and the whole `cpu ms` column shipped with no producer anywhere in
   * the tree, so every node read "unavailable" forever — the same shape as B172's GPU half
   * and forty lines away from it in `hub.ts`. This is the producer. It is a DIFFERENT
   * measurement from the GPU span and never substitutes for one (§V86): writing the
   * commands and executing them differ by orders of magnitude, which is exactly why the
   * pair is worth showing.
   */
  const cpuTimingListeners = new Set<(spans: Readonly<Record<string, number>>) => void>();
  /** T1604b: true = one device render pass per draw (`setExactPassTiming`); false = one per run. */
  let exactPassTiming = false;
  let unsubscribeTimer: (() => void) | undefined;
  /**
   * T327 (B33): the PERSISTENT device-error net. B9's listener only lives for the
   * compile window, but a pipeline built lazily fails at its FIRST DISPATCH — inside a
   * frame, long after compile unsubscribed — and the error then went to gpu.onError
   * with nobody listening: nine storage buffers against a limit of eight rendered
   * "successfully" forever with zero diagnostics. A recovery path must ride something
   * unconditional (§V209); for device verdicts that is the session's whole lifetime.
   */
  let unsubscribeErrorNet: (() => void) | undefined;
  /** True while compile()'s own listener owns pipeline-compile errors (B9's veto). */
  let compileErrorWindow = false;
  /**
   * §T1507b: Effects built ahead for passes the installed program does not have — a
   * bypassed Layer's — handed to the next structural compile that brings them in. Belongs
   * to one device: a compile on another (after a loss) takes nothing from it.
   */
  let warmEffects: WarmEffects | undefined;
  /**
   * T1523b: pass ids whose pipeline failures a pending `reportBuildVerdicts` is collecting —
   * a preview's or a device rebuild's. Counted, because two builds can name one pass.
   */
  const claimedPipelineLabels = new Map<string, number>();

  function attachErrorNet(watched: GpuSession): void {
    unsubscribeErrorNet?.();
    const report = (error: unknown): void => {
      program?.preparations?.invalidate();
      // During the compile window the B9 listener triages pipeline failures itself
      // (veto + release); reporting them here too would double every shader error.
      if (compileErrorWindow && isPipelineCompileError(error)) return;
      // T1523b: a build that collects its own verdicts says this one on the pass's node.
      if (isPipelineCompileError(error) && claimedPipelineLabels.has(failedPipelineLabel(error))) return;
      // T1705b: vgpu's timer lost a timestamp readback (its staging buffer went with a lost
      // device, say). That is GPU timing gone missing, not a pass that failed: told as such,
      // and not as the error that says the failing pass renders nothing.
      if ((error as { code?: unknown } | null)?.code === "VGPU-QUERY-READBACK") {
        hub.report(
          backendDiagnostic(
            "warning",
            BackendDiagnosticCode.frameError,
            `GPU timing readback dropped: ${describeError(error)}`,
          ),
        );
        return;
      }
      hub.report(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.frameError,
          `GPU validation error: ${describeError(error)}`,
          { suggestion: "The failing pass renders nothing. Check binding counts and formats against device limits." },
        ),
      );
    };
    const unsubscribeScoped = watched.gpu.onError(report);
    // vgpu's onError only carries its OWN scoped errors. A verdict outside any scope —
    // a bind-group or dispatch validation failure — surfaces on the RAW device's
    // uncaptured-error path, which nothing forwarded (the literal B33 hole). This is
    // the sanctioned reach-through (§V3), same as compileShader's.
    const raw = (watched.gpu.device as { gpu?: GPUDevice }).gpu;
    const uncaptured = (event: { readonly error?: { readonly message?: string } }): void => {
      report(new Error(event.error?.message ?? "uncaptured GPU error"));
    };
    if (raw !== undefined && "onuncapturederror" in raw) {
      (raw as { onuncapturederror: unknown }).onuncapturederror = uncaptured;
    }
    unsubscribeErrorNet = () => {
      unsubscribeScoped();
      if (raw !== undefined && "onuncapturederror" in raw) {
        (raw as { onuncapturederror: unknown }).onuncapturederror = null;
      }
    };
  }

  /**
   * T1523b(b) — A BUILD THAT DOES NOT VETO STILL OWES EVERY ERROR ITS NODE (§V27, §V288).
   *
   * `compile()` reads its build's verdicts before it installs. The preview hosts and the
   * device-loss rebuild build too — synchronously, with nothing to refuse — and their
   * device errors went out on the uncaptured path (the module) and through the net (the
   * pipeline), naming no node. They now build inside the same per-pass scopes, and this
   * reads the answers afterwards: each failure becomes the same row `compile()` would
   * write — the compiler's message, on the author's line, under the pass's node — with
   * the suggestion that fits a build that kept nothing (`suggestion`).
   *
   * MUST be called synchronously after the build returns: the pipeline failures are
   * delivered asynchronously, so the listener and the net's claim go up before the first
   * await, or a failure could slip past both.
   */
  async function reportBuildVerdicts(
    watched: GpuSession,
    verdicts: readonly PassBuildVerdict[],
    passes: readonly PassDescriptor[],
    suggestion: string,
  ): Promise<void> {
    // The mock device opens no scopes; there is nothing to read.
    if (verdicts.length === 0) return;
    const labels = new Set(verdicts.map((verdict) => verdict.passId));
    for (const label of labels) claimedPipelineLabels.set(label, (claimedPipelineLabels.get(label) ?? 0) + 1);
    const pipelineFailures: unknown[] = [];
    const unsubscribe = watched.gpu.onError((error: unknown) => {
      if (isPipelineCompileError(error) && labels.has(failedPipelineLabel(error))) pipelineFailures.push(error);
    });
    try {
      // Twice, for the reason `compile()` gives: the scope pops, then the listener delivery.
      await watched.gpu.settled();
      await watched.gpu.settled();
      const { failures, notices } = await deviceVerdictDiagnostics(
        (watched.gpu.device as { gpu?: GPUDevice }).gpu,
        pipelineFailures,
        await passBuildErrors(verdicts),
        passes,
        suggestion,
      );
      if (disposed) return;
      for (const diagnostic of [...notices, ...failures]) hub.report(diagnostic);
    } catch (error) {
      // A device that died while answering is reported by the loss path; anything else is
      // still said, never swallowed (§V469).
      if (!disposed) {
        hub.report(
          backendDiagnostic(
            "error",
            BackendDiagnosticCode.frameError,
            `Could not read the device's build verdicts: ${describeError(error)}`,
          ),
        );
      }
    } finally {
      unsubscribe();
      for (const label of labels) {
        const left = (claimedPipelineLabels.get(label) ?? 1) - 1;
        if (left > 0) claimedPipelineLabels.set(label, left);
        else claimedPipelineLabels.delete(label);
      }
    }
  }

  interface PreviewHostState {
    readonly canvas: PresentableCanvas;
    surface: Surface | undefined;
    program: PreviewProgram | undefined;
    set: ResourceSet | undefined;
    /** Descriptors `set` was built from — the previous side of the T257 carry diff. */
    built: { resources: ReadonlyArray<ResourceDescriptor>; passes: ReadonlyArray<PassDescriptor> } | undefined;
    /** Counters of the latest build — what proves a rebuild CARRIED instead of blanking (§V162). */
    stats: BuildStats | undefined;
    /**
     * The latest build was partial or failed — typically a race where the preview
     * program referenced main outputs the CURRENT main program does not have yet.
     * Every main compile retries a dirty host (T258); the set keeps presenting
     * whatever it has in the meantime.
     */
    dirty: boolean;
    blit: Effect | undefined;
    /** External texture bindings per pass, for re-pointing after a main recompile. */
    externalBindings: Array<{ passId: string; binding: string; resourceId: string }>;
    disposed: boolean;
  }
  const previewHosts = new Set<PreviewHostState>();

  /**
   * T1329b — WHO SIZES A LAYOUT-BACKED SURFACE, and why it is this file rather than vgpu.
   *
   * vgpu sizes every layout-backed surface from its CSS box once per frame advance
   * (`applyAutoResize`), and a size change assigns `canvas.width`, which REALLOCATES and
   * CLEARS the drawing buffer. Measured on E32 Pasture while dragging the bottom divider:
   * 80 backing-store writes across 40 pointer moves, all of them from that per-frame
   * sizing — 40 on the preview surface, 40 on the graph background. The row's original
   * suspect (`use-output-presentation`'s ResizeObserver) wrote nothing in that gesture.
   *
   * So the surfaces are created with `autoResize: false` and sized HERE, by the same rule,
   * at the same moment in the frame — which costs nothing extra and buys the one thing
   * vgpu's version cannot offer: it can be HELD for the duration of a gesture
   * (`setSurfaceResizeHold`). While held the bitmap keeps its size and the browser scales
   * it into the changing box; the release resizes once.
   */
  let surfaceResizeHeld = false;

  /** §T1391b: whose animation frames drive the realtime loop; null = this realm's. */
  let frameSource: FrameSource | null = null;

  /** T1409b: requests pending through `frames`, by the id handed out, and where each waits. */
  const followers = new Map<number, { callback: (time: number) => void; requester: FrameSource; handle: number }>();
  let nextFollower = 1;

  /** The CSS box in device pixels, or undefined for a canvas with no layout (Offscreen). */
  function layoutSize(canvas: PresentableCanvas): readonly [number, number] | undefined {
    const laidOut = canvas as PresentableCanvas & {
      clientWidth?: number;
      clientHeight?: number;
      ownerDocument?: { defaultView?: { devicePixelRatio?: number } | null };
    };
    if (typeof laidOut.clientWidth !== "number" || typeof laidOut.clientHeight !== "number") return undefined;
    // §T1391b: the ratio of the window the canvas LIVES in. A floated viewer or a perform
    // window on a second screen has its own; the editor's would size it wrong on a mixed-
    // density pair (a 1× projector next to a 2× laptop panel).
    const ratio = laidOut.ownerDocument?.defaultView?.devicePixelRatio ?? globalThis.devicePixelRatio ?? 1;
    return [Math.max(1, Math.floor(laidOut.clientWidth * ratio)), Math.max(1, Math.floor(laidOut.clientHeight * ratio))];
  }

  /**
   * Sizes every live surface to its CSS box, unless a gesture is holding them.
   *
   * MUST run outside frame encoding: `surface.resize` recreates the swapchain textures
   * (§V8), which is why every caller is at a frame boundary rather than inside one.
   */
  function fitSurfacesToLayout(): void {
    if (surfaceResizeHeld) return;
    for (const p of presentations.values()) {
      // A native-model canvas is sized by its packed input extent, never by a CSS box —
      // `ensurePresentation` throws if the two disagree, and it has no layout anyway.
      if (p.disposed || p.surface === undefined || p.modelInputSize !== undefined) continue;
      // §T1391b: a source-sized surface follows its target in `ensurePresentation`.
      if (p.sizing === "source") continue;
      fitSurface(p.canvas, p.surface);
    }
    for (const h of previewHosts) {
      if (h.disposed || h.surface === undefined) continue;
      fitSurface(h.canvas, h.surface);
    }
  }

  function fitSurface(canvas: PresentableCanvas, target: Surface): void {
    const size = layoutSize(canvas);
    if (size === undefined) return;
    if (canvas.width === size[0] && canvas.height === size[1]) return;
    target.resize([size[0], size[1]]);
  }

  const status: BackendStatus = {
    get initialized() {
      return session !== undefined;
    },
    get disposed() {
      return disposed;
    },
    get halted() {
      return halted;
    },
    get deviceGeneration() {
      return deviceGeneration;
    },
    get temporalResets() {
      return temporalResets;
    },
    get resourceBuilds() {
      return resourceBuilds;
    },
    get framesSubmitted() {
      return framesSubmitted;
    },
    get framesSkipped() {
      return framesSkipped;
    },
    get readbacks() {
      return readbacks;
    },
    get stale() {
      return stale;
    },
    get estimatedResourceBytes() {
      return estimatedBytes;
    },
    get lastBuild() {
      return lastBuildStats;
    },
  };

  function requireSession(where: string): GpuSession {
    if (disposed) throw new Error(`${where} called after dispose().`);
    if (!session) throw new Error(`${where} called before initialize().`);
    return session;
  }

  function reportCapabilities(report: BackendCapabilities, droppedAsk?: string): void {
    if (!meetsBaseline(report)) {
      hub.report(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.capabilityBelowBaseline,
          `GPU reports capability tier ${report.tier}; Loom requires tier B ` +
            "(rgba16float render targets, compute, storage buffers).",
          { suggestion: "Use a desktop Chrome/Edge 128+ with hardware WebGPU." },
        ),
      );
    }
    if (!report.timestampQuery) {
      /*
       * §V12: optional, so it degrades to "no per-pass GPU timings", never to a hard
       * failure. §V469: and the message states only MEASURED facts — did we ask, was it
       * granted — because the previous copy asserted "this adapter did not offer it" and
       * was read on a Mac whose adapter offered it. The ask can also be dropped by the
       * host's fallback ladder, and when it was, `optionalFeatureError` says so by name
       * instead of leaving the absence to be blamed on the device.
       */
      const asked = report.timestampQueryRequested === true;
      hub.report(
        backendDiagnostic(
          "info",
          BackendDiagnosticCode.timestampUnavailable,
          (asked
            ? "The device request asked for timestamp-query and the device did not grant it; per-pass GPU timings are disabled."
            : "The device request did not ask for timestamp-query; per-pass GPU timings are disabled.") +
            (droppedAsk === undefined
              ? ""
              : ` The raised device request failed and its optional features were dropped: ${droppedAsk}`),
        ),
      );
    }
  }

  function watchDeviceLoss(watched: GpuSession): void {
    void watched.deviceLost.then((info) => {
      if (session !== watched || disposed) return;
      // §V23, step 1: stop submitting before anything else runs.
      halted = true;
      stopLoops();
      hub.report(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.deviceLost,
          `The GPU device was lost (${info.reason}): ${info.message}`,
          { suggestion: "Resources are being rebuilt from the current graph." },
        ),
      );
      if (recover) recovery = rebuildWithRetries().finally(() => (recovery = undefined));
    });
  }

  /** §V23 + T98: one failed re-acquire must not strand the backend halted forever. */
  async function rebuildWithRetries(): Promise<void> {
    for (let attempt = 0; attempt < maxRebuildAttempts; attempt += 1) {
      if (disposed) return;
      if (attempt > 0) await retryDelay(attempt - 1);
      await rebuild();
      if (!halted) return;
    }
    hub.report(
      backendDiagnostic(
        "error",
        BackendDiagnosticCode.submissionHalted,
        `GPU submission is halted: ${maxRebuildAttempts} rebuild attempt(s) failed.`,
        { suggestion: "Call recover() (or use the UI retry) once the GPU is available again." },
      ),
    );
  }

  function stopLoops(): void {
    for (const registration of loops) {
      registration.handle?.stop();
      registration.handle = undefined;
    }
  }

  /** Starts one registration on the live session, honoring its scheduler (T109). */
  function startLoop(registration: LoopRegistration): void {
    const gpu = session?.gpu;
    if (!gpu || registration.stopped || registration.handle) return;

    if (registration.settings.scheduler === "timer") {
      // No rAF: frames driven off an interval through the same frame path a rAF tick
      // takes. This is the worker / Node realtime loop (§V49) — frame(gpu, …) is the
      // whole mechanism, the scheduler is just who calls it.
      const fps = projectFps(registration.settings);
      const interval = setInterval(() => {
        if (halted || disposed || registration.stopped) return;
        const active = session?.gpu;
        if (!active) return;
        frame(active, (f) => runFrame(f, registration.onFrame));
      }, 1000 / fps);
      registration.handle = {
        stop() {
          clearInterval(interval);
        },
      };
      return;
    }

    // T351 (§V290): the fps cap runs HERE, not in vgpu. vgpu's gate is
    // `elapsed >= interval` with `last = timestamp` — no phase carry, no tolerance —
    // so on any display FASTER than the target the due tick often lands a fraction of
    // a millisecond early, gets skipped, and the frame runs a whole refresh late:
    // 120 Hz asking for 60 alternates 16.6/25 ms and averages 45-55 fps on EVERY
    // graph. The paced gate below runs the tick CLOSEST to the due time (half-a-tick
    // tolerance) and advances the due time by the exact interval, so the long-run
    // rate is the target by construction; a large gap (hidden tab) resyncs instead
    // of bursting to catch up.
    //
    // T933: the rate comes from `projectFps`, NEVER from the raw field. An ABSENT fps
    // used to take an unpaced branch here — so the domain read 60 (projectFps's default,
    // which the clock and the settings pane both take) while the loop ran at display
    // rate, and the two disagreed in exactly the case every shipped document is in:
    // no `fps` key at all. There is now no unpaced branch to fall into by omission; a
    // loop that genuinely wants every tick has to ask for that rate by name.
    const gate = createPacedGate();
    const source = frameSource;
    if (source !== null) {
      registration.handle = sourceLoop(source, gate, registration);
      return;
    }
    registration.handle = frameLoop(gpu, (f) => {
      // Interval read PER TICK off the registration, so a live settings.fps change
      // takes effect without a loop restart — the clock reads its rate the same way
      // (T271), and the two must not disagree.
      if (!gate.due(performance.now(), 1000 / projectFps(registration.settings))) return;
      runFrame(f, registration.onFrame);
    });
  }

  function restartLoops(): void {
    for (const registration of loops) startLoop(registration);
  }

  /** This realm's frames — vgpu's own fallback where there is no rAF (a worker, Node). */
  function realmFrames(): FrameSource {
    const realm = globalThis as { requestAnimationFrame?: (cb: (t: number) => void) => number; cancelAnimationFrame?: (id: number) => void };
    const request = realm.requestAnimationFrame;
    const cancel = realm.cancelAnimationFrame;
    if (request !== undefined && cancel !== undefined) {
      return { requestAnimationFrame: (cb) => request.call(globalThis, cb), cancelAnimationFrame: (id) => cancel.call(globalThis, id) };
    }
    return {
      requestAnimationFrame: (cb) => setTimeout(() => cb(performance.now()), 16) as unknown as number,
      cancelAnimationFrame: (id) => clearTimeout(id as unknown as ReturnType<typeof setTimeout>),
    };
  }

  /** T1409b: park one `frames` request on the current source, or this realm's frames. */
  function placeFollower(id: number, callback: (time: number) => void): void {
    const requester = frameSource === null || frameSource.closed === true ? realmFrames() : frameSource;
    const handle = requester.requestAnimationFrame((time) => {
      followers.delete(id);
      callback(time);
    });
    followers.set(id, { callback, requester, handle });
  }

  /** T1409b: every request still waiting moves to the source that now drives the frames. */
  function moveFollowers(): void {
    for (const [id, { callback, requester, handle }] of [...followers]) {
      requester.cancelAnimationFrame(handle);
      placeFollower(id, callback);
    }
  }

  /**
   * The realtime loop on ANOTHER window's frames (§T1391b, §V202). vgpu's `frameLoop`
   * captures this realm's `requestAnimationFrame`, so this is the same loop written here
   * over `frame()`: the same paced gate on this realm's clock (a child window's rAF
   * timestamps have a different origin, so they are never compared with ours), the same
   * frame path, a stop that cancels on the realm it requested from. A closed source never
   * calls back, so each tick re-checks it and falls back to this realm rather than stall.
   */
  function sourceLoop(
    source: FrameSource,
    gate: ReturnType<typeof createPacedGate>,
    registration: LoopRegistration,
  ): { stop(): void } {
    let stopped = false;
    let requester: FrameSource = source;
    let id = 0;
    const schedule = (): void => {
      requester = source.closed === true ? realmFrames() : source;
      id = requester.requestAnimationFrame(tick);
    };
    const tick = (): void => {
      if (stopped) return;
      const active = session?.gpu;
      if (active && !halted && !disposed && !registration.stopped && gate.due(performance.now(), 1000 / projectFps(registration.settings))) {
        try {
          frame(active, (f) => runFrame(f, registration.onFrame));
        } catch (error) {
          // As vgpu's own loop does: an error escaping a rAF callback has no caller and
          // no next tick; stop properly instead of leaving a loop that looks alive.
          stopped = true;
          throw error;
        }
      }
      if (!stopped) schedule();
    };
    schedule();
    return {
      stop() {
        stopped = true;
        requester.cancelAnimationFrame(id);
      },
    };
  }

  async function rebuild(): Promise<void> {
    const previous = session;
    const opts = initOptions;
    if (!opts) return;

    try {
      session = undefined;
      try {
        previous?.dispose();
      } catch {
        // A lost device may refuse teardown; the replacement matters more than the corpse.
      }

      const next = await host.create(opts);
      if (disposed) {
        next.dispose();
        return;
      }
      session = next;
      deviceGeneration += 1;
      capabilities = describeCapabilities(next.gpu, next.requestedFeatures);
      reportCapabilities(capabilities, next.optionalFeatureError);
      watchDeviceLoss(next);
      attachErrorNet(next);
      attachTimer();

      if (program) {
        // §V23: rebuilt from the retained plan, which is the compiled form of the domain graph.
        // T1523b: inside the per-pass scopes, so what the new device refuses lands on its node.
        // Read in a `finally`: a build that throws part-way still owes what its scopes caught.
        const verdicts: PassBuildVerdict[] = [];
        try {
          program.resources = buildResources(
            next.gpu,
            program.resourceDescriptors,
            program.passes,
            guard,
            emptyCarryOver,
            undefined,
            noExternalResources,
            undefined,
            verdicts,
          );
        } finally {
          void reportBuildVerdicts(
            next,
            verdicts,
            program.passes,
            "The restored device refused this pass, so it renders nothing; fix it and recompile.",
          );
        }
        program.preparations?.invalidate();
        program.preparations = createEnvironmentPreparation(next.gpu, program.passes, program.resourceDescriptors, program.resources);
        program.textureConsumers = indexBindingConsumers(program.resources.dynamicTextures);
        program.bufferConsumers = indexBindingConsumers(program.resources.dynamicBuffers);
        resourceBuilds += 1;
        // Live values, not the ones the plan was compiled with: a rebuild must not roll a
        // parameter back to whatever it was when the shader last changed.
        flushUniforms(program);
        estimatedBytes = estimatedProgramBytes(program);
        mediaExtentFailures.clear();
      }

      halted = false;
      clearTemporalHistory("device");
      // Old surfaces and the sampler died with the old device; re-establish every
      // attached presentation on the new one from its retained canvas (T87, §V23).
      presentSampler = undefined;
      for (const p of presentations.values()) {
        p.surface = undefined;
        p.blit = undefined;
        p.boundSource = undefined;
      }
      ensureAllPresentations();
      for (const h of previewHosts) {
        h.surface = undefined;
        h.set = undefined;
        h.built = undefined; // T257: never carry across a device loss — the objects died
        h.blit = undefined;
        h.externalBindings = [];
        buildPreviewHost(h);
      }
      restartLoops();
      hub.report(
        backendDiagnostic(
          "info",
          BackendDiagnosticCode.deviceRestored,
          `GPU device restored (generation ${deviceGeneration}).`,
        ),
      );
    } catch (error) {
      halted = true;
      hub.report(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.rebuildFailed,
          `Could not rebuild GPU resources after device loss: ${describeError(error)}`,
        ),
      );
    }
  }

  /** Merges values into the live set and writes the buffer. The only way uniforms move. */
  function applyUniforms(target: Program, passId: string, values: UniformValues): void {
    const block = target.resources.passUniforms.get(passId);
    if (!block) {
      // T1623b: a `write` pass has no block. Its values are rows of a region of a buffer.
      const region = regionPass(target, passId);
      if (region !== undefined) applyRegionValues(target, region, values);
      return;
    }
    const merged = { ...(target.liveUniforms.get(passId) ?? {}), ...values };
    block.set(toMutable(merged));
    target.liveUniforms.set(passId, merged);
  }

  /*
   * T1623b slice 2 — VALUES FOR A REGION OF A BUFFER (`BufferWritePassDescriptor`).
   *
   * The values live in `liveUniforms` beside every uniform block's, under the pass's own id,
   * so a device rebuild flushes them and a values-only compile rolls them back with the
   * rest. What is extra is WHEN they reach the device: not here, but once, ahead of the next
   * frame's first pass (`writeBufferRegions`), from the set below. A program that has never
   * been written, or whose buffers a boundary clear just zeroed, has no entry, which means
   * every region it has.
   */
  const regionsToWrite = new WeakMap<Program, Set<string>>();
  const regionPass = (target: Program, passId: string): BufferWritePassDescriptor | undefined => {
    const pass = target.passes.find((entry) => entry.id === passId);
    return pass?.kind === "write" ? pass : undefined;
  };
  function pendingRegions(target: Program): Set<string> {
    let pending = regionsToWrite.get(target);
    if (pending === undefined) {
      pending = new Set(target.passes.flatMap((pass) => (pass.kind === "write" ? [pass.id] : [])));
      regionsToWrite.set(target, pending);
    }
    return pending;
  }
  function applyRegionValues(target: Program, region: BufferWritePassDescriptor, values: UniformValues): void {
    const merged = { ...(target.liveUniforms.get(region.id) ?? region.values), ...values };
    // The one check the plan reader makes, made again for a value pushed on a values-only
    // frame: rows past the capacity are refused by name and the rows already there stay.
    const problem = bufferRegionProblem(region, merged);
    if (problem !== undefined) {
      hub.report(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.planInvalid,
          `Buffer values "${region.id}" for "${region.resourceId}": ${problem}. Not written; the rows already there stay.`,
          region.nodeId === undefined ? {} : { nodeId: region.nodeId as never },
        ),
      );
      return;
    }
    target.liveUniforms.set(region.id, merged);
    pendingRegions(target).add(region.id);
  }
  function writeBufferRegions(active: Program): void {
    const pending = pendingRegions(active);
    for (const passId of pending) {
      const region = regionPass(active, passId);
      const buffer = region === undefined ? undefined : active.resources.buffers.get(region.resourceId);
      const values = active.liveUniforms.get(passId) as BufferRegionValues | undefined;
      if (region === undefined || buffer === undefined || values === undefined) continue;
      // vgpu's storage buffer writes at an offset; its published interface names the data alone.
      const at = buffer as StorageBuffer & { write(data: BufferSource, offset: number): void };
      if (values.rows.length > 0) at.write(encodeBufferRows(region, values), region.offset);
      if (region.countOffset !== undefined) at.write(new Uint32Array([values.count]), region.countOffset);
    }
    pending.clear();
  }

  function flushUniforms(target: Program): void {
    for (const [passId, values] of target.liveUniforms) applyUniforms(target, passId, values);
  }

  function estimatedProgramBytes(active: Program): number {
    let bytes = estimateResourceBytes(active.resourceDescriptors);
    for (const descriptor of active.resourceDescriptors) {
      if (descriptor.kind !== "externalTexture") continue;
      const entry = active.resources.externalTextures.get(descriptor.id);
      if (entry !== undefined) bytes += (entry.size[0] * entry.size[1] - descriptor.size[0] * descriptor.size[1]) *
        bytesPerPixelFor(descriptor.format as Parameters<typeof bytesPerPixelFor>[0]);
    }
    return bytes;
  }

  function clearTemporalHistory(
    reason: "device" | "resolution" | "explicit",
    resourceIds?: readonly string[],
    options?: { buffers?: boolean; silent?: boolean },
  ): void {
    const gpu = session?.gpu;
    if (!gpu || !program) return;
    // T215: an id filter clears ONLY those pairs — the pulse-based Feedback reset
    // (§V126) and `runtime.resetFeedback` need one node's history gone, not every
    // simulation's. No filter = every pair, the device-loss/whole-project semantics.
    const activeProgram = program;
    activeProgram.preparations?.invalidate();
    const pingPongs = activeProgram.resources.pingPongs;
    const selected =
      resourceIds === undefined
        ? [...pingPongs.values()]
        : resourceIds.flatMap((id) => {
            const pair = pingPongs.get(id);
            if (pair !== undefined) return [pair];
            // T237: a ring id is a legitimate reset target too, handled below — warning
            // "no feedback pair" for one would be reporting a fault where there is none.
            if (activeProgram.resources.rings.has(id)) return [];
            hub.report(
              backendDiagnostic(
                "warning",
                BackendDiagnosticCode.unknownResource,
                `resetTemporalHistory: no feedback pair "${id}" in the current program.`,
                {
                  suggestion:
                    pingPongs.size === 0
                      ? "The program has no temporal resources."
                      : `Known pairs: ${[...pingPongs.keys()].sort().join(", ")}.`,
                },
              ),
            );
            return [];
          });
    // T237: a ring is history in exactly the sense §V22 means, so a reset clears it with
    // the pairs. Selected the same way — all of them, or the ids asked for.
    const rings = activeProgram.resources.rings;
    const selectedRings =
      resourceIds === undefined
        ? [...rings.values()]
        : resourceIds.flatMap((id) => {
            const ring = rings.get(id);
            return ring === undefined ? [] : [ring];
          });
    /* T764 (§B142) — the BOUNDARY RITE clears PLAIN TARGETS too. `recreateTargets` was
       produced at ten sites and read at zero: "a load recreates every target" was an
       unenforced property, and the carry-over diff reuses same-id same-shape textures —
       which two documents share the moment they share node names ("out" is in every
       shipped example). Ping-pongs, rings and buffers were already cleared here; a
       plain target whose first write is not a clear (an accumulating draw) was the one
       carrier left, showing the previous document's pixels. Enforced HERE, on the same
       unscoped-with-buffers signal the load path already sends, rather than as a flag
       someone must remember to read (§V205: an unread decision is worse than none).

       T773 (§B157, §V759) — EXTERNAL TEXTURES ARE CLEARED HERE TOO, and T764's stated
       exception was wrong on BOTH of its clauses. It read: "they lack render-attachment
       usage, and the media pipeline re-registers per document". (1) They HAVE
       render-attachment usage — `resources.ts` requests `texture_binding | copy_dst |
       render_attachment` because `copyExternalImageToTexture` REQUIRES it, so the very
       same raw encoder pass below clears them, no new mechanism. (2) The media pipeline
       does NOT re-register per document. `use-media-sources` keys its open effect on
       `nodeId|type|url` with no document identity, and every shipped movie example ships
       the SAME node id `clip` with `file: ""` — so loading a second movie example after
       picking a video UNREGISTERS the source and registers NOTHING, while the carry-over
       diff reuses the same-id same-size same-format external texture. Nothing then
       overwrites it (`uploadExternalTextures` skips a resource with no registered
       source), so document B's node blits document A's last decoded frame forever. That
       is §B157 verbatim: "the canvas and preview stays stale on the prior one".

       `lastFrameId` is reset with the pixels, and that pairing is load-bearing in the
       OTHER direction: where a source IS still registered across the boundary (a webcam,
       or a Text node — their key carries no url, so `nodeId|type|` is constant across
       every document naming that id and the effect never re-runs), the source's frameId
       has not advanced, so a clear alone would leave the texture permanently BLACK. Reset
       together, a still-live source re-uploads its current frame on the next tick and
       heals itself — which is why this fix needs NO document identity in the media key
       and therefore costs no webcam permission re-prompt (§V754: the existing signal
       gains a reason, it does not gain a policy). */
    const boundaryScoped = options?.buffers === true && resourceIds === undefined;
    // Provenance is invalid whenever the pixels it describes are cleared.
    if (boundaryScoped) activeProgram.textureFrames.clear();
    else for (const id of activeProgram.textureFrames.keys()) {
      if ((resourceIds === undefined || resourceIds.includes(id)) &&
          (activeProgram.resources.pingPongs.has(id) || activeProgram.resources.rings.has(id))) {
        activeProgram.textureFrames.delete(id);
      }
    }
    const boundaryTargets = boundaryScoped ? [...activeProgram.resources.targets.values()] : [];
    const boundaryLayered = boundaryScoped ? [...activeProgram.resources.layered.values()] : [];
    const boundaryExternals = boundaryScoped
      ? [...activeProgram.resources.externalTextures.values()]
      : [];
    temporalResets += 1;
    if (
      selected.length > 0 ||
      selectedRings.length > 0 ||
      boundaryTargets.length > 0 ||
      boundaryLayered.length > 0 ||
      boundaryExternals.length > 0
    ) {
      guard.assertOutsideFrame("temporal history clear");
      /* B186 — THE CLEAR COLOUR IS NAMED, and it is named because the default is not it.
         vgpu's `clear: true` uses the TARGET's own `clearColor`, which defaults to
         `[0, 0, 0, 1]` (opaque black), and nothing here ever sets one — so "cleared"
         history read back as rgb 0 with ALPHA 1 while a freshly allocated pair (which
         WebGPU zero-initialises) reads back alpha 0. Reset and first run were therefore
         DIFFERENT STATES, and the difference is exactly the channel a one-texture
         simulation has left to carry its "history exists" flag in: E2/E24's Gray-Scott
         kernel re-seeds on `alpha < 0.5`, so after any reset it stepped from U=0,V=0
         instead of seeding, U ramped to 1 through the feed term, V stayed 0 and the
         field sat on the dead fixed point — a black picture in the app, where the T552
         load rite runs, and a healthy one under `renderHeadless`, which never resets.
         §V22's "history is gone" has to mean the same thing at both entrances.

         T1261: this frame is ATOMIC — vgpu ≥ 0.4's cancel-on-throw is accepted as is. A
         clear that throws leaves every pair as it was (the caller gets the error), never
         one half cleared and the other carrying. Gate: frame-throw.gpu.test.ts. */
      frame(gpu, (f) => {
        for (const pair of selected) {
          f.pass({ target: pair.read, clear: CLEARED_HISTORY }, () => {});
          f.pass({ target: pair.write, clear: CLEARED_HISTORY }, () => {});
        }
        for (const ring of selectedRings) {
          f.pass({ target: ring.current(), clear: CLEARED_HISTORY }, () => {});
        }
      });
      /* The plain targets clear through a RAW encoder pass (loadOp clear, storeOp
         store, no draws). Measured, not assumed: the frame()-idiom empty-pass clear
         that works for ping-pong pairs (probed: a pair reads back 0 through it — in
         RGB, which is the half of that probe B186 had to finish) left a PLAIN target
         at 255 in this change's own gate — so do not unify these two paths without
         re-running reset-boundary.gpu.test.ts against the unified one. */
      if (boundaryTargets.length > 0 || boundaryLayered.length > 0 || boundaryExternals.length > 0) {
        const device = gpu.gpu as GPUDevice;
        const encoder = device.createCommandEncoder({ label: "boundary target clear" });
        const clearView = (view: GPUTextureView) => {
          const pass = encoder.beginRenderPass({
            colorAttachments: [
              { view, loadOp: "clear", storeOp: "store", clearValue: { r: 0, g: 0, b: 0, a: 0 } },
            ],
          });
          pass.end();
        };
        for (const target of boundaryTargets) {
          clearView((target as { color: { gpu: GPUTexture } }).color.gpu.createView());
        }
        // T1623b: a layered target is a plain target a layer, and carries the same way
        // (same id, same shape): every layer is cleared with them.
        for (const layers of boundaryLayered) {
          for (let index = 0; index < layers.layers; index += 1) clearView(layers.layerView(index));
        }
        // T773: same path, same measured behaviour — see the boundary comment above for
        // why an external texture can take it and why `lastFrameId` must go with it.
        for (const entry of boundaryExternals) {
          clearView(entry.texture.gpu.createView());
          entry.lastFrameId = undefined;
        }
        device.queue.submit([encoder.finish()]);
      }
      // T321: the history is an array texture now — archive the cleared frame into
      // every layer and reset the counters, outside the frame (copies self-submit).
      for (const ring of selectedRings) ring.resetHistory();
    }
    /**
     * T552/T510: the OTHER half of the audit sentence — "a SEEK zeroes frameIndex and
     * drops the point pairs together". Zero-filled is fresh-allocation state byte for
     * byte, so a cleared boundary is indistinguishable from a cold open; every shipped
     * kernel's frameIndex == 0 self-seed guard fires over exactly what it would have
     * seen at first run. Unscoped only: a per-node feedback reset names textures.
     */
    if (options?.buffers === true && resourceIds === undefined) {
      for (const pair of activeProgram.resources.bufferPairs.values()) {
        pair.read.write(new Uint8Array(pair.read.size));
        pair.write.write(new Uint8Array(pair.write.size));
      }
      // Plain storage buffers too — the lifecycle's counts and scan scratch, the
      // indirect draw args. All of them are GPU-written scratch that a cold open
      // would have zero-filled, and a spawn cursor that survives the clear makes
      // `alive` a stale number the firstRun contract just promised was fresh.
      for (const buffer of activeProgram.resources.buffers.values()) {
        buffer.write(new Uint8Array(buffer.size));
      }
      // T1623b: a region's rows were zeroed with the rest and are values, not history.
      regionsToWrite.delete(activeProgram);
      // T1353b: a FED buffer was just zeroed with the rest, and its source's frameId has
      // not moved — reset the cursor with the bytes (T773's pairing, for buffers), or a
      // mesh would stay degenerate after every seek until its file was re-picked.
      for (const cursor of activeProgram.resources.externalBuffers.values()) {
        cursor.lastFrameId = undefined;
      }
      // T510: tell the kernels — every dispatch's next frame reads firstRun = 1u.
      activeProgram.pendingBufferClear = true;
    }
    /**
     * T553, decided deliberately: the receipt goes to WHOEVER ASKED. A user-invoked
     * reset keeps its info line — they acted, the pane confirming N pairs cleared is
     * the receipt. An automatic boundary reset (document load, seek replay) passes
     * silent: the load is its own visible event, and restating it on every open is the
     * noise that teaches people to skim the one pane they currently read. The
     * temporalResets counter still ticks either way, so the audit number survives the
     * missing line.
     */
    if (options?.silent === true) return;
    hub.report(
      backendDiagnostic(
        "info",
        BackendDiagnosticCode.temporalReset,
        `Temporal history reset (${reason}); ${selected.length} feedback pair(s) cleared${
          resourceIds === undefined ? "" : ` (of ${resourceIds.length} requested)`
        }.`,
      ),
    );
  }

  /**
   * Runs a loop tick with a frame open.
   *
   * The guard covers the *whole* callback, not just encoding: a frame is open for its full
   * duration, so any allocation anywhere inside it is the §V8 violation — including one in
   * caller code that happens to run between two `render()` calls.
   */
  function reportPreparationFailure(error: unknown): void {
    hub.report(backendDiagnostic("error", BackendDiagnosticCode.frameError,
      `Environment preparation submission failed: ${describeError(error)}`));
  }

  function runFrame(f: Frame, onFrame: () => void): void {
    // T311: BEFORE the frame opens — building preview resources is an allocation, and
    // the §V8 guard rightly refuses it once `duringFrame` begins.
    retryDirtyPreviewHosts();
    // T1329b: the sizing vgpu used to do at frame advance, at the same boundary, minus the
    // part that cannot be held for the duration of a gesture.
    fitSurfacesToLayout();
    reconcileExternalTextureExtents();
    flushRings(); // T321: archive last frame's ring writes before anything binds a tap.
    if (program) prepareStepSlots(program); // T1583b: a block is a buffer; made here, not in the frame.
    const previous = currentFrame;
    currentFrame = f;
    try {
      guard.duringFrame(onFrame);
      consecutiveFrameErrors = 0;
    } catch (error) {
      // T98: a throw inside vgpu's rAF callback would otherwise explode every frame
      // with no diagnostic. Report it; a streak means something structural broke, so
      // halt instead of letting the storm continue.
      //
      // T1261: this catch is ALSO what decides the queue. vgpu ≥ 0.4 cancels a frame
      // whose callback throws and stops a `frameLoop` whose tick throws; caught here,
      // the callback returns normally and the passes encoded before the throw are
      // submitted (partial submit — consistent with the CPU-side swaps that already
      // happened, and the same state `encodeDirect` leaves). Gate: frame-throw.gpu.test.ts.
      consecutiveFrameErrors += 1;
      hub.report(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.frameError,
          `Frame callback threw: ${describeError(error)}`,
        ),
      );
      if (consecutiveFrameErrors >= MAX_CONSECUTIVE_FRAME_ERRORS && !halted) {
        halted = true;
        stopLoops();
        hub.report(
          backendDiagnostic(
            "error",
            BackendDiagnosticCode.submissionHalted,
            `GPU submission halted after ${consecutiveFrameErrors} consecutive frame errors.`,
            { suggestion: "Fix the failing pass, then call recover() to resume." },
          ),
        );
      }
    } finally {
      currentFrame = previous;
    }
    // Close this backend-owned callback at its existing submission boundary.
    try { f.submit(); program?.preparations?.submitted(f, reportPreparationFailure); }
    catch (error) { program?.preparations?.invalidate(); throw error; }
  }

  /**
   * Encodes one dispatch pass into the open frame, as a compute pass of its own.
   *
   * §T1707b: through vgpu 0.5.0 a compute had no frame-level pass, so `dispatch()` built and
   * submitted its own command buffer. Every kernel then ran before every render pass of its
   * frame, and the direct path split a render into one frame per run of render passes to
   * keep plan order. `Frame.computePass` encodes the kernel into the frame's encoder: plan
   * order on both paths, one submit, and a frame that is cancelled takes its kernels with it.
   *
   * T1247 (§V86): `timer` is the pass's GPU span, exactly as a render pass's. Without it the
   * per-pass column was render-only and the frame extent stopped at the last render pass,
   * under-reporting every points, scan/compact and audio-analysis document by exactly the
   * compute work. A pass of its own per kernel is what gives each one its own span.
   */
  function encodeDispatch(
    f: Frame,
    active: Program,
    pass: PassDescriptor & { kind: "dispatch" },
    timer: TimerSpan | undefined,
  ): void {
    // T172: indirect counts come from a GPU buffer the lifecycle wrote — the CPU never
    // knows the number, and does not need to.
    const pipeline = active.resources.computes.get(pass.id);
    if (!pipeline) return;
    let counter: StorageBuffer | undefined;
    if ("indirect" in (pass.workgroups as object)) {
      counter = active.resources.buffers.get((pass.workgroups as { indirect: string }).indirect);
      if (!counter) return;
    }
    f.computePass({ label: pass.id, ...(timer === undefined ? {} : { timer }) }, (encoder) => {
      if (counter !== undefined) {
        encoder.dispatch(pipeline, { indirect: counter });
      } else {
        const [x, y, z] = pass.workgroups as readonly [number, number, number];
        encoder.dispatch(pipeline, x, y, z);
      }
    });
  }

  /** T1583b: the plan whose timer shortfall has been reported — see `encode`. */
  let untimedSpansReportedFor: Program | undefined;

  /** T425: this frame's expanded order — declared counts overridden by the live map. */
  function expandedPasses(active: Program): ReadonlyArray<PassDescriptor> {
    if (active.encodePasses === undefined) {
      active.encodePasses = expandLoops(active.passes, (loopId, declared) => active.loopCounts.get(loopId) ?? declared);
    }
    return active.encodePasses;
  }

  function setLoopCount(active: Program, loopId: string, count: number): void {
    if (active.loopCounts.get(loopId) === count) return;
    active.loopCounts.set(loopId, count);
    active.encodePasses = undefined;
  }

  /**
   * T1583b: gives every stepped dispatch a uniform block for each run it may be asked for.
   *
   * Called at FRAME ENTRY on both paths, before anything is encoded, because a block is a
   * buffer and §V8 keeps buffers out of the frame. That one seam covers a fresh plan, a
   * values-only compile, a count pushed between direct renders and a rebuilt device. The
   * one case it cannot see is a count pushed INSIDE the frame (the animator, on the loop
   * path), which is what `prepare` is for: the compiler states how far a count that moves
   * per frame can go, and that many are made here up front. Never shrinks.
   */
  function prepareStepSlots(active: Program): void {
    if (active.stepped.size === 0 || !session) return;
    for (const [passId, stepping] of active.stepped) {
      const pipeline = active.resources.computes.get(passId);
      const own = active.resources.passUniforms.get(passId);
      if (pipeline === undefined || own === undefined || stepping.uniformBinding === undefined) continue;
      const wanted = Math.max(stepping.prepare, liveStepCount(active, stepping)) - 1;
      let slots = stepSlotsOf.get(pipeline);
      if ((slots?.blocks.length ?? 0) >= wanted) continue;
      guard.assertOutsideFrame("kernel step uniform block");
      if (slots === undefined) {
        slots = { blocks: [], bound: 0 };
        stepSlotsOf.set(pipeline, slots);
      }
      const values = toMutable(active.liveUniforms.get(passId) ?? {});
      while (slots.blocks.length < wanted) {
        const block = uniforms<Record<string, unknown>>(session.gpu, values);
        // vgpu creates a block's buffer when a pipeline first binds it, so bind it now.
        pipeline.set({ [stepping.uniformBinding]: block });
        slots.blocks.push(block);
      }
      pipeline.set({ [stepping.uniformBinding]: own });
      slots.bound = 0;
    }
  }

  /** T1583b: the dispatches a kernel region's live count asks for, inside the plan's bounds. */
  function liveStepCount(active: Program, stepping: SteppedDispatch): number {
    const live = active.loopCounts.get(stepping.loopId) ?? 1;
    return Math.min(MAX_KERNEL_STEPS, Math.max(1, Math.round(live)));
  }

  /**
   * T1583b: how one stepped dispatch divides THIS render — substeps × iterations runs.
   *
   * The live count is the region's (`expandLoops` clamps it the same way); iterations is
   * how many of those runs make one substep. A count the blocks are not ready for can only
   * arrive inside a frame, past what the plan said to prepare. It is not run short in
   * silence: the frame runs what it has blocks for, with the step it divides by matching
   * what it runs, and the shortfall is reported by name. Frame entry then makes the rest.
   */
  function resolveStepRuns(
    active: Program,
    passId: string,
    stepping: SteppedDispatch,
  ): { substeps: number; iterations: number; total: number } {
    const asked = liveStepCount(active, stepping);
    let iterations = Math.min(asked, Math.max(1, Math.round(active.loopIterations.get(stepping.loopId) ?? 1)));
    let substeps = Math.max(1, Math.floor(asked / iterations));
    const pipeline = active.resources.computes.get(passId);
    const ready =
      stepping.uniformBinding === undefined
        ? asked
        : 1 + (pipeline === undefined ? 0 : (stepSlotsOf.get(pipeline)?.blocks.length ?? 0));
    if (substeps * iterations > ready) {
      iterations = Math.min(iterations, ready);
      substeps = Math.max(1, Math.floor(ready / iterations));
      hub.report(
        backendDiagnostic(
          "warning",
          BackendDiagnosticCode.resourceLimit,
          `Node "${stepping.nodeId ?? passId}" was asked for ${asked} kernel steps inside a frame, with uniform blocks ready for ${ready}; this frame ran ${substeps * iterations}.`,
          {
            ...(stepping.nodeId === undefined ? {} : { nodeId: stepping.nodeId }),
            suggestion: "Blocks are created between frames (§V8); the next frame runs the full count.",
          },
        ),
      );
    }
    return { substeps, iterations, total: substeps * iterations };
  }

  /**
   * T1583b: readies a stepped dispatch for its next run this render; false when it has
   * none left.
   *
   * Run 0 is the dispatch exactly as an unstepped one. Before each later run the pair
   * swaps, so the run reads what the one before it wrote, and this dispatch's own two
   * bindings move with it. Before the LAST run every other binding of the pair moves too —
   * each downstream consumer's — which is what leaves consumers on the half the last run
   * wrote (assessment risk 1) without re-pointing them once per run. The pair's own swap
   * pass, after its last consumer, then hands that half to the next frame.
   */
  function beginStepRun(active: Program, passId: string, stepping: SteppedDispatch): boolean {
    let runs = active.stepRuns.get(passId);
    if (runs === undefined) {
      // Encoded outside `render()`, which is what divides a frame: one run, as unstepped.
      runs = { total: 1, done: 0 };
      active.stepRuns.set(passId, runs);
    }
    const run = runs.done;
    if (run >= runs.total) return false;
    runs.done = run + 1;
    if (run > 0) {
      active.resources.bufferPairs.get(stepping.pair)?.swap();
      rebindResource(active, stepping.pair, run === runs.total - 1 ? undefined : passId);
    }
    const pipeline = active.resources.computes.get(passId);
    const slots = pipeline === undefined ? undefined : stepSlotsOf.get(pipeline);
    if (pipeline === undefined || slots === undefined || stepping.uniformBinding === undefined) return true;
    if (slots.bound === run) return true;
    const block = run === 0 ? active.resources.passUniforms.get(passId) : slots.blocks[run - 1];
    if (block === undefined) return true;
    pipeline.set({ [stepping.uniformBinding]: block });
    slots.bound = run;
    return true;
  }

  function encode(
    f: Frame,
    active: Program,
    input: FrameEvaluationInput,
  ): void {
    const passes = expandedPasses(active);
    guard.duringFrame(() => {
      /**
       * T387: how many times each pass has already been encoded THIS call. Substeps make
       * that more than one, and vgpu refuses a duplicate timer span name inside a frame —
       * so the iterations are numbered rather than dropped, and `aggregate` sums them back
       * onto the pass. Dropping them would report a 50-substep loop as costing one substep.
       */
      const iterations = new Map<string, number>();
      // T1243: `render()` counts this frame as submit N+1 once encoding returns.
      if (gpuTimer !== undefined) timedFrames.set(f, framesSubmitted + 1);
      /*
       * T1583b (assessment risk 10): the timer holds 2048 spans per frame and vgpu throws on
       * the next one, which used to turn "more looped runs than the timer can measure" into
       * a frame that does not render. Every pass keeps ONE span, so every node keeps a row;
       * what gives way is REPEATS of looped passes, once the frame has no span left for
       * them. They still run. Their node's GPU time is then a sum over fewer runs than
       * happened, which is said by name below instead of shown as if it were whole.
       */
      let spansTaken = 0;
      let untimedRepeats = 0;
      let repeatSpans = Number.POSITIVE_INFINITY;
      if (gpuTimer !== undefined && passes.length > MAX_TIMED_SPANS_PER_FRAME) {
        const timed = new Set<string>();
        for (const pass of passes) {
          if (pass.kind === "effect" || pass.kind === "draw" || pass.kind === "dispatch") timed.add(pass.id);
        }
        repeatSpans = Math.max(0, MAX_TIMED_SPANS_PER_FRAME - timed.size);
      }
      const spanFor = (passId: string): TimerSpan | undefined => {
        if (gpuTimer === undefined) return undefined;
        const seen = iterations.get(passId) ?? 0;
        iterations.set(passId, seen + 1);
        if (spansTaken >= MAX_TIMED_SPANS_PER_FRAME || (seen > 0 && repeatSpans <= 0)) {
          untimedRepeats += 1;
          return undefined;
        }
        if (seen > 0) repeatSpans -= 1;
        spansTaken += 1;
        return gpuTimer.span(iterationSpanName(passId, seen));
      };
      /*
       * T256: the CPU span, keyed exactly like the GPU one — same `iterationSpanName`, so
       * a substepped pass sums back onto its node through the same `spanBasePassId` path
       * and the two columns can never disagree about which pass they are describing.
       *
       * Costs nothing when nobody is listening: no object, no clock reads, no wrapper.
       */
      const cpuSpans: Record<string, number> | undefined =
        cpuTimingListeners.size === 0 ? undefined : {};
      const cpuIterations = new Map<string, number>();
      /** The CPU span name of this encode of a pass, counting it. */
      const cpuSpanName = (passId: string): string => {
        const seen = cpuIterations.get(passId) ?? 0;
        cpuIterations.set(passId, seen + 1);
        return iterationSpanName(passId, seen);
      };
      const timed = (passId: string, run: () => void): void => {
        if (cpuSpans === undefined) {
          run();
          return;
        }
        const name = cpuSpanName(passId);
        const started = performance.now();
        run();
        cpuSpans[name] = performance.now() - started;
      };
      /**
       * T1604b: several draws, one device render pass. What a single draw's pass does, kept
       * exactly: the head's `clear` is the pass's; a draw whose pipeline was never built is
       * left out (and, when it is the head, takes its clear with it, as its own pass would
       * have); a skipped draw (T1598b) is left out and, as the head, still clears.
       */
      const encodeRun = (members: ReadonlyArray<DrawPassDescriptor>): void => {
        const head = members[0] as DrawPassDescriptor;
        const resolve = active.resources.renderTargets.get(head.id);
        if (!resolve) return;
        const live: Array<{ readonly id: string; readonly drawable: Draw; readonly indirect: StorageBuffer | undefined }> = [];
        for (const member of members) {
          const drawable = active.resources.draws.get(member.id);
          if (!drawable || active.skipped.has(member.id)) continue;
          live.push({
            id: member.id,
            drawable,
            indirect: typeof member.instances === "object" ? active.resources.buffers.get(member.instances.indirect) : undefined,
          });
        }
        const clear = active.resources.draws.has(head.id) && (head.clear ?? true);
        if (live.length === 0 && !clear) return;
        // One span for the run, named for its head and for how many passes share it.
        const span = spanFor(runSpanName(head.id, members.length - 1));
        const started = cpuSpans === undefined ? 0 : performance.now();
        let inDraws = 0;
        let headName: string | undefined;
        f.pass({ target: resolve(), clear, ...(span === undefined ? {} : { timer: span }) }, (encoder) => {
          for (const member of live) {
            const before = cpuSpans === undefined ? 0 : performance.now();
            encoder.draw(member.drawable, member.indirect === undefined ? undefined : { indirect: member.indirect });
            if (cpuSpans === undefined) continue;
            // The CPU half stays per draw: writing a draw is its own work inside the pass.
            const took = performance.now() - before;
            inDraws += took;
            const name = cpuSpanName(member.id);
            cpuSpans[name] = took;
            if (member.id === head.id) headName = name;
          }
        });
        if (cpuSpans === undefined) return;
        // Opening and closing the pass is the head's, as it was when the pass held it alone.
        const name = headName ?? cpuSpanName(head.id);
        cpuSpans[name] = (cpuSpans[name] ?? 0) + (performance.now() - started - inDraws);
      };
      const preparation = active.preparations?.begin(f, active.resources, active.liveUniforms, active.skipped, (pass, destination, drawable) => {
        const span = spanFor(pass.id);
        timed(pass.id, () => f.pass({ target: destination, clear: true, ...(span === undefined ? {} : { timer: span }) }, drawable));
      });
      for (let index = 0; index < passes.length; index += 1) {
        const pass = passes[index] as PassDescriptor;
        if (pass.kind === "draw" && preparation?.take(pass)) { preparation.completed(pass); continue; }
        if (pass.kind === "loop") continue; // expanded away before we get here
        if (pass.kind === "swap") {
          active.resources.pingPongs.get(pass.resourceId)?.swap();
          active.resources.bufferPairs.get(pass.resourceId)?.swap();
          // T237/§V226: a ring rotates on the same pass kind, because a swap IS a
          // rotation of a two-slot ring. One placement rule, one pass kind, one thing
          // the compiler has to get right.
          active.resources.rings.get(pass.resourceId)?.rotate();
          // T387: a swap INSIDE the frame moves the halves under every binding that reads
          // them, and the next iteration of a substep loop reads them immediately. The
          // per-frame rebind (`rebindDynamicTextures`, before encoding) cannot see that, so
          // a substepped loop without this reads its own first iteration fifty times — a
          // picture that renders perfectly and never evolves, which is exactly the §V147
          // failure this feature exists to fix. `set()` only, no allocation.
          rebindResource(active, pass.resourceId);
          continue;
        }
        if (pass.kind === "dispatch") {
          // Reserve only an input its CPU consumer can use. The decision is made while
          // encoding, rather than again after a model may have finished asynchronously.
          const demand = dispatchGates.get(pass.id);
          if (demand !== undefined) {
            // §T1707b: the passes before this one in the plan have rendered THIS frame by the
            // time the kernel runs, so their targets carry this frame's stamp here.
            stampRenderedTextures(active, passes.slice(0, index), input);
            const resourceId = pass.textures?.[0]?.resourceId;
            const source = resourceId !== undefined && active.resources.externalTextures.has(resourceId)
              ? { renderIndex: framesSubmitted + 1, frameIndex: input.frameIndex,
                  timeSeconds: absTimeSecondsOf(input) }
              : resourceId === undefined ? undefined : active.textureFrames.get(resourceId);
            if (!demand.gate(input, { renderIndex: framesSubmitted + 1, source })) continue;
          }
          if (demand !== undefined) {
            if (!active.resources.computes.has(pass.id)) {
              throw new Error(`Demanded dispatch ${pass.id} has no compute pipeline.`);
            }
            if ("indirect" in (pass.workgroups as object) &&
              !active.resources.buffers.has((pass.workgroups as { indirect: string }).indirect)) {
              throw new Error(`Demanded dispatch ${pass.id} has no indirect workgroup buffer.`);
            }
          }
          // §T1707b: encoded into this frame in plan order, so an effect→dispatch read
          // (Analyze, the TOP→POP bridge) sees the texture this frame rendered.
          //
          // T1583b: a kernel region's dispatch arrives here once per run. Each run after
          // the first swaps the pair and binds its own uniform block first.
          const stepping = active.stepped.get(pass.id);
          if (stepping !== undefined && !beginStepRun(active, pass.id, stepping)) continue;
          // T1247: the GPU span is keyed exactly like a render pass's (same `spanFor`, same
          // substep numbering), so the compute lands in the per-pass column and the extent.
          const dispatchSpan = spanFor(pass.id);
          timed(pass.id, () => encodeDispatch(f, active, pass, dispatchSpan));
          continue;
        }
        if (pass.kind === "draw") {
          /*
           * T1604b — ONE DEVICE RENDER PASS PER RUN. The draws that follow this one in its
           * run (`renderPassRuns`: the same node's, into the same target, none of them
           * clearing) are encoded inside the pass this one opens. They are found by their
           * place in the run, not by looking at the next pass's fields, so the encoder and
           * every reader of `renderPassRuns` cannot disagree about where a pass ends — and a
           * loop body's last draw never joins its own first, one iteration on.
           */
          let last = index;
          const placed = exactPassTiming ? undefined : active.runs.get(pass.id);
          if (placed !== undefined) {
            for (;;) {
              const next = passes[last + 1];
              const nextPlaced = next === undefined ? undefined : active.runs.get(next.id);
              if (nextPlaced === undefined || nextPlaced.run !== placed.run || nextPlaced.at !== placed.at + (last + 1 - index)) break;
              last += 1;
            }
          }
          if (last > index) {
            encodeRun(passes.slice(index, last + 1) as DrawPassDescriptor[]);
            index = last;
            continue;
          }
          const drawable = active.resources.draws.get(pass.id);
          const resolve = active.resources.renderTargets.get(pass.id);
          if (!drawable || !resolve) continue;
          const indirect =
            typeof pass.instances === "object"
              ? active.resources.buffers.get(pass.instances.indirect)
              : undefined;
          // T1598b: a skipped draw is provably empty, so it is not encoded. One that owns
          // its target's clear still clears, with nothing drawn.
          const skipped = active.skipped.has(pass.id);
          if (skipped && pass.clear === false) continue;
          const span = spanFor(pass.id);
          // Every draw encodes through f.pass, which is what gives it a clear knob (T180 —
          // clear:false is the trails pattern), a GPU timer span (T181 — span name = pass
          // id, like effects) and ITS PLACE IN THE FRAME.
          //
          // An INDIRECT draw (the GPU reads the counts from the args buffer) used to go
          // through `Draw.draw()`, which builds and submits its own command buffer and
          // clears its target. So a counted geometry in a Render erased the backdrop and
          // every geometry before it on the direct path, and on the loop path ran ahead of
          // the frame's own passes and was erased by them. vgpu's pass takes the same
          // `indirect` option, so it is one pass of the frame like any other draw: plan
          // order, the pass's own clear, the frame's submit. Gate: indirect-draw-order.gpu.test.ts.
          timed(pass.id, () =>
            f.pass(
              {
                target: resolve(),
                clear: pass.clear ?? true,
                ...(span === undefined ? {} : { timer: span }),
              },
              skipped ? () => {} : indirect === undefined ? drawable : (encoder) => encoder.draw(drawable, { indirect }),
            ),
          );
          preparation?.completed(pass);
          continue;
        }
        // counter is reserved for the scan/compact convenience ops; the lifecycle
        // module currently expresses those as ordinary dispatch passes.
        if (pass.kind !== "effect") continue;
        const drawable = active.resources.effects.get(pass.id);
        const resolve = active.resources.renderTargets.get(pass.id);
        if (!drawable || !resolve) continue;
        const renderTarget: Target = resolve();
        // T163: span name = PASS ID — node and component timing attribution key on it.
        // T387: plus an iteration suffix from the second substep on, because vgpu allows
        // one span per name per frame.
        const span = spanFor(pass.id);
        timed(pass.id, () =>
          f.pass(
            span === undefined
              ? { target: renderTarget, clear: pass.clear ?? true }
              : { target: renderTarget, clear: pass.clear ?? true, timer: span },
            drawable,
          ),
        );
      }

      // T1583b: once per installed plan — the condition is the plan's, and it holds every frame.
      if (untimedRepeats > 0 && untimedSpansReportedFor !== active) {
        untimedSpansReportedFor = active;
        hub.report(
          backendDiagnostic(
            "warning",
            BackendDiagnosticCode.timestampUnavailable,
            `This frame encodes ${spansTaken + untimedRepeats} timed passes and the GPU timer holds ${MAX_TIMED_SPANS_PER_FRAME} per frame; ${untimedRepeats} repeats of looped passes carry no GPU time, so the GPU time of the nodes they belong to is under-reported.`,
            { suggestion: "Lower Substeps or Iterations on the looped nodes to see their whole GPU time." },
          ),
        );
      }
      encodePresentations(f);
      // Presentations are not a plan pass and get no row; publishing after them keeps the
      // emission on the same edge as the frame rather than mid-encode.
      if (cpuSpans !== undefined) {
        for (const listener of cpuTimingListeners) listener(cpuSpans);
      }
    });
  }

  /** Records, for a demanded dispatch's gate, which render produced each target `passes` write. */
  function stampRenderedTextures(active: Program, passes: ReadonlyArray<PassDescriptor>, input: FrameEvaluationInput): void {
    if (dispatchGates.size === 0) return;
    const stamp: DispatchSourceFrame = { renderIndex: framesSubmitted + 1,
      frameIndex: input.frameIndex, timeSeconds: absTimeSecondsOf(input) };
    for (const pass of passes) {
      if (pass.kind === "effect" || pass.kind === "draw") active.textureFrames.set(pass.target, stamp);
    }
  }

  /**
   * The direct (no open frame) path: export, offline renders, a paused app. One frame,
   * the same encode the loop path runs, so both paths execute the same order (§V47).
   * Through vgpu 0.5.0 this split a render into one frame per run of render passes before
   * a kernel, because a kernel submitted on its own (§T1707b).
   */
  function encodeDirect(gpu: GpuSession["gpu"], active: Program, input: FrameEvaluationInput): void {
    const submitted = frame(gpu, (f) => {
      try {
        encode(f, active, input);
      } catch (error) {
        // T1261: PARTIAL SUBMIT, on purpose. vgpu ≥ 0.4 cancels a frame whose callback
        // throws (nothing encoded reaches the queue); 0.3.1 submitted what was there.
        // The passes before the throw stay on the queue here because the CPU-side
        // state they belong to — a pair swapped after its write, a ring rotated — is
        // not rolled back by anyone, and because the loop path (`runFrame` catches
        // inside its callback) submits exactly the same partial frame: the same failing
        // plan must leave the same state on both paths (§V47). `render()` still rethrows
        // below. Gate: frame-throw.gpu.test.ts.
        try {
          f.submit();
        } catch {
          // The encode's own error is the one the caller must see.
        }
        active.preparations?.invalidate();
        throw error;
      }
    });
    active.preparations?.submitted(submitted, reportPreparationFailure);
  }

  /**
   * Re-points the bindings of ONE resource, mid-frame, after it swapped (T387).
   *
   * The per-frame `rebindDynamicTextures` runs before encoding and is right for a plan that
   * swaps once at the end. A substep loop swaps inside the frame and reads the result on
   * the very next pass, so the halves have to move under the bindings there and then.
   * Scoped to the swapped resource because a substep loop does this on every iteration and
   * walking every binding in the plan fifty times a frame is work with no reader.
   *
   * T1583b: `onlyPassId` scopes it to ONE consumer. Between the runs of a stepped kernel
   * only the kernel itself is encoded, so only its bindings need to follow each swap; the
   * downstream consumers follow once, before the last run.
   */
  function rebindResource(active: Program, resourceId: string, onlyPassId?: string): void {
    const pair = active.resources.pingPongs.get(resourceId);
    const ring = active.resources.rings.get(resourceId);
    const bufferPair = active.resources.bufferPairs.get(resourceId);
    if (!pair && !ring && !bufferPair) return;
    const settableFor = (passId: string): { set(values: Record<string, unknown>): unknown } | undefined =>
      active.resources.effects.get(passId) ??
      active.resources.computes.get(passId) ??
      active.resources.draws.get(passId);

    const textureConsumers = active.textureConsumers.get(resourceId);
    if ((pair || ring) && textureConsumers !== undefined) {
      for (const [passId, matching] of textureConsumers) {
        if (onlyPassId !== undefined && passId !== onlyPassId) continue;
        const drawable = settableFor(passId);
        if (!drawable) continue;
        const values: Record<string, unknown> = {};
        for (const binding of matching) {
          if (pair) values[binding.binding] = pair.read.color;
          else if (ring) {
            // B160: `live` is the write target — one stable object, re-set harmlessly.
            values[binding.binding] =
              binding.live === true
                ? ring.current()
                : binding.array === true
                  ? ring.arrayView()
                  : ring.tapView(binding.tap ?? 1);
          }
        }
        drawable.set(values);
      }
    }
    const bufferConsumers = active.bufferConsumers.get(resourceId);
    if (bufferPair && bufferConsumers !== undefined) {
      for (const [passId, matching] of bufferConsumers) {
        if (onlyPassId !== undefined && passId !== onlyPassId) continue;
        const drawable = settableFor(passId);
        if (!drawable) continue;
        const values: Record<string, unknown> = {};
        for (const binding of matching) {
          const side = binding.half === "write" ? bufferPair.write : bufferPair.read;
          // T1076: a region binding is re-pointed as a region — the swap changed which
          // buffer holds this frame's bytes, never where the attribute sits inside it.
          const region = regionOf(binding);
          values[binding.binding] = region === undefined ? side : bufferRegion(side, region);
        }
        drawable.set(values);
      }
    }
  }

  /** Re-points ping-pong texture and buffer-pair bindings after swaps. `set()` only — no allocation. */
  function rebindDynamicTextures(active: Program): void {
    const settableFor = (passId: string): { set(values: Record<string, unknown>): unknown } | undefined =>
      active.resources.effects.get(passId) ??
      active.resources.computes.get(passId) ??
      active.resources.draws.get(passId);

    for (const [passId, bindings] of active.resources.dynamicTextures) {
      const drawable = settableFor(passId);
      if (!drawable) continue;
      const values: Record<string, unknown> = {};
      for (const binding of bindings) {
        const pair = active.resources.pingPongs.get(binding.resourceId);
        if (pair) values[binding.binding] = pair.read.color;
        // T237: the tap moves under the binding on every rotation, so it is re-pointed
        // here for the same reason a ping-pong read half is. `set()` allocates nothing.
        const ring = active.resources.rings.get(binding.resourceId);
        if (ring) {
          // T321: the whole-array view is ONE stable object and never needs
          // re-pointing; only fixed taps chase the head per frame. B160: `live` is the
          // write target, equally stable.
          values[binding.binding] =
            binding.live === true
              ? ring.current()
              : binding.array === true
                ? ring.arrayView()
                : ring.tapView(binding.tap ?? 1);
        }
      }
      drawable.set(values);
    }
    for (const [passId, bindings] of active.resources.dynamicBuffers) {
      const drawable = settableFor(passId);
      if (!drawable) continue;
      const values: Record<string, unknown> = {};
      for (const binding of bindings) {
        const pair = active.resources.bufferPairs.get(binding.resourceId);
        if (!pair) continue;
        const side = binding.half === "write" ? pair.write : pair.read;
        // T1076: as above — the region is a property of the plan, the half is the swap's.
        const region = regionOf(binding);
        values[binding.binding] = region === undefined ? side : bufferRegion(side, region);
      }
      drawable.set(values);
    }
  }

  /** Source storage follows decoded pixels; Common controls only the shader's output. */
  function reconcileExternalTextureExtents(): void {
    if (!session || !program) return;
    guard.assertOutsideFrame("media source texture resize");
    const active = program;
    for (const [resourceId, entry] of active.resources.externalTextures) {
      const mediaFrame = mediaSources.get(entry.sourceId)?.source.currentFrame();
      if (mediaFrame === undefined) continue;
      // Bytes have an authored extent, unlike a browser image's intrinsic pixel size.
      const descriptor = mediaFrame.bytes === undefined ? undefined
        : active.resourceDescriptors.find(resource => resource.id === resourceId && resource.kind === "externalTexture");
      const size = mediaFrame.bytes !== undefined && descriptor?.kind === "externalTexture"
        ? descriptor.size : externalImageSize(mediaFrame.image);
      if (size === undefined || (size[0] === entry.size[0] && size[1] === entry.size[1])) continue;
      const max = capabilities?.limits["maxTextureDimension2D"] ?? 0;
      if (max > 0 && (size[0] > max || size[1] > max)) {
        const rejected = `${size[0]}x${size[1]}`;
        if (mediaExtentFailures.get(resourceId) !== rejected) {
          mediaExtentFailures.set(resourceId, rejected);
          hub.report(backendDiagnostic("error", BackendDiagnosticCode.resourceLimit,
            `Media source "${entry.sourceId}" is ${rejected}, above this device's ${max}px texture limit.`,
            { suggestion: "Use a smaller source or re-export the video at a supported resolution." }));
        }
        continue;
      }
      mediaExtentFailures.delete(resourceId);
      const texture = session.gpu.device.createTexture({
        kind: "2d", size, format: entry.format as GPUTextureFormat,
        usage: ["texture_binding", "copy_dst", "render_attachment"],
        label: `${entry.sourceId} source texture`,
      });
      active.resources = {
        ...active.resources,
        externalTextures: new Map(active.resources.externalTextures).set(resourceId, { ...entry, texture, size, lastFrameId: undefined }),
      };
      for (const pass of active.passes) {
        if (pass.kind !== "effect" && pass.kind !== "draw" && pass.kind !== "dispatch") continue;
        const bindings = (pass.textures ?? []).filter(binding => binding.resourceId === resourceId);
        if (bindings.length === 0) continue;
        const drawable = active.resources.effects.get(pass.id) ?? active.resources.draws.get(pass.id) ?? active.resources.computes.get(pass.id);
        if (drawable === undefined) continue;
        drawable.set(Object.fromEntries(bindings.map(binding => [binding.binding, texture])));
      }
      active.preparations?.invalidate();
      entry.texture.destroy();
      estimatedBytes += (size[0] * size[1] - entry.size[0] * entry.size[1]) * bytesPerPixelFor(entry.format as Parameters<typeof bytesPerPixelFor>[0]);
      active.dirty = true;
    }
  }

  /**
   * Uploads new media frames into their external textures (T229, §V136).
   *
   * Per render, per texture: ask the registered source what its newest frame is; upload
   * ONLY when the frameId advanced — a 30fps video in a 60fps graph uploads 30 times.
   * `writeTexture` is a queue operation, ordered before this frame's submit, so the
   * frame samples what was just written. No source registered, or no frame yet, or the
   * source ended: the texture keeps its contents (black until the first frame).
   */
  function uploadExternalTextures(active: Program): Set<string> {
    // T253 (§V136): the CHANGED set is the return value, not a discard — the cook gate
    // (T254) reads it, so a 30fps source in a 60fps graph dirties its downstream 30
    // times, not 60. Computed here because this is the one place that knows whether an
    // upload actually happened.
    const changed = new Set<string>();
    if (!session || active.resources.externalTextures.size === 0) return changed;
    const queue = session.gpu.device.queue.gpu;
    for (const [resourceId, entry] of active.resources.externalTextures) {
      const registered = mediaSources.get(entry.sourceId);
      if (registered === undefined) continue;
      const mediaFrame = registered.source.currentFrame();
      if (mediaFrame === undefined ||
          (mediaFrame.frameId === entry.lastFrameId && registered.token === entry.lastSourceToken)) continue;
      const imageSize = mediaFrame.bytes === undefined ? externalImageSize(mediaFrame.image) : undefined;
      // A live surface can resize after the frame prelude. Wait for next frame's
      // reconciliation instead of copying a cropped subset or allocating while encoding.
      if (imageSize !== undefined && (imageSize[0] !== entry.size[0] || imageSize[1] !== entry.size[1])) continue;
      entry.lastSourceToken = registered.token;
      try {
        if (mediaFrame.bytes !== undefined) {
          const bytesPerRow = entry.size[0] * bytesPerPixelFor(entry.format as Parameters<typeof bytesPerPixelFor>[0]);
          // VNB13: `flipY` is the frame's, whichever payload carries it. The image path flips
          // on the copy; bytes are written rows reversed, from a buffer kept between frames.
          const bytes = mediaFrame.flipY === true
            ? (flipScratch = rowsReversed(mediaFrame.bytes, bytesPerRow, entry.size[1], flipScratch))
            : mediaFrame.bytes;
          queue.writeTexture(
            { texture: entry.texture.gpu },
            bytes as BufferSource,
            { bytesPerRow, rowsPerImage: entry.size[1] },
            { width: entry.size[0], height: entry.size[1] },
          );
        } else if (mediaFrame.image !== undefined && typeof queue.copyExternalImageToTexture === "function") {
          // Browser fast path: ImageBitmap / VideoFrame / canvas, no CPU readback.
          queue.copyExternalImageToTexture(
            // VNB13: a bottom-first image (a Syphon surface) is flipped on the copy itself
            { source: mediaFrame.image as GPUCopyExternalImageSource, flipY: mediaFrame.flipY === true },
            { texture: entry.texture.gpu },
            { width: entry.size[0], height: entry.size[1] },
          );
        } else {
          continue; // No payload this device can take; leave the cursor so a usable frame retries.
        }
        entry.lastFrameId = mediaFrame.frameId;
        changed.add(resourceId);
      } catch (error) {
        hub.report(
          backendDiagnostic(
            "warning",
            BackendDiagnosticCode.frameError,
            `Media upload for source "${entry.sourceId}" failed: ${describeError(error)}`,
          ),
        );
        // Advance anyway: retrying the same broken frame at 60Hz is a diagnostics flood.
        entry.lastFrameId = mediaFrame.frameId;
      }
    }
    return changed;
  }

  /**
   * T1353b — the buffer twin of `uploadExternalTextures`: the same registry, the same
   * frameId cursor (§V136), `MediaSourceFrame.bytes` written from offset 0. A payload
   * larger than the buffer, or not a whole number of 4-byte words, is refused by name
   * and not written — a truncated vertex list is a plausible wrong shape. Changed ids
   * join the media-dirty set, so the idle skip sees a mesh arrive.
   */
  function uploadExternalBuffers(active: Program, changed: Set<string>): void {
    if (active.resources.externalBuffers.size === 0) return;
    for (const [resourceId, cursor] of active.resources.externalBuffers) {
      const registered = mediaSources.get(cursor.sourceId);
      if (registered === undefined) continue;
      const frame = registered.source.currentFrame();
      if (frame === undefined || frame.bytes === undefined ||
          (frame.frameId === cursor.lastFrameId && registered.token === cursor.lastSourceToken)) continue;
      cursor.lastSourceToken = registered.token;
      cursor.lastFrameId = frame.frameId;
      const buffer = active.resources.buffers.get(resourceId);
      if (buffer === undefined) continue;
      if (frame.bytes.byteLength > buffer.size || frame.bytes.byteLength % 4 !== 0) {
        hub.report(
          backendDiagnostic(
            "warning",
            BackendDiagnosticCode.frameError,
            `Buffer source "${cursor.sourceId}" supplied ${frame.bytes.byteLength} bytes for a ${buffer.size}-byte buffer ("${resourceId}"); not written. The payload must fit and be a multiple of 4 bytes.`,
          ),
        );
        continue;
      }
      try {
        buffer.write(frame.bytes as BufferSource);
        changed.add(resourceId);
      } catch (error) {
        hub.report(
          backendDiagnostic(
            "warning",
            BackendDiagnosticCode.frameError,
            `Buffer upload for source "${cursor.sourceId}" failed: ${describeError(error)}`,
          ),
        );
      }
    }
  }

  function lookupTargets(outputId: string): ReadonlyArray<Target> {
    if (program) {
      const plain = program.resources.targets.get(outputId);
      if (plain) return [plain];
      const pair = program.resources.pingPongs.get(outputId);
      if (pair) return [pair.read, pair.write];
    }
    // T563: a SYNTHESIZED preview's target lives in a preview host's set, not the main
    // program — readback (an agent's screenshot, the inspect probe) still reaches it.
    for (const host of previewHosts) {
      const tile = host.set?.targets.get(outputId);
      if (tile) return [tile];
    }
    return [];
  }

  function presentationSource(outputId: string): Target | PingPongTargets | undefined {
    if (!program) return undefined;
    return program.resources.targets.get(outputId) ?? program.resources.pingPongs.get(outputId);
  }

  const isPair = (source: Target | PingPongTargets | StorageBuffer): source is PingPongTargets => "swap" in source;

  // T1307: sRGB storage already contains display bytes. The final blit must sample
  // those bytes without decoding them. Views share storage; no extra texture or copy.
  // Prepare both feedback halves outside frame encoding and reuse their view identities.
  const presentationViews = new WeakMap<GPUTexture, GPUTextureView>();
  const presentationBindings = new WeakMap<PresentationState, Target | GPUTextureView>();
  function preparePresentationView(target: Target): void {
    if (target.format !== "rgba8unorm-srgb") return;
    const texture = target.color.gpu;
    if (!presentationViews.has(texture)) {
      presentationViews.set(texture, target.color.createView({ format: "rgba8unorm" }));
    }
  }
  function presentationBinding(target: Target): Target | GPUTextureView {
    if (target.format !== "rgba8unorm-srgb") return target;
    const view = presentationViews.get(target.color.gpu);
    if (view === undefined) throw new Error("sRGB presentation view was not prepared before frame encoding.");
    return view;
  }

  /**
   * (Re)establishes one presentation: surface on the live device, blit effect bound to
   * the current source object. Allocates, so callers run outside any open frame (§V8).
   * A presentation with no resolvable source (nothing compiled yet, output pruned) stays
   * attached and silent until a later compile brings the output back.
   */
  function ensurePresentation(p: PresentationState): void {
    const active = session;
    if (!active || p.disposed) return;
    try {
      if (!p.surface) {
        // PresentableCanvas is the structural shape of vgpu's SurfaceCanvas; the cast
        // is what lets tests and transferred OffscreenCanvas objects through unchanged.
        // Presentation surfaces own their pane (a viewer, a perform window): opaque is
        // CORRECT here — an output should never show the page through unrendered pixels.
        // Only the preview overlay surface is transparent (V106).
        //
        // T674: `alphaMode` must be PASSED, not left to the default. This comment has
        // claimed "opaque" since T87 while vgpu defaults to `"premultiplied"`
        // (`vgpu/dist/surface.js`), so the viewer has been compositing the sink's
        // STRAIGHT alpha all along — and the catalogue's arithmetic blends carry alpha
        // per channel, so a sink alpha outside [0,1] is ordinary. E9-Ember's
        // screen-through-feedback loop drives it to ±65504 alternating every frame:
        // negative alpha clamps to 0, the pane goes fully transparent, and the owner
        // sees the picture flicker to black at 60Hz. The preview tiles never showed it
        // because every lens shader writes `a = 1.0` (`debug-effects.wgsl.ts`).
        p.surface = surface(active.gpu, p.canvas as unknown as SurfaceCanvas, {
          alphaMode: "opaque",
          // T1329b: this file sizes it (see `fitSurfacesToLayout`), so a gesture can hold it.
          autoResize: false,
          ...(p.label === undefined ? {} : { label: p.label }),
        });
        // T739: record WHICH device this canvas got configured against. A floated
        // viewer's canvas is a fresh element in another document (§V659) and the
        // question "was it configured, and against the live device" is otherwise
        // unanswerable from outside.
        p.surfaceGeneration = deviceGeneration;
      }
      if (p.modelInputSize) {
        const [width, height] = p.modelInputSize;
        const expected = nativeInputTransportSize(p.modelInputSize);
        if (p.canvas.width !== expected[0] || p.canvas.height !== expected[1])
          throw new Error("Native model canvas must match its packed input extent");
        const source = program?.resources.buffers.get(p.outputId);
        if (!source) { p.boundSource = undefined; return; }
        if (source.size !== width * height * 16) throw new Error("Native model input must be a tightly packed vec4f image");
        if (!p.blit) {
          p.blit = effect(active.gpu, preparedShader(NATIVE_INPUT_PACK_WGSL, `model-input:${p.id}`), {
            set: { modelInput: source, shape: uniforms(active.gpu, { width, height }) }, label: `model-input:${p.id}`,
          });
        } else if (p.boundSource !== source) {
          p.blit.set({ modelInput: source });
        }
        p.boundSource = source;
        return;
      }
      const source = presentationSource(p.outputId);
      if (source === undefined) {
        p.boundSource = undefined;
        presentationBindings.delete(p);
        return;
      }
      presentSampler ??= sampler(active.gpu, { magFilter: "linear", minFilter: "linear" });
      const readTarget = isPair(source) ? source.read : source;
      // §T1391b: a perform window shows its Window Out's target 1:1. Every caller of this
      // function runs outside a frame (compile, present, setOutput), which is where a
      // surface may be resized (§V8); a recompile that reallocates the target lands here.
      if (p.sizing === "source" && p.surface !== undefined && (p.canvas.width !== readTarget.size[0] || p.canvas.height !== readTarget.size[1])) {
        p.surface.resize([readTarget.size[0], readTarget.size[1]]);
      }
      preparePresentationView(readTarget);
      if (isPair(source)) preparePresentationView(source.write);
      const bindValue = presentationBinding(readTarget);
      if (!p.blit) {
        p.blit = effect(active.gpu, preparedShader(p.displayEncode ? ENCODE_BLIT_WGSL : p.alphaDisplay === "rgba" ? RGBA_BLIT_WGSL : BLIT_WGSL, `present:${p.id}`), {
          set: { blitSampler: presentSampler, blitSource: bindValue },
          label: `present:${p.id}`,
        });
        // No compileSync here: a surface target only exists inside frame(gpu)
        // (VGPU-SURFACE-NOT-IN-FRAME), so the blit pipeline compiles lazily on its
        // first encode. One-time cost on the first presented frame, not per frame.
      } else if (p.boundSource !== source || presentationBindings.get(p) !== bindValue) {
        p.blit.set({ blitSource: bindValue });
      }
      p.boundSource = source;
      presentationBindings.set(p, bindValue);
    } catch (error) {
      hub.report(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.presentFailed,
          `Could not attach presentation "${p.id}" for output "${p.outputId}": ${describeError(error)}`,
        ),
      );
    }
  }

  function ensureAllPresentations(): void {
    for (const p of presentations.values()) ensurePresentation(p);
  }

  /** Creates the pass timer on the live device, when it can exist at all (T163, §V12). */
  function attachTimer(): void {
    unsubscribeTimer?.();
    unsubscribeTimer = undefined;
    gpuTimer = undefined;
    const active = session;
    if (!active || capabilities?.timestampQuery !== true) return;
    try {
      const created = timer(active.gpu);
      gpuTimer = created;
      const offResults = created.onResults((spans, extent) => {
        // T1243: the frame figure is the extent vgpu measured from the same timestamps
        // the spans came from — never a sum of the spans (they overlap; see hub.ts
        // `frameBucket`). The submit number ties it to the render that encoded it.
        const frame: GpuFrameTiming = {
          gpuMs: extent.extentMs,
          submit: timedFrames.get(extent.frame as Frame) ?? null,
        };
        for (const listener of timingListeners) listener(spans, frame);
      });
      /*
       * T1295: the frames that will never reach `onResults`, keyed back to their submit the
       * same way. vgpu reports each once; results plus drops now account for every timed
       * frame this backend submitted, so a missing figure can say it is missing.
       */
      const offDropped = created.onDropped((drop) => {
        const report: GpuTimingDrop = {
          submit: timedFrames.get(drop.frame as Frame) ?? null,
          reason: drop.reason,
          spans: drop.spans,
        };
        for (const listener of droppedTimingListeners) listener(report);
      });
      unsubscribeTimer = () => {
        offResults();
        offDropped();
      };
    } catch (error) {
      // Absence degrades to "no GPU timings", exactly like the capability being missing.
      hub.report(
        backendDiagnostic(
          "info",
          BackendDiagnosticCode.timestampUnavailable,
          `GPU timer could not be created: ${describeError(error)}`,
        ),
      );
    }
  }

  /** The main program's resources, as binding sources for the preview program (T161). */
  function mainExternals(): ExternalResources {
    if (!program) return noExternalResources;
    return {
      targets: program.resources.targets,
      pingPongs: program.resources.pingPongs,
      samplers: program.resources.samplers,
      // T563: a preview program's synthesized draws bind the main program's point
      // storage (a splat's positions, the lifecycle's counts) as externals.
      buffers: program.resources.buffers,
      bufferPairs: program.resources.bufferPairs,
    };
  }

  /** Destroys a preview host's owned objects; the shared block is kept iff it is the main program's. */
  function releasePreviewSet(previous: ResourceSet, keepShared: boolean): void {
    releaseResourcesExcept(previous, {
      targets: new Map(),
      layered: new Map(),
      rings: new Map(),
      pingPongs: new Map(),
      samplers: new Map(),
      externalTextures: new Map(),
      buffers: new Map(),
      bufferPairs: new Map(),
      externalBuffers: new Map(),
      freshStorage: new Set(),
      effects: new Map(),
      computes: new Map(),
      draws: new Map(),
      passUniforms: new Map(),
      shared: keepShared ? previous.shared : (undefined as unknown as ResourceSet["shared"]),
      dynamicTextures: new Map(),
      dynamicBuffers: new Map(),
      renderTargets: new Map(),
    });
  }

  /** (Re)builds one preview host: surface, tile targets, preview effects, tile blit. */
  function buildPreviewHost(h: PreviewHostState): void {
    const active = session;
    if (!active || h.disposed) return;
    try {
      if (!h.surface) {
        // V106: the preview canvas composites OVER the graph DOM — it must be
        // transparent where no tile paints. BOTH options are load-bearing: vgpu's
        // clearColor defaults to opaque black, AND the canvas context defaults to
        // alphaMode "opaque" (which composites black even under a transparent clear).
        h.surface = surface(active.gpu, h.canvas as unknown as SurfaceCanvas, {
          label: "previews",
          alphaMode: "premultiplied",
          clearColor: [0, 0, 0, 0],
          // T1329b: sized by `fitSurfacesToLayout`, so a pane drag can hold it.
          autoResize: false,
        });
      }
      if (!h.program) return;

      const previous = h.set;
      const sharedFromMain = program?.resources.shared;
      // T257 (§V162): the T143 per-entry diff, applied to the preview host. Without it,
      // ANY program change rebuilt every tile from nothing — one node crossing the
      // screen edge blanked all of them. Tile targets whose structure keys survive keep
      // their objects AND their contents; effects carry when everything they bind
      // survived, counting bindings into the MAIN program as stable (a main recompile
      // re-points those separately via refreshPreviewExternals).
      const declaredIds = new Set(h.program.resources.map((resource) => resource.id));
      const externalIds = new Set<string>();
      for (const pass of h.program.passes) {
        for (const binding of pass.textures ?? []) {
          if (!declaredIds.has(binding.resourceId)) externalIds.add(binding.resourceId);
        }
      }
      const carry =
        previous !== undefined && h.built !== undefined && previous.shared === sharedFromMain
          ? computeCarryOver(
              { resourceDescriptors: h.built.resources, passes: h.built.passes, resources: previous },
              h.program.resources,
              h.program.passes,
              externalIds,
            )
          : emptyCarryOver;
      const stats: BuildStats = { resourcesCreated: 0, resourcesReused: 0, effectsBuilt: 0, effectsReused: 0 };
      // T258: TOLERANT. A preview program racing the main compile references outputs
      // the current main program does not have yet; strict building threw, the catch
      // left the stale set installed, and — because the old retry fired only before the
      // FIRST main compile — one bad binding blacked out every preview forever. Now the
      // partial set installs (good tiles keep working, the bad tile is absent), the
      // problems are reported, and `dirty` makes every subsequent main compile retry.
      const partial: { diagnostics: RuntimeDiagnostic[] } = { diagnostics: [] };
      // T1523b: inside the per-pass scopes, so a preview pass the device refuses is said on
      // its node rather than as a nodeless validation error.
      // Read in a `finally`: a build that throws part-way still owes what its scopes caught.
      const verdicts: PassBuildVerdict[] = [];
      const previewPasses = h.program.passes;
      try {
        h.set = buildResources(
          active.gpu,
          h.program.resources,
          previewPasses,
          guard,
          { ...carry, shared: sharedFromMain ?? carry.shared },
          stats,
          mainExternals(),
          partial,
          verdicts,
        );
      } finally {
        void reportBuildVerdicts(
          active,
          verdicts,
          previewPasses,
          "This preview tile renders nothing; the main output is unaffected.",
        );
      }
      h.stats = stats;
      h.dirty = partial.diagnostics.length > 0;
      for (const diagnostic of partial.diagnostics) {
        hub.report({ ...diagnostic, severity: "warning" });
      }
      h.built = { resources: h.program.resources, passes: h.program.passes };
      // Identity-based: carried objects live in BOTH sets and survive; only the
      // replaced ones are destroyed. The shared block is kept iff it is the main
      // program's (whose lifecycle owns it) or carried forward.
      if (previous) releaseResourcesExcept(previous, h.set);
      // Bindings that live in the MAIN program get re-pointed after its recompiles.
      h.externalBindings = [];
      for (const pass of h.program.passes) {
        for (const binding of pass.textures ?? []) {
          if (!h.set.targets.has(binding.resourceId) && !h.set.pingPongs.has(binding.resourceId)) {
            h.externalBindings.push({ passId: pass.id, binding: binding.binding, resourceId: binding.resourceId });
          }
        }
      }

      // The tile-composite blit. Needs some initial source; any tile target will do —
      // presentPreviews re-points it per tile before every composite pass.
      const firstTile = h.set.targets.values().next().value as Target | undefined;
      if (!h.blit && firstTile !== undefined) {
        presentSampler ??= sampler(active.gpu, { magFilter: "linear", minFilter: "linear" });
        h.blit = effect(active.gpu, preparedShader(BLIT_WGSL, "preview-composite"), {
          set: { blitSampler: presentSampler, blitSource: firstTile },
          label: "preview-composite",
        });
      }
    } catch (error) {
      // Allocation-level failure (not a binding problem — those are tolerated above).
      // The previous set keeps presenting; the next main compile retries (T258).
      h.dirty = true;
      hub.report(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.presentFailed,
          `Could not build the preview host: ${describeError(error)}`,
        ),
      );
    }
  }

  /**
   * T311 (§V209): retries dirty preview hosts at FRAME ENTRY, before the frame opens.
   *
   * The T258 retry rides the main compile path — which the recompile classifier (T308)
   * is about to make rarer, since a uniform-only edit will stop reaching
   * `backend.compile`. A recovery path must be driven by something that happens
   * UNCONDITIONALLY, or the optimisation that thins its trigger silently reopens the
   * blackout it was built to close. Frame entry is that unconditional something: as
   * long as anything renders, a dirty preview heals without waiting for a structural
   * edit. Zero steady-state cost — the set iteration only finds work while a host is
   * dirty — and a PERSISTENT failure backs off to one attempt per interval instead of
   * recompiling preview effects sixty times a second.
   */
  const PREVIEW_RETRY_INTERVAL_FRAMES = 30;
  let previewRetryCooldown = 0;

  /**
   * T321: performs pending ring rotations — copy write target → layer[head] — at
   * FRAME ENTRY, before anything binds a tap. The swap pass only MARKS during encode:
   * copying mid-encode would archive LAST frame (the writing draws submit at frame
   * end on the loop path). Frame entry is after that submit and outside any open
   * frame, the same unconditional seam T311 rides (§V209).
   */
  function flushRings(): void {
    const active = program;
    if (!active) return;
    for (const ring of active.resources.rings.values()) ring.flush();
  }

  function retryDirtyPreviewHosts(): void {
    if (previewRetryCooldown > 0) {
      previewRetryCooldown -= 1;
      return;
    }
    let stillDirty = false;
    for (const h of previewHosts) {
      if (h.disposed || !h.dirty || h.program === undefined) continue;
      buildPreviewHost(h);
      if (h.dirty) stillDirty = true;
    }
    if (stillDirty) previewRetryCooldown = PREVIEW_RETRY_INTERVAL_FRAMES;
  }

  /** After a main recompile, preview bindings into replaced main resources are re-pointed (T143 interplay). */
  function refreshPreviewExternals(): void {
    for (const h of previewHosts) {
      if (h.disposed) continue;
      if (h.set === undefined || h.dirty) {
        // Either the program arrived BEFORE the first main compile, or the last build
        // was partial — a race where the preview referenced outputs the main program
        // did not have yet (T258). A main compile just landed, so retry NOW, every
        // time, not only before the first compile: the once-only retry is exactly what
        // turned one bad binding into a permanent blackout.
        if (h.program !== undefined) buildPreviewHost(h);
        continue;
      }
      for (const external of h.externalBindings) {
        const source = presentationSource(external.resourceId);
        if (source === undefined) continue;
        h.set.effects.get(external.passId)?.set({
          [external.binding]: isPair(source) ? source.read.color : source,
        });
      }
    }
  }

  /** §V7: presenting is a blit pass encoded with the frame. No readback, ever. */
  function encodePresentations(f: Frame): void {
    for (const p of presentations.values()) {
      if (p.disposed || p.surface === undefined || p.blit === undefined || p.boundSource === undefined) continue;
      // A ping-pong source swaps identity every frame; re-point before encoding, the
      // same way rebindDynamicTextures treats plan passes.
      if (isPair(p.boundSource)) p.blit.set({ blitSource: presentationBinding(p.boundSource.read) });
      f.pass({ target: p.surface, clear: true }, p.blit);
      // T739: counted HERE, after the four guards above, so the number means "a blit was
      // actually encoded for this surface" and not "a frame happened somewhere".
      p.presentedFrames += 1;
      p.lastPresentTime = performance.now();
    }
  }

  // A name, so `compile()` can start itself over (§T1528b).
  const backend: VgpuBackend = {
    status,
    get capabilities() {
      return capabilities;
    },

    async initialize(options) {
      if (disposed) throw new Error("initialize() called after dispose().");
      if (session) return capabilities ?? describeCapabilities(session.gpu, session.requestedFeatures);

      initOptions = options;
      try {
        const created = await host.create(options);
        session = created;
        deviceGeneration += 1;
        capabilities = describeCapabilities(created.gpu, created.requestedFeatures);
        reportCapabilities(capabilities, created.optionalFeatureError);
        // §V199: compat mode is NOT a target. The point/geometry render path is
        // vertex-pulling from SoA storage, which compat's zero vertex-stage storage
        // buffers cannot express — so the refusal is LOUD at init, never a silent
        // breakage three nodes in. The named migration (same pairs, VERTEX usage,
        // instance-step layout) is a later project, not a tuning knob.
        if ((created.gpu.device as { isCompatibilityMode?: boolean }).isCompatibilityMode === true) {
          hub.report(
            backendDiagnostic(
              "error",
              BackendDiagnosticCode.capabilityBelowBaseline,
              "This adapter runs WebGPU compatibility mode (0 vertex-stage storage buffers); point and geometry rendering require core WebGPU and are disabled (§V199).",
              { suggestion: "Use a browser/device with core WebGPU. Texture nodes keep working." },
            ),
          );
        }
        watchDeviceLoss(created);
        attachErrorNet(created);
        attachTimer();
        // §V47: no surface is created here, with or without `options.canvas`. The plan
        // always renders offscreen; a canvas becomes visible only through present() (T87).
        return capabilities;
      } catch (error) {
        hub.report(
          backendDiagnostic(
            "error",
            BackendDiagnosticCode.initFailed,
            `GPU initialization failed: ${describeError(error)}`,
          ),
        );
        throw error;
      }
    },

    async compile(plan) {
      // R9: a compile racing the device-loss recovery window waits for it to settle
      // instead of throwing a misleading "called before initialize()".
      if (recovery) await recovery;
      const active = requireSession("compile()");
      guard.assertOutsideFrame("plan compile");

      const read = readExecutionPlan(plan);
      for (const diagnostic of read.diagnostics) hub.report(diagnostic);
      if (!read.ok) {
        stale = program !== undefined;
        throw new ResourceBuildError(read.diagnostics);
      }

      // §V24 (T97): device limits are enforced before anything is allocated. A 30k×30k
      // target must become a diagnostic here, not a device loss three calls later.
      const maxDimension = capabilities?.limits["maxTextureDimension2D"] ?? 0;
      if (maxDimension > 0) {
        const oversized = read.resources
          .filter(
            (resource): resource is ResourceDescriptor & { size: readonly [number, number] } =>
              resource.kind === "target" || resource.kind === "pingPong" || resource.kind === "ring" || resource.kind === "layers",
          )
          .filter((resource) => resource.size[0] > maxDimension || resource.size[1] > maxDimension);
        if (oversized.length > 0) {
          const limitDiagnostics = oversized.map((resource) =>
            backendDiagnostic(
              "error",
              BackendDiagnosticCode.resourceLimit,
              `Resource "${resource.id}" (${resource.size[0]}×${resource.size[1]}) exceeds this device's ` +
                `maxTextureDimension2D of ${maxDimension}.`,
              { suggestion: "Lower the node or project resolution below the device limit." },
            ),
          );
          for (const diagnostic of limitDiagnostics) hub.report(diagnostic);
          stale = program !== undefined;
          throw new ResourceBuildError(limitDiagnostics);
        }
      }
      // T1623b: and a layered target's layer count, before `createTexture` is asked for a
      // texture this device cannot make (which answers on the uncaptured-error path, §T1153).
      const maxLayers = capabilities?.limits["maxTextureArrayLayers"] ?? 0;
      if (maxLayers > 0) {
        const tooDeep = read.resources.flatMap((resource) => (resource.kind === "layers" && resource.layers > maxLayers ? [resource] : []));
        if (tooDeep.length > 0) {
          const limitDiagnostics = tooDeep.map((resource) =>
            backendDiagnostic(
              "error",
              BackendDiagnosticCode.resourceLimit,
              `Resource "${resource.id}" has ${resource.layers} layers, and this device's maxTextureArrayLayers is ${maxLayers}.`,
              { suggestion: "Ask for fewer layers: for a Render's shadow maps, fewer casting lights." },
            ),
          );
          for (const diagnostic of limitDiagnostics) hub.report(diagnostic);
          stale = program !== undefined;
          throw new ResourceBuildError(limitDiagnostics);
        }
      }

      const signature = planStructureSignature(read.resources, read.passes);

      if (program && program.signature === signature) {
        // Structurally identical: only uniform values can differ, so nothing is rebuilt (§V5).
        // §T1533b: all or nothing. A block's `set` can throw (a value its adopted layout
        // rejects — the signature holds uniform NAMES, not shapes — or a destroyed buffer),
        // and both conditions live inside vgpu (the layout is private, its packer is not
        // exported), so they cannot be checked up front without a second copy of vgpu's
        // packing rules. Instead every block written before the throw gets its previous
        // values back, and the previous plan keeps rendering, flagged stale (§V9).
        const written: Array<[string, UniformValues]> = [];
        try {
          for (const [passId, values] of planUniformValues(read.passes)) {
            const previous = program.liveUniforms.get(passId);
            applyUniforms(program, passId, values);
            if (previous !== undefined) written.push([passId, previous]);
          }
        } catch (error) {
          for (const [passId, previous] of written) {
            program.resources.passUniforms.get(passId)?.set(toMutable(previous));
            program.liveUniforms.set(passId, previous);
          }
          stale = true;
          hub.report(
            backendDiagnostic(
              "error",
              BackendDiagnosticCode.compileFailed,
              `Plan compile failed: ${describeError(error)}`,
            ),
          );
          throw error;
        }
        for (const pass of read.passes) {
          if (pass.kind === "loop" && pass.edge === "begin") {
            setLoopCount(program, pass.loopId, pass.count ?? 1);
            // T1583b: a kernel region's other two values move with its count.
            if (pass.steps !== undefined) program.loopIterations.set(pass.loopId, pass.steps.iterations);
            // T1585b: and a rate-driven one's rate.
            if (pass.steps?.rate !== undefined) program.loopRates.set(pass.loopId, pass.steps.rate);
          }
        }
        program.stepped = steppedDispatches(read.passes);
        // T1598b: which draws are skipped is a value too, and moves with the rest.
        program.skipped.clear();
        for (const passId of planSkippedDraws(read.passes)) program.skipped.add(passId);
        program.dirty = true; // values moved; the next frame must draw them (§V159)
        stale = false;
        return program.compiled;
      }

      // T143 (§V22): diff per-entry structure keys against the retained program and
      // carry over everything unchanged. A carried ping-pong keeps its CONTENTS, so an
      // unrelated structural edit no longer zeroes anyone's feedback history; carried
      // effects skip shader recompilation, so the edit hitch scales with the edit.
      const carry = program ? computeCarryOver(program, read.resources, read.passes) : emptyCarryOver;
      // §T1528b: the carry is only good while the device it was built on is the live one
      // and the objects it took are still the installed program's. The window below
      // waits, and while it waits a device loss can rebuild `program.resources` on a new
      // device (`rebuild()`), or another direct caller's compile can install and release
      // what this one carried (§B235). Either way, this build points at dead objects.
      const carriedFrom = program?.resources;
      const outlived = (): boolean => session !== active || program?.resources !== carriedFrom;
      const stats: BuildStats = { resourcesCreated: 0, resourcesReused: 0, effectsBuilt: 0, effectsReused: 0 };

      let resources!: ResourceSet;
      let preparations: ReturnType<typeof createEnvironmentPreparation>;
      // B9 (T217, §V9): Dawn does not throw on invalid WGSL. `compileSync()` returns; the
      // validation error surfaces ASYNCHRONOUSLY through vgpu's pipeline error scope and
      // lands on `gpu.onError` (or stderr, when nobody listens). So the try/catch below
      // only sees CPU-side failures — the device's verdict has to be collected here and
      // awaited via `settled()` BEFORE the program is installed, or a broken shader
      // replaces (and releases) the last valid program with all lights green.
      const asyncErrors: unknown[] = [];
      // T1521b: what the device said while each pass was BUILT — the shader module's own
      // error above all, which vgpu's pipeline scope does not cover.
      const verdicts: PassBuildVerdict[] = [];
      let deviceVerdicts: Awaited<ReturnType<typeof deviceVerdictDiagnostics>>;
      compileErrorWindow = true;
      const unsubscribe = active.gpu.onError((error: unknown) => {
        asyncErrors.push(error);
      });
      try {
        resources = buildResources(
          active.gpu,
          read.resources,
          read.passes,
          guard,
          carry,
          stats,
          noExternalResources,
          undefined,
          verdicts,
          warmEffects?.gpu === active.gpu ? warmEffects : undefined,
        );
        preparations = createEnvironmentPreparation(active.gpu, read.passes, read.resources, resources);
        // Twice, deliberately: the first settle drains the tracked error-scope pops, whose
        // handlers only THEN enqueue the listener delivery; the second drains those.
        await active.gpu.settled();
        await active.gpu.settled();
        // T1490b: inside the window, so the verdicts it draws out land in `asyncErrors`.
        await askPassesSharingAFailedShader(active.gpu, read.passes, resources, asyncErrors);
        // T1521b: read here, not below — asking the compiler for its reasons is a wait, and
        // everything after the window closes runs to the install without one.
        deviceVerdicts = await deviceVerdictDiagnostics(
          (active.gpu.device as { gpu?: GPUDevice }).gpu,
          asyncErrors.filter(isPipelineCompileError),
          await passBuildErrors(verdicts),
          read.passes,
        );
      } catch (caught) {
        if (resources !== undefined) releaseResourcesExcept(resources, program?.resources);
        // §T1528b: a build that failed on a device which has since been replaced says
        // nothing about this plan; it is tried again against what is installed now.
        if (outlived()) return backend.compile(plan);
        // T95 (§V9, §V27): shader and allocation failures must reach onDiagnostic — the
        // problems tab listens there, not on thrown errors. The previous program is
        // retained and keeps rendering, flagged stale. Carried objects still belong to
        // the retained program, which is why nothing is released on this path.
        stale = program !== undefined;
        // §T1706b: a pass the CPU refused is put to the device's compiler, which says where.
        const error =
          caught instanceof ResourceBuildError
            ? await refusalsOnTheDevice((active.gpu.device as { gpu?: GPUDevice }).gpu, caught, read.passes)
            : caught;
        if (error instanceof ResourceBuildError) {
          for (const diagnostic of error.diagnostics) hub.report(diagnostic);
        } else {
          hub.report(
            backendDiagnostic(
              "error",
              BackendDiagnosticCode.compileFailed,
              `Plan compile failed: ${describeError(error)}`,
            ),
          );
        }
        // T1521b: the build threw on the CPU side, so no verdict below is ever reached —
        // and whatever a pass's scope caught before that would otherwise be said nowhere.
        for (const [passId, message] of await passBuildErrors(verdicts)) {
          hub.report(passBuildNotice(passId, message, read.passes));
        }
        throw error;
      } finally {
        unsubscribe();
        compileErrorWindow = false;
      }

      // §T1528b: RESTART, not refuse. The plan is still the one the caller wants installed,
      // and nothing in it was wrong — refusing would leave the previous graph rendering,
      // flagged stale, until some unrelated edit happened to compile again. The half-built
      // set goes, except what the installed program shares with it; on a lost device that
      // is everything, and destroying a dead device's objects is a no-op. The verdicts the
      // window collected are dropped with it: they are about objects nobody will draw.
      if (outlived()) {
        releaseResourcesExcept(resources, program?.resources);
        return backend.compile(plan);
      }

      // Anything else the device reported in the window (a dropped readback, say) still
      // reaches the problems tab — it just does not veto the install.
      for (const other of asyncErrors) {
        if (isPipelineCompileError(other)) continue;
        hub.report(
          backendDiagnostic("warning", BackendDiagnosticCode.frameError, describeError(other)),
        );
      }
      const { failures: failureDiagnostics, notices } = deviceVerdicts;
      for (const notice of notices) hub.report(notice);
      if (failureDiagnostics.length > 0) {
        // §V9: the previous program stays installed and keeps rendering, flagged stale.
        // The half-built resources are released — except objects carried from (and still
        // owned by) the retained program.
        stale = program !== undefined;
        releaseResourcesExcept(resources, program?.resources);
        for (const diagnostic of failureDiagnostics) hub.report(diagnostic);
        throw new ResourceBuildError(failureDiagnostics);
      }
      const id = `plan-${planCounter + 1}`;
      const next: Program = {
        id,
        preparations,
        signature,
        resourceDescriptors: read.resources,
        passes: read.passes,
        textureFrames: new Map(),
        encodePasses: expandLoops(read.passes),
        loopCounts: new Map(
          read.passes.flatMap((pass) =>
            pass.kind === "loop" && pass.edge === "begin" ? [[pass.loopId, pass.count ?? 1] as const] : [],
          ),
        ),
        loopIterations: new Map(
          read.passes.flatMap((pass) =>
            pass.kind === "loop" && pass.steps !== undefined ? [[pass.loopId, pass.steps.iterations] as const] : [],
          ),
        ),
        loopRates: new Map(
          read.passes.flatMap((pass) =>
            pass.kind === "loop" && pass.steps?.rate !== undefined ? [[pass.loopId, pass.steps.rate] as const] : [],
          ),
        ),
        skipped: planSkippedDraws(read.passes),
        runs: new Map(renderPassRuns(read.passes, read.resources).flatMap((run) => run.passIds.map((passId, at) => [passId, { run, at }] as const))),
        stepped: steppedDispatches(read.passes),
        stepRuns: new Map(),
        compiled: { id, logical: plan },
        liveUniforms: new Map(planUniformValues(read.passes)),
        resources,
        textureConsumers: indexBindingConsumers(resources.dynamicTextures),
        bufferConsumers: indexBindingConsumers(resources.dynamicBuffers),
        everyFrame: planRequiresEveryFrame(read.passes, read.resources),
        dirty: true, // a fresh program must draw its first frame
        pendingBufferClear: false,
      };
      // Reused uniform blocks still hold pre-recompile values; the plan's values are
      // authoritative (they come from the domain graph), so sync every block.
      // §T1529b: BEFORE the install, so a throw here (a value the block's layout rejects,
      // a carried buffer someone destroyed) cannot leave a half-installed program: §V9's
      // failure path instead — the previous program stays installed, flagged stale, and
      // loses nothing. Carried blocks are shared with it and the flush may already have
      // written new values into some of them, so its own live values go back in.
      try {
        flushUniforms(next);
      } catch (error) {
        stale = program !== undefined;
        releaseResourcesExcept(resources, program?.resources);
        hub.report(
          backendDiagnostic(
            "error",
            BackendDiagnosticCode.compileFailed,
            `Plan compile failed: ${describeError(error)}`,
          ),
        );
        if (program) flushUniforms(program);
        throw error;
      }
      resourceBuilds += 1;
      planCounter += 1;
      const previous = program;
      program = next;
      if (previous) releaseResourcesExcept(previous.resources, resources);
      lastBuildStats = stats;
      stale = false;
      estimatedBytes = estimatedProgramBytes(program);
      for (const resourceId of mediaExtentFailures.keys()) {
        if (!resources.externalTextures.has(resourceId)) mediaExtentFailures.delete(resourceId);
      }
      // Rebuilt outputs replaced their objects; every attached surface rebinds (T87),
      // and preview bindings into the main program get re-pointed (T161).
      ensureAllPresentations();
      refreshPreviewExternals();
      return program.compiled;
    },

    render(compiled, frameInputs) {
      // §V23: while halted nothing reaches the queue.
      if (disposed || halted || !session || !program) return;
      // T311: the DIRECT render path (no loop, headless) is its own unconditional
      // frame entry. Loop renders arrive with a frame already open — runFrame retried
      // before opening it — so only retry here when no frame is open.
      if (currentFrame === undefined) {
        retryDirtyPreviewHosts();
        fitSurfacesToLayout(); // T1329b, same seam: outside the frame, before anything encodes.
        reconcileExternalTextureExtents();
        flushRings(); // T321: same reasoning, same seam.
        prepareStepSlots(program); // T1583b: same seam — see the function.
      }
      if (compiled.id !== program.id) {
        hub.report(
          backendDiagnostic(
            "warning",
            BackendDiagnosticCode.planNotCurrent,
            `render() was given plan "${compiled.id}" but "${program.id}" is compiled; frame skipped.`,
          ),
        );
        return;
      }

      const active = program;
      const shared = sharedUniformsFromFrame(frameInputs);
      active.resources.shared.set(shared);
      // T172 convention: a dispatch pass's uniform block receives the frame fields each
      // render, merged over its static values (seed, count) — the KernelFrame contract,
      // fed from FrameInputs and nothing else (§V44).
      //
      // WHICH numbers is `dispatchFrameUniforms`'s call to make, not this loop's (T489):
      // the pointer (T367/§V182) and the absolute clock (T461/T468) are read off the object
      // just handed to the shared block, so a kernel and a fragment shader cannot come to
      // disagree about either. Supply only fields declared in the pass's initial uniform
      // contract: vgpu 0.5 rejects unknown fields instead of silently ignoring them.
      let dispatchValues: Array<[string, UniformValues[string]]> | undefined;
      // T1583b: how each stepped kernel divides this render, decided before anything is
      // written so the blocks below and the encoder's runs come from one answer.
      active.stepRuns.clear();
      const stepsOf = new Map<string, DispatchStep>();
      /* T1585b: a region whose substeps follow the frame gets THIS frame's count here — the
         one place every host's frame passes through, with the frame's own step in hand. A
         tick that covers two project frames then runs twice the steps at the same step
         size (Notch's Update Frame Rate), and a host that never runs a per-frame compile
         still steps correctly. The count is set the way a pushed one is, so the encoder,
         the uniform blocks below and the timer all read the same number. */
      for (const stepping of active.stepped.values()) {
        const rate = active.loopRates.get(stepping.loopId);
        if (rate === undefined) continue;
        const iterations = Math.max(1, Math.round(active.loopIterations.get(stepping.loopId) ?? 1));
        setLoopCount(active, stepping.loopId, rateSubsteps(frameInputs.frame.deltaSeconds, rate) * iterations);
      }
      for (const [passId, stepping] of active.stepped) {
        const { substeps, iterations, total } = resolveStepRuns(active, passId, stepping);
        active.stepRuns.set(passId, { total, done: 0 });
        stepsOf.set(passId, { run: 0, substeps, iterations });
      }
      for (const pass of active.passes) {
        if (pass.kind === "dispatch" && pass.uniformBinding !== undefined) {
          // T510: firstRun = 1u exactly when this pass's storage was created or cleared
          // since the last submitted frame — never at a plain frameIndex wrap (a LAP
          // keeps its buffers, so a sim must survive it; §T510).
          const firstRun =
            active.pendingBufferClear ||
            (pass.buffers ?? []).some((binding) =>
              active.resources.freshStorage.has(binding.resourceId),
            );
          const declared = pass.uniforms ?? {};
          const values: Record<string, UniformValues[string]> = {};
          dispatchValues ??= Object.entries(dispatchFrameUniforms(frameInputs.frame, shared));
          for (const [name, value] of dispatchValues) {
            if (Object.hasOwn(declared, name)) values[name] = value;
          }
          if (Object.hasOwn(declared, "firstRun")) {
            values["firstRun"] = firstRun ? 1 : 0;
          }
          // T1583b: run 0 of a stepped kernel. At one step per frame this writes the
          // numbers above again — the delta over 1, the same `firstRun` — so a kernel
          // that is not stepped reads exactly what it read before steps existed.
          const steps = stepsOf.get(pass.id);
          const stepFrame = { deltaSeconds: frameInputs.frame.deltaSeconds, firstRun };
          if (steps !== undefined) {
            for (const [name, value] of Object.entries(dispatchStepUniforms(steps, stepFrame))) {
              if (Object.hasOwn(declared, name)) values[name] = value;
            }
          }
          if (Object.keys(values).length > 0) applyUniforms(active, pass.id, values);
          // T1583b: runs 1..N-1, each into its OWN block and all of them now, before any
          // dispatch is encoded (see `StepSlots`). The seed is folded per run from the
          // live one, which never holds a folded value itself: run 0 folds to identity.
          const total = active.stepRuns.get(pass.id)?.total ?? 1;
          if (steps !== undefined && total > 1) {
            const pipeline = active.resources.computes.get(pass.id);
            const blocks = pipeline === undefined ? undefined : stepSlotsOf.get(pipeline)?.blocks;
            const live = active.liveUniforms.get(pass.id) ?? {};
            const seed = typeof live["seed"] === "number" ? live["seed"] : undefined;
            for (let run = 1; run < total; run += 1) {
              const merged: Record<string, unknown> = { ...live };
              const perRun = dispatchStepUniforms({ ...steps, run }, seed === undefined ? stepFrame : { ...stepFrame, seed });
              for (const [name, value] of Object.entries(perRun)) {
                if (Object.hasOwn(declared, name)) merged[name] = value;
              }
              blocks?.[run - 1]?.set(merged);
            }
          }
        }
      }
      // T321: passes reading a ring as an ARRAY need to know where "now" is. The
      // view is one stable object; the head is a NUMBER, so it travels as uniform
      // VALUES (§V5) merged per frame exactly like the T172 frame fields.
      for (const pass of active.passes) {
        if (pass.kind === "swap" || pass.kind === "counter" || pass.kind === "loop" || pass.kind === "write") continue;
        const arrayBinding = (pass.textures ?? []).find(
          (binding) => binding.array === true && active.resources.rings.has(binding.resourceId),
        );
        if (arrayBinding === undefined) continue;
        const ring = active.resources.rings.get(arrayBinding.resourceId);
        if (ring === undefined || pass.uniformBinding === undefined) continue;
        applyUniforms(active, pass.id, {
          ringLatest: ring.latestLayer(),
          ringWritten: ring.writtenCount(),
          ringFrames: ring.frames,
        });
      }
      rebindDynamicTextures(active);
      const mediaDirty = uploadExternalTextures(active);
      uploadExternalBuffers(active, mediaDirty);
      writeBufferRegions(active);
      active.mediaDirty = mediaDirty;

      // T254 (§V157): the whole-plan idle skip — the gate the census justified. A fully
      // static plan (nothing reads the clock, nothing holds state) with nothing dirty
      // would re-encode IDENTICAL pixels; under "auto" the frame is skipped and every
      // surface keeps presenting what it has. Per-node gating measured at 0-25% on
      // animated graphs and was not worth its correctness risk; this is the 100% case.
      if (
        cookPolicy === "auto" &&
        !active.everyFrame &&
        !active.dirty &&
        active.mediaDirty.size === 0
      ) {
        framesSkipped += 1;
        return;
      }
      active.dirty = false;
      active.preparations?.beginRender();

      const open = currentFrame;
      if (open) {
        encode(open, active, frameInputs.frame);
      } else {
        try {
          encodeDirect(session.gpu, active, frameInputs.frame);
        } catch (error) {
          // Direct (non-loop) render: the caller sees the throw, the problems tab sees
          // the diagnostic. Loop renders get the same treatment inside runFrame().
          hub.report(
            backendDiagnostic(
              "error",
              BackendDiagnosticCode.frameError,
              `Frame callback threw: ${describeError(error)}`,
            ),
          );
          throw error;
        }
      }
      stampRenderedTextures(active, expandedPasses(active), frameInputs.frame);
      framesSubmitted += 1;
      // T510: the seeding frame is spent — the next dispatch of every pass reads 0u
      // until storage is created or cleared again.
      active.pendingBufferClear = false;
      active.resources.freshStorage.clear();
    },

    resize(outputId, size) {
      guard.assertOutsideFrame("target resize");
      if (program) program.dirty = true;
      const found = lookupTargets(outputId);
      if (found.length === 0) {
        hub.report(
          backendDiagnostic(
            "warning",
            BackendDiagnosticCode.unknownOutput,
            `resize() referenced unknown output "${outputId}".`,
          ),
        );
        return;
      }
      program?.preparations?.invalidate();
      for (const t of found) t.resize(size);
      program?.textureFrames.delete(outputId);
      // Alternate views belong to the old texture allocation, not the retained Target.
      // Recreate/rebind outside the frame, just as after a structural rebuild.
      ensureAllPresentations();

      // R4: the two resolution-change paths must agree. A live resize mutates GPU
      // targets, so the retained descriptors and structural signature are updated to
      // match — otherwise the next compile either rebuilds spuriously (wiping feedback
      // history, §V22) when the compiler hands back the same new size, or silently
      // reuses descriptors that lie about what is allocated when it hands back the old
      // one. A device-loss rebuild also reallocates at the post-resize sizes this way.
      if (program) {
        program.resourceDescriptors = program.resourceDescriptors.map((resource) =>
          (resource.kind === "target" || resource.kind === "pingPong") && resource.id === outputId
            ? { ...resource, size: [size[0], size[1]] as const }
            : resource,
        );
        program.signature = planStructureSignature(program.resourceDescriptors, program.passes);
        estimatedBytes = estimatedProgramBytes(program);
      }

      // A resized feedback pair carries garbage from the old resolution (§V23 resetOn).
      if (program?.resources.pingPongs.has(outputId)) clearTemporalHistory("resolution");
    },

    async readOutput(outputId, region) {
      // §V48: the only readback in the runtime, and never inside the playback loop.
      guard.assertOutsideFrame("output readback");
      if (halted) {
        throw new Error(`readOutput("${outputId}") while GPU submission is halted.`);
      }
      const found = lookupTargets(outputId);
      const first = found[0];
      if (!first) {
        const message = `readOutput() referenced unknown output "${outputId}".`;
        hub.report(backendDiagnostic("error", BackendDiagnosticCode.unknownOutput, message));
        throw new Error(message);
      }

      // §V60 (T173): the descriptor comes from the thing that owns the copy. vgpu's
      // read() UNPADS rows (its readback loop strips the 256-byte alignment), so the
      // returned rowStride is exactly width × bytesPerPixel — asserted, not assumed.
      const descriptor =
        program?.resourceDescriptors.find(
          (resource) =>
            resource.id === outputId && (resource.kind === "target" || resource.kind === "pingPong"),
        ) ??
        // T563: a synthesized preview target's descriptor lives with its preview host.
        [...previewHosts]
          .flatMap((host) => host.built?.resources ?? [])
          .find((resource) => resource.id === outputId && resource.kind === "target");
      if (descriptor === undefined || (descriptor.kind !== "target" && descriptor.kind !== "pingPong")) {
        throw new Error(`readOutput("${outputId}") has no retained descriptor to interpret the bytes.`);
      }
      const [width, height] = descriptor.size;
      const format = descriptor.format;
      const bytesPerPixel = bytesPerPixelFor(format);

      readbacks += 1;
      // vgpu returns an owned, unpadded Uint8Array after releasing its staging buffer.
      // Re-wrapping that array copies the entire frame (63 MiB at 4K rgba16float).
      const raw = await first.color.read({ mipLevel: 0, region: "all" });
      if (raw.byteLength !== width * height * bytesPerPixel) {
        throw new Error(
          `readOutput("${outputId}") returned ${raw.byteLength} bytes; expected ${width * height * bytesPerPixel} for ${width}×${height} ${format}.`,
        );
      }
      const whole = { width, height, format, rowStride: width * bytesPerPixel, bytes: raw };
      if (
        region === undefined ||
        (region.x === 0 && region.y === 0 && region.width === width && region.height === height)
      ) {
        return whole;
      }

      // Region crop. vgpu has no sub-rectangle read yet, so this still moves the whole
      // frame across the bus and crops on the CPU — the CONTRACT is region-shaped so a
      // real sub-copy is a backend optimization later, not an interface change.
      const x = Math.max(0, Math.min(region.x, width));
      const y = Math.max(0, Math.min(region.y, height));
      const cropWidth = Math.max(0, Math.min(region.width, width - x));
      const cropHeight = Math.max(0, Math.min(region.height, height - y));
      const cropped = new Uint8Array(cropWidth * cropHeight * bytesPerPixel);
      for (let row = 0; row < cropHeight; row += 1) {
        const src = (y + row) * whole.rowStride + x * bytesPerPixel;
        cropped.set(raw.subarray(src, src + cropWidth * bytesPerPixel), row * cropWidth * bytesPerPixel);
      }
      return {
        width: cropWidth,
        height: cropHeight,
        format,
        rowStride: cropWidth * bytesPerPixel,
        bytes: cropped,
      };
    },

    onDiagnostic(listener) {
      return hub.subscribe(listener);
    },

    onGpuTimings(listener) {
      timingListeners.add(listener);
      return () => {
        timingListeners.delete(listener);
      };
    },

    onGpuTimingsDropped(listener) {
      droppedTimingListeners.add(listener);
      return () => {
        droppedTimingListeners.delete(listener);
      };
    },

    onCpuTimings(listener) {
      cpuTimingListeners.add(listener);
      return () => {
        cpuTimingListeners.delete(listener);
      };
    },

    setExactPassTiming(exact) {
      if (exact === exactPassTiming) return;
      exactPassTiming = exact;
      // The same plan encoded another way: the next frame must be drawn to be measured.
      if (program) program.dirty = true;
    },

    loop(onFrame, settings = {}) {
      // R9: during the recovery window there is no session yet, but registering is
      // still valid — restartLoops() starts every registration once the device is back.
      if (disposed) throw new Error("loop() called after dispose().");
      if (!session && !recovery) throw new Error("loop() called before initialize().");
      const registration: LoopRegistration = {
        onFrame,
        settings,
        handle: undefined,
        stopped: false,
      };
      loops.add(registration);
      if (session && !halted) startLoop(registration);
      return {
        stop() {
          registration.stopped = true;
          registration.handle?.stop();
          registration.handle = undefined;
          loops.delete(registration);
        },
      };
    },

    updateUniforms(update) {
      if (program) program.dirty = true; // §V159: dirty marks are set at THE backend entry point
      // §V5: values in, values only. There is no path from here to resource construction.
      if (!program) {
        hub.report(
          backendDiagnostic(
            "warning",
            BackendDiagnosticCode.notInitialized,
            "updateUniforms() called before a plan was compiled.",
          ),
        );
        return;
      }
      /*
       * T425: a loop-begin pass carries no GPU uniform block — its one value is the
       * iteration count the encoder reads. The animator pushes it through this same
       * entry point so a driven substeps parameter animates like any uniform (§V5).
       */
      const loopBegin = program.passes.find(
        (pass) => pass.id === update.passId && pass.kind === "loop" && pass.edge === "begin",
      );
      if (loopBegin !== undefined && loopBegin.kind === "loop") {
        const requested = update.values["count"];
        if (typeof requested === "number" && Number.isFinite(requested)) {
          setLoopCount(program, loopBegin.loopId, requested);
        }
        // T1583b: a kernel region's second value — how many of those runs are one substep.
        const iterations = update.values["iterations"];
        if (loopBegin.steps !== undefined && typeof iterations === "number" && Number.isFinite(iterations)) {
          program.loopIterations.set(loopBegin.loopId, iterations);
        }
        // T1585b: a rate-driven region's rate and clamps — three more values of the region.
        // Only a region compiled WITH a rate takes them: whether a count follows the frame
        // is the node's declaration, never a value.
        const live = program.loopRates.get(loopBegin.loopId);
        if (live !== undefined) {
          const finite = (raw: unknown, fallback: number): number =>
            typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
          program.loopRates.set(loopBegin.loopId, {
            perSecond: Math.max(0, finite(update.values["rate"], live.perSecond)),
            min: finite(update.values["minSteps"], live.min),
            max: finite(update.values["maxSteps"], live.max),
          });
        }
        return;
      }
      // T1598b: a draw's skip flag — a value the encoder reads, like the count above.
      if (update.skip !== undefined) {
        if (!program.resources.draws.has(update.passId)) {
          hub.report(
            backendDiagnostic(
              "warning",
              BackendDiagnosticCode.unknownPass,
              `updateUniforms() set skip on pass "${update.passId}", which is not a draw of this plan.`,
            ),
          );
          return;
        }
        if (update.skip) program.skipped.add(update.passId);
        else program.skipped.delete(update.passId);
        // A draw with no uniform block, or an update that moves nothing else, ends here.
        if (Object.keys(update.values).length === 0) return;
      }
      if (!program.resources.passUniforms.has(update.passId) && regionPass(program, update.passId) === undefined) {
        hub.report(
          backendDiagnostic(
            "warning",
            BackendDiagnosticCode.unknownPass,
            `updateUniforms() referenced pass "${update.passId}", which has no uniform block.`,
          ),
        );
        return;
      }
      applyUniforms(program, update.passId, update.values);
    },

    resetTemporalHistory(resourceIds?: readonly string[], options?: { buffers?: boolean; silent?: boolean }) {
      if (program) program.dirty = true;
      clearTemporalHistory("explicit", resourceIds, options);
    },

    setFrameSource(source: FrameSource | null) {
      if (source === frameSource) return;
      frameSource = source;
      // Only rAF-scheduled loops move; a timer loop has no window to follow.
      stopLoops();
      if (session && !halted) restartLoops();
      moveFollowers();
    },

    frames: {
      requestAnimationFrame(callback: (time: number) => void): number {
        const id = nextFollower++;
        placeFollower(id, callback);
        return id;
      },
      cancelAnimationFrame(id: number): void {
        const pending = followers.get(id);
        if (pending === undefined) return;
        followers.delete(id);
        pending.requester.cancelAnimationFrame(pending.handle);
      },
      /** T1488b: the same test `placeFollower` makes — a closed source answers nothing. */
      get foreign(): boolean {
        return frameSource !== null && frameSource.closed !== true;
      },
    },

    present(canvas: PresentableCanvas, options: PresentationOptions): PresentationHandle {
      // §V64/§V70: the surface is handed in, never created here, and any number of
      // surfaces may present the same output. Registering mid-recovery is fine — the
      // rebuild re-establishes every retained presentation (mirrors loop(), R9).
      if (disposed) throw new Error("present() called after dispose().");
      if (!session && !recovery) throw new Error("present() called before initialize().");
      guard.assertOutsideFrame("surface attach");
      if (options.displayEncode === true && options.alphaDisplay === "rgba")
        throw new Error("present(): displayEncode and alphaDisplay \"rgba\" are exclusive.");

      presentationCounter += 1;
      const p: PresentationState = {
        id: `present-${presentationCounter}`,
        canvas,
        label: options.label,
        ...(options.modelInputSize ? { modelInputSize: options.modelInputSize } : {}),
        sizing: options.sizing ?? "layout",
        alphaDisplay: options.alphaDisplay ?? "rgb",
        displayEncode: options.displayEncode === true,
        outputId: options.outputId,
        surface: undefined,
        blit: undefined,
        boundSource: undefined,
        disposed: false,
        surfaceGeneration: undefined,
        presentedFrames: 0,
        lastPresentTime: undefined,
      };
      presentations.set(p.id, p);
      if (session) ensurePresentation(p);

      return {
        id: p.id,
        get outputId() {
          return p.outputId;
        },
        setOutput(outputId: string) {
          if (p.disposed) return;
          p.outputId = outputId;
          p.boundSource = undefined;
          if (session && currentFrame === undefined) ensurePresentation(p);
        },
        describe(): PresentationReport {
          return {
            id: p.id,
            outputId: p.outputId,
            surfaceConfigured: p.surface !== undefined,
            blitReady: p.blit !== undefined,
            sourceBound: p.boundSource !== undefined,
            presentedFrames: p.presentedFrames,
            lastPresentTime: p.lastPresentTime ?? null,
            // Only meaningful alongside a live surface; a device rebuild clears
            // `surface` and `ensureAllPresentations` re-stamps the generation.
            deviceGeneration: p.surface === undefined ? null : (p.surfaceGeneration ?? null),
          };
        },
        dispose() {
          if (p.disposed) return;
          p.disposed = true;
          try {
            p.surface?.dispose();
          } catch {
            // A lost device already tore it down.
          }
          presentations.delete(p.id);
        },
      };
    },

    previewHost(canvas: PresentableCanvas): PreviewHostHandle {
      if (disposed) throw new Error("previewHost() called after dispose().");
      if (!session && !recovery) throw new Error("previewHost() called before initialize().");
      guard.assertOutsideFrame("preview host attach");

      const h: PreviewHostState = {
        canvas,
        surface: undefined,
        program: undefined,
        set: undefined,
        built: undefined,
        stats: undefined,
        dirty: false,
        blit: undefined,
        externalBindings: [],
        disposed: false,
      };
      previewHosts.add(h);
      buildPreviewHost(h); // creates the surface now; the program arrives later

      return {
        setPreviewProgram(next: PreviewProgram) {
          if (h.disposed) return;
          // The contract says this is called only on change; the signature makes that
          // cheap to honor even when a caller is sloppy about it (§V8).
          if (h.program?.signature === next.signature) return;
          guard.assertOutsideFrame("preview program build");
          h.program = next;
          buildPreviewHost(h);
        },
        get lastBuildStats() {
          return h.stats;
        },
        presentPreviews(command: PreviewFrameCommand) {
          if (h.disposed || disposed || halted) return;
          // T1329b: this path opens its own frame below, so the surface is sized here —
          // outside it, where recreating the swapchain textures is legal (§V8).
          fitSurfacesToLayout();
          const active = session;
          const set = h.set;
          const surfaceTarget = h.surface;
          if (!active || set === undefined || surfaceTarget === undefined) return;

          // B118: lens VALUES arrive on the command, because the program's signature
          // excludes them by construction (§V5) and `updateUniforms` resolves against
          // the MAIN program only. Without this write, exposure, channel mask, tonemap,
          // checker size and signed scale were recomputed every tick and never uploaded.
          for (const update of command.uniforms ?? []) {
            const block = set.passUniforms.get(update.passId);
            if (block) block.set(toMutable(update.values));
          }

          const dpr = command.surface.dpr;
          /**
           * A tile whose rect lies wholly OFF the surface composites nowhere — and must
           * never reach `f.pass` as a viewport.
           *
           * T756 parks an interest-pinned tile at `{ x: -100000, y: -100000, w: 1, h: 1 }`
           * ("an off-surface rect so the tile composites nowhere"), and the scheduler
           * keeps a pinned tile ACTIVE, so that rect arrives here every tick. vgpu bounds
           * a viewport to ±16384: −100000 (×dpr) is outside it at every dpr, so `f.pass`
           * THREW — aborting the whole `PreviewSystem.update()` before a single preview
           * state was published. Owner's report on E14: every texture node reading NO
           * SIGNAL, no error anywhere, the graph pane finally dying into its boundary.
           * The parking rect was never wrong; honouring it as "draw nothing" is this
           * loop's job, and clipping the encoder cannot do it — a partially visible tile
           * still needs its full rect to place the picture.
           */
          const [surfaceWidth, surfaceHeight] = command.surface.size;
          const compositesNowhere = (dest: { x: number; y: number; width: number; height: number }): boolean =>
            dest.x + dest.width <= 0 ||
            dest.y + dest.height <= 0 ||
            dest.x >= surfaceWidth ||
            dest.y >= surfaceHeight;
          const clearFor = (passId: string): boolean => {
            const pass = h.program?.passes.find((entry) => entry.id === passId);
            return pass === undefined || !("clear" in pass) || pass.clear !== false;
          };
          const encodeCommand = (f: Frame): void => {
            /*
             * B234 — PASSES WHOSE SOURCE IN THE MAIN PROGRAM IS GONE ARE NOT ENCODED.
             *
             * A main recompile destroys the objects it drops, and a preview pass that
             * bound one keeps naming it: `refreshPreviewExternals` and the re-pointing
             * below can only move a binding to a source that still exists. The program
             * that stops naming it is the caller's to send, and it arrives a React commit
             * behind the install — so a tick in between encoded the pass, the device
             * refused the WHOLE submit ("Destroyed texture … used in a submit"; a watched
             * pointset's storage says the same of a buffer) and every other tile's
             * refresh went with it. Skipped, the one tile holds its last picture.
             */
            const orphaned = new Set<string>();
            for (const external of h.externalBindings) {
              if (presentationSource(external.resourceId) === undefined) orphaned.add(external.passId);
            }
            // Ping-pong-sourced bindings swap identity per frame — re-point first,
            // exactly as the main program's rebindDynamicTextures does.
            for (const [passId, bindings] of set.dynamicTextures) {
              const drawable = set.effects.get(passId) ?? set.draws.get(passId);
              if (!drawable) continue;
              const values: Record<string, unknown> = {};
              for (const binding of bindings) {
                const pair =
                  set.pingPongs.get(binding.resourceId) ??
                  program?.resources.pingPongs.get(binding.resourceId);
                if (pair) values[binding.binding] = pair.read.color;
              }
              drawable.set(values);
            }
            // T563: a synthesized draw's buffer-pair bindings chase the MAIN program's
            // swaps — re-pointed per encode exactly as the texture pairs above are.
            for (const [passId, bindings] of set.dynamicBuffers) {
              const drawable = set.draws.get(passId) ?? set.effects.get(passId);
              if (!drawable) continue;
              const values: Record<string, unknown> = {};
              for (const binding of bindings) {
                const pair =
                  set.bufferPairs.get(binding.resourceId) ??
                  program?.resources.bufferPairs.get(binding.resourceId);
                if (pair) {
                  const side = binding.half === "write" ? pair.write : pair.read;
                  // T1076: a preview's splat binds ONE region of the main program's
                  // packed point storage, chasing the same swaps.
                  const region = regionOf(binding);
                  values[binding.binding] = region === undefined ? side : bufferRegion(side, region);
                  continue;
                }
                // A plain external buffer (counts): a main recompile replaces the
                // object, so bind whatever the main program holds NOW.
                const plain =
                  set.buffers.get(binding.resourceId) ??
                  program?.resources.buffers.get(binding.resourceId);
                if (plain) values[binding.binding] = plain;
                else orphaned.add(passId); // B234: the main program no longer has it.
              }
              drawable.set(values);
            }

            // Refresh: only the tiles whose cadence says they are due (§V28, §V16).
            // A synthesized preview's draw passes appear here too (T563), ahead of
            // their lens pass — encode order IS this list's order. `clear` comes from
            // the pass descriptor: a stock scene's backdrop clears, the object drawn
            // over it must not.
            for (const passId of command.refresh) {
              if (orphaned.has(passId)) continue; // B234
              const drawable = set.effects.get(passId) ?? set.draws.get(passId);
              const resolve = set.renderTargets.get(passId);
              if (drawable && resolve) {
                f.pass({ target: resolve(), clear: clearFor(passId) }, drawable);
              }
            }

            // Composite: every active tile, due or not — a pan moves rects without
            // re-rendering pixels. GPU→GPU throughout (§V7).
            f.pass({ target: surfaceTarget, clear: true }, () => {});
            if (h.blit) {
              const [targetWidth, targetHeight] = surfaceTarget.size;
              for (const tile of command.composite) {
                const tileTarget = set.targets.get(tile.resourceId);
                if (tileTarget === undefined) continue;
                if (compositesNowhere(tile.dest)) continue;
                /*
                 * T1102 — the tile's CLIP, as a scissor per surviving piece.
                 *
                 * The viewport stays the tile's FULL destination in every pass: it is what
                 * places and scales the picture, and shrinking it to the visible piece
                 * would squash the whole image into a corner instead of showing part of
                 * it. The scissor is what withholds the pixels a node in front owns.
                 *
                 * Absent clip = paint it all (the pre-T1102 path, and what every
                 * non-overlapping node still asks for). Empty clip = fully covered,
                 * encode nothing — a distinction the requester states and this loop must
                 * not flatten.
                 */
                const viewport = {
                  x: tile.dest.x * dpr,
                  y: tile.dest.y * dpr,
                  width: Math.max(1, tile.dest.width * dpr),
                  height: Math.max(1, tile.dest.height * dpr),
                };
                h.blit.set({ blitSource: tileTarget });
                if (tile.clip === undefined) {
                  f.pass({ target: surfaceTarget, clear: false, viewport }, h.blit);
                  continue;
                }
                for (const piece of tile.clip) {
                  // vgpu THROWS on a scissor that leaves the attachment (it mirrors
                  // WebGPU's own validation), and one throw here aborts the whole preview
                  // update — B-shaped, exactly as the off-surface parking rect did. So the
                  // rect is clamped to the attachment here rather than trusted.
                  const left = Math.max(0, Math.min(targetWidth, Math.round(piece.x * dpr)));
                  const top = Math.max(0, Math.min(targetHeight, Math.round(piece.y * dpr)));
                  const right = Math.max(
                    left,
                    Math.min(targetWidth, Math.round((piece.x + piece.width) * dpr)),
                  );
                  const bottom = Math.max(
                    top,
                    Math.min(targetHeight, Math.round((piece.y + piece.height) * dpr)),
                  );
                  if (right <= left || bottom <= top) continue;
                  f.pass(
                    {
                      target: surfaceTarget,
                      clear: false,
                      viewport,
                      scissor: [left, top, right - left, bottom - top],
                    },
                    h.blit,
                  );
                }
              }
            }
          };

          const open = currentFrame;
          if (open) encodeCommand(open);
          else frame(active.gpu, encodeCommand);
        },
        dispose() {
          if (h.disposed) return;
          h.disposed = true;
          if (h.set) releasePreviewSet(h.set, h.set.shared === program?.resources.shared);
          try {
            h.surface?.dispose();
          } catch {
            // A lost device already tore it down.
          }
          previewHosts.delete(h);
        },
      };
    },

    async readBuffer(resourceId: string) {
      // §V48: readback outside the loop only, counted like every other readback.
      guard.assertOutsideFrame("buffer readback");
      if (halted) throw new Error(`readBuffer("${resourceId}") while GPU submission is halted.`);
      const plain = program?.resources.buffers.get(resourceId);
      const pair = program?.resources.bufferPairs.get(resourceId);
      const buffer = plain ?? pair?.read;
      if (buffer === undefined) {
        const message = `readBuffer() referenced unknown buffer "${resourceId}".`;
        hub.report(backendDiagnostic("error", BackendDiagnosticCode.unknownResource, message));
        throw new Error(message);
      }
      readbacks += 1;
      return buffer.read();
    },

    async warmPasses(plan) {
      // Nothing to build ahead of on no device, and nothing to diff against before the
      // first install: the plan would be held whole.
      if (plan === null || disposed || halted || !session || !program) {
        warmEffects?.clear();
        return [];
      }
      const active = session;
      const read = readExecutionPlan(plan);
      // Advisory: a warm plan that does not read is not built ahead. Its compile, if the
      // switch ever happens, is where its problems are reported.
      if (!read.ok) return warmEffects?.passIds() ?? [];
      if (warmEffects?.gpu !== active.gpu) warmEffects = createWarmEffects(active.gpu);
      const pool = warmEffects;
      const raw = (active.gpu.device as { gpu?: GPUDevice }).gpu;
      // What the switch would CARRY needs nothing built: the carry rule itself decides
      // (§V22, T143), against whichever program is installed when a build is about to run.
      // Not "the program has this pass": a consumer below the layer (E82's `dim`) keeps its
      // id and bytes but binds a different texture once the layer is on, so the switch
      // rebuilds it — and so it is held too.
      let carriedFor: Program | undefined;
      let carried: ReadonlyMap<string, unknown> = new Map();
      await pool.warm(read.passes, read.resources, {
        live: (passId) => {
          if (program !== carriedFor) {
            carriedFor = program;
            carried =
              program === undefined ? new Map() : computeCarryOver(program, read.resources, read.passes).effects;
          }
          return carried.has(passId);
        },
        blocked: () => disposed || halted || session !== active || guard.encoding,
        onBuildError: (shader, message) => rememberReason(raw, shader, message),
      });
      return pool.passIds();
    },

    async compileShader(source: string, options: { label?: string } = {}) {
      const active = requireSession("compileShader()");
      const label = options.label ?? "editor.wgsl";
      // The RAW device: vgpu's wrapper does not expose shader modules, and this is the
      // vgpu adapter, the one sanctioned place to reach through it (§V3).
      const raw = (active.gpu.device as { gpu?: GPUDevice }).gpu;
      const unvalidated = () => ({
        ok: false,
        validated: false,
        diagnostics: [
          backendDiagnostic(
            "info",
            BackendDiagnosticCode.shaderValidationUnavailable,
            "This device cannot report shader compilation info; the shader is unvalidated, not broken.",
          ),
        ],
      });
      if (raw === undefined || typeof raw.createShaderModule !== "function") return unvalidated();

      // Scope the validation error so an invalid module never surfaces as an uncaptured
      // device error at the console — the diagnostics ARE the report.
      raw.pushErrorScope?.("validation");
      const module = raw.createShaderModule({ code: source, label });
      const scopeError = (await raw.popErrorScope?.()) ?? null;
      const info = await module.getCompilationInfo?.();

      if (info === undefined) return unvalidated();

      const diagnostics = info.messages.map((message) => ({
        severity:
          message.type === "error" ? ("error" as const) : message.type === "warning" ? ("warning" as const) : ("info" as const),
        code: "wgsl/compile",
        message: message.message,
        // §V27: line and column, 1-based as WebGPU reports them, mapped to the editor.
        source: { file: label, line: message.lineNum, column: message.linePos },
      }));
      if (diagnostics.length === 0 && scopeError !== null) {
        diagnostics.push({
          severity: "error" as const,
          code: "wgsl/compile",
          message: scopeError.message,
          source: { file: label, line: 1, column: 1 },
        });
      }
      return {
        ok: diagnostics.every((diagnostic) => diagnostic.severity !== "error"),
        validated: true,
        diagnostics,
      };
    },

    async recover() {
      if (disposed) throw new Error("recover() called after dispose().");
      if (recovery) {
        await recovery;
        return;
      }
      if (!halted) return;
      // A halt from a frame-error storm still has a live session; only rebuild when the
      // device itself is gone. Either way submission resumes only on success.
      if (session) {
        consecutiveFrameErrors = 0;
        halted = false;
        restartLoops();
        return;
      }
      recovery = rebuildWithRetries().finally(() => (recovery = undefined));
      await recovery;
    },

    setSurfaceResizeHold(held: boolean) {
      if (surfaceResizeHeld === held) return;
      surfaceResizeHeld = held;
      // The release is the whole point: one resize, now, rather than the next frame's.
      // Held, there is nothing to do — the bitmap keeps its size until this runs.
      if (!held) fitSurfacesToLayout();
    },

    setCookPolicy(policy) {
      // T249 (§V157): stored now, read by encode() when T254's gating lands. Until
      // then "auto" IS "always" — which is exactly what the cook oracle pins, so the
      // gating cannot land without staying byte-identical at every frame index.
      cookPolicy = policy;
      void cookPolicy;
    },

    registerMediaSource(sourceId, source) {
      // Order-free (T229): a plan compiled before this registration starts uploading on
      // the next render; a registration with no plan yet simply waits. Frame IDs are
      // private to each producer: a replacement can restart at the previous ID.
      if (mediaSources.get(sourceId)?.source !== source) mediaSources.set(sourceId, { source, token: {} });
      return () => {
        if (mediaSources.get(sourceId)?.source === source) mediaSources.delete(sourceId);
      };
    },

    registerDispatchGate(passId, gate) {
      const registration = { gate };
      dispatchGates.set(passId, registration);
      return () => {
        if (dispatchGates.get(passId) === registration) dispatchGates.delete(passId);
      };
    },

    async whenSettled() {
      await recovery;
      await session?.gpu.settled();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopLoops();
      loops.clear();
      dispatchGates.clear();
      mediaExtentFailures.clear();
      for (const p of presentations.values()) {
        p.disposed = true;
        try {
          p.surface?.dispose();
        } catch {
          // A lost device already tore it down.
        }
      }
      presentations.clear();
      unsubscribeErrorNet?.();
      unsubscribeErrorNet = undefined;
      unsubscribeTimer?.();
      unsubscribeTimer = undefined;
      gpuTimer = undefined;
      timingListeners.clear();
      droppedTimingListeners.clear();
      cpuTimingListeners.clear();
      for (const h of previewHosts) {
        h.disposed = true;
        try {
          h.surface?.dispose();
        } catch {
          // A lost device already tore it down.
        }
      }
      previewHosts.clear();
      warmEffects?.clear();
      warmEffects = undefined;
      program = undefined;
      try {
        session?.dispose();
      } catch {
        // Disposing a lost device is allowed to fail; the handle is dropped either way.
      }
      session = undefined;
    },
  };
  return backend;
}

/**
 * Decides what the new build may carry over from the retained program (T143).
 *
 * A resource is reusable when its per-entry structure key is unchanged. An effect is
 * reusable only when its own pass key is unchanged AND its render target and every
 * bound resource are reusable — a rebuilt binding target means the effect's set bag
 * would reference a destroyed object.
 */
/** T254: does any pass read the clock or touch evolving state? Shared with the census. */
function planRequiresEveryFrame(
  passes: ReadonlyArray<PassDescriptor>,
  resources: ReadonlyArray<ResourceDescriptor>,
): boolean {
  const kinds = new Map(resources.map((resource) => [resource.id, resource.kind]));
  /**
   * T518/B: `ring` belongs here and was missing, which froze every slit-scan whose SOURCE
   * happened to be still under "auto".
   *
   * A ring is evolving state by definition — it archives a slice at every frame entry
   * (§V276), so the SAME map value names a different moment on each frame and identical
   * inputs do not produce identical output. Skipping the frame skips the archive as well,
   * so the history stops advancing and the picture freezes on whatever it held.
   *
   * It hid because the only shipped slit-scan read the clock through a Noise shader's
   * shared block, which set `everyFrame` for an unrelated reason; the moment E8's source
   * became a shape whose motion arrives as a UNIFORM WRITE, nothing in the plan itself was
   * time-dependent and the whole plan looked static. Measured on Dawn through the cook
   * oracle: 80 frames under "auto" returned frame 0's digest 80 times while "always"
   * advanced correctly — the exact policy divergence §V157's oracle exists to catch, and
   * the first time it has ever fired.
   */
  const evolving = (id: string | undefined): boolean =>
    id !== undefined &&
    (kinds.get(id) === "pingPong" ||
      kinds.get(id) === "bufferPair" ||
      kinds.get(id) === "externalTexture" ||
      kinds.get(id) === "ring");
  return passes.some((pass) => {
    if (pass.kind === "swap" || pass.kind === "counter" || pass.kind === "loop" || pass.kind === "write") return false;
    if (pass.kind === "dispatch" && pass.uniformBinding !== undefined) return true;
    if ((pass.kind === "effect" || pass.kind === "draw") && pass.sharedBinding !== undefined) return true;
    if (pass.kind === "effect" && /frameU|SharedFrame/.test(pass.shader) && pass.sharedBinding === undefined) {
      // Defensive: a shader reading the shared block through a binding the descriptor
      // forgot to declare still counts as time-dependent rather than skippable.
      return true;
    }
    const bound = [
      "target" in pass ? pass.target : undefined,
      ...(pass.textures ?? []).map((binding) => binding.resourceId),
      ...("buffers" in pass ? (pass.buffers ?? []).map((binding) => binding.resourceId) : []),
    ];
    return bound.some(evolving);
  });
}

/** What a per-entry diff needs from the previous build — the main Program or a preview set (T257). */
interface CarrySource {
  readonly resourceDescriptors: ReadonlyArray<ResourceDescriptor>;
  readonly passes: ReadonlyArray<PassDescriptor>;
  readonly resources: ResourceSet;
}

function computeCarryOver(
  previous: CarrySource,
  nextResources: ReadonlyArray<ResourceDescriptor>,
  nextPasses: ReadonlyArray<PassDescriptor>,
  /**
   * Resource ids that are STABLE ACROSS THIS REBUILD despite not being in either
   * resource list — a preview pass's bindings into the MAIN program (T257). Safe
   * because a main recompile re-points them separately (`refreshPreviewExternals`);
   * without this, no preview effect could ever carry.
   */
  stableExternalIds?: ReadonlySet<string>,
): CarryOver {
  const oldResourceKeys = new Map(
    previous.resourceDescriptors.map((resource) => [resource.id, resourceStructureKey(resource)]),
  );
  const reusable = new Set<string>();
  for (const resource of nextResources) {
    if (oldResourceKeys.get(resource.id) === resourceStructureKey(resource)) reusable.add(resource.id);
  }

  const targets = new Map<string, NonNullable<ReturnType<ResourceSet["targets"]["get"]>>>();
  const layered = new Map<string, NonNullable<ReturnType<ResourceSet["layered"]["get"]>>>();
  const rings = new Map<string, NonNullable<ReturnType<ResourceSet["rings"]["get"]>>>();
  const pingPongs = new Map<string, NonNullable<ReturnType<ResourceSet["pingPongs"]["get"]>>>();
  const samplers = new Map<string, GPUSampler>();
  const externalTextures = new Map<string, NonNullable<ReturnType<ResourceSet["externalTextures"]["get"]>>>();
  const buffers = new Map<string, NonNullable<ReturnType<ResourceSet["buffers"]["get"]>>>();
  const bufferPairs = new Map<string, NonNullable<ReturnType<ResourceSet["bufferPairs"]["get"]>>>();
  const externalBuffers = new Map<string, NonNullable<ReturnType<ResourceSet["externalBuffers"]["get"]>>>();
  for (const id of reusable) {
    const target = previous.resources.targets.get(id);
    if (target) targets.set(id, target);
    const layers = previous.resources.layered.get(id);
    if (layers) layered.set(id, layers);
    const pair = previous.resources.pingPongs.get(id);
    if (pair) pingPongs.set(id, pair);
    // T237: a carried ring keeps its history, like a carried pair keeps its feedback.
    const ring = previous.resources.rings.get(id);
    if (ring) rings.set(id, ring);
    const sampler = previous.resources.samplers.get(id);
    if (sampler) samplers.set(id, sampler);
    const external = previous.resources.externalTextures.get(id);
    if (external) externalTextures.set(id, external);
    const buffer = previous.resources.buffers.get(id);
    if (buffer) buffers.set(id, buffer);
    const bufferPair = previous.resources.bufferPairs.get(id);
    if (bufferPair) bufferPairs.set(id, bufferPair);
    const cursor = previous.resources.externalBuffers.get(id);
    if (cursor) externalBuffers.set(id, cursor);
  }

  const oldPassKeys = new Map(previous.passes.map((pass) => [pass.id, passStructureKey(pass)]));
  const effects = new Map<string, NonNullable<ReturnType<ResourceSet["effects"]["get"]>>>();
  const computes = new Map<string, NonNullable<ReturnType<ResourceSet["computes"]["get"]>>>();
  const draws = new Map<string, NonNullable<ReturnType<ResourceSet["draws"]["get"]>>>();
  const passUniforms = new Map<string, NonNullable<ReturnType<ResourceSet["passUniforms"]["get"]>>>();
  for (const pass of nextPasses) {
    if (pass.kind === "swap" || pass.kind === "counter" || pass.kind === "loop" || pass.kind === "write") continue;
    if (oldPassKeys.get(pass.id) !== passStructureKey(pass)) continue;

    const bound: string[] = [];
    if (pass.kind === "effect" || pass.kind === "draw") bound.push(pass.target);
    if (pass.kind === "effect") bound.push(...(pass.samplers ?? []).map((binding) => binding.resourceId));
    if (pass.kind === "dispatch" || pass.kind === "draw") {
      bound.push(...(pass.buffers ?? []).map((binding) => binding.resourceId));
    }
    bound.push(...(pass.textures ?? []).map((binding) => binding.resourceId));
    if (!bound.every((id) => reusable.has(id) || stableExternalIds?.has(id) === true)) continue;

    if (pass.kind === "effect") {
      const existing = previous.resources.effects.get(pass.id);
      if (!existing) continue;
      effects.set(pass.id, existing);
    } else if (pass.kind === "dispatch") {
      const existing = previous.resources.computes.get(pass.id);
      if (!existing) continue;
      computes.set(pass.id, existing);
    } else {
      const existing = previous.resources.draws.get(pass.id);
      if (!existing) continue;
      draws.set(pass.id, existing);
    }
    const block = previous.resources.passUniforms.get(pass.id);
    if (block) passUniforms.set(pass.id, block);
  }

  return {
    targets,
    layered,
    rings,
    pingPongs,
    samplers,
    externalTextures,
    buffers,
    bufferPairs,
    externalBuffers,
    effects,
    computes,
    draws,
    passUniforms,
    shared: previous.resources.shared,
  };
}

/**
 * Destroys everything in `previous` that did not survive into `next` (T143). Identity
 * comparison, not id comparison: a rebuilt resource shares its id with the object it
 * replaced, and only the replaced object may die.
 *
 * `destroy()` is duck-typed: vgpu's public `Target` / `SharedUniforms` interfaces do not
 * declare it, but the concrete implementations have it, and without it every shader edit
 * leaks the replaced objects until `gpu.dispose()` (§T49's stable-resource-count gate).
 */
/** Releases `previous`'s objects except those shared (by identity) with `next`. An
 * absent `next` releases everything — the failed-build cleanup path (B9), where the
 * half-built set shares only what it CARRIED from the retained program. */
function releaseResourcesExcept(previous: ResourceSet, next?: ResourceSet): void {
  const destroy = (value: unknown): void => {
    const candidate = value as { destroy?: () => void };
    if (typeof candidate?.destroy === "function") {
      try {
        candidate.destroy();
      } catch {
        // Already released, or a build that does not expose one.
      }
    }
  };

  for (const [id, item] of previous.computes) {
    if (next?.computes.get(id) === item) continue;
    // T1583b: a stepped kernel's per-run uniform blocks belong to its pipeline and go with it.
    for (const block of stepSlotsOf.get(item)?.blocks ?? []) destroy(block);
    stepSlotsOf.delete(item);
  }
  for (const [id, target] of previous.targets) {
    if (next?.targets.get(id) !== target) destroy(target);
  }
  // T1623b: a layered target that was not carried takes its array texture and its depth with it.
  for (const [id, layers] of previous.layered) {
    if (next?.layered.get(id) !== layers) layers.dispose();
  }
  for (const [id, pair] of previous.pingPongs) {
    if (next?.pingPongs.get(id) !== pair) {
      destroy(pair.read);
      destroy(pair.write);
    }
  }
  // T237: a ring that was not carried takes every one of its slices with it. Missing this
  // leaks `frames` full-size textures per rebuild — the one place where being N-slots-wide
  // instead of two turns a small leak into a visible one.
  for (const [id, ring] of previous.rings) {
    if (next?.rings.get(id) !== ring) {
      destroy(ring.current());
      ring.dispose();
    }
  }
  for (const [id, entry] of previous.externalTextures) {
    if (next?.externalTextures.get(id) !== entry) destroy(entry.texture);
  }
  for (const [id, buffer] of previous.buffers) {
    if (next?.buffers.get(id) !== buffer) destroy(buffer);
  }
  for (const [id, pair] of previous.bufferPairs) {
    if (next?.bufferPairs.get(id) !== pair) {
      destroy(pair.read);
      destroy(pair.write);
    }
  }
  for (const [id, block] of previous.passUniforms) {
    if (next?.passUniforms.get(id) !== block) destroy(block);
  }
  if (next?.shared !== previous.shared) destroy(previous.shared);
}

/** vgpu reports a failed pipeline build as `VGPUError` code VGPU-COMPILE-FAILED (B9). */
function isPipelineCompileError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "VGPU-COMPILE-FAILED"
  );
}

/** The label a failed pipeline was built under — its pass id (B229) — off the error's `where`. */
function failedPipelineLabel(error: unknown): string {
  const where = (error as { where?: unknown }).where;
  return typeof where === "string" ? where.replace(/\.(compileSync|compile|pipelineFor)$/, "") : "";
}

/**
 * T1490b — EVERY PASS THAT SHARES A FAILED SHADER GETS ITS OWN VERDICT (§V27).
 *
 * vgpu keeps one shader module per byte-identical source and one pipeline per module and
 * target signature. The second pass with the same broken WGSL is therefore handed the
 * first one's cache entry: the device compiles once and reports once, under whichever pass
 * compiled first, and the other node — a copy-pasted Custom WGSL — renders nothing and
 * carries no diagnostic.
 *
 * vgpu evicts a failed entry when its verdict lands, so each such pass is compiled AGAIN
 * here and the device answers under that pass's own label. One at a time, settling between:
 * two twins asked together would share an entry all over again.
 *
 * The verdict stays the device's, never an inference from equal text. A pass with the same
 * source whose own pipeline is fine (another target format, say) finds its valid entry in
 * the cache, compiles nothing and reports nothing.
 */
async function askPassesSharingAFailedShader(
  gpu: { settled(): Promise<unknown> },
  passes: readonly PassDescriptor[],
  resources: ResourceSet,
  asyncErrors: readonly unknown[],
): Promise<void> {
  // Everything that goes through vgpu's shared caches. T1705b: a dispatch too. Through
  // vgpu 0.5.0 a compute built a module and a pipeline of its own; since 0.6.0 it takes
  // both from the caches an effect uses, so a kernel pasted onto two nodes is one entry.
  const shaderOf = (pass: PassDescriptor): string | undefined =>
    pass.kind === "effect" || pass.kind === "draw" || pass.kind === "dispatch" ? pass.shader : undefined;
  const failed = new Set(asyncErrors.filter(isPipelineCompileError).map(failedPipelineLabel));
  const failedShaders = new Set(passes.filter((pass) => failed.has(pass.id)).map(shaderOf));
  for (const pass of passes) {
    const shader = shaderOf(pass);
    if (shader === undefined || !failedShaders.has(shader) || failed.has(pass.id)) continue;
    if (pass.kind === "dispatch") {
      const kernel = resources.computes.get(pass.id);
      if (kernel === undefined) continue;
      kernel.compileSync();
    } else {
      const pipeline = resources.effects.get(pass.id) ?? resources.draws.get(pass.id);
      const target = resources.renderTargets.get(pass.id);
      if (pipeline === undefined || target === undefined) continue;
      pipeline.compileSync(target());
    }
    // Twice, for the reason `compile()` gives: the pop, then the listener delivery.
    await gpu.settled();
    await gpu.settled();
  }
}

/** T1521b: the scopes' answers, by pass id — only the passes the device objected to. */
async function passBuildErrors(verdicts: readonly PassBuildVerdict[]): Promise<Map<string, string>> {
  const errors = new Map<string, string>();
  for (const verdict of verdicts) {
    // A scope that could not be read is said under its pass too, never dropped.
    const message = await verdict.error.then((error) => error?.message, describeError);
    if (message !== undefined) errors.set(verdict.passId, message);
  }
  return errors;
}

/** The node a pass belongs to, for the kinds that are built against the device. */
function builtPassNodeId(pass: PassDescriptor | undefined): string | undefined {
  return pass !== undefined && (pass.kind === "effect" || pass.kind === "draw" || pass.kind === "dispatch")
    ? pass.nodeId
    : undefined;
}

/**
 * T1521b: something the device objected to while a pass was built that is NOT the reason
 * a failure already gives. It used to reach the problems tab from the uncaptured path with
 * no node on it; the scope it was caught in says whose it is, so it keeps its row and
 * gains an owner (§V469: an error with no other home is never the one that gets dropped).
 */
function passBuildNotice(
  passId: string,
  message: string,
  passes: readonly PassDescriptor[],
): RuntimeDiagnostic {
  const nodeId = builtPassNodeId(passes.find((candidate) => candidate.id === passId));
  return backendDiagnostic(
    "error",
    BackendDiagnosticCode.frameError,
    `GPU validation error while building pass "${passId}": ${message}`,
    {
      ...(nodeId === undefined ? {} : { nodeId }),
      suggestion: "The failing pass renders nothing. Check binding counts and formats against device limits.",
    },
  );
}

/** A WGSL error as the device's compiler reports it: 1-based, in the source it was handed. */
interface WgslError {
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

/**
 * T1521b — ASK THE COMPILER WHAT IS WRONG WITH A SOURCE.
 *
 * vgpu holds a pass's real shader module and exposes neither it nor its compilation info,
 * and it keeps an invalid module cached under its source: the device raises the parse
 * error ONCE per session, for whichever pass got there first. So the question is put again,
 * to a module created only to be read — which answers for every pass holding that source,
 * on every compile, however long ago vgpu's copy was made.
 *
 * It is handed the PASS'S text, not what vgpu compiled. An effect's module is that text
 * behind vgpu's fullscreen vertex stage, which puts the author's line 6 on the device's
 * line 19; compiled alone, the positions are the ones the pass counts in — and the editor
 * too, for a node that emits its author's text as written (§V27).
 */
/**
 * §T1706b — A PASS THE CPU REFUSED IS STILL PUT TO THE DEVICE'S COMPILER.
 *
 * vgpu 0.6.0 validates a prepared shader's reflection on the CPU, harder than its own parser
 * reads it: `@align(3)` is accepted by `prepareShader` and then refused by `draw()`, so the
 * device is never asked and the row read `Draw pass "…" failed to compile: …` on the pass's
 * node, with no line. The device's compiler refuses the same source with a line, and through
 * the pass's source map that is the author's parameter, line and node (§T1535b). Its messages,
 * when it has any, replace the CPU's sentence; a refusal the compiler does not share (a
 * binding the CPU rejects) keeps it.
 */
async function refusalsOnTheDevice(
  raw: GPUDevice | undefined,
  error: ResourceBuildError,
  passes: readonly PassDescriptor[],
): Promise<ResourceBuildError> {
  if (error.refused.size === 0) return error;
  const diagnostics = [...error.diagnostics];
  for (const [passId, index] of error.refused) {
    const pass = passes.find((candidate) => candidate.id === passId);
    if (pass === undefined || !(pass.kind === "effect" || pass.kind === "draw" || pass.kind === "dispatch")) continue;
    const described = describeWgslErrors(await wgslErrorsOf(raw, pass.shader), "sourceMap" in pass ? pass.sourceMap : undefined);
    if (described === undefined) continue;
    diagnostics[index] = deviceFailureDiagnostic(passId, described.reason, passes, {
      ...(described.source === undefined ? {} : { source: described.source }),
      ...(described.nodeId === undefined ? {} : { nodeId: described.nodeId }),
    });
  }
  return new ResourceBuildError(diagnostics, error.refused);
}

async function wgslErrorsOf(raw: GPUDevice | undefined, source: string): Promise<readonly WgslError[]> {
  if (raw === undefined || typeof raw.createShaderModule !== "function") return [];
  // Scoped as `compileShader` scopes its own: this module is EXPECTED to be invalid, and
  // what is wrong with it is read off the compilation info rather than raised a second time.
  raw.pushErrorScope?.("validation");
  const module = raw.createShaderModule({ code: source });
  await raw.popErrorScope?.();
  const info = await module.getCompilationInfo?.();
  return (info?.messages ?? [])
    .filter((message) => message.type === "error")
    .map((message) => ({ line: message.lineNum, column: message.linePos, message: message.message }));
}

/**
 * T1521b — THE DEVICE'S VERDICTS ON A BUILD, EACH WITH ITS REASON AND ITS NODE (§V27).
 *
 * A failed pipeline says "[Invalid ShaderModule] is invalid due to a previous error". The
 * reason a node's badge owes its author is the previous error, so each failure is given, in
 * order of preference: the compiler's own messages for the pass's WGSL, with line and
 * column; what the device raised while the pass was built (a layout over a device limit is
 * not a WGSL error, and is just as much the reason); and only then the pipeline's sentence.
 *
 * `notices` is every build error a failure does NOT already state. One that the failure
 * repeats — the same text, or the compiler message inside the device's longer one — would
 * be the old nodeless duplicate with a node on it; anything else is a different error and
 * is reported in its own right.
 *
 * T1522b — A DISPATCH FAILS HERE TOO. vgpu gives a compute pipeline no error scope and no
 * error sink, so nothing in `pipelineFailures` ever names one: a kernel the device refused
 * compiled "successfully", was installed over the last good program (§V9) and failed on
 * every frame after that, nodelessly. The scope the pass was built in is the only verdict
 * it has, so for a dispatch that scope's error IS the failure — whatever it was, because a
 * compute pipeline built from a refused module, layout or bind group cannot run either way.
 */
async function deviceVerdictDiagnostics(
  raw: GPUDevice | undefined,
  pipelineFailures: readonly unknown[],
  buildErrors: ReadonlyMap<string, string>,
  passes: readonly PassDescriptor[],
  /** T1523b: what a failure means for THIS build — a preview or a device rebuild retains nothing. */
  suggestion?: string,
): Promise<{ failures: RuntimeDiagnostic[]; notices: RuntimeDiagnostic[] }> {
  const failed = pipelineFailures.map((error) => ({
    label: failedPipelineLabel(error),
    cause: pipelineFailureCause(error),
  }));
  for (const [passId, message] of buildErrors) {
    if (passes.find((candidate) => candidate.id === passId)?.kind === "dispatch") {
      failed.push({ label: passId, cause: message });
    }
  }
  const failures: RuntimeDiagnostic[] = [];
  const told = new Set<string>();
  for (const { label, cause } of failed) {
    const pass = passes.find((candidate) => candidate.id === label);
    const wgsl =
      pass !== undefined && (pass.kind === "effect" || pass.kind === "draw" || pass.kind === "dispatch")
        ? await wgslErrorsOf(raw, pass.shader)
        : [];
    const built = buildErrors.get(label);
    const described = describeWgslErrors(wgsl, pass !== undefined && "sourceMap" in pass ? pass.sourceMap : undefined);
    const reason =
      described?.reason ?? built ?? (pass !== undefined && "shader" in pass ? rememberedReason(raw, pass.shader) : undefined);
    if (built !== undefined && (reason === built || wgsl.some((entry) => built.includes(entry.message)))) {
      told.add(label);
    }
    // T1523b(c): the device states an error that is not in the pass's WGSL (a layout over a
    // device limit) ONCE. vgpu then keeps the object the device refused and hands it to
    // every later build that asks for the same one, which fails with "invalid due to a
    // previous error" and nothing else. So the reason the scope caught is kept against
    // those bytes, for as long as that device (and so vgpu's copy of the object) lives.
    if (wgsl.length === 0 && built !== undefined && pass !== undefined && "shader" in pass) {
      rememberReason(raw, pass.shader, built);
    }
    failures.push(
      deviceFailureDiagnostic(label, reason ?? cause, passes, {
        ...(described?.source === undefined ? {} : { source: described.source }),
        ...(described?.nodeId === undefined ? {} : { nodeId: described.nodeId }),
        ...(suggestion === undefined ? {} : { suggestion }),
      }),
    );
  }
  const notices = [...buildErrors]
    .filter(([passId]) => !told.has(passId))
    .map(([passId, message]) => passBuildNotice(passId, message, passes));
  return { failures, notices };
}

/**
 * What the device said about a failed PIPELINE, off vgpu's error: the `cause` carries
 * Dawn's message — which for a broken shader only points at an earlier error (T1521b).
 */
function pipelineFailureCause(error: unknown): string {
  const shaped = error as { cause?: unknown };
  return shaped.cause instanceof Error
    ? shaped.cause.message
    : typeof (shaped.cause as { message?: unknown } | undefined)?.message === "string"
      ? String((shaped.cause as { message: string }).message)
      : describeError(error);
}

/**
 * A device-side build failure, attributed to its pass and node (§V27). `label` is what the
 * failed object was built under — a pipeline's comes off the error's `where`
 * (`<label>.compileSync`), a dispatch's off the scope it was built in (T1522b) — and every
 * one is labelled with its pass id, so the owning pass — and through it the node badge — is
 * recoverable. Only the id: a pass's human label is shared by every pass of its node type,
 * which blamed the wrong node (B229).
 */
function deviceFailureDiagnostic(
  label: string,
  reason: string,
  passes: readonly PassDescriptor[],
  options: {
    readonly source?: RuntimeDiagnostic["source"];
    readonly suggestion?: string;
    /** T1535b: the node whose text the error is in, when not the pass's own (a material's). */
    readonly nodeId?: string;
  } = {},
): ReturnType<typeof backendDiagnostic> {
  const pass = passes.find((candidate) => candidate.id === label);
  const nodeId =
    options.nodeId ??
    (pass !== undefined && pass.kind !== "swap" && pass.kind !== "counter" ? pass.nodeId : undefined);
  return backendDiagnostic(
    "error",
    BackendDiagnosticCode.compileFailed,
    `${pass === undefined ? (label.length > 0 ? `"${label}"` : "A pipeline") : `Pass "${pass.id}"`} failed to compile on the device: ${reason}`,
    {
      ...(nodeId === undefined ? {} : { nodeId }),
      ...(options.source === undefined ? {} : { source: options.source }),
      suggestion:
        options.suggestion ?? "The previous program is retained and still renders (§V9); fix the shader and recompile.",
    },
  );
}

/**
 * T1523b — THE COMPILER'S MESSAGES, ON THE AUTHOR'S LINES.
 *
 * `wgslErrorsOf` answers in the pass's WGSL. A pass whose node wrote its author's text into a
 * bigger module says where (`sourceMap`), and every message is put back on the parameter and
 * line the author typed — `kernel 3:10 …`. A position in generated code says so instead of
 * borrowing an author line it is not on. A pass with no map (a built-in node's own shader)
 * keeps the positions as the device gave them.
 *
 * `source` is the first message's authored position, which is what the shader editor marks:
 * `file` names the code parameter, so a node with several (kernel, group, spawn) marks the
 * right one.
 *
 * T1535b: `nodeId` is that same position's node when its span names one — a Material · WGSL's
 * code drawn inside the Scene node's pass — so the badge and the marker land on the node the
 * author typed into (§V27). An error only in generated code stays on the pass's node.
 */
function describeWgslErrors(
  errors: readonly WgslError[],
  map: WgslSourceMap | undefined,
): { reason: string; source?: NonNullable<RuntimeDiagnostic["source"]>; nodeId?: string } | undefined {
  if (errors.length === 0) return undefined;
  if (map === undefined) {
    return { reason: errors.map((entry) => `${entry.line}:${entry.column} ${entry.message}`).join("\n") };
  }
  let first: AuthoredPosition | undefined;
  const lines = errors.map((entry) => {
    const authored = entry.line >= 1 ? authoredPosition(map, entry) : undefined;
    if (authored === undefined) {
      return `${entry.line}:${entry.column} of the generated module (not your code) ${entry.message}`;
    }
    first ??= authored;
    return `${authored.parameter} ${authored.line}:${authored.column} ${entry.message}`;
  });
  return {
    reason: lines.join("\n"),
    ...(first === undefined ? {} : { source: { file: first.parameter, line: first.line, column: first.column } }),
    ...(first?.nodeId === undefined ? {} : { nodeId: first.nodeId }),
  };
}

/** T1523b(c): per device, the last reason the device gave for a source vgpu now holds invalid. */
const rememberedReasons = new WeakMap<GPUDevice, Map<string, string>>();
const REMEMBERED_REASON_LIMIT = 64;

function rememberReason(raw: GPUDevice | undefined, shader: string, reason: string): void {
  if (raw === undefined) return;
  let reasons = rememberedReasons.get(raw);
  if (reasons === undefined) {
    reasons = new Map();
    rememberedReasons.set(raw, reasons);
  }
  reasons.delete(shader);
  reasons.set(shader, reason);
  if (reasons.size > REMEMBERED_REASON_LIMIT) {
    const oldest = reasons.keys().next();
    if (oldest.done !== true) reasons.delete(oldest.value);
  }
}

function rememberedReason(raw: GPUDevice | undefined, shader: string): string | undefined {
  return raw === undefined ? undefined : rememberedReasons.get(raw)?.get(shader);
}
