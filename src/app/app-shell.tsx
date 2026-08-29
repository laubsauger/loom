import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import type { ImperativePanelGroupHandle, ImperativePanelHandle } from "react-resizable-panels";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { Button } from "@ui/primitives/button.tsx";
import { PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "@ui/primitives/popover.tsx";
import { TooltipProvider } from "@ui/primitives/tooltip.tsx";
import { cx } from "@ui/cx.ts";
import { BottomDock } from "./bottom-dock.tsx";
import { Pane, PaneEmpty } from "./pane.tsx";
import { TopBar } from "./top-bar.tsx";
import type { DockTab, LayoutStorage, ShellLayout } from "./layout-storage.ts";
import { DEFAULT_SHELL_LAYOUT, readLayout, writeLayout } from "./layout-storage.ts";
import styles from "./app-shell.module.css";

type GroupKey = "rows" | "columns" | "rightRows";

const HIT_AREA = { coarse: 12, fine: 6 } as const;

function withGroup(layout: ShellLayout, key: GroupKey, sizes: number[]): ShellLayout {
  switch (key) {
    case "rows":
      return { ...layout, rows: sizes };
    case "columns":
      return { ...layout, columns: sizes };
    case "rightRows":
      return { ...layout, rightRows: sizes };
  }
}

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
  graphCanvas?: ReactNode;
  inspector?: ReactNode;
  viewer?: ReactNode;
  shaderEditor?: ReactNode;
  problems?: ReactNode;
  performance?: ReactNode;
  problemCount?: number;
  /**
   * Layout store override. Defaults to `localStorage` (V18); pass `null` to run
   * without persistence, or a fake in tests.
   */
  storage?: LayoutStorage | null;
}

/**
 * App shell (§I.ui, T4).
 *
 * Three nested panel groups — body rows, main columns, right column rows — each
 * resizable, collapsible, reset on divider double-click, and persisted to
 * `localStorage` (V18). Pane contents are slots; other tracks fill them.
 */
