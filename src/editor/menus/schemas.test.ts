import { describe, expect, it } from "vitest";
import { createHarness } from "@domain/commands/test-support.ts";
import { PARAMETER_MODES } from "@domain/parameters/slots.ts";
import type { ParameterMode } from "@domain/types/parameters.ts";
import { MODE_LABELS } from "@ui/controls/parameter-slot.ts";
import type { MenuEntry, MenuItem, MenuSchema } from "@domain/types/menus.ts";
import { hasMenuInputBuilder, menuInputBuilderCommands } from "./input.ts";
import { isMenuSeparator } from "@domain/types/menus.ts";
import { isMenuGuardName } from "./guards.ts";
import { PLANNED_COMMANDS, TOGGLE_GUARD, addNodeSubmenu, menuSchemaFor } from "./schemas.ts";

/**
 * The menus themselves (T127, §V78).
 *
 * These are the anti-drift tests for the SCHEMA half of the track: a menu is data that
 * names bus commands, so what can rot is a label that hardcodes a key, a guard name
 * nobody implements, or a promise about a command that quietly changed hands.
 */

const { bus } = createHarness();
const registry = bus.registry;
const SURFACES = ["canvas", "node", "port", "edge", "parameter"] as const;

const schemas: MenuSchema[] = SURFACES.map((surface) => menuSchemaFor(surface, registry));

function items(entries: readonly MenuEntry[]): MenuItem[] {
  return entries.flatMap((entry): MenuItem[] => {
    if (isMenuSeparator(entry)) return [];
    return [entry, ...items(entry.submenu ?? [])];
  });
}

const everyItem = schemas.flatMap((schema) => items(schema.entries));

describe("every item names a command (§V78)", () => {
  it("names a non-empty command on every actionable item, at every depth", () => {
    expect(everyItem.length).toBeGreaterThan(10);
    // A submenu parent is allowed to name none — it has no action of its own.
    const actionable = everyItem.filter((item) => item.submenu === undefined);
    const commands = actionable.map((item) => item.command);
    expect(commands.filter((command) => typeof command !== "string" || command.length === 0)).toEqual([]);
  });

  it("never writes a key into a label — the keymap owns that text (§V55)", () => {
    // "⌘Z" in a label is a lie the moment someone rebinds the key.
    const keyish = /[⌘⇧⌥⌃]|\b(ctrl|cmd|alt|shift|meta)\b/i;
    expect(everyItem.filter((item) => keyish.test(item.label))).toEqual([]);
  });

  it("uses only guard names this module implements", () => {
    const guards = everyItem.flatMap((item) => (item.when === undefined ? [] : [item.when]));
    expect(guards.length).toBeGreaterThan(0);
    expect(guards.filter((when) => !isMenuGuardName(when.replace(/^!/, "")))).toEqual([]);
  });

  it("marks only destructive items as dangerous", () => {
    const dangerous = everyItem.filter((item) => item.danger === true).map((item) => item.label);
    expect(dangerous).toEqual(["Delete", "Delete"]);
  });
});

/**
 * Registered by the app when it wires the editor (`src/app/selection-commands.ts`),
 * not by the domain bus — selection is view state, so its owner registers it there.
 */
