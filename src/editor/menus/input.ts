import type { MenuItem, MenuTarget } from "@domain/types/menus.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { MenuContext } from "./guards.ts";
import { edgesForTarget } from "./guards.ts";

/**
 * Turning a target into command input (T126).
 *
 * A `MenuItem` carries only static `input`; everything that depends on WHAT was clicked
 * is filled in here, when the menu opens. Keeping it in one table rather than in each
 * item is what lets the same schema serve a right-click on one node and a right-click
 * inside a multi-selection without the schema knowing about either.
 *
 * A builder that cannot produce a complete input refuses, with a reason — the item then
 * renders disabled. Half-formed input never reaches the bus (§V29, §V32).
 */

export type MenuInputResolution =
  | { ok: true; input: Record<string, unknown> }
  | { ok: false; reason: string };

type InputBuilder = (
  item: MenuItem,
  target: MenuTarget,
  context: MenuContext,
) => MenuInputResolution;

/** One patch, so a menu action is one undo group (§V34). */
function patch(
  context: MenuContext,
  label: string,
  operations: GraphPatchOperation[],
): MenuInputResolution {
  return { ok: true, input: { baseRevision: context.revision, label, operations } };
}

/**
 * Right-clicking a node inside a selection acts on the whole selection; right-clicking
 * outside one acts on that node alone. Any other rule surprises someone: acting on a
 * hidden selection, or silently dropping the other nine nodes the user just picked.
 */
const nodeIds: InputBuilder = (_item, target, context) => {
  const { nodeId } = target;
  if (nodeId === undefined) return { ok: false, reason: "No node under the cursor." };
  const ids = context.selection.includes(nodeId)
    ? [...new Set(context.selection)].sort()
    : [nodeId];
  return { ok: true, input: { nodeIds: ids } };
};

/**
 * The clicked node alone, as a one-element `nodeIds` — for a command that speaks the
 * keymap's selection shape but acts on exactly one node.
 */
const clickedNodeIds: InputBuilder = (_item, target) =>
  target.nodeId === undefined
    ? { ok: false, reason: "No node under the cursor." }
    : { ok: true, input: { nodeIds: [target.nodeId] } };

const nodeRef: InputBuilder = (_item, target) =>
  target.nodeId === undefined
    ? { ok: false, reason: "No node under the cursor." }
    : { ok: true, input: { nodeId: target.nodeId } };

const portRef: InputBuilder = (_item, target) =>
  target.nodeId === undefined || target.portId === undefined
    ? { ok: false, reason: "No port under the cursor." }
    : { ok: true, input: { nodeId: target.nodeId, portId: target.portId } };

const edgeRef: InputBuilder = (_item, target) =>
  target.edgeId === undefined
    ? { ok: false, reason: "No edge under the cursor." }
    : { ok: true, input: { edgeId: target.edgeId } };

const parameterRef: InputBuilder = (_item, target) =>
  target.nodeId === undefined || target.parameterKey === undefined
    ? { ok: false, reason: "No parameter under the cursor." }
    : { ok: true, input: { nodeId: target.nodeId, parameterKey: target.parameterKey } };

const cursorPosition: InputBuilder = (_item, target) =>
  target.position === undefined
    ? { ok: true, input: {} }
    : { ok: true, input: { position: { x: target.position.x, y: target.position.y } } };

/** "Add node here": the leaf item names the type, the target says where. */
const addNode: InputBuilder = (item, target, context) => {
  const type = (item.input as { type?: unknown } | undefined)?.type;
  if (typeof type !== "string") return { ok: false, reason: "This item names no node type." };
  const position = target.position ?? { x: 0, y: 0 };
  return patch(context, "Add node", [
    { op: "addNode", ref: "$added", type, position: { x: position.x, y: position.y } },
  ]);
};

const disconnect: InputBuilder = (_item, target, context) => {
  const edgeIds = edgesForTarget(target, context);
  if (edgeIds.length === 0) return { ok: false, reason: "Nothing is connected here." };
  return patch(context, target.surface === "edge" ? "Delete edge" : "Disconnect", [
    { op: "disconnect", edgeIds },
  ]);
};

/**
 * A parameter item that also carries static input — the mode submenu's four leaves,
 * which differ only by which mode they name (T246).
 */
const parameterRefWith: InputBuilder = (item, target) => {
  const base = parameterRef(item, target, undefined as never);
  if (!base.ok) return base;
  return { ok: true, input: { ...base.input, ...((item.input as Record<string, unknown>) ?? {}) } };
};

