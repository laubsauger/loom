import type { LoomBus } from "@domain/commands/bus.ts";
import type { InvocationContext } from "@domain/types/commands.ts";
import type { GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { isParameterSlot, staticBindingValue } from "@domain/parameters/slots.ts";
import { LAYER_NODE_TYPE, controlNameOf } from "@nodes/definitions/controls.ts";

/**
 * A LAYER'S SWITCH AND FADER, as every desk surface writes and reads them — the board's
 * layer item (`board-members.tsx`, T1501b) and the Controls pane's Layers tab (T1506b).
 * One place, so the two cannot disagree about what a press writes or what a driven
 * opacity looks like.
 */

/**
 * On means not bypassed (`layer.ts`). Writes the STATE the press asked for
 * (`setNodeUi { bypassed }`), never a flip, and nothing at all when the layer is already
 * so. Read from the document at the press, not from what was drawn, so a second press
 * that lands before the first has repainted cannot flip the layer back.
 */
export function setLayerOn(bus: LoomBus, invocation: InvocationContext, nodeId: NodeId, next: boolean): void {
  const node = bus.store.getGraph().nodes[nodeId];
  if (node === undefined || (node.ui?.bypassed !== true) === next) return;
  void bus.execute(
    "graph.applyPatch",
    {
      baseRevision: bus.store.getRevision(),
      // T1771b: any node's board switch writes through here; only a Layer is called one.
      label: `${node.type === LAYER_NODE_TYPE ? "Layer" : "Switch"} ${next ? "on" : "off"} (${controlNameOf(node)})`,
      operations: [{ op: "setNodeUi", nodeId, ui: { bypassed: !next } }],
    },
    invocation,
  );
}

/** A number off a parameter definition, or the fallback. */
const declared = (definition: unknown, key: "default" | "min" | "max", fallback: number): number => {
  const value = (definition as Record<string, unknown> | undefined)?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
};

/**
 * The opacity fader's parameters, as a Slider widget reads them. Through the schema funnel
 * (§T903): the range and default are the layer's own. A static-mode slot is a plain number
 * in an envelope; any other slot is DRIVEN, and is handed over as the slot so the slider
 * shows it and refuses the drag exactly as a driven Slider node does.
 */
export function layerOpacityFader(bus: LoomBus, node: GraphNode): { caption: string; value: unknown; min: number; max: number; step: number } {
  const definition = effectiveParameterSchema(bus.registry.get(node.type), node.parameters)["opacity"];
  const stored = node.parameters["opacity"];
  const value = stored === undefined ? declared(definition, "default", 1) : isParameterSlot(stored) && stored.mode === "static" ? staticBindingValue(stored) : stored;
  return { caption: "Opacity", value, min: declared(definition, "min", 0), max: declared(definition, "max", 1), step: 0 };
}
