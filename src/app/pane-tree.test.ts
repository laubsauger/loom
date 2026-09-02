import { describe, expect, it } from "vitest";

import {
  DEFAULT_PANE_TREE,
  addTab,
  moveTabToEdge,
  spawnEdge,
  spawnableEdges,
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
  baselinePlacement,
  baselineRegionNode,
  restoreBaselineRegion,
  repairPaneTree,
  restoreRole,
  revealRole,
  selectTab,
  setSplitRatio,
  shellLayoutFromTree,
  splitLeaf,
  treeFromShellLayout,
} from "./pane-tree.ts";
import type { LayoutNode, PaneKey, PaneTreeLayout } from "./pane-tree.ts";
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

/**
 * T927/T932 — the default arrangement itself, which is now a value in this module rather
 * than a derivation of the flat one. Every assertion here is a thing the owner asked
 * for, so a change that quietly walks one back is a failure and not a diff.
 */
describe("the T932 default: the libraries live in the bottom region's own column", () => {
  const bottomRegion = () => {
    const root = DEFAULT_PANE_TREE.root;
    if (root.kind !== "split") throw new Error("root is a leaf");
    const work = root.first;
    if (work.kind !== "split") throw new Error("work area is a leaf");
    return work.second;
  };

  it("has NO left dock — the graph is the whole work area above the bottom", () => {
    const root = DEFAULT_PANE_TREE.root as Extract<typeof DEFAULT_PANE_TREE.root, { kind: "split" }>;
    const work = root.first as Extract<typeof root, { kind: "split" }>;
    expect(work.first).toEqual(
      expect.objectContaining({ kind: "leaf", id: "leaf-center", tabs: [{ key: "graph-1", role: "graph" }] }),
    );
    // Nothing anywhere is the old left dock.
    expect(leavesOf(DEFAULT_PANE_TREE.root).map((leaf) => leaf.id)).not.toContain("leaf-left");
  });

  it("the graph is WIDER than it was: it takes the 23% the left dock held", () => {
    // Measured, not asserted by shape. Widths are fractions of the window.
    const widthOf = (layout: PaneTreeLayout, role: string): number => {
      let width = 0;
      const walk = (node: PaneTreeLayout["root"], w: number): void => {
        if (node.kind === "leaf") {
          if (node.tabs.some((tab) => tab.role === role)) width = w;
          return;
        }
        const share = node.ratio / 100;
        const first = node.direction === "row" ? w * share : w;
        const second = node.direction === "row" ? w * (1 - share) : w;
        walk(node.first, first);
        walk(node.second, second);
      };
      walk(layout.root, 1);
      return width;
    };
    const before = widthOf(treeFromShellLayout(DEFAULT_SHELL_LAYOUT), "graph");
    const after = widthOf(DEFAULT_PANE_TREE, "graph");
    expect(after).toBeGreaterThan(before);
    expect(after).toBeCloseTo(0.74, 5); // the whole work area, where it held 77% of it
  });

  it("the bottom region is TWO COLUMNS at 50/50 — the tab dock, then the libraries", () => {
    const bottom = bottomRegion();
    expect(bottom.kind).toBe("split");
    const region = bottom as Extract<typeof bottom, { kind: "split" }>;
    expect(region.direction).toBe("row"); // two columns
    expect(region.ratio).toBe(50);
    expect((region.first as { id: string }).id).toBe("leaf-bottom");
    expect((region.second as { id: string }).id).toBe("leaf-libraries");
  });

  it("library and components share ONE leaf, so each gets the FULL column height (T932)", () => {
    /*
     * T927 made these two SEPARATE LEAVES, so both would be visible at once — and this
     * gate asserted exactly that, with a comment calling a shared leaf the version that
     * "moves them without buying anything". Measurement reversed it, and the reversal is
     * the thing worth learning here, not the shape:
     *
     *   in the browser, stacked in a 34%-tall bottom bar, the node library rendered FOUR
     *   rows under its search box. As a tab of one leaf it gets the whole column — about
     *   double — because the split was spending half the height on whichever library the
     *   user was not reading at that moment.
     *
     * So the cost is chosen, not overlooked: only one of the pair is on screen at a
     * time. For a SCAN-AND-DRAG surface, rows beat simultaneity, and the owner picked
     * that having seen both. A future change back to two leaves is not wrong on its face
     * — but it must come with a measurement of the rows it costs, or it is T927 again.
     */
    const leaves = leavesOf(DEFAULT_PANE_TREE.root);
    const libraryLeaf = leaves.find((leaf) => leaf.tabs.some((tab) => tab.role === "library"))!;
    const componentsLeaf = leaves.find((leaf) => leaf.tabs.some((tab) => tab.role === "components"))!;
    expect(libraryLeaf.id).toBe("leaf-libraries");
    expect(componentsLeaf.id).toBe(libraryLeaf.id);
    // Two tabs, and the node library is the one that opens — it is the surface you scan.
    expect(libraryLeaf.tabs.map((tab) => tab.role)).toEqual(["library", "components"]);
    expect(libraryLeaf.tabs.find((tab) => tab.key === libraryLeaf.active)?.role).toBe("library");
    // §V93: the EXAMPLE library is not welcome in this leaf — OPEN replaces the document.
    expect(libraryLeaf.tabs.some((tab) => tab.role === "examples")).toBe(false);
  });

  it("the library column is HALF the bottom, not a margin beside the tab dock (T932)", () => {
    // The dock holds an editor and the libraries are a browsing surface; the owner asked
    // for 50/50 between them, and a ratio drifting back to 74/26 is a silent regression.
    const region = bottomRegion() as Extract<ReturnType<typeof bottomRegion>, { kind: "split" }>;
    expect(region.ratio).toBe(50);
  });

  it("every key is unique and the mint counter clears them all", () => {
    const keys = allTabs(DEFAULT_PANE_TREE).map((tab) => tab.key);
    expect(new Set(keys).size).toBe(keys.length);
    // A hand-authored tree can get this wrong in a way a derived one could not.
    const minted = addTab(DEFAULT_PANE_TREE, "leaf-center", "viewer");
    const mintedKeys = allTabs(minted).map((tab) => tab.key);
    expect(new Set(mintedKeys).size).toBe(mintedKeys.length);
  });

  it("still holds all ten roles — moving two panes must not lose one", () => {
    expect(new Set(allTabs(DEFAULT_PANE_TREE).map((tab) => tab.role)).size).toBe(10);
  });
});

