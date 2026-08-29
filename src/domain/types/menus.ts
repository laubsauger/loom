import type { EdgeId, NodeId, PortId } from "./ids.ts";
import type { CommandName } from "./commands.ts";

/**
 * Right-click menus, described as DATA (§V78).
 *
 * A menu item names a bus command; it never carries a handler. That is what keeps the
 * menu, the keymap and the command palette three views of one command set instead of
 * three drifting implementations — and it is why an agent can invoke everything a
 * right-click offers (§V29, §V52, §V55).
 *
 * Shortcut text is looked up from the keymap at render time rather than written into the
 * label, so a rebound key updates the menu instead of leaving it lying.
 */

/** A right-click means different things over a node, a port, an edge, or empty canvas. */
export interface MenuTarget {
  surface: "canvas" | "node" | "port" | "edge" | "parameter";
  nodeId?: NodeId;
  portId?: PortId;
  edgeId?: EdgeId;
  parameterKey?: string;
  /** Graph-space position of the click, so "add node here" lands under the cursor. */
  position?: { x: number; y: number };
}

export interface MenuItem {
  /**
   * The bus command this item runs. No inline handlers.
   * Omitted only for a submenu parent, which has no action of its own.
   */
  command?: CommandName;
  /** Static arguments; anything target-derived is filled in when the menu opens. */
  input?: unknown;
  label: string;
  /** Named guard, evaluated against the target — e.g. "hasSelection", "isBypassed". */
  when?: string;
  danger?: boolean;
  submenu?: ReadonlyArray<MenuItem>;
}

export interface MenuSeparator {
  separator: true;
}

export type MenuEntry = MenuItem | MenuSeparator;

/** The menu offered for one surface. Resolved on open, never precomputed per node. */
export interface MenuSchema {
  surface: MenuTarget["surface"];
  entries: ReadonlyArray<MenuEntry>;
}

export function isMenuSeparator(entry: MenuEntry): entry is MenuSeparator {
  return "separator" in entry;
}
