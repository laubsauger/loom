import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { ResolvedOutput } from "@compiler/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { liveClock } from "@domain/transport/live-clock.ts";
import { DEFAULT_PREVIEW_VIEW, createPreviewSystem } from "@runtime/previews/index.ts";
import type { PreviewRequest, PreviewSystem } from "@runtime/previews/index.ts";

/**
 * The graph BACKGROUND (T463): every node flagged `ui.background` renders behind the
 * patch — TD's network background, the way a lot of people actually work.
 *
 * It reuses more than it builds. The pane already owns a full-surface GPU canvas for
 * node previews (T185); this is the same preview system on a SECOND canvas, one
 * z-layer down — beneath the nodes, above the dot grid (`graph-canvas.tsx` renders it
 * next to React Flow's own Background, in the same negative-z stacking slot). Marking
 * a node IS watching it, so the refs join T252's preview-sink set: one materialization
 * shared with any tile or viewer already watching, zero cost when nothing is flagged.
 * Full brightness, the owner's call — TD does not dim its network background either;
 * if a dim ever returns it is CSS opacity on the canvas (per-person chrome), never a
 * touch on the pixels an export or viewer sees.
 *
 * The image letterboxes into the pane (§V118: never stretch — a background that
 * misrepresents aspect is worse than bars). Several marked nodes stack in document
 * order, later over earlier.
 */

/** Backgrounds are big and behind everything; a handful is already a light show. */
const BACKGROUND_TILE_CAPACITY = 4;

/** Refresh a background at preview cadence — it is ambience, not the picture. */
export interface GraphBackgroundInputs {
  readonly backend: ShaderloomBackend | null;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly graph: GraphDocument;
  readonly compiledOutputs: ReadonlyArray<ResolvedOutput>;
  /** T252 (§V158): the same sink set the tile scheduler feeds — refs merge. */
  readonly previewSinks?: { set(refs: ReadonlyArray<{ nodeId: string; portId: string }>): void };
  readonly previewFps: number;
  readonly previewLongEdge: number;
}

/** The marked nodes, in document order — exported for the wiring test. */
export function graphBackgroundMarks(
  graph: GraphDocument,
  outputs: ReadonlyArray<ResolvedOutput>,
): Array<{ nodeId: string; output: ResolvedOutput | undefined }> {
  return Object.keys(graph.nodes)
    .sort()
    .filter((nodeId) => graph.nodes[nodeId]?.ui?.background === true)
    .map((nodeId) => ({
      nodeId,
      output: outputs.find(
        (entry) => entry.nodeId === nodeId && entry.resourceKind !== "pointset",
      ),
    }));
}

/** §V118: letterbox the output inside the surface, centred — never stretched. */
export function backgroundRect(
  surface: { width: number; height: number },
  size: readonly [number, number],
): { x: number; y: number; width: number; height: number } {
  const scale = Math.min(surface.width / Math.max(size[0], 1), surface.height / Math.max(size[1], 1));
  const width = size[0] * scale;
  const height = size[1] * scale;
  return { x: (surface.width - width) / 2, y: (surface.height - height) / 2, width, height };
}

export function useGraphBackground(inputs: GraphBackgroundInputs): void {
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;

  useEffect(() => {
    const canvas = inputs.canvasRef.current;
    const backend = inputs.backend;
    if (backend === null || canvas === null) return;

    const host = backend.previewHost(canvas);
    const system: PreviewSystem = createPreviewSystem({ host, capacity: BACKGROUND_TILE_CAPACITY });
    const clock = liveClock();
    let lastDeviceGeneration = backend.status.deviceGeneration;
    let frameHandle = 0;

    const tick = (): void => {
      frameHandle = requestAnimationFrame(tick);

      if (backend.status.deviceGeneration !== lastDeviceGeneration) {
        lastDeviceGeneration = backend.status.deviceGeneration;
        system.reset();
      }

      const current = inputsRef.current;
      const marks = graphBackgroundMarks(current.graph, current.compiledOutputs);
      // Marking IS watching (T252): the refs keep their nodes materialized. The sink
      // store merges callers, so this coexists with the tile scheduler's own set.
      if (marks.length > 0) {
        current.previewSinks?.set(
          marks
            .map((mark) => mark.output)
            .filter((output): output is ResolvedOutput => output !== undefined)
            .map((output) => ({ nodeId: output.nodeId, portId: output.portId }))
            .concat(
              // Not yet materialized: register by the node's first port anyway — the
              // sink is what triggers the recompile that materializes it (T252).
              marks
                .filter((mark) => mark.output === undefined)
                .map((mark) => ({ nodeId: mark.nodeId, portId: "out" })),
            ),
        );
      }

      const rect = canvas.getBoundingClientRect();
      const surface = { x: 0, y: 0, width: rect.width, height: rect.height };
      const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

      const requests: PreviewRequest[] = [];
      for (const mark of marks) {
        const output = mark.output;
        if (output === undefined) continue;
        requests.push({
          ref: { nodeId: output.nodeId, portId: output.portId },
          source: {
            resourceId: output.resourceId,
            size: output.size,
            format: output.format,
            space: output.space,
          },
          rect: backgroundRect(surface, output.size),
          area: { width: Math.round(surface.width), height: Math.round(surface.height) },
          visible: true,
          // A background is deliberately always on while marked — scrolling the graph
          // never scrolls it away, so there is nothing for visibility to gate.
          pinned: true,
          collapsed: false,
          occluded: false,
          view: DEFAULT_PREVIEW_VIEW,
          fps: current.previewFps,
        });
      }

      system.update({
        requests,
        frame: clock.next(),
        surface,
        devicePixelRatio,
        previewFps: current.previewFps,
        previewLongEdge: current.previewLongEdge,
      });
    };

    frameHandle = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(frameHandle);
      host.dispose();
    };
    // The ref carries per-tick inputs; the effect re-runs only for a new surface/backend.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs.backend, inputs.canvasRef]);
}
