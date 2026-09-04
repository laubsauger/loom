import { compileGraph, flattenComponents } from "../../compiler/index.ts";
import type { ComponentRegistryView } from "../../domain/components/index.ts";
import type { CompiledGraph } from "../../compiler/types.ts";
import type { BackendCapabilities, LogicalExecutionPlan } from "../../domain/types/backend.ts";
import type { TransportSource } from "../../domain/types/frame.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import { projectFps } from "../../domain/types/graph.ts";
import type { NodeDefinition, TextureFormat } from "../../domain/types/node-definition.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { createUniformAnimator } from "../../app/animate-parameters.ts";
import type { AudioFeatures } from "../../domain/types/frame.ts";
import type { FeatureTrackRecorder } from "../../domain/audio/feature-track.ts";
import type { GpuHost } from "../../runtime/backend/vgpu/gpu-host.ts";
import { analyzeChannelEntries, createAnalyzeChannels } from "../../runtime/execution/analyze-channels.ts";
import { createFrameDriver } from "../../runtime/execution/frame-driver.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import { offlineTransport } from "../../runtime/execution/offline-transport.ts";
import { createPointerSource, type PointerState } from "../../runtime/execution/pointer.ts";
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
   * T741: read these BUFFER resources back after the final frame, by plan resource id
   * (e.g. "scratch:cloud:orient"). What a §V683-shaped claim needs is the attribute
   * values a kernel actually wrote — pixels cannot testify about a quaternion — and
   * this is the one seam with both the animated value graph and the backend in hand.
   * Absent, nothing changes for any existing caller.
   */
  readonly probeBuffers?: ReadonlyArray<string>;
  /**
   * T661: FEED the pointer — the audio seam's shape, pointer edition, and the fifth
   * reader-that-cannot-see in this file's history (T630, T633, T650, T655): the source
   * below existed since T69 and nothing ever fed it, so E12-Fluid — whose every force
   * is the pointer — rendered offline as a still fluid with the blob parked at the
   * origin, and passed every gate. Returning `null` HOLDS the previous state (§V236's
   * own semantics); returning a partial updates only the named fields.
   */
  readonly pointer?: (frameIndex: number) => Partial<PointerState> | null;
  /** T661: the capture half, mirroring `recordAudio` — what the engine READ, per frame. */
  readonly recordPointer?: (frameIndex: number, state: PointerState) => void;
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
  /**
   * T715/T384: FEED a recorded inference result, per node, per frame.
   *
   * The audio seam's shape, one layer over. A gate must not run a model — it would not be
   * hermetic, and different backends give different numbers for the same input, so the
   * output is not byte-comparable across machines. What replays is the RESULT.
   *
   * Absent, every `infer:` texture gets the declared-synthetic banded stand-in, because an
   * unfed external texture renders black and silence is how this file earned five
   * reader-that-cannot-see rows. Returning `null` means "no result yet" — the state a
   * machine still acquiring a model is in, and worth gating rather than only surviving.
   */
  readonly inference?: (nodeId: string, frameIndex: number) => Uint8Array | null;
  /**
   * Extra node definitions, merged over the shipped catalogue (T715).
   *
   * The catalogue was hardcoded here, so a node under construction could not be rendered
   * offline until it shipped — which is backwards for anything whose whole risk is what
   * it looks like. Same role `components` plays for instances.
   */
  readonly nodes?: Iterable<NodeDefinition>;
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
  /** T741: the requested probeBuffers, read after the final frame, keyed by resource id. */
  readonly buffers?: Readonly<Record<string, ArrayBuffer>>;
}

