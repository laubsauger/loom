import { DEFAULT_BINDINGS } from "./defaults.ts";
import { detectPlatform, normalizeKeys } from "./keys.ts";
import type { ResolvedKeymap } from "./resolve.ts";
import { resolveKeymap } from "./resolve.ts";
import type { KeymapOverrides, KeymapStorage } from "./storage.ts";
import { defaultKeymapStorage, readOverrides, writeOverrides } from "./storage.ts";
import type { KeyBinding, Platform } from "./types.ts";

/**
 * The live keymap: defaults + the user's override layer, resolved and cached (§V54).
 *
 * A plain observable rather than a zustand store — this is one small piece of chrome
 * state with no cross-slice selectors, and keeping it framework-free is what lets the
 * whole engine be tested headless.
 */

export interface KeymapStoreOptions {
  defaults?: readonly KeyBinding[];
  /** `null` disables persistence entirely (tests, embedders). */
  storage?: KeymapStorage | null;
  platform?: Platform;
}

export type SetOverrideResult =
  | { status: "ok" }
  | { status: "invalid"; message: string }
  | { status: "unknown-binding"; message: string };

export interface KeymapStore {
  readonly platform: Platform;
  readonly defaults: readonly KeyBinding[];
  /** Stable reference; changes only when the keymap changes. */
  getSnapshot(): ResolvedKeymap;
  getOverrides(): KeymapOverrides;
  subscribe(listener: () => void): () => void;
  /** `null` unbinds. Returns why it was refused rather than failing silently. */
  setOverride(bindingId: string, keys: string | null): SetOverrideResult;
  /** Per-binding reset to the shipped default (§V54). */
  resetBinding(bindingId: string): void;
  /** Whole-map reset (§V54). */
  resetAll(): void;
  hasOverride(bindingId: string): boolean;
}

export function createKeymapStore(options: KeymapStoreOptions = {}): KeymapStore {
  const defaults = options.defaults ?? DEFAULT_BINDINGS;
  const platform = options.platform ?? detectPlatform();
  const storage = "storage" in options ? options.storage : defaultKeymapStorage();
  const knownIds = new Set(defaults.map((binding) => binding.id));

  let overrides: KeymapOverrides = storage ? readOverrides(storage) : {};
  let snapshot: ResolvedKeymap = resolveKeymap({ defaults, overrides }, platform);
  const listeners = new Set<() => void>();

  function commit(next: KeymapOverrides): void {
    overrides = next;
    snapshot = resolveKeymap({ defaults, overrides }, platform);
    if (storage) writeOverrides(overrides, storage);
    for (const listener of listeners) listener();
  }

  return {
    platform,
    defaults,

    getSnapshot: () => snapshot,
    getOverrides: () => ({ ...overrides }),

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    hasOverride: (bindingId) => Object.prototype.hasOwnProperty.call(overrides, bindingId),

    setOverride(bindingId, keys): SetOverrideResult {
      if (!knownIds.has(bindingId)) {
        return {
          status: "unknown-binding",
          message: `No binding with id "${bindingId}".`,
        };
      }
      if (keys === null) {
        commit({ ...overrides, [bindingId]: null });
        return { status: "ok" };
      }
      const normalized = normalizeKeys(keys);
      if (normalized === null) {
        return { status: "invalid", message: `"${keys}" is not a valid key sequence.` };
      }
      const binding = defaults.find((entry) => entry.id === bindingId);
      const defaultKeys = binding === undefined ? null : normalizeKeys(binding.keys);
      const next = { ...overrides };
      if (normalized === defaultKeys) {
        // Back to the shipped value: drop the override rather than storing a no-op,
        // so a future change to the default is picked up.
        delete next[bindingId];
      } else {
        next[bindingId] = normalized;
      }
      commit(next);
      return { status: "ok" };
    },

    resetBinding(bindingId) {
      if (!Object.prototype.hasOwnProperty.call(overrides, bindingId)) return;
      const next = { ...overrides };
      delete next[bindingId];
      commit(next);
    },

    resetAll() {
      if (Object.keys(overrides).length === 0) return;
      commit({});
    },
  };
}
