import type { DockZone, PaneId, ShellLayout } from "./layout-storage.ts";
import { DEFAULT_SHELL_LAYOUT } from "./layout-storage.ts";

/**
 * The pane TREE (T404, V340): identity split from role.
 *
 * `PaneId` fused WHAT A PANE SHOWS with WHICH PANE IT IS, so a second viewer was not
 * forbidden — it was unrepresentable. Here identity is a MINTED KEY and role is one of
 * the ten names; the layout is a binary tree of SPLITS whose leaves are TAB GROUPS
 * (today's zones already tab — the tree generalizes the arrangement, it does not
 * replace tabbing), and any number of tabs may share a role.
 *
 * A tab's KEY SURVIVES A ROLE CHANGE: changing what a pane shows does not change which
 * pane it is — its position, size and floating-window identity stay put. V340 applied
 * twice.
 *
 * Everything here is PURE over the layout value; the shell holds one in a ref and
 * persists on change, exactly as the flat model did.
 */

/** What a pane SHOWS — the ten names, unchanged. Identity lives in PaneKey. */
export type PaneRole = PaneId;

export type PaneKey = string;

export interface PaneTab {
  readonly key: PaneKey;
  readonly role: PaneRole;
  /** While FLOATING: the leaf it left, so closing the window puts it back (§V97). */
  readonly home?: PaneKey;
}

export interface SplitNode {
  readonly kind: "split";
  readonly id: PaneKey;
  readonly direction: "row" | "column";
  /** First child's share, percent (0..100). */
  readonly ratio: number;
  readonly first: LayoutNode;
  readonly second: LayoutNode;
}

export interface LeafNode {
  readonly kind: "leaf";
  readonly id: PaneKey;
  readonly tabs: readonly PaneTab[];
  readonly active: PaneKey | null;
}

export type LayoutNode = SplitNode | LeafNode;

/**
 * T486 (V423): how a CLOSED role comes back. Closing deletes the tab — there is no
 * object left to carry a `home` the way a floating tab carries one — so the layout
 * remembers a RECIPE per role: the leaf it lived in, and if that leaf itself was
 * closed, the split that would recreate its area (which surviving leaf to split, in
 * which direction, at what ratio, on which side).
 */
export type RestoreHint =
  | { readonly kind: "leaf"; readonly leaf: PaneKey }
  | {
      readonly kind: "split";
      readonly target: PaneKey;
      readonly direction: "row" | "column";
      readonly ratio: number;
      readonly side: "first" | "second";
    };

export interface PaneTreeLayout {
  readonly root: LayoutNode;
  /** Tabs currently in their own window (§V97). Never also in a leaf. */
  readonly floating: readonly PaneTab[];
  /** Mint counter for keys — deterministic, persisted with the layout. */
  readonly nextKey: number;
  /** T486: where each CLOSED role would come back. Absent = never closed. */
  readonly homes?: Readonly<Partial<Record<PaneRole, RestoreHint>>>;
}

// ---- walking ------------------------------------------------------------------------

export function leavesOf(node: LayoutNode): LeafNode[] {
  if (node.kind === "leaf") return [node];
  return [...leavesOf(node.first), ...leavesOf(node.second)];
}

export function findLeaf(layout: PaneTreeLayout, leafId: PaneKey): LeafNode | undefined {
  return leavesOf(layout.root).find((leaf) => leaf.id === leafId);
}

export function findTab(layout: PaneTreeLayout, key: PaneKey): PaneTab | undefined {
  for (const leaf of leavesOf(layout.root)) {
    const tab = leaf.tabs.find((candidate) => candidate.key === key);
    if (tab !== undefined) return tab;
  }
  return layout.floating.find((candidate) => candidate.key === key);
}

/** Every tab, docked leaves first (in tree order), then floating. */
export function allTabs(layout: PaneTreeLayout): PaneTab[] {
  return [...leavesOf(layout.root).flatMap((leaf) => [...leaf.tabs]), ...layout.floating];
}

