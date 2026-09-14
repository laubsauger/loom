import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import { resolveParameters } from "@domain/parameters/index.ts";
import { mediaNodeDefinitions, mediaSourceIdFor } from "@nodes/definitions/index.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { CameraStatus } from "./camera-request.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { MediaControlRegistry } from "./media-commands.ts";
import {
  applyMediaPlayhead,
  createMediaTransportRunner,
  durationOf,
  playableMedia,
  type MediaTransportRunner,
  type PlayableMedia,
} from "./media-playback.ts";
import {
  hdrPictureRefusal,
  pictureFileKind,
  pictureFileUrl,
} from "@domain/media/picture-file.ts";
import { awaitMediaReady, createStillMediaSource, createVideoMediaSource } from "./media-sources.ts";
import type { MediaElement, StillImage, VideoMediaSource } from "./media-sources.ts";
import { createTextMediaSource } from "./text-source.ts";
import type { TextAlign, TextMediaSource, TextRaster, TextVerticalAlign } from "./text-source.ts";
import {
  NO_CAMERA_REQUEST,
  cameraConstraints,
  cameraGrantOf,
  cameraLimitsOf,
  cameraRequestOf,
  requiredFormatText,
  type CameraGrant,
  type CameraLimits,
  type CameraRequest,
} from "./camera-request.ts";

/**
 * Media inputs, wired (T264, §V135, §V136, §V29).
 *
 * A Movie File In or a Webcam node declares an external texture keyed by
 * `mediaSourceIdFor(nodeId)`; the backend uploads whatever source is registered under
 * that key and leaves the texture black when there is none. Nothing registered one. This
 * hook is the missing half: it watches the document for media nodes, opens the thing each
 * one names, and registers it.
 *
 * ## What it refuses to do
 *
 * Declining camera access is a NORMAL outcome, not an exception. A denial (or a file that
 * will not decode) registers nothing, reports a diagnostic naming the node, and leaves the
 * node black — which is exactly what the node's own contract promises. Nothing here
 * throws, and no failure takes a frame loop or an editor down with it.
 *
 * ## A generated source has no intrinsic size (T312)
 *
 * `copyExternalImageToTexture` asserts matching extents, so whatever a source produces
 * must be exactly the size of the node's target. A video HAS an intrinsic size and the
 * node adopts it (below). Everything we GENERATE — text today, anything procedural later —
 * has none, so the arrow points the other way: the source is told the node's RESOLVED
 * size and draws at it. That is why this hook takes the resolved sizes rather than the
 * project resolution: a per-node resolution override (§V50) would otherwise produce a
 * canvas of one size and a target of another, and the upload would fail rather than scale.
 *
 * ## Intrinsic size is not node size
 *
 * `copyExternalImageToTexture` asserts matching extents: it will not scale a 1920x1080
 * camera frame into a 1280x720 target, and the bytes path has the same rule. So once the
 * intrinsic size is known this sets the node's resolution override to it — through the
 * bus, as one `setNodeResolution` patch (§V29), and only when it actually differs, so a
 * live camera does not write a patch per frame.
 */

/**
 * T1043 — A LIVE CAMERA: the element to blit, and the two things only the track knows.
 *
 * `grant` and `limits` are FUNCTIONS, not captured values, and that is §V986's second half
 * rather than a style choice: `getSettings()` moves. A track renegotiates when the camera
 * is reconfigured, several platforms settle on their real frame rate a beat after the open,
 * and a number snapshotted at open time goes quietly stale while looking authoritative —
 * which is the exact disease this row exists to treat. Two property lookups per read.
 */
export interface OpenedCamera {
  readonly element: MediaElement;
  /** What the track says it is doing NOW. Null where the browser reports nothing. */
  grant(): CameraGrant | null;
  /** What the camera says it CAN do (§V985). Null where the browser reports nothing. */
  limits(): CameraLimits | null;
  /**
   * Release the capture. `pause()` on the element does NOT stop a `MediaStream` track —
   * the camera keeps running and its indicator light stays on for a node that is gone —
   * so the door that opened the stream is the one that has to close it, exactly as the
   * microphone path already does (`use-audio-input.ts` stops its tracks on teardown).
   */
  stop(): void;
}

/**
 * The environment this hook needs. Injectable, so a test needs no camera, no codec — and,
 * since T243, no canvas: jsdom's `getContext("2d")` returns null, so a text source built
 * on the real factory would register and then quietly draw nothing in a test.
 */
