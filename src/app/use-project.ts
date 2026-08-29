import { useCallback, useEffect, useRef, useState } from "react";
import { buildProjectFile, loadProject } from "@domain/project/index.ts";
import type { LoadProjectSuccess } from "@domain/project/index.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { registerProjectCommands } from "./project-commands.ts";
import type { ProjectNewResult, ProjectOpenResult, ProjectSaveResult } from "./project-commands.ts";
import { readProjectFile, writeProjectFile } from "./project-io.ts";
import type { OpenOutcome, SaveOutcome } from "./project-io.ts";

/**
 * Open and save, wired (T43, T139, §V10, §V29).
 *
 * The serializer, the loader, the forward-compat lane and the file-picker constants all
 * existed; what did not exist was anything that called them. This hook is the caller,
 * and it deliberately owns none of the policy: `buildProjectFile` decides what the bytes
 * are, `loadProject` decides what a file means, and `project-io.ts` decides how bytes
 * reach a disk. What is left here is the sequencing, which is where the real rules live:
 *
 *  - an autosave flush happens BEFORE a manual save, so the two writers cannot disagree
 *    about what "the current document" was;
 *  - a failed load changes nothing — the open project stays open and the reason is
 *    reported, because losing the session to a bad file is a worse outcome than the bad
 *    file;
 *  - every diagnostic the loader produced is surfaced, including the ones that say the
 *    file was written by a newer build (§V68) and the ones naming unknown node types
 *    that came back as placeholders (§V10).
 *
 * Both routes go through the bus (§V29): the mod+s binding has named `project.save`
 * since the keymap landed, and it resolves now.
 */

export interface ProjectWiringOptions {
  /** Pending autosave write, forced before a manual save. */
  readonly flushAutosave: () => Promise<void>;
  /** Hands the loaded document to whoever can adopt it (see `project-commands.ts`). */
  readonly onDocumentLoaded: (result: LoadProjectSuccess) => void;
  /**
   * Starts an empty project (§V165). The root replaces the runtime, exactly as it does
   * for an open — see `adoptDocument` in `app.tsx`.
   */
  readonly onNewProject?: () => void;
  /**
   * "Is there unsaved work?" — the one question that makes a destructive verb ask first
   * (§V93, §V165). Absent, nothing ever asks, which is the wrong default but a truthful
   * one for a caller that does not track it.
   */
  readonly isDirty?: () => boolean;
  /**
   * Fired when bytes actually reached a file — not on a cancelled picker.
   *
   * The dirty flag (T189) is "the store's revision is above the last one written", and
   * this is the only moment anything knows what was written. Without it the app errs
   * toward asking before an open, which is the safe direction but a needless prompt.
   */
  readonly onSaved?: () => void;
  /** Test seams for the browser halves. */
  readonly write?: (file: ReturnType<typeof buildProjectFile>) => Promise<SaveOutcome>;
  readonly read?: () => Promise<OpenOutcome>;
}

/**
 * A destructive verb waiting on the user (§V166).
 *
 * The command is SUSPENDED while this is set: it resolves when one of the three actions
 * is chosen, so the confirmation belongs to the command and every route through it —
 * button, hotkey, palette, agent — asks the same question and honours the same answer.
 */
export interface PendingConfirm {
  /** What is about to happen, in the user's words. */
  readonly action: string;
  /** Saves, then continues. The primary action (§V166). */
  save(): void;
  /** Continues without saving. */
  discard(): void;
  cancel(): void;
}

export interface ProjectWiring {
  /** Save/open diagnostics, merged into the problems tab. */
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** Last file written or read, for the top bar. */
  readonly fileName: string | null;
  readonly busy: boolean;
  /** Non-null while a destructive verb is waiting for the user (§V166). */
  readonly confirm: PendingConfirm | null;
  save(): void;
  open(): void;
  /** Starts an empty project, asking first when there is unsaved work (§V165). */
  create(): void;
  /** Opens bytes we already have — the restore-on-launch path. */
  openText(text: string, fileName?: string): void;
}

