import type { CommandName } from "@domain/types/commands.ts";
import type { MenuItem, MenuSchema, MenuTarget } from "@domain/types/menus.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
// The command constant, NOT a literal — importing it is what keeps the menu and the
// popup naming one thing (§V78). Deliberately from `command.ts` rather than the
// `@editor/inspect` barrel: the barrel exports React surfaces, and `@editor/inspect`
// imports this module's `resolveMenuTarget`.
import { SHOW_NODE_INFO_COMMAND } from "@editor/inspect/command.ts";
import type { MenuGuardName } from "./guards.ts";

/**
 * The menus themselves (T127, §V78).
 *
 * Every entry names a bus command and carries NO handler. That is the whole point of
 * the track: the menu, the keymap and the command palette stay three views of one
 * command set, an agent can invoke everything a right-click offers (§V29, §V52, §V55),
 * and no label may contain a key like "⌘Z" — the renderer asks the keymap instead.
 *
 * Menus are kept short on purpose. A twenty-item menu is a list, not a menu; grouping
 * is done with separators and the add-node submenu.
 */

/**
 * Commands these menus name that NO track has registered yet. `CommandMap` only carries
 * commands somebody implemented, so naming a planned one needs this widening.
 *
 * We deliberately do NOT declare-merge fake entries into `CommandMap`: that would make
 * `bus.execute("view.frameAll", …)` typecheck against a command that does not exist.
 * Naming them here instead keeps the list of promises the menus make enumerable — and
 * every one of them renders DISABLED until its owner registers it, exactly as the
 * palette already does (§V55).
 */
export type PlannedCommandName =
  | "ui.openNodeSearch"
  | "graph.layoutAll"
  | "view.frameAll"
  | "node.rename"
  | "node.openColorPalette"
  | "graph.diveIn"
  | "graph.insertConversion"
  | "graph.rerouteEdge"
  | "parameter.copyPath"
  | "component.publishParameter";

export const PLANNED_COMMANDS: readonly PlannedCommandName[] = [
  "ui.openNodeSearch",
  "graph.layoutAll",
  "view.frameAll",
  "node.openColorPalette",
  "graph.diveIn",
  "graph.insertConversion",
  "graph.rerouteEdge",
  "parameter.copyPath",
  "component.publishParameter",
];

const planned = (name: PlannedCommandName): CommandName => name as CommandName;

/** Toggles show their state, so bypass/mute/preview are checkbox items. */
export const TOGGLE_GUARD: Readonly<Record<string, MenuGuardName>> = {
  "node.toggleBypass": "isBypassed",
  "node.toggleRender": "isMuted",
  "node.toggleDisplay": "showsPreview",
};

/**
 * Add-node submenu, grouped by the registry's own categories. Each leaf names
 * `graph.applyPatch` with the node type as static input; the input builder turns that
 * into a one-operation patch positioned under the cursor, so "add node here" works
 * today rather than waiting for a bespoke `graph.addNode`.
 */
export function addNodeSubmenu(registry: NodeRegistryView): MenuItem[] {
  const byCategory = new Map<string, MenuItem[]>();
  for (const definition of [...registry.list()].sort((a, b) => a.title.localeCompare(b.title))) {
    const bucket = byCategory.get(definition.category) ?? [];
    bucket.push({
      command: "graph.applyPatch",
      input: { type: definition.type },
      label: definition.title,
    });
    byCategory.set(definition.category, bucket);
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, items]) => ({
      label: category,
      submenu: items,
    }));
}

export function canvasMenu(registry: NodeRegistryView): MenuSchema {
  return {
    surface: "canvas",
    entries: [
      { label: "Add node", submenu: addNodeSubmenu(registry) },
      { command: planned("ui.openNodeSearch"), label: "Search nodes…" },
      { separator: true },
      { command: "graph.paste", label: "Paste" },
      { command: "graph.selectAll", label: "Select all" },
      { separator: true },
      { command: planned("graph.layoutAll"), label: "Layout" },
      { command: planned("view.frameAll"), label: "Frame all" },
    ],
  };
}

export const NODE_MENU: MenuSchema = {
  surface: "node",
  entries: [
    // T145: the third route to the node info popup, beside TouchDesigner's middle click
    // and the `?` binding. All three name `ui.showNodeInfo`, which is the only reason
    // they are guaranteed to open the same surface (§V78, §V85). Registered by the
    // mounted `NodeInfoHost`, not by the domain bus — like `graph.selectAll`, its owner
    // is the editor, so it is live rather than planned.
    { command: SHOW_NODE_INFO_COMMAND, label: "Info" },
    { separator: true },
    { command: "node.toggleBypass", label: "Bypass" },
    { command: "node.toggleRender", label: "Mute" },
    { command: "node.toggleDisplay", label: "Pin preview" },
    { separator: true },
    { command: planned("node.rename"), label: "Rename…" },
    { command: planned("node.openColorPalette"), label: "Set colour…" },
    { command: planned("graph.diveIn"), label: "Dive in" },
    { separator: true },
    { command: "graph.copySelection", label: "Copy" },
    { command: "graph.cutSelection", label: "Cut" },
    { command: "graph.duplicateSelection", label: "Duplicate" },
    { separator: true },
    { command: "graph.removeNodes", label: "Delete", danger: true },
  ],
};

export const PORT_MENU: MenuSchema = {
  surface: "port",
  entries: [
    { command: "graph.applyPatch", label: "Disconnect", when: "canDisconnect" },
    // §V13 — a conversion is a visible node the user can see and edit, never an
    // implicit coercion the graph performs behind their back.
    { command: planned("graph.insertConversion"), label: "Insert conversion node…" },
  ],
};

export const EDGE_MENU: MenuSchema = {
  surface: "edge",
  entries: [
    { command: "graph.applyPatch", label: "Delete", danger: true },
    { command: planned("graph.rerouteEdge"), label: "Reroute" },
  ],
};

export const PARAMETER_MENU: MenuSchema = {
  surface: "parameter",
  entries: [
    { command: "graph.applyPatch", label: "Reset to default", when: "isOverridden" },
    { command: planned("parameter.copyPath"), label: "Copy parameter path" },
    { command: planned("component.publishParameter"), label: "Publish to component" },
  ],
};

/** The one menu offered for a surface. Built on open, never precomputed per node. */
export function menuSchemaFor(
  surface: MenuTarget["surface"],
  registry: NodeRegistryView,
): MenuSchema {
  switch (surface) {
    case "canvas":
      return canvasMenu(registry);
    case "node":
      return NODE_MENU;
    case "port":
      return PORT_MENU;
    case "edge":
      return EDGE_MENU;
    case "parameter":
      return PARAMETER_MENU;
  }
}