function registry(extra?: Iterable<NodeDefinition>) {
  return createNodeRegistry(
    extra === undefined ? allNodeDefinitions : [...allNodeDefinitions, ...extra],
  ).view();
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

/**
 * T715/T384 — THE INFERENCE FEED, and why it is not the media test card.
 *
 * `registerSyntheticMediaSources` below claims every `media:`-prefixed external texture.
 * An inference result declares its own `infer:` namespace (`inferenceSourceIdFor`) for
 * exactly that reason: on the media prefix, a depth node would have collected DIAGONAL
 * TEST-CARD BARS in every Dawn gate — plausible, green, and wrong in a way that surfaces
 * three weeks later as "why does depth look striped". When a harness fakes a whole
 * prefix, the prefix is an interface.
 *
 * ## The stand-in is SYNTHETIC and says so
 *
 * There is no model here and there is not meant to be: a gate that downloaded 50MB and
 * ran an inference would be neither hermetic nor reproducible, because different backends
 * give different numbers for the same input. So a gate replays a RESULT — T431's contract
 * for audio, applied one seam over: what must replay identically is what the engine READ,
 * not what some upstream stage computed.
 *
 * Until a real model exists to record from, the default stand-in is a BANDED radial ramp:
 * depth-SHAPED, so a Displace downstream of it does something legible, but quantized hard
 * enough that nobody mistakes it for a monocular depth estimate. That distinction matters
 * — §V647's lesson is that tuning against a synthetic stand-in fits the stand-in's
 * distribution rather than the real one, so this is a WIRING fixture and never a
 * BEHAVIOUR one. Phase 4 replaces it with bytes recorded from a real model, through the
 * `inference` closure, which is why that closure exists before there is anything to put
 * in it.
 */
/** Derived, never spelled twice: the prefix the node compiles with is the one claimed here. */
const INFERENCE_PREFIX = inferenceSourceIdFor("");

export function syntheticInferenceFrame(
  sourceId: string,
  size: readonly [number, number],
  frameIndex: number,
  /**
   * T743: the DECLARED format, because the byte count depends on it.
   *
   * This defaulted to four bytes per texel and Pose's keypoint map is `rgba16float` —
   * eight. Dawn refused the upload outright ("Required size for texture data layout (136)
   * exceeds the linear data size (68)"), which was the lucky outcome: a stand-in that
   * happened to be the RIGHT length for the wrong format would have uploaded garbage
   * silently. A fake must be sized by the thing it is filling, not by the common case.
   */
  format: string = "rgba8unorm",
  /** T1037: shapes the fake — a matte/personMask result is a mask, not a depth map. */
  nodeType?: string,
): Uint8Array {
  const [width, height] = size;
  if (format === "rgba16float") return syntheticHalfFrame(width, height, frameIndex, sourceId);
  /* T959: the depth result is r32float — one FLOAT per texel, handed as a byte view over
     its own buffer exactly as the model runner uploads. Same banded radial picture, same
     frame-index marker in texel 0 (as a plain 0..255-scaled float, so the assertions
     keep their byte spelling). */
  if (format === "r32float") {
    /* T1037 — a MASK-shaped result gets a MASK-shaped stand-in: a soft oval "subject",
       zero outside, because the depth-shaped radial below is WRONG-SHAPED for a matte —
       multiplied as coverage it painted concentric rings over the whole frame, and the
       E52/E53 thumbnails shipped as near-identical white posters through exactly this
       third path (§V840: the oracle serves nothing, the app serves the node's neutral,
       and this harness served depth's picture to a mask). Still unmistakably synthetic,
       still salted, still frame-marked, and it drifts with the frame so downstream
       motion gates keep seeing motion. */
    if (nodeType === "matte" || nodeType === "personMask") {
      const floats = new Float32Array(width * height);
      let saltM = 0;
      for (const char of sourceId) saltM = (saltM * 31 + char.charCodeAt(0)) >>> 0;
      const cx = width * (0.5 + 0.06 * Math.sin((frameIndex + (saltM % 32)) / 9));
      const cy = height * 0.55;
      const rx = width * 0.16;
      const ry = height * 0.34;
      for (let y = 0; y < height; y += 1) {
        for (let x = 0; x < width; x += 1) {
          const d = Math.hypot((x - cx) / rx, (y - cy) / ry);
          floats[y * width + x] = d >= 1 ? 0 : Math.min(0.9, (1 - d) * 3);
        }
      }
      floats[0] = (frameIndex & 255) / 255;
      return new Uint8Array(floats.buffer);
    }
    const floats = new Float32Array(width * height);
    let salt32 = 0;
    for (const char of sourceId) salt32 = (salt32 * 31 + char.charCodeAt(0)) >>> 0;
    const cx32 = width / 2;
    const cy32 = height / 2;
    const longest32 = Math.max(1, Math.hypot(cx32, cy32));
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const distance = Math.hypot(x - cx32, y - cy32) / longest32;
        const band = Math.floor((1 - distance) * 8 + frameIndex + (salt32 % 8)) % 8;
        floats[y * width + x] = (((band + 8) % 8) * 32) / 255;
      }
    }
    floats[0] = (frameIndex & 255) / 255;
    return new Uint8Array(floats.buffer);
  }
  const bytes = new Uint8Array(width * height * 4);
  let salt = 0;
  for (const char of sourceId) salt = (salt * 31 + char.charCodeAt(0)) >>> 0;
  const cx = width / 2;
  const cy = height / 2;
  const longest = Math.max(1, Math.hypot(cx, cy));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const distance = Math.hypot(x - cx, y - cy) / longest;
      // Eight hard bands, drifting one band per frame: near is bright, far is dark, which
      // is the convention a depth map carries and the one Displace reads.
      const band = Math.floor((1 - distance) * 8 + frameIndex + (salt % 8)) % 8;
      const level = ((band + 8) % 8) * 32;
      const offset = (y * width + x) * 4;
      bytes[offset] = level;
      bytes[offset + 1] = level;
      bytes[offset + 2] = level;
      bytes[offset + 3] = 255;
    }
  }
  // Row 0, first pixel: the frame index, so "the result is f(frame)" is assertable to the
  // byte and an off-by-one is visible rather than plausible (the media card's own trick).
  bytes[0] = frameIndex & 255;
  bytes[1] = (frameIndex >> 8) & 255;
  bytes[2] = 85;
  bytes[3] = 255;
  return bytes;
}

