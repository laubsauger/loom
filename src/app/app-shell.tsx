import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { ImperativePanelGroupHandle, ImperativePanelHandle } from "react-resizable-panels";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Button } from "@ui/primitives/button.tsx";
import { PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "@ui/primitives/popover.tsx";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import { cx } from "@ui/cx.ts";
import { DockZoneView, DropZoneOverlay } from "./dock-zone.tsx";
import { PaneEmpty } from "./pane.tsx";
import { PaneContent, PaneHostProvider } from "./pane-portal.tsx";
import { FloatingPane } from "./pane-window.tsx";
import type { OpenPaneWindow } from "./pane-window.tsx";
import { TopBar } from "./top-bar.tsx";
import type { DockZone, LayoutStorage, PaneDescriptor, PaneId, ShellLayout } from "./layout-storage.ts";
import {
  DEFAULT_SHELL_LAYOUT,
  PANE_IDS,
  PANE_TITLES,
  dockPane,
  floatPane,
  movePane,
  readLayout,
  selectPane,
  writeLayout,
} from "./layout-storage.ts";
import styles from "./app-shell.module.css";

type GroupKey = "rows" | "columns";

const HIT_AREA = { coarse: 12, fine: 6 } as const;

/** The mutable half of the arrangement — what a move changes, and what re-renders. */
type Arrangement = Pick<ShellLayout, "zones" | "active" | "floating">;

function arrangementOf(layout: ShellLayout): Arrangement {
  return { zones: layout.zones, active: layout.active, floating: layout.floating };
}

function withGroup(layout: ShellLayout, key: GroupKey, sizes: number[]): ShellLayout {
  return key === "rows" ? { ...layout, rows: sizes } : { ...layout, columns: sizes };
}

const ZONE_NAMES: Readonly<Record<DockZone, string>> = {
  left: "Left dock",
  center: "Centre dock",
  right: "Right dock",
  bottom: "Bottom dock",
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
 * App shell (§I.ui, T4, T191, T192, T193).
 *
 * ## The arrangement is data
 *
 * §V95: no pane is nailed to a slot. Four dock zones — left, centre, right, bottom — each
 * hold an ordered list of panes read from `ShellLayout`, and a pane moves by rewriting
 * that list: by dragging its tab onto a drop band, or from its zone's move menu, which is
 * the keyboard path (§V19). Floating a pane (§V97) takes it out of every zone and into
 * its own window; it is still the same pane, in the same React tree, on the same bus.
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
  const initial = useMemo(() => readLayout(storage), [storage]);
  const layoutRef = useRef<ShellLayout>(initial);
  const [arrangement, setArrangement] = useState<Arrangement>(() => arrangementOf(initial));
  const [dragging, setDragging] = useState<PaneId | null>(null);

  const rowsRef = useRef<ImperativePanelGroupHandle>(null);
  const columnsRef = useRef<ImperativePanelGroupHandle>(null);
  const zonePanels: Record<"left" | "right" | "bottom", RefObject<ImperativePanelHandle | null>> = {
    left: useRef<ImperativePanelHandle>(null),
    right: useRef<ImperativePanelHandle>(null),
    bottom: useRef<ImperativePanelHandle>(null),
  };
  const [collapsed, setCollapsed] = useState({ left: false, right: false, bottom: false });

  // The layout the shell actually mounted with is the layout we store: a
  // repaired or defaulted entry is normalised back into the store immediately,
  // so what is on screen and what is persisted never disagree (V18).
  useEffect(() => {
    writeLayout(layoutRef.current, storage);
  }, [storage]);

  const persistGroup = useCallback(
    (key: GroupKey, sizes: number[]) => {
      layoutRef.current = withGroup(layoutRef.current, key, sizes);
      writeLayout(layoutRef.current, storage);
    },
    [storage],
  );

  /** The one write path for an arrangement change: ref, state and storage in step. */
  const apply = useCallback(
    (change: (layout: ShellLayout) => ShellLayout) => {
      const next = change(layoutRef.current);
      if (next === layoutRef.current) return;
      layoutRef.current = next;
      setArrangement(arrangementOf(next));
      writeLayout(next, storage);
    },
    [storage],
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

  /** Double-click a divider → that group returns to its default split. */
  const resetGroup = useCallback(
    (ref: RefObject<ImperativePanelGroupHandle | null>, key: GroupKey) => {
      const sizes = [...DEFAULT_SHELL_LAYOUT[key]];
      const group = ref.current;
      // A group that has not registered its panels yet (pre-layout-effect,
      // server render) throws on setLayout; persist regardless so the next
      // mount picks the defaults up.
      if (group && group.getLayout().length === sizes.length) group.setLayout(sizes);
      persistGroup(key, sizes);
    },
    [persistGroup],
  );

  const resetAll = useCallback(() => {
    resetGroup(rowsRef, "rows");
    resetGroup(columnsRef, "columns");
    apply(() => ({ ...DEFAULT_SHELL_LAYOUT, rows: layoutRef.current.rows, columns: layoutRef.current.columns }));
  }, [apply, resetGroup]);

  const togglePane = useCallback((ref: RefObject<ImperativePanelHandle | null>) => {
    const panel = ref.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }, []);

  // A zone with nothing in it is 0 tall or 0 wide. Collapsing it on the way to empty and
  // expanding it when a pane arrives is what makes dragging the last pane out of a zone
  // give the space back instead of leaving a titled void.
  const emptinessRef = useRef<Record<string, boolean>>({});
  useEffect(() => {
    for (const zone of ["left", "right", "bottom"] as const) {
      const empty = arrangement.zones[zone].length === 0;
      if (emptinessRef.current[zone] === empty) continue;
      emptinessRef.current[zone] = empty;
      const panel = zonePanels[zone].current;
      if (panel === null) continue;
      if (empty) panel.collapse();
      else panel.expand();
    }
    // `zonePanels` holds refs created on the first render and never replaced.
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
                collapsed={collapsed}
                floating={arrangement.floating}
                onToggle={(zone) => togglePane(zonePanels[zone])}
                onDock={onDock}
                onReset={resetAll}
              />
            </div>
          </header>

          {/* Always present so the grid keeps three rows: an empty strip is 0 tall, and
              the body row stays `1fr` whether or not anything needs saying. */}
          <div className={styles.notices}>{notices}</div>

          <div className={styles.bodyWrap}>
            <PanelGroup
              className={styles.body}
              direction="vertical"
              id="shell-rows"
              ref={rowsRef}
              onLayout={(sizes) => persistGroup("rows", sizes)}
            >
              <Panel id="shell-main" order={1} minSize={30} defaultSize={initial.rows[0]}>
                <PanelGroup
                  direction="horizontal"
                  id="shell-columns"
                  ref={columnsRef}
                  onLayout={(sizes) => persistGroup("columns", sizes)}
                >
                  <Panel
                    id="shell-left"
                    order={1}
                    minSize={12}
                    defaultSize={initial.columns[0]}
                    collapsible
                    collapsedSize={0}
                    ref={zonePanels.left}
                    onCollapse={() => setCollapsed((prev) => ({ ...prev, left: true }))}
                    onExpand={() => setCollapsed((prev) => ({ ...prev, left: false }))}
                  >
                    {zoneView("left")}
                  </Panel>

                  <PanelResizeHandle
                    className={cx(styles.handle, styles.handleV)}
                    hitAreaMargins={HIT_AREA}
                    aria-label="Resize left dock"
                    onDoubleClick={() => resetGroup(columnsRef, "columns")}
                  />

                  <Panel id="shell-center" order={2} minSize={25} defaultSize={initial.columns[1]}>
                    {zoneView("center")}
                  </Panel>

                  <PanelResizeHandle
                    className={cx(styles.handle, styles.handleV)}
                    hitAreaMargins={HIT_AREA}
                    aria-label="Resize right dock"
                    onDoubleClick={() => resetGroup(columnsRef, "columns")}
                  />

                  <Panel
                    id="shell-right"
                    order={3}
                    minSize={14}
                    defaultSize={initial.columns[2]}
                    collapsible
                    collapsedSize={0}
                    ref={zonePanels.right}
                    onCollapse={() => setCollapsed((prev) => ({ ...prev, right: true }))}
                    onExpand={() => setCollapsed((prev) => ({ ...prev, right: false }))}
                  >
                    {zoneView("right")}
                  </Panel>
                </PanelGroup>
              </Panel>

              <PanelResizeHandle
                className={cx(styles.handle, styles.handleH)}
                hitAreaMargins={HIT_AREA}
                aria-label="Resize bottom dock"
                onDoubleClick={() => resetGroup(rowsRef, "rows")}
              />

              <Panel
                id="shell-bottom"
                order={2}
                minSize={12}
                defaultSize={initial.rows[1]}
                collapsible
                collapsedSize={0}
                ref={zonePanels.bottom}
                onCollapse={() => setCollapsed((prev) => ({ ...prev, bottom: true }))}
                onExpand={() => setCollapsed((prev) => ({ ...prev, bottom: false }))}
              >
                {zoneView("bottom")}
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
  collapsed: { left: boolean; right: boolean; bottom: boolean };
  floating: readonly PaneId[];
  onToggle: (zone: "left" | "right" | "bottom") => void;
  onDock: (paneId: PaneId) => void;
  onReset: () => void;
}

/**
 * Keyboard path to everything the dividers do with a mouse (V19): show/hide a
 * zone, bring a floated pane back, and put the whole layout back to defaults.
 */
function LayoutMenu({ collapsed, floating, onToggle, onDock, onReset }: LayoutMenuProps) {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button aria-label="Layout">layout</Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverHeader>panes</PopoverHeader>
        <div className={styles.layoutMenu}>
          {(["left", "right", "bottom"] as const).map((zone) => (
            <PaneToggle
              key={zone}
              label={ZONE_NAMES[zone]}
              hidden={collapsed[zone]}
              onToggle={() => onToggle(zone)}
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
          <Button variant="outline" size="md" onClick={onReset}>
            Reset layout
          </Button>
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
