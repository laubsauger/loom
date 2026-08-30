import { compileGraph } from "../../compiler/index.ts";
import type { CompiledGraph } from "../../compiler/types.ts";
import type { BackendCapabilities, LogicalExecutionPlan } from "../../domain/types/backend.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import type { TextureFormat } from "../../domain/types/node-definition.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { createUniformAnimator } from "../../app/animate-parameters.ts";
import type { AudioFeatures } from "../../domain/types/frame.ts";
import type { FeatureTrackRecorder } from "../../domain/audio/feature-track.ts";
import type { GpuHost } from "../../runtime/backend/vgpu/gpu-host.ts";
import { createFrameDriver } from "../../runtime/execution/frame-driver.ts";
import { offlineTransport } from "../../runtime/execution/offline-transport.ts";
import { createPointerSource } from "../../runtime/execution/pointer.ts";
import { OUTPUT_NODE_ID, paritySettings } from "../fixtures/parity-graphs.ts";

/**
 * One graph, one device, N deterministic frames, pixels out.
 *
 * This is the whole point of T69. Everything that differs between "the browser path" and
 * "the headless path" is meant, per §V47, to be exactly one thing: which `GpuHost` built
 * the device. So this harness takes a `GpuHost` and nothing else varies — same
 * `GraphDocument`, same `compileGraph`, same `createVgpuBackend`, same `FrameDriver.step()`
 * the live loop calls. If the two paths ever diverge in more than the host, the divergence
 * has to be written INTO this file, where it is visible, rather than hiding in two
 * near-identical test bodies.
 *
 * `offlineTransport` supplies time (§V44, §V49): frame N lands on exactly N/fps with no
 * clock read anywhere, which is what makes the sequence replayable rather than merely
 * repeatable-if-you-are-lucky.
 */

export interface RenderedFrame {
  readonly frameIndex: number;
  readonly width: number;
  readonly height: number;
  readonly format: TextureFormat;
  /** Raw target bytes, unpadded, in the target's own format (§V60 shape, carried here). */
  readonly bytes: Uint8Array;
}

export interface HeadlessRenderRequest {
  readonly host: GpuHost;
  readonly graph: GraphDocument;
  readonly settings?: ProjectSettings;
  /** How many frames to step. Frame indices are 0..frames-1. */
  readonly frames?: number;
  /** Which frame indices to read back. Defaults to the last frame only. */
  readonly capture?: ReadonlyArray<number>;
  readonly outputNodeId?: string;
  readonly fps?: number;
  /**
   * §V47's control knob. Supplying a canvas must not change a single byte — the backend
   * documents that it creates no surface either way — so the parity suite runs the same
   * graph with and without one and compares.
   */
  readonly canvas?: HTMLCanvasElement;
  /** Called once after compile, before any frame. Used by the resize case. */
  readonly beforeFrames?: (control: HarnessControl) => void;
  /** Called after frame `at`, before the next step. Used by the resize case. */
  readonly betweenFrames?: (control: HarnessControl, frameIndex: number) => void;
  /**
   * T442 (T431's skeleton): evaluate the VALUE GRAPH each frame and push driven
   * parameter values through the animator before the encode — the live app's T340
   * order, headless. Off by default: a static render must not pay for a value session
   * it does not use, and every existing caller keeps its exact behaviour.
   */
  readonly animate?: boolean;
  /**
   * T431: FEED a recorded feature track. The closure is the frame driver's `audio` seam
   * — the same one the live session's analyser fills — so a replayed render and the
   * performance it was recorded from are the same computation with the same inputs.
   * Absent, a render runs in silence rather than re-listening (§V352).
   */
  readonly audio?: (frameIndex: number) => AudioFeatures | null;
  /**
   * T431: CAPTURE what crossed that seam, frame by frame. Recording here rather than at
   * the analyser is the whole contract: what must replay identically is what the engine
   * READ, not what some upstream stage computed.
   */
  readonly recordAudio?: FeatureTrackRecorder;
}

export interface HarnessControl {
  resize(outputId: string, size: readonly [number, number]): void;
  readonly outputResourceId: string;
  readonly plan: CompiledGraph;
}

