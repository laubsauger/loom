import type { LoomBus } from "@domain/commands/bus.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";

/**
 * `ui.showPipeline` — the ONE command that opens the pipeline inspector (T1188, §V307,
 * §V52, §V78).
 *
 * The same shape as `ui.openSettings` and `ui.openHelp`, and for the same reason: an
 * openable surface is opened by a COMMAND, which buys the palette entry, the keystroke
 * and any button for the price of one, and gives the seam gate a registry to enumerate
 * against. Nothing sets a flag to show this panel.
 *
 * It lives beside its surface rather than in `src/domain/commands` because there is
 * nothing for `ctx.apply` to write: whether a read-only inspector is on screen is not
 * document state, produces no patch, opens no undo group and never reaches a file (§V16).
 *
 * Registration is idempotent and dispatches through a mutable holder: the bus has no
 * unregister, and React mounts more than once (StrictMode, remounts, tests).
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Open the pipeline inspector — the passes, resources and decisions of the plan the backend installed. */
    "ui.showPipeline": {
      input: Record<string, never>;
      output: { opened: boolean };
    };
  }
}

/** The command name. The keymap binding and any menu entry reference THIS, never a literal. */
export const SHOW_PIPELINE_COMMAND = "ui.showPipeline";

export interface PipelineHandlers {
  open(): void;
}

export interface PipelineHolder {
  current: PipelineHandlers | null;
}

export function pipelineHolderFor(bus: LoomBus): PipelineHolder {
  return commandHolder<PipelineHandlers>(bus, SHOW_PIPELINE_COMMAND);
}

export function registerPipelineCommand(bus: LoomBus): PipelineHolder {
  const holder = pipelineHolderFor(bus);
  if (bus.hasCommand(SHOW_PIPELINE_COMMAND)) return holder;

  bus.registerCommand({
    name: SHOW_PIPELINE_COMMAND,
    description: "Show the pipeline — the passes, resources and decisions of the installed plan.",
    handler: (_input, context) => {
      const revision = context.store.getRevision();

      if (holder.current === null) {
        return {
          status: "rejected" as const,
          revision,
          diagnostics: [
            {
              severity: "info" as const,
              code: "inspect.noPipelineSurface",
              message: "No pipeline surface is mounted to open the inspector.",
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
