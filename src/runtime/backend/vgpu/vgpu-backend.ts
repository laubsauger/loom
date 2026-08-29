import { effect, frame, frameLoop, sampler, surface, timer } from "vgpu";
import type { Effect, Frame, PingPongTargets, Surface, SurfaceCanvas, Target, Timer } from "vgpu";
import type { RuntimeDiagnostic } from "../../../domain/types/diagnostics.ts";
import type {
  BackendCapabilities,
  BackendInitOptions,
  CompiledExecutionPlan,
} from "../../../domain/types/backend.ts";
import type {
  BackendStatus,
  BuildStats,
  FrameLoopSettings,
  // Ours, NOT the DOM's Media Source Extensions global of the same name — without this
  // import the code below would silently typecheck against the wrong interface.
  MediaSource,
  PresentableCanvas,
  PresentationHandle,
  PresentationOptions,
  PreviewFrameCommand,
  PreviewHostHandle,
  PreviewProgram,
  ShaderloomBackend,
} from "../backend-types.ts";
import {
  BackendDiagnosticCode,
  backendDiagnostic,
  createDiagnosticHub,
  describeError,
} from "../diagnostics.ts";
import { createFrameGuard } from "../frame-guard.ts";
import {
  bytesPerPixelFor,
  estimateResourceBytes,
  passStructureKey,
  planStructureSignature,
  resourceStructureKey,
  planUniformValues,
  readExecutionPlan,
  type PassDescriptor,
  type ResourceDescriptor,
  type UniformValues,
} from "../plan.ts";
import { sharedUniformsFromFrame } from "../shared-uniforms.ts";
import { describeCapabilities, meetsBaseline } from "./capabilities.ts";
import { browserGpuHost, type GpuHost, type GpuSession } from "./gpu-host.ts";
import {
  ResourceBuildError,
  buildResources,
  emptyCarryOver,
  noExternalResources,
  toMutable,
  type CarryOver,
  type ExternalResources,
  type ResourceSet,
} from "./resources.ts";

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

const defaultRetryDelay = (attempt: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));


/** `ShaderloomBackend` plus a settle hook for shutdown and deterministic tests. */
export interface VgpuBackend extends ShaderloomBackend {
  /** The report from the live device. Undefined before `initialize()`. */
  readonly capabilities: BackendCapabilities | undefined;
  /** Resolves once any in-flight device recovery has finished. */
  whenSettled(): Promise<void>;
}

interface Program {
  readonly id: string;
  /** Mutable: `resize()` reconciles both so the compile cache never diverges from the GPU (R4). */
  signature: string;
  resourceDescriptors: ReadonlyArray<ResourceDescriptor>;
  readonly passes: ReadonlyArray<PassDescriptor>;
  readonly compiled: CompiledExecutionPlan;
  /** Latest uniform values per pass, including live updates. Survives a device rebuild. */
  readonly liveUniforms: Map<string, UniformValues>;
  resources: ResourceSet;
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
  outputId: string;
  surface: Surface | undefined;
  blit: Effect | undefined;
  /** The exact object currently bound as the blit source, for change detection. */
  boundSource: Target | PingPongTargets | undefined;
  disposed: boolean;
}

/** Presenting is a GPU-to-GPU copy (§V7): sample the output, write the surface. */
const BLIT_WGSL = `@group(0) @binding(0) var blitSampler: sampler;
@group(0) @binding(1) var blitSource: texture_2d<f32>;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(blitSource, blitSampler, uv);
}`;

