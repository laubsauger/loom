import { useCallback, useId, useRef , useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { Button } from "@ui/primitives/button.tsx";
import { PopoverContent, PopoverHeader, PopoverRoot, PopoverTrigger } from "@ui/primitives/popover.tsx";
import { TabBadge } from "@ui/primitives/tabs.tsx";
import { cx } from "@ui/cx.ts";
import tabStyles from "@ui/primitives/tabs.module.css";
import type { PaneKey, PaneRole } from "./pane-tree.ts";
import { PaneOutlet } from "./pane-portal.tsx";
import styles from "./pane-leaf.module.css";

/**
 * One LEAF of the pane tree (T404/T406) — the tab group `dock-zone.tsx` used to be,
 * re-keyed from zones to identities.
 *
 * A leaf is a tab strip plus a stack of outlets, and it has no idea what its tabs SHOW
 * — a tab is a KEY (which pane) wearing a ROLE (what it shows), and the arrangement is
 * data (V340/§V95). The panels are ALL mounted, always: hiding the inactive ones is a
 * CSS concern, never an unmount (§V96).
 *
 * ## Keyboard (§V19)
 *
 * The strip is one tab stop with a roving tabindex — arrows, Home, End — exactly as the
 * zone version behaved. Moving a tab must not require a pointer either: the pane menu
 * lists every other leaf by label, Float, and Close. Splitting and closing the LEAF
 * live in the leaf's own menu, so a docking system is never mouse-only furniture.
 *
 * T854's per-tab × is a POINTER shortcut, deliberately outside the roving index: arrowing
 * to a tab already selects it, so the keyboard route to closing any tab is arrow-then-menu
 * and no tab is keyboard-unclosable. Giving each × its own tab stop would put N stops in
 * the strip and cost the single-stop property this docblock promises.
 *
 * ## The empty leaf is a QUESTION, not a void
 *
 * A fresh split opens EMPTY on purpose (T406): the user says what it shows via the role
 * list rendered in its body — never a guessed duplicate. An emptied leaf (last tab
 * floated or closed) shows the same picker, which is strictly more useful than the
 * collapsed void the flat shell left.
 */

export interface LeafTabDescriptor {
  readonly key: PaneKey;
  readonly role: PaneRole;
  readonly title: string;
  /** Count chip on the tab (problems). */
  readonly badge?: number;
}

/** Another leaf a tab can move to, labelled for humans. */
export interface LeafTarget {
  readonly id: PaneKey;
  readonly label: string;
}

export interface PaneLeafViewProps {
  readonly leafId: PaneKey;
  readonly label: string;
  readonly tabs: readonly LeafTabDescriptor[];
  readonly active: PaneKey | null;
  /** Every OTHER leaf, in tree order — the move menu's targets. */
  readonly moveTargets: readonly LeafTarget[];
  /** A tab drag in progress anywhere in the shell; this leaf shows its drop target. */
  readonly dragging: PaneKey | null;
  /** The role list an empty leaf offers. */
  readonly roleOptions: ReadonlyArray<{ readonly role: PaneRole; readonly title: string }>;
  /** False for the last leaf: the shell always has somewhere to stand. */
  readonly canCloseLeaf: boolean;
  /**
   * T705(b): keys currently floated to their own windows. Their tabs stay in the leaf
   * — the owner: a float must not yank the pane out of the arrangement — but their
   * panels show a placeholder, because the content itself lives in the child window
   * and exists exactly once (§V96).
   */
  readonly floating: ReadonlySet<PaneKey>;
  /** Brings a floated tab's content back into its slot (closing its window). */
  readonly onDock: (key: PaneKey) => void;
  readonly onSelect: (leafId: PaneKey, key: PaneKey) => void;
  readonly onMoveTab: (key: PaneKey, leafId: PaneKey) => void;
  readonly onFloat: (key: PaneKey) => void;
  readonly onCloseTab: (key: PaneKey) => void;
  readonly onDragTab: (key: PaneKey | null) => void;
  readonly onDropTab: (key: PaneKey, leafId: PaneKey) => void;
  readonly onSplit: (leafId: PaneKey, direction: "row" | "column") => void;
  readonly onCloseLeaf: (leafId: PaneKey) => void;
  readonly onAssignEmpty: (leafId: PaneKey, role: PaneRole) => void;
  /** V340: change what an existing tab SHOWS; its key — place, size, window — stays. */
  readonly onAssignRole: (key: PaneKey, role: PaneRole) => void;
  /**
   * T835: ADD a tab to this leaf — a NEW key beside the ones already here. The opposite
   * intent from `onAssignRole`, which re-faces the tab you are standing on and keeps its
   * key (§V340), and the reason the two are separate controls: an occupied leaf used to
   * offer only the swap, so `addTab` was reachable from the empty-pane picker alone.
   */
  readonly onAddTab: (leafId: PaneKey, role: PaneRole) => void;
}

export function PaneLeafView({
  leafId,
  label,
  tabs,
  active,
  floating,
  onDock,
  moveTargets,
  dragging,
  roleOptions,
  canCloseLeaf,
  onSelect,
  onMoveTab,
  onFloat,
  onCloseTab,
  onDragTab,
  onDropTab,
  onSplit,
  onCloseLeaf,
  onAssignEmpty,
  onAssignRole,
  onAddTab,
}: PaneLeafViewProps) {
  const baseId = useId();
  const listRef = useRef<HTMLDivElement | null>(null);

  const focusTab = useCallback((index: number) => {
    const list = listRef.current;
    if (list === null) return;
    const targets = list.querySelectorAll<HTMLElement>('[role="tab"]');
    const target = targets[Math.max(0, Math.min(index, targets.length - 1))];
    target?.focus();
  }, []);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, index: number) => {
      const last = tabs.length - 1;
      let next: number | null = null;
      if (event.key === "ArrowRight" || event.key === "ArrowDown") next = index === last ? 0 : index + 1;
      else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = index === 0 ? last : index - 1;
      else if (event.key === "Home") next = 0;
      else if (event.key === "End") next = last;
      if (next === null) return;
      event.preventDefault();
      const tab = tabs[next];
      if (tab !== undefined) onSelect(leafId, tab.key);
      focusTab(next);
    },
    [focusTab, leafId, onSelect, tabs],
  );

  const activeTab = tabs.find((tab) => tab.key === active) ?? tabs[0];
  // The dragged tab's own leaf is not a target for itself — unless it has company.
  const droppable = dragging !== null && (tabs.length !== 1 || tabs[0]?.key !== dragging);

  return (
    <section className={styles.leaf} data-pane-leaf={leafId} aria-label={label}>
      <div className={cx(tabStyles.list, styles.strip)} role="tablist" ref={listRef} aria-label={label}>
        {tabs.map((tab, index) => (
          /* T854: the tab and its × are SIBLINGS. A button inside a button is invalid
             HTML, and nesting would also fold the close into the tab's accessible name.
             `role="presentation"` keeps the wrapper out of the a11y tree so the tablist
             still owns its tabs directly. */
          <div key={tab.key} role="presentation" className={styles.tabSlot}>
            <button
              type="button"
              role="tab"
              id={`${baseId}-tab-${tab.key}`}
              aria-controls={`${baseId}-panel-${tab.key}`}
              aria-selected={tab.key === activeTab?.key}
              tabIndex={tab.key === activeTab?.key ? 0 : -1}
              data-state={tab.key === activeTab?.key ? "active" : "inactive"}
              data-pane-tab={tab.key}
              data-pane-role={tab.role}
              className={cx(tabStyles.trigger, styles.tab)}
              draggable
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/x-loom-pane", tab.key);
                onDragTab(tab.key);
              }}
              onDragEnd={() => onDragTab(null)}
              onClick={() => onSelect(leafId, tab.key)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {tab.title}
              {tab.badge !== undefined && tab.badge > 0 ? <TabBadge tone="error">{tab.badge}</TabBadge> : null}
            </button>
            {/* T854, the owner: "we still cant close a tab in a pane individually."
                `closeTab` shipped and `onCloseTab` was wired — but only into the move
                menu, which renders for the ACTIVE tab, so a background tab could not be
                closed without first being selected. This is that same operation given a
                door on every tab; it is NOT the leaf's Close, which takes the whole area
                and every tab in it (§V340: what a control closes is part of what it is).
                `tabIndex={-1}` on purpose — the strip is ONE tab stop with a roving
                index (§V19), and N extra stops would trade one gap for another. */}
            <button
              type="button"
              tabIndex={-1}
              className={styles.tabClose}
              aria-label={`Close ${tab.title}`}
              title={`Close ${tab.title}`}
              onClick={() => onCloseTab(tab.key)}
            >
              ×
            </button>
          </div>
        ))}
        <div className={styles.stripTrailing}>
          {/* T835: the ADD door. Only on an OCCUPIED strip — an empty leaf already asks
              the question in its body, and offering it twice is the menu-that-grows the
              owner has objected to. */}
          {tabs.length === 0 ? null : (
            <LeafAddTabMenu leafId={leafId} roleOptions={roleOptions} onAddTab={onAddTab} />
          )}
          {activeTab === undefined ? null : (
            <PaneTabMenu
              tab={activeTab}
              targets={moveTargets}
              roleOptions={roleOptions}
              onMove={onMoveTab}
              onFloat={onFloat}
              onClose={onCloseTab}
              onAssignRole={onAssignRole}
            />
          )}
          <LeafMenu leafId={leafId} canClose={canCloseLeaf} onSplit={onSplit} onClose={onCloseLeaf} />
        </div>
      </div>

      <div className={styles.panels}>
        {tabs.length === 0 ? (
          <div className={styles.picker} data-testid={`leaf-picker-${leafId}`}>
            <p className={styles.pickerHint}>What should this pane show?</p>
            <div className={styles.pickerRoles}>
              {roleOptions.map((option) => (
                <Button
                  key={option.role}
                  variant="outline"
                  size="md"
                  onClick={() => onAssignEmpty(leafId, option.role)}
                >
                  {option.title}
                </Button>
              ))}
            </div>
            {canCloseLeaf ? (
              <Button variant="outline" size="md" onClick={() => onCloseLeaf(leafId)}>
                Close this pane
              </Button>
            ) : null}
          </div>
        ) : null}
        {tabs.map((tab) => (
          <div
            key={tab.key}
            role="tabpanel"
            id={`${baseId}-panel-${tab.key}`}
            aria-labelledby={`${baseId}-tab-${tab.key}`}
            className={cx(styles.panel, tab.key === activeTab?.key ? undefined : styles.panelHidden)}
          >
            {floating.has(tab.key) ? (
              // T705(b): the slot stays, the content is elsewhere. No PaneOutlet here —
              // two adopters for one host would fight over the same DOM (§V96).
              <div className={styles.floatedNote} data-testid={`floated-placeholder-${tab.key}`}>
                <p>Showing in its own window.</p>
                <Button variant="outline" size="md" onClick={() => onDock(tab.key)}>
                  Bring it back here
                </Button>
              </div>
            ) : (
              <PaneOutlet paneId={tab.key} />
            )}
          </div>
        ))}
        {droppable ? (
          <div
            className={styles.dropTarget}
            data-drop-leaf={leafId}
            aria-label={`Move pane into ${label}`}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
            }}
            onDrop={(event) => {
              event.preventDefault();
              const key = event.dataTransfer.getData("text/x-loom-pane");
              if (key !== "") onDropTab(key, leafId);
            }}
          >
            <span className={styles.dropLabel}>{label}</span>
          </div>
        ) : null}
      </div>
    </section>
  );
}

