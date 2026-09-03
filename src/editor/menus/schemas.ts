import type { CommandName, PlannedCommandName } from "@domain/types/commands.ts";
import { PLANNED_COMMANDS } from "@domain/types/commands.ts";
import type { MenuItem, MenuSchema, MenuTarget } from "@domain/types/menus.ts";
import { AUTHORABLE_PARAMETER_MODES } from "@domain/parameters/slots.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { MODE_LABELS } from "@ui/controls/parameter-slot.ts";
// The command constant, NOT a literal — importing it is what keeps the menu and the
// popup naming one thing (§V78). Deliberately from `command.ts` rather than the
// `@editor/inspect` barrel: the barrel exports React surfaces, and `@editor/inspect`
// imports this module's `resolveMenuTarget`.
import { SHOW_NODE_INFO_COMMAND } from "@editor/inspect/command.ts";
// Same reason, same shape: the constant rather than a literal, and from the module
// itself rather than the `@editor/nodes` barrel, which exports React surfaces.
import { BEGIN_RENAME_COMMAND } from "@editor/nodes/rename-session.ts";
// Same reason again (B68, §V356): the constant, from the module rather than the
// `@editor/edges` barrel.
import { TOGGLE_REFERENCE_LINES_COMMAND } from "@editor/edges/reference-lines-command.ts";
// Same reason again (T1010): the constant, from the module rather than the
// `@editor/nodes` barrel, which exports React surfaces.
import { TOGGLE_TIMING_OVERLAY_COMMAND } from "@editor/nodes/timing-overlay-command.ts";
import { TOGGLE_EDGE_FLOW_COMMAND } from "@editor/edges/edge-flow-command.ts";
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
 * The list itself lives in `@domain/types/commands.ts` since T365, because the default
 * keymap names planned commands too — five of them the same ones these menus name — and
 * two lists would mean two deletions to remember when one gets built. Re-exported here so
 * the menus barrel keeps offering it.
 */
export type { PlannedCommandName };
export { PLANNED_COMMANDS };

const planned = (name: PlannedCommandName): CommandName => name as CommandName;

