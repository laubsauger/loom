import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ImperativePanelHandle } from "react-resizable-panels";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Button } from "@ui/primitives/button.tsx";
import { PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "@ui/primitives/popover.tsx";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import { cx } from "@ui/cx.ts";
import { AppRuntimeContext } from "./app-context.ts";
import { PaneLeafView } from "./pane-leaf.tsx";
import type { LeafTabDescriptor, LeafTarget } from "./pane-leaf.tsx";
import { PaneEmpty } from "./pane.tsx";
import { PaneContent, PaneHostProvider } from "./pane-portal.tsx";
import { FloatingPane } from "./pane-window.tsx";
import type { OpenPaneWindow } from "./pane-window.tsx";
import { registerLayoutCommands } from "./layout-commands.ts";
import { TopBar } from "./top-bar.tsx";
import type { LayoutStorage, PaneId } from "./layout-storage.ts";
import { PANE_IDS, PANE_TITLES, clearLegacyLayout, isPresetLayoutId } from "./layout-storage.ts";
import {
  addTab,
  allTabs,
  assignRole,
  restoreRole,
  closeLeaf,
  closeTab,
  dockTab,
  findLeaf,
  floatTab,
  leavesOf,
  moveTab,
  moveTabToEdge,
  spawnEdge,
  spawnableEdges,
  selectTab,
  setSplitRatio,
  splitLeaf,
  DEFAULT_PANE_TREE,
} from "./pane-tree.ts";
import type { ShellEdge, LayoutNode, PaneKey, PaneRole, PaneTreeLayout } from "./pane-tree.ts";
import {
  allNamedPaneTrees,
  applyNamedPaneTree,
  deleteNamedPaneTree,
  isPaneTreeModified,
  readPaneTreeStore,
  renameNamedPaneTree,
  savePaneTreeAs,
  updateNamedPaneTree,
  writePaneTreeStore,
} from "./pane-tree-storage.ts";
import type { NamedPaneTree, PaneTreeStore } from "./pane-tree-storage.ts";
import { DEFAULT_LAYOUT_ID } from "./layout-storage.ts";
import styles from "./app-shell.module.css";

const HIT_AREA = { coarse: 12, fine: 6 } as const;

/**
 * The canonical leaves keep their human names; anything the user split is named by what
 * it currently shows. The three ids the layout menu's dock toggles collapse are the
 * migration skeleton's own — a rearranged shell simply has fewer toggles, not wrong ones.
 */
const CANONICAL_LEAF_NAMES: Readonly<Record<string, string>> = {
  "leaf-left": "Left dock",
  "leaf-center": "Centre dock",
  "leaf-right": "Right dock top",
  "leaf-rightBottom": "Right dock bottom",
  "leaf-bottom": "Bottom dock",
};

/** Panel ids the layout menu can collapse, when the current tree still has them. */
const TOGGLE_TARGETS: ReadonlyArray<{ readonly id: string; readonly label: string }> = [
  { id: "leaf-left", label: "Left dock" },
  { id: "split-right", label: "Right dock" },
  { id: "leaf-bottom", label: "Bottom dock" },
];
const COLLAPSIBLE_IDS = new Set(TOGGLE_TARGETS.map((target) => target.id));

/** The canonical splits keep the divider names the flat shell taught (§V19). */
const SPLIT_HANDLE_NAMES: Readonly<Record<string, string>> = {
  "split-columns": "Resize right dock",
  "split-rows": "Resize bottom dock",
  "split-main": "Resize left dock",
  "split-right": "Resize sidebar split",
};

export interface AppShellProps {
  /** Replaces the whole top bar. Defaults to the stock transport/metrics bar. */
  topBar?: ReactNode;
  /**
   * App-wide notices, rendered under the header and above everything else: autosave
   * unavailable, a halted GPU, a restorable snapshot. Full width because each one is a
   * decision the user has to be able to see and act on from anywhere in the app.
   */
  notices?: ReactNode;
  nodeLibrary?: ReactNode;
  /** Component catalogue. Shares a leaf with the node library — both ADD (§V93). */
  componentLibrary?: ReactNode;
  graphCanvas?: ReactNode;
  inspector?: ReactNode;
  viewer?: ReactNode;
  shaderEditor?: ReactNode;
  problems?: ReactNode;
  performance?: ReactNode;
  /** Example projects. Its own pane, never a tab beside the two additive ones (§V93). */
  exampleLibrary?: ReactNode;
  /** Agent presence: what the agent is doing, and what is waiting for review (§V42). */
  agent?: ReactNode;
  problemCount?: number;
  /**
   * Layout store override. Defaults to `localStorage` (V18); pass `null` to run
   * without persistence, or a fake in tests.
   */
  storage?: LayoutStorage | null;
  /** Window opener for floated panes (§V97). Injectable so a test needs no popup. */
  openPaneWindow?: OpenPaneWindow;
  /** A float that the browser refused. The pane is docked again; say so on screen. */
  onFloatBlocked?: (role: PaneId) => void;
}

/**
 * App shell (§I.ui, T4, T191, T192, T193, T426, T436 — re-founded on the TREE, T404).
 *
 * ## The arrangement is a TREE of splits whose leaves are tab groups (V340)
 *
 * The five fixed zones became the DEFAULT arrangement rather than the only one: the
 * layout is a binary tree of {direction, ratio} splits, each leaf an ordered tab group,
 * and every tab is an IDENTITY (a minted key) wearing a ROLE (what it shows). Two
 * viewers are now a layout, not a contradiction. The v3 flat layout migrates in losslessly
 * and projects back OUT while the tree still fits it (`pane-tree-storage.ts`, V385).
 *
 * ## Moving never remounts
 *
 * §V96 unchanged, re-keyed: every tab's content renders ONCE, keyed by its pane KEY,
 * and is portalled into a container that never changes for the life of the tab
 * (`pane-portal.tsx`). A leaf renders OUTLETS; relocation moves DOM. React never sees a
 * pane change position — CodeMirror keeps its undo history, a viewer keeps its canvas
 * and its presentation handle, focus survives.
 *
 * ## §V16 and §V18
 *
 * Split ratios are written straight to the store ref at drag rate and NEVER re-render
 * the pane tree; structure (splits, tabs, floating) is React state because it changes
 * once per gesture. Both persist to `localStorage` and never the project document.
 * Restoring a named layout bumps a generation key so every group remounts at its
 * stored ratios — the one moment sizes must flow imperatively.
 */
export function AppShell({
  topBar,
  notices,
  nodeLibrary,
  componentLibrary,
  graphCanvas,
  inspector,
  viewer,
  shaderEditor,
  problems,
  performance,
  exampleLibrary,
  agent,
  problemCount = 0,
  storage,
  openPaneWindow,
  onFloatBlocked,
}: AppShellProps) {
  const initial = useMemo(() => readPaneTreeStore(storage), [storage]);
  const storeRef = useRef<PaneTreeStore>(initial);
  const [tree, setTree] = useState<PaneTreeLayout>(initial.current);
  /** Bumped when stored ratios must win over live panel sizes (restore, reset). */
  const [generation, setGeneration] = useState(0);
  const [dragging, setDragging] = useState<PaneKey | null>(null);
  /**
   * What the layout menu renders. The live layout is deliberately NOT refreshed at drag
   * rate (§V16), so the menu takes a SNAPSHOT: refreshed when it opens, and whenever a
   * named layout changes — exactly when its "modified" mark has to be honest.
   */
  const [menuStore, setMenuStore] = useState<PaneTreeStore>(initial);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const panelRefs = useRef(new Map<string, ImperativePanelHandle | null>());

  // The layout the shell actually mounted with is the layout we store: a repaired,
  // MIGRATED or defaulted entry is normalised back immediately — v4 written, the v3
  // projection written or cleared (V385), v2's key dropped — so what is on screen and
  // what is persisted never disagree (V18).
  useEffect(() => {
    writePaneTreeStore(storeRef.current, storage);
    clearLegacyLayout(storage);
  }, [storage]);

  const persist = useCallback(
    (next: PaneTreeStore) => {
      storeRef.current = next;
      writePaneTreeStore(next, storage);
    },
    [storage],
  );

  /** The one write path for a STRUCTURE change: ref, state and storage in step. */
  const applyLayout = useCallback(
    (change: (layout: PaneTreeLayout) => PaneTreeLayout) => {
      const next = change(storeRef.current.current);
      if (next === storeRef.current.current) return;
      persist({ ...storeRef.current, current: next });
      setTree(next);
    },
    [persist],
  );

  /** Ratio writes skip React entirely — a divider drag must not re-render panes (§V16). */
  const onRatio = useCallback(
    (splitId: PaneKey, sizes: number[]) => {
      const first = sizes[0];
      if (first === undefined) return;
      persist({
        ...storeRef.current,
        current: setSplitRatio(storeRef.current.current, splitId, first),
      });
    },
    [persist],
  );

  /** Double-click a divider → that split returns to its default (or even) ratio. */
  const resetSplit = useCallback(
    (splitId: PaneKey) => {
      const fallback = ((): number => {
        const walk = (node: LayoutNode): number | null => {
          if (node.kind === "leaf") return null;
          if (node.id === splitId) return node.ratio;
          return walk(node.first) ?? walk(node.second);
        };
        return walk(DEFAULT_PANE_TREE.root) ?? 50;
      })();
      applyLayout((layout) => setSplitRatio(layout, splitId, fallback));
      setGeneration((current) => current + 1);
    },
    [applyLayout],
  );

  const onSelect = useCallback(
    (leafId: PaneKey, key: PaneKey) => applyLayout((layout) => selectTab(layout, leafId, key)),
    [applyLayout],
  );
  const onMoveTab = useCallback(
    (key: PaneKey, leafId: PaneKey) => {
      setDragging(null);
      applyLayout((layout) => moveTab(layout, key, leafId));
    },
    [applyLayout],
  );
  const onFloat = useCallback(
    (key: PaneKey) => {
      setDragging(null);
      applyLayout((layout) => floatTab(layout, key));
    },
    [applyLayout],
  );
  const onDock = useCallback((key: PaneKey) => applyLayout((layout) => dockTab(layout, key)), [applyLayout]);
  const onCloseTab = useCallback(
    (key: PaneKey) => applyLayout((layout) => closeTab(layout, key)),
    [applyLayout],
  );
  const onSplit = useCallback(
    (leafId: PaneKey, direction: "row" | "column") =>
      applyLayout((layout) => splitLeaf(layout, leafId, direction)),
    [applyLayout],
  );
  const onCloseLeaf = useCallback(
    (leafId: PaneKey) => applyLayout((layout) => closeLeaf(layout, leafId)),
    [applyLayout],
  );
  const onAssignEmpty = useCallback(
    (leafId: PaneKey, role: PaneRole) => applyLayout((layout) => addTab(layout, leafId, role)),
    [applyLayout],
  );
  const onAssignRole = useCallback(
    (key: PaneKey, role: PaneRole) => applyLayout((layout) => assignRole(layout, key, role)),
    [applyLayout],
  );
  // T486 (V423): a closed role comes back through the menu — restored to the leaf it
  // left, or by re-splitting the area it lived in (the recipe stamped at close).
  const onRestoreRole = useCallback(
    (role: PaneRole) => applyLayout((layout) => restoreRole(layout, role)),
    [applyLayout],
  );
  // T494, door one: spawn an absent edge area empty — the role picker says what it shows.
  const onSpawnEdge = useCallback(
    (edge: ShellEdge) => applyLayout((layout) => spawnEdge(layout, edge).layout),
    [applyLayout],
  );
  // T494, door two: the same operation, entered by dragging a tab to the shell's edge.
  const onDropEdge = useCallback(
    (key: PaneKey, edge: ShellEdge) => {
      setDragging(null);
      applyLayout((layout) => moveTabToEdge(layout, key, edge));
    },
    [applyLayout],
  );

  /** RESTORE a named layout: the stored ratios must win, so the groups remount. */
  const restoreLayout = useCallback(
    (id: string) => {
      const next = applyNamedPaneTree(storeRef.current, id);
      if (next === storeRef.current) return;
      persist(next);
      setTree(next.current);
      setGeneration((current) => current + 1);
      setMenuStore(next);
    },
    [persist],
  );

  const mutateNamed = useCallback(
    (change: (store: PaneTreeStore) => PaneTreeStore) => {
      const next = change(storeRef.current);
      if (next === storeRef.current) return;
      persist(next);
      setMenuStore(next);
    },
    [persist],
  );

  /** Opening the menu is what refreshes its snapshot of the live layout. */
  const onMenuOpenChange = useCallback((next: boolean) => {
    if (next) setMenuStore(storeRef.current);
    setMenuOpen(next);
  }, []);

  const togglePanel = useCallback((id: string) => {
    const panel = panelRefs.current.get(id);
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }, []);

  // §V307 — the layout menu is opened by a COMMAND, so it reaches the palette and the
  // shortcut editor. The runtime is optional: the shell renders standalone in tests.
  const runtime = useContext(AppRuntimeContext);
  const bus = runtime?.bus ?? null;
  const commandHandlers = useMemo(
    () => ({ open: () => onMenuOpenChange(true), reset: () => restoreLayout(DEFAULT_LAYOUT_ID) }),
    [onMenuOpenChange, restoreLayout],
  );
  useEffect(() => {
    if (bus === null) return;
    const holder = registerLayoutCommands(bus);
    holder.current = commandHandlers;
    return () => {
      if (holder.current === commandHandlers) holder.current = null;
    };
  }, [bus, commandHandlers]);

  /** Role → what goes in it. The only place the shell's named slots are interpreted. */
  const contents = useMemo<Record<PaneId, ReactNode>>(
    () => ({
      library: nodeLibrary ?? <PaneEmpty label="No library" />,
      components: componentLibrary ?? <PaneEmpty label="No components" />,
      graph: <div className={styles.canvas}>{graphCanvas ?? <PaneEmpty label="No canvas" />}</div>,
      inspector: inspector ?? <PaneEmpty label="No selection" />,
      viewer: viewer ?? <PaneEmpty label="No output pinned" />,
      shader: shaderEditor ?? <PaneEmpty label="No shader selected" />,
      problems: problems ?? <PaneEmpty label="No problems" />,
      performance: performance ?? <PaneEmpty label="Not running" />,
      examples: exampleLibrary ?? <PaneEmpty label="No examples" />,
      agent: agent ?? <PaneEmpty label="No agent connected" />,
    }),
    [
      agent,
      componentLibrary,
      exampleLibrary,
      graphCanvas,
      inspector,
      nodeLibrary,
      performance,
      problems,
      shaderEditor,
      viewer,
    ],
  );

  const describe = useCallback(
    (tab: { key: PaneKey; role: PaneRole }): LeafTabDescriptor => ({
      key: tab.key,
      role: tab.role,
      title: PANE_TITLES[tab.role],
      ...(tab.role === "problems" ? { badge: problemCount } : {}),
    }),
    [problemCount],
  );

  const roleOptions = useMemo(
    () => PANE_IDS.map((role) => ({ role: role as PaneRole, title: PANE_TITLES[role] })),
    [],
  );

  const leaves = leavesOf(tree.root);
  const leafLabels = new Map<PaneKey, string>(
    leaves.map((leaf, index) => {
      const canonical = CANONICAL_LEAF_NAMES[leaf.id];
      if (canonical !== undefined) return [leaf.id, canonical];
      const activeRole = leaf.tabs.find((tab) => tab.key === leaf.active)?.role ?? leaf.tabs[0]?.role;
      return [leaf.id, activeRole !== undefined ? `${PANE_TITLES[activeRole]} area` : `Area ${index + 1}`];
    }),
  );

  const leafView = (leaf: Extract<LayoutNode, { kind: "leaf" }>): ReactNode => {
    const moveTargets: LeafTarget[] = leaves
      .filter((candidate) => candidate.id !== leaf.id)
      .map((candidate) => ({ id: candidate.id, label: leafLabels.get(candidate.id) ?? candidate.id }));
    return (
      <PaneLeafView
        leafId={leaf.id}
        label={leafLabels.get(leaf.id) ?? leaf.id}
        tabs={leaf.tabs.map(describe)}
        active={leaf.active}
        moveTargets={moveTargets}
        dragging={dragging}
        roleOptions={roleOptions}
        canCloseLeaf={leaves.length > 1}
        onSelect={onSelect}
        onMoveTab={onMoveTab}
        onFloat={onFloat}
        onCloseTab={onCloseTab}
        onDragTab={setDragging}
        onDropTab={onMoveTab}
        onSplit={onSplit}
        onCloseLeaf={onCloseLeaf}
        onAssignEmpty={onAssignEmpty}
        onAssignRole={onAssignRole}
      />
    );
  };

  /**
   * The tree, recursively: a split is a PanelGroup of two Panels around a handle, a
   * leaf is a tab group. Group keys carry the GENERATION so a layout restore remounts
   * them at their stored ratios; a live drag never re-renders anything (§V16 — the
   * ratio callback writes to the ref and storage only).
   */
  const renderNode = (node: LayoutNode): ReactNode => {
    if (node.kind === "leaf") return leafView(node);
    // Every panel is collapsible so a stored zero-size section (Classic's closed
    // sidebar row) mounts cleanly; only the canonical three get menu toggles.
    const panelProps = (child: LayoutNode) => ({
      collapsible: true,
      collapsedSize: 0,
      ...(COLLAPSIBLE_IDS.has(child.id)
        ? {
            ref: (handle: ImperativePanelHandle | null) => void panelRefs.current.set(child.id, handle),
            onCollapse: () => setCollapsed((prev) => ({ ...prev, [child.id]: true })),
            onExpand: () => setCollapsed((prev) => ({ ...prev, [child.id]: false })),
          }
        : {}),
    });
    return (
      <PanelGroup
        key={`${node.id}:${generation}`}
        className={node.id === "split-columns" ? styles.body : undefined}
        direction={node.direction === "row" ? "horizontal" : "vertical"}
        id={`group-${node.id}`}
        onLayout={(sizes) => onRatio(node.id, sizes)}
      >
        <Panel
          id={`panel-${node.id}-a`}
          order={1}
          minSize={8}
          defaultSize={node.ratio}
          {...panelProps(node.first)}
        >
          {renderNode(node.first)}
        </Panel>
        <PanelResizeHandle
          className={cx(styles.handle, node.direction === "row" ? styles.handleV : styles.handleH)}
          hitAreaMargins={HIT_AREA}
          aria-label={
            SPLIT_HANDLE_NAMES[node.id] ??
            `Resize ${leafLabels.get(node.first.kind === "leaf" ? node.first.id : node.second.kind === "leaf" ? node.second.id : node.id) ?? "split"}`
          }
          onDoubleClick={() => resetSplit(node.id)}
        />
        <Panel
          id={`panel-${node.id}-b`}
          order={2}
          minSize={8}
          defaultSize={100 - node.ratio}
          {...panelProps(node.second)}
        >
          {renderNode(node.second)}
        </Panel>
      </PanelGroup>
    );
  };

  const tabs = allTabs(tree);

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <PaneHostProvider>
        {/*
          Every tab's content, rendered exactly once and KEYED BY ITS PANE KEY (§V96,
          V340). These are portals: where one APPEARS is decided by whichever outlet
          currently owns its container, and moving it is a DOM operation, never a
          remount. Two tabs of one role are two instances, each with its own key.
        */}
        {tabs.map((tab) => (
          <PaneContent key={tab.key} paneId={tab.key}>
            {contents[tab.role]}
          </PaneContent>
        ))}

        {tree.floating.map((tab) => (
          <FloatingPane
            key={tab.key}
            paneId={tab.key}
            title={PANE_TITLES[tab.role]}
            onClose={onDock}
            {...(onFloatBlocked === undefined ? {} : { onBlocked: () => onFloatBlocked(tab.role) })}
            {...(openPaneWindow === undefined ? {} : { open: openPaneWindow })}
          />
        ))}

        <div className={styles.shell}>
          <header className={styles.topbar}>
            <div className={styles.topbarSlot}>{topBar ?? <TopBar />}</div>
            <div className={styles.topbarTrailing}>
              <LayoutMenu
                open={menuOpen}
                onOpenChange={onMenuOpenChange}
                store={menuStore}
                collapsed={collapsed}
                floating={tree.floating}
                absentRoles={PANE_IDS.filter((role) => !tabs.some((tab) => tab.role === role))}
                onRestoreRole={onRestoreRole}
                spawnEdges={spawnableEdges(tree)}
                onSpawnEdge={onSpawnEdge}
                presentToggles={TOGGLE_TARGETS.filter((target) =>
                  target.id.startsWith("leaf-")
                    ? findLeaf(tree, target.id) !== undefined
                    : hasSplit(tree.root, target.id),
                )}
                onToggle={togglePanel}
                onDock={onDock}
                onRestore={restoreLayout}
                onMutate={mutateNamed}
              />
            </div>
          </header>

          {/* Always present so the grid keeps three rows: an empty strip is 0 tall, and
              the body row stays `1fr` whether or not anything needs saying. */}
          <div className={styles.notices}>{notices}</div>

          <div className={styles.bodyWrap}>
            {tree.root.kind === "leaf" ? (
              <div className={styles.body}>{leafView(tree.root)}</div>
            ) : (
              renderNode(tree.root)
            )}
            {/* T494, door two: while a tab drags, absent edges become drop zones. The
                standard dockable gesture — drag to the outer edge, the area is created
                and the tab lands in it. Same tree operation as the menu row. */}
            {dragging !== null
              ? spawnableEdges(tree).map((edge) => (
                  <div
                    key={edge}
                    className={styles.edgeDrop}
                    data-edge={edge}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const key = event.dataTransfer.getData("text/x-shaderloom-pane") || dragging;
                      if (key) onDropEdge(key, edge);
                    }}
                  >
                    <span className={styles.edgeDropLabel}>new {edge} pane</span>
                  </div>
                ))
              : null}
          </div>
        </div>
      </PaneHostProvider>
    </TooltipProvider>
  );
}

