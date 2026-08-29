import type { RuntimeDiagnostic } from "../../domain/types/diagnostics.ts";

/**
 * Diagnostic codes emitted by the GPU backend. Stable strings — the problems tab,
 * agent tools and tests all key off them (§I.diag).
 */
export const BackendDiagnosticCode = {
  deviceLost: "backend/device-lost",
  deviceRestored: "backend/device-restored",
  rebuildFailed: "backend/rebuild-failed",
  temporalReset: "backend/temporal-reset",
  initFailed: "backend/init-failed",
  notInitialized: "backend/not-initialized",
  planInvalid: "backend/plan-invalid",
  planNotCurrent: "backend/plan-not-current",
  unknownResource: "backend/unknown-resource",
  unknownOutput: "backend/unknown-output",
  unknownPass: "backend/unknown-pass",
  capabilityBelowBaseline: "backend/capability-below-baseline",
  timestampUnavailable: "backend/timestamp-unavailable",
  frameError: "backend/frame-error",
  submissionHalted: "backend/submission-halted",
  compileFailed: "backend/compile-failed",
  resourceLimit: "backend/resource-limit",
  presentFailed: "backend/present-failed",
} as const;

export type BackendDiagnosticCodeValue =
  (typeof BackendDiagnosticCode)[keyof typeof BackendDiagnosticCode];

export type DiagnosticListener = (diagnostic: RuntimeDiagnostic) => void;

export interface DiagnosticHub {
  subscribe(listener: DiagnosticListener): () => void;
  report(diagnostic: RuntimeDiagnostic): void;
  /** Diagnostics reported so far, newest last. Bounded so a failing frame cannot grow forever. */
  readonly log: ReadonlyArray<RuntimeDiagnostic>;
}

const MAX_LOG = 256;

/** Repeats of an identical diagnostic inside this window are counted, not re-emitted (T99). */
const DEDUPE_WINDOW_MS = 1000;

export interface DiagnosticHubOptions {
  /** Injectable clock for deterministic dedupe tests. */
  now?: () => number;
}

export function createDiagnosticHub(options: DiagnosticHubOptions = {}): DiagnosticHub {
  const now = options.now ?? Date.now;
  const listeners = new Set<DiagnosticListener>();
  const log: RuntimeDiagnostic[] = [];
  // Keyed by the full identity of the diagnostic: two *different* messages with the
  // same code (say, two invalid passes in one compile) must both surface — only true
  // per-frame repeats (a stale-plan warning at 60fps) are collapsed.
  const recent = new Map<string, { lastEmitted: number; suppressed: number }>();

  return {
    get log() {
      return log;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    report(diagnostic) {
      const key = `${diagnostic.code}|${diagnostic.nodeId ?? ""}|${diagnostic.message}`;
      const at = now();
      const seen = recent.get(key);
      if (seen !== undefined && at - seen.lastEmitted < DEDUPE_WINDOW_MS) {
        seen.suppressed += 1;
        return;
      }

      const emitted =
        seen !== undefined && seen.suppressed > 0
          ? { ...diagnostic, message: `${diagnostic.message} (${seen.suppressed} repeat(s) suppressed)` }
          : diagnostic;
      recent.set(key, { lastEmitted: at, suppressed: 0 });
      if (recent.size > MAX_LOG) recent.delete(recent.keys().next().value as string);

      log.push(emitted);
      if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
      for (const listener of listeners) listener(emitted);
    },
  };
}

export function backendDiagnostic(
  severity: RuntimeDiagnostic["severity"],
  code: BackendDiagnosticCodeValue,
  message: string,
  extra?: Omit<RuntimeDiagnostic, "severity" | "code" | "message">,
): RuntimeDiagnostic {
  return { severity, code, message, ...extra };
}

/** Best-effort message extraction — vgpu throws VGPUError, hosts can throw anything. */
export function describeError(error: unknown): string {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? `${code}: ${error.message}` : error.message;
  }
  return String(error);
}