/** Toggles show their state, so bypass/mute/preview are checkbox items. */
export const TOGGLE_GUARD: Readonly<Record<string, MenuGuardName>> = {
  "node.toggleBypass": "isBypassed",
  "node.toggleRender": "isMuted",
  "node.togglePin": "pinsPreview",
  "node.toggleBackground": "showsBackground",
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
      // T709: live since the graph canvas registers it. The row, the `tab` binding and
      // the background double-click are the same command, so all three open one browser
      // at one position (§V78, §V307).
      { command: "ui.openNodeSearch", label: "Search nodes…" },
      { separator: true },
      { command: "graph.paste", label: "Paste" },
      { command: "graph.selectAll", label: "Select all" },
      { separator: true },
      // B84/T440/§V354: live since `createDomainBus` registers it. The menu row, `l` and
      // the agent's `layout_graph` are the same command, so a click, a keypress and a tool
      // call cannot mean different things (§V78, §V191).
      { command: "graph.layoutAll", label: "Layout" },
      // T430/§V354: live since the canvas registers it — the menu row and `F` are the
      // same command, so a click and a keypress cannot mean different things (§V78).
      { command: "view.frameAll", label: "Frame all" },
      // B68/§V153: the toggle the invariant calls a real control, which until now had no
      // door at all — `registerReferenceLinesCommand` is called for its STORE, so the
      // seam gate saw a reached registrar while the command it registers was named by no
      // binding, no menu row and no button. A plain row, like `node.toggleBypass`: the
      // command flips when `show` is omitted, which is what a menu item means.
      { command: TOGGLE_REFERENCE_LINES_COMMAND, label: "Reference lines" },
      { separator: true },
      /**
       * T1010 — the DEBUG submenu, and the owner asked for it by that name: *"it's not
       * supposed to be there all the time. I want to turn it off and on — right-click,
       * debug submenu."*
       *
       * A submenu rather than a flat row for the reason the Component rows are nested: a
       * canvas menu that lists every instrument alongside "Paste" is a list, not a menu,
       * and everything under here is something you reach for while diagnosing and put down
       * afterwards. It loses no door by being nested (§V78) — the command is on the bus,
       * so the palette and any later keybinding reach the same one.
       */
      {
        label: "Debug",
        submenu: [
          { command: TOGGLE_TIMING_OVERLAY_COMMAND, label: "Node timings" },
          // T1013: the flow dashes, the timing overlay's twin — same question ("where is
          // the frame going"), same submenu, same default. The owner asked for them
          // together: "same as the timings".
          { command: TOGGLE_EDGE_FLOW_COMMAND, label: "Edge flow" },
        ],
      },
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
    // T353/§V297: the PIN lives here and the switch does not, which is the displacement
    // the item cap asks for rather than a twelfth entry. The switch has the `P` button on
    // every node and the `d` key; the pin had neither, and one of them had to be the one
    // you can reach without knowing it exists.
    { command: "node.togglePin", label: "Pin preview" },
    // T463: TD's network background — this node's output behind the patch, dimmed.
    // It DISPLACED "Set colour…" per the item cap's own rule (a planned row, still
    // reachable through its keymap binding and the palette when it lands).
    { command: "node.toggleBackground", label: "Graph background" },
    { separator: true },
    // The ellipsis is a promise, and until T415 it was a lie: this named `node.rename`,
    // which needs a `label` no menu route could ever supply, so the item dispatched a
    // rename with no name (B60, §V342). It names the command that OPENS the inline editor
    // on the node's title; that editor is what runs `node.rename`.
    { command: BEGIN_RENAME_COMMAND, label: "Rename…" },
    /**
     * T423 — the component gestures, as a SUBMENU rather than as two more rows.
     *
     * "Dive in" was `planned("graph.diveIn")` from T127 until the component editor landed;
     * it is a real command now, and "Save as component…" is the gesture that makes the
     * whole feature discoverable, so both want a place here. The node menu is AT its
     * eleven-item cap, and the cap's own instruction is to displace a row or open a
     * submenu rather than raise it a second time. Nothing here was stale enough to
     * displace, and the two belong together, so: one row, two verbs.
     *
     * Neither loses a door by being nested (§V78): "Dive in" keeps `i`/`Enter` and the
     * palette, and "Save as component…" has its own binding and the palette.
     */
    {
      label: "Component",
      submenu: [
        { command: "graph.diveIn", label: "Dive in", when: "isComponentInstance" },
        { command: "ui.createComponent", label: "Save as component…" },
      ],
    },
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

/**
 * The parameter menu (T246). TouchDesigner's right-click on a parameter, as data.
 *
 * Every entry names a REGISTERED command (§V78) — the same ones the mode panel and an
 * agent use — so this is a view of the command set rather than a second implementation
 * of copy, paste, reset and mode switching. That is the whole reason `parameter.copyPath`
 * left `PLANNED_COMMANDS`: it was a promise, and `parameter.copyReference` is the thing.
 */
export const PARAMETER_MENU: MenuSchema = {
  surface: "parameter",
  entries: [
    // Conditional paste: ONE copy that captures the value snapshot, the reference and the active
    // binding, so PASTE is where the choice is made. All three copy rows capture all
    // three members; they differ only in which string leaves for the system clipboard,
    // which is the one choice a single-string clipboard genuinely forces.
    { command: "parameter.copy", label: "Copy parameter" },
    { command: "parameter.copyValue", label: "Copy value" },
    // §V148: a string that pastes back into an expression and resolves to this parameter.
    { command: "parameter.copyReference", label: "Copy reference" },
    { separator: true },
    /*
     * Three named pastes rather than one "Paste" that guesses — the owner's ask.
     *
     * Deciding at copy time asks the user to predict what they will want when they get
     * to the other node, and they cannot. Flat rather than a submenu because the whole
     * complaint was that the choice was invisible; burying it one level down answers a
     * different complaint.
     *
     * No `when` guard, for the same reason the Mode rows have none: a row that cannot
     * complete is still offered and refuses BY NAME (§V288). "The copied parameter is a
     * constant; it carries no binding" teaches; a row that quietly vanished does not.
     * The honest guard would have to ask the BUS what is on its clipboard, and
     * `MenuContext` is a document snapshot with no bus in it.
     */
    { command: "parameter.paste", input: { as: "value" }, label: "Paste value" },
    { command: "parameter.paste", input: { as: "reference" }, label: "Paste reference" },
    { command: "parameter.paste", input: { as: "binding" }, label: "Paste binding" },
    { separator: true },
    { command: "parameter.reset", label: "Reset to default", when: "isOverridden" },
    { separator: true },
    {
      // §V107: every parameter takes every mode, so the switch belongs on every
      // parameter's menu — not only on the ones whose panel someone thought to open.
      // DERIVED from the mode union, never hand-listed (B45, §V316): the first version
      // enumerated four members of a five-mode category and `map` was silently absent.
      // AUTHORABLE, not every parsable mode: §T897 retired `driven` (a channel read is
      // an expression term, `op('name').chan.low`) but it stays in `ParameterMode` forever
      // so the load-time upgrade can parse documents that hold it. Its own docblock already
      // says authoring surfaces offer only the authorable set — the mode BUTTONS obeyed
      // that and this menu did not, which is how a retired mode kept its own menu item.
      // A mode that cannot complete from a menu (map, bind need a payload) is
      // still offered and refuses BY NAME through `parameter.setMode` — a missing item
      // teaches nothing, a named refusal says what the mode needs (§V288).
      label: "Mode",
      submenu: AUTHORABLE_PARAMETER_MODES.map((mode) => ({
        command: "parameter.setMode" as const,
        input: { mode },
        label: MODE_LABELS[mode],
      })),
    },
    { separator: true },
    // A REAL command since T132 — registered by `registerComponentCommands`, which
    // `app-runtime.ts` calls. It sat in `PLANNED_COMMANDS` until T365 because the menus'
    // own test asks a bare DOMAIN harness whether a command is live, and component
    // commands are not on that bus; the T365 gate asks `CommandMap` and found it.
    { command: "component.publishParameter", label: "Publish to component" },
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