export function createVgpuBackend(options: VgpuBackendOptions = {}): VgpuBackend {
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
  let readbacks = 0;
  let planCounter = 0;
  /** §V9: latest compile attempt failed; the retained program is what still renders. */
  let stale = false;
  let estimatedBytes = 0;
  let consecutiveFrameErrors = 0;
  let lastBuildStats: BuildStats | undefined;
  const presentations = new Map<string, PresentationState>();
  /** sourceId → frame producer (T229, §V135). Backend-lifetime: survives recompiles and device loss. */
  const mediaSources = new Map<string, MediaSource>();
  let presentationCounter = 0;
  let presentSampler: GPUSampler | undefined;
  /** GPU pass timer (T163). Exists only when the device has timestamp-query (§V12). */
  let gpuTimer: Timer | undefined;
  const timingListeners = new Set<(spans: Readonly<Record<string, number>>) => void>();
  let unsubscribeTimer: (() => void) | undefined;

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

  function reportCapabilities(report: BackendCapabilities): void {
    if (!meetsBaseline(report)) {
      hub.report(
        backendDiagnostic(
          "error",
          BackendDiagnosticCode.capabilityBelowBaseline,
          `GPU reports capability tier ${report.tier}; Shaderloom requires tier B ` +
            "(rgba16float render targets, compute, storage buffers).",
          { suggestion: "Use a desktop Chrome/Edge 128+ with hardware WebGPU." },
        ),
      );
    }
    if (!report.timestampQuery) {
      // §V12: optional, so it degrades to "no per-pass GPU timings", never to a hard failure.
      hub.report(
        backendDiagnostic(
          "info",
          BackendDiagnosticCode.timestampUnavailable,
          "timestamp-query is unavailable; per-pass GPU timings are disabled.",
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
      const fps = registration.settings.fps ?? 60;
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

    registration.handle = frameLoop(gpu, (f) => runFrame(f, registration.onFrame), registration.settings);
  }

  function restartLoops(): void {
    for (const registration of loops) startLoop(registration);
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
      capabilities = describeCapabilities(next.gpu);
      reportCapabilities(capabilities);
      watchDeviceLoss(next);
      attachTimer();

      if (program) {
        // §V23: rebuilt from the retained plan, which is the compiled form of the domain graph.
        program.resources = buildResources(
          next.gpu,
          program.resourceDescriptors,
          program.passes,
          guard,
        );
        resourceBuilds += 1;
        // Live values, not the ones the plan was compiled with: a rebuild must not roll a
        // parameter back to whatever it was when the shader last changed.
        flushUniforms(program);
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
    if (!block) return;
    const merged = { ...(target.liveUniforms.get(passId) ?? {}), ...values };
    target.liveUniforms.set(passId, merged);
    block.set(toMutable(merged));
  }

  function flushUniforms(target: Program): void {
    for (const [passId, values] of target.liveUniforms) applyUniforms(target, passId, values);
  }

  function clearTemporalHistory(
    reason: "device" | "resolution" | "explicit",
    resourceIds?: readonly string[],
  ): void {
    const gpu = session?.gpu;
    if (!gpu || !program) return;
    // T215: an id filter clears ONLY those pairs — the pulse-based Feedback reset
    // (§V126) and `runtime.resetFeedback` need one node's history gone, not every
    // simulation's. No filter = every pair, the device-loss/whole-project semantics.
    const pingPongs = program.resources.pingPongs;
    const selected =
      resourceIds === undefined
        ? [...pingPongs.values()]
        : resourceIds.flatMap((id) => {
            const pair = pingPongs.get(id);
            if (pair !== undefined) return [pair];
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
    temporalResets += 1;
    if (selected.length > 0) {
      guard.assertOutsideFrame("temporal history clear");
      frame(gpu, (f) => {
        for (const pair of selected) {
          f.pass({ target: pair.read, clear: true }, () => {});
          f.pass({ target: pair.write, clear: true }, () => {});
        }
      });
    }
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
  function runFrame(f: Frame, onFrame: () => void): void {
    const previous = currentFrame;
    currentFrame = f;
    try {
      guard.duringFrame(onFrame);
      consecutiveFrameErrors = 0;
    } catch (error) {
      // T98: a throw inside vgpu's rAF callback would otherwise explode every frame
      // with no diagnostic. Report it; a streak means something structural broke, so
      // halt instead of letting the storm continue.
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
  }

  /**
   * Encodes one dispatch pass. vgpu computes have no frame-level pass API (upstream
   * gap): `dispatch()` builds its own command buffer and SUBMITS IMMEDIATELY, so where
   * this call happens relative to open frames IS the execution order.
   */
  function encodeDispatch(active: Program, pass: PassDescriptor & { kind: "dispatch" }): void {
    // T172: kernels run in the frame. Indirect counts come from a GPU buffer the
    // lifecycle wrote — the CPU never knows the number, and does not need to.
    const pipeline = active.resources.computes.get(pass.id);
    if (!pipeline) return;
    if ("indirect" in (pass.workgroups as object)) {
      const counter = active.resources.buffers.get((pass.workgroups as { indirect: string }).indirect);
      if (counter) pipeline.dispatch({ indirect: counter });
    } else {
      const [x, y, z] = pass.workgroups as readonly [number, number, number];
      pipeline.dispatch(x, y, z);
    }
  }

  function encode(
    f: Frame,
    active: Program,
    passes: ReadonlyArray<PassDescriptor> = active.passes,
    withPresentations = true,
  ): void {
    guard.duringFrame(() => {
      for (const pass of passes) {
        if (pass.kind === "swap") {
          active.resources.pingPongs.get(pass.resourceId)?.swap();
          active.resources.bufferPairs.get(pass.resourceId)?.swap();
          continue;
        }
        if (pass.kind === "dispatch") {
          // Inside an OPEN frame (the loop path) a dispatch cannot be ordered after
          // this frame's render passes — vgpu submits it now, the frame submits later.
          // Kernel→draw chains are therefore correct here; an effect→dispatch read
          // (Analyze, the TOP→POP bridge) sees the PREVIOUS frame's texture — one
          // frame of latency, which §V144 embraces. The no-open-frame path
          // (`encodeSegmented`) honours plan order exactly.
          encodeDispatch(active, pass);
          continue;
        }
        if (pass.kind === "draw") {
          const drawable = active.resources.draws.get(pass.id);
          const resolve = active.resources.renderTargets.get(pass.id);
          if (!drawable || !resolve) continue;
          const indirect =
            typeof pass.instances === "object"
              ? active.resources.buffers.get(pass.instances.indirect)
              : undefined;
          if (indirect) {
            // Indirect counts come from the GPU-written args buffer through the draw's
            // own pass. No clear/timer hook exists on that path yet (T180/T181 note).
            drawable.draw({ target: resolve(), indirect });
          } else {
            // Literal draws encode through f.pass, which is what gives them a clear
            // knob (T180 - clear:false is the trails pattern) and a GPU timer span
            // (T181 - span name = pass id, like effects).
            const span = gpuTimer?.span(pass.id);
            f.pass(
              {
                target: resolve(),
                clear: pass.clear ?? true,
                ...(span === undefined ? {} : { timer: span }),
              },
              drawable,
            );
          }
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
        const span = gpuTimer?.span(pass.id);
        f.pass(
          span === undefined
            ? { target: renderTarget, clear: pass.clear ?? true }
            : { target: renderTarget, clear: pass.clear ?? true, timer: span },
          drawable,
        );
      }

      if (withPresentations) encodePresentations(f);
    });
  }

  /**
   * Plan-order-exact encoding for the direct (no open frame) path. vgpu computes
   * submit the moment they are called, while a frame's render passes submit when the
   * frame closes — so inside ONE frame a dispatch always runs first, whatever the plan
   * said. Here the passes are split into segments instead: consecutive render-family
   * passes share a frame, and each dispatch executes BETWEEN frames, exactly where the
   * plan put it. This is what makes an effect→dispatch read (Analyze reducing a texture
   * rendered THIS frame) correct on the offline/export path.
   */
  function encodeSegmented(gpu: GpuSession["gpu"], active: Program): void {
    type Segment =
      | { kind: "frame"; passes: PassDescriptor[] }
      | { kind: "dispatch"; pass: PassDescriptor & { kind: "dispatch" } };
    const segments: Segment[] = [];
    let current: PassDescriptor[] = [];
    for (const pass of active.passes) {
      if (pass.kind === "dispatch") {
        if (current.length > 0) {
          segments.push({ kind: "frame", passes: current });
          current = [];
        }
        segments.push({ kind: "dispatch", pass });
        continue;
      }
      current.push(pass);
    }
    // The final frame always runs, even empty: it carries the presentations.
    segments.push({ kind: "frame", passes: current });

    segments.forEach((segment, index) => {
      if (segment.kind === "dispatch") {
        guard.duringFrame(() => encodeDispatch(active, segment.pass));
        return;
      }
      const final = index === segments.length - 1;
      frame(gpu, (f) => encode(f, active, segment.passes, final));
    });
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
      }
      drawable.set(values);
    }
    for (const [passId, bindings] of active.resources.dynamicBuffers) {
      const drawable = settableFor(passId);
      if (!drawable) continue;
      const values: Record<string, unknown> = {};
      for (const binding of bindings) {
        const pair = active.resources.bufferPairs.get(binding.resourceId);
        if (pair) values[binding.binding] = binding.half === "write" ? pair.write : pair.read;
      }
      drawable.set(values);
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
  function uploadExternalTextures(active: Program): void {
    if (!session || active.resources.externalTextures.size === 0) return;
    const queue = session.gpu.device.queue.gpu;
    for (const entry of active.resources.externalTextures.values()) {
      const source = mediaSources.get(entry.sourceId);
      if (source === undefined) continue;
      const mediaFrame = source.currentFrame();
      if (mediaFrame === undefined || mediaFrame.frameId === entry.lastFrameId) continue;
      try {
        if (mediaFrame.bytes !== undefined) {
          const bytesPerRow = entry.size[0] * bytesPerPixelFor(entry.format as Parameters<typeof bytesPerPixelFor>[0]);
          queue.writeTexture(
            { texture: entry.texture.gpu },
            mediaFrame.bytes as BufferSource,
            { bytesPerRow, rowsPerImage: entry.size[1] },
            { width: entry.size[0], height: entry.size[1] },
          );
        } else if (mediaFrame.image !== undefined && typeof queue.copyExternalImageToTexture === "function") {
          // Browser fast path: ImageBitmap / VideoFrame / canvas, no CPU readback.
          queue.copyExternalImageToTexture(
            { source: mediaFrame.image as GPUCopyExternalImageSource },
            { texture: entry.texture.gpu },
            { width: entry.size[0], height: entry.size[1] },
          );
        } else {
          continue; // No payload this device can take; leave the cursor so a usable frame retries.
        }
        entry.lastFrameId = mediaFrame.frameId;
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
  }

  function lookupTargets(outputId: string): ReadonlyArray<Target> {
    if (!program) return [];
    const plain = program.resources.targets.get(outputId);
    if (plain) return [plain];
    const pair = program.resources.pingPongs.get(outputId);
    if (pair) return [pair.read, pair.write];
    return [];
  }

  function presentationSource(outputId: string): Target | PingPongTargets | undefined {
    if (!program) return undefined;
    return program.resources.targets.get(outputId) ?? program.resources.pingPongs.get(outputId);
  }

  const isPair = (source: Target | PingPongTargets): source is PingPongTargets => "swap" in source;

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
        p.surface = surface(active.gpu, p.canvas as unknown as SurfaceCanvas, p.label === undefined ? {} : { label: p.label });
      }
      const source = presentationSource(p.outputId);
      if (source === undefined) {
        p.boundSource = undefined;
        return;
      }
      presentSampler ??= sampler(active.gpu, { magFilter: "linear", minFilter: "linear" });
      const bindValue = isPair(source) ? source.read.color : source;
      if (!p.blit) {
        p.blit = effect(active.gpu, BLIT_WGSL, {
          set: { blitSampler: presentSampler, blitSource: bindValue },
          label: `present:${p.id}`,
        });
        // No compileSync here: a surface target only exists inside frame(gpu)
        // (VGPU-SURFACE-NOT-IN-FRAME), so the blit pipeline compiles lazily on its
        // first encode. One-time cost on the first presented frame, not per frame.
      } else if (p.boundSource !== source) {
        p.blit.set({ blitSource: bindValue });
      }
      p.boundSource = source;
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
      unsubscribeTimer = created.onResults((spans) => {
        for (const listener of timingListeners) listener(spans);
      });
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
    };
  }

  /** Destroys a preview host's owned objects; the shared block is kept iff it is the main program's. */
  function releasePreviewSet(previous: ResourceSet, keepShared: boolean): void {
    releaseResourcesExcept(previous, {
      targets: new Map(),
      pingPongs: new Map(),
      samplers: new Map(),
      externalTextures: new Map(),
      buffers: new Map(),
      bufferPairs: new Map(),
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
      h.set = buildResources(
        active.gpu,
        h.program.resources,
        h.program.passes,
        guard,
        { ...carry, shared: sharedFromMain ?? carry.shared },
        stats,
        mainExternals(),
        partial,
      );
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
        h.blit = effect(active.gpu, BLIT_WGSL, {
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
      if (isPair(p.boundSource)) p.blit.set({ blitSource: p.boundSource.read.color });
      f.pass({ target: p.surface, clear: true }, p.blit);
    }
  }

  return {
    status,
    get capabilities() {
      return capabilities;
    },

    async initialize(options) {
      if (disposed) throw new Error("initialize() called after dispose().");
      if (session) return capabilities ?? describeCapabilities(session.gpu);

      initOptions = options;
      try {
        const created = await host.create(options);
        session = created;
        deviceGeneration += 1;
        capabilities = describeCapabilities(created.gpu);
        reportCapabilities(capabilities);
        watchDeviceLoss(created);
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
              resource.kind === "target" || resource.kind === "pingPong",
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

      const signature = planStructureSignature(read.resources, read.passes);

      if (program && program.signature === signature) {
        // Structurally identical: only uniform values can differ, so nothing is rebuilt (§V5).
        for (const [passId, values] of planUniformValues(read.passes)) {
          applyUniforms(program, passId, values);
        }
        stale = false;
        return program.compiled;
      }

      // T143 (§V22): diff per-entry structure keys against the retained program and
      // carry over everything unchanged. A carried ping-pong keeps its CONTENTS, so an
      // unrelated structural edit no longer zeroes anyone's feedback history; carried
      // effects skip shader recompilation, so the edit hitch scales with the edit.
      const carry = program ? computeCarryOver(program, read.resources, read.passes) : emptyCarryOver;
      const stats: BuildStats = { resourcesCreated: 0, resourcesReused: 0, effectsBuilt: 0, effectsReused: 0 };

      let resources: ResourceSet;
      // B9 (T217, §V9): Dawn does not throw on invalid WGSL. `compileSync()` returns; the
      // validation error surfaces ASYNCHRONOUSLY through vgpu's pipeline error scope and
      // lands on `gpu.onError` (or stderr, when nobody listens). So the try/catch below
      // only sees CPU-side failures — the device's verdict has to be collected here and
      // awaited via `settled()` BEFORE the program is installed, or a broken shader
      // replaces (and releases) the last valid program with all lights green.
      const asyncErrors: unknown[] = [];
      const unsubscribe = active.gpu.onError((error: unknown) => {
        asyncErrors.push(error);
      });
      try {
        resources = buildResources(active.gpu, read.resources, read.passes, guard, carry, stats);
        // Twice, deliberately: the first settle drains the tracked error-scope pops, whose
        // handlers only THEN enqueue the listener delivery; the second drains those.
        await active.gpu.settled();
        await active.gpu.settled();
      } catch (error) {
        // T95 (§V9, §V27): shader and allocation failures must reach onDiagnostic — the
        // problems tab listens there, not on thrown errors. The previous program is
        // retained and keeps rendering, flagged stale. Carried objects still belong to
        // the retained program, which is why nothing is released on this path.
        stale = program !== undefined;
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
        throw error;
      } finally {
        unsubscribe();
      }

      const pipelineFailures = asyncErrors.filter(isPipelineCompileError);
      // Anything else the device reported in the window (a dropped readback, say) still
      // reaches the problems tab — it just does not veto the install.
      for (const other of asyncErrors) {
        if (isPipelineCompileError(other)) continue;
        hub.report(
          backendDiagnostic("warning", BackendDiagnosticCode.frameError, describeError(other)),
        );
      }
      if (pipelineFailures.length > 0) {
        // §V9: the previous program stays installed and keeps rendering, flagged stale.
        // The half-built resources are released — except objects carried from (and still
        // owned by) the retained program.
        stale = program !== undefined;
        releaseResourcesExcept(resources, program?.resources);
        const failureDiagnostics = pipelineFailures.map((error) =>
          pipelineFailureDiagnostic(error, read.passes),
        );
        for (const diagnostic of failureDiagnostics) hub.report(diagnostic);
        throw new ResourceBuildError(failureDiagnostics);
      }
      resourceBuilds += 1;
      planCounter += 1;
      const id = `plan-${planCounter}`;

      const previous = program;
      program = {
        id,
        signature,
        resourceDescriptors: read.resources,
        passes: read.passes,
        compiled: { id, logical: plan },
        liveUniforms: new Map(planUniformValues(read.passes)),
        resources,
      };
      if (previous) releaseResourcesExcept(previous.resources, resources);
      // Reused uniform blocks still hold pre-recompile values; the plan's values are
      // authoritative (they come from the domain graph), so sync every block.
      flushUniforms(program);
      lastBuildStats = stats;
      stale = false;
      estimatedBytes = estimateResourceBytes(read.resources);
      // Rebuilt outputs replaced their objects; every attached surface rebinds (T87),
      // and preview bindings into the main program get re-pointed (T161).
      ensureAllPresentations();
      refreshPreviewExternals();
      return program.compiled;
    },

    render(compiled, frameInputs) {
      // §V23: while halted nothing reaches the queue.
      if (disposed || halted || !session || !program) return;
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
      active.resources.shared.set(sharedUniformsFromFrame(frameInputs));
      // T172 convention: a dispatch pass's uniform block receives the frame fields each
      // render, merged over its static values (seed, count) — the KernelFrame contract,
      // fed from FrameInputs and nothing else (§V44).
      for (const pass of active.passes) {
        if (pass.kind === "dispatch" && pass.uniformBinding !== undefined) {
          applyUniforms(active, pass.id, {
            timeSeconds: frameInputs.frame.timeSeconds,
            deltaSeconds: frameInputs.frame.deltaSeconds,
            frameIndex: frameInputs.frame.frameIndex,
          });
        }
      }
      rebindDynamicTextures(active);
      uploadExternalTextures(active);

      const open = currentFrame;
      if (open) {
        encode(open, active);
      } else {
        try {
          encodeSegmented(session.gpu, active);
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
      framesSubmitted += 1;
    },

    resize(outputId, size) {
      guard.assertOutsideFrame("target resize");
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
      for (const t of found) t.resize(size);

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
        estimatedBytes = estimateResourceBytes(program.resourceDescriptors);
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
      const descriptor = program?.resourceDescriptors.find(
        (resource) => resource.id === outputId && (resource.kind === "target" || resource.kind === "pingPong"),
      );
      if (descriptor === undefined || (descriptor.kind !== "target" && descriptor.kind !== "pingPong")) {
        throw new Error(`readOutput("${outputId}") has no retained descriptor to interpret the bytes.`);
      }
      const [width, height] = descriptor.size;
      const format = descriptor.format;
      const bytesPerPixel = bytesPerPixelFor(format);

      readbacks += 1;
      const raw = new Uint8Array(await first.read());
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
      if (!program.resources.passUniforms.has(update.passId)) {
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

    resetTemporalHistory(resourceIds?: readonly string[]) {
      clearTemporalHistory("explicit", resourceIds);
    },

    present(canvas: PresentableCanvas, options: PresentationOptions): PresentationHandle {
      // §V64/§V70: the surface is handed in, never created here, and any number of
      // surfaces may present the same output. Registering mid-recovery is fine — the
      // rebuild re-establishes every retained presentation (mirrors loop(), R9).
      if (disposed) throw new Error("present() called after dispose().");
      if (!session && !recovery) throw new Error("present() called before initialize().");
      guard.assertOutsideFrame("surface attach");

      presentationCounter += 1;
      const p: PresentationState = {
        id: `present-${presentationCounter}`,
        canvas,
        label: options.label,
        outputId: options.outputId,
        surface: undefined,
        blit: undefined,
        boundSource: undefined,
        disposed: false,
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
          const active = session;
          const set = h.set;
          const surfaceTarget = h.surface;
          if (!active || set === undefined || surfaceTarget === undefined) return;

          const dpr = command.surface.dpr;
          const encodeCommand = (f: Frame): void => {
            // Ping-pong-sourced bindings swap identity per frame — re-point first,
            // exactly as the main program's rebindDynamicTextures does.
            for (const [passId, bindings] of set.dynamicTextures) {
              const drawable = set.effects.get(passId);
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

            // Refresh: only the tiles whose cadence says they are due (§V28, §V16).
            for (const passId of command.refresh) {
              const drawable = set.effects.get(passId);
              const resolve = set.renderTargets.get(passId);
              if (drawable && resolve) f.pass({ target: resolve(), clear: true }, drawable);
            }

            // Composite: every active tile, due or not — a pan moves rects without
            // re-rendering pixels. GPU→GPU throughout (§V7).
            f.pass({ target: surfaceTarget, clear: true }, () => {});
            if (h.blit) {
              for (const tile of command.composite) {
                const tileTarget = set.targets.get(tile.resourceId);
                if (tileTarget === undefined) continue;
                h.blit.set({ blitSource: tileTarget });
                f.pass(
                  {
                    target: surfaceTarget,
                    clear: false,
                    viewport: {
                      x: tile.dest.x * dpr,
                      y: tile.dest.y * dpr,
                      width: Math.max(1, tile.dest.width * dpr),
                      height: Math.max(1, tile.dest.height * dpr),
                    },
                  },
                  h.blit,
                );
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

    registerMediaSource(sourceId, source) {
      // Order-free (T229): a plan compiled before this registration starts uploading on
      // the next render; a registration with no plan yet simply waits. Replacement
      // resets no texture — the next differing frameId overwrites the pixels anyway.
      mediaSources.set(sourceId, source);
      return () => {
        if (mediaSources.get(sourceId) === source) mediaSources.delete(sourceId);
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
      for (const p of presentations.values()) {
        p.disposed = true;
        try {
          p.surface?.dispose();
        } catch {
          // A lost device already tore it down.
        }
      }
      presentations.clear();
      unsubscribeTimer?.();
      unsubscribeTimer = undefined;
      gpuTimer = undefined;
      timingListeners.clear();
      for (const h of previewHosts) {
        h.disposed = true;
        try {
          h.surface?.dispose();
        } catch {
          // A lost device already tore it down.
        }
      }
      previewHosts.clear();
      program = undefined;
      try {
        session?.dispose();
      } catch {
        // Disposing a lost device is allowed to fail; the handle is dropped either way.
      }
      session = undefined;
    },
  };
}

/**
 * Decides what the new build may carry over from the retained program (T143).
 *
 * A resource is reusable when its per-entry structure key is unchanged. An effect is
 * reusable only when its own pass key is unchanged AND its render target and every
 * bound resource are reusable — a rebuilt binding target means the effect's set bag
 * would reference a destroyed object.
 */
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
  const pingPongs = new Map<string, NonNullable<ReturnType<ResourceSet["pingPongs"]["get"]>>>();
  const samplers = new Map<string, GPUSampler>();
  const externalTextures = new Map<string, NonNullable<ReturnType<ResourceSet["externalTextures"]["get"]>>>();
  const buffers = new Map<string, NonNullable<ReturnType<ResourceSet["buffers"]["get"]>>>();
  const bufferPairs = new Map<string, NonNullable<ReturnType<ResourceSet["bufferPairs"]["get"]>>>();
  for (const id of reusable) {
    const target = previous.resources.targets.get(id);
    if (target) targets.set(id, target);
    const pair = previous.resources.pingPongs.get(id);
    if (pair) pingPongs.set(id, pair);
    const sampler = previous.resources.samplers.get(id);
    if (sampler) samplers.set(id, sampler);
    const external = previous.resources.externalTextures.get(id);
    if (external) externalTextures.set(id, external);
    const buffer = previous.resources.buffers.get(id);
    if (buffer) buffers.set(id, buffer);
    const bufferPair = previous.resources.bufferPairs.get(id);
    if (bufferPair) bufferPairs.set(id, bufferPair);
  }

  const oldPassKeys = new Map(previous.passes.map((pass) => [pass.id, passStructureKey(pass)]));
  const effects = new Map<string, NonNullable<ReturnType<ResourceSet["effects"]["get"]>>>();
  const computes = new Map<string, NonNullable<ReturnType<ResourceSet["computes"]["get"]>>>();
  const draws = new Map<string, NonNullable<ReturnType<ResourceSet["draws"]["get"]>>>();
  const passUniforms = new Map<string, NonNullable<ReturnType<ResourceSet["passUniforms"]["get"]>>>();
  for (const pass of nextPasses) {
    if (pass.kind === "swap" || pass.kind === "counter") continue;
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
    pingPongs,
    samplers,
    externalTextures,
    buffers,
    bufferPairs,
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

  for (const [id, target] of previous.targets) {
    if (next?.targets.get(id) !== target) destroy(target);
  }
  for (const [id, pair] of previous.pingPongs) {
    if (next?.pingPongs.get(id) !== pair) {
      destroy(pair.read);
      destroy(pair.write);
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

/**
 * A device-side pipeline failure, attributed to its pass and node (§V27). The error's
 * `where` is `<label>.compileSync` and effects are labelled with the pass id (or its
 * label), so the owning pass — and through it the node badge — is recoverable. The
 * `cause` carries Dawn's real message, line and column included.
 */
function pipelineFailureDiagnostic(
  error: unknown,
  passes: readonly PassDescriptor[],
): ReturnType<typeof backendDiagnostic> {
  const shaped = error as { where?: unknown; cause?: unknown; message?: unknown };
  const where = typeof shaped.where === "string" ? shaped.where : "";
  const label = where.replace(/\.(compileSync|compile|pipelineFor)$/, "");
  const pass = passes.find(
    (candidate) =>
      candidate.id === label ||
      (candidate.kind === "effect" && candidate.label !== undefined && candidate.label === label),
  );
  const nodeId =
    pass !== undefined && pass.kind !== "swap" && pass.kind !== "counter" ? pass.nodeId : undefined;
  const causeMessage =
    shaped.cause instanceof Error
      ? shaped.cause.message
      : typeof (shaped.cause as { message?: unknown } | undefined)?.message === "string"
        ? String((shaped.cause as { message: string }).message)
        : describeError(error);
  return backendDiagnostic(
    "error",
    BackendDiagnosticCode.compileFailed,
    `${pass === undefined ? (label.length > 0 ? `"${label}"` : "A pipeline") : `Pass "${pass.id}"`} failed to compile on the device: ${causeMessage}`,
    {
      ...(nodeId === undefined ? {} : { nodeId }),
      suggestion: "The previous program is retained and still renders (§V9); fix the shader and recompile.",
    },
  );
}

