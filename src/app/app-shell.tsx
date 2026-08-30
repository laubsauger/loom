import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { ImperativePanelGroupHandle, ImperativePanelHandle } from "react-resizable-panels";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Button } from "@ui/primitives/button.tsx";
import { PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "@ui/primitives/popover.tsx";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import { cx } from "@ui/cx.ts";
import { AppRuntimeContext } from "./app-context.ts";
import { DockZoneView, DropZoneOverlay } from "./dock-zone.tsx";
import { PaneEmpty } from "./pane.tsx";
import { PaneContent, PaneHostProvider } from "./pane-portal.tsx";
import { FloatingPane } from "./pane-window.tsx";
import type { OpenPaneWindow } from "./pane-window.tsx";
import { registerLayoutCommands } from "./layout-commands.ts";
import { TopBar } from "./top-bar.tsx";
import type {
  DockZone,
  LayoutStorage,
  LayoutStore,
  NamedLayout,
  PaneDescriptor,
  PaneId,
  ShellLayout,
} from "./layout-storage.ts";
import {
  DEFAULT_LAYOUT_ID,
  DEFAULT_SHELL_LAYOUT,
  PANE_IDS,
  PANE_TITLES,
  allNamedLayouts,
  applyNamedLayout,
  clearLegacyLayout,
  deleteNamedLayout,
  dockPane,
  floatPane,
  isLayoutModified,
  isPresetLayoutId,
  movePane,
  readLayoutStore,
  renameNamedLayout,
  saveLayoutAs,
  selectPane,
  updateNamedLayout,
  writeLayoutStore,
} from "./layout-storage.ts";
import styles from "./app-shell.module.css";

/** The four resizable groups the shell is built from (T426). */
type GroupKey = "columns" | "mainColumns" | "rows" | "rightRows";

/** Panels the shell drives imperatively: the collapsible docks. */
type PanelKey = "left" | "bottom" | "right" | "rightTop" | "rightBottom";

const HIT_AREA = { coarse: 12, fine: 6 } as const;

/** The mutable half of the arrangement — what a move changes, and what re-renders. */
type Arrangement = Pick<ShellLayout, "zones" | "active" | "floating">;

function arrangementOf(layout: ShellLayout): Arrangement {
  return { zones: layout.zones, active: layout.active, floating: layout.floating };
}

const ZONE_NAMES: Readonly<Record<DockZone, string>> = {
  left: "Left dock",
  center: "Centre dock",
  right: "Right dock top",
  rightBottom: "Right dock bottom",
  bottom: "Bottom dock",
};

/**
 * A dock panel collapses to nothing when there is no pane to put in it. The right
 * sidebar's own panel goes with BOTH its sections: two collapsed siblings cannot both be
 * zero in one group, so the column itself has to be the thing that closes.
 */
const AUTO_COLLAPSE: Readonly<Record<PanelKey, (zones: Arrangement["zones"]) => boolean>> = {
  // Parent first: expanding a section inside a collapsed column has to find it open.
  right: (zones) => zones.right.length === 0 && zones.rightBottom.length === 0,
  left: (zones) => zones.left.length === 0,
  bottom: (zones) => zones.bottom.length === 0,
  rightTop: (zones) => zones.right.length === 0,
  rightBottom: (zones) => zones.rightBottom.length === 0,
};

const PANEL_KEYS = Object.keys(AUTO_COLLAPSE) as readonly PanelKey[];

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
  /** Component catalogue. Shares the left dock with the node library — both ADD (§V93). */
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
  onFloatBlocked?: (paneId: PaneId) => void;
}