/**
 * Keyed by `surface:command` first, then by `command`. The surface key exists because
 * `graph.applyPatch` is a real, registered command that means something different on
 * each surface — which is how "delete edge" and "disconnect port" work TODAY instead of
 * waiting, greyed out, for a bespoke command to be registered.
 */
const BUILDERS: Record<string, InputBuilder> = {
  "canvas:graph.applyPatch": addNode,
  "canvas:ui.openNodeSearch": cursorPosition,
  "port:graph.applyPatch": disconnect,
  "edge:graph.applyPatch": disconnect,

  "graph.removeNodes": nodeIds,
  "graph.copySelection": nodeIds,
  "graph.cutSelection": nodeIds,
  "graph.duplicateSelection": nodeIds,
  "node.toggleBypass": nodeIds,
  "node.togglePin": nodeIds,
  "node.toggleRender": nodeIds,
  "node.toggleBackground": nodeIds,

  // Rename is single-target by nature, so it takes the node under the CURSOR rather than
  // the whole selection: "rename these nine nodes" has no one answer, and picking one of
  // them silently would be a guess the user cannot see (T415).
  "ui.beginRename": clickedNodeIds,
  "node.openColorPalette": nodeRef,
  "graph.diveIn": nodeRef,
  /*
   * T720 — the row that had never opened anything, and §B87's own note two screens down
   * describing exactly why.
   *
   * `ui.showNodeInfo` takes an OPTIONAL `nodeId`, and omitting it means "whatever the
   * surface considers current" — the selection. That is right for the `?` binding and for
   * a bare palette run, and it was fatally wrong for a menu row: with no builder the row
   * dispatched empty input, so a right-click on a node described the SELECTED node
   * instead. A right-click does not select, so the ordinary gesture resolved to no target
   * and refused (measured: popup count 0), and with another node selected it opened the
   * popup for THAT one (measured: right-clicked `checker`, got "Node info for noise1").
   *
   * An optional input is what let this hide: nothing could reject the empty dispatch,
   * because empty is a legal input for the other two routes. The builder is therefore
   * scoped to the menu rather than enforced in the command (§V516) — the selection
   * fallback stays exactly as it is for the doors that need it.
   */
  "ui.showNodeInfo": nodeRef,
  // The whole selection, like every other multi-node action: "save these nine as a
  // component" is the gesture, and taking only the clicked one would silently drop eight.
  "ui.createComponent": nodeIds,

  "graph.insertConversion": portRef,
  "graph.rerouteEdge": edgeRef,

  "parameter.copyValue": parameterRef,
  "parameter.copyReference": parameterRef,
  "parameter.paste": parameterRef,
  "parameter.reset": parameterRef,
  "parameter.setMode": parameterRefWith,
  "component.publishParameter": parameterRef,
};

/**
 * B87's gate (V423's family): a command whose input must carry a TARGET but has no
 * builder dispatches its static input — empty — and rejects with "no target" while
 * every unit suite stays green. The graph-background toggle shipped exactly that way.
 * Exported so the seam test can assert the pair: every toggle the menus guard has a
 * builder here.
 */
/**
 * T486: every COMMAND the builder table knows, surface prefixes stripped — the middle
 * link of B87's chain (TOGGLE_GUARD ⊆ builders ⊆ registered-or-planned), exported so
 * the seam gate can check the second inclusion too: a builder for a command nothing
 * registers is a menu row that resolves perfect input for a dispatch that cannot land.
 */
export function menuInputBuilderCommands(): readonly string[] {
  return [...new Set(Object.keys(BUILDERS).map((key) => key.includes(":") ? (key.split(":")[1] as string) : key))];
}

export function hasMenuInputBuilder(command: string): boolean {
  return (
    BUILDERS[command] !== undefined ||
    Object.keys(BUILDERS).some((key) => key.endsWith(`:${command}`))
  );
}

export function resolveMenuInput(
  item: MenuItem,
  target: MenuTarget,
  context: MenuContext,
): MenuInputResolution {
  // A submenu parent names no command and needs no input builder.
  if (item.command === undefined) {
    return { ok: true, input: { ...((item.input as Record<string, unknown> | undefined) ?? {}) } };
  }
  const builder = BUILDERS[`${target.surface}:${item.command}`] ?? BUILDERS[item.command];
  // No builder: the item's static input is the whole input. `graph.paste` and
  // `graph.selectAll` want nothing from the target, and saying so by omission is
  // better than a builder that returns `{}`.
  if (builder === undefined) {
    return { ok: true, input: { ...((item.input as Record<string, unknown> | undefined) ?? {}) } };
  }
  return builder(item, target, context);
}
