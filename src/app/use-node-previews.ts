import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { liveClock } from "@domain/transport/live-clock.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ResolvedOutput } from "@compiler/index.ts";
import type { NodeRuntimeStore } from "@editor/graph-canvas/index.ts";
import { fitInsideRegion } from "@editor/nodes/index.ts";
import type { PreviewSlotBoundsStore, PreviewViewSource } from "@editor/viewer/index.ts";
import { DEFAULT_PREVIEW_VIEW, createPreviewSystem, slotScreenRect } from "@runtime/previews/index.ts";
import type { PreviewRequest, PreviewSystem, ViewportTransform } from "@runtime/previews/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * Mounts the shared preview surface and feeds it every node's tile request (T185).
 *
 * The scheduler, the tile pool and the debug-effect programs already existed and were
 * fully tested (`src/runtime/previews/**`) with no caller anywhere in the app — the node
 * body's preview region was, and stays, an empty `<div>` until something calls
 * `previewSystem.update()`. This is that caller.
 *
 * Driven by its own `requestAnimationFrame`, deliberately separate from `backend.loop()`
 * (`use-frame-loop.ts`): `PreviewSystem.plan()` allocates and must run OUTSIDE frame
 * encoding (§V8), and a standalone tick is the documented way to get that for free —
 * `update()` is exactly "plan() then present(), outside the frame" (`system.ts`). Tile
 * CONTENT still refreshes at `previewFps`; this tick, like `backend.loop`'s own
 * scheduler, just runs at display rate to keep tile PLACEMENT in sync with pan (design
 * note §3) — cheap, because nothing here allocates when nothing about the active set
 * changed.
 *
 * §V28a: every eligible node is offered as a request every tick — visibility (on
 * screen or not) and the pin are read by the scheduler that already exists, never
 * re-decided here.
 */

const PREVIEW_TILE_CAPACITY = 48;

export interface NodePreviewInputs {
  /**
   * T252 (§V158): where the scheduler's kept set goes, so the COMPILER materializes
   * exactly what is watched. Optional: absent means nobody is gating on previews.
   */
  readonly previewSinks?: { set(refs: ReadonlyArray<{ nodeId: string; portId: string }>): void };
  readonly backend: ShaderloomBackend | null | undefined;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly bounds: PreviewSlotBoundsStore;
  /**
   * T336: per-node preview LENS. `PreviewRequest.view` has been on this request since T34 and
   * every caller passed the default, so channel isolation, exposure and the tonemap were live
   * in the shader and unreachable from the product (§V220, §V255). Absent = the default view,
   * which is what a caller with no lens store means.
   */
  readonly views?: PreviewViewSource | undefined;
  readonly graph: GraphDocument;
  readonly registry: NodeRegistryView;
  readonly compiledOutputs: ReadonlyArray<ResolvedOutput>;
  readonly nodeRuntime: NodeRuntimeStore;
  readonly getViewport: () => ViewportTransform;
  /**
   * React Flow's LIVE node position, never `GraphNode.position` (§V112): a drag is not
   * committed to the document until release, so the document's position is stale for
   * the entire gesture — exactly the window a preview must keep up in.
   */
  readonly getNodePosition: (nodeId: NodeId) => { readonly x: number; readonly y: number } | undefined;
  readonly previewFps: number;
  readonly previewLongEdge: number;
}

/** Every node whose definition has a texture output — the same test T182 uses to sink it. */
function textureNodes(
  graph: GraphDocument,
  registry: NodeRegistryView,
): ReadonlyArray<{ nodeId: NodeId; portId: string }> {
  const found: Array<{ nodeId: NodeId; portId: string }> = [];
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    const definition = registry.get(node.type);
    const port = definition?.outputs.find((candidate) => candidate.type.kind === "texture2d");
    if (port !== undefined) found.push({ nodeId, portId: port.id });
  }
  return found;
}