/**
 * App shell (§I.ui, T4, T191, T192, T193, T426, T436).
 *
 * ## The shape of the window (T426)
 *
 * The RIGHT SIDEBAR is a top-level column, so it runs the full height of the window
 * instead of stopping where the bottom dock begins, and it is split horizontally: the
 * viewer on top, the inspector under it. The bottom dock spans the left and centre
 * columns — that is the half of the window it belongs to, and keeping the shader editor
 * as wide as it was is why the left dock was left alone.
 *
 * Four resizable groups, each persisted under its own name: `columns` (work area |
 * sidebar), `mainColumns` (left | centre), `rows` (centre | bottom) and `rightRows`
 * (sidebar top | sidebar bottom).
 *
 * ## The arrangement is data
 *
 * §V95: no pane is nailed to a slot. Five dock zones each hold an ordered list of panes
 * read from `ShellLayout`, and a pane moves by rewriting that list: by dragging its tab
 * onto a drop band, or from its zone's move menu, which is the keyboard path (§V19).
 * Floating a pane (§V97) takes it out of every zone and into its own window; it is still
 * the same pane, in the same React tree, on the same bus.
 *
 * ## Moving never remounts
 *
 * §V96: every pane's content is rendered ONCE, here, in a fixed order over the constant
 * `PANE_IDS`, and portalled into a container that never changes for the life of the app
 * (`pane-portal.tsx`). A zone renders an OUTLET, and relocation moves the container's DOM
 * into it. React therefore never sees a pane change position: CodeMirror keeps its undo
 * history, a preview keeps its tile and its presentation handle, and a focused control
 * keeps focus.
 *
 * ## §V16 and §V18
 *
 * Panel sizes live in a ref and are written straight to storage — resizing must not
 * re-render the pane tree at pointer rate. The arrangement is React state because it
 * changes once per gesture. Both are persisted to `localStorage` and NEVER to the project
 * document (§V18).
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
  const initial = useMemo(() => readLayoutStore(storage), [storage]);
  const storeRef = useRef<LayoutStore>(initial);
  const [arrangement, setArrangement] = useState<Arrangement>(() =>
    arrangementOf(initial.current),
  );
  const [dragging, setDragging] = useState<PaneId | null>(null);
  /**
   * What the layout menu renders. The live layout is deliberately NOT React state
   * (§V16 — resizing must not re-render the pane tree at pointer rate), so the menu takes
   * a SNAPSHOT: refreshed when it opens, and again whenever a named layout changes. That
   * is exactly the moment its "modified" mark has to be true, and never in between.
   */
  const [menuStore, setMenuStore] = useState<LayoutStore>(initial);
  const [menuOpen, setMenuOpen] = useState(false);

  const groups: Record<GroupKey, RefObject<ImperativePanelGroupHandle | null>> = {
    columns: useRef<ImperativePanelGroupHandle>(null),
    mainColumns: useRef<ImperativePanelGroupHandle>(null),
    rows: useRef<ImperativePanelGroupHandle>(null),
    rightRows: useRef<ImperativePanelGroupHandle>(null),
  };
  const panels: Record<PanelKey, RefObject<ImperativePanelHandle | null>> = {
    left: useRef<ImperativePanelHandle>(null),
    bottom: useRef<ImperativePanelHandle>(null),
    right: useRef<ImperativePanelHandle>(null),
    rightTop: useRef<ImperativePanelHandle>(null),
    rightBottom: useRef<ImperativePanelHandle>(null),
  };
  const [collapsed, setCollapsed] = useState({ left: false, right: false, bottom: false });

  // The layout the shell actually mounted with is the layout we store: a repaired,
  // MIGRATED or defaulted entry is normalised back into the store immediately, so what is
  // on screen and what is persisted never disagree (V18). v2's key goes at the same time
  // — one key holds the layout, and a stale one would be read again on a downgrade.
  useEffect(() => {
    writeLayoutStore(storeRef.current, storage);
    clearLegacyLayout(storage);
  }, [storage]);

  const persist = useCallback(
    (next: LayoutStore) => {
      storeRef.current = next;
      writeLayoutStore(next, storage);
    },
    [storage],
  );

  const persistGroup = useCallback(
    (key: GroupKey, sizes: number[]) => {
      persist({ ...storeRef.current, current: { ...storeRef.current.current, [key]: sizes } });
    },
    [persist],
  );

  /** The one write path for an arrangement change: ref, state and storage in step. */
  const apply = useCallback(
    (change: (layout: ShellLayout) => ShellLayout) => {
      const next = change(storeRef.current.current);
      if (next === storeRef.current.current) return;
      persist({ ...storeRef.current, current: next });
      setArrangement(arrangementOf(next));
    },
    [persist],
  );

  const onSelect = useCallback(
    (zone: DockZone, paneId: PaneId) => apply((layout) => selectPane(layout, zone, paneId)),
    [apply],
  );
  const onMove = useCallback(
    (paneId: PaneId, zone: DockZone) => {
      setDragging(null);
      apply((layout) => movePane(layout, paneId, zone));
    },
    [apply],
  );
  const onFloat = useCallback(
    (paneId: PaneId) => {
      setDragging(null);
      apply((layout) => floatPane(layout, paneId));
    },
    [apply],
  );
  const onDock = useCallback((paneId: PaneId) => apply((layout) => dockPane(layout, paneId)), [apply]);

  /** Pushes a stored split onto a live group. A group that has not registered its panels
   *  yet (pre-layout-effect, server render) throws on setLayout, so it is skipped. */
  const pushGroup = useCallback((key: GroupKey, sizes: readonly number[]) => {
    const group = groups[key].current;
    if (group && group.getLayout().length === sizes.length) group.setLayout([...sizes]);
    // `groups` holds refs created on the first render and never replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Double-click a divider → that group returns to its default split. */
  const resetGroup = useCallback(
    (key: GroupKey) => {
      pushGroup(key, DEFAULT_SHELL_LAYOUT[key]);
      persistGroup(key, [...DEFAULT_SHELL_LAYOUT[key]]);
    },
    [persistGroup, pushGroup],
  );

  /** RESTORE a named layout: sizes onto the live groups, arrangement into React. */
  const restoreLayout = useCallback(
    (id: string) => {
      const next = applyNamedLayout(storeRef.current, id);
      if (next === storeRef.current) return;
      persist(next);
      for (const key of ["columns", "mainColumns", "rows", "rightRows"] as const) {
        pushGroup(key, next.current[key]);
      }
      setArrangement(arrangementOf(next.current));
      setMenuStore(next);
    },
    [persist, pushGroup],
  );

  const mutateNamed = useCallback(
    (change: (store: LayoutStore) => LayoutStore) => {
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

  const togglePane = useCallback((key: PanelKey) => {
    const panel = panels[key].current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
    // `panels` holds refs created on the first render and never replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // §V307 — the layout menu is opened by a COMMAND, so it reaches the palette and the
  // shortcut editor. The runtime is optional: the shell renders standalone in tests and
  // in Storybook-style harnesses, where there is no bus to register against.
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

  // A zone with nothing in it is 0 tall or 0 wide. Collapsing it on the way to empty and
  // expanding it when a pane arrives is what makes dragging the last pane out of a zone
  // give the space back instead of leaving a titled void.
  const emptinessRef = useRef<Partial<Record<PanelKey, boolean>>>({});
  useEffect(() => {
    for (const key of PANEL_KEYS) {
      const empty = AUTO_COLLAPSE[key](arrangement.zones);
      if (emptinessRef.current[key] === empty) continue;
      emptinessRef.current[key] = empty;
      const panel = panels[key].current;
      if (panel === null) continue;
      if (empty) panel.collapse();
      else panel.expand();
    }
    // `panels` holds refs created on the first render and never replaced.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrangement.zones]);

  /** Pane id → what goes in it. The only place the shell's named slots are interpreted. */
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
    (paneId: PaneId): PaneDescriptor => ({
      id: paneId,
      title: PANE_TITLES[paneId],
      ...(paneId === "problems" ? { badge: problemCount } : {}),
    }),
    [problemCount],
  );

  const zoneView = (zone: DockZone) => (
    <DockZoneView
      zone={zone}
      label={ZONE_NAMES[zone]}
      panes={arrangement.zones[zone].map(describe)}
      active={arrangement.active[zone]}
      onSelect={onSelect}
      onMove={onMove}
      onFloat={onFloat}
      onDragPane={setDragging}
    />
  );

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <PaneHostProvider>
        {/*
          Every pane's content, rendered exactly once, in a constant order (§V96). These
          are portals: where they APPEAR is decided by whichever outlet currently owns the
          pane's container, and moving one is a DOM operation, never a remount.
        */}
        {PANE_IDS.map((paneId) => (
          <PaneContent key={paneId} paneId={paneId}>
            {contents[paneId]}
          </PaneContent>
        ))}

        {arrangement.floating.map((paneId) => (
          <FloatingPane
            key={paneId}
            paneId={paneId}
            title={PANE_TITLES[paneId]}
            onClose={onDock}
            {...(onFloatBlocked === undefined ? {} : { onBlocked: onFloatBlocked })}
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
                floating={arrangement.floating}
                onToggle={togglePane}
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
            <PanelGroup
              className={styles.body}
              direction="horizontal"
              id="shell-columns"
              ref={groups.columns}
              onLayout={(sizes) => persistGroup("columns", sizes)}
            >
              <Panel id="shell-work" order={1} minSize={30} defaultSize={initial.current.columns[0]}>
                <PanelGroup
                  direction="vertical"
                  id="shell-rows"
                  ref={groups.rows}
                  onLayout={(sizes) => persistGroup("rows", sizes)}
                >
                  <Panel id="shell-main" order={1} minSize={30} defaultSize={initial.current.rows[0]}>
                    <PanelGroup
                      direction="horizontal"
                      id="shell-main-columns"
                      ref={groups.mainColumns}
                      onLayout={(sizes) => persistGroup("mainColumns", sizes)}
                    >
                      <Panel
                        id="shell-left"
                        order={1}
                        minSize={12}
                        defaultSize={initial.current.mainColumns[0]}
                        collapsible
                        collapsedSize={0}
                        ref={panels.left}
                        onCollapse={() => setCollapsed((prev) => ({ ...prev, left: true }))}
                        onExpand={() => setCollapsed((prev) => ({ ...prev, left: false }))}
                      >
                        {zoneView("left")}
                      </Panel>

                      <PanelResizeHandle
                        className={cx(styles.handle, styles.handleV)}
                        hitAreaMargins={HIT_AREA}
                        aria-label="Resize left dock"
                        onDoubleClick={() => resetGroup("mainColumns")}
                      />

                      <Panel
                        id="shell-center"
                        order={2}
                        minSize={25}
                        defaultSize={initial.current.mainColumns[1]}
                      >
                        {zoneView("center")}
                      </Panel>
                    </PanelGroup>
                  </Panel>

                  <PanelResizeHandle
                    className={cx(styles.handle, styles.handleH)}
                    hitAreaMargins={HIT_AREA}
                    aria-label="Resize bottom dock"
                    onDoubleClick={() => resetGroup("rows")}
                  />

                  <Panel
                    id="shell-bottom"
                    order={2}
                    minSize={12}
                    defaultSize={initial.current.rows[1]}
                    collapsible
                    collapsedSize={0}
                    ref={panels.bottom}
                    onCollapse={() => setCollapsed((prev) => ({ ...prev, bottom: true }))}
                    onExpand={() => setCollapsed((prev) => ({ ...prev, bottom: false }))}
                  >
                    {zoneView("bottom")}
                  </Panel>
                </PanelGroup>
              </Panel>

              <PanelResizeHandle
                className={cx(styles.handle, styles.handleV)}
                hitAreaMargins={HIT_AREA}
                aria-label="Resize right dock"
                onDoubleClick={() => resetGroup("columns")}
              />

              {/* T426: a TOP-LEVEL column, which is what makes it full height. */}
              <Panel
                id="shell-right"
                order={2}
                minSize={14}
                defaultSize={initial.current.columns[1]}
                collapsible
                collapsedSize={0}
                ref={panels.right}
                onCollapse={() => setCollapsed((prev) => ({ ...prev, right: true }))}
                onExpand={() => setCollapsed((prev) => ({ ...prev, right: false }))}
              >
                <PanelGroup
                  direction="vertical"
                  id="shell-right-rows"
                  ref={groups.rightRows}
                  onLayout={(sizes) => persistGroup("rightRows", sizes)}
                >
                  <Panel
                    id="shell-right-top"
                    order={1}
                    minSize={10}
                    defaultSize={initial.current.rightRows[0]}
                    collapsible
                    collapsedSize={0}
                    ref={panels.rightTop}
                  >
                    {zoneView("right")}
                  </Panel>

                  <PanelResizeHandle
                    className={cx(styles.handle, styles.handleH)}
                    hitAreaMargins={HIT_AREA}
                    aria-label="Resize sidebar split"
                    onDoubleClick={() => resetGroup("rightRows")}
                  />

                  <Panel
                    id="shell-right-bottom"
                    order={2}
                    minSize={10}
                    defaultSize={initial.current.rightRows[1]}
                    collapsible
                    collapsedSize={0}
                    ref={panels.rightBottom}
                  >
                    {zoneView("rightBottom")}
                  </Panel>
                </PanelGroup>
              </Panel>
            </PanelGroup>

            {dragging === null ? null : (
              <DropZoneOverlay onDrop={(zone) => onMove(dragging, zone)} />
            )}
          </div>
        </div>
      </PaneHostProvider>
    </TooltipProvider>
  );
}

interface LayoutMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  store: LayoutStore;
  collapsed: { left: boolean; right: boolean; bottom: boolean };
  floating: readonly PaneId[];
  onToggle: (key: PanelKey) => void;
  onDock: (paneId: PaneId) => void;
  onRestore: (id: string) => void;
  onMutate: (change: (store: LayoutStore) => LayoutStore) => void;
}

type Draft = { readonly mode: "save" | "rename"; readonly value: string };

/**
 * The layout menu (T436, §V90).
 *
 * Named layouts and the pane controls in ONE on-demand popover rather than a permanent
 * strip of buttons. The list names the layouts and nothing else; the four verbs are a
 * single row that acts on the SELECTED one, so the menu does not grow a control per
 * layout as the list grows.
 *
 * ## UPDATE is not SAVE AS, and the menu says so
 *
 * "Save as…" is the only control that ever adds an entry, and it always asks for a name.
 * "Update" overwrites the selected layout, is only enabled while the live arrangement has
 * actually drifted from it, and is disabled outright on a preset — which is what stops a
 * layout list from turning into forty near-duplicates nobody dares delete.
 */
function LayoutMenu({
  open,
  onOpenChange,
  store,
  collapsed,
  floating,
  onToggle,
  onDock,
  onRestore,
  onMutate,
}: LayoutMenuProps) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const entries: readonly NamedLayout[] = allNamedLayouts(store);
  const selected = entries.find((entry) => entry.id === store.currentId) ?? null;
  const editable = selected !== null && !isPresetLayoutId(selected.id);
  const modified = isLayoutModified(store);

  const closeDraft = () => setDraft(null);
  const submitDraft = () => {
    if (draft === null) return;
    const name = draft.value.trim();
    if (name === "") return;
    if (draft.mode === "save") onMutate((current) => saveLayoutAs(current, name));
    else if (selected !== null) onMutate((current) => renameNamedLayout(current, selected.id, name));
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
                  if (selected !== null) onMutate((current) => updateNamedLayout(current, selected.id));
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
                  if (selected !== null) onMutate((current) => deleteNamedLayout(current, selected.id));
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
          {(["left", "right", "bottom"] as const).map((key) => (
            <PaneToggle
              key={key}
              label={key === "right" ? "Right dock" : ZONE_NAMES[key]}
              hidden={collapsed[key]}
              onToggle={() => onToggle(key)}
            />
          ))}
          {floating.map((paneId) => (
            <div key={paneId} className={styles.layoutRow}>
              <span>{PANE_TITLES[paneId]} (window)</span>
              <Button aria-label={`Dock ${PANE_TITLES[paneId]}`} onClick={() => onDock(paneId)}>
                dock
              </Button>
            </div>
          ))}
          <p className={styles.layoutHint}>Drag a tab onto a dock, or use its move menu.</p>
          <p className={styles.layoutHint}>
            Drag a divider to resize, double-click it to reset. A focused divider resizes with the
            arrow keys and collapses with Enter.
          </p>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

function PaneToggle({
  label,
  hidden,
  onToggle,
}: {
  label: string;
  hidden: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={styles.layoutRow}>
      <span>{label}</span>
      <Button aria-label={label} aria-pressed={!hidden} onClick={onToggle}>
        {hidden ? "hidden" : "shown"}
      </Button>
    </div>
  );
}
