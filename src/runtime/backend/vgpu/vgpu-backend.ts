import { frame, frameLoop } from "vgpu";
import type { Frame, Target } from "vgpu";
import type {
  BackendCapabilities,
  BackendInitOptions,
  CompiledExecutionPlan,
} from "../../../domain/types/backend.ts";
import type { BackendStatus, FrameLoopSettings, ShaderloomBackend } from "../backend-types.ts";
import {
  BackendDiagnosticCode,
  backendDiagnostic,
  createDiagnosticHub,
  describeError,
} from "../diagnostics.ts";
import { createFrameGuard } from "../frame-guard.ts";
import {
  estimateResourceBytes,
  planStructureSignature,
  planUniformValues,
  readExecutionPlan,
  type PassDescriptor,
  type ResourceDescriptor,
  type UniformValues,
} from "../plan.ts";
import { sharedUniformsFromFrame } from "../shared-uniforms.ts";
import { describeCapabilities, meetsBaseline } from "./capabilities.ts";
import { browserGpuHost, type GpuHost, type GpuSession } from "./gpu-host.ts";
import { ResourceBuildError, buildResources, toMutable, type ResourceSet } from "./resources.ts";

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

  function restartLoops(): void {
    const gpu = session?.gpu;
    if (!gpu) return;
    for (const registration of loops) {
      if (registration.stopped || registration.handle) continue;
      registration.handle = frameLoop(
        gpu,
        (f) => runFrame(f, registration.onFrame),
        registration.settings,
      );
    }
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

  function clearTemporalHistory(reason: "device" | "resolution" | "explicit"): void {
    const gpu = session?.gpu;
    if (!gpu || !program) return;
    const pairs = [...program.resources.pingPongs.values()];
    temporalResets += 1;
    if (pairs.length > 0) {
      guard.assertOutsideFrame("temporal history clear");
      frame(gpu, (f) => {
        for (const pair of pairs) {
          f.pass({ target: pair.read, clear: true }, () => {});
          f.pass({ target: pair.write, clear: true }, () => {});
        }
      });
    }
    hub.report(
      backendDiagnostic(
        "info",
        BackendDiagnosticCode.temporalReset,
        `Temporal history reset (${reason}); ${pairs.length} feedback pair(s) cleared.`,
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

  function encode(f: Frame, active: Program): void {
    guard.duringFrame(() => {
      for (const pass of active.passes) {
        if (pass.kind === "swap") {
          active.resources.pingPongs.get(pass.resourceId)?.swap();
          continue;
        }
        // dispatch / draw / counter are declared in the plan IR but not encodable yet;
        // the compiler does not emit them in v1, and skipping is safer than guessing.
        if (pass.kind !== "effect") continue;
        const drawable = active.resources.effects.get(pass.id);
        const resolve = active.resources.renderTargets.get(pass.id);
        if (!drawable || !resolve) continue;
        const renderTarget: Target = resolve();
        f.pass({ target: renderTarget, clear: pass.clear ?? true }, drawable);
      }
    });
  }

  /** Re-points ping-pong texture bindings after a swap. Outside the frame: rebinding only. */
  function rebindDynamicTextures(active: Program): void {
    for (const [passId, bindings] of active.resources.dynamicTextures) {
      const drawable = active.resources.effects.get(passId);
      if (!drawable) continue;
      const values: Record<string, unknown> = {};
      for (const binding of bindings) {
        const pair = active.resources.pingPongs.get(binding.resourceId);
        if (pair) values[binding.binding] = pair.read.color;
      }
      drawable.set(values);
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
        // §V47: no surface is created here, with or without `options.canvas`. The plan
        // always renders offscreen; presenting to a canvas is a separate concern.
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

      let resources: ResourceSet;
      try {
        resources = buildResources(active.gpu, read.resources, read.passes, guard);
      } catch (error) {
        // T95 (§V9, §V27): shader and allocation failures must reach onDiagnostic — the
        // problems tab listens there, not on thrown errors. The previous program is
        // retained and keeps rendering, flagged stale.
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
      if (previous) releaseResources(previous.resources);
      stale = false;
      estimatedBytes = estimateResourceBytes(read.resources);
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
      rebindDynamicTextures(active);

      const open = currentFrame;
      if (open) {
        encode(open, active);
      } else {
        try {
          frame(session.gpu, (f) => encode(f, active));
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

    async readOutput(outputId) {
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
      readbacks += 1;
      return first.read();
    },

    onDiagnostic(listener) {
      return hub.subscribe(listener);
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
      if (session && !halted) {
        registration.handle = frameLoop(session.gpu, (f) => runFrame(f, registration.onFrame), settings);
      }
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

    resetTemporalHistory() {
      clearTemporalHistory("explicit");
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

    async whenSettled() {
      await recovery;
      await session?.gpu.settled();
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      stopLoops();
      loops.clear();
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
 * vgpu's public `Target` / `SharedUniforms` interfaces do not declare `destroy()`, but the
 * concrete `OffscreenTarget` and shared-uniform block both implement it and both would
 * otherwise live until `gpu.dispose()` — a leak across every shader edit (§T49 asks for a
 * stable resource count over ten minutes). Duck-typed on purpose, and tolerant.
 */
function releaseResources(set: ResourceSet): void {
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

  for (const t of set.targets.values()) destroy(t);
  for (const pair of set.pingPongs.values()) {
    destroy(pair.read);
    destroy(pair.write);
  }
  for (const block of set.passUniforms.values()) destroy(block);
  destroy(set.shared);
}
