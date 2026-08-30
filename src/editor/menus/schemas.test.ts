import { describe, expect, it } from "vitest";
import { createHarness } from "@domain/commands/test-support.ts";
import type { MenuEntry, MenuItem, MenuSchema } from "@domain/types/menus.ts";
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
];

describe("what the menus promise but nobody has built", () => {
  it("PLANNED_COMMANDS is exactly the set the menus name and no track implements", () => {
    // The anti-drift check for the disabled half of the menus: when a track finally
    // registers `view.frameAll`, this fails and PLANNED_COMMANDS gets one entry shorter.
    const named = new Set(
      everyItem.map((item) => item.command).filter((command): command is NonNullable<typeof command> => command !== undefined),
    );
    const missing = [...named]
      .filter((command) => !bus.hasCommand(command) && !APP_REGISTERED.includes(command))
      .sort();
    expect(missing).toEqual([...PLANNED_COMMANDS].sort());
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

  it("gives the three node toggles a state guard, so each shows a checkmark", () => {
    const nodeItems = items(menuSchemaFor("node", registry).entries);
    const toggles = nodeItems.filter((item) => item.command !== undefined && TOGGLE_GUARD[item.command] !== undefined);
    // "Pin preview" is `node.togglePin` since T353: the preview SWITCH left the menu when
    // it stopped being a pin, because it has the `P` button and the `d` key and the item
    // cap below has no room for both.
    expect(toggles.map((item) => item.label)).toEqual(["Bypass", "Mute", "Pin preview"]);
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
