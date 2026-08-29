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

export function createDiagnosticHub(): DiagnosticHub {
  const listeners = new Set<DiagnosticListener>();
  const log: RuntimeDiagnostic[] = [];

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
      log.push(diagnostic);
      if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
      for (const listener of listeners) listener(diagnostic);
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
