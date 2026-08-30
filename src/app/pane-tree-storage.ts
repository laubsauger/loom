import {
  DEFAULT_LAYOUT_ID,
  LAYOUT_PRESETS,
  LAYOUT_STORAGE_KEY,
  LAYOUT_STORE_VERSION,
  defaultLayoutStorage,
  readJson,
  readLayoutStore,
} from "./layout-storage.ts";
import type { LayoutStorage } from "./layout-storage.ts";
import {
  DEFAULT_PANE_TREE,
  repairPaneTree,
  shellLayoutFromTree,
  treeFromShellLayout,
} from "./pane-tree.ts";
import type { PaneTreeLayout } from "./pane-tree.ts";

/**
 * The pane tree's persistence (T404, V311, V385).
 *
 * v4 lives BESIDE v3, not instead of it. The tree is the truth; a v3 PROJECTION is
 * written under the old key WHILE the tree is still flat-expressible, so an older build
 * opening the same browser keeps the arrangement. The moment the tree stops being
 * projectable — a split, a second tab of one role — the v3 record is CLEARED, never
 * left behind (V385): a stale projection silently restores an arrangement the user
 * abandoned, where an absent one falls back to a default the user can SEE.
 *
 * Reading walks the chain: v4 → v3 (which itself migrates v2) → stock default. Every
 * stored layout goes through `repairPaneTree`, so a corrupt entry degrades to the
 * default rather than an unusable shell — `readLayoutStore`'s own contract, one
 * version up.
 *
 * This module is separate from `layout-storage.ts` for one structural reason: the tree
 * model imports the flat model (for migration), so the flat module cannot import the
 * tree without a cycle whose initializers actually bite (DEFAULT_PANE_TREE is built
 * from DEFAULT_SHELL_LAYOUT at module init).
 */

export const PANE_TREE_STORAGE_KEY = "shaderloom.shell.layouts.v4";

export interface NamedPaneTree {
  readonly id: string;
  readonly name: string;
  readonly layout: PaneTreeLayout;
}

export interface PaneTreeStore {
  /** The live arrangement — what the shell mounts with. */
  readonly current: PaneTreeLayout;
  /** The named layout the current arrangement came from, when it came from one. */
  readonly currentId: string | null;
  /** User-saved layouts (T436), as trees. Presets are code, never stored. */
  readonly layouts: readonly NamedPaneTree[];
}

/** The stock presets, lifted from the flat model's own list (T436). */
export const PANE_TREE_PRESETS: readonly NamedPaneTree[] = LAYOUT_PRESETS.map((preset) => ({
  id: preset.id,
  name: preset.name,
  layout: treeFromShellLayout(preset.layout),
}));

export const DEFAULT_PANE_TREE_STORE: PaneTreeStore = {
  current: DEFAULT_PANE_TREE,
  // The flat store's own answer (T436): a fresh shell IS the default preset.
  currentId: DEFAULT_LAYOUT_ID,
  layouts: [],
};

function repairNamedTrees(candidate: unknown): NamedPaneTree[] {
  if (!Array.isArray(candidate)) return [];
  const seen = new Set<string>();
  const layouts: NamedPaneTree[] = [];
  for (const entry of candidate) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = record["id"];
    const name = record["name"];
    if (typeof id !== "string" || id === "" || PANE_TREE_PRESETS.some((preset) => preset.id === id)) continue;
    if (typeof name !== "string" || name.trim() === "") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    layouts.push({ id, name: name.trim(), layout: repairPaneTree(record["layout"]) });
  }
  return layouts;
}

/**
 * Never throws, never returns a partial store. An absent v4 record migrates the v3
 * store (which migrates v2 itself) — arrangement, selection and every named layout —
 * so upgrading costs the user nothing (V311).
 */
export function readPaneTreeStore(
  storage: LayoutStorage | null = defaultLayoutStorage(),
): PaneTreeStore {
  if (!storage) return DEFAULT_PANE_TREE_STORE;

  const parsed = readJson(storage, PANE_TREE_STORAGE_KEY);
  if (typeof parsed !== "object" || parsed === null) {
    const flat = readLayoutStore(storage);
    return {
      current: treeFromShellLayout(flat.current),
      currentId: flat.currentId,
      layouts: flat.layouts.map((entry) => ({
        id: entry.id,
        name: entry.name,
        layout: treeFromShellLayout(entry.layout),
      })),
    };
  }

  const source = parsed as Record<string, unknown>;
  const layouts = repairNamedTrees(source["layouts"]);
  const currentId = source["currentId"];
  const known =
    typeof currentId === "string" &&
    (PANE_TREE_PRESETS.some((preset) => preset.id === currentId) ||
      layouts.some((entry) => entry.id === currentId));

  return {
    current: repairPaneTree(source["current"]),
    currentId: known ? (currentId as string) : null,
    layouts,
  };
}

/**
 * Writes v4, then keeps the v3 record honest: a faithful projection while one exists,
 * REMOVAL the moment it does not (V385). Named layouts project individually — the
 * faithful ones stay reachable from an old build, the tree-only ones simply are not
 * there rather than being there wrong.
 */
export function writePaneTreeStore(
  store: PaneTreeStore,
  storage: LayoutStorage | null = defaultLayoutStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(
      PANE_TREE_STORAGE_KEY,
      JSON.stringify({ version: 4, current: store.current, currentId: store.currentId, layouts: store.layouts }),
    );
    const projected = shellLayoutFromTree(store.current);
    if (projected === null) {
      storage.removeItem(LAYOUT_STORAGE_KEY);
      return;
    }
    const flatLayouts = store.layouts.flatMap((entry) => {
      const layout = shellLayoutFromTree(entry.layout);
      return layout === null ? [] : [{ id: entry.id, name: entry.name, layout }];
    });
    storage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORE_VERSION,
        current: projected,
        currentId: store.currentId,
        layouts: flatLayouts,
      }),
    );
  } catch {
    // Quota or a blocked store: layout persistence is a convenience, never a
    // reason to break the session (writeLayoutStore's own contract).
  }
}