export interface MediaEnvironment {
  /** Creates a video element bound to `url`, already playing. Throws to report failure. */
  openFile(url: string): Promise<MediaElement>;
  /**
   * T1223 — decodes a STILL at `url`. Throws to report failure, like the other two.
   *
   * A separate door rather than a union return from `openFile`, because the two produce
   * genuinely different things: an element that decodes on its own schedule, and one
   * decoded picture that never changes. It is REQUIRED, not optional, so an environment
   * that cannot open a still has to say so at the type level — an optional member would
   * let a test double answer "no image door" by silence, and a silently-video-only
   * environment is exactly the bug this task fixes.
   */
  openStill(url: string): Promise<StillImage>;
  /**
   * Opens a camera. T810: an empty `device` is the system default; a non-empty one is
   * an EXACT `deviceId` and a vanished device throws `OverconstrainedError` — the open
   * loop owns the retry-bare fallback and the diagnostic that names it, so the
   * environment stays a dumb door (the same split `use-audio-input` made for T434).
   * Throws (permission denied, no device) to report failure.
   *
   * T1043 — it takes the whole `CameraRequest` and hands back an `OpenedCamera` rather
   * than a bare element, because a camera's SIZE AND RATE ARE NEGOTIATED and the only
   * party that knows what was actually granted is the live `MediaStreamTrack` the door
   * opened. Returning the element alone would leave the grant unreachable and the node's
   * Capture parameters unverifiable, which is the whole defect T1043 exists to close.
   */
  openCamera(request: CameraRequest): Promise<OpenedCamera>;
  /** Text rasterizer factory (T243). Defaults to the browser one. */
  createTextSource?(): TextMediaSource;
}

/**
 * §V453/§V316, as a DERIVATION rather than a hand list — `hasMediaTransport`'s rule,
 * applied to the set that names the nodes rather than the one that classifies them.
 *
 * It read `["movieFileIn", "webcam", "text"]`, which was the same three by coincidence of
 * nobody having added a fourth. Media node N+1 is now a capture candidate by construction,
 * or it fails the mute gate in `media-mute.test.tsx`, instead of rendering nothing while
 * this hook silently skips a type it was never told about.
 */
const MEDIA_TYPES = new Set(mediaNodeDefinitions.map((definition) => definition.type));

interface MediaRequest {
  readonly nodeId: NodeId;
  readonly type: string;
  /** The file a movie node names. Empty for a webcam, and for a movie with no file yet. */
  readonly url: string;
  /**
   * T1043: everything the webcam asks the camera for, T810's `device` included. The
   * shipped default for every other node type, which asks for nothing.
   */
  readonly camera: CameraRequest;
}

/**
 * Media nodes in document order, with the one input each needs.
 *
 * T577 — a node that is OFF is not one of them. This is T555's answer, not a second rule:
 * a silenced SOURCE is not a capture candidate at all, which is the analogue of the
 * compiler dropping a muted node from the plan (T250) and of §V504's "a muted node is not
 * cooked". Muting a movie already removed its PICTURE — the compiler drops the node — and
 * its SOUND — the element is created `muted` — while the decoder kept running for a
 * texture nobody uploads, which is the wasted work this closes.
 *
 * `isSilencedSource` answers from the flags alone, which is only sound for a node with NO
 * INPUTS; all three media types declare `inputs: []` and the gate in `media-mute.test.tsx`
 * reddens if one grows an input, exactly as T555's does for the audio candidates.
 */
function mediaRequests(graph: GraphDocument): MediaRequest[] {
  const requests: MediaRequest[] = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined || !MEDIA_TYPES.has(node.type)) continue;
    if (isSilencedSource(node)) continue;
    requests.push({
      nodeId,
      type: node.type,
      // T1223: one reader for what a `file` parameter holds, shared with the classifier
      // and the transport's `inactiveWhen` — three surfaces that must agree about which
      // file a node names, or the picker, the loader and the dimming disagree.
      url: pictureFileUrl(node.parameters["file"]),
      // T810/T1043: raw read, like `url` above — the picker writes a plain string commit,
      // and driving a camera choice or a capture format from an expression is not a thing
      // this hook supports (see `cameraRequestOf`).
      camera: node.type === "webcam" ? cameraRequestOf(node.parameters) : NO_CAMERA_REQUEST,
    });
  }
  return requests;
}

const TEXT_ALIGNS = new Set(["left", "center", "right"]);
const TEXT_VALIGNS = new Set(["top", "middle", "bottom"]);

