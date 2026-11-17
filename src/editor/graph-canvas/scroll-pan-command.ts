// v16-allow-command-bus: registers `view.toggleScrollPan`, which makes no patch and opens no
// undo group — what a scroll gesture does to the view is not something the document knows.
import type { LoomBus } from "@domain/commands/bus.ts";
import type { PreferenceStorage } from "@editor/nodes/node-type-labels.ts";
import { z } from "zod";

/**
 * `view.toggleScrollPan` — what a two-finger scroll does on the graph (T1724b).
 *
 * TouchDesigner's network editor zooms on the wheel (`docs.derivative.ca/Network_Editor`),
 * and so does Loom by default. On a trackpad that means a two-finger slide zooms and there
 * is no two-finger pan at all — TD's own users have asked for one since 2022
 * (`forum.derivative.ca/t/304411`). A wheel event does not say whether it came from a mouse
 * or a trackpad, so this is the person's choice, not a guess: ON, a scroll pans the view and
 * a pinch (or Cmd/Ctrl + scroll) zooms; OFF, the wheel zooms as in TouchDesigner.
 *
 * Per person and persisted, for `minimap-command.ts`'s reasons: chrome, not project data
 * (§V18, §V54), one store over one `localStorage` key rather than one per bus, so a canvas
 * inside a component dive and the root canvas cannot disagree.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Scroll pans (`pan: true`) or zooms. `pan` omitted FLIPS, which is what a menu row means. */
    "view.toggleScrollPan": {
      input: { pan?: boolean };
      output: { pan: boolean };
    };
  }
}

export const TOGGLE_SCROLL_PAN_COMMAND = "view.toggleScrollPan";

// §V813: the `shaderloom` prefix is a STORAGE ADDRESS, not a name (see `minimap-command.ts`).
export const SCROLL_PAN_STORAGE_KEY = "shaderloom.graph.scrollPan.v1";

/** TouchDesigner's: the wheel zooms. */
export const SCROLL_PAN_DEFAULT = false;

export interface ScrollPanStore {
  get(): boolean;
  set(pan: boolean): boolean;
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

export function createScrollPanStore(storage: PreferenceStorage | null = defaultStorage()): ScrollPanStore {
  let pan = SCROLL_PAN_DEFAULT;
  try {
    const raw = storage?.getItem(SCROLL_PAN_STORAGE_KEY) ?? null;
    // Only the two words it writes are honoured; anything else reads as the default.
    if (raw === "pan") pan = true;
    else if (raw === "zoom") pan = false;
  } catch {
    /* see defaultStorage */
  }

  const listeners = new Set<() => void>();
  return {
    get: () => pan,
    set: (next) => {
      if (next === pan) return pan;
      pan = next;
      try {
        storage?.setItem(SCROLL_PAN_STORAGE_KEY, next ? "pan" : "zoom");
      } catch {
        // A blocked store keeps the change for this session; persistence is a convenience.
      }
      for (const listener of [...listeners]) listener();
      return pan;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** One store for the person — see the module docblock for why it is not keyed by bus. */
let shared: ScrollPanStore | null = null;

export function scrollPanStore(): ScrollPanStore {
  shared ??= createScrollPanStore();
  return shared;
}

/** Idempotent, and registered on every bus the canvas is handed, as `registerMinimapCommand` is. */
export function registerScrollPanCommand(bus: LoomBus): ScrollPanStore {
  const store = scrollPanStore();
  if (bus.hasCommand(TOGGLE_SCROLL_PAN_COMMAND)) return store;

  bus.registerCommand({
    name: TOGGLE_SCROLL_PAN_COMMAND,
    inSession: "app",
    inputSchema: z.object({ pan: z.boolean().optional() }).strict(),
    description:
      "Make a two-finger scroll pan the graph (pinch or Cmd/Ctrl + scroll zooms), or zoom it as TouchDesigner's wheel does (T1724b).",
    handler: (input, context) => {
      const next = input.pan ?? !store.get();
      // §V36 — a dry run answers what WOULD happen and changes nothing.
      if (context.dryRun) return { status: "validated", output: { pan: next } };
      return { status: "applied", output: { pan: store.set(next) } };
    },
    rejectionOutput: () => ({ pan: store.get() }),
  });

  return store;
}
