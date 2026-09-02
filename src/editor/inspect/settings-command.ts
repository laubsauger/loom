import type { LoomBus } from "@domain/commands/bus.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";

/**
 * `ui.openSettings` — the ONE command that opens project settings (T359, §V307, §V52).
 *
 * The dialog shipped with T266 opened from a `useState` toggle in the composition root,
 * which made it the only openable surface in the app a keystroke could not reach. The
 * default keymap has bound `mod+,` to this name since T77 and the engine simply skipped
 * it, because nothing registered the command — a binding pointing at a command that does
 * not exist is silent by design (`engine.ts` refuses to dispatch an unregistered name).
 *
 * §V307 makes that the rule rather than the exception: an openable surface is opened by a
 * command, which buys three doors — button, palette, keystroke — for the price of one
 * (§V78), and gives the seam guard a REGISTRY to enumerate against instead of a naming
 * convention.
 *
 * Like `ui.showNodeInfo` and `ui.openHelp`, this lives beside its surface rather than in
 * `src/domain/commands`: there is nothing for `ctx.apply` to write. Whether a dialog is on
 * screen is not document state — it produces no patch, opens no undo group and never
 * reaches a file (§V16). What the dialog EDITS goes through `project.setSettings`, which
 * is where the revision bump and the undo entry belong (§V177).
 *
 * Registration is idempotent and dispatches through a mutable holder: the bus has no
 * unregister, and React mounts more than once (StrictMode, remounts, tests).
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Open the project settings dialog. */
    "ui.openSettings": {
      input: Record<string, never>;
      output: { opened: boolean };
    };
  }
}

/** The command name. The keymap binding, the top bar button and the palette use THIS. */
export const OPEN_SETTINGS_COMMAND = "ui.openSettings";

export interface ProjectSettingsHandlers {
  /** Shows the dialog. */
  open(): void;
}

export interface ProjectSettingsHolder {
  current: ProjectSettingsHandlers | null;
}

export function projectSettingsHolderFor(bus: LoomBus): ProjectSettingsHolder {
  return commandHolder<ProjectSettingsHandlers>(bus, OPEN_SETTINGS_COMMAND);
}

export function registerProjectSettingsCommand(bus: LoomBus): ProjectSettingsHolder {
  const holder = projectSettingsHolderFor(bus);
  if (bus.hasCommand(OPEN_SETTINGS_COMMAND)) return holder;

  bus.registerCommand({
    name: OPEN_SETTINGS_COMMAND,
    description: "Open project settings — resolution, working format, frame rate, seed.",
    handler: (_input, context) => {
      const revision = context.store.getRevision();

      if (holder.current === null) {
        return {
          status: "rejected" as const,
          revision,
          diagnostics: [
            {
              severity: "info" as const,
              code: "settings.noSurface",
              message: "No settings surface is mounted to open the dialog.",
            },
          ],
          output: { opened: false },
        };
      }

      // §V36: a dry run validates and opens nothing.
      if (context.dryRun) {
        return { status: "applied" as const, revision, output: { opened: false } };
      }

      holder.current.open();
      return { status: "applied" as const, revision, output: { opened: true } };
    },
    rejectionOutput: () => ({ opened: false }),
  });

  return holder;
}
