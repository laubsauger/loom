import { useMemo, useRef } from "react";

import type { AgentPorts, PointsExport, PreviewExport } from "@agent/index.ts";
import type { CompiledGraph } from "../compiler/types.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import {
  createExportInterface,
  createPointsReadback,
  describeOutputStats,
  exportOutputsFrom,
  readbackSourceFromBackend,
  renderPreviewPng,
} from "@runtime/export/index.ts";
import { pointSetInfoFor } from "@nodes/definitions/index.ts";
import type { GraphDocument } from "@domain/types/graph.ts";

/**
 * The agent's pixel ports, CONSTRUCTED (T291 — and B12's shape closed a third time):
 * `render_preview` and `describe_output` were built, tested and unavailable in the
 * product because nothing in `src/app/**` handed the surface a preview port. This hook
 * is that seam: an export interface over the live backend and the CURRENT plan (read
 * through refs, so the port never answers from a stale render), exposed as the
 * `preview` port the tools already require.
 *
 * §V48 stands: everything goes through the export interface, nothing calls the backend
 * for pixels directly. `isPlaying` is wired truthfully so a read during playback is
 * governed by the export interface's own policy rather than silently permitted.
 */
export function useAgentPorts(inputs: {
  backend: ShaderloomBackend | undefined;
  compiled: CompiledGraph | null;
  playing: boolean;
  graph: () => GraphDocument;
}): AgentPorts {
  const compiledRef = useRef(inputs.compiled);
  compiledRef.current = inputs.compiled;
  const playingRef = useRef(inputs.playing);
  playingRef.current = inputs.playing;
  const graphRef = useRef(inputs.graph);
  graphRef.current = inputs.graph;

  const backend = inputs.backend;
  return useMemo(() => {
    if (backend === undefined) return {};
    const exports = createExportInterface({
      source: readbackSourceFromBackend(backend),
      outputs: () => exportOutputsFrom(compiledRef.current?.outputs ?? []),
      isPlaying: () => playingRef.current,
    });
    const preview: PreviewExport = {
      async renderPreview({ ref, maxSize }) {
        const capture = await renderPreviewPng(exports, ref, { maxWidth: maxSize, maxHeight: maxSize });
        return { ref, mimeType: "image/png", width: capture.width, height: capture.height, bytes: capture.bytes };
      },
      describeOutput: (ref) => describeOutputStats(exports, ref),
    };
    // T293: the read_points port — the same B12 shape closed in the same pass it was
    // found. Date.now is injected HERE, at the composition root, which is the one
    // place the §V44 boundary permits a wall clock.
    const points: PointsExport = createPointsReadback({
      readBuffer: (resourceId) => backend.readBuffer(resourceId),
      pointSetInfo: (nodeId) => {
        const node = graphRef.current().nodes[nodeId];
        return node === undefined ? undefined : pointSetInfoFor(node);
      },
      now: Date.now,
    });
    return { preview, points };
  }, [backend]);
}