export function AppShell({
  topBar,
  notices,
  nodeLibrary,
  graphCanvas,
  inspector,
  viewer,
  shaderEditor,
  problems,
  performance,
  problemCount = 0,
  storage,
}: AppShellProps) {
  const initial = useMemo(() => readLayout(storage), [storage]);
  const layoutRef = useRef<ShellLayout>(initial);

  const rowsRef = useRef<ImperativePanelGroupHandle>(null);
  const columnsRef = useRef<ImperativePanelGroupHandle>(null);
  const rightRowsRef = useRef<ImperativePanelGroupHandle>(null);
  const libraryRef = useRef<ImperativePanelHandle>(null);
  const rightRef = useRef<ImperativePanelHandle>(null);
  const dockRef = useRef<ImperativePanelHandle>(null);

  const [dockTab, setDockTab] = useState<DockTab>(initial.dockTab);
  const [collapsed, setCollapsed] = useState({ library: false, right: false, dock: false });

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

  const selectDockTab = useCallback(
    (tab: DockTab) => {
      setDockTab(tab);
      layoutRef.current = { ...layoutRef.current, dockTab: tab };
      writeLayout(layoutRef.current, storage);
    },
    [storage],
  );

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
    resetGroup(rightRowsRef, "rightRows");
  }, [resetGroup]);

  const togglePane = useCallback((ref: RefObject<ImperativePanelHandle | null>) => {
    const panel = ref.current;
    if (!panel) return;
    if (panel.isCollapsed()) panel.expand();
    else panel.collapse();
  }, []);

  return (
    <TooltipProvider delayDuration={400} skipDelayDuration={200}>
      <div className={styles.shell}>
        <header className={styles.topbar}>
          <div className={styles.topbarSlot}>{topBar ?? <TopBar />}</div>
          <div className={styles.topbarTrailing}>
            <LayoutMenu
              collapsed={collapsed}
              onToggleLibrary={() => togglePane(libraryRef)}
              onToggleRight={() => togglePane(rightRef)}
              onToggleDock={() => togglePane(dockRef)}
              onReset={resetAll}
            />
          </div>
        </header>

        {/* Always present so the grid keeps three rows: an empty strip is 0 tall, and
            the body row stays `1fr` whether or not anything needs saying. */}
        <div className={styles.notices}>{notices}</div>

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
                id="shell-library"
                order={1}
                minSize={12}
                defaultSize={initial.columns[0]}
                collapsible
                collapsedSize={0}
                ref={libraryRef}
                onCollapse={() => setCollapsed((prev) => ({ ...prev, library: true }))}
                onExpand={() => setCollapsed((prev) => ({ ...prev, library: false }))}
              >
                <Pane title="Node Library">
                  {nodeLibrary ?? (
                    <PaneEmpty label="Node library" />
                  )}
                </Pane>
              </Panel>

              <PanelResizeHandle
                className={cx(styles.handle, styles.handleV)}
                hitAreaMargins={HIT_AREA}
                aria-label="Resize node library"
                onDoubleClick={() => resetGroup(columnsRef, "columns")}
              />

              <Panel id="shell-graph" order={2} minSize={25} defaultSize={initial.columns[1]}>
                <div className={styles.canvas}>
                  {graphCanvas ?? (
                    <PaneEmpty label="Graph canvas" />
                  )}
                </div>
              </Panel>

              <PanelResizeHandle
                className={cx(styles.handle, styles.handleV)}
                hitAreaMargins={HIT_AREA}
                aria-label="Resize inspector column"
                onDoubleClick={() => resetGroup(columnsRef, "columns")}
              />

              <Panel
                id="shell-right"
                order={3}
                minSize={14}
                defaultSize={initial.columns[2]}
                collapsible
                collapsedSize={0}
                ref={rightRef}
                onCollapse={() => setCollapsed((prev) => ({ ...prev, right: true }))}
                onExpand={() => setCollapsed((prev) => ({ ...prev, right: false }))}
              >
                <PanelGroup
                  direction="vertical"
                  id="shell-right-rows"
                  ref={rightRowsRef}
                  onLayout={(sizes) => persistGroup("rightRows", sizes)}
                >
                  <Panel id="shell-inspector" order={1} minSize={15} defaultSize={initial.rightRows[0]}>
                    <Pane title="Inspector">
                      {inspector ?? (
                        <PaneEmpty label="No selection" />
                      )}
                    </Pane>
                  </Panel>

                  <PanelResizeHandle
                    className={cx(styles.handle, styles.handleH)}
                    hitAreaMargins={HIT_AREA}
                    aria-label="Resize viewer"
                    onDoubleClick={() => resetGroup(rightRowsRef, "rightRows")}
                  />

                  <Panel id="shell-viewer" order={2} minSize={15} defaultSize={initial.rightRows[1]}>
                    <Pane title="Viewer" scroll={false}>
                      {viewer ?? <PaneEmpty label="No output pinned" />}
                    </Pane>
                  </Panel>
                </PanelGroup>
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
            id="shell-dock"
            order={2}
            minSize={12}
            defaultSize={initial.rows[1]}
            collapsible
            collapsedSize={0}
            ref={dockRef}
            onCollapse={() => setCollapsed((prev) => ({ ...prev, dock: true }))}
            onExpand={() => setCollapsed((prev) => ({ ...prev, dock: false }))}
          >
            <BottomDock
              value={dockTab}
              onValueChange={selectDockTab}
              problemCount={problemCount}
              {...(shaderEditor === undefined ? {} : { shaderEditor })}
              {...(problems === undefined ? {} : { problems })}
              {...(performance === undefined ? {} : { performance })}
            />
          </Panel>
        </PanelGroup>
      </div>
    </TooltipProvider>
  );
}

interface LayoutMenuProps {
  collapsed: { library: boolean; right: boolean; dock: boolean };
  onToggleLibrary: () => void;
  onToggleRight: () => void;
  onToggleDock: () => void;
  onReset: () => void;
}

/**
 * Keyboard path to everything the dividers do with a mouse (V19): show/hide a
 * pane, and put the whole layout back to defaults.
 */
function LayoutMenu({
  collapsed,
  onToggleLibrary,
  onToggleRight,
  onToggleDock,
  onReset,
}: LayoutMenuProps) {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button aria-label="Layout">layout</Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverHeader>panes</PopoverHeader>
        <div className={styles.layoutMenu}>
          <PaneToggle label="Node library" hidden={collapsed.library} onToggle={onToggleLibrary} />
          <PaneToggle label="Inspector + viewer" hidden={collapsed.right} onToggle={onToggleRight} />
          <PaneToggle label="Bottom dock" hidden={collapsed.dock} onToggle={onToggleDock} />
          <Button variant="outline" size="md" onClick={onReset}>
            Reset layout
          </Button>
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