describe("the projection goes NULL the moment the tree stops being flat (V385)", () => {
  /*
   * T927: these gates run on the FLAT-DERIVED tree, not on `DEFAULT_PANE_TREE`. The
   * default is now authored as a tree and is structural by construction — its bottom
   * region is a split — so it projects to null before any of these cases is applied,
   * and a gate asserting null against it could not fail. The five-zone skeleton is what
   * "still flat-expressible" MEANS, so it is what the trigger is measured against.
   */
  const flat = treeFromShellLayout(DEFAULT_SHELL_LAYOUT);

  it("splitting any leaf makes the tree unprojectable", () => {
    // The precondition is the whole point: it is projectable UNTIL the split.
    expect(shellLayoutFromTree(flat)).not.toBeNull();
    const split = splitLeaf(flat, "leaf-center", "row");
    expect(shellLayoutFromTree(split)).toBeNull();
  });

  it("a second tab of the SAME role makes the tree unprojectable", () => {
    const doubled = addTab(flat, "leaf-right", "viewer");
    expect(shellLayoutFromTree(doubled)).toBeNull();
  });

  it("a second tab of a NEW role stays projectable — v3 can say that much", () => {
    /*
     * The flat model tabs zones already; only structure and duplicates exceed it. The
     * moved role comes from the BOTTOM dock, which has five tabs and keeps four: since
     * T931 a move that EMPTIES its source leaf collapses that leaf, which is a structural
     * change and would make this assert the wrong thing for the wrong reason.
     */
    const moved = moveTab(flat, allTabs(flat).find((tab) => tab.role === "problems")!.key, "leaf-right");
    const projected = shellLayoutFromTree(moved);
    expect(projected?.zones.right).toEqual(["viewer", "problems"]);
    expect(projected?.zones.bottom).toEqual(["shader", "performance", "examples", "agent"]);
  });

  it("the T927 default is structural, so v3 cannot hold it at all", () => {
    // Not incidental: the bottom region is two columns and the second is split
    // vertically, which the five fixed zones have no spelling for. V385 therefore
    // CLEARS the v3 record for a fresh profile rather than writing a lie into it.
    expect(shellLayoutFromTree(DEFAULT_PANE_TREE)).toBeNull();
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
    const doubled = addTab(DEFAULT_PANE_TREE, "leaf-center", "viewer");
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
    // T927: the multi-tab leaf of the default is the bottom dock — the left dock this
    // used to read is gone, and its two roles are leaves of their own now.
    const bottom = findLeaf(tree, "leaf-bottom")!;
    const [shader, problems] = bottom.tabs;
    const closed = closeTab(tree, shader!.key);
    const after = findLeaf(closed, "leaf-bottom")!;
    expect(after.tabs.map((tab) => tab.key)).toEqual(bottom.tabs.slice(1).map((tab) => tab.key));
    expect(after.active).toBe(problems!.key);
    // Empty the leaf entirely: it STAYS — closing the leaf is a separate, explicit act.
    const emptied = after.tabs.reduce((layout, tab) => closeTab(layout, tab.key), closed);
    expect(findLeaf(emptied, "leaf-bottom")?.tabs).toEqual([]);
    expect(findLeaf(emptied, "leaf-bottom")?.active).toBeNull();
  });

  it("closeLeaf collapses its split and the sibling takes the whole area", () => {
    const closed = closeLeaf(DEFAULT_PANE_TREE, "leaf-right");
    const leaves = leavesOf(closed.root);
    expect(leaves.some((leaf) => leaf.id === "leaf-right")).toBe(false);
    // The sibling (rightBottom) absorbed the right column; everything else intact.
    expect(leaves.some((leaf) => leaf.id === "leaf-rightBottom")).toBe(true);
    expect(leaves).toHaveLength(4); // T932: five leaves in the default, one closed
  });

  it("the LAST leaf never closes — the shell always has somewhere to stand", () => {
    let tree: PaneTreeLayout = DEFAULT_PANE_TREE;
    for (const id of ["leaf-bottom", "leaf-libraries", "leaf-right", "leaf-rightBottom"]) {
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
    // A move to nowhere leaves the layout untouched — never a dropped tab.
    expect(moveTab(tree, inspector.key, "leaf-ghost")).toBe(tree);
  });

  /**
   * T931 — the leaf a dragged tab LEAVES. Everything below is one rule with three
   * boundaries, and the rule is not `closeTab`'s: closing a TAB keeps the area (T854,
   * the × must never strand a user in a vanished pane), while MOVING the last tab out
   * takes the area with it, because the pane still exists — it is somewhere else — and
   * nobody asked to keep the hole it left.
   */
  describe("a leaf emptied by a MOVE collapses (T931)", () => {
    it("collapses the source leaf and its split promotes the sibling", () => {
      const tree = DEFAULT_PANE_TREE;
      const inspector = allTabs(tree).find((tab) => tab.role === "inspector")!;
      const moved = moveTab(tree, inspector.key, "leaf-bottom");
      // Gone, not left behind empty — the difference between this and closeTab.
      expect(findLeaf(moved, "leaf-rightBottom")).toBeUndefined();
      // …and the sibling took the whole sidebar rather than half of it.
      const leaves = leavesOf(moved.root).map((leaf) => leaf.id);
      expect(leaves).toContain("leaf-right");
      expect(leaves).toHaveLength(4);
      // The tab itself is intact where it landed. A collapse that ate the pane would be
      // a far worse bug than a leftover leaf, so it is asserted, not assumed.
      expect(findTab(moved, inspector.key)?.role).toBe("inspector");
    });

    it("leaves the source ALONE while any tab remains — including a floated one (§V97)", () => {
      const tree = DEFAULT_PANE_TREE;
      const shader = findLeaf(tree, "leaf-bottom")!.tabs[0]!;
      const moved = moveTab(tree, shader.key, "leaf-center");
      expect(findLeaf(moved, "leaf-bottom")?.tabs.map((tab) => tab.role)).toEqual([
        "problems",
        "performance",
        "examples",
        "agent",
      ]);

      /*
       * The §V97 boundary: since T705(b) a floated tab STAYS in its leaf holding its
       * place, so a leaf whose only remaining tab is floating is NOT empty. Collapsing
       * it would delete the slot its window comes home to while the window is open.
       */
      const viewer = allTabs(tree).find((tab) => tab.role === "viewer")!;
      const twoTabs = addTab(tree, "leaf-right", "problems");
      const extra = findLeaf(twoTabs, "leaf-right")!.tabs.find((tab) => tab.role === "problems")!;
      const floated = floatTab(twoTabs, viewer.key);
      const afterMove = moveTab(floated, extra.key, "leaf-center");
      expect(findLeaf(afterMove, "leaf-right")?.tabs.map((tab) => tab.key)).toEqual([viewer.key]);
    });

    it("never strands a FLOATING pane whose home leaf the collapse took (§V97)", () => {
      /*
       * The fixture is a PRE-T705(b) shape on purpose — a floating tab that is NOT also
       * in its leaf — because that is the only way a home leaf can empty at all. Since
       * T705(b) a floated tab holds its place in its leaf, so a leaf containing one is
       * never empty and this collapse cannot reach it; a layout stored before that
       * change can still be read back, and it is the case that would strand a pane.
       */
      const legacy: PaneTreeLayout = {
        root: {
          kind: "split",
          id: "split-1",
          direction: "row",
          ratio: 50,
          first: { kind: "leaf", id: "leaf-a", tabs: [{ key: "graph-1", role: "graph" }], active: "graph-1" },
          second: { kind: "leaf", id: "leaf-b", tabs: [{ key: "problems-2", role: "problems" }], active: "problems-2" },
        },
        floating: [{ key: "viewer-3", role: "viewer", home: "leaf-b" }],
        nextKey: 4,
      };
      const moved = moveTab(legacy, "problems-2", "leaf-a");
      expect(findLeaf(moved, "leaf-b")).toBeUndefined(); // the home is gone

      // Docking must still land it SOMEWHERE — restored somewhere beats restored nowhere.
      const docked = dockTab(moved, "viewer-3");
      expect(docked.floating).toEqual([]);
      expect(allTabs(docked).some((tab) => tab.key === "viewer-3")).toBe(true);
    });

    it("never collapses the LAST leaf — the shell always has somewhere to stand", () => {
      const solo: PaneTreeLayout = {
        root: {
          kind: "leaf",
          id: "leaf-1",
          tabs: [{ key: "graph-1", role: "graph" }],
          active: "graph-1",
        },
        floating: [],
        nextKey: 2,
      };
      const moved = moveTab(solo, "graph-1", "leaf-1", 0);
      expect(leavesOf(moved.root).map((leaf) => leaf.id)).toEqual(["leaf-1"]);
      expect(findLeaf(moved, "leaf-1")?.tabs.map((tab) => tab.key)).toEqual(["graph-1"]);
    });
  });

  /**
   * T931 — dropping a tab back into its OWN strip is a reorder, and the index the user
   * aimed at counted the tab they are dragging. Off by one here means every drag lands
   * one slot right of the gap the caret was drawn in.
   */
  describe("reordering inside one leaf (T931)", () => {
    it("lands where the caret was, not one past it, when dragging RIGHTWARDS", () => {
      const tree = DEFAULT_PANE_TREE;
      const bottom = findLeaf(tree, "leaf-bottom")!;
      const shader = bottom.tabs[0]!; // shader | problems | performance | examples | agent
      // Aimed at the gap before "examples", which is index 3 in the strip on screen.
      const moved = moveTab(tree, shader.key, "leaf-bottom", 3);
      expect(findLeaf(moved, "leaf-bottom")?.tabs.map((tab) => tab.role)).toEqual([
        "problems",
        "performance",
        "shader",
        "examples",
        "agent",
      ]);
    });

    it("needs no adjustment dragging LEFTWARDS — the shift is only for tabs before it", () => {
      const tree = DEFAULT_PANE_TREE;
      const agent = findLeaf(tree, "leaf-bottom")!.tabs[4]!;
      const moved = moveTab(tree, agent.key, "leaf-bottom", 1);
      expect(findLeaf(moved, "leaf-bottom")?.tabs.map((tab) => tab.role)).toEqual([
        "shader",
        "agent",
        "problems",
        "performance",
        "examples",
      ]);
    });
  });

  it("revealRole fronts the problems tab, restores it when closed, leaves a float alone (T599)", () => {
    const tree = DEFAULT_PANE_TREE;
    const problems = allTabs(tree).find((tab) => tab.role === "problems")!;
    const leafOf = (layout: typeof tree) =>
      leavesOf(layout.root).find((leaf) => leaf.tabs.some((tab) => tab.role === "problems"))!;

    // Hidden behind a sibling tab: reveal makes it the leaf's active tab.
    const shader = leafOf(tree).tabs.find((tab) => tab.role === "shader")!;
    const buried = selectTab(tree, leafOf(tree).id, shader.key);
    const fronted = revealRole(buried, "problems");
    expect(findLeaf(fronted, leafOf(fronted).id)?.active).toBe(problems.key);

    // Closed entirely: reveal restores it AND fronts it — a door onto a closed pane
    // that merely restored-in-the-back would still not show the diagnostics.
    const closed = closeTab(tree, problems.key);
    expect(allTabs(closed).some((tab) => tab.role === "problems")).toBe(false);
    const restored = revealRole(closed, "problems");
    const restoredLeaf = leafOf(restored);
    expect(restoredLeaf.tabs.some((tab) => tab.role === "problems")).toBe(true);
    expect(restoredLeaf.active).toBe(restoredLeaf.tabs.find((tab) => tab.role === "problems")!.key);

    // Floating: already its own window — nothing to change.
    const floated = floatTab(tree, problems.key);
    expect(revealRole(floated, "problems")).toBe(floated);
  });

  it("selectTab activates only a tab the leaf actually holds", () => {
    const tree = DEFAULT_PANE_TREE;
    const bottom = findLeaf(tree, "leaf-bottom")!;
    const problems = bottom.tabs[1]!;
    const selected = selectTab(tree, "leaf-bottom", problems.key);
    expect(findLeaf(selected, "leaf-bottom")?.active).toBe(problems.key);
    const viewer = allTabs(tree).find((tab) => tab.role === "viewer")!;
    expect(findLeaf(selectTab(tree, "leaf-bottom", viewer.key), "leaf-bottom")?.active).toBe(bottom.active);
  });
});

/**
 * T936 — the baseline docks are always listable, and an ABSENT one is recreatable.
 *
 * The owner: "it still only lets us show 3 panes that currently exist instead of always
 * allowing us to bring back or hide any." The gap was structural and had two halves:
 * `leaf-left` is not in the default tree (T927 removed it) AND the left EDGE reads as
 * HELD, because the graph touches it — so the region appeared in neither the toggle list
 * nor T494's spawn list. Two mechanisms, two different meanings of "absent", and a dock
 * that fell between them.
 *
 * T931 is what made it urgent rather than untidy: dragging a leaf's last tab out now
 * collapses that leaf, so a dock can be DESTROYED and the only way back was a full
 * layout reset — which throws away everything else the user arranged.
 */
describe("the baseline docks: always listed, absent ones restorable (T936)", () => {
  const rectOf = (layout: PaneTreeLayout, id: PaneKey) => {
    let found: { x: number; y: number; w: number; h: number } | null = null;
    const walk = (node: LayoutNode, x: number, y: number, w: number, h: number): void => {
      if (node.id === id) found = { x, y, w, h };
      if (node.kind === "leaf") return;
      const share = node.ratio / 100;
      if (node.direction === "row") {
        walk(node.first, x, y, w * share, h);
        walk(node.second, x + w * share, y, w * (1 - share), h);
      } else {
        walk(node.first, x, y, w, h * share);
        walk(node.second, x, y + h * share, w, h * (1 - share));
      }
    };
    walk(layout.root, 0, 0, 1, 1);
    return found as { x: number; y: number; w: number; h: number } | null;
  };

  it("reports the third state: the default has a right and a bottom, and NO left", () => {
    // The exact shape the owner is looking at, and the reason the menu showed three rows.
    expect(baselineRegionNode(DEFAULT_PANE_TREE, "right")).toBe("split-right");
    expect(baselineRegionNode(DEFAULT_PANE_TREE, "bottom")).toBe("leaf-bottom");
    expect(baselineRegionNode(DEFAULT_PANE_TREE, "left")).toBeNull();
    // …and the other mechanism could not have offered it either: the graph touches the
    // left edge, so T494 reads that edge as HELD. Absent from BOTH lists is the bug.
    expect(spawnableEdges(DEFAULT_PANE_TREE)).toEqual([]);
  });

  it("restores the left dock BESIDE THE GRAPH — inside the work area, above the bottom", () => {
    const restored = restoreBaselineRegion(DEFAULT_PANE_TREE, "left");
    expect(baselineRegionNode(restored, "left")).toBe("leaf-left");

    /*
     * Position asserted by MEASUREMENT, because "it is somewhere in the tree" is exactly
     * the bug a naive insertion produces: wrapping the root would put the left dock
     * beside the sidebar and full height, and splitting the first leaf found would drop
     * it inside the bottom bar.
     */
    const dock = rectOf(restored, "leaf-left")!;
    const graph = rectOf(restored, "leaf-center")!;
    const sidebar = rectOf(restored, "split-right")!;
    const bottom = rectOf(restored, "split-bottom")!;
    expect(dock.x).toBeCloseTo(0, 5); // hard against the left edge
    expect(dock.y).toBeCloseTo(graph.y, 5); // level with the graph, not above it
    expect(dock.h).toBeCloseTo(graph.h, 5); // as tall as the graph…
    expect(dock.y + dock.h).toBeLessThan(bottom.y + 1e-6); // …and stopping at the bottom bar
    expect(dock.x + dock.w).toBeLessThan(sidebar.x + 1e-6); // nowhere near the sidebar
    // The stock share of the work area, taken from the skeleton and not written out here.
    expect(dock.w / (graph.w + dock.w)).toBeCloseTo(baselinePlacement("left").ratio / 100, 5);
  });

  it("INSERTS — every other leaf, ratio and tab order is byte-identical", () => {
    /*
     * The constraint that makes this a fix rather than a second bug: a restore that
     * discards the arrangement is the thing it exists to save the user from. Asserted by
     * serialising the whole tree with the new subtree lifted out, so a ratio nudged
     * anywhere or a tab order shuffled anywhere fails this — not just the leaves the
     * insertion happens to touch.
     */
    let custom: PaneTreeLayout = DEFAULT_PANE_TREE;
    custom = setSplitRatio(custom, "split-columns", 61);
    custom = setSplitRatio(custom, "split-bottom", 33);
    const libraries = findLeaf(custom, "leaf-libraries")!;
    custom = moveTab(custom, libraries.tabs[1]!.key, "leaf-bottom", 0);
    custom = addTab(custom, "leaf-rightBottom", "problems");

    const restored = restoreBaselineRegion(custom, "left");

    /** The tree with the freshly inserted split spliced back out. */
    const withoutInsertion = (node: LayoutNode): LayoutNode => {
      if (node.kind === "leaf") return node;
      if (node.first.id === "leaf-left") return withoutInsertion(node.second);
      if (node.second.id === "leaf-left") return withoutInsertion(node.first);
      return { ...node, first: withoutInsertion(node.first), second: withoutInsertion(node.second) };
    };
    expect(JSON.stringify(withoutInsertion(restored.root))).toBe(JSON.stringify(custom.root));
    expect(restored.floating).toEqual(custom.floating);
  });

  it("gives the restored dock an EMPTY leaf — the picker, never a guessed tab (T853)", () => {
    const restored = restoreBaselineRegion(DEFAULT_PANE_TREE, "left");
    const dock = findLeaf(restored, "leaf-left")!;
    // Guessing would make "bring the left dock back" and "put the node library back" the
    // same button, and reopen a pane the user deliberately moved out of it.
    expect(dock.tabs).toEqual([]);
    expect(dock.active).toBeNull();
    // Nothing was taken from anywhere else to fill it.
    expect(allTabs(restored).map((tab) => tab.key).sort()).toEqual(
      allTabs(DEFAULT_PANE_TREE).map((tab) => tab.key).sort(),
    );
  });

  it("restores the sidebar FULL HEIGHT — the T426 property, not a corner", () => {
    const noSidebar = closeLeaf(closeLeaf(DEFAULT_PANE_TREE, "leaf-right"), "leaf-rightBottom");
    expect(baselineRegionNode(noSidebar, "right")).toBeNull();

    const restored = restoreBaselineRegion(noSidebar, "right");
    const sidebar = rectOf(restored, "leaf-right")!;
    // The whole height of the shell: a sidebar wrapped around the centre leaf instead of
    // the root is exactly the pre-T426 shell T426 was written to end.
    expect(sidebar.y).toBeCloseTo(0, 5);
    expect(sidebar.h).toBeCloseTo(1, 5);
    expect(sidebar.x + sidebar.w).toBeCloseTo(1, 5);
  });

  it("restores the bottom bar SHORT OF the sidebar, which wrapping the root would not", () => {
    const noBottom = closeLeaf(closeLeaf(DEFAULT_PANE_TREE, "leaf-bottom"), "leaf-libraries");
    expect(baselineRegionNode(noBottom, "bottom")).toBeNull();

    const restored = restoreBaselineRegion(noBottom, "bottom");
    const bar = rectOf(restored, "leaf-bottom")!;
    const sidebar = rectOf(restored, "split-right")!;
    expect(bar.y + bar.h).toBeCloseTo(1, 5); // on the floor
    expect(bar.x).toBeCloseTo(0, 5);
    // …and it stops where the sidebar starts. `spawnEdge` wraps the ROOT, which would
    // run the bar underneath the full-height sidebar and undo T426.
    expect(bar.x + bar.w).toBeCloseTo(sidebar.x, 5);
    expect(bar.x + bar.w).toBeLessThan(1 - 1e-6);
  });

  it("wraps the WHOLE tree when the region further out is missing too", () => {
    // No sidebar to stop short of: the bottom bar runs the full width, correctly.
    const solo: PaneTreeLayout = {
      root: { kind: "leaf", id: "leaf-center", tabs: [{ key: "graph-1", role: "graph" }], active: "graph-1" },
      floating: [],
      nextKey: 2,
    };
    const restored = restoreBaselineRegion(solo, "bottom");
    const bar = rectOf(restored, "leaf-bottom")!;
    expect(bar.x).toBeCloseTo(0, 5);
    expect(bar.w).toBeCloseTo(1, 5);
  });

  it("is a no-op for a region that is already there — the menu offers hide, not restore", () => {
    expect(restoreBaselineRegion(DEFAULT_PANE_TREE, "bottom")).toBe(DEFAULT_PANE_TREE);
    expect(restoreBaselineRegion(DEFAULT_PANE_TREE, "right")).toBe(DEFAULT_PANE_TREE);
  });

  it("T931's destroyed dock comes back — the one-way door this row closes", () => {
    /*
     * The exact sequence the owner can hit: drag the sidebar's two tabs away one at a
     * time, and the second drag collapses the leaf out of the tree. Before T936 the only
     * route back was a full reset.
     */
    let tree: PaneTreeLayout = DEFAULT_PANE_TREE;
    tree = moveTab(tree, allTabs(tree).find((tab) => tab.role === "viewer")!.key, "leaf-bottom");
    tree = moveTab(tree, allTabs(tree).find((tab) => tab.role === "inspector")!.key, "leaf-bottom");
    expect(baselineRegionNode(tree, "right")).toBeNull();

    const restored = restoreBaselineRegion(tree, "right");
    expect(baselineRegionNode(restored, "right")).toBe("leaf-right");
    // …and the panes the user dragged away stayed where they put them.
    expect(findLeaf(restored, "leaf-bottom")?.tabs.map((tab) => tab.role)).toContain("viewer");
    expect(findLeaf(restored, "leaf-bottom")?.tabs.map((tab) => tab.role)).toContain("inspector");
  });

  it("EDGE_SHARE and the skeleton are ONE answer — T494's spawn agrees with T936's restore", () => {
    /*
     * They did not: `EDGE_SHARE` said the left dock was 22% of the shell where the
     * skeleton says 23%, and T936 would have been a third number. Pinned by comparing
     * the two doors' output rather than the constants, so a future edit to either is
     * caught by the one that did not move.
     */
    const solo: PaneTreeLayout = {
      root: { kind: "leaf", id: "leaf-center", tabs: [{ key: "graph-1", role: "graph" }], active: "graph-1" },
      floating: [],
      nextKey: 2,
    };
    const spawned = spawnEdge(solo, "left").layout;
    const restored = restoreBaselineRegion(solo, "left");
    expect(rectOf(spawned, spawned.root.kind === "split" ? spawned.root.first.id : "")!.w).toBeCloseTo(
      rectOf(restored, "leaf-left")!.w,
      5,
    );
  });
});

/**
 * T494 — creating an area that does not exist. Both owner reports were this gap through
 * two doors (a menu row, an edge drop), so both doors run ONE operation and these gates
 * pin the operation plus the offer rule.
 */
describe("edge areas spawn back (T494)", () => {
  it("the default layout holds all three edges — nothing to offer (V423)", () => {
    expect(spawnableEdges(DEFAULT_PANE_TREE)).toEqual([]);
  });

  it("a single center leaf holds nothing: touching an edge AND its opposite anchors nowhere", () => {
    const solo: PaneTreeLayout = {
      root: { kind: "leaf", id: "leaf-1", tabs: [{ key: "graph-1", role: "graph" }], active: "graph-1" },
      floating: [],
      nextKey: 2,
    };
    expect(spawnableEdges(solo)).toEqual(["left", "right", "bottom"]);
  });

  it("spawning an edge wraps the ROOT: a fresh empty leaf on that side, the old tree intact", () => {
    const solo: PaneTreeLayout = {
      root: { kind: "leaf", id: "leaf-1", tabs: [{ key: "graph-1", role: "graph" }], active: "graph-1" },
      floating: [],
      nextKey: 2,
    };
    const { layout, leafId } = spawnEdge(solo, "bottom");
    const root = layout.root;
    if (root.kind !== "split") throw new Error("root did not split");
    expect(root.direction).toBe("column");
    expect(root.second.kind).toBe("leaf");
    expect((root.second as { id: string }).id).toBe(leafId);
    expect((root.second as { tabs: readonly unknown[] }).tabs).toEqual([]);
    expect(root.first).toBe(solo.root);
    // The new area is a dock, not a half — and the edge is now held.
    expect(root.ratio).toBeGreaterThan(50);
    expect(spawnableEdges(layout)).toEqual(["left", "right"]);
  });

  it("left spawns FIRST at a dock share; right spawns SECOND", () => {
    const solo: PaneTreeLayout = {
      root: { kind: "leaf", id: "leaf-1", tabs: [], active: null },
      floating: [],
      nextKey: 2,
    };
    const left = spawnEdge(solo, "left");
    if (left.layout.root.kind !== "split") throw new Error("no split");
    expect(left.layout.root.direction).toBe("row");
    expect((left.layout.root.first as { id: string }).id).toBe(left.leafId);
    expect(left.layout.root.ratio).toBeLessThan(50);
    const right = spawnEdge(solo, "right");
    if (right.layout.root.kind !== "split") throw new Error("no split");
    expect((right.layout.root.second as { id: string }).id).toBe(right.leafId);
    expect(right.layout.root.ratio).toBeGreaterThan(50);
  });

  it("door two IS door one: dragging a tab to an edge spawns the same area and drops in", () => {
    const two: PaneTreeLayout = {
      root: {
        kind: "split", id: "split-1", direction: "row", ratio: 50,
        first: { kind: "leaf", id: "leaf-1", tabs: [{ key: "graph-1", role: "graph" }, { key: "viewer-2", role: "viewer" }], active: "graph-1" },
        second: { kind: "leaf", id: "leaf-2", tabs: [{ key: "inspector-3", role: "inspector" }], active: "inspector-3" },
      },
      floating: [],
      nextKey: 4,
    };
    const moved = moveTabToEdge(two, "viewer-2", "bottom");
    const root = moved.root;
    if (root.kind !== "split" || root.direction !== "column") throw new Error("no bottom area");
    const fresh = root.second;
    if (fresh.kind !== "leaf") throw new Error("bottom is not a leaf");
    expect(fresh.tabs.map((tab) => tab.key)).toEqual(["viewer-2"]);
    expect(fresh.active).toBe("viewer-2");
    // The tab LEFT its old leaf — moved, never duplicated.
    const remaining = leavesOf(root).flatMap((leaf) => leaf.tabs).filter((tab) => tab.key === "viewer-2");
    expect(remaining).toHaveLength(1);
    // An unknown tab spawns nothing.
    expect(moveTabToEdge(two, "nope", "bottom")).toBe(two);
  });
});

describe("floating (§V97) and docking home", () => {
  it("floatTab keeps the tab's slot; dockTab just clears the floating entry (T705b)", () => {
    // The owner's correction of T192's original behaviour: "it's getting yanked out of
    // its original position — it should stay there, block the space". Floating adds the
    // key to `floating` while the tab HOLDS its leaf, so the arrangement never reflows;
    // the leaf renders a placeholder and the content lives in the window (§V96: one
    // content, one container). Docking removes the entry and the same slot resumes.
    const tree = DEFAULT_PANE_TREE;
    const viewer = allTabs(tree).find((tab) => tab.role === "viewer")!;
    const floated = floatTab(tree, viewer.key);
    expect(floated.floating.map((tab) => tab.key)).toEqual([viewer.key]);
    expect(findLeaf(floated, "leaf-right")?.tabs.map((tab) => tab.key)).toContain(viewer.key);
    // One content, one portal container: allTabs must not list the key twice.
    expect(allTabs(floated).filter((tab) => tab.key === viewer.key)).toHaveLength(1);
    const docked = dockTab(floated, viewer.key);
    expect(docked.floating).toEqual([]);
    expect(findTab(docked, viewer.key)).toBeDefined();
    expect(findLeaf(docked, "leaf-right")?.tabs.map((tab) => tab.key)).toContain(viewer.key);
    // Floating twice is a no-op; docking a non-floating key is a no-op.
    expect(floatTab(floated, viewer.key)).toBe(floated);
    expect(dockTab(tree, viewer.key)).toBe(tree);
  });

  it("dockTab still RE-PLACES a tab whose leaf vanished while it floated", () => {
    // The pre-T705b shape, kept alive for old persisted layouts and for a leaf the
    // user closed mid-float: the floating entry is the only record, so docking must
    // re-insert rather than silently dropping the pane.
    const tree = DEFAULT_PANE_TREE;
    const viewer = allTabs(tree).find((tab) => tab.role === "viewer")!;
    const floated = floatTab(tree, viewer.key);
    const orphaned = { ...floated, root: closeTab(floated, viewer.key).root };
    const docked = dockTab(orphaned, viewer.key);
    expect(docked.floating).toEqual([]);
    expect(findTab(docked, viewer.key)).toBeDefined();
  });

  it("homeLeafFor answers by ROLE — the first leaf carrying it, else the first leaf", () => {
    expect(homeLeafFor(DEFAULT_PANE_TREE, "graph")).toBe("leaf-center");
    /*
     * T927: the fallback branch needs the leaf that CARRIED the role to be gone, not
     * merely emptied — the graph's own leaf is the first leaf of the default now, so
     * closing the tab alone would answer "leaf-center" through the FIRST branch and the
     * two answers would stop being distinguishable.
     */
    const noGraph = closeLeaf(DEFAULT_PANE_TREE, "leaf-center");
    expect(homeLeafFor(noGraph, "graph")).toBe("leaf-bottom");
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
    const valid = addTab(splitLeaf(DEFAULT_PANE_TREE, "leaf-center", "row"), "leaf-libraries", "viewer");
    const repaired = repairPaneTree({ root: valid.root, floating: valid.floating });
    expect(repaired.root).toBe(valid.root);
    expect(repaired.nextKey).toBeGreaterThan(0);
    // Minting from the repaired counter must not collide with any existing key.
    const minted = addTab(repaired, "leaf-libraries", "graph");
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
    // Not a tab wedged into a surviving dock: a fresh area with the SHAPE the closed
    // one had. T927/T932 moved where that is — the bottom dock is now the FIRST column
    // of a two-column bottom region, so it comes back as a row split beside the library
    // leaf at the region's own 50/50, not as a third tab inside it.
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
    // A ROW split with the new area on the FIRST (left) side, at the old 50/50.
    expect(parent?.direction).toBe("row");
    expect(parent?.secondIsFresh).toBe(false);
    expect(parent?.ratio).toBe(50);
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
