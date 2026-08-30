import type { AgentPorts, PointsExport, PreviewExport } from "../../agent/index.ts";
import type { CompiledGraph } from "../../compiler/types.ts";
import type { ShaderloomBackend } from "../backend/index.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import type { PixelProbe } from "../previews/index.ts";
import type { ExportInterface } from "./types.ts";
import {
  createExportInterface,
  createPixelProbe,
  createPointsReadback,
  describeOutputStats,
  exportOutputsFrom,
  readbackSourceFromBackend,
  renderPreviewPng,
} from "./index.ts";
import { pointSetInfoFor } from "../../nodes/definitions/index.ts";

/**
 * The agent's pixel ports as a PURE factory (T294 splitting T291's hook): the same
 * `preview` and `points` ports the in-tab agent gets, buildable anywhere a backend
 * exists — the React hook wraps this with refs, the headless MCP server calls it
 * directly, and the two cannot drift because there is one body.
 *
 * §V48 stands: everything goes through the export interface, nothing reads pixels off
 * the backend directly. Inputs are GETTERS so a port never answers from a stale plan.
 *
 * It also returns the VIEWER's pixel probe (T329), from THIS export interface rather than
 * a second one. The interface keeps counters — readbacks, refusals, bytes and a once-only
 * playback warning — so a second instance would split the accounting in half and warn
 * twice about the same thing. The extra field is additive: a caller that wants only
 * `AgentPorts` is unaffected.
 */
export function createAgentPorts(inputs: {
  backend: ShaderloomBackend;
  compiled: () => CompiledGraph | null;
  playing: () => boolean;
  graph: () => GraphDocument;
  now: () => number;
}): AgentPorts & { readonly probe: PixelProbe; readonly exports: ExportInterface } {
  const { backend } = inputs;
  const exports = createExportInterface({
    source: readbackSourceFromBackend(backend),
    outputs: () => exportOutputsFrom(inputs.compiled()?.outputs ?? []),
    isPlaying: () => inputs.playing(),
  });
  const preview: PreviewExport = {
    async renderPreview({ ref, maxSize }) {
      const capture = await renderPreviewPng(exports, ref, { maxWidth: maxSize, maxHeight: maxSize });
      return { ref, mimeType: "image/png", width: capture.width, height: capture.height, bytes: capture.bytes };
    },
    describeOutput: (ref) => describeOutputStats(exports, ref),
  };
  const points: PointsExport = createPointsReadback({
    readBuffer: (resourceId) => backend.readBuffer(resourceId),
    pointSetInfo: (nodeId) => {
      const node = inputs.graph().nodes[nodeId];
      return node === undefined ? undefined : pointSetInfoFor(node);
    },
    now: inputs.now,
  });
  // T433 — the timeline render takes THIS interface, not one of its own. The counters
  // (readbacks, refusals, bytes, the once-only playback warning) live on the instance, so
  // a second one would split the accounting in half and warn twice about one thing — the
  // same reason the probe is returned from here rather than built beside it.
  return { preview, points, probe: createPixelProbe(exports), exports };
}
