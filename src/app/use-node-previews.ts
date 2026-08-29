import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { liveClock } from "@domain/transport/live-clock.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { ResolvedOutput } from "@compiler/index.ts";
import type { NodeRuntimeStore } from "@editor/graph-canvas/index.ts";
import type { PreviewSlotBoundsStore } from "@editor/viewer/index.ts";
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
  readonly backend: ShaderloomBackend | null | undefined;
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly bounds: PreviewSlotBoundsStore;
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
          idle.push({ nodeId, portId });
          continue;
        }
        const node = current.graph.nodes[nodeId];
        const box = {
          x: position.x + offset.x,
          y: position.y + offset.y,
          width: offset.width,
          height: offset.height,
        };
        requests.push({
          ref: { nodeId, portId: output.portId },
          source: { resourceId: output.resourceId, size: output.size, format: output.format },
          rect: slotScreenRect(box, viewport),
          visible: true,
          pinned: node?.ui?.preview === true,
          collapsed: false,
          occluded: false,
          view: DEFAULT_PREVIEW_VIEW,
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
