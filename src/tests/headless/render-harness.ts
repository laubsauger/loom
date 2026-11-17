import { compileGraph, compiledWithoutCatalogue, flattenComponents, timelineStructureRequest } from "../../compiler/index.ts";
import type { CompileRequest } from "../../compiler/types.ts";
import type { ComponentRegistryView } from "../../domain/components/index.ts";
import { createComponentAwareRegistry } from "../../domain/components/index.ts";
import type { CompiledGraph } from "../../compiler/types.ts";
import type { BackendCapabilities, LogicalExecutionPlan } from "../../domain/types/backend.ts";
import type { TransportSource } from "../../domain/types/frame.ts";
import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";
import { diagnosticClass, leavesPlanUsable, stopsFinalRender, type DiagnosticClass } from "../../domain/diagnostics/classes.ts";
import { describeFinding, documentFindings } from "../../compiler/document-findings.ts";
import { isParameterSlot } from "../../domain/parameters/slots.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import { projectFps } from "../../domain/types/graph.ts";
import type { NodeDefinition, TextureFormat } from "../../domain/types/node-definition.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { meshSourceIdsFor, prepareMesh, type PreparedMesh } from "../../points/mesh.ts";
import type { MeshFrame } from "../../domain/mesh/glb.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { createValueGraphSession } from "../../domain/channels/value-graph.ts";
import { buildMorphIndex } from "../../domain/presets/morph-index.ts";
import { buildTimelineStructure, type TimelineStructureState } from "../../domain/presets/timeline-cues.ts";
import type { ChannelResolver } from "../../domain/parameters/resolve.ts";
import { createUniformAnimator } from "../../app/animate-parameters.ts";
import type { AudioFeatures } from "../../domain/types/frame.ts";
import type { FeatureTrackRecorder } from "../../domain/audio/feature-track.ts";
import type { GpuHost } from "../../runtime/backend/vgpu/gpu-host.ts";
import type { AccumulatedSum, LinearDecode, OutputAccumulator } from "../../runtime/backend/backend-types.ts";
import type { ColorSpace } from "../../domain/types/ports.ts";
import { analyzeChannelEntries, analyzeOperationOf, createAnalyzeChannels } from "../../runtime/execution/analyze-channels.ts";
import { NO_INSTANCES, NO_PAGES } from "../../domain/parameters/node-references.ts";
import { createFrameDriver } from "../../runtime/execution/frame-driver.ts";
import { inferenceSourceIdFor } from "../../runtime/execution/inference-sources.ts";
import { offlineTransport } from "../../runtime/execution/offline-transport.ts";
import { documentTempo } from "../../domain/tempo/project-tempo.ts";
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
  /** How many frames to step. Frame indices are 0..frames-1 (after a `warmup` run-up's, which are negative). */
  readonly frames?: number;
  /** Which frame indices to read back. Defaults to the last frame only. */
  readonly capture?: ReadonlyArray<number>;
  readonly outputNodeId?: string;
  /**
   * §T1311b(a): WHICH PORT of `outputNodeId` to read back. A node can publish more than one
   * row — a customWgsl marcher that declares a view camera publishes its authored output
   * AND its `out#view` viewport — and "the first row with this node id" cannot tell them
   * apart. Absent keeps the historical behaviour (the first row for the node).
   */
  readonly outputPortId?: string;
  /**
   * §T1311b(a): the PREVIEW SINK set, exactly as the editor publishes it.
   *
   * Absent, a headless render has none — which is the state every export, thumbnail and
   * claims run is in, and the reason a viewport does not exist in any of them. Supplying it
   * is how a test can stand where the editor stands and assert what the editor gets.
   */
  readonly sinks?: ReadonlyArray<{ readonly nodeId: string; readonly portId: string }>;
  /**
   * §T1391b: DISPLAY sinks to treat as shown — a Window Out renders only while the app
   * names it (its window is open), so a render of one has to stand where the app stands.
   */
  readonly displaySinks?: ReadonlyArray<string>;
  readonly fps?: number;
  /**
   * The transport's first frame: frame index 0 of this render lands at `startFrame / fps`
   * (offlineTransport's own `startFrame`). Default 0. A render that starts mid-shot steps
   * from there instead of rendering every earlier frame unseen.
   */
  readonly startFrame?: number;
  /**
   * T1497b: the absolute clock's EPOCH every frame of this render counts in
   * (`FrameEvaluationInput.absEpoch`). A preset morph record fades only for frames of its
   * own epoch, so a gate that wants to see a fade stands where the live session stands and
   * names the epoch its record was stamped with. Absent — every export, every thumbnail,
   * every other gate — frames carry none and each record is finished: the end state.
   */
  readonly absEpoch?: string;
  /**
   * T1435b: the caller averages this many consecutive frames into one output frame, so
   * `fps` is the SUB-frame rate. Every frame then reports `fps / subframes` as the project
   * rate and `subframes` itself, which an expression reads (`fps`, `subframes`). Default 1.
   */
  readonly subframes?: number;
  /**
   * §V47's control knob. Supplying a canvas must not change a single byte — the backend
   * documents that it creates no surface either way — so the parity suite runs the same
   * graph with and without one and compares.
   */
  readonly canvas?: HTMLCanvasElement;
  /** Called once after compile, before any frame. Used by the resize case. */
  readonly beforeFrames?: (control: HarnessControl) => void;
  /**
   * Called after frame `at`, before the next step. Used by the resize case. A returned
   * promise is awaited (T1745b: a decoder fills the next frame's movie bytes here, run-up
   * frames included), and a run-up frame's index is negative.
   */
  readonly betweenFrames?: (control: HarnessControl, frameIndex: number) => void | Promise<void>;
  /**
   * T1745b — A RUN-UP: frames stepped BEFORE frame 0 and never read back, so the history a
   * feedback, a cache, a simulation or a stateful value node carries into frame 0 is the one
   * those frames built. Called once with the first compiled plan (what holds state is the
   * plan's to say); it returns how many frames. The transport starts that many frames before
   * `startFrame`, so frame 0 still lands on `startFrame / fps`, and with a run-up of
   * `startFrame` the render steps exactly the frames a render from 0 steps: frame 0 here IS
   * that render's frame `startFrame`. A run-up frame's index is negative (−n … −1) wherever
   * a callback is told the frame; nothing can capture or probe one. It may not reach before
   * the timeline's frame 0. Absent: no run-up, the render starts cold at frame 0.
   */
  readonly warmup?: (plan: CompiledGraph) => number;
  /**
   * T1739b — SUM THE CAPTURED FRAMES ON THE GPU instead of reading each one back. Every
   * captured frame is added, in linear light, to a float sum of the read output
   * (`LoomBackend.accumulateOutput`), and every `every` captures the sum is read back ONCE,
   * handed to `onSum` and zeroed. `decode` gets the read output's format, declared space,
   * size and the device's limits; returning undefined reads each captured frame back to
   * `onCapture` instead, as without this option. The capture count must be a multiple of
   * `every`.
   */
  readonly accumulate?: {
    readonly every: number;
    readonly decode: (output: AccumulateTarget) => LinearDecode | undefined;
    readonly onSum: (sum: AccumulatedSum & { readonly frameIndex: number }) => void | Promise<void>;
  };
  /**
   * T442 (T431's skeleton): evaluate the VALUE GRAPH each frame and push driven
   * parameter values through the animator before the encode — the live app's T340
   * order, headless. Off by default: a static render must not pay for a value session
   * it does not use, and every existing caller keeps its exact behaviour.
   */
  readonly animate?: boolean;
  /**
   * §T1641b: the `local` findings this render EXPECTS, by code.
   *
   * A stored thing that can never take effect is an ERROR, and an error stops a headless
   * render, so a script that reads no diagnostics still does not trust the file (§B262). A
   * fallback's own test renders a broken document on purpose: it names the finding, and gets
   * it back in `diagnostics` beside the frames. Only a finding that leaves the plan usable
   * can be named (`leavesPlanUsable`), and a named finding the render never produces fails
   * it: an expectation nothing meets is a test that stopped testing.
   */
  readonly expectedFindings?: ReadonlyArray<string>;
  /**
   * §T1641b slice 3: A FINAL RENDER'S RULE. The frames are about to be trusted (a film
   * frame, a thumbnail, a measurement), so the render fails on everything
   * `stopsFinalRender` names, wherever it was said: of the document at rest, by the
   * structural plan, by the device, and AT ANY FRAME. That is every error; everything that
   * can never take effect, a payload a slot only keeps included; everything still waiting
   * (a channel not published at that frame: a final render has no "later"); an expression
   * with no finite answer at a frame; and a code nobody classed. And it refuses to render a
   * document that holds expression slots with `animate` off, which would be frames of
   * stored values.
   *
   * Off, the default, a render stops on an error and returns the rest in `findings`: a
   * document that reads a live publisher this process does not have (a Person Mask's
   * `coverage`) is a legitimate thing to render and measure. A finding named in
   * `expectedFindings` is let through either way.
   */
  readonly strict?: boolean;
  /**
   * T1604b: one device render pass PER DRAW (`backend.setExactPassTiming(true)`), the way
   * every frame was encoded before a run of draws shared a pass. The picture must be the
   * same either way, which is what a test renders both for.
   */
  readonly exactPassTiming?: boolean;
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
   * T1585b: read `probeBuffers` at THESE frame indices as well, each right after its own
   * frame is stepped (between frames, §V48's window) and before `betweenFrames` runs for it.
   *
   * A claim about how a simulation MOVES — nothing jumps from one frame to the next, a
   * strand never stretches on the way — is about every frame, and the probe above sees only
   * the last. The one way to ask it of an earlier frame was to render the whole sequence
   * again one frame shorter, which is a different run. Each index must be a frame this
   * render steps, and there must be buffers to read: a probe that could come back empty in
   * silence would be a gate that cannot fail.
   */
  readonly probeFrames?: ReadonlyArray<number>;
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
  /**
   * T1353b — GLB bytes per Mesh File In node id. Each one is prepared through
   * `prepareMesh` — the app loader's own path — under the node's Select, and fed to the
   * node's two sources. T1416b: the harness MEASURES as the app's loader does — the node's
   * Vertices, Triangles, Parts and Joints are replaced by what its Select holds before the
   * first compile, so a Select that drops a sub-mesh needs no counts from the caller. A mesh
   * node inside a component (not in this document's own graph) is not measured: its facts
   * must already match, and a mismatch THROWS, because a buffer sized for another file is
   * exactly the silent wrong shape the facts exist to prevent. A mesh node absent from this
   * map is fed nothing and draws nothing.
   */
  readonly meshes?: Readonly<Record<string, Uint8Array>>;
  /**
   * T1407b — REAL PICTURES for Movie File In nodes, by node id, in place of the T650 test card:
   * given the texture's size, return its RGBA8 bytes (row-major, top row first). A still: one
   * frame, uploaded once. What an offline render of a document that loads an image needs.
   */
  readonly pictures?: Readonly<Record<string, (size: readonly [number, number]) => Uint8Array>>;
  /**
   * T1737b — MOVING PICTURES for Movie File In nodes, by node id: given the texture's size and
   * the index of the frame being stepped (0-based, counted from this render's first frame;
   * negative in a `warmup` run-up), return that frame's RGBA8 bytes (row-major, top row first). Asked once per stepped frame,
   * and the upload advances with it, so a pre-rendered clip plays on a surface in ONE render.
   * A still in `pictures` is uploaded once and holds, which made a clip cost one whole render
   * per frame. The callback is synchronous: a consumer streaming frames from a decoder fills
   * its buffer in `onCapture`, which is awaited between frames.
   */
  readonly movies?: Readonly<Record<string, (size: readonly [number, number], frame: number) => Uint8Array>>;
  /**
   * T1354b — STREAM captured frames instead of returning them. Each captured frame is handed
   * here (awaited, so a consumer can back-pressure, e.g. an encoder pipe) and NOT retained,
   * so a thirty-second clip does not hold a gigabyte of readbacks. `frames` in the result is
   * then empty.
   */
  readonly onCapture?: (frame: RenderedFrame) => void | Promise<void>;
}

