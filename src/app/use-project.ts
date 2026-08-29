import { useCallback, useEffect, useRef, useState } from "react";
import { buildProjectFile, loadProject } from "@domain/project/index.ts";
import type { LoadProjectSuccess } from "@domain/project/index.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { registerProjectCommands } from "./project-commands.ts";
import type { ProjectOpenResult, ProjectSaveResult } from "./project-commands.ts";
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
  /** Test seams for the browser halves. */
  readonly write?: (file: ReturnType<typeof buildProjectFile>) => Promise<SaveOutcome>;
  readonly read?: () => Promise<OpenOutcome>;
}

export interface ProjectWiring {
  /** Save/open diagnostics, merged into the problems tab. */
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** Last file written or read, for the top bar. */
  readonly fileName: string | null;
  readonly busy: boolean;
  save(): void;
  open(): void;
  /** Opens bytes we already have — the restore-on-launch path. */
  openText(text: string, fileName?: string): void;
}

export function useProject(runtime: AppRuntime, options: ProjectWiringOptions): ProjectWiring {
  const { flushAutosave, onDocumentLoaded, write = writeProjectFile, read = readProjectFile } = options;

  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const [fileName, setFileName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Read through refs so the registered handlers never go stale without re-registering.
  const latest = useRef({ runtime, flushAutosave, onDocumentLoaded, write, read });
  latest.current = { runtime, flushAutosave, onDocumentLoaded, write, read };

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
          return result;
        } finally {
          setBusy(false);
        }
      },
      async open(input: { text?: string | undefined; fileName?: string | undefined }): Promise<ProjectOpenResult> {
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
    };
    holder.current = handlers;
    return () => {
      if (holder.current === handlers) holder.current = null;
    };
  }, [open, runtime.bus, save]);

  // §V29: the buttons execute the command; they do not call the handler this hook just
  // registered. Same path as the hotkey, the palette and an agent adapter.
  const { bus, invocation } = runtime;

  const requestSave = useCallback(() => {
    void bus.execute("project.save", {}, invocation);
  }, [bus, invocation]);

  const requestOpen = useCallback(() => {
    void bus.execute("project.open", {}, invocation);
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
    save: requestSave,
    open: requestOpen,
    openText: requestOpenText,
  };
}
