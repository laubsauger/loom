import type { KeyContext } from "@editor/keymap/types.ts";
import type { ResolvedKeymap } from "@editor/keymap/resolve.ts";
import { displayForCommand } from "@editor/keymap/resolve.ts";

/**
 * The shortcut half of the help panel, DERIVED from the resolved keymap (T200, §V105).
 *
 * There is no table of shortcuts in this file and there must never be one. §V54 lets a
 * user rebind anything and §V55 already forbids a hardcoded "⌘Z" in a menu label; help
 * is the surface where that rule matters most, because help is READ AS TRUE. A panel
 * that said "⌘Z — Undo" after someone moved undo to ⌘U would be worse than no panel.
 *
 * So the sections below are a projection of `ResolvedKeymap` — the same object the
 * engine dispatches from, override layer and all. A binding with no keys (explicitly
 * unbound, §V54) still appears, marked, because "this exists and you have not bound it"
 * is a different fact from "this does not exist".
 */

export interface ShortcutEntry {
  /** Binding id, stable across rebinds — the key a settings row is found by. */
  readonly id: string;
  readonly label: string;
  readonly command: string;
  readonly context: KeyContext;
  /** Platform-correct display, or null when the binding carries no keys. */
  readonly display: string | null;
  readonly description: string | undefined;
  /** The keymap resolved a conflict here; the settings pane is where it is fixed. */
  readonly conflicted: boolean;
}

export interface ShortcutSection {
  readonly context: KeyContext;
  readonly entries: readonly ShortcutEntry[];
}

/** Every binding, grouped by the context it fires in, bound ones first. */
export function shortcutSections(resolved: ResolvedKeymap): readonly ShortcutSection[] {
  const byContext = new Map<KeyContext, ShortcutEntry[]>();

  for (const binding of resolved.bindings) {
    const entry: ShortcutEntry = {
      id: binding.id,
      label: binding.label,
      command: binding.command,
      context: binding.context,
      display: binding.display,
      description: binding.description,
      conflicted: resolved.conflictingIds.has(binding.id),
    };
    const bucket = byContext.get(binding.context);
    if (bucket === undefined) byContext.set(binding.context, [entry]);
    else bucket.push(entry);
  }

  return [...byContext.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([context, entries]) => ({
      context,
      entries: [...entries].sort((a, b) => {
        if ((a.display === null) !== (b.display === null)) return a.display === null ? 1 : -1;
        return a.label.localeCompare(b.label);
      }),
    }));
}

/**
 * The display for one command, when a surface wants a single lookup rather than a list.
 * A re-export by intent, not by accident: help must go through the keymap's own lookup.
 */
export function shortcutForCommand(resolved: ResolvedKeymap, command: string): string | null {
  return displayForCommand(resolved, command);
}
