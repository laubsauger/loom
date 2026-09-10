import { useCallback, useMemo } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import { MiniMap, useReactFlow } from "@xyflow/react";
import type { XYPosition } from "@xyflow/react";
import { useStore } from "zustand";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import { ANNOTATE_TYPE, annotationColorOf } from "@nodes/definitions/annotate.ts";
import { portTypeColor } from "@ui/ports.ts";
import { useGraphCanvas } from "./canvas-context.ts";
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

/**
 * Only for a host whose stylesheet did not reach it (a bare jsdom mount): the product
 * size is the CSS variable. Half of React Flow's 200×150 default, aspect 10:7.
 */
const MINIMAP_FALLBACK_SIZE = { width: 100, height: 70 } as const;

export function minimapSizeOf(host: HTMLElement): { width: number; height: number } {
  const style = getComputedStyle(host);
  const width = Number.parseFloat(style.getPropertyValue("--minimap-width"));
  const height = Number.parseFloat(style.getPropertyValue("--minimap-height"));
  return {
    width: Number.isFinite(width) && width > 0 ? width : MINIMAP_FALLBACK_SIZE.width,
    height: Number.isFinite(height) && height > 0 ? height : MINIMAP_FALLBACK_SIZE.height,
  };
}

/**
 * Colour by the node's primary output port kind — the same token the wire leaving it
 * carries (§V26), so the map reads as the graph's family map. Sinks have no output and
 * take the dim text tone. `--family-*` was rejected: those tints are at constant
 * luminance and vanish at map scale. Token variables only, never a literal (§V17).
 *
 * T1262: an annotation has no output and is not a sink — it is a region, and the map
 * shows it in the region's own hue (the `--category-*` token its colour names), so the
 * overview reads the same structure the canvas does.
 */
export function minimapNodeColor(definition: NodeDefinition | undefined, annotationHue?: string): string {
  if (annotationHue !== undefined) return `var(--category-${annotationHue})`;
  const primary = definition?.outputs[0];
  if (primary === undefined) return "var(--text-dim)";
  return portTypeColor(primary.type);
}

/**
 * T1262: the hue of every annotation, as one `id=hue;` string. React Flow's map re-colours
 * a node only when the projected node object or the `nodeColor` function changes, and a
 * colour edit changes neither (`projectNodes` keeps the prior object when geometry is
 * unchanged). So the map subscribes to the hues themselves — a primitive, so the
 * subscription re-renders on a hue change and not on every commit — and hands React Flow
 * a new function when one moves.
 */
export function annotationHueKey(nodes: Readonly<Record<string, GraphNode>>): string {
  let key = "";
  for (const node of Object.values(nodes)) {
    if (node.type !== ANNOTATE_TYPE) continue;
    key += `${node.id}=${annotationColorOf(storedStaticValue(node.parameters["color"]))};`;
  }
  return key;
}

function parseAnnotationHues(key: string): ReadonlyMap<string, string> {
  const hues = new Map<string, string>();
  for (const pair of key.split(";")) {
    if (pair === "") continue;
    const at = pair.lastIndexOf("=");
    hues.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return hues;
}

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