function hasSplit(node: LayoutNode, id: string): boolean {
  if (node.kind === "leaf") return false;
  if (node.id === id) return true;
  return hasSplit(node.first, id) || hasSplit(node.second, id);
}

interface LayoutMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  store: PaneTreeStore;
  collapsed: Record<string, boolean>;
  floating: ReadonlyArray<{ readonly key: PaneKey; readonly role: PaneRole }>;
  /** T486 (V423): the roles with NO pane anywhere — the possibility space, not the tree. */
  absentRoles: readonly PaneId[];
  onRestoreRole: (role: PaneRole) => void;
  /** T494: shell edges with no dedicated area — offered for spawning, absent ones only (V423). */
  spawnEdges: readonly ShellEdge[];
  onSpawnEdge: (edge: ShellEdge) => void;
  presentToggles: ReadonlyArray<{ readonly id: string; readonly label: string }>;
  onToggle: (id: string) => void;
  onDock: (key: PaneKey) => void;
  onRestore: (id: string) => void;
  onMutate: (change: (store: PaneTreeStore) => PaneTreeStore) => void;
}

type Draft = { readonly mode: "save" | "rename"; readonly value: string };

/**
 * The layout menu (T436, §V90) — unchanged in shape, re-founded on the tree store.
 * "Save as…" is the only control that ever adds an entry; "Update" overwrites the
 * selected user layout and only while the live arrangement has actually drifted.
 */