/** IEEE-754 binary16, for the stand-in that fills a half-float target. */
function halfBits(value: number): number {
  const view = new DataView(new ArrayBuffer(4));
  view.setFloat32(0, value, true);
  const bits = view.getUint32(0, true);
  const sign = (bits >>> 16) & 0x8000;
  let exponent = (bits >>> 23) & 0xff;
  let mantissa = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00;
  exponent = exponent - 127 + 15;
  if (exponent >= 0x1f) return sign | 0x7c00;
  if (exponent <= 0) {
    if (exponent < -10) return sign;
    mantissa = (mantissa | 0x800000) >>> (1 - exponent);
    return sign | (mantissa >>> 13);
  }
  return sign | (exponent << 10) | (mantissa >>> 13);
}

/**
 * The half-float stand-in — for Pose, a spread of plainly synthetic keypoints.
 *
 * Deliberately a diagonal march rather than anything body-shaped: a plausible skeleton
 * would be the §V147 failure the Pose node's identity argument exists to refuse, and a
 * gate's fake must never be mistakable for a measurement.
 */
function syntheticHalfFrame(
  width: number,
  height: number,
  frameIndex: number,
  sourceId: string,
): Uint8Array {
  const bytes = new Uint8Array(width * height * 8);
  const view = new DataView(bytes.buffer);
  let salt = 0;
  for (const char of sourceId) salt = (salt * 31 + char.charCodeAt(0)) >>> 0;
  const count = width * height;
  for (let i = 0; i < count; i += 1) {
    const t = (i + frameIndex + (salt % 7)) / Math.max(1, count);
    view.setUint16(i * 8, halfBits(t), true);
    view.setUint16(i * 8 + 2, halfBits(1 - t), true);
    view.setUint16(i * 8 + 4, halfBits(1), true);
    view.setUint16(i * 8 + 6, halfBits(1), true);
  }
  return bytes;
}

/**
 * Registers a result source for every `infer:` external texture the plan declares.
 *
 * Registering by DEFAULT is the point. An unfed external texture keeps its contents —
 * black — so a depth node in a Dawn gate would render nothing, silently, which is the
 * reader-that-cannot-see family (T630, T633, T650, T655, T661) that this file's history
 * is made of. Those are all closed; inference must not reopen one.
 *
 * A `feed` returning `null` means "no result for this frame", which is a real state worth
 * gating: it is what a machine still acquiring the model shows, and the node must render
 * its identity fallback rather than a hole.
 */
