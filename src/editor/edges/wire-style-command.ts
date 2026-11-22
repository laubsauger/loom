// v16-allow-command-bus: registers `view.setWireStyle`, which makes no patch and opens no
// undo group — how a wire is drawn is not something the document knows about.
import type { LoomBus } from "@domain/commands/bus.ts";
import type { PreferenceStorage } from "@editor/nodes/node-type-labels.ts";
import { z } from "zod";
import { WIRE_STYLES, WIRE_STYLE_DEFAULT, isWireStyle, type WireStyle } from "./wire-path.ts";

/**
 * `view.setWireStyle` — curved, gentle or straight data wires (T1820b).
 *
 * The owner: *"can we make it so that our connectors can also be curved instead of just
 * straight pointers and make that the default? it gets a bit crowded with the straight
 * shots."* The shapes are `wire-path.ts`'s; this is the person's choice between them.
 *
 * Per person and persisted, for `minimap-command.ts`'s reasons: how wires are drawn is
 * chrome, not project data (§V18, §V54) — it changes no pixel the project renders, travels
 * in no `.loom.json` and bumps no revision — and a look someone picked that reverts on
 * reload is a setting that does not work. One store over one `localStorage` key rather
 * than one per bus, so a canvas inside a component dive and the root canvas draw the same
 * wires.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /**
     * Draw data wires `curved` (the default), `gentle` (React Flow's bezier, the look before
     * T1820b) or `straight`. `style` omitted steps to the next one, which is what a palette
     * run means.
     */
    "view.setWireStyle": {
      input: { style?: WireStyle };
      output: { style: WireStyle };
    };
  }
}

export const SET_WIRE_STYLE_COMMAND = "view.setWireStyle";

// §V813: the `shaderloom` prefix is a STORAGE ADDRESS, not a name (see `minimap-command.ts`).
export const WIRE_STYLE_STORAGE_KEY = "shaderloom.graph.wireStyle.v1";

export interface WireStyleStore {
  get(): WireStyle;
  set(style: WireStyle): WireStyle;
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

export function createWireStyleStore(storage: PreferenceStorage | null = defaultStorage()): WireStyleStore {
  let style: WireStyle = WIRE_STYLE_DEFAULT;
  try {
    const raw = storage?.getItem(WIRE_STYLE_STORAGE_KEY) ?? null;
    // Only the words it writes are honoured; anything else reads as the default.
    if (isWireStyle(raw)) style = raw;
  } catch {
    /* see defaultStorage */
  }

  const listeners = new Set<() => void>();
  return {
    get: () => style,
    set: (next) => {
      if (next === style) return style;
      style = next;
      try {
        storage?.setItem(WIRE_STYLE_STORAGE_KEY, next);
      } catch {
        // A blocked store keeps the change for this session; persistence is a convenience.
      }
      for (const listener of [...listeners]) listener();
      return style;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** One store for the person — see the module docblock for why it is not keyed by bus. */
let shared: WireStyleStore | null = null;

export function wireStyleStore(): WireStyleStore {
  shared ??= createWireStyleStore();
  return shared;
}

/** The style after `style`, wrapping: what `view.setWireStyle` with no input moves to. */
export function nextWireStyle(style: WireStyle): WireStyle {
  const index = WIRE_STYLES.indexOf(style);
  return WIRE_STYLES[(index + 1) % WIRE_STYLES.length] ?? WIRE_STYLE_DEFAULT;
}

/** Idempotent, and registered on the app's bus by the canvas, as `registerMinimapCommand` is. */
export function registerWireStyleCommand(bus: LoomBus): WireStyleStore {
  const store = wireStyleStore();
  if (bus.hasCommand(SET_WIRE_STYLE_COMMAND)) return store;

  bus.registerCommand({
    name: SET_WIRE_STYLE_COMMAND,
    inSession: "app",
    inputSchema: z.object({ style: z.enum(["curved", "gentle", "straight"]).optional() }).strict(),
    description:
      "Draw the graph's data wires curved (the default: they leave and enter their ports level), gentle (the earlier, flatter bezier) or straight (T1820b).",
    handler: (input, context) => {
      const next = input.style ?? nextWireStyle(store.get());
      // §V36 — a dry run answers what WOULD happen and changes nothing.
      if (context.dryRun) return { status: "validated", output: { style: next } };
      return { status: "applied", output: { style: store.set(next) } };
    },
    rejectionOutput: () => ({ style: store.get() }),
  });

  return store;
}