interface PaneTabMenuProps {
  readonly tab: LeafTabDescriptor;
  readonly targets: readonly LeafTarget[];
  readonly roleOptions: ReadonlyArray<{ readonly role: PaneRole; readonly title: string }>;
  readonly onMove: (key: PaneKey, leafId: PaneKey) => void;
  readonly onFloat: (key: PaneKey) => void;
  readonly onClose: (key: PaneKey) => void;
  readonly onAssignRole: (key: PaneKey, role: PaneRole) => void;
}

function PaneTabMenu({ tab, targets, roleOptions, onMove, onFloat, onClose, onAssignRole }: PaneTabMenuProps) {
  /**
   * T705(b), owner report: the popover stayed open after an action fired — and since
   * floating now leaves the pane's slot in place, the open menu sat exactly over the
   * placeholder's "Bring it back here" button. Every action closes the menu first.
   */
  const [open, setOpen] = useState(false);
  const act = (run: () => void) => {
    setOpen(false);
    run();
  };
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button className={styles.menuTrigger} aria-label={`Move ${tab.title}`} title={`Move ${tab.title}`}>
          {/* Glyphs, not words: the header is the tightest row in the shell and these two
              were the first things cut off. `aria-label` carries the meaning — and the two
              must differ in SILHOUETTE, not just in shape: a grip and a boxed plus were
              both dense squares and read as the same button at 11px. Thin arrows against a
              striped block are told apart without being read. */}
          ⇄
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverHeader>move {tab.title}</PopoverHeader>
        <div className={styles.menu}>
          {targets.map((target) => (
            <Button key={target.id} variant="outline" size="md" onClick={() => act(() => onMove(tab.key, target.id))}>
              {target.label}
            </Button>
          ))}
          <Button variant="outline" size="md" onClick={() => act(() => onFloat(tab.key))}>
            Float in its own window
          </Button>
          <Button variant="outline" size="md" onClick={() => act(() => onClose(tab.key))}>
            Close pane
          </Button>
        </div>
        <PopoverHeader>show instead</PopoverHeader>
        {/* V340 made visible: the PANE stays — its place, size and window — and only
            what it SHOWS changes. The role wearing the key, never a new key. */}
        <div className={styles.menu}>
          {roleOptions
            .filter((option) => option.role !== tab.role)
            .map((option) => (
              <Button
                key={option.role}
                variant="outline"
                size="md"
                /* T837 — spelled out, the symmetry of T835's "add" labels: "viewer" alone
                   appears under the add menu too, and a screen reader on a bare title cannot
                   tell "show this here" from "add this beside". */
                aria-label={`Show ${option.title} here instead`}
                onClick={() => act(() => onAssignRole(tab.key, option.role))}
              >
                {option.title}
              </Button>
            ))}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

interface LeafAddTabMenuProps {
  readonly leafId: PaneKey;
  readonly roleOptions: ReadonlyArray<{ readonly role: PaneRole; readonly title: string }>;
  readonly onAddTab: (leafId: PaneKey, role: PaneRole) => void;
}

/**
 * T835 — "add X as a new tab", the counterpart to the move menu's "show instead".
 *
 * Two headers in two popovers behind two triggers, on purpose. Adding MINTS a key beside
 * the tabs already here; showing instead keeps the key you are on and changes its face
 * (§V340). Folding both into one role list would make which of the two happens depend on
 * where in the list you clicked — the identity/role fusion V340 exists to forbid, wearing
 * a menu.
 *
 * The list is the full possibility space (V423), roles already in the leaf included: any
 * number of tabs may share a role, and two viewers is the case V340 was written for.
 */
function LeafAddTabMenu({ leafId, roleOptions, onAddTab }: LeafAddTabMenuProps) {
  // Same close-first rule as the move menu: an action never leaves its popover sitting
  // over what it just changed.
  const [open, setOpen] = useState(false);
  return (
    <PopoverRoot open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          className={styles.menuTrigger}
          aria-label="Add a tab to this area"
          title="Add a tab to this area"
        >
          {/* A thin cross: told apart from ⇄ (arrows) and ▤ (a striped block) by
              SILHOUETTE at 11px, the constraint the move menu's glyph note records. */}
          +
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverHeader>add a tab</PopoverHeader>
        <div className={styles.menu}>
          {roleOptions.map((option) => (
            <Button
              key={option.role}
              variant="outline"
              size="md"
              /* Spelled out, because "viewer" alone appears under "show instead" too and
                 the two do different things to the layout. */
              aria-label={`Add ${option.title} as a new tab`}
              onClick={() => {
                setOpen(false);
                onAddTab(leafId, option.role);
              }}
            >
              {option.title}
            </Button>
          ))}
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}

interface LeafMenuProps {
  readonly leafId: PaneKey;
  readonly canClose: boolean;
  readonly onSplit: (leafId: PaneKey, direction: "row" | "column") => void;
  readonly onClose: (leafId: PaneKey) => void;
}

/** Split right/down and close — the T406 controls, in a menu so the chrome stays quiet. */
function LeafMenu({ leafId, canClose, onSplit, onClose }: LeafMenuProps) {
  return (
    <PopoverRoot>
      <PopoverTrigger asChild>
        <Button
          className={styles.menuTrigger}
          aria-label="Split or close this pane area"
          title="Split or close this pane area"
        >
          ▤
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end">
        <PopoverHeader>this area</PopoverHeader>
        <div className={styles.menu}>
          <Button variant="outline" size="md" onClick={() => onSplit(leafId, "row")}>
            Split right
          </Button>
          <Button variant="outline" size="md" onClick={() => onSplit(leafId, "column")}>
            Split down
          </Button>
          <Button variant="outline" size="md" disabled={!canClose} onClick={() => onClose(leafId)}>
            Close area
          </Button>
        </div>
      </PopoverContent>
    </PopoverRoot>
  );
}
