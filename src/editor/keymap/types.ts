import type { CommandName } from "../../domain/types/commands.ts";
import type { NodeId } from "../../domain/types/ids.ts";

/**
 * Keymap data model (§I.keymap, T76–T79).
 *
 * §V52: a binding NAMES a bus command. There is no inline handler here and no
 * `if (event.key === "z")` anywhere in a component — the whole point of this module is
 * that hotkeys, menus, the command palette and future agent adapters all funnel into
 * `AppCommandBus.execute` (§V29), so there is exactly one mutation path to audit, undo
 * and reason about.
 */

export type KeyContext = "global" | "graph" | "inspector" | "viewer" | "text";

export const KEY_CONTEXTS: readonly KeyContext[] = [
  "global",
  "graph",
  "inspector",
  "viewer",
  "text",
];

/**
 * Specificity, narrowest wins (§V53). `graph`, `inspector` and `viewer` are siblings —
 * only one of them is ever active at a time, so they share a rank. `text` outranks all
 * of them because it is entered *inside* one of those panes.
 */
export const CONTEXT_RANK: Record<KeyContext, number> = {
  global: 1,
  graph: 2,
  inspector: 2,
  viewer: 2,
  text: 3,
};

export type Platform = "mac" | "other";

/**
 * A binding may name a command no track has registered yet (play/pause, save, group,
 * fit…). Those are declared here on purpose and reported as *unresolved* — never
 * stubbed onto the bus, never crashed on. `CommandName` stays in the union so the
 * already-registered commands keep autocompleting and type-checking.
 */
export type KeymapCommandName = CommandName | (string & Record<never, never>);

/** Where a command's input comes from when it is not static (§T77). */
export interface BindingInputSource {
  from: "selection" | "hoveredNode" | "selectionOrHovered";
  /** Property name the resolved value is written to on the command input. */
  as: string;
}

export interface KeyBinding {
  /** Stable id. Survives rebinding — overrides are keyed by it (§V54). */
  id: string;
  /** "mod+z", "shift+h", "g d" (chord). `mod` = Cmd on macOS, Ctrl elsewhere. */
  keys: string;
  /** Narrowest wins; `text` swallows editing keys (§V53). */
  context: KeyContext;
  /** Bus command name — ⊥ inline handler (§V52). */
  command: KeymapCommandName;
  /** Static command input. Merged with `inputFrom` when both are present. */
  input?: Record<string, unknown>;
  /** Selection-resolved input (§T77). */
  inputFrom?: BindingInputSource;
  /** Guard name, optionally negated: "hasSelection", "!hasSelection". */
  when?: string;
  /** Shown in the palette, menus and tooltips (§V55). */
  label: string;
  /** Longer text for the palette. */
  description?: string;
  /**
   * The spec marks some TD-derived defaults `?` — unconfirmed against a real
   * TouchDesigner install. Surfaced in the settings pane so they can be corrected.
   */
  unconfirmed?: boolean;
}

/** §I.keymap — defaults plus the user's layer. `null` = deliberately unbound. */
export interface Keymap {
  defaults: readonly KeyBinding[];
  overrides: Readonly<Record<string, string | null>>;
}

/**
 * Everything a `when` guard or a selection-resolved input needs. Supplied by the app
 * shell; the keymap never reaches into another track's store.
 */
export interface KeymapEnvironment {
  /** Fallback context when the focused element does not declare one. */
  context: KeyContext;
  selection: readonly NodeId[];
  hoveredNodeId: NodeId | null;
}

export const EMPTY_ENVIRONMENT: KeymapEnvironment = {
  context: "global",
  selection: [],
  hoveredNodeId: null,
};