export interface HeadlessRenderResult {
  readonly frames: ReadonlyArray<RenderedFrame>;
  readonly plan: CompiledGraph;
  readonly capabilities: BackendCapabilities;
  /** Readback count seen by the backend. Playback itself must never add to this (§V7). */
  readonly readbacks: number;
  readonly outputResourceId: string;
  /** Everything the backend reported. A silent diagnostic is a silently broken render. */
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}

function registry() {
  return createNodeRegistry(allNodeDefinitions).view();
}

/** The resource the sink presents into, resolved from the plan rather than reconstructed. */
export function outputResourceIdOf(plan: CompiledGraph, nodeId: string): string {
  const match = plan.outputs.find((output) => output.nodeId === nodeId);
  if (match === undefined) {
    throw new Error(
      `No materialized output for node "${nodeId}". Plan outputs: ` +
        plan.outputs.map((o) => `${o.nodeId}:${o.portId}`).join(", "),
    );
  }
  return match.resourceId;
}

/**
 * Compiles the graph without a GPU. Split out so a plan-level comparison (which is where a
 * compiler divergence would actually show up) does not need a device at all.
 */
export function compileParityGraph(
  graph: GraphDocument,
  capabilities: BackendCapabilities,
  settings: ProjectSettings = paritySettings(),
): CompiledGraph {
  return compileGraph({ graph, settings, registry: registry(), capabilities });
}

export async function renderHeadless(request: HeadlessRenderRequest): Promise<HeadlessRenderResult> {
  const settings = request.settings ?? paritySettings();
  const frameCount = request.frames ?? 1;
  const capture = [...(request.capture ?? [frameCount - 1])].sort((a, b) => a - b);
  const outputNodeId = request.outputNodeId ?? OUTPUT_NODE_ID;
  const fps = request.fps ?? 60;

  const backend = createVgpuBackend({ host: request.host });
  const diagnostics: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  try {
    // §V12: compile against the capabilities the DEVICE reports, never against assumed
    // ones. A device without float32-filterable must produce a plan that says so.
    const capabilities = await backend.initialize(
      request.canvas === undefined ? {} : { canvas: request.canvas },
    );

    const plan = compileParityGraph(request.graph, capabilities, settings);
    const errors = plan.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      throw new Error(`Parity graph failed to compile: ${errors.map((d) => d.message).join("; ")}`);
    }

    const outputResourceId = outputResourceIdOf(plan, outputNodeId);
    const compiled = await backend.compile(plan);

    const control: HarnessControl = {
      resize: (outputId, size) => {
        backend.resize(outputId, size);
      },
      outputResourceId,
      plan,
    };
    request.beforeFrames?.(control);

    const valueSession = request.animate === true ? createValueGraphSession(registry()) : null;
    const animator = request.animate === true ? createUniformAnimator() : null;
    // One closure serves both directions, so a render can replay a track and record what
    // it replayed — which is what makes "record, replay, record again, compare" a test of
    // the ROUND TRIP rather than of two separate code paths.
    const audioAt = request.audio;
    const recorder = request.recordAudio;
    // The driver reads its audio seam with no argument — it is a LIVE source there. The
    // loop below publishes the index it is about to step so the closure knows which frame
    // of the track it is standing in.
    let steppingFrame = 0;
    const audioSeam =
      audioAt === undefined && recorder === undefined
        ? undefined
        : (): AudioFeatures | null => {
            const features = audioAt?.(steppingFrame) ?? null;
            recorder?.capture(steppingFrame, features);
            return features;
          };

    const driver = createFrameDriver({
      backend,
      ...(audioSeam === undefined ? {} : { audio: audioSeam }),
      // §V45: the seed is the project's, not the transport's own invention.
      transport: offlineTransport({ fps, seed: settings.randomSeed, mode: "fixed-step" }),
      pointer: createPointerSource(),
      resolution: () => [settings.outputResolution.width, settings.outputResolution.height],
      ...(valueSession === null || animator === null
        ? {}
        : {
            // T340's order, headless: channels advance, then the per-frame plan is
            // re-resolved and only changed VALUES are pushed (§V5 — a structural
            // difference is refused by the animator, never silently recompiled).
            onBeforeFrame: (inputs) => {
              const evaluated = valueSession.evaluate(request.graph, inputs.frame, {
                ...(inputs.audio === undefined ? {} : { audio: inputs.audio }),
              });
              const next = compileGraph({
                graph: request.graph,
                settings,
                registry: registry(),
                capabilities,
                resolution: { frame: inputs.frame, channels: evaluated.resolver },
              });
              animator.push(backend, plan, next);
            },
          }),
    });
    driver.setPlan(compiled);

    const captured: RenderedFrame[] = [];
    const wanted = new Set(capture);
    for (let index = 0; index < frameCount; index += 1) {
      steppingFrame = index;
      driver.step();
      if (wanted.has(index)) {
        // §V48/§V7: readback happens between frames, never inside the loop, which is why
        // `step()` exists as a separate entry point at all.
        // T173: readOutput returns the full descriptor now — width/format/stride come
        // from the thing that did the copy, not from a lookup beside it (§V60).
        const image = await backend.readOutput(outputResourceId);
        captured.push({
          frameIndex: index,
          width: image.width,
          height: image.height,
          format: image.format,
          bytes: image.bytes,
        });
      }
      request.betweenFrames?.(control, index);
    }

    return {
      frames: captured,
      plan,
      capabilities,
      readbacks: backend.status.readbacks,
      outputResourceId,
      diagnostics,
    };
  } finally {
    backend.dispose();
  }
}