export function registerInferenceSources(
  backend: {
    registerMediaSource(
      sourceId: string,
      source: { currentFrame(): { frameId: number; bytes: Uint8Array } | undefined },
    ): () => void;
  },
  plan: CompiledGraph,
  frameOf: () => number,
  feed: ((nodeId: string, frameIndex: number) => Uint8Array | null) | undefined,
  /** T1037 — the node's TYPE, so the stand-in can be SHAPED like the result it fakes. */
  nodeTypeOf?: (nodeId: string) => string | undefined,
): void {
  for (const resource of plan.resources) {
    const entry = resource as {
      kind?: string;
      sourceId?: string;
      size?: readonly [number, number];
      format?: string;
    };
    if (entry.kind !== "externalTexture" || entry.sourceId === undefined || entry.size === undefined) continue;
    if (!entry.sourceId.startsWith(INFERENCE_PREFIX)) continue;
    const sourceId = entry.sourceId;
    const nodeId = sourceId.slice(INFERENCE_PREFIX.length);
    const size = entry.size;
    const format = entry.format ?? "rgba8unorm";
    backend.registerMediaSource(sourceId, {
      currentFrame: () => {
        const frameId = frameOf();
        const recorded = feed?.(nodeId, frameId);
        if (recorded === null) return undefined;
        return {
          frameId,
          bytes:
            recorded ??
            syntheticInferenceFrame(sourceId, size, frameId, format, nodeTypeOf?.(nodeId)),
        };
      },
    });
  }
}

/**
 * Registers a test-card source for every MEDIA external texture, except text's.
 *
 * T715: it claims the `media:` prefix and ONLY that prefix. It used to register a card
 * for every external texture whatever its sourceId, which was harmless while media was
 * the only producer and became wrong the moment a second one existed — an inference
 * result would have rendered diagonal bars in every Dawn gate. The prefix is the
 * interface between the two feeds, so it is checked rather than assumed.
 */