function mapNode(node: LayoutNode, transform: (node: LayoutNode) => LayoutNode): LayoutNode {
  const applied = transform(node);
  if (applied.kind === "leaf") return applied;
  return {
    ...applied,
    first: mapNode(applied.first, transform),
    second: mapNode(applied.second, transform),
  };
}

// ---- minting ------------------------------------------------------------------------

/** `viewer-2`: the role for the human, the counter for uniqueness. */
function mint(layout: PaneTreeLayout, role: PaneRole): { key: PaneKey; next: number } {
  return { key: `${role}-${layout.nextKey}`, next: layout.nextKey + 1 };
}

// ---- algebra ------------------------------------------------------------------------

export function setSplitRatio(layout: PaneTreeLayout, splitId: PaneKey, ratio: number): PaneTreeLayout {
  const clamped = Math.max(5, Math.min(95, ratio));
  return {
    ...layout,
    root: mapNode(layout.root, (node) =>
      node.kind === "split" && node.id === splitId ? { ...node, ratio: clamped } : node,
    ),
  };
}

/**
 * Splits a leaf: the leaf keeps its tabs on the FIRST side, and a fresh EMPTY leaf
 * opens on the second — empty, so the role picker renders and the user says what it
 * shows (T406). The new leaf's id is minted like a tab key.
 */
export function splitLeaf(
  layout: PaneTreeLayout,
  leafId: PaneKey,
  direction: "row" | "column",
  options?: { readonly ratio?: number; readonly side?: "first" | "second" },
): PaneTreeLayout {
  const emptyLeafMint = mint(layout, "graph");
  const splitMint = { key: `split-${layout.nextKey + 1}`, next: layout.nextKey + 2 };
  const fresh: LeafNode = { kind: "leaf", id: `leaf-${emptyLeafMint.key}`, tabs: [], active: null };
  const side = options?.side ?? "second";
  const ratio = Math.max(5, Math.min(95, options?.ratio ?? 50));
  let split = false;
  const root = mapNode(layout.root, (node) => {
    if (node.kind !== "leaf" || node.id !== leafId || split) return node;
    split = true;
    return {
      kind: "split",
      id: splitMint.key,
      direction,
      ratio,
      // T486: a restore recreates a closed area on the SIDE it lived on; a user split
      // keeps its old shape (existing tabs first, fresh empty leaf second).
      first: side === "second" ? node : fresh,
      second: side === "second" ? fresh : node,
    } as SplitNode;
  });
  return split ? { ...layout, root, nextKey: splitMint.next } : layout;
}

/** Adds a tab of `role` to a leaf, minting its identity. It becomes the active tab. */
export function addTab(layout: PaneTreeLayout, leafId: PaneKey, role: PaneRole): PaneTreeLayout {
  const minted = mint(layout, role);
  let added = false;
  const root = mapNode(layout.root, (node) => {
    if (node.kind !== "leaf" || node.id !== leafId || added) return node;
    added = true;
    return { ...node, tabs: [...node.tabs, { key: minted.key, role }], active: minted.key };
  });
  return added ? { ...layout, root, nextKey: minted.next } : layout;
}

/**
 * Changes what a tab SHOWS. The key — its position, size, floating identity — stays:
 * identity is not role (V340, applied the second time).
 */
export function assignRole(layout: PaneTreeLayout, key: PaneKey, role: PaneRole): PaneTreeLayout {
  const retab = (tabs: readonly PaneTab[]): PaneTab[] =>
    tabs.map((tab) => (tab.key === key ? { ...tab, role } : tab));
  return {
    ...layout,
    root: mapNode(layout.root, (node) => (node.kind === "leaf" ? { ...node, tabs: retab(node.tabs) } : node)),
    floating: retab(layout.floating),
  };
}

/** Removes a tab wherever it is. An emptied leaf stays — closing the LEAF is explicit.
 *  The tab's ROLE remembers the leaf it left (T486), so the layout menu can offer it
 *  back into the same place. */