/** Convenience for the common "one frame, give me the pixels" case. */
export async function renderOnce(request: HeadlessRenderRequest): Promise<RenderedFrame> {
  const result = await renderHeadless({ ...request, frames: request.frames ?? 1 });
  const first = result.frames[0];
  if (first === undefined) throw new Error("renderHeadless captured no frames.");
  return first;
}

export interface PlanRenderRequest {
  readonly host: GpuHost;
  /** A hand-written plan, for structures the node catalogue cannot express yet. */
  readonly plan: LogicalExecutionPlan;
  readonly outputResourceId: string;
  readonly size: readonly [number, number];
  readonly format: TextureFormat;
  readonly frames: number;
  readonly capture?: ReadonlyArray<number>;
  readonly fps?: number;
  readonly seed?: number;
}

/**
 * The same journey starting from a plan rather than a document.
 *
 * Needed because the node catalogue has no feedback node yet — the temporal path exists in
 * the compiler, the plan IR and the backend, but nothing in `src/nodes/definitions/**`
 * emits a `pingPong` resource, so a feedback-progression test has to describe the plan
 * directly. That is a REPORTED GAP, not an alternative style: once a feedback node lands,
 * this case should be rewritten as a `GraphDocument` like every other one.
 */
export async function renderPlanHeadless(request: PlanRenderRequest): Promise<{
  readonly frames: ReadonlyArray<RenderedFrame>;
  readonly diagnostics: ReadonlyArray<RuntimeDiagnostic>;
}> {
  const capture = [...(request.capture ?? [request.frames - 1])].sort((a, b) => a - b);
  const backend = createVgpuBackend({ host: request.host });
  const diagnostics: RuntimeDiagnostic[] = [];
  backend.onDiagnostic((diagnostic) => diagnostics.push(diagnostic));
  try {
    await backend.initialize({});
    const compiled = await backend.compile(request.plan);
    const driver = createFrameDriver({
      backend,
      transport: offlineTransport({
        fps: request.fps ?? 60,
        seed: request.seed ?? 7,
        mode: "fixed-step",
      }),
      pointer: createPointerSource(),
      resolution: () => request.size,
    });
    driver.setPlan(compiled);

    const captured: RenderedFrame[] = [];
    const wanted = new Set(capture);
    for (let index = 0; index < request.frames; index += 1) {
      driver.step();
      if (wanted.has(index)) {
        const image = await backend.readOutput(request.outputResourceId);
        captured.push({
          frameIndex: index,
          width: image.width,
          height: image.height,
          format: image.format,
          bytes: image.bytes,
        });
      }
    }
    return { frames: captured, diagnostics };
  } finally {
    backend.dispose();
  }
}