function LayoutMenu({
  open,
  onOpenChange,
  store,
  collapsed,
  floating,
  absentRoles,
  onRestoreRole,
  spawnEdges,
  onSpawnEdge,
  presentToggles,
  onToggle,
  onDock,
  onRestore,
  onMutate,
}: LayoutMenuProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const entries: readonly NamedPaneTree[] = allNamedPaneTrees(store);
  const selected = entries.find((entry) => entry.id === store.currentId) ?? null;
  const editable = selected !== null && !isPresetLayoutId(selected.id);
  const modified = isPaneTreeModified(store);

  const closeDraft = () => setDraft(null);
  const submitDraft = () => {
    if (draft === null) return;
    const name = draft.value.trim();
    if (name === "") return;
    if (draft.mode === "save") onMutate((current) => savePaneTreeAs(current, name));
    else if (selected !== null) onMutate((current) => renameNamedPaneTree(current, selected.id, name));
    setDraft(null);
  };

  return (
    <PopoverRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) setDraft(null);
        onOpenChange(next);
      }}
    >
      <PopoverTrigger asChild>
        <Button aria-label="Layout">layout</Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverHeader>layouts</PopoverHeader>
        <div className={styles.layoutMenu}>
          <div className={styles.layoutList}>
            {entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className={cx(
                  styles.layoutEntry,
                  entry.id === store.currentId ? styles.layoutEntryCurrent : undefined,
                )}
                {...(entry.id === store.currentId ? { "aria-current": "true" as const } : {})}
                onClick={() => onRestore(entry.id)}
              >
                <span className={styles.layoutName}>{entry.name}</span>
                {entry.id === store.currentId && modified ? (
                  <span className={styles.layoutModified}>modified</span>
                ) : null}
              </button>
            ))}
          </div>

          {draft === null ? (
            <div className={styles.layoutActions}>
              <Button
                variant="outline"
                size="md"
                onClick={() => setDraft({ mode: "save", value: "" })}
              >
                Save as…
              </Button>
              <Button
                variant="outline"
                size="md"
                disabled={!editable || !modified}
                onClick={() => {
                  if (selected !== null) onMutate((current) => updateNamedPaneTree(current, selected.id));
                }}
              >
                Update
              </Button>
              <Button
                variant="outline"
                size="md"
                disabled={!editable}
                onClick={() => setDraft({ mode: "rename", value: selected?.name ?? "" })}
              >
                Rename
              </Button>
              <Button
                variant="outline"
                size="md"
                disabled={!editable}
                onClick={() => {
                  if (selected !== null) onMutate((current) => deleteNamedPaneTree(current, selected.id));
                }}
              >
                Delete
              </Button>
            </div>
          ) : (
            <div className={styles.layoutActions}>
              <input
                className={styles.layoutInput}
                aria-label={draft.mode === "save" ? "New layout name" : "Layout name"}
                value={draft.value}
                autoFocus
                onChange={(event) => setDraft({ mode: draft.mode, value: event.target.value })}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    submitDraft();
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    closeDraft();
                  }
                }}
              />
              <Button variant="outline" size="md" onClick={submitDraft}>
                {draft.mode === "save" ? "Save" : "Rename"}
              </Button>
              <Button variant="outline" size="md" onClick={closeDraft}>
                Cancel
              </Button>
            </div>
          )}

          <PopoverHeader>panes</PopoverHeader>
          {presentToggles.map((target) => (
            <div key={target.id} className={styles.layoutRow}>
              <span>{target.label}</span>
              <Button
                aria-label={target.label}
                aria-pressed={collapsed[target.id] !== true}
                onClick={() => onToggle(target.id)}
              >
                {collapsed[target.id] === true ? "hidden" : "shown"}
              </Button>
            </div>
          ))}
          {floating.map((tab) => (
            <div key={tab.key} className={styles.layoutRow}>
              <span>{PANE_TITLES[tab.role]} (window)</span>
              <Button aria-label={`Dock ${PANE_TITLES[tab.role]}`} onClick={() => onDock(tab.key)}>
                dock
              </Button>
            </div>
          ))}
          {/* T486 (V423): a control listing what is PRESENT cannot restore what is
              ABSENT — closed roles are offered here, and grow only with the user's own
              closes, never with the catalogue. */}
          {absentRoles.map((role) => (
            <div key={role} className={styles.layoutRow}>
              <span>{PANE_TITLES[role]} (closed)</span>
              <Button aria-label={`Restore ${PANE_TITLES[role]}`} onClick={() => onRestoreRole(role)}>
                restore
              </Button>
            </div>
          ))}
          {/* T494 (V423 both ways): absent EDGES are offered as fresh empty areas —
              only while absent, so the menu never grows with what already exists. */}
          {spawnEdges.map((edge) => (
            <div key={edge} className={styles.layoutRow}>
              <span>{edge} area (none)</span>
              <Button aria-label={`New ${edge} pane`} onClick={() => onSpawnEdge(edge)}>
                spawn
              </Button>
            </div>
          ))}
          <p className={styles.layoutHint}>Drag a tab onto another area, or use its move menu.</p>
          <p className={styles.layoutHint}>
            Drag a divider to resize, double-click it to reset. A focused divider resizes with the
            arrow keys and collapses with Enter.
          </p>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
