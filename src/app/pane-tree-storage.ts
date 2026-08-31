import {
  DEFAULT_LAYOUT_ID,
  LAYOUT_PRESETS,
  isPresetLayoutId,
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
 * Reading walks the chain: v5 → v4 → v3 (which itself migrates v2) → stock default.
 * Every stored layout goes through `repairPaneTree`, so a corrupt entry degrades to the
 * default rather than an unusable shell — `readLayoutStore`'s own contract, one
 * version up.
 *
 * This module is separate from `layout-storage.ts` for one structural reason: the tree
 * model imports the flat model (for migration), so the flat module cannot import the
 * tree without a cycle whose initializers actually bite (DEFAULT_PANE_TREE is built
 * from DEFAULT_SHELL_LAYOUT at module init).
 */

/**
 * v5 has the SAME SHAPE as v4. The bump is a one-time TICKET, not a schema change: it is
 * what makes T466's repair below fire exactly once per profile and never again. A flag
 * inside the record would do the same job, at the cost of a field in `PaneTreeStore`
 * that means nothing to anything but the reader; the chain already speaks versions.
 */
export const PANE_TREE_STORAGE_KEY = "shaderloom.shell.layouts.v5";

/** v4's key. Read once, repaired, and removed — see `readPaneTreeStore`. */
export const LEGACY_PANE_TREE_STORAGE_KEY = "shaderloom.shell.layouts.v4";

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

/** One stored v4/v5 record → a usable store. Shared by both keys; they share a shape. */
function storeFromRecord(source: Record<string, unknown>): PaneTreeStore {
  const layouts = repairNamedTrees(source["layouts"]);
  const currentId = source["currentId"];
  const known =
    typeof currentId === "string" &&
    (PANE_TREE_PRESETS.some((preset) => preset.id === currentId) ||
      layouts.some((entry) => entry.id === currentId));

  return {
    current: repairPaneTree(source["current"]),
    /*
     * T589 (amending T470): a vanished selection CLEARS — preset or user layout, one
     * rule. T470 repointed a vanished preset's NAME to Default while leaving the
     * ARRANGEMENT untouched, so the menu said Default while the shell was still
     * Classic: §V399's "falls back gracefully and named" was half true, and the half
     * that lied was the name. Clearing keeps the furniture the user was actually
     * looking at and lets the menu say the honest thing — an unsaved arrangement —
     * instead of claiming a preset the shell does not show.
     */
    currentId: known ? (currentId as string) : null,
    layouts,
  };
}

/** The id `migrateLegacyLayout` mints for a user's own pre-T426 arrangement. */
const MIGRATED_LAYOUT_ID = "user:saved-layout";

/**
 * T466, second half (§V437). The first half changed the v2 migration to keep a user's
 * arrangement as a named row WITHOUT selecting it — a default nobody is shown is not a
 * default. That only ever reaches a profile that has not migrated yet, and the migration
 * never runs twice, so every profile that had already upgraded stayed parked on the row
 * the OLD rule selected: the owner's own, which is why they kept reporting the same
 * thing after it was "fixed". Delivering the RULE at one site is not delivering it.
 *
 * So the rule is applied once, retroactively, to exactly the selection the migration
 * minted. It is NOT a general "reset to default": the row survives untouched and one
 * click away, nothing a person arranged by hand is read, and `user:saved-layout` is an
 * id no other code path can produce — a layout the user saved themselves has their own
 * name in it. V18 holds: this returns a person to the default they were never shown, it
 * does not seize an arrangement they chose.
 *
 * Once, because the v5 key it is written back under makes the v4 branch unreachable
 * afterwards. Someone who then picks "Saved layout" on purpose keeps it forever.
 */
function unpinMigratedSelection(store: PaneTreeStore): PaneTreeStore {
  if (store.currentId !== MIGRATED_LAYOUT_ID) return store;
  if (!store.layouts.some((entry) => entry.id === MIGRATED_LAYOUT_ID)) return store;
  return applyNamedPaneTree(store, DEFAULT_LAYOUT_ID);
}

/**
 * Never throws, never returns a partial store. An absent v5 record reads v4 (applying
 * T466's one-time repair), and an absent v4 migrates the v3 store — which migrates v2
 * itself — arrangement, selection and every named layout, so upgrading costs the user
 * nothing (V311).
 */
export function readPaneTreeStore(
  storage: LayoutStorage | null = defaultLayoutStorage(),
): PaneTreeStore {
  if (!storage) return DEFAULT_PANE_TREE_STORE;

  const parsed = readJson(storage, PANE_TREE_STORAGE_KEY);
  if (typeof parsed === "object" && parsed !== null) {
    return storeFromRecord(parsed as Record<string, unknown>);
  }

  const legacy = readJson(storage, LEGACY_PANE_TREE_STORAGE_KEY);
  if (typeof legacy === "object" && legacy !== null) {
    return unpinMigratedSelection(storeFromRecord(legacy as Record<string, unknown>));
  }

  const flat = readLayoutStore(storage);
  return unpinMigratedSelection({
    current: treeFromShellLayout(flat.current),
    currentId: flat.currentId,
    layouts: flat.layouts.map((entry) => ({
      id: entry.id,
      name: entry.name,
      layout: treeFromShellLayout(entry.layout),
    })),
  });
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
      JSON.stringify({ version: 5, current: store.current, currentId: store.currentId, layouts: store.layouts }),
    );
    // V385, the same rule the v3 projection follows: v4 is now stale, and a stale record
    // silently restores an arrangement the user has moved on from. The v3 projection
    // below is what a downgraded build reads.
    storage.removeItem(LEGACY_PANE_TREE_STORAGE_KEY);
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

// ---- named layouts over the TREE store (T436's verbs, one version up) ---------------

export function allNamedPaneTrees(store: PaneTreeStore): readonly NamedPaneTree[] {
  return [...PANE_TREE_PRESETS, ...store.layouts];
}

export function findNamedPaneTree(store: PaneTreeStore, id: string): NamedPaneTree | undefined {
  return allNamedPaneTrees(store).find((entry) => entry.id === id);
}

/** RESTORE: the named layout becomes the live one, and the selection follows it. */
export function applyNamedPaneTree(store: PaneTreeStore, id: string): PaneTreeStore {
  const found = findNamedPaneTree(store, id);
  if (found === undefined) return store;
  return { ...store, current: found.layout, currentId: found.id };
}

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Deterministic — no clock, no randomness, so a test can name the entry it just made. */
function mintPaneTreeId(store: PaneTreeStore, name: string): string {
  const base = `user:${slug(name) || "layout"}`;
  const taken = new Set(store.layouts.map((entry) => entry.id));
  if (!taken.has(base)) return base;
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

/** SAVE AS: a NEW entry holding the live arrangement — the only verb that grows the list. */
export function savePaneTreeAs(store: PaneTreeStore, name: string): PaneTreeStore {
  const trimmed = name.trim();
  if (trimmed === "") return store;
  const id = mintPaneTreeId(store, trimmed);
  return {
    current: store.current,
    currentId: id,
    layouts: [...store.layouts, { id, name: trimmed, layout: store.current }],
  };
}

/** UPDATE: overwrite an EXISTING user layout. Never appends; a preset is code. */
export function updateNamedPaneTree(store: PaneTreeStore, id: string): PaneTreeStore {
  if (isPresetLayoutId(id)) return store;
  if (!store.layouts.some((entry) => entry.id === id)) return store;
  return {
    ...store,
    currentId: id,
    layouts: store.layouts.map((entry) =>
      entry.id === id ? { ...entry, layout: store.current } : entry,
    ),
  };
}

export function renameNamedPaneTree(store: PaneTreeStore, id: string, name: string): PaneTreeStore {
  const trimmed = name.trim();
  if (trimmed === "" || isPresetLayoutId(id)) return store;
  if (!store.layouts.some((entry) => entry.id === id)) return store;
  return {
    ...store,
    layouts: store.layouts.map((entry) => (entry.id === id ? { ...entry, name: trimmed } : entry)),
  };
}

/** DELETE a user layout. The screen does not change; only the selection is dropped. */
export function deleteNamedPaneTree(store: PaneTreeStore, id: string): PaneTreeStore {
  if (isPresetLayoutId(id)) return store;
  if (!store.layouts.some((entry) => entry.id === id)) return store;
  return {
    current: store.current,
    currentId: store.currentId === id ? null : store.currentId,
    layouts: store.layouts.filter((entry) => entry.id !== id),
  };
}

/**
 * Ratio noise from a live drag must not read as "modified" — compare to half a percent.
 *
 * T590's measurement found the old rounding was `ratio * 2 / 2`: half a UNIT, not half
 * a percent. Ratios live on two scales in this tree (the shell projection's splits are
 * percentages, `splitLeaf`'s are fractions), and on the fraction scale half a unit is
 * the whole range — every drag between 0.25 and 0.75 compared equal, so the modified
 * badge stayed OFF through real rearrangement. Scale-aware: fractions round to 1/200,
 * percentages to 1/2 — half a percent either way, as the sentence above always claimed.
 */
function normalizeTreeNode(node: PaneTreeLayout["root"]): unknown {
  if (node.kind === "leaf") return { kind: "leaf", id: node.id, tabs: node.tabs, active: node.active };
  const scale = node.ratio <= 1 ? 200 : 2;
  return {
    kind: "split",
    id: node.id,
    direction: node.direction,
    ratio: Math.round(node.ratio * scale) / scale,
    first: normalizeTreeNode(node.first),
    second: normalizeTreeNode(node.second),
  };
}

function samePaneTree(a: PaneTreeLayout, b: PaneTreeLayout): boolean {
  return (
    JSON.stringify({ root: normalizeTreeNode(a.root), floating: a.floating }) ===
    JSON.stringify({ root: normalizeTreeNode(b.root), floating: b.floating })
  );
}

/** Has the live arrangement drifted from the layout it was restored from? */
export function isPaneTreeModified(store: PaneTreeStore): boolean {
  if (store.currentId === null) return true;
  const selected = findNamedPaneTree(store, store.currentId);
  if (selected === undefined) return true;
  return !samePaneTree(selected.layout, store.current);
}
