import { useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import { resolveParameters } from "@domain/parameters/index.ts";
import { mediaSourceIdFor } from "@nodes/definitions/index.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { createVideoMediaSource } from "./media-sources.ts";
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
  /** Opens the default camera. Throws (permission denied, no device) to report failure. */
  openCamera(): Promise<MediaElement>;
  /** Text rasterizer factory (T243). Defaults to the browser one. */
  createTextSource?(): TextMediaSource;
}

const MEDIA_TYPES = new Set(["movieFileIn", "webcam", "text"]);

interface MediaRequest {
  readonly nodeId: NodeId;
  readonly type: string;
  /** The file a movie node names. Empty for a webcam, and for a movie with no file yet. */
  readonly url: string;
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

/** Media nodes in document order, with the one input each needs. */
function mediaRequests(graph: GraphDocument): MediaRequest[] {
  const requests: MediaRequest[] = [];
  for (const nodeId of Object.keys(graph.nodes).sort()) {
    const node = graph.nodes[nodeId];
    if (node === undefined || !MEDIA_TYPES.has(node.type)) continue;
    requests.push({ nodeId, type: node.type, url: urlOf(node.parameters["file"]) });
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

function rgba(
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
    color: rgba(read("color"), [1, 1, 1, 1]),
    background: rgba(read("bgcolor"), [0, 0, 0, 0]),
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
    video.loop = true;
    await video.play();
    return video as unknown as MediaElement;
  };

  return {
    async openFile(url) {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.src = url;
      return prepare(video);
    },
    async openCamera() {
      const media = navigator.mediaDevices;
      if (media === undefined) throw new Error("This browser exposes no camera API.");
      const stream = await media.getUserMedia({ video: true, audio: false });
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
}

export function useMediaSources(
  runtime: AppRuntime,
  backend: ShaderloomBackend | null,
  graph: GraphDocument,
  /** Resolved output sizes (T312). Null before the first successful compile. */
  resolved: ResolvedSizeSource | null,
  environment?: MediaEnvironment,
): MediaWiring {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>(NO_DIAGNOSTICS);

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
  const key = requests.map((request) => `${request.nodeId}|${request.type}|${request.url}`).join("\n");

  const runtimeRef = useRef(runtime);
  runtimeRef.current = runtime;
  const graphRef = useRef(graph);
  graphRef.current = graph;
  const requestsRef = useRef(requests);
  requestsRef.current = requests;
  /** Live text sources by node, so the content effect can push into them (T243). */
  const textSourcesRef = useRef(new Map<NodeId, TextMediaSource>());

  useEffect(() => {
    if (backend === null) return;
    const env = environment ?? browserMediaEnvironment();
    const open = requestsRef.current;
    let live = true;
    const opened: Array<{ source: VideoMediaSource; unregister: () => void }> = [];
    const textOpened: Array<{ nodeId: NodeId; source: TextMediaSource; unregister: () => void }> = [];
    // Captured here rather than read in the cleanup: by teardown the ref may already point
    // at the next render's map, and this effect must only take down what IT registered.
    const liveText = textSourcesRef.current;
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
          element =
            request.type === "webcam"
              ? await env.openCamera()
              : await env.openFile(request.url);
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
        opened.push({ source: media, unregister });

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
      }
      for (const entry of textOpened) {
        entry.unregister();
        entry.source.dispose();
        liveText.delete(entry.nodeId);
      }
      setDiagnostics(NO_DIAGNOSTICS);
    };
    // `key` is the identity of the request set; `requestsRef` carries the values, so a
    // node moving on the canvas does not restart a camera.
  }, [backend, environment, key]);

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

  return { diagnostics };
}
