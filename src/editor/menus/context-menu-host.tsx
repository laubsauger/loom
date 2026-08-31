import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { MenuEntry, MenuItem, MenuTarget } from "@domain/types/menus.ts";
import { isMenuSeparator } from "@domain/types/menus.ts";
import { cx } from "@ui/cx.ts";
import {
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRoot,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@ui/primitives/context-menu.tsx";
import { useCommandKeyDisplay, useRunCommand } from "@editor/keymap/index.ts";
import type { MenuContext } from "./guards.ts";
import { evaluateMenuGuard, menuGuardValue } from "./guards.ts";
import { resolveMenuInput } from "./input.ts";
import { TOGGLE_GUARD, menuSchemaFor } from "./schemas.ts";
import { resolveMenuTarget } from "./target.ts";
import styles from "./context-menu-host.module.css";

/**
 * ONE context-menu root per surface (T126, §V78).
 *
 * The root wraps a whole pane. What was clicked is resolved from the event when the
 * menu opens — a Radix root per node would cost a portal, a context and a subscription
 * on every one of a few hundred nodes.
 *
 * Nothing in here holds a handler for a menu action. An item names a bus command, the
 * shortcut chip comes from the keymap, and the dispatch goes through `useRunCommand` —
 * the same path a hotkey and the command palette take (§V29, §V52, §V55). An item whose
 * command nobody has registered renders disabled and says so, rather than vanishing or
 * throwing when clicked.
 *
 * Must be mounted inside a `<KeymapProvider>`: that is where the bus, the actor identity
 * and the binding table come from.
 */

interface MenuRuntime {
  target: MenuTarget;
  context: MenuContext;
  hasCommand: (command: string) => boolean;
  run: (command: string, input: Record<string, unknown>) => void;
}

const MenuRuntimeContext = createContext<MenuRuntime | null>(null);

function useMenuRuntime(): MenuRuntime {
  const runtime = useContext(MenuRuntimeContext);
  if (runtime === null) throw new Error("A menu row must render inside a ContextMenuHost.");
  return runtime;
}

const UNAVAILABLE = "This command is not available yet — no track has registered it.";

function MenuRow({ item }: { item: MenuItem }) {
  const { target, context, hasCommand, run } = useMenuRuntime();
  // §V55 — the shortcut is asked of the keymap at render time. A label may never
  // contain "⌘Z": rebinding a key updates this text, a hardcoded one would lie.
  const display = useCommandKeyDisplay(item.command ?? "graph.undo");

  const submenu = item.submenu;
  if (submenu !== undefined && submenu.length > 0) {
    // A submenu parent has no action of its own; `command` is optional for exactly
    // this case, so it is never asked to name one it does not have.
    return (
      <ContextMenuSub>
        <ContextMenuSubTrigger data-menu-submenu={item.label}>
          <span className={styles.label}>{item.label}</span>
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {submenu.map((child, index) => (
            <MenuRow key={`${child.command}:${child.label}:${index}`} item={child} />
          ))}
        </ContextMenuSubContent>
      </ContextMenuSub>
    );
  }

  // Past the submenu branch a row must name a command. A row with neither is a
  // schema mistake, so it renders disabled and says so rather than silently vanishing.
  const command = item.command;
  if (command === undefined) {
    return (
      <ContextMenuItem disabled title="Menu entry names no command.">
        <span className={styles.label}>{item.label}</span>
      </ContextMenuItem>
    );
  }

  const available = hasCommand(command);
  const guard = evaluateMenuGuard(item.when, target, context);
  const resolved = resolveMenuInput(item, target, context);
  const reason = !available
    ? UNAVAILABLE
    : !guard.ok
      ? guard.reason
      : !resolved.ok
        ? resolved.reason
        : null;
  const disabled = reason !== null;

  const onSelect = (): void => {
    if (disabled || !resolved.ok) return;
    run(command, resolved.input);
  };

  const body = (
    <>
      <span className={styles.label}>{item.label}</span>
      {display === null || item.command === undefined ? null : (
        <ContextMenuShortcut>{display}</ContextMenuShortcut>
      )}
      {available ? null : <span className={styles.tag}>unavailable</span>}
    </>
  );

  const shared = {
    disabled,
    onSelect,
    title: reason ?? item.label,
    "data-menu-command": command,
  };

  // A toggle shows its state, so bypass/mute/preview are checkbox items rather than
  // three verbs the user has to guess the current value of.
  const toggle = TOGGLE_GUARD[command];
  if (toggle !== undefined) {
    return (
      <ContextMenuCheckboxItem checked={menuGuardValue(toggle, target, context)} {...shared}>
        {body}
      </ContextMenuCheckboxItem>
    );
  }

  return (
    <ContextMenuItem danger={item.danger === true} {...shared}>
      {body}
    </ContextMenuItem>
  );
}

function renderEntry(entry: MenuEntry, index: number): ReactNode {
  if (isMenuSeparator(entry)) return <ContextMenuSeparator key={`separator-${index}`} />;
  return <MenuRow key={`${entry.command}:${entry.label}`} item={entry} />;
}

export interface ContextMenuHostProps {
  bus: ShaderloomBus;
  /**
   * Surface for a click that lands on nothing addressable — "canvas" for the graph
   * pane. Omitted, such a click opens no menu at all.
   */
  fallbackSurface?: MenuTarget["surface"] | null;
  /** Canvas selection: a right-click inside one acts on all of it. */
  selection?: readonly NodeId[];
  /** Client → graph space, i.e. React Flow's `screenToFlowPosition`, so "add node here" lands under the cursor. */
  toGraphPosition?: (client: { x: number; y: number }) => { x: number; y: number };
  className?: string;
  children?: ReactNode;
}

const NO_SELECTION: readonly NodeId[] = [];

export function ContextMenuHost({
  bus,
  fallbackSurface = null,
  selection = NO_SELECTION,
  toGraphPosition,
  className,
  children,
}: ContextMenuHostProps) {
  const run = useRunCommand();
  const hostRef = useRef<HTMLDivElement | null>(null);
  /**
   * Whether the menu is closing because an item was CHOSEN, as opposed to dismissed.
   *
   * B (found by T709): a menu row that opens a surface opened nothing at all. Measured on
   * "Search nodes…" and reproduced on T145's "Info", which has been broken this way since
   * it shipped — the command ran, the handler was reached with the right input, the
   * surface set its state, and the popover was gone within a frame. Radix restores focus
   * to the trigger as the menu closes, that restoration lands on the graph pane AFTER the
   * new popover has mounted, and the popover's own dismissable layer reads it as focus
   * moving outside itself and closes.
   *
   * So: when the user PICKED something, the menu must not yank focus back — whatever the
   * command did now owns it. When the menu was dismissed with Escape or a click away,
   * nothing else took focus and returning it to the trigger is exactly right (§V19), so
   * that path is untouched.
   */
  const selectionRan = useRef(false);
  const [opened, setOpened] = useState<{ target: MenuTarget; context: MenuContext } | null>(null);

  const onContextMenu = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const start = event.target instanceof Element ? event.target : null;
      const client = { x: event.clientX, y: event.clientY };
      const target = resolveMenuTarget(start, {
        fallback: fallbackSurface,
        position: toGraphPosition === undefined ? client : toGraphPosition(client),
        boundary: hostRef.current,
      });

      if (target === null) {
        // Nothing addressable under the cursor. Preventing the default stops Radix's
        // own handler (it composes with `checkForDefaultPrevented`) from opening a
        // menu we have no target for.
        event.preventDefault();
        setOpened(null);
        return;
      }

      // The document is read ONCE, here. Subscribing the host to the store instead
      // would re-render the entire pane it wraps on every revision (§V16); a menu that
      // is open for two seconds does not need to follow the document.
      setOpened({
        target,
        context: {
          graph: bus.store.getGraph(),
          revision: bus.store.getRevision(),
          selection,
          registry: bus.registry,
        },
      });
    },
    [bus, fallbackSurface, selection, toGraphPosition],
  );

  const schema = useMemo(
    () => (opened === null ? null : menuSchemaFor(opened.target.surface, opened.context.registry)),
    [opened],
  );

  const runtime = useMemo<MenuRuntime | null>(
    () =>
      opened === null
        ? null
        : {
            target: opened.target,
            context: opened.context,
            hasCommand: (command) => bus.hasCommand(command),
            run: (command, input) => {
              selectionRan.current = true;
              void run(command, input);
            },
          },
    [bus, opened, run],
  );

  return (
    <ContextMenuRoot
      onOpenChange={(open) => {
        if (!open) setOpened(null);
      }}
    >
      <ContextMenuTrigger asChild onContextMenu={onContextMenu}>
        <div ref={hostRef} className={cx(styles.host, className)} data-testid="context-menu-host">
          {children}
        </div>
      </ContextMenuTrigger>
      {schema === null || runtime === null ? null : (
        <ContextMenuContent
          aria-label={`${schema.surface} menu`}
          data-menu-surface={schema.surface}
          onCloseAutoFocus={(event) => {
            if (selectionRan.current) event.preventDefault();
            selectionRan.current = false;
          }}
        >
          <MenuRuntimeContext.Provider value={runtime}>
            {schema.entries.map(renderEntry)}
          </MenuRuntimeContext.Provider>
        </ContextMenuContent>
      )}
    </ContextMenuRoot>
  );
}