/** T1739b: the output a GPU sum would read, as `HeadlessRenderRequest.accumulate.decode` is told it. */
export interface AccumulateTarget {
  readonly format: TextureFormat;
  /** The output's declared space (§V57), which decides how its stored values decode. */
  readonly space: ColorSpace;
  readonly size: readonly [number, number];
  /** The device's limits (`maxStorageBufferBindingSize` bounds the sum). */
  readonly limits: Readonly<Record<string, number>>;
}

export interface HarnessControl {
  resize(outputId: string, size: readonly [number, number]): void;
  /**
   * B186 — THE DOCUMENT-BOUNDARY RITE (T552), reachable offline.
   *
   * `use-frame-loop` calls exactly this the moment a new document's plan is installed,
   * and this harness never called it — so every offline render started every simulation
   * from FRESH textures while the app started it from CLEARED ones. Those were different
   * states (a clear wrote opaque black; an allocation is zeroed), and the gap is the
   * whole of B186: E2 and E24 rendered healthy here and dead in the app from the day
   * that rite started running, with every gate green. A harness that cannot do what the
   * app does on open cannot see what the app sees on open.
   */
  resetTemporalHistory(): void;
  /**
   * §T1311b(b) — push uniform VALUES onto one pass, exactly as the editor does.
   *
   * The viewer's inspection camera reaches a shader through `backend.updateUniforms` and
   * nowhere else (`use-view-camera.ts`), so a test that cannot make that call can only
   * assert the camera by re-staging it as stored document parameters — which renders a
   * picture through a path the app never takes. This is the app's own seam, offline: the
   * same method, the same pass id off `plan`, so "the flown camera renders this" is a
   * claim about the shipped delivery path rather than about a re-creation of it.
   *
   * It reaches no further than a uniform block, by construction: the backend's
   * `updateUniforms` "accepts values and nothing else", so a test cannot rebuild a plan
   * or re-point a resource through here.
   *
   * T1598b: `skip` is a draw pass's other per-frame value (`DrawPassDescriptor.skip`), the
   * same call's third field. Passing `false` for every skipped draw renders the frame with
   * nothing left out, which is the picture a culled frame must equal.
   */
  updateUniforms(passId: string, values: Record<string, number | number[]>, skip?: boolean): void;
  /**
   * T1508b — a LAP: the timeline wraps to `frameIndex` and keeps running, exactly the
   * transport's own `wrapTo` (T464) — the clock changes, nothing is cleared, and the
   * absolute clock keeps counting. What lets a gate render "frame 45 on the second lap".
   */
  wrapTo(frameIndex: number): void;
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
  /**
   * §T1641b slice 3: EVERYTHING SAID ABOUT THIS RENDER, once each, with where it was first
   * said. `diagnostics` above is the structural plan's and the device's, as it always was;
   * a warning only a frame shows (a channel not published at that frame, an expression with
   * no finite answer at it) was computed on every frame and read by nobody. Here are: what
   * `documentFindings` says of the document at rest, a kept payload included; the device's;
   * every frame's plan and value graph; and the harness's own remark on its request
   * (`harness.animateOff`). Deduplicated by code, node and message.
   */
  readonly findings: ReadonlyArray<RenderFinding>;
  /** T741: the requested probeBuffers, read after the final frame, keyed by resource id. */
  readonly buffers?: Readonly<Record<string, ArrayBuffer>>;
  /**
   * T1585b: the requested probeBuffers as each of `probeFrames` left them, in the order the
   * frames were stepped. Present exactly when `probeFrames` was given.
   */
  readonly bufferFrames?: ReadonlyArray<ProbedFrame>;
}