const APP_REGISTERED = [
  "graph.selectAll",
  // T145: registered by the mounted `NodeInfoHost` (`src/editor/inspect/command.ts`).
  // Popup visibility is not document state and produces no patch, so there is nothing
  // for `ctx.apply` to write and no reason for the domain bus to own it — but it IS
  // registered, so it is live rather than planned.
  "ui.showNodeInfo",
  // T132, found by T365's gate: `registerComponentCommands` puts this on the app's bus
  // (`app-runtime.ts`), but not on the bare domain harness this file constructs. It spent
  // that whole time in `PLANNED_COMMANDS` — a built command the menus called a promise —
  // because "is it live" asked here can only mean "is it on THIS bus".
  "component.publishParameter",
  // T415: registered by the mounted graph canvas (`src/editor/nodes/rename-session.ts`),
  // for the same reason as `ui.showNodeInfo` — WHICH node title is an input box is not
  // document state, so the domain bus does not own it. Live, not planned: the menu row
  // that names it opens a real editor.
  "ui.beginRename",
  // T709: registered by the mounted graph canvas (`src/editor/library/node-search-command.ts`),
  // for the same reason as `ui.beginRename` — whether a browser is OPEN, and at which
  // point, is view state and produces no patch, so the domain bus does not own it. The
  // node it creates is a separate `graph.applyPatch`, and that is the one that undoes.
  // Live, not planned: "Search nodes…", `tab` and the background double-click all open it.
  "ui.openNodeSearch",
  // T423: registered by the mounted canvas chrome — `graph.diveIn`/`graph.jumpUp` by
  // `registerComponentNavigationCommands` (`src/app/component-navigation.ts`) and
  // `ui.createComponent` by `ComponentBar` (`src/app/component-bar.tsx`). WHICH component
  // you are inside is view state like the viewport, so the domain bus does not own it
  // (§V16). Live, not planned: "Dive in" opens a real surface now, which is why it left
  // `PLANNED_COMMANDS`.
  "graph.diveIn",
  "graph.jumpUp",
  "ui.createComponent",
  // B68/T441: registered by the mounted graph canvas too — `registerReferenceLinesCommand`
  // returns the store the canvas subscribes to, and the command comes with it. Whether a
  // line is DRAWN is a property of a look at the graph, not of the graph, so the domain
  // bus does not own it. Live, not planned: this row is the FIRST door the command has
  // ever had (§V153, §V356).
  "ui.toggleReferenceLines",
  // T430/§V354: registered by the mounted graph pane (`src/app/view-commands.ts`) — only
  // the canvas can move its own camera, and framing is view state that writes no patch.
  // Live, not planned: `F` and this row both fit the graph in the window.
  "view.frameAll",
];

describe("what the menus promise but nobody has built", () => {
  it("declares every menu command no track implements, so none is a silent dead item", () => {
    // The anti-drift check for the disabled half of the menus: a menu item naming a
    // command nobody registered and nobody PLANNED fails here.
    //
    // This is a subset check, not equality, since T365: `PLANNED_COMMANDS` is shared with
    // the default keymap, which names ten planned commands these menus do not. The
    // equality — nothing in the list that no menu and no binding names — moved to
    // `composition-seams.test.ts`, the one place that can see both tables at once.
    const named = new Set(
      everyItem.map((item) => item.command).filter((command): command is NonNullable<typeof command> => command !== undefined),
    );
    const missing = [...named]
      .filter((command) => !bus.hasCommand(command) && !APP_REGISTERED.includes(command))
      .sort();
    const declaredPlanned = new Set<string>(PLANNED_COMMANDS);
    expect(missing.filter((command) => !declaredPlanned.has(command))).toEqual([]);
    // Non-vacuity: the menus really do name unimplemented commands, so an empty `missing`
    // would mean the walk broke rather than that the menus got finished.
    // T463 displaced the planned "Set colour…" row (still keymap-reachable) and B84 built
    // the canvas menu's "Layout", so the menus promised four unbuilt commands rather than
    // six; T423 built "Dive in" and it is three; T709 built "Search nodes…" and it is two.
    // The floor tracks that number down as rows get built — it is a non-vacuity guard, not
    // a quota, and the day it reaches zero this assertion should be DELETED along with the
    // disabled-item machinery, not weakened to `>= 0`.
    expect(missing.length).toBeGreaterThan(1);
  });

  it("every command it treats as live is really on a bus", () => {
    const planned = new Set<string>([...PLANNED_COMMANDS, ...APP_REGISTERED]);
    const live = [...new Set(everyItem.map((item) => item.command))]
      .filter((command): command is NonNullable<typeof command> => command !== undefined)
      .filter((command) => !planned.has(command));
    expect(live.filter((command) => !bus.hasCommand(command))).toEqual([]);
  });
});

