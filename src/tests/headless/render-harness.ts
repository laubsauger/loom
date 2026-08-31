import { compileGraph, flattenComponents } from "../../compiler/index.ts";
import type { ComponentRegistryView } from "../../domain/components/index.ts";
import type { CompiledGraph } from "../../compiler/types.ts";
import type { BackendCapabilities, LogicalExecutionPlan } from "../../domain/types/backend.ts";
import type { TransportSource } from "../../domain/types/frame.ts";
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
  /**
   * The component catalogue (T615, §V47).
   *
   * This harness is the OFFLINE half of §V47's "same graph, same compiler" claim, and it
   * never passed one — so an instance fell through to `component.notFlattened` and no
   * offline render of a component document has ever been possible. The live path and this
   * one therefore agreed about animated components only because BOTH were broken. Supplied
   * here, one flattening is produced per render and handed to every compile below, exactly
   * as `app/flattened-graph.ts` does for the live session.
   */
  readonly components?: ComponentRegistryView;
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
  /**
   * Everything the COMPILER and the backend reported, in that order. A silent
   * diagnostic is a silently broken render — and this harness is what every example
   * agent verifies with, so it must not be quieter than the app's problems pane (T630:
   * backend-only reporting let three builds ship believing substeps worked while a
   * `compiler/substeps-refused` warning sat unread on `plan.diagnostics` and the render
   * was byte-identical to one step).
   */
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
  /** T615: the component catalogue. Omitted, an instance does not flatten (§V82, B29). */
  components?: ComponentRegistryView,
): CompiledGraph {
  return compileGraph({
    graph,
    settings,
    registry: registry(),
    capabilities,
    ...(components === undefined ? {} : { components }),
  });
}


/**
 * T650 — DETERMINISTIC STAND-INS FOR MEDIA SOURCES.
 *
 * This harness contained zero occurrences of `registerMediaSource`, so `webcam` and
 * `movieFileIn` rendered NOTHING, silently, in every Dawn test — every example gate and
 * look pass over a document containing media was measuring a blank and reporting green.
 * The third reader-that-cannot-see in this file's own history (T630: compiler warnings
 * unreturned; T633: the oracle with no channel resolver).
 *
 * The stand-in is a TEST CARD, deliberately unmistakable for a capture (§V44 determinism
 * AND obviously synthetic): saturated diagonal bars whose phase advances with the frame,
 * salted per sourceId so two sources never match — and the first pixels of row 0 encode
 * the FRAME INDEX in bytes, so "the playhead is f(frame)" is assertable to the byte and
 * an off-by-one is visible rather than plausible.
 *
 * `text` is deliberately NOT faked (§V403): its pixels come from the browser's font
 * stack rasterizing into a canvas, and headless has no font stack — black is the honest
 * output of a machine that genuinely cannot draw it, and a fake glyph card would teach
 * that text works where it does not. The media gate states that absence by name.
 */
export function syntheticMediaFrame(
  sourceId: string,
  size: readonly [number, number],
  frameIndex: number,
): Uint8Array {
  const [width, height] = size;
  const bytes = new Uint8Array(width * height * 4);
  let salt = 0;
  for (const char of sourceId) salt = (salt * 31 + char.charCodeAt(0)) >>> 0;
  const bands: ReadonlyArray<readonly [number, number, number]> = [
    [236, 32, 199], // magenta
    [32, 221, 236], // cyan
    [242, 226, 55], // yellow
    [24, 24, 28], // near-black gap, so the bars read as bars
  ];
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const band = bands[(Math.floor((x + y + frameIndex * 3 + salt) / 16) % 4 + 4) % 4] ?? bands[0]!;
      const offset = (y * width + x) * 4;
      bytes[offset] = band[0];
      bytes[offset + 1] = band[1];
      bytes[offset + 2] = band[2];
      bytes[offset + 3] = 255;
    }
  }
  // Row 0, first two pixels: the frame index, little-endian across the channels.
  bytes[0] = frameIndex & 255;
  bytes[1] = (frameIndex >> 8) & 255;
  bytes[2] = 170;
  bytes[3] = 255;
  return bytes;
}