export function closeTab(layout: PaneTreeLayout, key: PaneKey): PaneTreeLayout {
  const leaf = leavesOf(layout.root).find((entry) => entry.tabs.some((tab) => tab.key === key));
  const closing = leaf?.tabs.find((tab) => tab.key === key) ?? layout.floating.find((tab) => tab.key === key);
  const homes =
    closing === undefined
      ? layout.homes
      : {
          ...layout.homes,
          [closing.role]:
            leaf !== undefined
              ? ({ kind: "leaf", leaf: leaf.id } satisfies RestoreHint)
              : (layout.homes?.[closing.role] ?? { kind: "leaf", leaf: leavesOf(layout.root)[0]?.id ?? "" }),
        };
  return {
    ...layout,
    ...(homes === undefined ? {} : { homes }),
    root: mapNode(layout.root, (node) => {
      if (node.kind !== "leaf") return node;
      if (!node.tabs.some((tab) => tab.key === key)) return node;
      const tabs = node.tabs.filter((tab) => tab.key !== key);
      const active = node.active === key ? (tabs[0]?.key ?? null) : node.active;
      return { ...node, tabs, active };
    }),
    floating: layout.floating.filter((tab) => tab.key !== key),
  };
}

/** Closes a leaf: its split collapses and the SIBLING takes the whole area. Its tabs
 *  are gone with it — closing a leaf is closing its panes, and the control says so. */
export function closeLeaf(layout: PaneTreeLayout, leafId: PaneKey): PaneTreeLayout {
  if (layout.root.kind === "leaf") return layout; // the last leaf is the shell; it stays
  /* T486: before collapsing, remember the RECIPE that would recreate this area — the
     parent split's direction, ratio and side, anchored on a surviving leaf of the
     sibling subtree — for every role this close takes down. */
  let recipe: Omit<Extract<RestoreHint, { kind: "split" }>, "kind"> | undefined;
  let closedTabs: readonly PaneTab[] = [];
  const inspect = (node: LayoutNode): void => {
    if (node.kind === "leaf") return;
    const closing =
      node.first.kind === "leaf" && node.first.id === leafId
        ? ("first" as const)
        : node.second.kind === "leaf" && node.second.id === leafId
          ? ("second" as const)
          : undefined;
    if (closing !== undefined) {
      const closedLeaf = (closing === "first" ? node.first : node.second) as LeafNode;
      const sibling = closing === "first" ? node.second : node.first;
      const anchor = leavesOf(sibling)[0];
      if (anchor !== undefined) {
        recipe = {
          target: anchor.id,
          direction: node.direction,
          ratio: closing === "first" ? node.ratio : node.ratio,
          side: closing,
        };
      }
      closedTabs = closedLeaf.tabs;
      return;
    }
    inspect(node.first);
    inspect(node.second);
  };
  inspect(layout.root);
  const collapse = (node: LayoutNode): LayoutNode => {
    if (node.kind === "leaf") return node;
    if (node.first.kind === "leaf" && node.first.id === leafId) return collapse(node.second);
    if (node.second.kind === "leaf" && node.second.id === leafId) return collapse(node.first);
    return { ...node, first: collapse(node.first), second: collapse(node.second) };
  };
  const stamped = recipe;
  const homes =
    stamped === undefined || closedTabs.length === 0
      ? layout.homes
      : {
          ...layout.homes,
          ...Object.fromEntries(
            closedTabs.map((tab) => [tab.role, { kind: "split", ...stamped } satisfies RestoreHint]),
          ),
        };
  return { ...layout, root: collapse(layout.root), ...(homes === undefined ? {} : { homes }) };
}