describe("shape", () => {
  it.each(SURFACES)("%s stays a menu rather than a list", (surface) => {
    const schema = menuSchemaFor(surface, registry);
    const top = schema.entries.filter((entry) => !isMenuSeparator(entry));
    // A twenty-item menu is a failure of design; nesting goes in submenus. Eleven is the
    // node menu with TouchDesigner's Info action added (T145) — raised deliberately, and
    // only once. The next item that wants in should displace one or open a submenu.
    expect(top.length).toBeLessThanOrEqual(11);
    expect(top.length).toBeGreaterThan(0);
  });

  it("answers with the schema for the surface it was asked about", () => {
    for (const surface of SURFACES) expect(menuSchemaFor(surface, registry).surface).toBe(surface);
  });

  it("gives the four node toggles a state guard, so each shows a checkmark", () => {
    const nodeItems = items(menuSchemaFor("node", registry).entries);
    const toggles = nodeItems.filter((item) => item.command !== undefined && TOGGLE_GUARD[item.command] !== undefined);
    // "Pin preview" is `node.togglePin` since T353: the preview SWITCH left the menu when
    // it stopped being a pin, because it has the `P` button and the `d` key and the item
    // cap below has no room for both.
    // T463 added "Graph background", displacing the planned "Set colour…" row per the
    // item cap's own instruction rather than raising the cap a second time.
    expect(toggles.map((item) => item.label)).toEqual(["Bypass", "Mute", "Pin preview", "Graph background"]);
  });
});

describe("the Mode submenu is the mode UNION (B45/T372, §V316)", () => {
  it("offers exactly the ParameterMode members, labelled from the one caption table", () => {
    const modeParent = items(menuSchemaFor("parameter", registry).entries).find(
      (item) => item.label === "Mode" && item.submenu !== undefined,
    );
    expect(modeParent).toBeDefined();
    const offered = (modeParent?.submenu ?? []).map((item) => (item.input as { mode: ParameterMode }).mode);
    // Structural equality with the union's runtime pin, not with a hand-written list:
    // `PARAMETER_MODES` derives from a `Record<ParameterMode, true>`, so a sixth binding
    // kind breaks THAT at compile time — and this test the moment the menu stops
    // following. The first version of this submenu enumerated four of five modes and
    // nothing noticed `map` was gone.
    expect(offered).toEqual([...PARAMETER_MODES]);
    for (const item of modeParent?.submenu ?? []) {
      expect(item.command).toBe("parameter.setMode");
      expect(item.label).toBe(MODE_LABELS[(item.input as { mode: ParameterMode }).mode]);
    }
  });
});

describe("add node here", () => {
  const submenu = addNodeSubmenu(registry);

  it("groups every registered node type under its own category", () => {
    const categories = submenu.map((entry) => entry.label);
    expect(categories).toEqual([...new Set(registry.list().map((d) => d.category))].sort());

    const leaves = submenu.flatMap((entry) => entry.submenu ?? []);
    expect(leaves.length).toBe(registry.list().length);
  });

  it("carries the node type as static input, not a handler", () => {
    const leaves = submenu.flatMap((entry) => entry.submenu ?? []);
    for (const leaf of leaves) {
      expect(leaf.command).toBe("graph.applyPatch");
      expect((leaf.input as { type: string }).type).toBeTypeOf("string");
    }
  });
});

/**
 * B87's standing gate: a registered, guarded, labelled command can still dispatch
 * NOTHING — if the input-builder table lacks it, the menu sends the item's static
 * input (empty for a toggle) and the command rejects "no target" while every suite
 * stays green. The pair below is the checkable form of the enumerate-the-right-set
 * rule: TOGGLE_GUARD's domain ⊆ the builder table ⊆ registered-or-planned commands.
 */
describe("every guarded toggle can actually dispatch (B87)", () => {
  it("each TOGGLE_GUARD command has a menu input builder", () => {
    for (const command of Object.keys(TOGGLE_GUARD)) {
      expect(hasMenuInputBuilder(command), `${command} has no input builder — it will dispatch empty input`).toBe(true);
    }
  });

  it("each TOGGLE_GUARD command is registered on the bus", () => {
    for (const command of Object.keys(TOGGLE_GUARD)) {
      expect(bus.hasCommand(command), `${command} is guarded but nothing registers it`).toBe(true);
    }
  });

  // T486 closes the chain's middle link: a BUILDER for a command nothing registers or
  // plans is a menu row that resolves perfect input for a dispatch that cannot land —
  // B87's failure one enumeration to the left.
  it("each input-builder command is registered, app-registered, or named as planned", () => {
    for (const command of menuInputBuilderCommands()) {
      expect(
        bus.hasCommand(command) ||
          APP_REGISTERED.includes(command) ||
          (PLANNED_COMMANDS as readonly string[]).includes(command),
        `${command} has an input builder but is neither registered nor planned`,
      ).toBe(true);
    }
  });
});
