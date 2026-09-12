import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";
import { storedStaticValue } from "@domain/parameters/slots.ts";
import { ANNOTATE_TYPE, annotationColorOf } from "@nodes/definitions/annotate.ts";
import { portTypeColor } from "@ui/ports.ts";

/**
 * What the network overview map (T1257) DERIVES — its size, its node colours, and the
 * annotation-hue key it re-colours on. Split out of `graph-minimap.tsx` by T1315b so
 * that file exports only components and Fast Refresh can swap them; `minimap-command.ts`
 * and its node-environment test reach these without pulling React Flow in behind them.
 */

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

export function parseAnnotationHues(key: string): ReadonlyMap<string, string> {
  const hues = new Map<string, string>();
  for (const pair of key.split(";")) {
    if (pair === "") continue;
    const at = pair.lastIndexOf("=");
    hues.set(pair.slice(0, at), pair.slice(at + 1));
  }
  return hues;
}
