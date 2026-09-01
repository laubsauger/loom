import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import { isSilencedSource } from "@domain/graph/bypass.ts";
import { resolveParameters } from "@domain/parameters/index.ts";
import { mediaSourceIdFor } from "@nodes/definitions/index.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
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
import { awaitMediaReady, createVideoMediaSource } from "./media-sources.ts";
import type { MediaElement, VideoMediaSource } from "./media-sources.ts";
import { createTextMediaSource } from "./text-source.ts";
import type { TextAlign, TextMediaSource, TextRaster, TextVerticalAlign } from "./text-source.ts";

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
 * The environment this hook needs. Injectable, so a test needs no camera, no codec — and,
 * since T243, no canvas: jsdom's `getContext("2d")` returns null, so a text source built
 * on the real factory would register and then quietly draw nothing in a test.
 */
export interface MediaEnvironment {
  /** Creates a video element bound to `url`, already playing. Throws to report failure. */
  openFile(url: string): Promise<MediaElement>;
  /**
   * Opens a camera. T810: an empty `device` is the system default; a non-empty one is
   * an EXACT `deviceId` and a vanished device throws `OverconstrainedError` — the open
   * loop owns the retry-bare fallback and the diagnostic that names it, so the
   * environment stays a dumb door (the same split `use-audio-input` made for T434).
   * Throws (permission denied, no device) to report failure.
   */
  openCamera(device: string): Promise<MediaElement>;
  /** Text rasterizer factory (T243). Defaults to the browser one. */
  createTextSource?(): TextMediaSource;
}

const MEDIA_TYPES = new Set(["movieFileIn", "webcam", "text"]);

interface MediaRequest {
  readonly nodeId: NodeId;
  readonly type: string;
  /** The file a movie node names. Empty for a webcam, and for a movie with no file yet. */
  readonly url: string;
  /** T810: the webcam's chosen camera ("" = system default). Empty for every other type. */
  readonly device: string;
}

/** What a node's `file` parameter holds. Stored by whatever UI wrote it, so read widely. */
function urlOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null) {
    const url = (value as { url?: unknown }).url;
    if (typeof url === "string") return url;
  }
  return "";
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
      url: urlOf(node.parameters["file"]),
      // T810: raw read, like `url` above — the picker writes a plain string commit, and
      // driving a camera choice from an expression is not a thing this hook supports.
      device:
        node.type === "webcam" && typeof node.parameters["device"] === "string"
          ? node.parameters["device"]
          : "",
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
    async openCamera(device) {
      const media = navigator.mediaDevices;
      if (media === undefined) throw new Error("This browser exposes no camera API.");
      // T810: an exact deviceId when one is chosen, exactly as the microphone path
      // (T434). A vanished device throws OverconstrainedError, which the open loop
      // turns into a named fallback rather than a silent default.
      const stream = await media.getUserMedia({
        video: device.trim() === "" ? true : { deviceId: { exact: device } },
        audio: false,
      });
      const video = document.createElement("video");
      video.srcObject = stream;
      return prepare(video);
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
}

export function useMediaSources(
  runtime: AppRuntime,
  backend: ShaderloomBackend | null,
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
  const key = requests
    .map((request) => `${request.nodeId}|${request.type}|${request.url}|${request.device}`)
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
    }> = [];
    const textOpened: Array<{ nodeId: NodeId; source: TextMediaSource; unregister: () => void }> = [];
    // Captured here rather than read in the cleanup: by teardown the ref may already point
    // at the next render's map, and this effect must only take down what IT registered.
    const liveText = textSourcesRef.current;
    // Same capture rule as `liveText`, for the same reason (T493).
    const livePlayers = playersRef.current;
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
        let element: MediaElement;
        try {
          if (request.type === "webcam") {
            try {
              element = await env.openCamera(request.device);
            } catch (constrained) {
              /*
               * T810 — the chosen camera has VANISHED (unplugged between sessions).
               * Falling back silently would leave the picker lying about what is live,
               * so the fallback is taken AND named — the same two-step the microphone
               * path made for T434. Any other failure (permission denied, no camera at
               * all) falls through to the ordinary unavailable diagnostic, and the
               * §V687 understudy keeps the document playing either way.
               */
              if (
                request.device === "" ||
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
              element = await env.openCamera("");
            }
          } else {
            element = await env.openFile(request.url);
          }
        } catch (error) {
          reported.push(
            diagnostic(
              request.nodeId,
              request.type === "webcam"
                ? `The camera for "${request.nodeId}" is unavailable.`
                : `The file for "${request.nodeId}" could not be played.`,
              error instanceof Error ? error.name : "The browser refused the request.",
            ),
          );
          if (live) setDiagnostics([...reported]);
          continue;
        }
        if (!live) return;

        const media = createVideoMediaSource(element);
        const unregister = backend.registerMediaSource(
          mediaSourceIdFor(request.nodeId),
          media.source,
        );
        opened.push({ source: media, unregister, element });

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
      }
      for (const entry of textOpened) {
        entry.unregister();
        entry.source.dispose();
        liveText.delete(entry.nodeId);
      }
      for (const nodeId of playerOpened) livePlayers.delete(nodeId);
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

  // T465: the problems tab's Clear empties every ACCUMULATING source; anything still
  // real re-reports on its own and thereby proves it is live.
  const clearDiagnostics = useCallback(() => setDiagnostics([]), []);
  return { diagnostics, clearDiagnostics, sync, setRunning };
}