/** Moves a tab into a leaf (at `index`, default last); it becomes that leaf's active. */
export function moveTab(
  layout: PaneTreeLayout,
  key: PaneKey,
  targetLeafId: PaneKey,
  index?: number,
): PaneTreeLayout {
  const tab = findTab(layout, key);
  if (tab === undefined) return layout;
  const removed = closeTab(layout, key);
  let placed = false;
  const root = mapNode(removed.root, (node) => {
    if (node.kind !== "leaf" || node.id !== targetLeafId || placed) return node;
    placed = true;
    const tabs = [...node.tabs];
    const at = index === undefined ? tabs.length : Math.max(0, Math.min(index, tabs.length));
    tabs.splice(at, 0, tab);
    return { ...node, tabs, active: key };
  });
  return placed ? { ...removed, root } : layout;
}

export function selectTab(layout: PaneTreeLayout, leafId: PaneKey, key: PaneKey): PaneTreeLayout {
  return {
    ...layout,
    root: mapNode(layout.root, (node) =>
      node.kind === "leaf" && node.id === leafId && node.tabs.some((tab) => tab.key === key)
        ? { ...node, active: key }
        : node,
    ),
  };
}

/** Pops a tab into its own window (§V97). Window name: `shaderloom-${key}` — unique by
 *  construction, which is the T393 fix the singleton names could not give (two floating
 *  viewers used to be the SAME window). */
export function floatTab(layout: PaneTreeLayout, key: PaneKey): PaneTreeLayout {
  const tab = findTab(layout, key);
  if (tab === undefined || layout.floating.some((floating) => floating.key === key)) return layout;
  const from = leavesOf(layout.root).find((leaf) => leaf.tabs.some((t) => t.key === key));
  const removed = closeTab(layout, key);
  return {
    ...removed,
    floating: [...removed.floating, { ...tab, ...(from === undefined ? {} : { home: from.id }) }],
  };
}

/** Docks a floating tab: back to the leaf it left while that leaf still exists, else
 *  the first leaf holding its role, else the first leaf — never nowhere. */
export function dockTab(layout: PaneTreeLayout, key: PaneKey): PaneTreeLayout {
  const tab = layout.floating.find((floating) => floating.key === key);
  if (tab === undefined) return layout;
  const leaves = leavesOf(layout.root);
  const target =
    (tab.home === undefined ? undefined : leaves.find((leaf) => leaf.id === tab.home)) ??
    leaves.find((leaf) => leaf.tabs.some((t) => t.role === tab.role)) ??
    leaves[0];
  if (target === undefined) return layout;
  const docked: PaneTab = { key: tab.key, role: tab.role };
  const without = { ...layout, floating: layout.floating.filter((floating) => floating.key !== key) };
  let placed = false;
  const root = mapNode(without.root, (node) => {
    if (node.kind !== "leaf" || node.id !== target.id || placed) return node;
    placed = true;
    return { ...node, tabs: [...node.tabs, docked], active: key };
  });
  return { ...without, root };
}

// ---- migration (T406, V311 both directions) -----------------------------------------

/**
 * v3's five zones ARE a fixed tree. This constructs it deterministically, one minted
 * tab per zone entry, ratios from the stored percentages:
 *
 *   column [ row[ row[left | center] | bottom ]  |  row[right | rightBottom] ]
 */
export function treeFromShellLayout(flat: ShellLayout): PaneTreeLayout {
  let next = 1;
  const tabsFor = (zone: DockZone): PaneTab[] =>
    flat.zones[zone].map((role) => ({ key: `${role}-${next++}`, role }));
  const leafFor = (zone: DockZone): LeafNode => {
    const tabs = tabsFor(zone);
    const activeRole = flat.active[zone];
    const active = tabs.find((tab) => tab.role === activeRole)?.key ?? tabs[0]?.key ?? null;
    return { kind: "leaf", id: `leaf-${zone}`, tabs, active };
  };
  const left = leafFor("left");
  const center = leafFor("center");
  const bottom = leafFor("bottom");
  const right = leafFor("right");
  const rightBottom = leafFor("rightBottom");
  const floating: PaneTab[] = flat.floating.map((role) => ({ key: `${role}-${next++}`, role }));
  return {
    root: {
      kind: "split",
      id: "split-columns",
      direction: "row",
      ratio: flat.columns[0] ?? 74,
      first: {
        kind: "split",
        id: "split-rows",
        direction: "column",
        ratio: flat.rows[0] ?? 72,
        first: {
          kind: "split",
          id: "split-main",
          direction: "row",
          ratio: flat.mainColumns[0] ?? 23,
          first: left,
          second: center,
        },
        second: bottom,
      },
      second: {
        kind: "split",
        id: "split-right",
        direction: "column",
        ratio: flat.rightRows[0] ?? 50,
        first: right,
        second: rightBottom,
      },
    },
    floating,
    nextKey: next,
  };
}

