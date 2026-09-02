import type { LoomBus } from "@domain/commands/bus.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";

/**
 * `ui.openHelp` — the one command that opens the help panel (T200, §V52, §V90).
 *
 * The keymap binds a key to a COMMAND NAME, never to a React handler, so the panel has
 * to be reachable as a command before it can be reachable as a keystroke. Registering it
 * here also puts help in the command palette and in reach of an agent for free, which is
 * what "three views of one command set" buys.
 *
 * §V90: on demand. Nothing about help is ambient — no permanent sidebar, no hint bar, no
 * `?` badge sitting beside a control. It opens when asked and goes away when dismissed.
 *
 * Registration is idempotent and dispatches through a mutable holder, exactly as
 * `ui.showNodeInfo` does: the bus has no unregister and React mounts more than once.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Open the help panel, optionally on a named section. */
    "ui.openHelp": {
      input: { section?: HelpSection };
      output: { opened: boolean; section: HelpSection | null };
    };
  }
}

/**
 * The panel's tabs. Each one is a projection of a live source (§V105) — including
 * `agents`, whose snippet is derived from `mcp/client-config.ts` and checked against
 * `package.json` by that module's test rather than typed out here (T399).
 */
export type HelpSection = "shortcuts" | "nodes" | "expressions" | "agents";

export const HELP_SECTIONS: readonly HelpSection[] = ["shortcuts", "nodes", "expressions", "agents"];

/** The command name. The keymap and any menu entry reference THIS, never a literal. */
export const OPEN_HELP_COMMAND = "ui.openHelp";

export interface HelpHandlers {
  /** Shows the panel. Returns the section it settled on. */
  open(section: HelpSection | undefined): HelpSection;
}

export interface HelpHolder {
  current: HelpHandlers | null;
}

export function helpHolderFor(bus: LoomBus): HelpHolder {
  return commandHolder<HelpHandlers>(bus, OPEN_HELP_COMMAND);
}

export function registerHelpCommand(bus: LoomBus): HelpHolder {
  const holder = helpHolderFor(bus);
  if (bus.hasCommand(OPEN_HELP_COMMAND)) return holder;

  bus.registerCommand({
    name: OPEN_HELP_COMMAND,
    description: "Open help — shortcuts, node reference, expression reference, agent setup.",
    handler: (input, context) => {
      const revision = context.store.getRevision();

      if (holder.current === null) {
        return {
          status: "rejected" as const,
          revision,
          diagnostics: [
            {
              severity: "info" as const,
              code: "help.noSurface",
              message: "No help surface is mounted to open the panel.",
            },
          ],
          output: { opened: false, section: null },
        };
      }

      // §V36: a dry run validates and opens nothing.
      if (context.dryRun) {
        return {
          status: "applied" as const,
          revision,
          output: { opened: false, section: input.section ?? null },
        };
      }

      const section = holder.current.open(input.section);
      return { status: "applied" as const, revision, output: { opened: true, section } };
    },
    rejectionOutput: () => ({ opened: false, section: null }),
  });

  return holder;
}
