import { describe, expect, it } from "vitest";

import {
  DEFAULT_PANE_TREE_STORE,
  LEGACY_PANE_TREE_STORAGE_KEY,
  PANE_TREE_STORAGE_KEY,
  applyNamedPaneTree,
  readPaneTreeStore,
  writePaneTreeStore,
} from "./pane-tree-storage.ts";
import {
  DEFAULT_PANE_TREE,
  addTab,
  allTabs,
  setSplitRatio,
  shellLayoutFromTree,
  splitLeaf,
  treeFromShellLayout,
} from "./pane-tree.ts";
import {
  DEFAULT_LAYOUT_ID,
  DEFAULT_SHELL_LAYOUT,
  LAYOUT_STORAGE_KEY,
  LAYOUT_STORE_VERSION,
  LEGACY_LAYOUT_STORAGE_KEY,
  readLayoutStore,
  saveLayoutAs,
  writeLayoutStore,
} from "./layout-storage.ts";
import type { LayoutStorage } from "./layout-storage.ts";

/**
 * The v4 store beside the v3 store (T404, V311, V385). The migration is where a
 * mistake costs a user their arrangement, so both directions are pinned by CONTENT —
 * and V385's clear is pinned as an actual absent key, because a stale projection is a
 * lie with a version number.
 */

