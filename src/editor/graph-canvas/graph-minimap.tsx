import { useCallback, useMemo } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { MiniMap, useReactFlow } from "@xyflow/react";
import type { XYPosition } from "@xyflow/react";
import { useStore } from "zustand";
import { useGraphCanvas } from "./canvas-context.ts";
import {
  annotationHueKey,
  minimapNodeColor,
  minimapSizeOf,
  parseAnnotationHues,
} from "./minimap-model.ts";
import type { LoomEdge, LoomNode } from "./derive.ts";

/**
 * The network overview map (T1257) — React Flow's `<MiniMap>`, TD-styled and moved out
 * of React Flow's own stacking context.
 *
 * ## Why it is portalled
 *
 * `<MiniMap>` must be a CHILD of `<ReactFlow>`: it reads the flow store from context,
 * and the canvas is mounted without an outer `ReactFlowProvider` in its own tests. But
 * the `.react-flow` wrapper is `position: relative; z-index: 0` — a stacking context —
 * and the graph pane paints its preview tiles on a sibling canvas at `--z-canvas-overlay`
 * above it. A map rendered in place would sit UNDER the preview tile of whichever node
 * happens to be in the corner. So the component stays in React Flow's tree for context
 * and portals its DOM to `host`, a sibling of `<ReactFlow>` at `--z-canvas-chrome`, the
 * layer graph-canvas already reserves for chrome that must be legible over tiles.
 *
 * ## Why the size is a CSS variable read back at mount
 *
 * The owner's first look: "minimap is too large. can easily be half the size" — so the
 * size is tunable in CSS (`--minimap-width`/`--minimap-height` on the host,
 * `graph-canvas.module.css`) rather than a literal here. React Flow, though, needs the
 * size as NUMBERS: its `viewBox` and its drag scale are computed from `style.width`, and
 * an SVG sized by CSS to anything else would draw at one scale and pan at another. So the
 * variables are read off the mounted host and handed to the map as its style — one
 * source, in CSS, and the arithmetic still sees the same number the screen does.
 *
 * ## Why `offsetScale` is 0
 *
 * React Flow's default padding of 5 map-pixels is added to the SVG's `viewBox` but not
 * to its `width`/`height`, so the viewBox's aspect ratio no longer matches the element's
 * and `preserveAspectRatio` scales the drawing down by a few percent — while its drag
 * handler still moves the viewport by `Δ × viewScale`. The mask then drifts under the
 * pointer during a drag. With 0 the two agree and a drag of Δ map-pixels moves the
 * viewport by EXACTLY Δ × (viewBox width / map width) graph units; the visual inset
 * comes from CSS padding on the panel instead, which the pointer math never sees.
 */
export const MINIMAP_OFFSET_SCALE = 0;

export interface GraphMinimapProps {
  /** Where the map's DOM lands; `null` until the host div has mounted. */
  host: HTMLElement | null;
}

export function GraphMinimap({ host }: GraphMinimapProps) {
  const { store, registry } = useGraphCanvas();
  const flow = useReactFlow<LoomNode, LoomEdge>();
  const hueKey = useStore(store, (state) => annotationHueKey(state.graph.nodes));
  const hueOf = useMemo(() => parseAnnotationHues(hueKey), [hueKey]);

  const nodeColor = useCallback(
    (node: LoomNode) => {
      const domainNode = store.getState().graph.nodes[node.data.nodeId];
      return minimapNodeColor(
        domainNode === undefined ? undefined : registry.get(domainNode.type),
        hueOf.get(node.data.nodeId),
      );
    },
    [store, registry, hueOf],
  );

  // TD: a click in the overview puts that point in the middle of the network editor.
  // Zoom is kept; a jump that also rescaled would be two gestures in one.
  const jumpTo = useCallback(
    (_event: ReactMouseEvent, position: XYPosition) => {
      void flow.setCenter(position.x, position.y, { zoom: flow.getZoom(), duration: 0 });
    },
    [flow],
  );

  const size = useMemo(() => (host === null ? null : minimapSizeOf(host)), [host]);

  if (host === null || size === null) return null;
  return createPortal(
    <MiniMap<LoomNode>
      pannable
      zoomable
      position="bottom-right"
      style={size}
      offsetScale={MINIMAP_OFFSET_SCALE}
      nodeColor={nodeColor}
      nodeBorderRadius={0}
      // Half a CSS pixel: one device pixel on the displays this is drawn on, and the
      // thinnest line that still reads as the viewport's edge at half the map's size.
      maskStrokeWidth={0.5}
      onClick={jumpTo}
      ariaLabel="Network overview"
    />,
    host,
  );
}