/**
 * The v3 PROJECTION, for old builds: faithful when the tree still has the canonical
 * five-zone skeleton AND no role appears twice. Otherwise NULL — and the caller must
 * CLEAR the v3 record rather than leave it (V385): a stale projection silently restores
 * an arrangement the user abandoned; an absent one falls back to a default the user can
 * SEE.
 */
export function shellLayoutFromTree(layout: PaneTreeLayout): ShellLayout | null {
  const root = layout.root;
  if (root.kind !== "split" || root.direction !== "row") return null;
  const work = root.first;
  const rightCol = root.second;
  if (work.kind !== "split" || work.direction !== "column") return null;
  if (rightCol.kind !== "split" || rightCol.direction !== "column") return null;
  const main = work.first;
  const bottom = work.second;
  if (main.kind !== "split" || main.direction !== "row") return null;
  const left = main.first;
  const center = main.second;
  const right = rightCol.first;
  const rightBottom = rightCol.second;
  const leaves = { left, center, bottom, right, rightBottom };
  for (const leaf of Object.values(leaves)) {
    if (leaf.kind !== "leaf") return null;
  }
  const roles = allTabs(layout).map((tab) => tab.role);
  if (new Set(roles).size !== roles.length) return null; // a role twice is v4-only

  const zoneOfLeaf = (leaf: LayoutNode): readonly PaneId[] =>
    leaf.kind === "leaf" ? leaf.tabs.map((tab) => tab.role) : [];
  const activeOf = (leaf: LayoutNode): PaneId | null => {
    if (leaf.kind !== "leaf") return null;
    return leaf.tabs.find((tab) => tab.key === leaf.active)?.role ?? leaf.tabs[0]?.role ?? null;
  };
  return {
    columns: [root.ratio, 100 - root.ratio],
    mainColumns: [main.ratio, 100 - main.ratio],
    rows: [work.ratio, 100 - work.ratio],
    rightRows: [rightCol.ratio, 100 - rightCol.ratio],
    zones: {
      left: zoneOfLeaf(left),
      center: zoneOfLeaf(center),
      right: zoneOfLeaf(right),
      rightBottom: zoneOfLeaf(rightBottom),
      bottom: zoneOfLeaf(bottom),
    },
    active: {
      left: activeOf(left),
      center: activeOf(center),
      right: activeOf(right),
      rightBottom: activeOf(rightBottom),
      bottom: activeOf(bottom),
    },
    floating: layout.floating.map((tab) => tab.role),
  };
}

export const DEFAULT_PANE_TREE: PaneTreeLayout = treeFromShellLayout(DEFAULT_SHELL_LAYOUT);

/**
 * T486 (V423): bring a CLOSED role back. The layout menu enumerates the POSSIBILITY
 * space — all ten roles — so an absent one is offered rather than unreachable; picking
 * it lands here. The remembered recipe is tried first: the leaf it lived in, or the
 * split that recreates its area (the owner's exact case — close the bottom bar, get
 * the bottom bar back, not a tab wedged into the left dock). A stale recipe degrades
 * to the first leaf rather than failing: restored SOMEWHERE beats restored nowhere.
 */
