import { useCallback, useId, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "@ui/primitives/button.tsx";
import { PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "@ui/primitives/popover.tsx";
import { TabBadge } from "@ui/primitives/tabs.tsx";
import { cx } from "@ui/cx.ts";
import tabStyles from "@ui/primitives/tabs.module.css";
import type { DockZone, PaneDescriptor, PaneId } from "./layout-storage.ts";
import { DOCK_ZONES } from "./layout-storage.ts";
import { PaneOutlet } from "./pane-portal.tsx";
import { PaneEmpty } from "./pane.tsx";
import styles from "./dock-zone.module.css";

/**
 * One dock zone (T191, §V95).
 *
 * A zone is a tab strip plus a stack of panels, and it has no idea which panes it holds
 * — the arrangement is data (`ShellLayout.zones`), so every pane can be in every zone and
 * none is nailed to a slot. The panels are ALL mounted, always: only the active one is
 * visible, and hiding it is a CSS concern, never an unmount (§V96 — the same rule that
 * makes tab switching safe makes dragging safe).
 *
 * ## Keyboard (§V19)
 *
 * The tab strip is one tab stop with a roving tabindex: arrows move between tabs, Home
 * and End jump to the ends, exactly as Radix's tabs behave elsewhere in the app. This one
 * is hand-rolled rather than `TabsRoot` because its panels are pane OUTLETS, not
 * children — the content lives somewhere else entirely (T193) — and a tab that owns no
 * content cannot be wired to `TabsContent`.
 *
 * Moving a pane must not require a pointer either, so every zone carries a "move" menu
 * listing the four zones and Float. A docking system reachable only by dragging is
 * mouse-only furniture.
 */

export interface DockZoneViewProps {
  readonly zone: DockZone;
  readonly label: string;
  readonly panes: readonly PaneDescriptor[];
  readonly active: PaneId | null;
  readonly onSelect: (zone: DockZone, paneId: PaneId) => void;
  readonly onMove: (paneId: PaneId, zone: DockZone) => void;
  readonly onFloat: (paneId: PaneId) => void;
  /** Raised while a tab is being dragged, so the shell can show its drop zones. */
  readonly onDragPane: (paneId: PaneId | null) => void;
}

export function DockZoneView({
  zone,
  label,
  panes,
  active,
  onSelect,
  onMove,
  onFloat,
  onDragPane,
}: DockZoneViewProps) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);

  const focusTab = useCallback((index: number) => {
    const list = listRef.current;
    if (list === null) return;
    const tabs = list.querySelectorAll<HTMLElement>('[role="tab"]');
    const target = tabs[Math.max(0, Math.min(index, tabs.length - 1))];
    target?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
      const last = panes.length - 1;
      let next: number | null = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index === last ? 0 : index + 1;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index === 0 ? last : index - 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = last;
      if (next === null) return;
      event.preventDefault();
      const pane = panes[next];
      if (pane !== undefined) onSelect(zone, pane.id);
      focusTab(next);
    },
    [focusTab, onSelect, panes, zone],
  );

  const activePane = panes.find((pane) => pane.id === active) ?? panes[0];

  return (
    <section className={styles.zone} data-dock-zone={zone} aria-label={label}>
      <div className={cx(tabStyles.list, styles.strip)} role="tablist" ref={listRef} aria-label={label}>
        {panes.map((pane, index) => (
          <button
            key={pane.id}
            type="button"
            role="tab"
            id={`${baseId}-tab-${pane.id}`}
            aria-controls={`${baseId}-panel-${pane.id}`}
            aria-selected={pane.id === activePane?.id}
            tabIndex={pane.id === activePane?.id ? 0 : -1}
            data-state={pane.id === activePane?.id ? "active" : "inactive"}
            data-pane-tab={pane.id}
            className={cx(tabStyles.trigger, styles.tab)}
            draggable
            onDragStart={(event) => {
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData("text/x-shaderloom-pane", pane.id);
              onDragPane(pane.id);
            }}
            onDragEnd={() => onDragPane(null)}
            onClick={() => onSelect(zone, pane.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
          >
            {pane.title}
            {pane.badge !== undefined && pane.badge > 0 ? (
              <TabBadge tone="error">{pane.badge}</TabBadge>
            ) : null}
          </button>
        ))}
        {activePane === undefined ? null : (
          <MovePaneMenu pane={activePane} zone={zone} onMove={onMove} onFloat={onFloat} />
        )}
      </div>

      <div className={styles.panels}>
        {panes.length === 0 ? <PaneEmpty label="Empty dock" /> : null}
        {panes.map((pane) => (
          <div
            key={pane.id}
            role="tabpanel"
            id={`${baseId}-panel-${pane.id}`}
            aria-labelledby={`${baseId}-tab-${pane.id}`}
            className={cx(styles.panel, pane.id === activePane?.id ? undefined : styles.panelHidden)}
          >
            <PaneOutlet paneId={pane.id} />
          </div>
        ))}
      </div>
    </section>
  );
}

const ZONE_LABELS: Readonly<Record<DockZone, string>> = {
  left: "Left",
  center: "Centre",
  right: "Right top",
  rightBottom: "Right bottom",
  bottom: "Bottom",
};

interface MovePaneMenuProps {
  readonly pane: PaneDescriptor;
  readonly zone: DockZone;
  readonly onMove: (paneId: PaneId, zone: DockZone) => void;
  readonly onFloat: (paneId: PaneId) => void;
}

function MovePaneMenu({ pane, zone, onMove, onFloat }: MovePaneMenuProps) {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button className={styles.moveTrigger} aria-label={`Move ${pane.title}`}>
          move
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverHeader>move {pane.title}</PopoverHeader>
        <div className={styles.moveMenu}>
          {DOCK_ZONES.map((target) => (
            <Button
              key={target}
              variant="outline"
              size="md"
              disabled={target === zone}
              onClick={() => onMove(pane.id, target)}
            >
              {ZONE_LABELS[target]}
            </Button>
          ))}
          <Button variant="outline" size="md" onClick={() => onFloat(pane.id)}>
            Float in its own window
          </Button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

export interface DropZoneOverlayProps {
  readonly onDrop: (zone: DockZone) => void;
}

/**
 * Where a dragged tab can land.
 *
 * One band per zone over the body rather than the zones themselves, because a zone that
 * is empty or collapsed has no area to drop on — and the zone you most want to drag a
 * pane back into is exactly the one you just emptied. The bands mirror T426's geometry:
 * the two right bands run down the full height, and the bottom band stops where the
 * right sidebar starts.
 */
export function DropZoneOverlay({ onDrop }: DropZoneOverlayProps) {
  return (
    <div className={styles.overlay} data-testid="dock-drop-overlay">
      {DOCK_ZONES.map((zone) => (
        <div
          key={zone}
          className={cx(styles.dropZone, styles[zone])}
          data-drop-zone={zone}
          aria-label={`Move pane to the ${ZONE_LABELS[zone].toLowerCase()} dock`}
          onDragOver={(event) => {
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            event.preventDefault();
            onDrop(zone);
          }}
        >
          <span className={styles.dropLabel}>{ZONE_LABELS[zone]}</span>
        </div>
      ))}
    </div>
  );
}
