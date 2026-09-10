// v16-allow-command-bus: registers `view.toggleMinimap`, which makes no patch and opens no
// undo group — whether the overview map is on screen is not something the document knows.
import type { LoomBus } from "@domain/commands/bus.ts";
import type { PreferenceStorage } from "@editor/nodes/node-type-labels.ts";

/**
 * `view.toggleMinimap` — TouchDesigner's network overview, as a corner map (T1257).
 *
 * TD toggles "a scale 'overview' representation of the Network" with `o`
 * (docs.derivative.ca, Network_Editor; Application_Shortcuts row `network.overview | o`).
 * Loom's version is React Flow's `<MiniMap>` in the graph pane's corner: node boxes
 * coloured by family, the visible viewport as a mask, drag to pan, click to jump.
 *
 * ## Per person, persisted — `nodeTypeLabelStore`'s reasons, not `ui.toggleEdgeFlow`'s
 *
 * Whether the map is on screen is chrome, not project data (§V18, §V54): it must not
 * travel in a `.loom.json` and must not bump the document revision. Unlike the reference
 * lines or the flow dashes — momentary instruments on a dense graph — hiding the map is a
 * decision about one's own screen, and a decision that reverts on reload is a setting
 * that does not work. So this is one store for the PERSON, backed by `localStorage`, and
 * deliberately not bus-keyed: a canvas inside a component dive runs on a session bus, and
 * two identities over one storage key would only be a way for the root canvas and the
 * dived one to disagree after a toggle.
 *
 * Default ON: TD shows it, and a map is the thing that tells a first-time reader where
 * the rest of a large network went.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Show or hide the overview map. `show` omitted FLIPS, which is what the `o` key and
     * a menu row mean.
     */
    "view.toggleMinimap": {
      input: { show?: boolean };
      output: { shown: boolean };
    };
  }
}

export const TOGGLE_MINIMAP_COMMAND = "view.toggleMinimap";

// §V813: the `shaderloom` prefix is a STORAGE ADDRESS, not a name — renaming it orphans every user's saved state for zero visible benefit. The product renamed to Loom (§T899); this key deliberately did not.
export const MINIMAP_STORAGE_KEY = "shaderloom.graph.minimap.v1";

export const MINIMAP_DEFAULT = true;

export interface MinimapStore {
  get(): boolean;
  set(shown: boolean): boolean;
  subscribe(listener: () => void): () => void;
}

function defaultStorage(): PreferenceStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Safari private mode and hardened embedders throw on access.
    return null;
  }
}

export function createMinimapStore(storage: PreferenceStorage | null = defaultStorage()): MinimapStore {
  let shown = MINIMAP_DEFAULT;
  try {
    const raw = storage?.getItem(MINIMAP_STORAGE_KEY) ?? null;
    // Only the two words it writes are honoured; anything else is a corrupt entry and
    // reads as the default rather than as `false`.
    if (raw === "on") shown = true;
    else if (raw === "off") shown = false;
  } catch {
    /* see defaultStorage */
  }

  const listeners = new Set<() => void>();
  return {
    get: () => shown,
    set: (next) => {
      if (next === shown) return shown;
      shown = next;
      try {
        storage?.setItem(MINIMAP_STORAGE_KEY, next ? "on" : "off");
      } catch {
        // Quota or a blocked store: persistence is a convenience, never a reason to
        // refuse the change the user just made in front of them.
      }
      for (const listener of [...listeners]) listener();
      return shown;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** One store for the person — see the module docblock for why it is not keyed by bus. */
let shared: MinimapStore | null = null;

export function minimapStore(): MinimapStore {
  shared ??= createMinimapStore();
  return shared;
}

/**
 * Idempotent: the bus has no unregister, and React mounts more than once. The canvas
 * registers on its own bus AND every door bus it is handed, because the keymap, the
 * menus and the palette dispatch on the ROOT bus while a component dive's canvas runs on
 * a session bus (T1195) — the `o` key must reach the map inside a dive too.
 */
export function registerMinimapCommand(bus: LoomBus): MinimapStore {
  const store = minimapStore();
  if (bus.hasCommand(TOGGLE_MINIMAP_COMMAND)) return store;

  bus.registerCommand({
    name: TOGGLE_MINIMAP_COMMAND,
    description:
      "Show or hide the network overview map in the graph pane's corner — drag it to pan, click it to jump (T1257).",
    handler: (input, context) => {
      const next = input.show ?? !store.get();
      // §V36 — a dry run answers what WOULD happen and changes nothing.
      if (context.dryRun) return { status: "validated", output: { shown: next } };
      return { status: "applied", output: { shown: store.set(next) } };
    },
    rejectionOutput: () => ({ shown: store.get() }),
  });

  return store;
}