export function useNodePreviews(inputs: NodePreviewInputs): void {
  const inputsRef = useRef(inputs);
  inputsRef.current = inputs;

  useEffect(() => {
    const canvas = inputs.canvasRef.current;
    const backend = inputs.backend;
    if (backend === null || backend === undefined || canvas === null) return;

    const host = backend.previewHost(canvas);
    const system: PreviewSystem = createPreviewSystem({ host, capacity: PREVIEW_TILE_CAPACITY });
    const clock = liveClock();
    let lastDeviceGeneration = backend.status.deviceGeneration;
    let frameHandle = 0;

    const tick = (): void => {
      frameHandle = requestAnimationFrame(tick);

      // §V23 — a device rebuild invalidates cadence state (refresh clocks, tile keys)
      // that the backend cannot know about; the backend's own rebuild is separate and
      // already happens beneath `previewHost`/`present`.
      if (backend.status.deviceGeneration !== lastDeviceGeneration) {
        lastDeviceGeneration = backend.status.deviceGeneration;
        system.reset();
      }

      const current = inputsRef.current;
      const rect = canvas.getBoundingClientRect();
      const surface = { x: 0, y: 0, width: rect.width, height: rect.height };
      const viewport = current.getViewport();
      const devicePixelRatio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;

      const candidates = textureNodes(current.graph, current.registry);
      const requests: PreviewRequest[] = [];
      const idle: Array<{ nodeId: NodeId; portId: string }> = [];
      const visibleIdle: Array<{ nodeId: NodeId; portId: string }> = [];
      // §V100/T197 — a slot that is not live still shows what the compiler resolved for
      // it, never a blank box, so this is looked up regardless of live/suspended/idle.
      const facts = new Map<NodeId, { width: number; height: number; format: string }>();
      for (const output of current.compiledOutputs) {
        facts.set(output.nodeId, { width: output.size[0], height: output.size[1], format: output.format });
      }

      for (const { nodeId, portId } of candidates) {
        const output = current.compiledOutputs.find((entry) => entry.nodeId === nodeId);
        // §V111: the offset within the node (never re-measured mid-drag). §V112: the
        // node's LIVE position, read fresh every tick — the two combine into the slot's
        // current graph-space box without a single DOM measurement this frame.
        const offset = current.bounds.get(nodeId);
        const position = current.getNodePosition(nodeId);
        if (output === undefined || offset === undefined || position === undefined) {
          // T252: a visible slot with NO materialized output cannot render yet, but it
          // must still register as a preview sink or it never will — the sink triggers
          // the recompile that materializes it, and the next tick fills the tile.
          if (offset !== undefined && position !== undefined) {
            const box = {
              x: position.x + offset.x,
              y: position.y + offset.y,
              width: offset.width,
              height: offset.height,
            };
            const screen = slotScreenRect(box, viewport);
            const onScreen =
              screen.x < surface.width && screen.y < surface.height && screen.x + screen.width > 0 && screen.y + screen.height > 0;
            if (onScreen || current.graph.nodes[nodeId]?.ui?.preview === true) {
              visibleIdle.push({ nodeId, portId });
            }
          }
          idle.push({ nodeId, portId });
          continue;
        }
        const node = current.graph.nodes[nodeId];
        // §V118 — LETTERBOX inside the node's preview area, never stretch to fill it.
        // The area is whatever the user dragged the node to (§V116); the texture's aspect
        // is whatever the graph resolved (§V21), and the two are unrelated. Since T208
        // made the area arbitrary this is no longer a corner case: a stretched preview
        // misrepresents the image on precisely the node someone enlarged to look at it.
        const fitted = fitInsideRegion(offset, output.size);
        const box = {
          x: position.x + offset.x + fitted.x,
          y: position.y + offset.y + fitted.y,
          width: fitted.width,
          height: fitted.height,
        };
        requests.push({
          ref: { nodeId, portId: output.portId },
          source: { resourceId: output.resourceId, size: output.size, format: output.format },
          rect: slotScreenRect(box, viewport),
          // §V142 — where the tile is DRAWN carries the camera; how big the tile is
          // ALLOCATED must not. This is the fitted region measured inside the node's own
          // box, so it is the node's preview area at any zoom (§V117) — and, because it
          // is the LETTERBOXED region, the tile carries the pixels actually shown rather
          // than paying for bars nobody renders.
          area: { width: fitted.width, height: fitted.height },
          visible: true,
          pinned: node?.ui?.preview === true,
          collapsed: false,
          occluded: false,
          // §V255/§V70a — the lens lives HERE, on the preview path, and nowhere near the
          // present blit, which stays a raw copy.
          view: current.views?.viewFor(nodeId) ?? DEFAULT_PREVIEW_VIEW,
          fps: current.previewFps,
        });
      }

      const result = system.update({
        requests,
        frame: clock.next(),
        surface,
        devicePixelRatio,
        previewFps: current.previewFps,
        previewLongEdge: current.previewLongEdge,
      });

      // T252: the compiler's preview-sink set = what the scheduler KEEPS, plus the
      // visible slots waiting on materialization (capped so the sink set cannot outrun
      // the tile budget the scheduler enforces).
      current.previewSinks?.set([
        ...result.schedule.active.map((entry) => ({ nodeId: entry.ref.nodeId as string, portId: entry.ref.portId })),
        ...visibleIdle.slice(0, Math.max(0, system.capacity - result.schedule.active.length)),
      ]);

      for (const entry of result.schedule.active) {
        const found = facts.get(entry.ref.nodeId);
        current.nodeRuntime.publish(entry.ref.nodeId, {
          preview: {
            output: entry.ref,
            state: { kind: "live" },
            ...(found === undefined ? {} : { facts: found }),
          },
        });
      }
      for (const entry of result.schedule.suspended) {
        const found = facts.get(entry.ref.nodeId);
        current.nodeRuntime.publish(entry.ref.nodeId, {
          preview: {
            output: entry.ref,
            state: { kind: "suspended", reason: entry.reason },
            ...(found === undefined ? {} : { facts: found }),
          },
        });
      }
      for (const { nodeId, portId } of idle) {
        const found = facts.get(nodeId);
        current.nodeRuntime.publish(nodeId, {
          preview: {
            output: { nodeId, portId },
            state: { kind: "idle" },
            ...(found === undefined ? {} : { facts: found }),
          },
        });
      }
    };

    frameHandle = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(frameHandle);
      system.reset();
      host.dispose();
    };
    // Re-mounted only when the backend instance changes; the `<canvas>` this reads is
    // unconditionally rendered by the caller, so its ref is already attached by the time
    // this effect runs even on the very first mount. Everything else this tick reads is
    // picked up live through `inputsRef` above rather than through the dependency array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputs.backend]);
}
