import type { GraphDocument, GraphNode } from "@domain/types/graph.ts";
import type { NodeId, Revision } from "@domain/types/ids.ts";
import type { MenuTarget } from "@domain/types/menus.ts";
import type { ParameterValue } from "@domain/types/parameters.ts";
import { isParameterSlot, storedStaticValue } from "@domain/parameters/slots.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * `when` guards for menu items (T126).
 *
 * Named, not expressions — same rule as the keymap's guards (§V52): a menu stays
 * serializable data, and the set of things an item can depend on stays enumerable and
 * testable. An unknown name evaluates to `false` WITH a reason, so a mis-authored
 * schema shows a disabled item that says why rather than a silently missing one.
 *
 * The toggle guards double as the checkbox state for their commands (see `toggles.ts`):
 * "is this node bypassed" is one question, and answering it in two places is how the
 * checkmark and the guard drift apart.
 */

/** Everything a guard, an input builder or a checkbox state can read. Snapshotted on open. */
export interface MenuContext {
  graph: GraphDocument;
  /** Base revision for any patch the menu builds (§V32). */
  revision: Revision;
  /** Canvas selection, so a right-click inside a multi-selection acts on all of it. */
  selection: readonly NodeId[];
  registry: NodeRegistryView;
}

export type MenuGuardName =
  | "always"
  | "canDisconnect"
  | "isBypassed"
  | "isMuted"
  | "pinsPreview"
  | "isOverridden";

export function nodeForTarget(target: MenuTarget, context: MenuContext): GraphNode | undefined {
  return target.nodeId === undefined ? undefined : context.graph.nodes[target.nodeId];
}

/** Edge ids attached to the target — a port's edges, or the target edge itself. */
export function edgesForTarget(target: MenuTarget, context: MenuContext): string[] {
  if (target.surface === "edge") {
    return target.edgeId !== undefined && context.graph.edges[target.edgeId] !== undefined
      ? [target.edgeId]
      : [];
  }
  if (target.nodeId === undefined || target.portId === undefined) return [];
  const { nodeId, portId } = target;
  return Object.keys(context.graph.edges)
    .sort()
    .filter((edgeId) => {
      const edge = context.graph.edges[edgeId];
      if (edge === undefined) return false;
      const source = edge.source.nodeId === nodeId && edge.source.portId === portId;
      const sink = edge.target.nodeId === nodeId && edge.target.portId === portId;
      return source || sink;
    });
}

function sameValue(a: ParameterValue | undefined, b: ParameterValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => {
      const other = b[index];
      if (typeof item === "number" || typeof other === "number") return item === other;
      return item?.x === other?.x && item?.y === other?.y;
    });
  }
  return false;
}

/** The definition-declared default for the targeted parameter, if it has one. */
export function parameterDefault(
  target: MenuTarget,
  context: MenuContext,
): ParameterValue | undefined {
  const node = nodeForTarget(target, context);
  if (node === undefined || target.parameterKey === undefined) return undefined;
  const definition = context.registry.get(node.type)?.parameters[target.parameterKey];
  // An asset parameter declares no default — there is no "reset" for a texture slot.
  if (definition === undefined || !("default" in definition)) return undefined;
  return definition.default;
}

function flag(
  target: MenuTarget,
  context: MenuContext,
  key: "bypassed" | "muted" | "previewPinned",
): boolean {
  return nodeForTarget(target, context)?.ui?.[key] === true;
}

const GUARDS: Record<MenuGuardName, (target: MenuTarget, context: MenuContext) => boolean> = {
  always: () => true,
  canDisconnect: (target, context) => edgesForTarget(target, context).length > 0,
  isBypassed: (target, context) => flag(target, context, "bypassed"),
  isMuted: (target, context) => flag(target, context, "muted"),
  pinsPreview: (target, context) => flag(target, context, "previewPinned"),
  isOverridden: (target, context) => {
    const node = nodeForTarget(target, context);
    if (node === undefined || target.parameterKey === undefined) return false;
    const fallback = parameterDefault(target, context);
    if (fallback === undefined) return false;
    const stored = node.parameters[target.parameterKey];
    // A mode envelope in a non-static mode (T202) is an override by definition — the
    // value is being computed, not defaulted. Otherwise compare the static view.
    if (isParameterSlot(stored) && stored.mode !== "static") return true;
    return !sameValue(storedStaticValue(stored), fallback);
  },
};

/** Why an item is disabled, said in the item's own terms rather than the guard's. */
const GUARD_REASON: Record<MenuGuardName, string> = {
  always: "Not applicable here.",
  canDisconnect: "Nothing is connected here.",
  isBypassed: "This node is not bypassed.",
  isMuted: "This node is not muted.",
  pinsPreview: "This node's preview is not pinned.",
  isOverridden: "Already at its default value.",
};

export const MENU_GUARD_NAMES: readonly MenuGuardName[] = Object.keys(GUARDS) as MenuGuardName[];

export function isMenuGuardName(name: string): name is MenuGuardName {
  return Object.prototype.hasOwnProperty.call(GUARDS, name);
}

export type GuardVerdict = { ok: true } | { ok: false; reason: string };

/** `"canDisconnect"` or the negated `"!canDisconnect"`. Unknown guard → refused, with a reason. */
export function evaluateMenuGuard(
  when: string | undefined,
  target: MenuTarget,
  context: MenuContext,
): GuardVerdict {
  if (when === undefined) return { ok: true };
  const trimmed = when.trim();
  const negated = trimmed.startsWith("!");
  const name = negated ? trimmed.slice(1).trim() : trimmed;
  if (!isMenuGuardName(name)) {
    return { ok: false, reason: `Unknown guard “${name}”.` };
  }
  const value = GUARDS[name](target, context);
  if (value !== negated) return { ok: true };
  return { ok: false, reason: negated ? "Not available here." : GUARD_REASON[name] };
}

/** The raw guard value — what a checkbox item shows as its checked state. */
export function menuGuardValue(
  name: MenuGuardName,
  target: MenuTarget,
  context: MenuContext,
): boolean {
  return GUARDS[name](target, context);
}
