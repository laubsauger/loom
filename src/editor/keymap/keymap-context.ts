import { createContext } from "react";
import type { LoomBus } from "../../domain/commands/bus.ts";
import type { InvocationContext } from "../../domain/types/commands.ts";
import type { KeymapEngine } from "./engine.ts";
import type { ResolvedKeymap } from "./resolve.ts";
import type { KeymapStore } from "./store.ts";

/**
 * The keymap's React context, alone in its own module (T1315b).
 *
 * A context defined beside a component is the one mixed-module case with a visible cost:
 * Fast Refresh re-evaluates the module, `createContext` makes a NEW context object, and
 * every consumer below silently falls back to the default — so the provider and the
 * hooks both reach for it here instead.
 */
export interface KeymapContextValue {
  store: KeymapStore;
  resolved: ResolvedKeymap;
  engine: KeymapEngine;
  bus: LoomBus;
  /** Actor identity every dispatch is stamped with (§V30). */
  invocationContext: InvocationContext;
  /** Chord in progress, "" when none. */
  pending: string;
}

export const KeymapReactContext = createContext<KeymapContextValue | null>(null);
