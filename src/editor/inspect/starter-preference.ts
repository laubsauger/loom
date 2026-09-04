/**
 * "Start on a starter network rather than an empty canvas" (§V18, §V54's category).
 *
 * ## What it controls
 *
 * On a boot with NOTHING to restore, the app opens a small shipped example instead of an
 * empty graph, so the first thing a new user sees is a picture they can grab a slider on.
 * This switch turns that off. The mechanism is `src/app/use-starter-project.ts`; this
 * module is only the remembered answer.
 *
 * ## Why this is not a `ProjectSettings` field
 *
 * It is a property of the PERSON, not of any document: it decides what happens BEFORE a
 * document exists, so there is no `.loom.json` it could honestly live in. Writing it into
 * one would send a preference about a first boot to somebody else's machine along with
 * the file. Same line §V18 draws for pane layout, §V54 for keymap overrides, and T416 for
 * the node type label — and the same storage answer, for the same reason: a decision that
 * silently reverts on reload is a setting that does not work.
 *
 * ## Default ON
 *
 * The empty canvas is the state this exists to replace, so defaulting to it would ship
 * the feature switched off. Turning it off is a preference someone forms after seeing the
 * starter; turning it on is one nobody can form before.
 *
 * Degrades the way every other preference store here does: a blocked or corrupt store
 * reads as the default, never as a broken session.
 */

// §V813: the `shaderloom` prefix is a STORAGE ADDRESS, not a name — renaming it orphans every user's saved state for zero visible benefit. The product renamed to Loom (§T899); this key deliberately did not.
export const STARTER_PREFERENCE_STORAGE_KEY = "shaderloom.project.startOnStarter.v1";

export const STARTER_PREFERENCE_DEFAULT = true;

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface StarterPreferenceStore {
  get(): boolean;
  set(enabled: boolean): void;
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

export function createStarterPreferenceStore(
  storage: PreferenceStorage | null = defaultStorage(),
): StarterPreferenceStore {
  let enabled = STARTER_PREFERENCE_DEFAULT;
  try {
    const raw = storage?.getItem(STARTER_PREFERENCE_STORAGE_KEY) ?? null;
    // Only the two words it writes are honoured; anything else is a corrupt entry and
    // reads as the default rather than as `false`.
    if (raw === "on") enabled = true;
    else if (raw === "off") enabled = false;
  } catch {
    /* see defaultStorage */
  }

  const listeners = new Set<() => void>();
  return {
    get: () => enabled,
    set: (next) => {
      if (next === enabled) return;
      enabled = next;
      try {
        storage?.setItem(STARTER_PREFERENCE_STORAGE_KEY, next ? "on" : "off");
      } catch {
        // Quota or a blocked store: persistence is a convenience, never a reason to
        // refuse the change the user just made in front of them.
      }
      for (const listener of [...listeners]) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/**
 * One store for the app.
 *
 * The same singleton argument `nodeTypeLabelStore` makes: this is a property of the
 * person, and the two surfaces that read it — the settings dialog and the composition
 * root's boot decision — are nowhere near each other in the tree. `localStorage` is
 * already a per-person singleton; a second identity on top of it would only be a way for
 * the switch and the boot to disagree.
 */
let shared: StarterPreferenceStore | null = null;

export function starterPreferenceStore(): StarterPreferenceStore {
  shared ??= createStarterPreferenceStore();
  return shared;
}