export function useProject(runtime: AppRuntime, options: ProjectWiringOptions): ProjectWiring {
  const {
    flushAutosave,
    onDocumentLoaded,
    onNewProject,
    isDirty,
    onSaved,
    write = writeProjectFile,
    read = readProjectFile,
  } = options;

  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Read through refs so the registered handlers never go stale without re-registering.
  const latest = useRef({
    runtime,
    flushAutosave,
    onDocumentLoaded,
    onNewProject,
    isDirty,
    onSaved,
    write,
    read,
  });
  latest.current = {
    runtime,
    flushAutosave,
    onDocumentLoaded,
    onNewProject,
    isDirty,
    onSaved,
    write,
    read,
  };

  const [pending, setPending] = useState<PendingConfirm | null>(null);

  const save = useCallback(async (): Promise<ProjectSaveResult> => {
    const { runtime: current, flushAutosave: flush, write: writeFile } = latest.current;
    // Before the picker opens, not after: the debounced snapshot and the file the user
    // is about to choose must describe the same document.
    await flush();

    const file = buildProjectFile({
      document: current.projectDocument(),
      components: current.components.all(),
    });
    const outcome = await writeFile(file);

    if (outcome.kind === "cancelled") {
      return { saved: false, fileName: null, diagnostics: [] };
    }
    if (outcome.kind === "failed") {
      return {
        saved: false,
        fileName: null,
        diagnostics: [
          {
            severity: "error",
            code: "project.save.failed",
            message: `The project could not be saved: ${outcome.reason}`,
          },
        ],
      };
    }
    return { saved: true, fileName: outcome.fileName, diagnostics: [] };
  }, []);

  const open = useCallback(
    async (input: { text?: string | undefined; fileName?: string | undefined }): Promise<ProjectOpenResult> => {
      const { runtime: current, read: readFile, onDocumentLoaded: adopt } = latest.current;

      let text = input.text;
      let name = input.fileName ?? null;
      if (text === undefined) {
        const outcome = await readFile();
        if (outcome.kind === "cancelled") return { opened: false, fileName: null, diagnostics: [] };
        if (outcome.kind === "failed") {
          return {
            opened: false,
            fileName: null,
            diagnostics: [
              {
                severity: "error",
                code: "project.open.failed",
                message: `The file could not be read: ${outcome.reason}`,
              },
            ],
          };
        }
        text = outcome.text;
        name = outcome.fileName;
      }

      const result = loadProject(text, {
        nodes: current.registry,
        components: current.components,
      });

      if (!result.ok) {
        // Nothing changes. The open project is still open, which is the whole reason
        // `loadProject` reports instead of throwing.
        return {
          opened: false,
          fileName: name,
          diagnostics: [
            ...result.diagnostics,
            {
              severity: "error",
              code: "project.open.rejected",
              message: `That file is not a project this build can open: ${result.reason}`,
              suggestion: "The project that was open has not been touched.",
            },
          ],
        };
      }

      adopt(result);
      return { opened: true, fileName: name, diagnostics: result.diagnostics };
    },
    [],
  );

  /**
   * Asks before a destructive verb throws unsaved work away (§V93, §V165, §V166).
   *
   * Returns the user's choice, and RESOLVES the command that is waiting on it — which is
   * why the confirmation lives here and not on a button. Three outcomes, never two: a
   * dialog that exists to protect unsaved work must make saving the shortest path through
   * it, not the longest one (§V166).
   *
   * Nothing to lose = nothing to ask. A clean document continues straight through.
   */
  const askUnsaved = useCallback((action: string): Promise<"save" | "discard" | "cancel"> => {
    if (latest.current.isDirty?.() !== true) return Promise.resolve("discard");
    return new Promise((resolve) => {
      const settle = (choice: "save" | "discard" | "cancel") => () => {
        setPending(null);
        resolve(choice);
      };
      setPending({
        action,
        save: settle("save"),
        discard: settle("discard"),
        cancel: settle("cancel"),
      });
    });
  }, []);

  // One registration per bus; the holder is what a remount replaces.
  useEffect(() => {
    const holder = registerProjectCommands(runtime.bus);
    const handlers = {
      async save(input: { saveAs: boolean }): Promise<ProjectSaveResult> {
        void input.saveAs; // Every save picks a destination today; there is no handle to reuse yet.
        setBusy(true);
        try {
          const result = await save();
          setDiagnostics(result.diagnostics);
          if (result.fileName !== null) setFileName(result.fileName);
          if (result.saved) latest.current.onSaved?.();
          return result;
        } finally {
          setBusy(false);
        }
      },
      async open(input: { text?: string | undefined; fileName?: string | undefined }): Promise<ProjectOpenResult> {
        // Only the PICKER route asks. `openText` is the restore-a-snapshot path, where
        // the user has already answered this question by choosing Restore.
        if (input.text === undefined) {
          const guard = await confirmDestructive("Open another project");
          if (guard !== null) return { opened: false, fileName: null, diagnostics: guard };
        }
        setBusy(true);
        try {
          const result = await open(input);
          setDiagnostics(result.diagnostics);
          if (result.opened && result.fileName !== null) setFileName(result.fileName);
          return result;
        } finally {
          setBusy(false);
        }
      },
      async create(): Promise<ProjectNewResult> {
        const guard = await confirmDestructive("Start a new project");
        if (guard !== null) return { created: false, diagnostics: guard };
        const start = latest.current.onNewProject;
        if (start === undefined) {
          return {
            created: false,
            diagnostics: [
              {
                severity: "error",
                code: "project.new.unsupported",
                message: "This surface cannot start a new project.",
              },
            ],
          };
        }
        setDiagnostics([]);
        setFileName(null);
        start();
        return { created: true, diagnostics: [] };
      },
    };

    /**
     * Runs the §V166 confirmation. Null = go ahead; a diagnostic list = stop, and why.
     *
     * "Save and continue" that fails to save STOPS. Continuing anyway would be the exact
     * outcome the user clicked Save to avoid.
     */
    async function confirmDestructive(action: string): Promise<RuntimeDiagnostic[] | null> {
      const choice = await askUnsaved(action);
      if (choice === "cancel") return [];
      if (choice === "discard") return null;
      const saved = await handlers.save({ saveAs: false });
      return saved.saved ? null : [...saved.diagnostics];
    }
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
  }, [askUnsaved, open, runtime.bus, save]);

  // §V29: the buttons execute the command; they do not call the handler this hook just
  // registered. Same path as the hotkey, the palette and an agent adapter.
  const { bus, invocation } = runtime;

  const requestSave = useCallback(() => {
    void bus.execute("project.save", {}, invocation);
  }, [bus, invocation]);

  const requestOpen = useCallback(() => {
    void bus.execute("project.open", {}, invocation);
  }, [bus, invocation]);

  const requestNew = useCallback(() => {
    void bus.execute("project.new", {}, invocation);
  }, [bus, invocation]);

  const requestOpenText = useCallback(
    (text: string, name?: string) => {
      void bus.execute(
        "project.open",
        name === undefined ? { text } : { text, fileName: name },
        invocation,
      );
    },
    [bus, invocation],
  );

  return {
    diagnostics,
    fileName,
    busy,
    confirm: pending,
    save: requestSave,
    open: requestOpen,
    create: requestNew,
    openText: requestOpenText,
  };
}
