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

/** Every tab, docked leaves first (in tree order), then floating. Deduplicated by key:
 *  since T705(b) a floated tab is ALSO still in its leaf, and its content must render
 *  exactly once (§V96 — one portal container per key). */
export function allTabs(layout: PaneTreeLayout): PaneTab[] {
  const docked = leavesOf(layout.root).flatMap((leaf) => [...leaf.tabs]);
  const seen = new Set(docked.map((tab) => tab.key));
  return [...docked, ...layout.floating.filter((tab) => !seen.has(tab.key))];
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

/**
 * Moves a tab into a leaf (at `index`, default last); it becomes that leaf's active.
 *
 * ## T931 — `index` is measured in the TARGET's own tab order, after the removal
 *
 * Which matters for exactly one case: dropping a tab back into the leaf it came from,
 * i.e. a REORDER. The user points at a gap in the strip they can see, and that strip
 * still contains the tab being dragged — so an index taken from what they are looking at
 * is one too many once the tab leaves. Adjusting here rather than at the drop handler is
 * deliberate: both doors (the strip and the whole-leaf overlay) speak the same
 * "position in the list you can see" and neither has to know about the shift.
 *
 * ## T931 — a leaf the move EMPTIES collapses, and that is not `closeTab`'s rule
 *
 * `closeTab` keeps an emptied leaf on purpose (T854: closing a TAB and closing an AREA
 * are different acts, and the × must never strand a user in a vanished pane). A move is
 * the other case. The tab is not gone, it is somewhere else, and nobody asked for the
 * area it vacated — leaving it behind hands the user a half-width empty picker they now
 * have to close by hand, one per drag. So the two verbs differ, and they differ because
 * the user's intent differs, not because the implementations drifted.
 *
 * The last leaf still survives: `closeLeaf` refuses to collapse a root leaf, so the
 * shell always has somewhere to stand. §V97 survives too, from two directions: since
 * T705(b) a FLOATED tab still occupies its leaf, so a leaf holding one is never empty
 * and cannot be collapsed out from under an open window; and a `home` left stale by a
 * collapse is `dockTab`'s existing degrade-never-strand path, which is gated.
 */
export function moveTab(
  layout: PaneTreeLayout,
  key: PaneKey,
  targetLeafId: PaneKey,
  index?: number,
): PaneTreeLayout {
  const tab = findTab(layout, key);
  if (tab === undefined) return layout;
  const source = leavesOf(layout.root).find((leaf) => leaf.tabs.some((entry) => entry.key === key));
  const removed = closeTab(layout, key);
  // A reorder inside one leaf: the index the user aimed at counted the dragged tab.
  const from = source?.id === targetLeafId ? source.tabs.findIndex((entry) => entry.key === key) : -1;
  const aimed = index === undefined ? undefined : from >= 0 && index > from ? index - 1 : index;
  let placed = false;
  const root = mapNode(removed.root, (node) => {
    if (node.kind !== "leaf" || node.id !== targetLeafId || placed) return node;
    placed = true;
    const tabs = [...node.tabs];
    const at = aimed === undefined ? tabs.length : Math.max(0, Math.min(aimed, tabs.length));
    tabs.splice(at, 0, tab);
    return { ...node, tabs, active: key };
  });
  if (!placed) return layout;
  const next = { ...removed, root };
  if (source === undefined || source.id === targetLeafId) return next;
  const emptied = findLeaf(next, source.id);
  return emptied !== undefined && emptied.tabs.length === 0 ? closeLeaf(next, source.id) : next;
}

/**
 * T494: the shell's outer edges as SPAWNABLE areas.
 *
 * Once an area is gone no gesture brought it back: every drop target was a band on an
 * EXISTING leaf and the menu listed what existed. Both owner reports ("spawn the
 * bottom, left and right side as empty panes if they are closed", "drag and drop is
 * not able to produce a new bottom pane if its not there") are this one gap through
 * two doors — so both doors run THIS operation, or they would disagree about ratios
 * and anchors the way the two layout algorithms once did.
 */
export type ShellEdge = "left" | "right" | "bottom";

/**
 * A new area's share of the shell, per edge — a dock, not a half.
 *
 * T936: read off `SKELETON_TREE` rather than written here. These used to be 22/22/28
 * against the skeleton's own 23/26/28, which is two answers to "how wide is a left dock"
 * already diverging — and T936 adds a third door (restoring a baseline region from the
 * layout menu) that has to agree with both.
 *
 * A function, not a constant, and the reason is module init order: `baselinePlacement`
 * reads a table declared further down this file, so evaluating it at import time is a
 * temporal dead zone. Called at gesture time it is a table lookup on a frozen tree.
 */
function edgeShare(edge: ShellEdge): number {
  const placement = baselinePlacement(edge);
  return placement.side === "first" ? placement.ratio : 100 - placement.ratio;
}

/**
 * Which edges are HELD by a dedicated area. The rule, chosen to be explainable in one
 * sentence: an edge is held when a strip anchored there — touching it WITHOUT touching
 * the opposite edge — covers the MAJORITY of it. The center leaf of a bottom-less
 * layout touches the bottom but also the top, so it anchors nowhere; the default
 * layout's bottom-right viewer touches the bottom but spans only its own column, so
 * closing the wide bottom bar genuinely frees the edge. V423 both ways: offer the
 * possibility space (any absent edge), never what is already there.
 */
export function heldEdges(layout: PaneTreeLayout): ReadonlySet<ShellEdge> {
  const coverage: Record<ShellEdge, number> = { left: 0, right: 0, bottom: 0 };
  const epsilon = 1e-6;
  const walk = (node: LayoutNode, x: number, y: number, w: number, h: number): void => {
    if (node.kind === "split") {
      const share = node.ratio / 100;
      if (node.direction === "row") {
        walk(node.first, x, y, w * share, h);
        walk(node.second, x + w * share, y, w * (1 - share), h);
      } else {
        walk(node.first, x, y, w, h * share);
        walk(node.second, x, y + h * share, w, h * (1 - share));
      }
      return;
    }
    const touchesLeft = x < epsilon;
    const touchesRight = x + w > 1 - epsilon;
    const touchesTop = y < epsilon;
    const touchesBottom = y + h > 1 - epsilon;
    // Anchored strips ACCUMULATE: a dock stacked into two leaves (the default right
    // column) covers its edge together, though neither half does alone.
    if (touchesLeft && !touchesRight) coverage.left += h;
    if (touchesRight && !touchesLeft) coverage.right += h;
    if (touchesBottom && !touchesTop) coverage.bottom += w;
  };
  walk(layout.root, 0, 0, 1, 1);
  const held = new Set<ShellEdge>();
  for (const edge of ["left", "right", "bottom"] as const) {
    if (coverage[edge] > 0.5) held.add(edge);
  }
  return held;
}

/** The edges a spawn gesture may offer right now. */
export function spawnableEdges(layout: PaneTreeLayout): ShellEdge[] {
  const held = heldEdges(layout);
  return (["left", "right", "bottom"] as const).filter((edge) => !held.has(edge));
}

/**
 * Creates the area: wraps the ROOT in a split with a fresh EMPTY leaf on `edge` — empty
 * so the role picker renders and the user says what it shows (T406), exactly like a
 * leaf split. Returns the new layout and the minted leaf id so the drag door can drop
 * into it; the menu door ignores the id.
 */
export function spawnEdge(
  layout: PaneTreeLayout,
  edge: ShellEdge,
): { readonly layout: PaneTreeLayout; readonly leafId: PaneKey } {
  const leafId = `leaf-graph-${layout.nextKey}`;
  const splitId = `split-${layout.nextKey + 1}`;
  const fresh: LeafNode = { kind: "leaf", id: leafId, tabs: [], active: null };
  const share = edgeShare(edge);
  const root: SplitNode =
    edge === "bottom"
      ? { kind: "split", id: splitId, direction: "column", ratio: 100 - share, first: layout.root, second: fresh }
      : edge === "left"
        ? { kind: "split", id: splitId, direction: "row", ratio: share, first: fresh, second: layout.root }
        : { kind: "split", id: splitId, direction: "row", ratio: 100 - share, first: layout.root, second: fresh };
  return { layout: { ...layout, root, nextKey: layout.nextKey + 2 }, leafId };
}

/** Door two in one move: spawn the area, drop the dragged tab into it. */
export function moveTabToEdge(layout: PaneTreeLayout, key: PaneKey, edge: ShellEdge): PaneTreeLayout {
  if (findTab(layout, key) === undefined) return layout;
  const spawned = spawnEdge(layout, edge);
  return moveTab(spawned.layout, key, spawned.leafId);
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

/** Pops a tab into its own window (§V97). Window name: `loom-${key}` — unique by
 *  construction, which is the T393 fix the singleton names could not give (two floating
 *  viewers used to be the SAME window). */
export function floatTab(layout: PaneTreeLayout, key: PaneKey): PaneTreeLayout {
  const tab = findTab(layout, key);
  if (tab === undefined || layout.floating.some((floating) => floating.key === key)) return layout;
  const from = leavesOf(layout.root).find((leaf) => leaf.tabs.some((t) => t.key === key));
  /*
   * T705(b), the owner's correction of the original T192 behaviour: floating a pane no
   * longer YANKS it out of the arrangement. The tab STAYS in its leaf — holding its
   * place, its size and its tab order — while its key also joins `floating`; the leaf
   * renders a placeholder for it (the content itself lives in the child window, and a
   * pane's content exists exactly once, §V96). Closing the window or docking removes
   * the floating entry and the same slot picks the content back up, nothing reflows.
   */
  return {
    ...layout,
    floating: [...layout.floating, { ...tab, ...(from === undefined ? {} : { home: from.id }) }],
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
  // T705(b): the tab normally never left its leaf — docking is just the floating entry
  // going away, and the slot that held its place picks the content back up. The
  // re-insertion below now serves only layouts from before the change (or a leaf the
  // user closed while the pane was floating), where the tab is genuinely gone.
  if (leavesOf(without.root).some((leaf) => leaf.tabs.some((t) => t.key === key))) {
    return without;
  }
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

  /*
   * T705(b): in the TREE a floated tab stays in its leaf (holding its place); v3's
   * model is exclusive — a pane is in a zone OR floating, and the read-side repair
   * drops a floating entry it has already seen in a zone. So the projection speaks
   * v3's own semantics: a floated pane appears as floating ONLY, which is also what a
   * downgraded build should show (the pane is, in fact, in a window).
   */
  const floatedKeys = new Set(layout.floating.map((tab) => tab.key));
  const dockedTabs = (leaf: LayoutNode): readonly PaneTab[] =>
    leaf.kind === "leaf" ? leaf.tabs.filter((tab) => !floatedKeys.has(tab.key)) : [];
  const zoneOfLeaf = (leaf: LayoutNode): readonly PaneId[] =>
    dockedTabs(leaf).map((tab) => tab.role);
  const activeOf = (leaf: LayoutNode): PaneId | null => {
    if (leaf.kind !== "leaf") return null;
    const tabs = dockedTabs(leaf);
    return tabs.find((tab) => tab.key === leaf.active)?.role ?? tabs[0]?.role ?? null;
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

/**
 * T1125 — the default arrangement, AUTHORED AS A TREE.
 *
 * ## The libraries are back in the LEFT DOCK, and T927's own measurement is why
 *
 * T927 moved `library` + `components` out of the left dock and into a second column of
 * the bottom region, to free the left 23% for the graph. T932 then made that column ONE
 * leaf with two tabs, because a vertical split halved the rows of whichever library you
 * were actually reading. Both changes were measured, and the numbers T927 recorded are
 * the ones that send this back: the left dock showed about TWENTY rows of the node
 * library; the bottom column showed one stacked, six as a tab. The owner has now looked
 * at the tabbed version in place and called it "squeezed" — a scan-and-drag list wants
 * HEIGHT, and the only full-height column in this shell that is not the graph is the
 * left dock.
 *
 * ⚠ Do NOT read this as "T932 was wrong". T932's finding still holds and is why the pair
 * stays ONE LEAF WITH TWO TABS here rather than becoming two stacked leaves: splitting
 * them halves the rows of the one you are scanning, wherever the leaf happens to live.
 * What changed is the leaf's home, not the argument about its contents. A future change
 * to two leaves still owes a measurement of the rows it costs, or it is T927 again.
 *
 * §V93 still holds and is why they may share this leaf: both ADD to the open document.
 * The example library must never join them — OPEN replaces the document, and a
 * destructive verb one tab away from two harmless ones is how a session gets lost.
 *
 * ## The bottom region is ONE dock again — the vacated column was not backfilled
 *
 * With the libraries gone there was a free column beside the bottom tab dock, and the
 * owner asked what should go in it. Nothing does. The tab dock absorbs it, which doubles
 * the width of the SHADER EDITOR — the one surface down there that is starved by width
 * rather than height — and widens the examples grid and the problems list with it. A
 * rail of filler beside the code you are editing is worse than no rail.
 *
 * ⚑ A consequence worth knowing: the default is now structurally the five-zone skeleton
 * again, so `shellLayoutFromTree` PROJECTS it and an older build reading v3 sees the same
 * arrangement instead of falling back. It is still authored here rather than derived from
 * `DEFAULT_SHELL_LAYOUT`, because the tab KEYS are identities (T1123) and deriving would
 * renumber them; the two must agree in SHAPE, and `pane-tree.test.ts` pins that.
 *
 * This is NOT a migration. Only a profile with no stored layout — or one that runs
 * `layout.reset` / picks "Default" in the layout menu — ever sees it; everyone else
 * keeps the arrangement they are sitting in (V813, and see `pane-tree-storage.ts`).
 */
export const DEFAULT_PANE_TREE: PaneTreeLayout = {
  root: {
    kind: "split",
    id: "split-columns",
    direction: "row",
    ratio: 74,
    first: {
      kind: "split",
      id: "split-rows",
      direction: "column",
      // The flat default's 72/28. T927 spent 34 here buying rows for the stacked
      // libraries; nothing in the bottom dock needs them now that the libraries are a
      // full-height column again.
      ratio: 72,
      first: {
        kind: "split",
        id: "split-main",
        direction: "row",
        // 23/77, the skeleton's own share — see `baselinePlacement`, which reads it off
        // `SKELETON_TREE` so the menu's "restore the left dock" lands at this width.
        ratio: 23,
        // T1125: ONE leaf, two tabs. T932's reason travels with the pair — a split here
        // halves the rows of whichever library you are scanning, and rows are what this
        // surface is for. What the left dock adds is the FULL WORK-AREA HEIGHT.
        first: {
          kind: "leaf",
          id: "leaf-left",
          tabs: [
            { key: "library-7", role: "library" },
            { key: "components-8", role: "components" },
          ],
          active: "library-7",
        },
        second: {
          kind: "leaf",
          id: "leaf-center",
          tabs: [{ key: "graph-1", role: "graph" }],
          active: "graph-1",
        },
      },
      /*
       * EXAMPLES FIRST, AND OPEN, on a fresh profile — the owner's call (T1123).
       *
       * The shader editor was first and selected, which meant the first thing a new
       * user saw in the bottom dock was an empty text pane for a node they had not
       * created. The example library is the one tab in this strip that has something in
       * it before the user does anything, and it is the door to the starter document
       * this default now boots with (`use-starter-project.ts`).
       *
       * The TAB KEYS are deliberately left at their historical numbers rather than
       * renumbered to match the new order. A key is an identity, not a position:
       * `homes` restore hints (T486) and any stored tree name tabs by key, and
       * renumbering would silently repoint them. Only the ARRAY order and `active`
       * carry the arrangement.
       *
       * This is the DEFAULT only. A profile with a stored tree
       * (`shaderloom.shell.layouts.v5`) keeps whatever the user arranged; the doors to
       * this order are a fresh profile and `layout.reset` / the menu's "Default" row.
       */
      second: {
        kind: "leaf",
        id: "leaf-bottom",
        tabs: [
          { key: "examples-5", role: "examples" },
          { key: "shader-2", role: "shader" },
          { key: "problems-3", role: "problems" },
          { key: "performance-4", role: "performance" },
          { key: "agent-6", role: "agent" },
        ],
        active: "examples-5",
      },
    },
    second: {
      kind: "split",
      id: "split-right",
      direction: "column",
      ratio: 50,
      first: { kind: "leaf", id: "leaf-right", tabs: [{ key: "viewer-9", role: "viewer" }], active: "viewer-9" },
      second: {
        kind: "leaf",
        id: "leaf-rightBottom",
        tabs: [{ key: "inspector-10", role: "inspector" }],
        active: "inspector-10",
      },
    },
  },
  floating: [],
  nextKey: 11,
};

/**
 * T1125 — "Perform": the second built-in preset, and the only one that is a MODE rather
 * than a rearrangement.
 *
 * The default above is for building a patch: the graph is the biggest thing on screen and
 * the output is a thumbnail in the sidebar. This is the other half of what the tool is
 * for — the graph is finished and you are playing it. So the ratios inverts: the VIEWER
 * takes the work area (about 52% of the window as one rectangle, against the default's
 * 13% sidebar tile), the INSPECTOR becomes a full-height column so a parameter's slider
 * has travel, and the graph is MINIMISED rather than gone.
 *
 * Minimised, not gone, and that is the load-bearing decision. Loom has no document-level
 * exposed-parameter surface — promotion exists for COMPONENT parameter pages only
 * (`domain/components`) — so the inspector shows the SELECTED node's parameters, and
 * selecting a node needs a graph you can click. A Perform layout that removed the graph
 * would leave its own parameter pane permanently empty. It sits in the bottom dock, wide
 * and short, beside `performance` — under stage conditions the two questions are "what do
 * I reach for next" and "am I holding frame rate".
 *
 * Everything build-time (library, components, examples, shader, problems, agent) is
 * absent, and the ways back are the ones every layout has: pick "Default" in the layout
 * menu, `layout.reset`, or restore a single pane from the menu's absent-roles list.
 *
 * Not flat-projectable on purpose — the work area has no `split-main` and the sidebar is
 * a single leaf — so, like the default before T1125, it lives here rather than in
 * `LAYOUT_PRESETS`. Tab keys deliberately reuse the default's numbering for the same
 * roles (T1123: a key is an identity), so switching presets does not repoint T486's
 * restore hints.
 */
export const PERFORM_PANE_TREE: PaneTreeLayout = {
  root: {
    kind: "split",
    id: "split-columns",
    direction: "row",
    // The same 74/26 as the default: the sidebar width is muscle memory, and only what
    // it HOLDS changes.
    ratio: 74,
    first: {
      kind: "split",
      id: "split-rows",
      direction: "column",
      // 70/30 rather than the default's 72/28 — the graph strip needs enough height to
      // read a node's title, and the viewer is not measurably worse for two points.
      ratio: 70,
      first: { kind: "leaf", id: "leaf-center", tabs: [{ key: "viewer-9", role: "viewer" }], active: "viewer-9" },
      second: {
        kind: "leaf",
        id: "leaf-bottom",
        tabs: [
          { key: "graph-1", role: "graph" },
          { key: "performance-4", role: "performance" },
        ],
        active: "graph-1",
      },
    },
    // A single leaf, not `split-right`: the sidebar's whole job here is the parameters,
    // and halving it for a second pane is what the default already does.
    second: {
      kind: "leaf",
      id: "leaf-right",
      tabs: [{ key: "inspector-10", role: "inspector" }],
      active: "inspector-10",
    },
  },
  floating: [],
  nextKey: 11,
};

// ---- T936: the baseline docks, always listable, absent ones recreatable ------------

/**
 * The five-zone migration skeleton — the shape every layout stored before T404 comes up
 * as, and, since T927 gave the default a bottom region the flat model cannot spell, the
 * only place `split-main` and its stock ratios still exist.
 *
 * T936 makes it load-bearing rather than merely historical: it is the SINGLE source for
 * where a baseline dock goes and how big it is. Three doors now ask that question — the
 * T494 edge spawn, the T494 edge drop, and the layout menu's restore — and constants
 * written out at any of them would be a fourth answer waiting to drift from the other
 * three (they already had: `EDGE_SHARE` said 22 where the skeleton says 23).
 */
export const SKELETON_TREE: PaneTreeLayout = treeFromShellLayout(DEFAULT_SHELL_LAYOUT);

/**
 * The docks the layout menu must ALWAYS list (T936), whatever the current tree holds.
 *
 * Ordered OUTERMOST FIRST, which is the skeleton's own nesting: the right sidebar is a
 * top-level column (T426), the bottom bar sits inside the work area beside it, and the
 * left dock sits inside the region above the bottom bar. That order is what makes a
 * restored dock land in the canonical place rather than merely somewhere on the right
 * side of the screen.
 */
export type BaselineRegion = "right" | "bottom" | "left";

export const BASELINE_REGIONS: readonly BaselineRegion[] = ["right", "bottom", "left"];

/**
 * Per region: the node ids that mean "this region is PRESENT", and the id a RESTORED one
 * takes.
 *
 * Two present-spellings for the sidebar, and that is not sloppiness: since T426 the right
 * dock is a COLUMN SPLIT of two zones (viewer over inspector), while a region recreated
 * from nothing is a single empty leaf — the same region, one node instead of three. Both
 * have to count, or restoring the sidebar would leave the menu still calling it absent.
 * The FIRST spelling is the one a collapse targets, so hiding the sidebar hides both
 * halves rather than only the top one.
 */
const REGION_NODES: Readonly<
  Record<BaselineRegion, { readonly present: readonly PaneKey[]; readonly leaf: PaneKey }>
> = {
  right: { present: ["split-right", "leaf-right"], leaf: "leaf-right" },
  bottom: { present: ["leaf-bottom"], leaf: "leaf-bottom" },
  left: { present: ["leaf-left"], leaf: "leaf-left" },
};

/** Every node id that can spell a baseline region — what the shell makes collapsible. */
export const BASELINE_REGION_NODE_IDS: readonly PaneKey[] = ["split-right", "leaf-right", "leaf-bottom", "leaf-left"];

export const BASELINE_REGION_LABELS: Readonly<Record<BaselineRegion, string>> = {
  right: "Right dock",
  bottom: "Bottom dock",
  left: "Left dock",
};

function findNode(node: LayoutNode, id: PaneKey): LayoutNode | undefined {
  if (node.id === id) return node;
  if (node.kind === "leaf") return undefined;
  return findNode(node.first, id) ?? findNode(node.second, id);
}

/**
 * Which node currently holds a baseline region, or null when nothing does — the third
 * state the layout menu needs (T936), and the id its collapse toggle targets.
 */
export function baselineRegionNode(layout: PaneTreeLayout, region: BaselineRegion): PaneKey | null {
  for (const id of REGION_NODES[region].present) {
    if (findNode(layout.root, id) !== undefined) return id;
  }
  return null;
}

/**
 * Where a region sits, read off the SKELETON: the direction of the split that creates it,
 * that split's FIRST-CHILD share, and which side of it the region is on.
 *
 * Read, not written. `split-main` is 23/77 with the left dock first; `split-rows` is
 * 72/28 with the bottom second; `split-columns` is 74/26 with the sidebar second. Change
 * the flat default and every door moves together.
 */
export function baselinePlacement(region: BaselineRegion): {
  readonly direction: "row" | "column";
  readonly ratio: number;
  readonly side: "first" | "second";
} {
  const target = REGION_NODES[region].present[0]!;
  const walk = (node: LayoutNode): ReturnType<typeof baselinePlacement> | null => {
    if (node.kind === "leaf") return null;
    if (node.first.id === target) return { direction: node.direction, ratio: node.ratio, side: "first" };
    if (node.second.id === target) return { direction: node.direction, ratio: node.ratio, side: "second" };
    return walk(node.first) ?? walk(node.second);
  };
  const found = walk(SKELETON_TREE.root);
  if (found === null) throw new Error(`the skeleton has no ${region} region`);
  return found;
}

/**
 * The subtree a restored region wraps.
 *
 * Walks the skeleton's nesting OUTSIDE-IN, stepping past every region further out than
 * this one that is actually present: the sidebar is outside the bottom bar, which is
 * outside the left dock. So restoring the left dock lands it beside the graph — inside
 * the work area, above the bottom bar, left of the sidebar — rather than beside whatever
 * subtree happens to sit first in the tree.
 *
 * "Present" is tested against the SUBTREE, not against a node id at that exact position,
 * which is what makes it survive a rearranged shell: T932's bottom region is
 * `split-bottom` holding two columns, and `leaf-bottom` is one of its children rather
 * than the child of `split-rows` the skeleton names. A region the shell does not have is
 * simply not stepped past, so restoring the bottom bar into a sidebar-less shell wraps
 * the whole tree instead of half of it.
 */
export function baselineAnchor(layout: PaneTreeLayout, region: BaselineRegion): PaneKey {
  let anchor: LayoutNode = layout.root;
  for (const outer of BASELINE_REGIONS) {
    if (outer === region) break;
    const placement = baselinePlacement(outer);
    if (anchor.kind !== "split" || anchor.direction !== placement.direction) continue;
    const occupied = placement.side === "first" ? anchor.first : anchor.second;
    const sibling = placement.side === "first" ? anchor.second : anchor.first;
    if (baselineRegionNode({ ...layout, root: occupied }, outer) === null) continue;
    anchor = sibling;
  }
  return anchor.id;
}

/**
 * Wraps the subtree `nodeId` in a NEW split, with a fresh EMPTY leaf on `side`.
 *
 * ⚑ The primitive the tree API was missing, and T936 is what found it. `splitLeaf` wraps
 * a LEAF and `spawnEdge` wraps the ROOT; the canonical bottom bar is neither — once a
 * sidebar exists it wraps the work area, an interior split. Restoring it was expressible
 * only as "reset the whole layout", which is the bug T936 exists to fix.
 *
 * EMPTY on purpose (T853's picker): a restored dock must not reopen a pane the user
 * deliberately moved out of it. Guessing a default tab would make "bring the left dock
 * back" and "put the node library back" the same button, and they are not.
 */
export function insertBeside(
  layout: PaneTreeLayout,
  nodeId: PaneKey,
  options: {
    readonly direction: "row" | "column";
    readonly ratio: number;
    readonly side: "first" | "second";
    /** The fresh leaf's id. Canonical for a baseline region, so the menu finds it again. */
    readonly leafId: PaneKey;
  },
): PaneTreeLayout {
  if (findNode(layout.root, nodeId) === undefined) return layout;
  if (findNode(layout.root, options.leafId) !== undefined) return layout; // ids are identities
  const fresh: LeafNode = { kind: "leaf", id: options.leafId, tabs: [], active: null };
  const splitId = `split-${layout.nextKey}`;
  const ratio = Math.max(5, Math.min(95, options.ratio));
  const wrap = (node: LayoutNode): LayoutNode => {
    if (node.id === nodeId) {
      return {
        kind: "split",
        id: splitId,
        direction: options.direction,
        ratio,
        first: options.side === "first" ? fresh : node,
        second: options.side === "first" ? node : fresh,
      } satisfies SplitNode;
    }
    if (node.kind === "leaf") return node;
    return { ...node, first: wrap(node.first), second: wrap(node.second) };
  };
  return { ...layout, root: wrap(layout.root), nextKey: layout.nextKey + 1 };
}

/**
 * T936 — bring an ABSENT baseline dock back, at its canonical position and stock ratio,
 * INSERTING it into the arrangement the user already has.
 *
 * Not a reset. Every other leaf, ratio and tab order comes through untouched; the only
 * change is one new split wrapping the anchor. A restore that discarded the rest would
 * be the bug it exists to fix — §T931 made a dock destroyable by dragging its last tab
 * out, and "reset the whole layout" was the only way back.
 */
export function restoreBaselineRegion(layout: PaneTreeLayout, region: BaselineRegion): PaneTreeLayout {
  if (baselineRegionNode(layout, region) !== null) return layout; // already there
  const placement = baselinePlacement(region);
  return insertBeside(layout, baselineAnchor(layout, region), {
    direction: placement.direction,
    // The skeleton's ratio is already the SPLIT's first-child share, and `insertBeside`
    // builds the split the same way round — so it carries over with no inversion.
    ratio: placement.ratio,
    side: placement.side,
    leafId: REGION_NODES[region].leaf,
  });
}

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

/**
 * T599: bring a role's tab to the FRONT — restore it if closed, then make it the
 * active tab of its leaf. The "+N more" chip on a node runs `ui.showProblems`, and a
 * door that opens onto a tab hidden behind another tab is not a door. A floating tab
 * is already its own window and is left where it is.
 */
export function revealRole(layout: PaneTreeLayout, role: PaneRole): PaneTreeLayout {
  if (layout.floating.some((tab) => tab.role === role)) return layout;
  const restored = restoreRole(layout, role);
  const leaf = leavesOf(restored.root).find((entry) => entry.tabs.some((tab) => tab.role === role));
  const key = leaf?.tabs.find((tab) => tab.role === role)?.key;
  if (leaf === undefined || key === undefined) return restored;
  return selectTab(restored, leaf.id, key);
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