/** §T1641b slice 3: one thing said about a render, and where it was first said. */
export interface RenderFinding {
  readonly diagnostic: RuntimeDiagnostic;
  /** `diagnosticClass(diagnostic.code)`. */
  readonly class: DiagnosticClass | "unclassified";
  /**
   * The first frame it appeared at; `null` when it was said before any frame was stepped:
   * of the document at rest, by the structural plan, or of the request itself.
   */
  readonly frame: number | null;
  /** About a payload a slot only keeps (`parameter.retained`): this render never read it. */
  readonly retained: boolean;
}

/**
 * §T1641b slice 3 — THE ANIMATE TRAP, as a finding. `renderHeadless` evaluates expression
 * slots per frame only with `animate: true`. Without it every frame is compiled once, at
 * the zero frame and with no channels: `time * 2` is 0 on frame 300, and a read of a
 * channel is the slot's stored value. The pictures are plausible (twenty minutes of
 * "walking" were once measured on a robot standing still), so the render says so.
 */
export const ANIMATE_OFF_CODE = "harness.animateOff";

/** T1585b: what the probed buffers held after one frame, keyed by resource id. */
export interface ProbedFrame {
  readonly frameIndex: number;
  readonly buffers: Readonly<Record<string, ArrayBuffer>>;
}

/**
 * B302: with `components`, the COMPONENT-AWARE view, as the app and `prepareProject` hand the
 * compiler. An instance that is muted or bypassed is not inlined (§T1032), so its node
 * reaches validation as itself and must have a type: with the bare node registry every
 * render of a document holding one stopped at `compiler/unknown-node-type`.
 */
function registry(extra?: Iterable<NodeDefinition>, components?: ComponentRegistryView) {
  const nodes = createNodeRegistry(
    extra === undefined ? allNodeDefinitions : [...allNodeDefinitions, ...extra],
  ).view();
  return components === undefined ? nodes : createComponentAwareRegistry(nodes, components);
}

