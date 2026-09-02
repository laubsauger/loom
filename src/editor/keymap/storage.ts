import { isValidKeys, normalizeKeys } from "./keys.ts";

/**
 * Override persistence (§V54).
 *
 * Overrides live in `localStorage` and NEVER in the project document — a keymap is
 * per-person chrome, not project data, and must not travel inside a `.loom.json` or
 * across collaborators. Same defensiveness as `src/app/layout-storage.ts`: a corrupt or
 * blocked store degrades to "no overrides", never to a broken session.
 */

// §V813: the `shaderloom` prefix is a STORAGE ADDRESS, not a name — renaming it orphans every user's saved state for zero visible benefit. The product renamed to Loom (§T899); this key deliberately did not.
export const KEYMAP_STORAGE_KEY = "shaderloom.keymap.overrides.v1";

export type KeymapOverrides = Record<string, string | null>;

export interface KeymapStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function defaultKeymapStorage(): KeymapStorage | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    // Safari private mode and hardened embedders throw on access.
    return null;
  }
}

/**
 * Reads the override layer. Entries whose value is neither `null` nor a parseable keys
 * string are dropped individually, so one bad entry cannot cost the user the rest of
 * their keymap.
 */
export function readOverrides(
  storage: KeymapStorage | null = defaultKeymapStorage(),
): KeymapOverrides {
  if (!storage) return {};

  let raw: string | null;
  try {
    raw = storage.getItem(KEYMAP_STORAGE_KEY);
  } catch {
    return {};
  }
  if (raw === null) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};

  const overrides: KeymapOverrides = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (id === "") continue;
    if (value === null) {
      overrides[id] = null;
      continue;
    }
    if (typeof value !== "string" || !isValidKeys(value)) continue;
    overrides[id] = normalizeKeys(value) ?? value;
  }
  return overrides;
}

export function writeOverrides(
  overrides: KeymapOverrides,
  storage: KeymapStorage | null = defaultKeymapStorage(),
): void {
  if (!storage) return;
  try {
    if (Object.keys(overrides).length === 0) {
      storage.removeItem(KEYMAP_STORAGE_KEY);
      return;
    }
    storage.setItem(KEYMAP_STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    // Quota or a blocked store: keymap persistence is a convenience, never a reason
    // to break the session.
  }
}

export function clearOverrides(storage: KeymapStorage | null = defaultKeymapStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(KEYMAP_STORAGE_KEY);
  } catch {
    /* see writeOverrides */
  }
}