export function restoreRole(layout: PaneTreeLayout, role: PaneRole): PaneTreeLayout {
  if (allTabs(layout).some((tab) => tab.role === role)) return layout; // present: nothing to restore
  const hint = layout.homes?.[role];
  if (hint?.kind === "leaf" && findLeaf(layout, hint.leaf) !== undefined) {
    return addTab(layout, hint.leaf, role);
  }
  if (hint?.kind === "split" && findLeaf(layout, hint.target) !== undefined) {
    // The recipe's ratio is the parent split's FIRST-child share, which is what
    // splitLeaf's ratio means on either side — no inversion.
    const split = splitLeaf(layout, hint.target, hint.direction, { ratio: hint.ratio, side: hint.side });
    const fresh = leavesOf(split.root).find((leaf) => leaf.tabs.length === 0);
    if (fresh !== undefined) return addTab(split, fresh.id, role);
  }
  const first = leavesOf(layout.root)[0];
  return first === undefined ? layout : addTab(layout, first.id, role);
}

/** A floating tab's home: the first leaf carrying its role, else the first leaf —
 *  role-shaped, where the flat model's homes were zone-shaped. */
export function homeLeafFor(layout: PaneTreeLayout, role: PaneRole): PaneKey | null {
  const leaves = leavesOf(layout.root);
  return (leaves.find((leaf) => leaf.tabs.some((tab) => tab.role === role)) ?? leaves[0])?.id ?? null;
}

/** Structural repair: unknown shapes degrade to the default tree, never a throw. */
export function repairPaneTree(raw: unknown): PaneTreeLayout {
  const isTab = (value: unknown): value is PaneTab =>
    typeof value === "object" &&
    value !== null &&
    typeof (value as PaneTab).key === "string" &&
    typeof (value as PaneTab).role === "string";
  const isNode = (value: unknown): value is LayoutNode => {
    if (typeof value !== "object" || value === null) return false;
    const node = value as LayoutNode;
    if (node.kind === "leaf") {
      return typeof node.id === "string" && Array.isArray(node.tabs) && node.tabs.every(isTab);
    }
    if (node.kind === "split") {
      return (
        typeof node.id === "string" &&
        (node.direction === "row" || node.direction === "column") &&
        typeof node.ratio === "number" &&
        isNode(node.first) &&
        isNode(node.second)
      );
    }
    return false;
  };
  if (typeof raw !== "object" || raw === null) return DEFAULT_PANE_TREE;
  const candidate = raw as PaneTreeLayout;
  if (!isNode(candidate.root)) return DEFAULT_PANE_TREE;
  if (!Array.isArray(candidate.floating) || !candidate.floating.every(isTab)) return DEFAULT_PANE_TREE;
  const keys = allTabs(candidate).map((tab) => tab.key);
  if (new Set(keys).size !== keys.length) return DEFAULT_PANE_TREE; // duplicate identity: corrupt
  /* T486: carry the restore hints through repair — an invalid entry is dropped alone,
     never the arrangement with it. */
  const homes: Partial<Record<PaneRole, RestoreHint>> = {};
  for (const [role, hint] of Object.entries(candidate.homes ?? {})) {
    if (typeof hint !== "object" || hint === null) continue;
    const shaped = hint as RestoreHint;
    if (shaped.kind === "leaf" && typeof shaped.leaf === "string") homes[role as PaneRole] = shaped;
    else if (
      shaped.kind === "split" &&
      typeof shaped.target === "string" &&
      (shaped.direction === "row" || shaped.direction === "column") &&
      typeof shaped.ratio === "number" &&
      (shaped.side === "first" || shaped.side === "second")
    ) {
      homes[role as PaneRole] = shaped;
    }
  }
  return {
    root: candidate.root,
    floating: candidate.floating,
    nextKey: typeof candidate.nextKey === "number" && candidate.nextKey > 0 ? candidate.nextKey : keys.length + 1,
    ...(Object.keys(homes).length === 0 ? {} : { homes }),
  };
}
