import { useCallback, useEffect, useRef, useState } from "react";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { MAX_RETAINED_DIAGNOSTICS, retainDiagnostic } from "./diagnostic-buffer.ts";

/**
 * The way back from a halted device (T98, §V23).
 *
 * §V23 says a lost device halts submission, reports a diagnostic and rebuilds from the
 * domain graph. The backend does all three, and gives up after three failed rebuild
 * attempts with `backend/submission-halted` — at which point the app was, until now, a
 * dead window: nothing submits, nothing retries, and the only affordance was reloading
 * the page and losing the session. `recover()` exists precisely for this and had no
 * caller.
 *
 * Halting is observed through the backend's own diagnostic stream rather than by polling
 * `status.halted`: a poll would be a timer that runs forever to catch an event that
 * almost never happens, and the halt already announces itself.
 */

/**
 * Bound on retained backend diagnostics.
 *
 * T596: the hub dedupes a repeat inside a ONE-SECOND window and then re-emits the
 * condition with a running count, so "already deduped upstream" bounds the RATE and not
 * the total — a warning that stays true costs one entry per second here. `retainDiagnostic`
 * is what keeps that to one SLOT, so this bound counts distinct conditions.
 */
const MAX_DIAGNOSTICS = MAX_RETAINED_DIAGNOSTICS;

export interface GpuRecovery {
  /** True while the backend is refusing to submit work. */
  readonly halted: boolean;
  /** True while a `recover()` attempt is in flight. */
  readonly retrying: boolean;
  /** Runtime diagnostics the backend reported, newest last. */
  readonly diagnostics: readonly RuntimeDiagnostic[];
  /** T465: empty the retained list; anything still real re-reports on its own. */
  clearDiagnostics(): void;
  /** Ask the backend to re-acquire a device. No-op when there is nothing to recover. */
  retry(): void;
}

export function useGpuRecovery(backend: LoomBackend | null | undefined): GpuRecovery {
  const [halted, setHalted] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [diagnostics, setDiagnostics] = useState<readonly RuntimeDiagnostic[]>([]);
  const backendRef = useRef<LoomBackend | null>(backend ?? null);
  backendRef.current = backend ?? null;

  useEffect(() => {
    if (backend === null || backend === undefined) {
      setHalted(false);
      setDiagnostics([]);
      return;
    }
    setHalted(backend.status.halted);
    return backend.onDiagnostic((diagnostic) => {
      setDiagnostics((current) => retainDiagnostic(current, diagnostic, MAX_DIAGNOSTICS));
      // Every transition into and out of the halted state is accompanied by a report,
      // so reading status here is enough — and it is the backend's own answer, not a
      // guess derived from the diagnostic's code.
      setHalted(backend.status.halted);
    });
  }, [backend]);

  const retry = useCallback(() => {
    const active = backendRef.current;
    if (active === null) return;
    setRetrying(true);
    void active
      .recover()
      .catch((error: unknown) => {
        setDiagnostics((current) =>
          retainDiagnostic(
            current,
            {
              severity: "error" as const,
              code: "backend/recover-failed",
              message: `The recovery attempt threw: ${error instanceof Error ? error.message : String(error)}`,
            },
            MAX_DIAGNOSTICS,
          ),
        );
      })
      .finally(() => {
        setRetrying(false);
        // `recover()` resolves when the attempt SETTLES, success or not (T98); the
        // outcome is whatever `status.halted` says afterwards, never an assumption that
        // the call working means the device came back.
        setHalted(backendRef.current?.status.halted ?? false);
      });
  }, []);

  // T465: the problems tab's Clear empties every ACCUMULATING source; anything still
  // real re-reports on its own and thereby proves it is live.
  const clearDiagnostics = useCallback(() => setDiagnostics([]), []);
  return { halted, retrying, diagnostics, clearDiagnostics, retry };
}