/** Registers a test-card source for every external texture the plan declares, except text's. */
function registerSyntheticMediaSources(
  backend: { registerMediaSource(sourceId: string, source: { currentFrame(): { frameId: number; bytes: Uint8Array } | undefined }): () => void },
  plan: CompiledGraph,
  graph: GraphDocument,
  frameOf: () => number,
): void {
  for (const resource of plan.resources) {
    const entry = resource as { kind?: string; sourceId?: string; size?: readonly [number, number] };
    if (entry.kind !== "externalTexture" || entry.sourceId === undefined || entry.size === undefined) continue;
    const nodeId = entry.sourceId.startsWith("media:") ? entry.sourceId.slice("media:".length) : undefined;
    if (nodeId !== undefined && graph.nodes[nodeId as keyof typeof graph.nodes]?.type === "text") continue;
    const sourceId = entry.sourceId;
    const size = entry.size;
    backend.registerMediaSource(sourceId, {
      currentFrame: () => {
        const frameId = frameOf();
        return { frameId, bytes: syntheticMediaFrame(sourceId, size, frameId) };
      },
    });
  }
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

    /**
     * T615: ONE flattening, produced once and reused by the structural compile and every
     * per-frame one — the same shape the live session has (`app/flattened-graph.ts`).
     * Without it the offline path either does not flatten at all (today) or re-flattens
     * 60 times a second, which is the regression the memo exists to avoid (§V529).
     */
    const flattened =
      request.components === undefined
        ? undefined
        : flattenComponents({
            graph: request.graph,
            registry: registry(),
            components: request.components,
          });
    /** What the value graph and every compile read. §V437: the raw document is not it. */
    const logicalGraph = flattened?.graph ?? request.graph;

    const plan = compileGraph({
      graph: request.graph,
      settings,
      registry: registry(),
      capabilities,
      ...(flattened === undefined ? {} : { flattened }),
    });
    const errors = plan.diagnostics.filter((d) => d.severity === "error");
    if (errors.length > 0) {
      throw new Error(`Parity graph failed to compile: ${errors.map((d) => d.message).join("; ")}`);
    }

    const outputResourceId = outputResourceIdOf(plan, outputNodeId);
    const compiled = await backend.compile(plan);

    // T650: media draws SOMETHING attributable in headless, or nothing by stated design.
    registerSyntheticMediaSources(backend, plan, logicalGraph, () => steppingFrame);

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
              // T615: the FLATTENED document, and the SAME one every frame — so a value
              // node inside a component evaluates here exactly as it does live.
              const evaluated = valueSession.evaluate(logicalGraph, inputs.frame, {
                ...(inputs.audio === undefined ? {} : { audio: inputs.audio }),
              });
              const next = compileGraph({
                graph: request.graph,
                settings,
                registry: registry(),
                capabilities,
                ...(flattened === undefined ? {} : { flattened }),
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
      // Compiler diagnostics FIRST: they are about the plan the render ran, and the
      // errors among them already threw above — what travels here is the warnings,
      // which are exactly what a byte-identical-but-wrong render hides (T630).
      diagnostics: [...plan.diagnostics, ...diagnostics],
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

/** What a `renderPlanHeadless` caller may do between frames (T464). */
export interface PlanRenderLevers {
  /** The clock. `wrapTo` is a lap; `reset` is the rewind half of a seek. */
  readonly transport: TransportSource;
  /** The state half of a seek (§V170/§V181) — what a lap must NOT do. */
  resetTemporalHistory(): void;
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
  /**
   * Runs after each frame, with the two levers a lap and a seek differ by (T464).
   *
   * Exposed so a test can WRAP the timeline mid-run — the lap a looping timeline takes —
   * and look at the pixels on the other side of it, and so the same test can perform the
   * CLEAR a seek does instead and show the difference. That pairing is the only way the
   * claim can be made: a feedback that resets at the wrap still renders a moving picture,
   * so only the accumulated value across the boundary tells the two apart (§V147).
   */
  readonly betweenFrames?: (levers: PlanRenderLevers, frameIndex: number) => void;
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
    const transport = offlineTransport({
      fps: request.fps ?? 60,
      seed: request.seed ?? 7,
      mode: "fixed-step",
    });
    const driver = createFrameDriver({
      backend,
      transport,
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
      request.betweenFrames?.(
        {
          transport,
          resetTemporalHistory: () => {
            backend.resetTemporalHistory();
          },
        },
        index,
      );
    }
    return { frames: captured, diagnostics };
  } finally {
    backend.dispose();
  }
}
