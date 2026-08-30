import { useMemo, useRef } from "react";

import type { AgentPorts } from "@agent/index.ts";
import type { PixelProbe } from "@runtime/previews/index.ts";
import type { ExportInterface } from "@runtime/export/index.ts";
import type { CompiledGraph } from "../compiler/types.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { createAgentPorts } from "@runtime/export/agent-ports.ts";
import type { GraphDocument } from "@domain/types/graph.ts";

/**
 * The agent's pixel ports, CONSTRUCTED (T291 — and B12's shape closed a third time):
 * `render_preview` and `describe_output` were built, tested and unavailable in the
 * product because nothing in `src/app/**` handed the surface a preview port. This hook
 * is that seam. The BODY lives in `runtime/export/agent-ports.ts` (T294): the headless
 * MCP server builds the same ports from the same factory, so the two pipes cannot
 * drift. Refs keep every getter answering from the CURRENT render; `Date.now` is
 * injected here, at a composition root — the one place §V44 permits a wall clock.
 */
export function useAgentPorts(inputs: {
  backend: ShaderloomBackend | undefined;
  compiled: CompiledGraph | null;
  playing: boolean;
  graph: () => GraphDocument;
}): AgentPorts & { probe?: PixelProbe | undefined; exports?: ExportInterface | undefined } {
  const compiledRef = useRef(inputs.compiled);
  compiledRef.current = inputs.compiled;
  const playingRef = useRef(inputs.playing);
  playingRef.current = inputs.playing;
  const graphRef = useRef(inputs.graph);
  graphRef.current = inputs.graph;

  const backend = inputs.backend;
  return useMemo(() => {
    if (backend === undefined) return {};
    return createAgentPorts({
      backend,
      compiled: () => compiledRef.current,
      playing: () => playingRef.current,
      graph: () => graphRef.current(),
      now: Date.now,
    });
  }, [backend]);
}