function memoryStorage(): LayoutStorage & { readonly map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

describe("the read chain: v4 → v3 → default (V311)", () => {
  it("an empty store answers the stock default", () => {
    expect(readPaneTreeStore(memoryStorage())).toEqual(DEFAULT_PANE_TREE_STORE);
  });

  it("a v3 store migrates wholesale — arrangement, selection and named layouts", () => {
    const storage = memoryStorage();
    const flat = {
      ...DEFAULT_SHELL_LAYOUT,
      columns: [60, 40] as const,
      active: { ...DEFAULT_SHELL_LAYOUT.active, left: "components" as const },
    };
    writeLayoutStore(saveLayoutAs({ current: flat, currentId: null, layouts: [] }, "stage rig"), storage);

    const store = readPaneTreeStore(storage);
    expect((store.current.root as { ratio: number }).ratio).toBe(60);
    const left = allTabs(store.current).filter((tab) => tab.role === "components");
    expect(left).toHaveLength(1);
    expect(store.layouts.map((entry) => entry.name)).toEqual(["stage rig"]);
    expect(store.currentId).toBe(store.layouts[0]?.id ?? null);
  });

  it("a corrupt v4 record degrades to the default tree, never a throw", () => {
    const storage = memoryStorage();
    storage.setItem(PANE_TREE_STORAGE_KEY, JSON.stringify({ version: 4, current: { root: 42 }, layouts: "no" }));
    const store = readPaneTreeStore(storage);
    expect(store.current).toBe(DEFAULT_PANE_TREE);
    expect(store.layouts).toEqual([]);
  });
});

describe("write keeps BOTH versions honest (V385)", () => {
  it("a flat-expressible tree round-trips v4 AND writes a v3 the old reader accepts", () => {
    const storage = memoryStorage();
    const current = setSplitRatio(DEFAULT_PANE_TREE, "split-columns", 61);
    writePaneTreeStore({ current, currentId: null, layouts: [] }, storage);

    // v4 round-trip by content.
    expect(readPaneTreeStore(storage).current).toEqual(current);
    // The v3 projection is a real v3 store the OLD code path reads back faithfully.
    const flat = readLayoutStore(storage);
    expect(flat.current.columns).toEqual([61, 39]);
    expect(flat.current.zones).toEqual(DEFAULT_SHELL_LAYOUT.zones);
    expect(storage.map.get(LAYOUT_STORAGE_KEY)).toContain(`"version":${LAYOUT_STORE_VERSION}`);
  });

  it("CLEARS the v3 record the moment the tree stops being flat-expressible", () => {
    const storage = memoryStorage();
    writePaneTreeStore({ current: DEFAULT_PANE_TREE, currentId: null, layouts: [] }, storage);
    expect(storage.map.has(LAYOUT_STORAGE_KEY)).toBe(true);

    const split = splitLeaf(DEFAULT_PANE_TREE, "leaf-center", "row");
    writePaneTreeStore({ current: split, currentId: null, layouts: [] }, storage);
    // V385: removed, not left stale — an old build now falls back to a default it can
    // SEE instead of silently restoring the arrangement the user left behind.
    expect(storage.map.has(LAYOUT_STORAGE_KEY)).toBe(false);
    // The tree itself is intact in v4.
    expect(readPaneTreeStore(storage).current).toEqual(split);
  });

  it("projects the faithful named layouts and simply omits the tree-only ones", () => {
    const storage = memoryStorage();
    const treeOnly = addTab(DEFAULT_PANE_TREE, "leaf-right", "viewer");
    writePaneTreeStore(
      {
        current: DEFAULT_PANE_TREE,
        currentId: null,
        layouts: [
          { id: "layout-a", name: "flat rig", layout: DEFAULT_PANE_TREE },
          { id: "layout-b", name: "twin viewers", layout: treeOnly },
        ],
      },
      storage,
    );
    expect(readLayoutStore(storage).layouts.map((entry) => entry.name)).toEqual(["flat rig"]);
    // v4 keeps both, verbatim.
    expect(readPaneTreeStore(storage).layouts.map((entry) => entry.name)).toEqual([
      "flat rig",
      "twin viewers",
    ]);
  });

  it("upgrades a v2 legacy entry through the whole chain", () => {
    const storage = memoryStorage();
    // v2's real shape: THREE columns (left, centre, right) and a single right zone.
    storage.setItem(
      LEGACY_LAYOUT_STORAGE_KEY,
      JSON.stringify({
        rows: [72, 28],
        columns: [20, 45, 35],
        zones: {
          left: ["library", "components"],
          center: ["graph"],
          right: ["inspector", "viewer"],
          bottom: ["shader", "problems", "performance", "examples", "agent"],
        },
        active: { left: "library", center: "graph", right: "viewer", bottom: "shader" },
        floating: [],
      }),
    );
    const store = readPaneTreeStore(storage);
    // The v2 migration's own ruling (twice owner-reported): the DEFAULT becomes
    // current, and the customised v2 arrangement survives as a NAMED layout — its
    // left+centre columns fused into the work column, 65/35.
    expect(store.current).toEqual(DEFAULT_PANE_TREE);
    const saved = store.layouts.find((entry) => entry.name === "Saved layout");
    expect((saved?.layout.root as { ratio: number } | undefined)?.ratio).toBe(65);
  });
});

/**
 * T466's second half (§V437). The rule "your migrated arrangement is KEPT but not
 * SELECTED" shipped inside the v2 migration, and a migration runs once — so every
 * profile that had already upgraded kept the old rule's selection forever, which is
 * every profile that had actually been using the app. Measured, not assumed: a v4 record
 * pinned to `user:saved-layout` renders the pre-T426 shell (inspector and viewer tabbed
 * in one right column) while the layout menu offers "Default" as something to go and
 * find.
 *
 * The fixture is the PRE-T426 arrangement, not a cosmetic tweak of the default: a
 * fixture equal to the default cannot tell "the repair ran" from "nothing happened"
 * (§V461). Every assertion below flips if `unpinMigratedSelection` is removed.
 */
describe("T466 — a profile parked on the migration's own row is unpinned, once", () => {
  /** v2's shell as the migration reshapes it: one right column, lower section closed. */
  const PRE_T426_TREE = treeFromShellLayout({
    ...DEFAULT_SHELL_LAYOUT,
    rightRows: [100, 0],
    zones: { ...DEFAULT_SHELL_LAYOUT.zones, right: ["inspector", "viewer"], rightBottom: [] },
    active: { ...DEFAULT_SHELL_LAYOUT.active, right: "inspector", rightBottom: null },
  });

  const MIGRATED_ROW = { id: "user:saved-layout", name: "Saved layout", layout: PRE_T426_TREE };

  function pinnedV4(): LayoutStorage & { readonly map: Map<string, string> } {
    const storage = memoryStorage();
    storage.setItem(
      LEGACY_PANE_TREE_STORAGE_KEY,
      JSON.stringify({
        version: 4,
        current: PRE_T426_TREE,
        currentId: MIGRATED_ROW.id,
        layouts: [MIGRATED_ROW],
      }),
    );
    return storage;
  }

  it("opens on the DEFAULT arrangement, not the migrated one", () => {
    const store = readPaneTreeStore(pinnedV4());
    expect(store.currentId).toBe(DEFAULT_LAYOUT_ID);
    // The property the owner actually reported: viewer over inspector, in a sidebar
    // split in two. Asserted on the RENDERED arrangement, because a selection that
    // says "Default" over a Classic tree is the exact lie this repair exists to end.
    const flat = shellLayoutFromTree(store.current);
    expect(flat?.zones.right).toEqual(["viewer"]);
    expect(flat?.zones.rightBottom).toEqual(["inspector"]);
    expect(flat?.rightRows).toEqual(DEFAULT_SHELL_LAYOUT.rightRows);
  });

  it("KEEPS their arrangement as a row — nothing is seized, it is one click away", () => {
    const store = readPaneTreeStore(pinnedV4());
    expect(store.layouts.map((entry) => entry.name)).toEqual(["Saved layout"]);
    expect(store.layouts[0]?.layout).toEqual(PRE_T426_TREE);
    // And restoring it gives back exactly what they had.
    expect(applyNamedPaneTree(store, "user:saved-layout").current).toEqual(PRE_T426_TREE);
  });

  it("fires ONCE: re-selecting the saved layout survives the next read (V18)", () => {
    const storage = pinnedV4();
    const reselected = applyNamedPaneTree(readPaneTreeStore(storage), MIGRATED_ROW.id);
    writePaneTreeStore(reselected, storage);

    const store = readPaneTreeStore(storage);
    expect(store.currentId).toBe(MIGRATED_ROW.id);
    expect(store.current).toEqual(PRE_T426_TREE);
    // V385: the v4 record is GONE rather than left to re-trigger the repair, or to
    // restore an arrangement a downgraded build would read as current.
    expect(storage.map.has(LEGACY_PANE_TREE_STORAGE_KEY)).toBe(false);
  });

  it("leaves a layout the USER named alone — only the minted id is unpinned", () => {
    const storage = memoryStorage();
    const mine = { id: "user:stage-rig", name: "stage rig", layout: PRE_T426_TREE };
    storage.setItem(
      LEGACY_PANE_TREE_STORAGE_KEY,
      JSON.stringify({ version: 4, current: PRE_T426_TREE, currentId: mine.id, layouts: [mine] }),
    );
    const store = readPaneTreeStore(storage);
    expect(store.currentId).toBe(mine.id);
    expect(store.current).toEqual(PRE_T426_TREE);
  });

  it("reaches a profile that never got as far as v4, through the v3 chain", () => {
    const storage = memoryStorage();
    const flat = {
      ...DEFAULT_SHELL_LAYOUT,
      rightRows: [100, 0] as const,
      zones: { ...DEFAULT_SHELL_LAYOUT.zones, right: ["inspector", "viewer"], rightBottom: [] },
      active: { ...DEFAULT_SHELL_LAYOUT.active, right: "inspector" as const, rightBottom: null },
    };
    storage.setItem(
      LAYOUT_STORAGE_KEY,
      JSON.stringify({
        version: LAYOUT_STORE_VERSION,
        current: flat,
        currentId: "user:saved-layout",
        layouts: [{ id: "user:saved-layout", name: "Saved layout", layout: flat }],
      }),
    );
    const store = readPaneTreeStore(storage);
    expect(store.currentId).toBe(DEFAULT_LAYOUT_ID);
    expect(shellLayoutFromTree(store.current)?.zones.rightBottom).toEqual(["inspector"]);
    expect(store.layouts.map((entry) => entry.name)).toEqual(["Saved layout"]);
  });
});
