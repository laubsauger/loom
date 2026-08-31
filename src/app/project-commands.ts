import type { ShaderloomBus } from "@domain/commands/bus.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import { commandHolder } from "@domain/commands/command-holder.ts";

/**
 * `project.save` and `project.open` (T43, T139, §V29).
 *
 * The keymap has named `project.save` since T77 and reported it unresolved ever since —
 * a binding is data naming a command, and nothing had registered the command. This
 * registers both, so the hotkey, a menu item, the palette and an agent adapter all reach
 * the same code path rather than three of them reaching a React click handler (§V52,
 * §V55, §V39).
 *
 * Neither handler can live in `src/domain`: saving needs a file picker and opening
 * needs to REPLACE the document, and §V29's "one mutation path" is about the bus being
 * the entry point, not about where the work happens. So the same holder pattern
 * `ui.showNodeInfo` uses applies here — the command is registered once per bus and
 * dispatches into whatever surface is currently mounted. The bus has no unregister and
 * React mounts more than once, so the holder, not the registration, is what a remount
 * replaces.
 *
 * ## Opening replaces the runtime, and why
 *
 * `GraphStore` takes `initialGraph` at construction and offers no `replaceGraph`; there
 * is no `graph.replaceDocument` command either. Rather than reach around the store — the
 * one thing §V29 exists to prevent — `open` hands the loaded document up to the
 * composition root, which builds a NEW `AppRuntime` around it and drops the old one.
 * That is honest about what happened (a different project is open now: different
 * settings, different project id, no undo history from the previous file) and it needs
 * no change in a directory this track does not own.
 *
 * What `src/domain/commands` would need to make an in-place open possible, precisely:
 *   1. `GraphStore.replace(graph: GraphDocument, options: { clearHistory: boolean })`,
 *      committing through the same path as `apply` so the revision bumps once and one
 *      audit entry is written (§V31);
 *   2. a `project.load` command that calls it, so the swap is a bus mutation with an
 *      actor (§V30) instead of a constructor argument;
 *   3. a decision about undo across the swap — §V41 makes history actor-local, and a
 *      history that survives into a different document can undo into nodes that do not
 *      exist, so `clearHistory` is not optional in practice.
 */
declare module "@domain/types/commands.ts" {
  interface CommandMap {
    /** Write the open project to a `.loom.json` the user chooses. */
    "project.save": {
      input: { saveAs?: boolean };
      output: { saved: boolean; fileName: string | null };
    };
    /** Pick a `.loom.json` and open it, replacing what is open. */
    "project.open": {
      input: { text?: string; fileName?: string };
      output: { opened: boolean; fileName: string | null };
    };
    /** Start an empty project, replacing what is open (§V165). Confirms when dirty. */
    "project.new": { input: Record<string, never>; output: { created: boolean } };
  }
}

export const SAVE_PROJECT_COMMAND = "project.save";
export const OPEN_PROJECT_COMMAND = "project.open";
export const NEW_PROJECT_COMMAND = "project.new";

export interface ProjectSaveResult {
  readonly saved: boolean;
  readonly fileName: string | null;
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

export interface ProjectOpenResult {
  readonly opened: boolean;
  readonly fileName: string | null;
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

export interface ProjectNewResult {
  readonly created: boolean;
  readonly diagnostics: readonly RuntimeDiagnostic[];
}

/** What the mounted composition root can do about a project. */
export interface ProjectHandlers {
  save(input: { saveAs: boolean }): Promise<ProjectSaveResult>;
  /** `text` present = open these bytes (restore, a test); absent = ask the user. */
  open(input: { text?: string | undefined; fileName?: string | undefined }): Promise<ProjectOpenResult>;
  /**
   * Replace the open project with an empty one (§V165).
   *
   * On the bus rather than on a click handler for the reason every other verb is: New is
   * destructive, so the confirmation belongs to the COMMAND. A button that asked and a
   * hotkey that did not would be two behaviours for one action (§V52).
   */
  create(): Promise<ProjectNewResult>;
}

export interface ProjectHolder {
  current: ProjectHandlers | null;
}

export function projectHolderFor(bus: ShaderloomBus): ProjectHolder {
  return commandHolder<ProjectHandlers>(bus, SAVE_PROJECT_COMMAND);
}

const NO_SURFACE: RuntimeDiagnostic = {
  severity: "error",
  code: "project.noSurface",
  message: "No project surface is mounted, so there is nowhere to read or write a file.",
};

export function registerProjectCommands(bus: ShaderloomBus): ProjectHolder {
  const holder = projectHolderFor(bus);

  if (!bus.hasCommand(SAVE_PROJECT_COMMAND)) {
    bus.registerCommand({
      name: SAVE_PROJECT_COMMAND,
      description: "Save the project to a .loom.json file.",
      handler: async (input, context) => {
        const revision = context.store.getRevision();
        if (holder.current === null) {
          return { status: "rejected", revision, diagnostics: [NO_SURFACE], output: { saved: false, fileName: null } };
        }
        // §V36: a dry run must not open a picker or write a byte.
        if (context.dryRun) {
          return { status: "applied", revision, output: { saved: false, fileName: null } };
        }
        const result = await holder.current.save({ saveAs: input.saveAs === true });
        return {
          status: result.saved ? "applied" : "rejected",
          revision,
          output: { saved: result.saved, fileName: result.fileName },
          ...(result.diagnostics.length === 0 ? {} : { diagnostics: [...result.diagnostics] }),
        };
      },
      rejectionOutput: () => ({ saved: false, fileName: null }),
    });
  }

  if (!bus.hasCommand(OPEN_PROJECT_COMMAND)) {
    bus.registerCommand({
      name: OPEN_PROJECT_COMMAND,
      description: "Open a .loom.json project, replacing the one that is open.",
      handler: async (input, context) => {
        const revision = context.store.getRevision();
        if (holder.current === null) {
          return { status: "rejected", revision, diagnostics: [NO_SURFACE], output: { opened: false, fileName: null } };
        }
        if (context.dryRun) {
          return { status: "applied", revision, output: { opened: false, fileName: null } };
        }
        const result = await holder.current.open({
          ...(input.text === undefined ? {} : { text: input.text }),
          ...(input.fileName === undefined ? {} : { fileName: input.fileName }),
        });
        return {
          status: result.opened ? "applied" : "rejected",
          revision,
          output: { opened: result.opened, fileName: result.fileName },
          ...(result.diagnostics.length === 0 ? {} : { diagnostics: [...result.diagnostics] }),
        };
      },
      rejectionOutput: () => ({ opened: false, fileName: null }),
    });
  }

  if (!bus.hasCommand(NEW_PROJECT_COMMAND)) {
    bus.registerCommand({
      name: NEW_PROJECT_COMMAND,
      description: "Start an empty project, replacing the one that is open.",
      handler: async (_input, context) => {
        const revision = context.store.getRevision();
        if (holder.current === null) {
          return { status: "rejected", revision, diagnostics: [NO_SURFACE], output: { created: false } };
        }
        // §V36: a dry run must not throw the open document away.
        if (context.dryRun) {
          return { status: "applied", revision, output: { created: false } };
        }
        const result = await holder.current.create();
        return {
          status: result.created ? "applied" : "rejected",
          revision,
          output: { created: result.created },
          ...(result.diagnostics.length === 0 ? {} : { diagnostics: [...result.diagnostics] }),
        };
      },
      rejectionOutput: () => ({ created: false }),
    });
  }

  return holder;
}
