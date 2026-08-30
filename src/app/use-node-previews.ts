import { useEffect, useRef } from "react";
import type { RefObject } from "react";
import { liveClock } from "@domain/transport/live-clock.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { SINK_TARGET_PORT } from "@compiler/index.ts";
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

/**
 * Every node that HAS a texture to show, and which port it lives on.
 *
 * A texture OUTPUT is the common case — the same test T182 uses to sink it. A declared
 * sink is the other one: an Output node publishes no port at all, yet it owns the render
 * target the whole graph exists to fill, materialized by the compiler under the reserved
 * `SINK_TARGET_PORT`. Excluding it left the one node whose content the user most wants to
 * see — the final picture — as the only empty body in the graph.
 *
 * `gated` says whether this node needs a preview SINK to exist at all (T252/§V158). A
 * preview-only node does: nothing else keeps it, so the scheduler's kept set is what
 * makes the compiler materialize it. A declared sink never does — §V25 keeps it
 * unconditionally — and asking for it as a preview sink would make `resolveSinks` warn
 * about a port the definition does not declare, which is true and useless.
 *
 * A sink with NOTHING CONNECTED is excluded, and that is not cosmetic. It presents no
 * image, so its compile emits no pass; the target then exists in the plan and in no
 * built program, and a tile asking for it makes the preview host report an unresolvable
 * binding on every retry — a warning per second, forever, about a node whose real
 * problem (`compiler/input-missing`) is already on screen.
 *
 * `on` is the user's switch (T353, §V297), default ON. It is reported rather than
 * filtered out because a switched-off node still has something to SAY in its body — it is
 * off, not broken — while contributing no request, no tile and no sink, which is what
 * makes OFF cost nothing. The two exclusions cannot fight: an unconnected sink drops out
 * here whatever its switch says, and an off node never reaches the request path.
 */
export interface PreviewCandidate {
  readonly nodeId: NodeId;
  readonly portId: string;
  readonly gated: boolean;
  readonly on: boolean;
}

/** Exported for the T373 coverage gate — the product path itself only calls it below. */
export function previewCandidates(
  graph: GraphDocument,
  registry: NodeRegistryView,
): ReadonlyArray<PreviewCandidate> {
  const found: PreviewCandidate[] = [];
  const fed = new Set<NodeId>();
  for (const edge of Object.values(graph.edges)) fed.add(edge.target.nodeId);
  for (const [nodeId, node] of Object.entries(graph.nodes)) {
    const definition = registry.get(node.type);
    if (definition === undefined) continue;
    // Absent means ON: an untouched node previews, so an untouched document and one
    // where somebody pressed P twice are the same document.
    const on = node.ui?.preview !== false;
    // T373 (§V85): a pointset output previews as its own splat — the compiler
    // synthesizes the target when this candidate becomes a preview sink, so the same
    // materialization dance texture nodes use (T252) covers point generators too.
    // Keyed on the port KIND, so every present and future point producer is a
    // candidate by construction (§V316, §V319).
    const port = definition.outputs.find(
      (candidate) => candidate.type.kind === "texture2d" || candidate.type.kind === "pointset",
    );
    if (port !== undefined) found.push({ nodeId, portId: port.id, gated: true, on });
    else if (definition.sink === true && fed.has(nodeId)) {
      found.push({ nodeId, portId: SINK_TARGET_PORT, gated: false, on });
    }
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

      const candidates = previewCandidates(current.graph, current.registry);
      // Nodes the compiler already keeps on its own, so they must not be asked for as
      // preview sinks (see `previewCandidates`).
      const ungated = new Set<string>(
        candidates.filter((candidate) => !candidate.gated).map((candidate) => candidate.nodeId),
      );
      const requests: PreviewRequest[] = [];
      const idle: Array<{ nodeId: NodeId; portId: string }> = [];
      const visibleIdle: Array<{ nodeId: NodeId; portId: string }> = [];
      /** Switched off (§V297): reported to the body, and nowhere else. */
      const off: Array<{ nodeId: NodeId; portId: string }> = [];
      // §V100/T197 — a slot that is not live still shows what the compiler resolved for
      // it, never a blank box, so this is looked up regardless of live/suspended/idle.
      const facts = new Map<NodeId, { width: number; height: number; format: string }>();
      for (const output of current.compiledOutputs) {
        facts.set(output.nodeId, { width: output.size[0], height: output.size[1], format: output.format });
      }

      for (const { nodeId, portId, on } of candidates) {
        // §V297 — OFF is not "hidden". No request means no tile, nothing scheduled and no
        // preview sink, so the compiler prunes the node and it costs nothing at all.
        if (!on) {
          off.push({ nodeId, portId });
          continue;
        }
        // A pointset MARKER is not bindable — it is the row a watched point output has
        // BEFORE the compiler synthesizes its preview target (T373). Skipping it routes
        // the node through the idle path below, which registers the sink that makes the
        // recompile materialize the real target — the same dance as an unmaterialized
        // texture (T252).
        const output = current.compiledOutputs.find(
          (entry) => entry.nodeId === nodeId && entry.resourceKind !== "pointset",
        );
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
            if (
              !ungated.has(nodeId) &&
              (onScreen || current.graph.nodes[nodeId]?.ui?.previewPinned === true)
            ) {
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
          // T375 (§V57): `space` travels with the texture. `output` is the compiler's
          // ResolvedOutput, which already carries it — the preview shader is told what it
          // is looking at rather than assuming linear (B47).
          source: {
            resourceId: output.resourceId,
            size: output.size,
            format: output.format,
            space: output.space,
          },
          rect: slotScreenRect(box, viewport),
          // §V142 — where the tile is DRAWN carries the camera; how big the tile is
          // ALLOCATED must not. This is the fitted region measured inside the node's own
          // box, so it is the node's preview area at any zoom (§V117) — and, because it
          // is the LETTERBOXED region, the tile carries the pixels actually shown rather
          // than paying for bars nobody renders.
          area: { width: fitted.width, height: fitted.height },
          visible: true,
          // The PIN (§V28b, T353) — keep the tile alive while the node is scrolled off
          // screen. Not the switch; the switch decided we are here at all.
          pinned: node?.ui?.previewPinned === true,
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
      const activeSinks = result.schedule.active
        .filter((entry) => !ungated.has(entry.ref.nodeId as string))
        .map((entry) => ({ nodeId: entry.ref.nodeId as string, portId: entry.ref.portId }));
      current.previewSinks?.set([
        ...activeSinks,
        ...visibleIdle.slice(0, Math.max(0, system.capacity - activeSinks.length)),
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
      // §V91/§V100 — a switched-off preview names its state rather than going blank, and
      // still shows what the compiler resolved when the node renders for something else.
      // Off with no facts is the honest picture of a node that is now costing nothing.
      for (const { nodeId, portId } of off) {
        const found = facts.get(nodeId);
        current.nodeRuntime.publish(nodeId, {
          preview: {
            output: { nodeId, portId },
            state: { kind: "off" },
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