function text(value: ParameterValue | undefined, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function number(value: ParameterValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function colorValue(
  value: ParameterValue | undefined,
  fallback: readonly [number, number, number, number],
): readonly [number, number, number, number] {
  if (!Array.isArray(value) || value.length !== 4) return fallback;
  const channels = value.filter((entry): entry is number => typeof entry === "number");
  return channels.length === 4
    ? ([channels[0], channels[1], channels[2], channels[3]] as [number, number, number, number])
    : fallback;
}

/**
 * What a Text node wants drawn (T243), or null while its size is unknown.
 *
 * Parameters are read through `resolveParameters` — §V61's single read path — so an
 * expression or a driven slot on the string, the size or the colour reaches the canvas
 * like any other mode (§V107). Colours come from `entries[].value`, which stays in the
 * space the user picked (display/sRGB); a canvas paints in sRGB and the external texture
 * is `rgba8unorm-srgb`, so the one decode to linear happens in hardware at sample time
 * (§V56). Reading `values` instead would hand the canvas linear numbers and paint a
 * visibly washed-out string.
 *
 * A null return means the node has no resolved size yet — not compiled, or pruned — and a
 * node that renders nothing is exactly what a pruned node should look like.
 */
function textRasterFor(
  graph: GraphDocument,
  registry: NodeRegistryView,
  nodeId: NodeId,
  size: readonly [number, number] | undefined,
): TextRaster | null {
  const node = graph.nodes[nodeId];
  if (node === undefined || size === undefined) return null;
  const resolved = resolveParameters(node, registry.get(node.type));
  const read = (key: string): ParameterValue | undefined => resolved.get(key)?.value;

  const align = text(read("align"), "center");
  const valign = text(read("valign"), "middle");
  return {
    text: text(read("text"), ""),
    font: text(read("font"), "sans-serif"),
    size: number(read("size"), 96),
    color: colorValue(read("color"), [1, 1, 1, 1]),
    background: colorValue(read("bgcolor"), [0, 0, 0, 0]),
    align: (TEXT_ALIGNS.has(align) ? align : "center") as TextAlign,
    valign: (TEXT_VALIGNS.has(valign) ? valign : "middle") as TextVerticalAlign,
    lineSpacing: number(read("linespacing"), 1.2),
    width: size[0],
    height: size[1],
  };
}

function diagnostic(nodeId: NodeId, message: string, suggestion: string): RuntimeDiagnostic {
  return { severity: "warning", code: "media.unavailable", message, nodeId, suggestion };
}

/** Browser implementation. Nothing here is reachable from a headless caller. */
export function browserMediaEnvironment(): MediaEnvironment {
  const prepare = async (video: HTMLVideoElement): Promise<MediaElement> => {
    video.muted = true;
    video.playsInline = true;
    // T493: `video.loop = true` USED TO LIVE HERE, and it was the whole of the movie
    // node's "transport" — looping you could not turn off, in a browser default, with no
    // parameter naming it. The transport owns wrapping now (`extend`), and leaving the
    // element's own loop on would fight every seek the playhead asks for.
    video.loop = false;
    // Kicked, never AWAITED (T493, §V369): `play()` on a source that never decodes stays
    // pending forever, and awaiting it stranded this whole loop before `registerMediaSource`
    // — a black node with nothing reported. `awaitMediaReady` is the half that can fail.
    void video.play().catch(() => undefined);
    await awaitMediaReady(video);
    return video as unknown as MediaElement;
  };

  return {
    async openFile(url) {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.src = url;
      return prepare(video);
    },
    /**
     * T1223 — the door that did not exist. This whole function is what "no
     * `createImageBitmap`, no `HTMLImageElement`, no image branch anywhere" cost.
     *
     * `fetch` + `createImageBitmap` rather than an `<img>`: the decode failure is a
     * REJECTION with the format's own name in it, where an `<img>`'s `error` event carries
     * nothing useful; the result is a first-class `copyExternalImageToTexture` source; and
     * it can be `close()`d, which an `<img>` cannot.
     *
     * `premultiplyAlpha: "none"` is load-bearing (§V56): `copyExternalImageToTexture`
     * defaults to a NON-premultiplied destination, so a bitmap decoded the browser's usual
     * way would upload a PNG's semi-transparent edges already multiplied and darken them.
     * `colorSpaceConversion: "default"` leaves the file's own encoding alone, because the
     * external texture is `rgba8unorm-srgb` and the one decode to linear happens in
     * hardware at sample time — converting here would apply the curve twice.
     */
    async openStill(url) {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`The image could not be read (HTTP ${response.status}).`);
      const blob = await response.blob();
      return createImageBitmap(blob, {
        premultiplyAlpha: "none",
        colorSpaceConversion: "default",
      });
    },
    /**
     * T810: an exact deviceId when one is chosen, exactly as the microphone path (T434).
     * A vanished device throws OverconstrainedError, which the open loop turns into a
     * named fallback rather than a silent default.
     *
     * T1043: the size, rate and facing ride the same constraint object, built by
     * `cameraConstraints` — which returns literal `true` when nothing was asked, so a
     * document storing none of the new keys negotiates byte-for-byte as it did. The
     * VIDEO TRACK is kept, because it is the only thing that knows what was granted.
     */
    async openCamera(request) {
      const media = navigator.mediaDevices;
      if (media === undefined) throw new Error("This browser exposes no camera API.");
      const stream = await media.getUserMedia({
        video: cameraConstraints(request),
        audio: false,
      });
      const video = document.createElement("video");
      video.srcObject = stream;
      const element = await prepare(video);
      const track = stream.getVideoTracks()[0];
      return {
        element,
        // Read per call, never captured (§V986) — see `OpenedCamera`.
        grant: () => cameraGrantOf(track?.getSettings()),
        // `getCapabilities` is OPTIONAL on MediaStreamTrack and some browsers have none
        // for video at all. Absent is a different fact from "no limits", and the section
        // says which (§V986); the optional call is what keeps them distinguishable.
        limits: () => cameraLimitsOf(track?.getCapabilities?.()),
        stop: () => {
          for (const entry of stream.getTracks()) entry.stop();
        },
      };
    },
  };
}

const NO_DIAGNOSTICS: readonly RuntimeDiagnostic[] = [];

/**
 * The resolved output sizes this hook needs (T312).
 *
 * Structurally a slice of the compiled plan, so the caller passes the plan and this file
 * imports no compiler type: a hook that took a whole `CompiledGraph` would be claiming to
 * care about passes, resources and diagnostics it never reads.
 */
export interface ResolvedSizeSource {
  readonly outputs: ReadonlyArray<{
    readonly nodeId: NodeId;
    readonly size: readonly [number, number];
  }>;
}

export interface MediaWiring {
  /** Why a node is black. Merged into the problems surface (§I.diag). */
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** T465: empty the retained list; anything still real re-reports on its own. */
  clearDiagnostics(): void;
  /**
   * T493 — put every movie element where its transport says, once per rendered frame.
   *
   * Rides the frame loop's `advanceChannels` seam rather than an effect, because the
   * position is a function OF THE FRAME (§V436) and an effect has no frame. `channels`
   * is the value graph's resolver, so a driven `speed` or `trimStart` reaches the element
   * through the ordinary path (§V107) instead of a second one.
   */
  sync(frame: FrameEvaluationInput, channels?: ChannelResolver): void;
  /**
   * Whether the app's own transport is running. A timeline-locked movie must stop when
   * the timeline stops — with the loop paused no frames arrive, so `sync` cannot be what
   * notices, and an element left running would drift arbitrarily far while nothing moved.
   */
  setRunning(running: boolean): void;
  /**
   * T1043 — what one webcam node's camera is ASKING FOR and what it actually GOT.
   *
   * A function, called once per inspector render, because the grant it reads is live
   * (§V986) — `audioStatus`'s shape and for the same stated reason. Null for a node that
   * is not a webcam, or one whose camera has not been opened in this session.
   */
  cameraStatus(nodeId: NodeId): CameraStatus | null;
}

export function useMediaSources(
  runtime: AppRuntime,
  backend: LoomBackend | null,
  graph: GraphDocument,
  /** Resolved output sizes (T312). Null before the first successful compile. */
  resolved: ResolvedSizeSource | null,
  environment?: MediaEnvironment,
  /** T493: where `media.cue` and `media.reload` find this node. Optional for tests. */
  controls?: MediaControlRegistry,
): MediaWiring {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>(NO_DIAGNOSTICS);
  /**
   * T493 — a `reload` pulse re-opens the file, which is STRUCTURAL: the element is torn
   * down and rebuilt, exactly as a changed URL already does. So it is a dependency of the
   * open effect rather than a side door into it.
   *
   * HONEST LIMIT: the effect opens the document's media as a SET, so a reload re-opens
   * them all. With a timeline-locked transport that is invisible — every element seeks
   * straight back to `f(frame)` — but a free-run neighbour would lose its accumulator.
   * Scoping it per node wants the open loop restructured one node at a time.
   */
  const [reloadNonce, setReloadNonce] = useState(0);

  // One entry per node, from its FIRST output: a media node has one. Keyed by a flat
  // string so an unrelated recompile — a new node elsewhere, a parameter change — does not
  // look like a size change and redraw every text canvas.
  const sizes = useMemo(() => {
    const byNode = new Map<NodeId, readonly [number, number]>();
    for (const output of resolved?.outputs ?? []) {
      if (!byNode.has(output.nodeId)) byNode.set(output.nodeId, output.size);
    }
    return byNode;
  }, [resolved]);
  const sizeKey = [...sizes]
    .map(([nodeId, size]) => `${nodeId}:${size[0]}x${size[1]}`)
    .sort()
    .join(",");

  // The identity that decides whether a source must be re-opened: which nodes, of which
  // type, naming which file. A node moving on the canvas must not restart a camera.
  const requests = useMemo(() => mediaRequests(graph), [graph]);
  // T810: `device` is part of a request's identity — picking a different camera must
  // re-run the open effect, or the picker writes a parameter nothing reads until reload.
  // T1043: so is every other Capture knob, for exactly the same reason — a constraint is
  // handed to `getUserMedia` at OPEN time, so a size or rate that did not re-open would be
  // a control that writes a number and changes nothing until the next reload.
  const key = requests
    .map((request) => {
      const { device, width, height, frameRate, facing, exact } = request.camera;
      const camera = `${device}|${String(width)}x${String(height)}@${String(frameRate)}|${facing}|${String(exact)}`;
      return `${request.nodeId}|${request.type}|${request.url}|${camera}`;
    })
    .join("\n");

  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  /** Live text sources by node, so the content effect can push into them (T243). */
  const textSourcesRef = useRef(new Map<NodeId, TextMediaSource>());
  /**
   * T493 — live movie transports by node: the element to drive, and the runner that owns
   * its free-run accumulator. A webcam is deliberately absent — a live camera has no
   * playhead to derive, which is why the transport is on the FILE node and not on
   * `compileMedia`'s shared shape.
   */
  const playersRef = useRef(
    new Map<NodeId, { element: PlayableMedia; runner: MediaTransportRunner }>(),
  );
  /**
   * T1043 — live cameras by node: what was asked for, and the door that can still be asked
   * what was granted. An entry with a null `camera` is a camera that FAILED to open, kept
   * so the Camera section can say why where the user is looking rather than only in the
   * problems pane.
   */
  const camerasRef = useRef(
    new Map<NodeId, { requested: CameraRequest; camera: OpenedCamera | null; message?: string }>(),
  );
  const runningRef = useRef(true);
  /** The value graph's resolver, refreshed per frame by `sync`. */
  const channelsRef = useRef<ChannelResolver | undefined>(undefined);

  useEffect(() => {
    if (backend === null) return;
    const env = environment ?? browserMediaEnvironment();
    const open = requestsRef.current;
    let live = true;
    const opened: Array<{
      source: VideoMediaSource;
      unregister: () => void;
      /** T577: what the cleanup has to STOP, not merely unhook. */
      element: MediaElement;
      /** T1043: a camera's live tracks, which `pause()` does NOT stop. Null for a file. */
      camera: OpenedCamera | null;
    }> = [];
    /** T1223: stills, which have no element to stop — only a decoded bitmap to free. */
    const stillOpened: Array<{ source: VideoMediaSource; unregister: () => void }> = [];
    const textOpened: Array<{ nodeId: NodeId; source: TextMediaSource; unregister: () => void }> = [];
    // Captured here rather than read in the cleanup: by teardown the ref may already point
    // at the next render's map, and this effect must only take down what IT registered.
    const liveText = textSourcesRef.current;
    // Same capture rule as `liveText`, for the same reason (T493).
    const livePlayers = playersRef.current;
    // Same capture rule again, for the same reason (T1043).
    const liveCameras = camerasRef.current;
    const cameraOpened: NodeId[] = [];
    const playerOpened: NodeId[] = [];
    const released: Array<() => void> = [];
    const reported: RuntimeDiagnostic[] = [];

    /**
     * §V29 — the resolution override is a bus patch like every other edit, so it is
     * undoable, audited and attributed. Written once, when the size is first known.
     */
    const matchNodeResolution = (nodeId: NodeId, width: number, height: number) => {
      const current = graphRef.current.nodes[nodeId]?.resolution;
      if (
        current !== undefined &&
        current.mode === "fixed" &&
        current.width === width &&
        current.height === height
      ) {
        return;
      }
      void runtimeRef.current.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtimeRef.current.bus.store.getRevision(),
          label: "Match media size",
          operations: [
            { op: "setNodeResolution", nodeId, resolution: { mode: "fixed", width, height } },
          ],
        },
        runtimeRef.current.invocation,
      );
    };

    // TEXT first, and synchronously: there is nothing to await, no permission to ask for
    // and nothing that can be refused. Registering it inside the async loop below would
    // make a Text node's appearance wait on a camera prompt in front of it.
    for (const request of open) {
      if (request.type !== "text") continue;
      const source = (env.createTextSource ?? createTextMediaSource)();
      const unregister = backend.registerMediaSource(mediaSourceIdFor(request.nodeId), source.source);
      liveText.set(request.nodeId, source);
      textOpened.push({ nodeId: request.nodeId, source, unregister });
    }

    const start = async () => {
      for (const request of open) {
        if (!live) return;
        if (request.type === "text") continue;
        if (request.type === "movieFileIn" && request.url === "") {
          // Not an error: a node whose file has not been chosen is a node waiting, and
          // saying so is more useful than a warning that reads like a fault.
          continue;
        }

        /*
         * T1223 — THE STILL BRANCH, and the reason this node's description was a lie.
         *
         * `pictureFileKind` decides from the file's own name (a `blob:` URL is opaque, so
         * the extension lives in the fragment the picker appended). Three outcomes, and
         * none of them is silence:
         *
         *  - `hdr`  — REFUSED BY NAME. An EXR decoded into this node's `rgba8unorm-srgb`
         *             texture is a very expensive JPEG, and handing back 8-bit for a file
         *             the user picked FOR its range is the failure this task exists to
         *             close, not one to add. §T1222 builds the float path; until then the
         *             diagnostic names the format and what would make it go away.
         *  - `still`— a ONE-FRAME STREAM (see `createStillMediaSource`). No element, so
         *             no transport: `playableMedia` would have returned null for it
         *             anyway, and there is no playhead to derive for a picture that does
         *             not move. `reload` still registers, because re-opening the file is
         *             the one File-group verb that still means something.
         *  - `video`— everything below, unchanged.
         */
        if (request.type === "movieFileIn") {
          const refusal = hdrPictureRefusal(request.url);
          if (refusal !== null) {
            reported.push(
              diagnostic(
                request.nodeId,
                `The file for "${request.nodeId}" is not supported: ${refusal}`,
                "Pick a PNG, JPEG or video file, or wait for the float texture path (T1222).",
              ),
            );
            if (live) setDiagnostics([...reported]);
            continue;
          }
          if (pictureFileKind(request.url) === "still") {
            let image: StillImage;
            try {
              image = await env.openStill(request.url);
            } catch (error) {
              reported.push(
                diagnostic(
                  request.nodeId,
                  `The image for "${request.nodeId}" could not be decoded.`,
                  error instanceof Error ? error.message : "The browser refused the request.",
                ),
              );
              if (live) setDiagnostics([...reported]);
              continue;
            }
            const still = createStillMediaSource(image);
            if (!live) {
              still.dispose();
              return;
            }
            const unregisterStill = backend.registerMediaSource(
              mediaSourceIdFor(request.nodeId),
              still.source,
            );
            stillOpened.push({ source: still, unregister: unregisterStill });
            // The size is known the moment the decode resolves — no `loadedmetadata` to
            // wait for — and the node must adopt it for the same reason a video's node
            // does: `copyExternalImageToTexture` asserts matching extents (T312).
            const size = still.size();
            if (size !== null) matchNodeResolution(request.nodeId, size.width, size.height);
            const releaseStill = controls?.register(request.nodeId, {
              // NO `cue`, deliberately: a still has no playhead to cue TO, and a registered
              // no-op would make `media.cue` report success while nothing moved (§V369).
              // Absent, the command refuses BY NAME and says it is a still. `reload` is
              // present because re-opening the file is real work on any picture.
              reload: () => setReloadNonce((nonce) => nonce + 1),
            });
            if (releaseStill !== undefined) released.push(releaseStill);
            continue;
          }
        }

        let element: MediaElement;
        let camera: OpenedCamera | null = null;
        try {
          if (request.type === "webcam") {
            try {
              camera = await env.openCamera(request.camera);
            } catch (constrained) {
              /*
               * T810 — the chosen camera has VANISHED (unplugged between sessions).
               * Falling back silently would leave the picker lying about what is live,
               * so the fallback is taken AND named — the same two-step the microphone
               * path made for T434. Any other failure (permission denied, no camera at
               * all) falls through to the ordinary unavailable diagnostic, and the
               * §V687 understudy keeps the document playing either way.
               *
               * T1043 — THERE ARE NOW TWO WAYS TO BE OVERCONSTRAINED AND THEY WANT
               * OPPOSITE ANSWERS: a device that vanished (retry without it — the camera
               * the user meant is gone but a camera is better than black), and a REQUIRED
               * size or rate this camera does not have (do NOT retry — dropping the
               * constraint is exactly what Require exists to refuse, and a silent retry
               * would make Require and Prefer the same control).
               *
               * `OverconstrainedError.constraint` is the browser naming which one failed,
               * so the discrimination is read rather than guessed. Where it names nothing
               * — older engines leave it empty — the device is blamed, which is the
               * pre-T1043 behaviour and the only one a document with no format request
               * can possibly mean.
               */
              const failing = (constrained as { constraint?: string }).constraint ?? "";
              const blamesDevice = failing === "" || failing === "deviceId";
              if (
                request.camera.device === "" ||
                !blamesDevice ||
                (constrained as { name?: string }).name !== "OverconstrainedError"
              ) {
                throw constrained;
              }
              reported.push(
                diagnostic(
                  request.nodeId,
                  `The selected camera for "${request.nodeId}" is unavailable; using the system default.`,
                  "Re-pick a camera in the inspector, or leave it on the system default.",
                ),
              );
              if (live) setDiagnostics([...reported]);
              camera = await env.openCamera({ ...request.camera, device: "" });
            }
            element = camera.element;
          } else {
            element = await env.openFile(request.url);
          }
        } catch (error) {
          /*
           * T1043 — a REQUIRED format this camera cannot do is refused BY NAME, with the
           * numbers in the sentence. "The camera is unavailable" would be true and useless
           * here: the camera is fine, the request is not, and the user cannot tell those
           * apart from a message that names neither.
           */
          const overconstrained =
            request.type === "webcam" &&
            (error as { name?: string }).name === "OverconstrainedError" &&
            request.camera.exact;
          const message = overconstrained
            ? `The camera for "${request.nodeId}" cannot do the REQUIRED ${requiredFormatText(request.camera)}.`
            : request.type === "webcam"
              ? `The camera for "${request.nodeId}" is unavailable.`
              : `The file for "${request.nodeId}" could not be played.`;
          const suggestion = overconstrained
            ? "Set Fit to Prefer to take the camera's nearest mode instead, or ask for a size and rate this camera has."
            : error instanceof Error
              ? error.name
              : "The browser refused the request.";
          reported.push(diagnostic(request.nodeId, message, suggestion));
          if (request.type === "webcam") {
            liveCameras.set(request.nodeId, {
              requested: request.camera,
              camera: null,
              message,
            });
            cameraOpened.push(request.nodeId);
          }
          if (live) setDiagnostics([...reported]);
          continue;
        }
        if (!live) {
          camera?.stop();
          return;
        }
        if (camera !== null) {
          liveCameras.set(request.nodeId, { requested: request.camera, camera });
          cameraOpened.push(request.nodeId);
        }

        const media = createVideoMediaSource(element);
        const unregister = backend.registerMediaSource(
          mediaSourceIdFor(request.nodeId),
          media.source,
        );
        opened.push({ source: media, unregister, element, camera });

        // T493: a FILE gets a transport; a camera does not. A live stream has no playhead
        // to derive — asking a webcam to seek to second four is not a thing — so the
        // transport is on the node that has a file, and the element that cannot be driven
        // simply is not (see `playableMedia`).
        if (request.type === "movieFileIn") {
          const playable = playableMedia(element);
          if (playable !== null) {
            const runner = createMediaTransportRunner(request.nodeId, {
              graph: () => graphRef.current,
              registry: runtimeRef.current.registry,
              channels: () => channelsRef.current,
            });
            livePlayers.set(request.nodeId, { element: playable, runner });
            playerOpened.push(request.nodeId);
            const release = controls?.register(request.nodeId, {
              cue: () => runner.cue(),
              reload: () => setReloadNonce((nonce) => nonce + 1),
            });
            if (release !== undefined) released.push(release);
          }
        }

        // The size arrives with the first decoded frame, which is after `play()` resolves.
        const applySize = () => {
          const size = media.size();
          if (size === null || !live) return;
          matchNodeResolution(request.nodeId, size.width, size.height);
          element.removeEventListener("loadedmetadata", applySize);
          element.removeEventListener("resize", applySize);
        };
        element.addEventListener("loadedmetadata", applySize);
        element.addEventListener("resize", applySize);
        applySize();
      }
    };

    void start();

    return () => {
      live = false;
      for (const entry of opened) {
        entry.unregister();
        entry.source.dispose();
        // T577: `dispose` only unhooks the frame callback — it leaves the element PLAYING,
        // so a node that stopped being a request went on decoding for nobody. That is the
        // wasted work itself, and unregistering the source cannot reach it. Probed
        // structurally through `playableMedia` for the same reason the transport does: it
        // is the one place that knows what "an element you can drive" means.
        playableMedia(entry.element)?.pause();
        /*
         * T1043 — and `pause()` IS NOT ENOUGH FOR A CAMERA. Pausing the element detaches
         * the sink; the `MediaStream`'s tracks keep capturing and the camera's indicator
         * light stays on for a node that no longer exists. Only the door that opened the
         * stream holds the tracks, which is why stopping them is on `OpenedCamera` — the
         * microphone path has stopped its tracks since T434 and this half never did.
         */
        entry.camera?.stop();
      }
      for (const entry of stillOpened) {
        entry.unregister();
        // T1223: `dispose` closes the ImageBitmap. A 4K still holds ~32 MB of decoded
        // bytes, so a document swap that only unregistered would leak one per picked file.
        entry.source.dispose();
      }
      for (const entry of textOpened) {
        entry.unregister();
        entry.source.dispose();
        liveText.delete(entry.nodeId);
      }
      for (const nodeId of playerOpened) livePlayers.delete(nodeId);
      for (const nodeId of cameraOpened) liveCameras.delete(nodeId);
      for (const release of released) release();
      setDiagnostics(NO_DIAGNOSTICS);
    };
    // `key` is the identity of the request set; `requestsRef` carries the values, so a
    // node moving on the canvas does not restart a camera.
  }, [backend, controls, environment, key, reloadNonce]);

  /**
   * What each Text node draws, pushed after registration (T243, T312).
   *
   * Separate from the effect above because the two change on different clocks: typing
   * changes CONTENT many times a second and must never re-register a source, while the
   * set of media nodes changes when someone edits the graph's shape. The source itself
   * decides whether anything actually changed and only then advances its frame id
   * (§V136), so a re-render that touches nothing uploads nothing.
   */
  useEffect(() => {
    for (const [nodeId, source] of textSourcesRef.current) {
      const raster = textRasterFor(graph, runtimeRef.current.registry, nodeId, sizes.get(nodeId));
      if (raster !== null) source.update(raster);
    }
  }, [graph, sizes, sizeKey, key]);

  /**
   * T493 — the per-frame half, and the half that makes the parameters real.
   *
   * Six times in this codebase a feature has been built, tested and left unreachable
   * (B12, B23, T264, B87 …). A transport whose parameters resolve correctly and never
   * reach a `<video>` would be the seventh. This is the reach.
   */
  const sync = useCallback((frame: FrameEvaluationInput, channels?: ChannelResolver) => {
    channelsRef.current = channels;
    runningRef.current = true;
    for (const { element, runner } of playersRef.current.values()) {
      const stepped = runner.step(frame, durationOf(element));
      if (stepped === null) continue;
      applyMediaPlayhead(element, stepped.transport, stepped.head);
    }
  }, []);

  const setRunning = useCallback((running: boolean) => {
    runningRef.current = running;
    if (running) return;
    // Paused: the timeline is not producing frames, so nothing will correct the drift.
    // Stop where we are rather than letting the element run on its own clock — that is
    // the state that made "pause" and "the picture froze but the sound kept going".
    for (const { element } of playersRef.current.values()) {
      if (!element.paused) element.pause();
    }
  }, []);

  /**
   * T1043 — the request beside the grant, for ONE webcam node.
   *
   * The grant is read HERE, on every call, straight off the live track (§V986) — never
   * copied into a ref at open time. `audioStatus` recomputes its latency for the same
   * reason and says so; a camera's settings move for a longer list of reasons than an
   * `AudioContext`'s latency does.
   *
   * NOTHING IN HERE EVER FILLS THE GRANT FROM THE REQUEST. That is the one line that keeps
   * this from becoming §B172's echo: a camera with no reportable settings comes back with
   * `granted: null`, and the section says the browser did not report — never the number the
   * user typed, dressed up as a measurement.
   */
  const cameraStatus = useCallback((nodeId: NodeId): CameraStatus | null => {
    const entry = camerasRef.current.get(nodeId);
    if (entry === undefined) return null;
    if (entry.camera === null) {
      return {
        kind: "error",
        ...(entry.message === undefined ? {} : { message: entry.message }),
        requested: entry.requested,
        granted: null,
        limits: null,
      };
    }
    return {
      kind: "live",
      requested: entry.requested,
      granted: entry.camera.grant(),
      limits: entry.camera.limits(),
    };
  }, []);

  // T465: the problems tab's Clear empties every ACCUMULATING source; anything still
  // real re-reports on its own and thereby proves it is live.
  const clearDiagnostics = useCallback(() => setDiagnostics([]), []);
  return { diagnostics, clearDiagnostics, sync, setRunning, cameraStatus };
}
