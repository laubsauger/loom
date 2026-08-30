import { describe, expect, it } from "vitest";

import {
  DEFAULT_PANE_TREE,
  addTab,
  allTabs,
  assignRole,
  closeLeaf,
  closeTab,
  dockTab,
  findLeaf,
  findTab,
  floatTab,
  homeLeafFor,
  leavesOf,
  moveTab,
  repairPaneTree,
  restoreRole,
  selectTab,
  setSplitRatio,
  shellLayoutFromTree,
  splitLeaf,
  treeFromShellLayout,
} from "./pane-tree.ts";
import type { PaneTreeLayout } from "./pane-tree.ts";
import { DEFAULT_SHELL_LAYOUT } from "./layout-storage.ts";

/**
 * The pane TREE (T404, V340): identity split from role. This gate is front-loaded on
 * the orchestrator's ruling — the migration is where a mistake costs a user their
 * arrangement — so the two directions are pinned by CONTENT, the V385 clear trigger is
 * pinned by NULL, and the whole point of the model (a second viewer is representable)
 * is asserted outright.
 */

describe("v3 → tree migration reproduces the flat arrangement (T404)", () => {
  it("builds the canonical five-zone skeleton with the flat ratios", () => {
    const tree = treeFromShellLayout(DEFAULT_SHELL_LAYOUT);
    const leaves = leavesOf(tree.root);
    expect(leaves.map((leaf) => leaf.id)).toEqual([
      "leaf-left",
      "leaf-center",
      "leaf-bottom",
      "leaf-right",
      "leaf-rightBottom",
    ]);
    // One minted tab per zone entry, in zone order, roles preserved.
    expect(findLeaf(tree, "leaf-left")?.tabs.map((tab) => tab.role)).toEqual(["library", "components"]);
    expect(findLeaf(tree, "leaf-bottom")?.tabs.map((tab) => tab.role)).toEqual([
      "shader",
      "problems",
      "performance",
      "examples",
      "agent",
    ]);
    // The active TAB carries the active ROLE of its zone.
    const left = findLeaf(tree, "leaf-left");
    expect(left?.tabs.find((tab) => tab.key === left.active)?.role).toBe("library");
    // Every key is unique — identity is minted, never the role alone.
    const keys = allTabs(tree).map((tab) => tab.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("round-trips the stock layout through the projection by content", () => {
    // Content equality, not entry-exists (the layout track's own warning).
    expect(shellLayoutFromTree(treeFromShellLayout(DEFAULT_SHELL_LAYOUT))).toEqual(DEFAULT_SHELL_LAYOUT);
  });
});

describe("the projection goes NULL the moment the tree stops being flat (V385)", () => {
  it("splitting any leaf makes the tree unprojectable", () => {
    const split = splitLeaf(DEFAULT_PANE_TREE, "leaf-center", "row");
    expect(shellLayoutFromTree(split)).toBeNull();
  });

  it("a second tab of the SAME role makes the tree unprojectable", () => {
    const doubled = addTab(DEFAULT_PANE_TREE, "leaf-right", "viewer");
    expect(shellLayoutFromTree(doubled)).toBeNull();
  });

  it("a second tab of a NEW role stays projectable — v3 can say that much", () => {
    // The flat model tabs zones already; only structure and duplicates exceed it.
    const moved = moveTab(
      DEFAULT_PANE_TREE,
      allTabs(DEFAULT_PANE_TREE).find((tab) => tab.role === "inspector")!.key,
      "leaf-right",
    );
    const projected = shellLayoutFromTree(moved);
    expect(projected?.zones.right).toEqual(["viewer", "inspector"]);
    expect(projected?.zones.rightBottom).toEqual([]);
  });
});

describe("identity survives role change (V340, applied twice)", () => {
  it("assignRole keeps the key, the position and the active state", () => {
    const tree = DEFAULT_PANE_TREE;
    const viewer = allTabs(tree).find((tab) => tab.role === "viewer")!;
    const changed = assignRole(tree, viewer.key, "problems");
    const after = findTab(changed, viewer.key);
    expect(after?.role).toBe("problems");
    // Same leaf, same slot, still the active tab — the pane did not move.
    const leaf = leavesOf(changed.root).find((entry) => entry.tabs.some((tab) => tab.key === viewer.key));
    expect(leaf?.id).toBe("leaf-right");
    expect(leaf?.active).toBe(viewer.key);
  });
});

describe("two viewers are REPRESENTABLE — the point of the model (T405)", () => {
  it("mints distinct keys for two tabs of one role, enumerable together", () => {
    const doubled = addTab(DEFAULT_PANE_TREE, "leaf-left", "viewer");
    const viewers = allTabs(doubled).filter((tab) => tab.role === "viewer");
    expect(viewers).toHaveLength(2);
    expect(viewers[0]!.key).not.toBe(viewers[1]!.key);
  });
});

describe("the split/close algebra", () => {
  it("splitLeaf keeps the tabs on the FIRST side and opens an EMPTY leaf", () => {
    const split = splitLeaf(DEFAULT_PANE_TREE, "leaf-center", "column");
    const leaves = leavesOf(split.root);
    const center = leaves.find((leaf) => leaf.id === "leaf-center");
    expect(center?.tabs.map((tab) => tab.role)).toEqual(["graph"]);
    // The fresh leaf is EMPTY so the role picker renders and the user says what it
    // shows (T406) — never a guessed duplicate.
    const fresh = leaves.find((leaf) => leaf.tabs.length === 0);
    expect(fresh).toBeDefined();
    expect(fresh?.active).toBeNull();
    // Splitting an unknown leaf is a no-op, not a throw.
    expect(splitLeaf(DEFAULT_PANE_TREE, "leaf-ghost", "row")).toBe(DEFAULT_PANE_TREE);
  });

  it("setSplitRatio clamps to 5..95 so no pane can vanish", () => {
    const wide = setSplitRatio(DEFAULT_PANE_TREE, "split-columns", 99.5);
    expect((wide.root as { ratio: number }).ratio).toBe(95);
    const thin = setSplitRatio(DEFAULT_PANE_TREE, "split-columns", -3);
    expect((thin.root as { ratio: number }).ratio).toBe(5);
  });

  it("closeTab removes the tab, hands active to a neighbour, and keeps the emptied leaf", () => {
    const tree = DEFAULT_PANE_TREE;
    const left = findLeaf(tree, "leaf-left")!;
    const [library, components] = left.tabs;
    const closed = closeTab(tree, library!.key);
    const after = findLeaf(closed, "leaf-left")!;
    expect(after.tabs.map((tab) => tab.key)).toEqual([components!.key]);
    expect(after.active).toBe(components!.key);
    // Empty the leaf entirely: it STAYS — closing the leaf is a separate, explicit act.
    const emptied = closeTab(closed, components!.key);
    expect(findLeaf(emptied, "leaf-left")?.tabs).toEqual([]);
    expect(findLeaf(emptied, "leaf-left")?.active).toBeNull();
  });

  it("closeLeaf collapses its split and the sibling takes the whole area", () => {
    const closed = closeLeaf(DEFAULT_PANE_TREE, "leaf-right");
    const leaves = leavesOf(closed.root);
    expect(leaves.some((leaf) => leaf.id === "leaf-right")).toBe(false);
    // The sibling (rightBottom) absorbed the right column; everything else intact.
    expect(leaves.some((leaf) => leaf.id === "leaf-rightBottom")).toBe(true);
    expect(leaves).toHaveLength(4);
  });

  it("the LAST leaf never closes — the shell always has somewhere to stand", () => {
    let tree: PaneTreeLayout = DEFAULT_PANE_TREE;
    for (const id of ["leaf-left", "leaf-bottom", "leaf-right", "leaf-rightBottom"]) {
      tree = closeLeaf(tree, id);
    }
    expect(leavesOf(tree.root).map((leaf) => leaf.id)).toEqual(["leaf-center"]);
    expect(closeLeaf(tree, "leaf-center")).toBe(tree);
  });

  it("moveTab lands at the given index and becomes the target's active tab", () => {
    const tree = DEFAULT_PANE_TREE;
    const inspector = allTabs(tree).find((tab) => tab.role === "inspector")!;
    const moved = moveTab(tree, inspector.key, "leaf-bottom", 1);
    const bottom = findLeaf(moved, "leaf-bottom")!;
    expect(bottom.tabs[1]?.key).toBe(inspector.key);
    expect(bottom.active).toBe(inspector.key);
    expect(findLeaf(moved, "leaf-rightBottom")?.tabs).toEqual([]);
    // A move to nowhere leaves the layout untouched — never a dropped tab.
    expect(moveTab(tree, inspector.key, "leaf-ghost")).toBe(tree);
  });

  it("selectTab activates only a tab the leaf actually holds", () => {
    const tree = DEFAULT_PANE_TREE;
    const left = findLeaf(tree, "leaf-left")!;
    const components = left.tabs[1]!;
    const selected = selectTab(tree, "leaf-left", components.key);
    expect(findLeaf(selected, "leaf-left")?.active).toBe(components.key);
    const viewer = allTabs(tree).find((tab) => tab.role === "viewer")!;
    expect(findLeaf(selectTab(tree, "leaf-left", viewer.key), "leaf-left")?.active).toBe(left.active);
  });
});

describe("floating (§V97) and docking home", () => {
  it("floatTab moves the tab out of its leaf; dockTab returns it to a leaf of its role", () => {
    const tree = DEFAULT_PANE_TREE;
    const viewer = allTabs(tree).find((tab) => tab.role === "viewer")!;
    const floated = floatTab(tree, viewer.key);
    expect(floated.floating.map((tab) => tab.key)).toEqual([viewer.key]);
    expect(findLeaf(floated, "leaf-right")?.tabs).toEqual([]);
    // Docking prefers a leaf already holding the role; here none does, so the tab
    // returns to the FIRST leaf rather than vanishing.
    const docked = dockTab(floated, viewer.key);
    expect(docked.floating).toEqual([]);
    expect(findTab(docked, viewer.key)).toBeDefined();
    // Floating twice is a no-op; docking a non-floating key is a no-op.
    expect(floatTab(floated, viewer.key)).toBe(floated);
    expect(dockTab(tree, viewer.key)).toBe(tree);
  });

  it("homeLeafFor answers by ROLE — the first leaf carrying it, else the first leaf", () => {
    expect(homeLeafFor(DEFAULT_PANE_TREE, "graph")).toBe("leaf-center");
    const noGraph = closeTab(
      DEFAULT_PANE_TREE,
      allTabs(DEFAULT_PANE_TREE).find((tab) => tab.role === "graph")!.key,
    );
    expect(homeLeafFor(noGraph, "graph")).toBe("leaf-left");
  });
});

describe("repair degrades to the default, never a throw (V385's cousin)", () => {
  it("rejects corrupt shapes wholesale", () => {
    for (const raw of [null, 42, "layout", {}, { root: { kind: "leaf" } }, { root: null, floating: [] }]) {
      expect(repairPaneTree(raw)).toBe(DEFAULT_PANE_TREE);
    }
  });

  it("rejects a duplicate KEY — two panes with one identity is corruption", () => {
    const twin: PaneTreeLayout = {
      root: {
        kind: "leaf",
        id: "leaf-a",
        tabs: [
          { key: "viewer-1", role: "viewer" },
          { key: "viewer-1", role: "graph" },
        ],
        active: "viewer-1",
      },
      floating: [],
      nextKey: 2,
    };
    expect(repairPaneTree(twin)).toBe(DEFAULT_PANE_TREE);
  });

  it("accepts a valid tree and repairs a missing mint counter past every key", () => {
    const valid = addTab(splitLeaf(DEFAULT_PANE_TREE, "leaf-center", "row"), "leaf-left", "viewer");
    const repaired = repairPaneTree({ root: valid.root, floating: valid.floating });
    expect(repaired.root).toBe(valid.root);
    expect(repaired.nextKey).toBeGreaterThan(0);
    // Minting from the repaired counter must not collide with any existing key.
    const minted = addTab(repaired, "leaf-left", "graph");
    const keys = allTabs(minted).map((tab) => tab.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("a closed role comes BACK (T486, V423)", () => {
  it("a closed tab restores into the leaf it left", () => {
    const tree = DEFAULT_PANE_TREE;
    const shader = allTabs(tree).find((tab) => tab.role === "shader")!;
    const closed = closeTab(tree, shader.key);
    expect(allTabs(closed).some((tab) => tab.role === "shader")).toBe(false);

    const restored = restoreRole(closed, "shader");
    const bottom = findLeaf(restored, "leaf-bottom")!;
    expect(bottom.tabs.some((tab) => tab.role === "shader")).toBe(true);
    // The restored pane is ACTIVE — the user asked for it; showing it buried would
    // look like the restore did nothing.
    expect(bottom.tabs.find((tab) => tab.key === bottom.active)?.role).toBe("shader");
  });

  it("the owner's exact trap: close the bottom AREA, restore recreates the bottom bar", () => {
    const tree = DEFAULT_PANE_TREE;
    const closed = closeLeaf(tree, "leaf-bottom");
    expect(findLeaf(closed, "leaf-bottom")).toBeUndefined();

    const restored = restoreRole(closed, "shader");
    // Not a tab wedged into a surviving dock: a fresh BOTTOM area, below the work
    // area, at the ratio the closed split held.
    const leaves = leavesOf(restored.root);
    expect(leaves.length).toBe(5);
    const fresh = leaves.find((leaf) => leaf.tabs.some((tab) => tab.role === "shader"))!;
    expect(fresh).toBeDefined();
    const parent = ((): { direction: string; ratio: number; secondIsFresh: boolean } | null => {
      let found: { direction: string; ratio: number; secondIsFresh: boolean } | null = null;
      const walk = (node: (typeof restored)["root"]): void => {
        if (node.kind === "leaf") return;
        if (node.second.kind === "leaf" && node.second.id === fresh.id) {
          found = { direction: node.direction, ratio: node.ratio, secondIsFresh: true };
          return;
        }
        if (node.first.kind === "leaf" && node.first.id === fresh.id) {
          found = { direction: node.direction, ratio: node.ratio, secondIsFresh: false };
          return;
        }
        walk(node.first);
        walk(node.second);
      };
      walk(restored.root);
      return found;
    })();
    // A COLUMN split with the new area on the second (bottom) side, at the old 72/28.
    expect(parent?.direction).toBe("column");
    expect(parent?.secondIsFresh).toBe(true);
    expect(parent?.ratio).toBe(72);
  });

  it("a stale recipe degrades to the first leaf — restored somewhere beats nowhere", () => {
    const tree = DEFAULT_PANE_TREE;
    const viewer = allTabs(tree).find((tab) => tab.role === "viewer")!;
    let mutated = closeTab(tree, viewer.key);
    // The remembered leaf then closes too, invalidating the hint.
    mutated = closeLeaf(mutated, "leaf-right");
    const restored = restoreRole(mutated, "viewer");
    expect(allTabs(restored).some((tab) => tab.role === "viewer")).toBe(true);
  });

  it("restoring a PRESENT role is a no-op, and repair keeps the hints", () => {
    expect(restoreRole(DEFAULT_PANE_TREE, "graph")).toBe(DEFAULT_PANE_TREE);
    const closed = closeLeaf(DEFAULT_PANE_TREE, "leaf-bottom");
    const repaired = repairPaneTree(JSON.parse(JSON.stringify(closed)));
    expect(repaired.homes?.shader?.kind).toBe("split");
  });
});
