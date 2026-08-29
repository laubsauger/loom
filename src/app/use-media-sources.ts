import { useEffect, useMemo, useRef, useState } from "react";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { mediaSourceIdFor } from "@nodes/definitions/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { createVideoMediaSource } from "./media-sources.ts";
import type { MediaElement, VideoMediaSource } from "./media-sources.ts";

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
 * ## Intrinsic size is not node size
 *
 * `copyExternalImageToTexture` asserts matching extents: it will not scale a 1920x1080
 * camera frame into a 1280x720 target, and the bytes path has the same rule. So once the
 * intrinsic size is known this sets the node's resolution override to it — through the
 * bus, as one `setNodeResolution` patch (§V29), and only when it actually differs, so a
 * live camera does not write a patch per frame.
 */

/** The environment this hook needs. Injectable, so a test needs no camera and no codec. */
export interface MediaEnvironment {
  /** Creates a video element bound to `url`, already playing. Throws to report failure. */
  openFile(url: string): Promise<MediaElement>;
  /** Opens the default camera. Throws (permission denied, no device) to report failure. */
  openCamera(): Promise<MediaElement>;
}

const MEDIA_TYPES = new Set(["movieFileIn", "webcam"]);

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

export interface MediaWiring {
  /** Why a node is black. Merged into the problems surface (§I.diag). */
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

export function useMediaSources(
  runtime: AppRuntime,
  backend: ShaderloomBackend | null,
  graph: GraphDocument,
  environment?: MediaEnvironment,
): MediaWiring {
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>(NO_DIAGNOSTICS);

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

  useEffect(() => {
    if (backend === null) return;
    const env = environment ?? browserMediaEnvironment();
    const open = requestsRef.current;
    let live = true;
    const opened: Array<{ source: VideoMediaSource; unregister: () => void }> = [];
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

    const start = async () => {
      for (const request of open) {
        if (!live) return;
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
      setDiagnostics(NO_DIAGNOSTICS);
    };
    // `key` is the identity of the request set; `requestsRef` carries the values, so a
    // node moving on the canvas does not restart a camera.
  }, [backend, environment, key]);

  return { diagnostics };
}
