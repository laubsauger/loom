import type { ShaderloomBus } from "@domain/commands/bus.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";

/**
 * The shell layout's bus commands (T436, §V78, §V307).
 *
 * §V307: an openable surface is opened by a COMMAND, which buys three doors — the top
 * bar's button, the command palette and a rebindable key — for the price of one. The
 * layout menu is where saving, naming, updating, restoring and deleting a layout all
 * live, so `ui.openLayouts` is the door to every one of them.
 *
 * ## Why the save/rename/delete verbs are NOT separate commands
 *
 * The palette invokes a command with NO input (`command-palette.tsx` calls
 * `run(entry.command)`), which is exactly the shape of §B60: a bound, registered,
 * handled command that does nothing because no surface supplies its argument. A
 * `layout.saveAs` needs a NAME and a `layout.apply` needs an ID, and neither the palette
 * nor a keystroke can produce one — they would list as rows that can only ever reject.
 * So the argument-taking verbs stay inside the menu, and the MENU is the command. What
 * an agent gains from `layout.apply` is real but it is not what T436 was asked for, and
 * it is not worth a palette row that is dead on arrival.
 *
 * `layout.reset` takes no argument and means the same thing from every door, so it is a
 * command in its own right — it was a hardcoded button handler until now.
 *
 * Registration is idempotent and dispatches through a mutable holder: the bus has no
 * unregister, and React mounts more than once (StrictMode, remounts, tests).
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Open the layout menu: presets, saved layouts, and the save/update/delete verbs. */
    "ui.openLayouts": {
      input: Record<string, never>;
      output: { opened: boolean };
    };
    /** Put every dock, split and pane back to the built-in default arrangement. */
    "layout.reset": {
      input: Record<string, never>;
      output: { reset: boolean };
    };
    /** Bring the problems pane to the front — restore its tab if closed (T599). */
    "ui.showProblems": {
      input: Record<string, never>;
      output: { shown: boolean };
    };
  }
}

export const OPEN_LAYOUTS_COMMAND = "ui.openLayouts";
export const RESET_LAYOUT_COMMAND = "layout.reset";
export const SHOW_PROBLEMS_COMMAND = "ui.showProblems";

export interface LayoutHandlers {
  /** Shows the layout menu. */
  open(): void;
  /** Restores the built-in default arrangement. */
  reset(): void;
  /** Brings the problems tab to the front (T599: the node's "+N more" door). */
  showProblems(): void;
}

export interface LayoutCommandHolder {
  current: LayoutHandlers | null;
}

export function layoutCommandHolderFor(bus: ShaderloomBus): LayoutCommandHolder {
  return commandHolder<LayoutHandlers>(bus, OPEN_LAYOUTS_COMMAND);
}

const NO_SHELL = {
  severity: "info" as const,
  code: "layout.noShell",
  message: "No app shell is mounted, so there is no layout to change.",
};

export function registerLayoutCommands(bus: ShaderloomBus): LayoutCommandHolder {
  const holder = layoutCommandHolderFor(bus);
  if (bus.hasCommand(OPEN_LAYOUTS_COMMAND)) return holder;

  bus.registerCommand({
    name: OPEN_LAYOUTS_COMMAND,
    description: "Open the layout menu — save, name, update or restore a window layout.",
    handler: (_input, context) => {
      const revision = context.store.getRevision();
      if (holder.current === null) {
        return {
          status: "rejected" as const,
          revision,
          diagnostics: [NO_SHELL],
          output: { opened: false },
        };
      }
      // §V36: a dry run validates and opens nothing.
      if (context.dryRun) return { status: "applied" as const, revision, output: { opened: false } };
      holder.current.open();
      return { status: "applied" as const, revision, output: { opened: true } };
    },
    rejectionOutput: () => ({ opened: false }),
  });

  bus.registerCommand({
    name: RESET_LAYOUT_COMMAND,
    description: "Reset the window layout to the built-in default arrangement.",
    handler: (_input, context) => {
      const revision = context.store.getRevision();
      if (holder.current === null) {
        return {
          status: "rejected" as const,
          revision,
          diagnostics: [NO_SHELL],
          output: { reset: false },
        };
      }
      if (context.dryRun) return { status: "applied" as const, revision, output: { reset: false } };
      holder.current.reset();
      return { status: "applied" as const, revision, output: { reset: true } };
    },
    rejectionOutput: () => ({ reset: false }),
  });

  bus.registerCommand({
    name: SHOW_PROBLEMS_COMMAND,
    description: "Show the problems pane — bring its tab to the front, restoring it if closed.",
    handler: (_input, context) => {
      const revision = context.store.getRevision();
      if (holder.current === null) {
        return {
          status: "rejected" as const,
          revision,
          diagnostics: [NO_SHELL],
          output: { shown: false },
        };
      }
      if (context.dryRun) return { status: "applied" as const, revision, output: { shown: false } };
      holder.current.showProblems();
      return { status: "applied" as const, revision, output: { shown: true } };
    },
    rejectionOutput: () => ({ shown: false }),
  });

  return holder;
}
