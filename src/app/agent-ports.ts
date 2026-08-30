import { useMemo, useRef } from "react";

import type { AgentPorts, PreviewExport } from "@agent/index.ts";
import type { CompiledGraph } from "../compiler/types.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import {
  createExportInterface,
  describeOutputStats,
  exportOutputsFrom,
  readbackSourceFromBackend,
  renderPreviewPng,
} from "@runtime/export/index.ts";

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
}): AgentPorts {
  const compiledRef = useRef(inputs.compiled);
  compiledRef.current = inputs.compiled;
  const playingRef = useRef(inputs.playing);
  playingRef.current = inputs.playing;

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
    return { preview };
  }, [backend]);
}
