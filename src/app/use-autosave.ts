import { useCallback, useEffect, useRef, useState } from "react";
import {
  createAutosave,
  createIndexedDbSnapshotStore,
  findRestoreCandidate,
} from "@domain/project/index.ts";
import type { RestoreCandidate, SnapshotStore } from "@domain/project/index.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { AppRuntime } from "./app-runtime.ts";

/**
 * Autosave, wired (T139, §V10).
 *
 * The scheduler, the retention ring and the IndexedDB adapter all landed built and
 * tested and none of them was reachable: nothing subscribed them to a commit. This is
 * that subscription, plus the two things a scheduler cannot do for itself — flush before
 * the tab goes away, and offer the newest snapshot back on the next launch.
 *
 * ## Failing loud
 *
 * `createIndexedDbSnapshotStore()` returns undefined where IndexedDB is not available:
 * private windows in some browsers, storage blocked by policy, a non-browser context.
 * The tempting behaviour is to shrug and continue, and it is the worst one available —
 * the user believes their work is being saved because the tool says it autosaves, and
 * finds out otherwise by losing it. So the absence becomes a diagnostic in the problems
 * tab AND a notice on screen, and the save/open commands still work by hand.
 *
 * ## Rate
 *
 * Every commit calls `notifyChange`; the debounce inside the scheduler is what turns a
 * 60 Hz parameter drag into one write. Serializing on every commit would be the obvious
 * mistake and it is the scheduler's job to avoid, not this hook's.
 */

export const AUTOSAVE_UNAVAILABLE_CODE = "project.autosave.unavailable";
export const AUTOSAVE_FAILED_CODE = "project.autosave.failed";

export interface AutosaveWiring {
  /** Problems-tab diagnostics: storage missing, or a write that failed. */
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** True when there is no snapshot store at all — autosave is OFF, loudly. */
  readonly unavailable: boolean;
  /** Newest snapshot found at launch, if any. The prompt offers it (§T139). */
  readonly restore: RestoreCandidate | null;
  dismissRestore(): void;
  /** Forces any pending write. Awaited before a manual save and on unload. */
  flush(): Promise<void>;
}

export interface UseAutosaveOptions {
  /** Test seam. MUST be stable across renders — it is an effect dependency. */
  readonly createStore?: () => SnapshotStore | undefined;
  readonly debounceMs?: number;
  /** Skips the restore-on-launch lookup (a test that only cares about writes). */
  readonly restoreOnLaunch?: boolean;
}

const noop = async (): Promise<void> => {};

export function useAutosave(runtime: AppRuntime, options: UseAutosaveOptions = {}): AutosaveWiring {
  const { createStore = createIndexedDbSnapshotStore, debounceMs, restoreOnLaunch = true } = options;

  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [restore, setRestore] = useState<RestoreCandidate | null>(null);
  const flushRef = useRef<() => Promise<void>>(noop);

  useEffect(() => {
    const store = createStore();

    if (store === undefined) {
      setUnavailable(true);
      setRestore(null);
      setDiagnostics([
        {
          severity: "warning",
          code: AUTOSAVE_UNAVAILABLE_CODE,
          message: "IndexedDB is not available here, so this project is NOT being autosaved.",
          suggestion:
            "Save to a file with the Save button (or the save shortcut) — the snapshot ring needs storage this browser context does not offer.",
        },
      ]);
      return;
    }

    setUnavailable(false);
    setDiagnostics([]);

    const autosave = createAutosave({
      store,
      getDocument: () => runtime.projectDocument(),
      ...(debounceMs === undefined ? {} : { debounceMs }),
      onError: (error: unknown) => {
        setDiagnostics([
          {
            severity: "warning",
            code: AUTOSAVE_FAILED_CODE,
            message: `An autosave write failed: ${error instanceof Error ? error.message : String(error)}`,
            suggestion: "Save to a file to be sure; storage may be full or blocked.",
          },
        ]);
      },
    });

    flushRef.current = () => autosave.flush();
    const unsubscribe = runtime.bus.store.subscribe(() => autosave.notifyChange());

    // Best effort by construction: `beforeunload` cannot await. Flushing here still
    // turns "the last two seconds of edits" into "the last frame of them".
    const onUnload = () => {
      void autosave.flush();
    };
    if (typeof window !== "undefined") window.addEventListener("beforeunload", onUnload);

    let cancelled = false;
    if (restoreOnLaunch) {
      void findRestoreCandidate(store, runtime.invocation.projectId)
        .then((candidate) => {
          if (!cancelled) setRestore(candidate ?? null);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setDiagnostics((current) => [
            ...current,
            {
              severity: "info",
              code: AUTOSAVE_FAILED_CODE,
              message: `Could not read autosave snapshots: ${error instanceof Error ? error.message : String(error)}`,
            },
          ]);
        });
    }

    return () => {
      cancelled = true;
      if (typeof window !== "undefined") window.removeEventListener("beforeunload", onUnload);
      unsubscribe();
      autosave.dispose();
      flushRef.current = noop;
    };
  }, [createStore, debounceMs, restoreOnLaunch, runtime]);

  const flush = useCallback(() => flushRef.current(), []);
  const dismissRestore = useCallback(() => setRestore(null), []);

  return { diagnostics, unavailable, restore, dismissRestore, flush };
}
