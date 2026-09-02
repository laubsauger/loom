/**
 * "Show the node TYPE beside its name" (T416, §V90).
 *
 * ## What it is for
 *
 * An unrenamed node is auto-named from its type — `blur1`, `over2` (§V129) — so the name
 * IS the identification, which is why a TouchDesigner network reads at a glance. Renaming
 * to `Bloom pass` buys a meaningful name and spends that identification. The owner asked
 * for the type back beside the name, with a way to turn it off.
 *
 * ## Why this is not a `ProjectSettings` field
 *
 * It is per-person chrome, not project data — exactly the line §V18 draws for pane layout
 * and §V54 draws for keymap overrides, and for the same two reasons. It must not travel
 * inside a `.loom.json`, where one person's reading preference would arrive as a fact
 * about someone else's document; and it must not bump the document revision, because a
 * look at the graph on the undo stack means ⌘Z after a glance undoes the glance instead of
 * the edit (the argument `ui.toggleReferenceLines` already makes for §V153).
 *
 * ## Why `localStorage` rather than session-scoped
 *
 * `ui.toggleReferenceLines` is deliberately session-scoped: it is a momentary act on a
 * dense network. This is not that. Someone who turns the type off has decided their nodes
 * are too busy, and a decision that silently reverts on reload is a setting that does not
 * work. Degrades the same way every other store here does: a blocked or corrupt store
 * reads as the default, never as a broken session.
 *
 * Default ON — the whole point is to keep an identification the rename took away, and a
 * feature that must be discovered before it can show you something you did not know was
 * missing is a feature nobody turns on.
 */

// §V813: the `shaderloom` prefix is a STORAGE ADDRESS, not a name — renaming it orphans every user's saved state for zero visible benefit. The product renamed to Loom (§T899); this key deliberately did not.
export const NODE_TYPE_LABELS_STORAGE_KEY = "shaderloom.graph.nodeTypeLabels.v1";

export const NODE_TYPE_LABELS_DEFAULT = true;

export interface PreferenceStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface NodeTypeLabelStore {
  get(): boolean;
  set(shown: boolean): void;
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

export function createNodeTypeLabelStore(
  storage: PreferenceStorage | null = defaultStorage(),
): NodeTypeLabelStore {
  let shown = NODE_TYPE_LABELS_DEFAULT;
  try {
    const raw = storage?.getItem(NODE_TYPE_LABELS_STORAGE_KEY) ?? null;
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
      if (next === shown) return;
      shown = next;
      try {
        storage?.setItem(NODE_TYPE_LABELS_STORAGE_KEY, next ? "on" : "off");
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
 * Deliberately NOT keyed by bus, unlike the rename session: this is a property of the
 * PERSON, so every canvas and the settings dialog — which is nowhere near a canvas in the
 * tree — must read the same one. `localStorage` is already a per-person singleton; a
 * second identity on top of it would only be a way for two surfaces to disagree.
 */
let shared: NodeTypeLabelStore | null = null;

export function nodeTypeLabelStore(): NodeTypeLabelStore {
  shared ??= createNodeTypeLabelStore();
  return shared;
}