export function registerSyntheticMediaSources(
  backend: { registerMediaSource(sourceId: string, source: { currentFrame(): { frameId: number; bytes: Uint8Array } | undefined }): () => void },
  plan: CompiledGraph,
  graph: GraphDocument,
  frameOf: () => number,
): void {
  for (const resource of plan.resources) {
    const entry = resource as { kind?: string; sourceId?: string; size?: readonly [number, number] };
    if (entry.kind !== "externalTexture" || entry.sourceId === undefined || entry.size === undefined) continue;
    if (!entry.sourceId.startsWith("media:")) continue;
    const nodeId = entry.sourceId.slice("media:".length);
    if (graph.nodes[nodeId as keyof typeof graph.nodes]?.type === "text") continue;
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

/**
 * T1132: the longest the frame loop may hold the event loop before letting the process
 * answer for itself. See the long note at the yield, in the loop below.
 *
 * EXPORTED so `harness-event-loop.test.ts` derives its bound from the promise rather than
 * restating a number: the gate's claim is "no gap longer than this", and if the value moves
 * the gate moves with it.
 */
export const FRAME_LOOP_YIELD_MS = 1_000;

export async function renderHeadless(request: HeadlessRenderRequest): Promise<HeadlessRenderResult> {
  const settings = request.settings ?? paritySettings();
  const frameCount = request.frames ?? 1;
  const capture = [...(request.capture ?? [frameCount - 1])].sort((a, b) => a - b);
  const outputNodeId = request.outputNodeId ?? OUTPUT_NODE_ID;
  // T933: the DOCUMENT's rate when the request does not override it. A bare `?? 60`
  // here rendered a 30 fps document at 60 and called the result a parity baseline.
  const fps = request.fps ?? projectFps(settings);

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
            registry: registry(request.nodes),
            components: request.components,
          });
    /** What the value graph and every compile read. §V437: the raw document is not it. */
    const logicalGraph = flattened?.graph ?? request.graph;

    const plan = compileGraph({
      graph: request.graph,
      settings,
      registry: registry(request.nodes),
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
    // T715: the inference feed, beside the media one and claiming a different prefix.
    registerInferenceSources(
      backend,
      plan,
      () => steppingFrame,
      request.inference,
      (nodeId) => logicalGraph.nodes[nodeId as keyof typeof logicalGraph.nodes]?.type,
    );

    const control: HarnessControl = {
      resize: (outputId, size) => {
        backend.resize(outputId, size);
      },
      outputResourceId,
      plan,
    };
    request.beforeFrames?.(control);

    /**
     * T655 — THE ANALYZE SEAM. The fourth reader-that-cannot-see in this file's own
     * history (T630: compiler warnings unreturned; T633: the oracle with no channel
     * resolver; T650: no media sources): the app has fed analyze readbacks into driven
     * parameters since T236, and this harness never built the channel store — so every
     * offline render of an analyze-driven document ran on fallbacks and reported green.
     *
     * Wired only under `animate` (the only consumer of channels here — a static render
     * must not pay readbacks it cannot read, and `result.readbacks` is asserted by §V7
     * gates). The seam samples between frames exactly where the app does, then AWAITS
     * the readbacks it issued — the live path lets them land whenever they land, but a
     * deterministic render must not race its own copies (§V44/§V45). §V144's shape
     * survives intact: frame N's value becomes visible to frame N+1, never to frame N,
     * so the one-frame latency is assertable offline instead of merely believed.
     */
    const analyzeEntries =
      request.animate === true
        ? (() => {
            const allocated = new Set(plan.resources.map((resource) => resource.id));
            return analyzeChannelEntries(logicalGraph, registry(request.nodes)).filter((entry) =>
              allocated.has(entry.resourceId),
            );
          })()
        : [];
    const analyze =
      analyzeEntries.length === 0
        ? null
        : createAnalyzeChannels({
            // B161: the harness awaits `sample()`'s own returned chain, so it no longer
            // tracks the raw readback promise separately — that split await was the phase
            // shift.
            readBuffer: (resourceId) => backend.readBuffer(resourceId),
          });
    analyze?.track(analyzeEntries);

    const valueSession = request.animate === true ? createValueGraphSession(registry(request.nodes)) : null;
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

    // T661: ONE pointer source, hoisted so the loop below can feed it — the same object
    // the driver publishes into `frameU.pointer` and `inputs.pointer`, never a second.
    const pointerSource = createPointerSource();
    /** T791: per-frame compile errors, deduped, with the first frame each appeared on. */
    const perFrameErrors = new Map<string, { frameIndex: number; diagnostic: RuntimeDiagnostic }>();
    const driver = createFrameDriver({
      backend,
      ...(audioSeam === undefined ? {} : { audio: audioSeam }),
      // §V45: the seed is the project's, not the transport's own invention.
      transport: offlineTransport({ fps, seed: settings.randomSeed, mode: "fixed-step" }),
      pointer: pointerSource,
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
                // T661/§V182: the SAME pointer the shaders read — the app passes
                // `inputs.pointer` here (use-value-graph.ts) and this harness never
                // did, so a `mouse` node evaluated to zeros even when a test fed the
                // driver's source.
                pointer: inputs.pointer,
                ...(inputs.audio === undefined ? {} : { audio: inputs.audio }),
                // T655/T654: analyze readbacks enter the value graph here — the same
                // extras.channels seam `useValueGraph` threads live, number-narrowed
                // the same way.
                ...(analyze === null
                  ? {}
                  : {
                      channels: (name: string): number | undefined => {
                        const value = analyze.resolver(name, { frame: inputs.frame } as never);
                        return typeof value === "number" ? value : undefined;
                      },
                    }),
              });
              const next = compileGraph({
                graph: request.graph,
                settings,
                registry: registry(request.nodes),
                capabilities,
                ...(flattened === undefined ? {} : { flattened }),
                resolution: {
                  frame: inputs.frame,
                  // Analyze FIRST, exactly as the app merges its resolvers: a measured
                  // channel outranks a value-graph channel of the same name.
                  channels:
                    analyze === null
                      ? evaluated.resolver
                      : (name, context) => analyze.resolver(name, context) ?? evaluated.resolver(name, context),
                },
              });
              /*
               * T791 — the per-frame plan's diagnostics are READ, not just pushed.
               *
               * `next` used to go straight to `animator.push` and nobody looked at its
               * diagnostics — the fifth reader-that-cannot-see in this file's history
               * (T630, T633, T650, T655 above): a per-frame ERROR was structurally
               * invisible to every animated gate. B155 is the defect class this hides —
               * a driven parameter whose validation errors on a live value errored here
               * on the exact frames the signal peaked, and 935 tests stayed green while
               * the app blacked out on the same diagnostics. Deduped by identity because
               * the same error usually fires every frame; the throw after the loop names
               * the first frame each one appeared on.
               */
              for (const diagnostic of next.diagnostics) {
                if (diagnostic.severity !== "error") continue;
                const key = `${diagnostic.code}|${diagnostic.nodeId ?? ""}|${diagnostic.message}`;
                if (!perFrameErrors.has(key)) {
                  perFrameErrors.set(key, { frameIndex: inputs.frame.frameIndex, diagnostic });
                }
              }
              animator.push(backend, plan, next);
            },
          }),
    });
    driver.setPlan(compiled);

    const captured: RenderedFrame[] = [];
    const wanted = new Set(capture);
    let lastYield = Date.now();
    for (let index = 0; index < frameCount; index += 1) {
      /**
       * ⚑ T1132/B150 — THE LOOP LETS THE PROCESS BREATHE, AND THAT IS NOT A COURTESY.
       *
       * A render with no Analyze node and one captured frame awaits NOTHING between
       * `driver.step()` calls, so the whole render is ONE uninterrupted block of the
       * event loop. Measured as a SET, same machine, back to back, E54 at its shipped
       * sixty-second horizon (3600 frames) — a 100 ms interval watching for its own ticks:
       *
       *   yield disabled     wall 36.3s   worst-uninterrupted-block 35.7s
       *   yield at 5000 ms   wall 33.8s   worst-uninterrupted-block  5.1s
       *   yield at 1000 ms   wall 25.7s   worst-uninterrupted-block  1.0s
       *
       * The render was the block, ALL of it, and the yield bounds it at the constant. The
       * walls say the yield is not paid for: the shortest run of the three is the one that
       * yields most often, so the spread is run-to-run noise and the interval was chosen for
       * margin rather than traded against throughput.
       *
       * A Node process that does not turn its loop for half a minute cannot answer
       * anything, and thirty-six seconds idle is the FLOOR: the quorum file renders this
       * twelve times while the rest of the suite runs on the other workers, and the block
       * stretches with the contention. That is exactly why `pnpm test` failed and the file
       * alone passed. Under Vitest a long enough block is a hard failure with no failing
       * test:
       *
       *  - the worker calls `onTaskUpdate` on the main process, and birpc arms a timer for
       *    the reply (`birpc`'s `DEFAULT_TIMEOUT = 6e4`, bundled in
       *    `vitest/dist/chunks/index.*.js`). The reply arrives on time and sits UNREAD in
       *    the channel, because the loop is blocked. When the block ends Node runs the
       *    TIMERS phase before the POLL phase, so the expired timeout wins the race against
       *    a message already in the queue;
       *  - `@vitest/runner`'s `updateTask` stores that promise in a module-level
       *    `previousUpdate` from inside a `setTimeout` and does not await it until the NEXT
       *    task update, so the rejection is unhandled when it lands. Vitest exits non-zero
       *    reporting `Timeout calling "onTaskUpdate"` while every test in the file passed.
       *    §B150's shape exactly: a red nobody owns, on the one command that is supposed
       *    to say everything is fine.
       *
       * NOT REACHABLE FROM CONFIG, and this was checked rather than assumed: Vitest 2.1.9's
       * `createForksRpcOptions` returns `{serialize, deserialize, post, on}` and no
       * `timeout`, and `createRuntimeRpc` spreads it over options that set none either, so
       * birpc's 60 000 ms default stands and no vitest setting reaches it.
       *
       * NOR WOULD A PROJECT SPLIT, which is the shape this was first reported as: giving
       * `*.gpu.test.ts` its own project (or its own worker, or `fileParallelism: false`)
       * only changes which files share a worker. The block is ONE TEST'S ONE RENDER inside
       * one worker, and that worker is the one that must answer.
       *
       * The independent reason, which would stand with no runner at all: Vitest's per-test
       * timeout is a timer too, so it cannot fire during the block either. A render that
       * genuinely hangs here is undetectable for as long as it holds the loop.
       *
       * TIME, not a frame count: what must stay bounded is the WALL GAP, and it inflates
       * with machine load, which a frame count cannot see. One second is a sixtieth of the
       * deadline it protects, and the measurements above say the ~35 extra turns it costs
       * across a 3600-frame render are free.
       *
       * ⚑ A TIMER, AND SPECIFICALLY NOT `setImmediate` — WHICH IS WHERE THIS LANDED FIRST.
       * Measured on the fixture in `harness-event-loop.test.ts`, which watches one observer
       * per phase for exactly this reason:
       *
       *  - `await Promise.resolve()` is no yield at all. A resolved promise never leaves the
       *    MICROTASK queue, so it reaches no phase of the loop: messages sat unread for the
       *    whole 2.2 s render;
       *  - `setImmediate` resumes in the CHECK phase. The loop passes through POLL on the
       *    way, so the pending reply IS read — and this looked like a fix — but it never
       *    reaches the TIMERS phase, and a `setInterval` observer sat silent for the entire
       *    render underneath it. Nothing that EXPIRES can fire in a phase never reached,
       *    which is the half that keeps a hung render detectable at all;
       *  - `setTimeout(…, 0)` resumes in TIMERS, and control returns to the loop at the NEXT
       *    yield — from inside that phase, so the loop then completes it and goes on through
       *    poll. Both observers stay inside the bound. That is this line.
       *
       * (§V48: between frames is the sanctioned window, which is where the Analyze path
       * already awaits.)
       *
       * NOT COPIED into `renderPlanHeadless` below, deliberately: it has the same unyielding
       * shape, but its callers render tens of frames, so it has never held the loop long
       * enough to starve anything and there is nothing to measure. Should one of them grow a
       * long horizon, this is the line it needs and `harness-event-loop.test.ts` is the gate
       * it needs pointing at it — not a second copy invented from scratch.
       */
      if (Date.now() - lastYield >= FRAME_LOOP_YIELD_MS) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        lastYield = Date.now();
      }
      steppingFrame = index;
      // T661: the pointer for THIS frame is set before the step that reads it, and
      // what gets recorded is the state the engine actually read — the audio seam's
      // record-what-crossed contract, pointer edition.
      if (request.pointer !== undefined) {
        const next = request.pointer(index);
        if (next !== null) pointerSource.set(next);
      }
      driver.step();
      request.recordPointer?.(index, pointerSource.state);
      if (analyze !== null) {
        // Between frames, §V48's sanctioned window — await the whole sample chain (B161),
        // guard-clear included, so the value frame N+1 reads is frame N's reduction by
        // construction, and the in-flight guard is clear before the next sample. Awaiting
        // the FULL chain (not the raw readback) is the fix: it stops a captured frame's
        // extra readback microtasks from shifting the sampling phase.
        await analyze.sample(index);
      }
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

    // T791: a per-frame error fails the render the way a structural one does — loudly,
    // naming the frame it first appeared on. Green frames over a broken per-frame plan
    // are exactly what this harness existed to prevent.
    if (perFrameErrors.size > 0) {
      const lines = [...perFrameErrors.values()].map(
        (entry) => `frame ${entry.frameIndex}: ${entry.diagnostic.code}: ${entry.diagnostic.message}`,
      );
      throw new Error(`Per-frame compile produced errors:\n${lines.join("\n")}`);
    }

    const probed: Record<string, ArrayBuffer> = {};
    for (const resourceId of request.probeBuffers ?? []) {
      probed[resourceId] = await backend.readBuffer(resourceId);
    }

    return {
      frames: captured,
      plan,
      capabilities,
      readbacks: backend.status.readbacks,
      outputResourceId,
      ...(request.probeBuffers === undefined ? {} : { buffers: probed }),
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
      // T933: a plan render has no document to ask, so this is the default APPLIED
      // ONCE rather than another literal 60.
      fps: projectFps(request.fps === undefined ? {} : { fps: request.fps }),
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