/** The resource the sink presents into, resolved from the plan rather than reconstructed. */
export function outputResourceIdOf(plan: CompiledGraph, nodeId: string, portId?: string): string {
  const match = plan.outputs.find(
    (output) => output.nodeId === nodeId && (portId === undefined || output.portId === portId),
  );
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
 * T1132: the longest a frame loop may hold the event loop before letting the process
 * answer for itself. See the long note on `frameLoopBreather` below.
 *
 * EXPORTED so `harness-event-loop.test.ts` derives its bound from the promise rather than
 * restating a number: the gate's claim is "no gap longer than this", and if the value moves
 * the gate moves with it.
 */
export const FRAME_LOOP_YIELD_MS = 1_000;

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
 * ⚑ ONE IMPLEMENTATION, BECAUSE THIS IS A CLASS AND NOT A FILE. The second instance was
 * `src/tests/acceptance/phase1-exit.test.ts`, whose 36 000-frame playback loop starved the
 * same RPC and also passed in isolation — a Node test that drives frames synchronously has
 * this defect wherever it lives. Both call THIS, so the fix cannot be repaired in one place
 * and left to rot in the other, and `harness-event-loop.test.ts` gates the thing they share.
 *
 * NOT wired into `renderPlanHeadless` below, deliberately: same unyielding shape, but its
 * callers render tens of frames, so it has never held the loop long enough to starve
 * anything and there is nothing to measure. Should one grow a long horizon, this is the
 * call it needs — not a third copy invented from scratch.
 */
export function frameLoopBreather(): () => Promise<void> {
  let lastYield = Date.now();
  return async (): Promise<void> => {
    if (Date.now() - lastYield < FRAME_LOOP_YIELD_MS) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    lastYield = Date.now();
  };
}

/**
 * T1416b — the app loader's measurement (`use-mesh-sources.ts`), offline: each Mesh File In
 * the request feeds is prepared under its own Select and its facts written onto a copy of the
 * graph, so what compiles is sized for what will be fed. The prepared bytes ride along so the
 * feed does not decode the file twice.
 */
/** T1410b: the clip a Mesh File In asks for, as `prepareMesh` takes it. */
function clipOf(parameters: Readonly<Record<string, unknown>>): { name?: string; rate?: number } {
  const name = typeof parameters["clip"] === "string" ? parameters["clip"].trim() : "";
  const rate = parameters["clipRate"];
  return name === "" ? {} : { name, ...(typeof rate === "number" ? { rate } : {}) };
}

/** T1424b: a Mesh File In's Lamps groups, which the decode needs (they add the `lamp` attribute). */
function lampsOf(parameters: Readonly<Record<string, unknown>>): string {
  return typeof parameters["lamps"] === "string" ? parameters["lamps"] : "";
}

/** T1581b: a Mesh File In's Frame — which frame its vertices are decoded in. */
function frameOf(parameters: Readonly<Record<string, unknown>>): MeshFrame {
  const frame = parameters["frame"];
  return frame === "object" || frame === "part" ? frame : "world";
}

function measureMeshes(request: HeadlessRenderRequest): { request: HeadlessRenderRequest; prepared: Map<string, PreparedMesh | null> } {
  const prepared = new Map<string, PreparedMesh | null>();
  if (request.meshes === undefined) return { request, prepared };
  const nodes: Record<string, GraphNode> = { ...request.graph.nodes };
  for (const [nodeId, glb] of Object.entries(request.meshes)) {
    const node = nodes[nodeId];
    if (node === undefined) continue; // inside a component: checked, not measured, at the feed
    if (node.type !== "meshFileIn") throw new Error(`meshes: "${nodeId}" is not a Mesh File In node.`);
    const select = typeof node.parameters["select"] === "string" ? (node.parameters["select"] as string) : "";
    const mesh = prepareMesh(glb, select, clipOf(node.parameters), lampsOf(node.parameters), frameOf(node.parameters));
    prepared.set(nodeId, mesh);
    if (mesh === null) continue;
    nodes[nodeId] = { ...node, parameters: { ...node.parameters, ...mesh.facts } };
  }
  return { request: { ...request, graph: { ...request.graph, nodes } }, prepared };
}

export async function renderHeadless(unmeasured: HeadlessRenderRequest): Promise<HeadlessRenderResult> {
  const { request, prepared: preparedMeshes } = measureMeshes(unmeasured);
  const settings = request.settings ?? paritySettings();
  const frameCount = request.frames ?? 1;
  const capture = [...(request.capture ?? [frameCount - 1])].sort((a, b) => a - b);
  // T1585b: a per-frame probe that could come back empty in silence is refused before a
  // device is opened — no buffers named, or a frame this render never steps.
  const probeAt = new Set(request.probeFrames ?? []);
  if (request.probeFrames !== undefined) {
    if ((request.probeBuffers ?? []).length === 0) {
      throw new Error("probeFrames names frames to read buffers at, and probeBuffers names no buffer to read.");
    }
    const outside = request.probeFrames.filter((index) => !Number.isInteger(index) || index < 0 || index >= frameCount);
    if (outside.length > 0) {
      throw new Error(`probeFrames asks for frame ${outside.join(", ")}, and this render steps frames 0 to ${frameCount - 1}.`);
    }
  }
  // T1739b: a sum of a partial group would be resolved by nobody.
  if (request.accumulate !== undefined) {
    const every = request.accumulate.every;
    if (!Number.isInteger(every) || every < 1) throw new Error(`accumulate.every must be a whole number of at least 1, not ${every}.`);
    if (capture.length % every !== 0) throw new Error(`accumulate sums ${every} captured frames at a time, and ${capture.length} are captured.`);
  }
  const probedFrames: ProbedFrame[] = [];
  const outputNodeId = request.outputNodeId ?? OUTPUT_NODE_ID;
  // T933: the DOCUMENT's rate when the request does not override it. A bare `?? 60`
  // here rendered a 30 fps document at 60 and called the result a parity baseline.
  const fps = request.fps ?? projectFps(settings);

  const backend = createVgpuBackend({ host: request.host });
  if (request.exactPassTiming === true) backend.setExactPassTiming(true);
  const diagnostics: RuntimeDiagnostic[] = [];
  /**
   * §T1641b slice 3: everything said about this render, once each (code, node, message),
   * with the first frame it was said at. `frameNow` is null until the first frame is stepped.
   */
  const found = new Map<string, RenderFinding>();
  let frameNow: number | null = null;
  const note = (diagnostic: RuntimeDiagnostic, retained = false): void => {
    const key = `${diagnostic.code}|${diagnostic.nodeId ?? ""}|${diagnostic.message}`;
    if (!found.has(key)) found.set(key, { diagnostic, class: diagnosticClass(diagnostic.code), frame: frameNow, retained });
  };
  backend.onDiagnostic((diagnostic) => {
    diagnostics.push(diagnostic);
    note(diagnostic);
  });
  /** T1739b: the GPU sum of captured frames, when `accumulate` made one; released with the backend. */
  let accumulator: { readonly resourceId: string; readonly sum: OutputAccumulator } | undefined;
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
            registry: registry(request.nodes, request.components),
            components: request.components,
          });
    /** What the value graph and every compile read. §V437: the raw document is not it. */
    const logicalGraph = flattened?.graph ?? compiledWithoutCatalogue(request.graph);
    /** T1497b: the preset morphs in flight — the flattening's, or the document's own. */
    const morphs = flattened?.morphs ?? buildMorphIndex({ document: request.graph, registry: registry(request.nodes, request.components) });

    /** The request every compile below starts from: the document's own structure, no frame. */
    const baseRequest: CompileRequest = {
      graph: request.graph,
      settings,
      registry: registry(request.nodes, request.components),
      capabilities,
      ...(flattened === undefined ? {} : { flattened }),
      // §T1311b(a): the editor's preview sinks, when a test is standing where the editor
      // stands. Absent is the export/thumbnail/claims state, and it stays the default.
      ...(request.sinks === undefined && request.displaySinks === undefined
        ? {}
        : {
            sinks: [
              ...(request.sinks ?? []).map((sink) => ({ ...sink, kind: "preview" as const })),
              ...(request.displaySinks ?? []).map((nodeId) => ({ nodeId, kind: "output" as const })),
            ],
          }),
    };
    /**
     * §T1537b — THE TIMELINE'S STRUCTURE, a function of the playhead. A frame compiles the
     * document with the structural overrides at ITS playhead applied: the plan is swapped
     * before the frame that reaches a structural cue is stepped, never after it, so the
     * crossing frame is the first one in the new structure — and a seek, a lap or a second
     * export lands on the same plan for the same playhead.
     */
    const structure = buildTimelineStructure({
      document: request.graph,
      registry: registry(request.nodes, request.components),
      ...(request.components === undefined ? {} : { components: request.components }),
      flattened,
    });
    const subframeCount = request.subframes ?? 1;
    const firstState =
      structure === null
        ? null
        : structure.at({ timeSeconds: (request.startFrame ?? 0) / fps, fps: fps / subframeCount, subframes: subframeCount });
    /** §T1641b: the findings the caller named, and the ones the render then met. */
    const expectedFindings = new Set(request.expectedFindings ?? []);
    for (const code of expectedFindings) {
      if (!leavesPlanUsable(code)) {
        throw new Error(
          `expectedFindings names "${code}", which is not local: only a finding that leaves the plan usable can be rendered through.`,
        );
      }
    }
    /** Each named finding the render met, once: a frame's plan repeats the structural one's. */
    const metFindings = new Map<string, RuntimeDiagnostic>();
    /** An error stops the render, unless it is a finding the caller named. */
    const stops = (diagnostic: RuntimeDiagnostic): boolean => {
      if (diagnostic.severity !== "error") return false;
      if (!expectedFindings.has(diagnostic.code)) return true;
      const key = `${diagnostic.code}|${diagnostic.nodeId ?? ""}|${diagnostic.message}`;
      if (!metFindings.has(key)) metFindings.set(key, diagnostic);
      return false;
    };
    /**
     * §T1641b: an error as the script that stops on it prints it. The code, the node BY
     * NAME (a parameter's message names its key, not its node), and what to write instead.
     */
    const described = (diagnostic: RuntimeDiagnostic): string => {
      const node = diagnostic.nodeId === undefined ? undefined : logicalGraph.nodes[diagnostic.nodeId];
      return describeFinding({
        diagnostic,
        node: node === undefined ? undefined : { id: node.id, name: node.label ?? node.id, type: node.type },
        component: undefined,
      });
    };
    const compileSegment = (state: TimelineStructureState | null): { request: CompileRequest; plan: CompiledGraph } => {
      const segmentRequest = state === null ? baseRequest : timelineStructureRequest(baseRequest, state);
      const segmentPlan = compileGraph(segmentRequest);
      const errors = segmentPlan.diagnostics.filter(stops);
      if (errors.length > 0) {
        throw new Error(`Parity graph failed to compile: ${errors.map(described).join("; ")}`);
      }
      return { request: segmentRequest, plan: segmentPlan };
    };
    const first = compileSegment(firstState);
    const plan = first.plan;

    /**
     * §T1641b slice 3 — THE DOCUMENT AT REST, before a frame is stepped. `documentFindings`
     * is the write gate asked of everything the document stores, with this compile's own
     * report: a script's document never met the bus, so this is where it is judged.
     *
     * What it adds to the compile above is what only the write gate checks. A wrong thing
     * IN EFFECT in the document's own graph (a pulse stored armed, a payload under another
     * mode's binding) stops the render as a compile error does. A payload a slot only KEEPS
     * (`parameter.retained`) and a finding inside a component definition's own graph are
     * returned and do not stop it: this render never reads the first, and reads the second
     * only through an instance, which the compile has judged. `strict` stops on both.
     *
     * The node catalogue here is the bare one, so a component INSTANCE's own page is not
     * re-read (the flattening reads it); a definition's inner nodes are.
     */
    const strict = request.strict === true;
    const atRest = documentFindings({
      graph: request.graph,
      settings,
      registry: registry(request.nodes, request.components),
      ...(request.components === undefined ? {} : { components: request.components }),
      capabilities,
      compiled: { plan, flattened },
    });
    const refusedAtRest: string[] = [];
    for (const finding of atRest) {
      note(finding.diagnostic, finding.retained);
      if (plan.diagnostics.includes(finding.diagnostic)) continue; // the compile's own, judged above
      // `stops` also records a finding the caller named, which is then met.
      const stopping = stops(finding.diagnostic);
      if (stopping && !finding.retained && finding.component === undefined) refusedAtRest.push(describeFinding(finding));
    }
    if (refusedAtRest.length > 0) {
      throw new Error(`The document holds what the write gate refuses: ${refusedAtRest.join("; ")}`);
    }

    /**
     * §T1641b slice 3 — THE ANIMATE TRAP. Without `animate` no expression is evaluated per
     * frame: the one structural compile above resolved each at the zero frame with no
     * channels, and every frame of this render carries those values.
     */
    if (request.animate !== true) {
      const holders: string[] = [];
      let slots = 0;
      for (const node of Object.values(logicalGraph.nodes)) {
        const held = Object.values(node.parameters).filter((stored) => isParameterSlot(stored) && stored.mode === "expression").length;
        if (held === 0) continue;
        slots += held;
        holders.push(node.label ?? node.id);
      }
      if (slots > 0) {
        const named = holders.slice(0, 3).map((name) => `"${name}"`).join(", ");
        const others = holders.length > 3 ? ` and ${holders.length - 3} more` : "";
        note({
          // An ERROR under `strict`, which is the caller saying these frames will be trusted.
          severity: strict ? "error" : "warning",
          code: ANIMATE_OFF_CODE,
          message:
            `This render holds ${slots} expression slot${slots === 1 ? "" : "s"} on ${holders.length} node${holders.length === 1 ? "" : "s"} (${named}${others}) and animate is off: ` +
            "none is evaluated per frame. Every frame carries each one's value at the zero frame, or its stored value where it reads a channel.",
          suggestion: "Pass animate: true.",
        });
      }
    }

    /** `strict`: what a final render cannot carry, unless the caller named it. */
    const stopsStrict = (finding: RenderFinding): boolean =>
      strict && stopsFinalRender(finding.diagnostic) && !expectedFindings.has(finding.diagnostic.code);
    const describedAt = (finding: RenderFinding): string =>
      `${finding.frame === null ? "before the first frame" : `frame ${finding.frame}`}: ${described(finding.diagnostic)}`;
    const refusedBeforeFrames = [...found.values()].filter(stopsStrict);
    if (refusedBeforeFrames.length > 0) {
      throw new Error(`A strict render stops on what a final render cannot carry:\n${refusedBeforeFrames.map(describedAt).join("\n")}`);
    }
    /** §T1537b: the segment the backend holds, its request and plan — moved by every crossing. */
    let installedState = firstState;
    let liveRequest = first.request;
    let livePlan = plan;

    const outputResourceId = outputResourceIdOf(plan, outputNodeId, request.outputPortId);
    let liveOutputResourceId = outputResourceId;
    const compiled = await backend.compile(plan);

    /** §T1537b: each media source is registered once, so a later segment's plan adds only its new ones. */
    const registeredSources = new Set<string>();
    const sourcesOnce: Parameters<typeof registerSyntheticMediaSources>[0] = {
      registerMediaSource: (sourceId, source) => {
        if (registeredSources.has(sourceId)) return () => undefined;
        registeredSources.add(sourceId);
        return backend.registerMediaSource(sourceId, source);
      },
    };
    // T650: media draws SOMETHING attributable in headless, or nothing by stated design.
    registerSyntheticMediaSources(sourcesOnce, plan, logicalGraph, () => steppingFrame);
    // T1738b: a Movie File In on a branch no sink reaches has no texture in the plan and
    // nothing reads it, so a feed named for it is left unfed. Any other id is still refused.
    const prunedMovie = (nodeId: string): boolean => logicalGraph.nodes[nodeId as keyof typeof logicalGraph.nodes]?.type === "movieFileIn";
    // T1407b: a real picture replaces the card for the nodes the caller names.
    for (const [nodeId, bytesFor] of Object.entries(request.pictures ?? {})) {
      const resource = plan.resources.find((entry) => (entry as { sourceId?: string }).sourceId === `media:${nodeId}`) as { size?: readonly [number, number] } | undefined;
      if (resource?.size === undefined && prunedMovie(nodeId)) continue;
      if (resource?.size === undefined) throw new Error(`pictures: "${nodeId}" has no media texture in the plan (is it a Movie File In?).`);
      const bytes = bytesFor(resource.size);
      if (bytes.length !== resource.size[0] * resource.size[1] * 4) throw new Error(`pictures: "${nodeId}" returned ${bytes.length} bytes for a ${resource.size[0]}×${resource.size[1]} RGBA8 texture.`);
      registeredSources.add(`media:${nodeId}`);
      backend.registerMediaSource(`media:${nodeId}`, { currentFrame: () => ({ frameId: 1, bytes }) });
    }
    // T1737b: a moving picture asks for the frame being stepped, and its frameId advances with
    // it, so the backend (which uploads only when the frameId moves) uploads every frame.
    for (const [nodeId, bytesAt] of Object.entries(request.movies ?? {})) {
      const resource = plan.resources.find((entry) => (entry as { sourceId?: string }).sourceId === `media:${nodeId}`) as { size?: readonly [number, number] } | undefined;
      if (resource?.size === undefined && prunedMovie(nodeId)) continue;
      if (resource?.size === undefined) throw new Error(`movies: "${nodeId}" has no media texture in the plan (is it a Movie File In?).`);
      const size = resource.size;
      // T1745b: a run-up frame's index is negative, so "none shown yet" is not a frame number.
      let shownFrame: number | undefined;
      let shown: Uint8Array = new Uint8Array(0);
      let uploads = 0;
      registeredSources.add(`media:${nodeId}`);
      backend.registerMediaSource(`media:${nodeId}`, {
        currentFrame: () => {
          if (steppingFrame !== shownFrame) {
            const bytes = bytesAt(size, steppingFrame);
            if (bytes.length !== size[0] * size[1] * 4) throw new Error(`movies: "${nodeId}" returned ${bytes.length} bytes for a ${size[0]}×${size[1]} RGBA8 texture at frame ${steppingFrame}.`);
            shownFrame = steppingFrame;
            shown = bytes;
            uploads += 1;
          }
          return { frameId: uploads, bytes: shown };
        },
      });
    }
    // T1353b: the mesh feed — one static frame per source, prepared the loader's way.
    for (const [nodeId, glb] of Object.entries(request.meshes ?? {})) {
      const node = logicalGraph.nodes[nodeId as keyof typeof logicalGraph.nodes];
      if (node?.type !== "meshFileIn") throw new Error(`meshes: "${nodeId}" is not a Mesh File In node.`);
      const select = typeof node.parameters["select"] === "string" ? (node.parameters["select"] as string) : "";
      const prepared = preparedMeshes.has(nodeId) ? (preparedMeshes.get(nodeId) ?? null) : prepareMesh(glb, select, clipOf(node.parameters), lampsOf(node.parameters), frameOf(node.parameters));
      if (prepared === null) continue;
      if (node.parameters["vertices"] !== prepared.facts.vertices || node.parameters["triangles"] !== prepared.facts.triangles) {
        throw new Error(
          `meshes: "${nodeId}" is sized for ${String(node.parameters["vertices"])} vertices / ${String(node.parameters["triangles"])} triangles but the file holds ${prepared.facts.vertices} / ${prepared.facts.triangles}. Set its facts from prepareMesh(...).facts.`,
        );
      }
      // T1401b: a skin adds two attributes, so a node sized unskinned for a skinned file (or
      // the reverse) has the wrong buffer even when the counts agree.
      const joints = typeof node.parameters["joints"] === "string" ? node.parameters["joints"] : "";
      if ((joints.trim() === "") !== (prepared.facts.joints === "")) {
        throw new Error(
          `meshes: "${nodeId}" is sized ${joints.trim() === "" ? "unskinned" : "skinned"} but the file's selection is ${prepared.facts.joints === "" ? "unskinned" : "skinned"}. Set its joints from prepareMesh(...).facts.`,
        );
      }
      const ids = meshSourceIdsFor(nodeId);
      backend.registerMediaSource(ids.points, { currentFrame: () => ({ frameId: 1, bytes: prepared.points }) });
      backend.registerMediaSource(ids.indices, { currentFrame: () => ({ frameId: 1, bytes: prepared.indices }) });
      // T1410b: a chosen clip's baked poses, the node's third fed buffer.
      const pose = prepared.pose;
      if (pose !== undefined) backend.registerMediaSource(ids.pose, { currentFrame: () => ({ frameId: 1, bytes: pose }) });
    }
    // T715: the inference feed, beside the media one and claiming a different prefix.
    const registerInference = (segmentPlan: CompiledGraph): void =>
      registerInferenceSources(
        sourcesOnce,
        segmentPlan,
        () => steppingFrame,
        request.inference,
        (nodeId) => logicalGraph.nodes[nodeId as keyof typeof logicalGraph.nodes]?.type,
      );
    registerInference(plan);

    // T1745b: the run-up, decided by the caller from the plan, before any frame is stepped.
    const runUp = request.warmup?.(plan) ?? 0;
    if (!Number.isInteger(runUp) || runUp < 0) throw new Error(`warmup must be a whole number of frames, not ${runUp}.`);
    if (runUp > (request.startFrame ?? 0)) {
      throw new Error(`warmup asks for ${runUp} frames before frame ${request.startFrame ?? 0}; a run-up cannot start before the timeline's frame 0.`);
    }
    const firstStepped = (request.startFrame ?? 0) - runUp;
    // §V45: the seed is the project's, not the transport's own invention. Hoisted so the
    // control below can wrap it (T1508b).
    // T1785b: the document's tempo along the take's absolute clock.
    const clock = offlineTransport({ fps, seed: settings.randomSeed, mode: "fixed-step", tempo: documentTempo(() => settings), ...(request.subframes === undefined ? {} : { subframes: request.subframes }), ...(firstStepped === 0 ? {} : { startFrame: firstStepped }), ...(request.absEpoch === undefined ? {} : { epoch: request.absEpoch }) });
    /**
     * §T1537b: the loop below PULLS each frame before stepping it, so the plan for that
     * frame's playhead is installed first; the driver then steps the pulled frame. With no
     * structural timeline nothing is pulled early and this is the clock unchanged.
     */
    let pulled: ReturnType<typeof clock.next> | null = null;
    const transport: typeof clock = {
      ...clock,
      next: () => {
        const frame = pulled ?? clock.next();
        pulled = null;
        return frame;
      },
    };
    const control: HarnessControl = {
      resize: (outputId, size) => {
        backend.resize(outputId, size);
      },
      wrapTo: (frameIndex) => {
        if (transport.wrapTo === undefined) throw new Error("The offline transport has no wrapTo; a lap cannot be rendered.");
        transport.wrapTo(frameIndex);
      },
      // B186: byte for byte the call `use-frame-loop` makes at a document boundary.
      resetTemporalHistory: () => {
        backend.resetTemporalHistory(undefined, { buffers: true, silent: true });
      },
      // §T1311b(b): byte for byte the call `use-view-camera` makes while the viewer flies.
      updateUniforms: (passId, values, skip) => {
        backend.updateUniforms({ passId, values, ...(skip === undefined ? {} : { skip }) });
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
            return analyzeChannelEntries(logicalGraph, registry(request.nodes, request.components)).filter((entry) =>
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
    /*
     * T1530b — which reduction each entry publishes is a parameter read, made at a frame.
     * The entries above resolve Operation at no frame (the set is structural); each rendered
     * frame re-resolves it below, with that frame's channels and the morphs, and re-tracks
     * only when one changed — `useAnalyzeChannels`' `refreshOperations`, offline.
     */
    let analyzeTracked = analyzeEntries;

    const valueSession = request.animate === true ? createValueGraphSession(registry(request.nodes, request.components)) : null;
    const animator = request.animate === true ? createUniformAnimator() : null;
    // One closure serves both directions, so a render can replay a track and record what
    // it replayed — which is what makes "record, replay, record again, compare" a test of
    // the ROUND TRIP rather than of two separate code paths.
    const audioAt = request.audio;
    const recorder = request.recordAudio;
    // The loop below publishes the index it is about to step so the closure knows which
    // frame of the track it is standing in — its own counter, as before the driver started
    // handing the seam the frame (T1229); a live source ignores that argument.
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
    /** B252: the value graph's warnings, deduped; they join the result's diagnostics. */
    const valueWarnings = new Map<string, RuntimeDiagnostic>();
    const driver = createFrameDriver({
      backend,
      ...(audioSeam === undefined ? {} : { audio: audioSeam }),
      transport,
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
                // T1497b: the same morph index the per-frame compile below derives, so a
                // recalled widget publishes the fading value here as it does live — and
                // (§T1559b) the instances a value node's own `op('<instance>')` can name.
                flattening: { morphs, instanceChannels: flattened?.instanceChannels ?? NO_INSTANCES, instancePages: flattened?.instancePages ?? NO_PAGES },
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
              /*
               * B252 — the value graph's diagnostics are READ. A loop that closes through a
               * wire and an `op()` reference makes every member emit nothing
               * (`valueGraph.cycle`); nobody looked, so the render went black in silence.
               * Errors fail the render like a per-frame compile error (T791), naming the
               * first frame; warnings travel with the result's diagnostics, once each.
               */
              for (const diagnostic of evaluated.diagnostics) {
                note(diagnostic);
                const key = `${diagnostic.code}|${diagnostic.nodeId ?? ""}|${diagnostic.message}`;
                if (stops(diagnostic)) {
                  if (!perFrameErrors.has(key)) perFrameErrors.set(key, { frameIndex: inputs.frame.frameIndex, diagnostic });
                } else if (!valueWarnings.has(key)) {
                  valueWarnings.set(key, diagnostic);
                }
              }
              // Analyze FIRST, exactly as the app merges its resolvers: a measured
              // channel outranks a value-graph channel of the same name.
              const channels: ChannelResolver =
                analyze === null
                  ? evaluated.resolver
                  : (name, context) => analyze.resolver(name, context) ?? evaluated.resolver(name, context);
              if (analyze !== null) {
                // T1530b: Operation AT THIS FRAME, before the sample that reads its reduction.
                let changed = false;
                const read = { frame: inputs.frame, channels, flattening: { morphs, instanceChannels: flattened?.instanceChannels ?? NO_INSTANCES, instancePages: flattened?.instancePages ?? NO_PAGES } };
                const nextEntries = analyzeTracked.map((entry) => {
                  const node = logicalGraph.nodes[entry.nodeId as keyof typeof logicalGraph.nodes];
                  const operation = node === undefined ? entry.operation : analyzeOperationOf(node, logicalGraph, registry(request.nodes, request.components), read);
                  if (operation === entry.operation) return entry;
                  changed = true;
                  return { ...entry, operation };
                });
                if (changed) {
                  analyzeTracked = nextEntries;
                  analyze.track(nextEntries);
                }
              }
              // §T1537b: the installed segment's request — the structure this frame compiles in.
              const next = compileGraph({
                ...liveRequest,
                resolution: {
                  frame: inputs.frame,
                  channels,
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
                // §T1641b slice 3: every one is kept, with the frame it first appeared at. A
                // warning only a frame shows had no reader at all.
                note(diagnostic);
                if (!stops(diagnostic)) continue;
                const key = `${diagnostic.code}|${diagnostic.nodeId ?? ""}|${diagnostic.message}`;
                if (!perFrameErrors.has(key)) {
                  perFrameErrors.set(key, { frameIndex: inputs.frame.frameIndex, diagnostic });
                }
              }
              animator.push(backend, livePlan, next);
            },
          }),
    });
    driver.setPlan(compiled);

    const captured: RenderedFrame[] = [];
    const wanted = new Set(capture);
    /**
     * T1739b: the decode a GPU sum of the read output goes through, or undefined to read
     * each captured frame back. Asked once, of the plan the render starts in.
     */
    const decode = (() => {
      if (request.accumulate === undefined) return undefined;
      const resource = plan.resources.find(
        (entry) => entry.id === outputResourceId && (entry.kind === "target" || entry.kind === "pingPong"),
      );
      const output = plan.outputs.find((entry) => entry.resourceId === outputResourceId);
      if (resource === undefined || (resource.kind !== "target" && resource.kind !== "pingPong") || output === undefined) {
        throw new Error(`accumulate: the plan has no texture for "${outputResourceId}" to sum.`);
      }
      return request.accumulate.decode({ format: resource.format, space: output.space, size: resource.size, limits: capabilities.limits });
    })();
    /** The sum, made for the output resource it reads: a segment that moves the output starts a new one between groups. */
    const sumOf = (resourceId: string, using: LinearDecode): OutputAccumulator => {
      if (accumulator?.resourceId === resourceId) return accumulator.sum;
      if (accumulator !== undefined && accumulator.sum.count > 0) {
        throw new Error(`accumulate: the output moved from "${accumulator.resourceId}" to "${resourceId}" inside one sum.`);
      }
      accumulator?.sum.dispose();
      accumulator = { resourceId, sum: backend.accumulateOutput(resourceId, using) };
      return accumulator.sum;
    };
    const breathe = frameLoopBreather();
    // T1745b: a run-up's frames come first, as −runUp … −1. `0 - runUp`, not `-runUp`: with
    // no run-up that is −0, a frame index no caller's 0 equals.
    for (let index = 0 - runUp; index < frameCount; index += 1) {
      // T1132: see `frameLoopBreather` — the loop must let the process answer.
      await breathe();
      steppingFrame = index;
      frameNow = index;
      // T661: the pointer for THIS frame is set before the step that reads it, and
      // what gets recorded is the state the engine actually read — the audio seam's
      // record-what-crossed contract, pointer edition.
      if (request.pointer !== undefined) {
        const next = request.pointer(index);
        if (next !== null) pointerSource.set(next);
      }
      if (structure !== null) {
        // §T1537b: the frame's playhead decides its structure; a crossing installs the
        // segment's plan BEFORE the frame is stepped.
        pulled = clock.next();
        const state = structure.at(pulled);
        if (state !== installedState) {
          const segment = compileSegment(state);
          driver.setPlan(await backend.compile(segment.plan));
          installedState = state;
          liveRequest = segment.request;
          livePlan = segment.plan;
          liveOutputResourceId = outputResourceIdOf(segment.plan, outputNodeId, request.outputPortId);
          animator?.reset();
          registerSyntheticMediaSources(sourcesOnce, segment.plan, logicalGraph, () => steppingFrame);
          registerInference(segment.plan);
        }
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
      if (wanted.has(index) && decode !== undefined) {
        // T1739b: added on the device, and read back once a group is whole.
        const sum = sumOf(liveOutputResourceId, decode);
        sum.add();
        if (sum.count === request.accumulate!.every) {
          const read = await sum.read();
          await request.accumulate!.onSum({ ...read, frameIndex: index });
        }
      } else if (wanted.has(index)) {
        // §V48/§V7: readback happens between frames, never inside the loop, which is why
        // `step()` exists as a separate entry point at all.
        // T173: readOutput returns the full descriptor now — width/format/stride come
        // from the thing that did the copy, not from a lookup beside it (§V60).
        const image = await backend.readOutput(liveOutputResourceId);
        const frame: RenderedFrame = {
          frameIndex: index,
          width: image.width,
          height: image.height,
          format: image.format,
          bytes: image.bytes,
        };
        if (request.onCapture === undefined) captured.push(frame);
        else await request.onCapture(frame);
      }
      if (probeAt.has(index)) {
        // T1585b: the same read the final probe makes, of the state this frame left.
        const buffers: Record<string, ArrayBuffer> = {};
        for (const resourceId of request.probeBuffers ?? []) buffers[resourceId] = await backend.readBuffer(resourceId);
        probedFrames.push({ frameIndex: index, buffers });
      }
      // Awaited only when it returns a promise: a synchronous caller's frames keep their timing.
      const between = request.betweenFrames?.(control, index);
      if (between !== undefined) await between;
    }

    // T791: a per-frame error fails the render the way a structural one does — loudly,
    // naming the frame it first appeared on. Green frames over a broken per-frame plan
    // are exactly what this harness existed to prevent.
    if (perFrameErrors.size > 0) {
      const lines = [...perFrameErrors.values()].map((entry) => `frame ${entry.frameIndex}: ${described(entry.diagnostic)}`);
      throw new Error(`Per-frame compile produced errors (the value graph's included):\n${lines.join("\n")}`);
    }
    // §T1641b: every finding the caller named has to have appeared.
    const metCodes = new Set([...metFindings.values()].map((diagnostic) => diagnostic.code));
    const unmet = [...expectedFindings].filter((code) => !metCodes.has(code));
    if (unmet.length > 0) {
      throw new Error(`The render was expected to report ${unmet.map((code) => `"${code}"`).join(", ")} and never did.`);
    }
    // §T1641b slice 3: `strict` is the same question asked of every frame. What was said
    // before the first one already stopped the render above; these appeared while it ran.
    const refusedInFrames = [...found.values()].filter(stopsStrict);
    if (refusedInFrames.length > 0) {
      throw new Error(`A strict render stops on what a final render cannot carry:\n${refusedInFrames.map(describedAt).join("\n")}`);
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
      ...(request.probeFrames === undefined ? {} : { bufferFrames: probedFrames }),
      // Compiler diagnostics FIRST: they are about the plan the render ran, and the
      // errors among them already threw above — what travels here is the warnings,
      // which are exactly what a byte-identical-but-wrong render hides (T630).
      // §T1641b: and the findings the caller named. The structural plan carries the ones it
      // could see; one only a frame's channels show (an ambiguous instance read) is added.
      diagnostics: [
        ...plan.diagnostics,
        ...diagnostics,
        ...valueWarnings.values(),
        ...[...metFindings.values()].filter((met) => !plan.diagnostics.some((said) => said.code === met.code && said.nodeId === met.nodeId && said.message === met.message)),
      ],
      findings: [...found.values()],
    };
  } finally {
    accumulator?.sum.dispose();
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
