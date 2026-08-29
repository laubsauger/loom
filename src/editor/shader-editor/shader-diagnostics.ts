import type { NodeId } from "@domain/types/ids.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type {
  ShaderCompilationMessage,
  ShaderEditorMarker,
  ShaderProblems,
} from "./compile-types.ts";

/**
 * WGSL compile messages → `RuntimeDiagnostic`, and → editor character ranges (§V27).
 *
 * The whole file exists to hold one boundary honest: **WebGPU reports 1-based line and
 * column, a text document is indexed from 0, and `0` means "no position"**. Every
 * off-by-one in a shader editor lives at that seam, so the conversion happens exactly
 * once, here, with a test either side of it.
 */

/** Stable diagnostic codes. The problems tab, node badge and agent tools key off these. */
export const ShaderDiagnosticCode = {
  error: "shader/compile-error",
  warning: "shader/compile-warning",
  info: "shader/compile-info",
  /** The compile call itself threw or was rejected — not a message from the compiler. */
  internal: "shader/compile-failed",
  /** The rendered output no longer reflects the editor text (§V9). */
  stale: "shader/output-stale",
} as const;

const CODE_BY_TYPE = {
  error: ShaderDiagnosticCode.error,
  warning: ShaderDiagnosticCode.warning,
  info: ShaderDiagnosticCode.info,
} as const;

export interface DiagnosticContext {
  readonly nodeId: NodeId;
  /** Shown as `source.file`. Defaults to the node id. */
  readonly file?: string;
}

/**
 * A reported position is only trustworthy when the line is >= 1. WebGPU uses 0 for
 * "unknown", and forwarding that as line 0 — or "helpfully" bumping it to 1 — both point
 * the user at the wrong place, so an unknown position stays absent instead.
 */
function positionOf(
  message: ShaderCompilationMessage,
  file: string,
): NonNullable<RuntimeDiagnostic["source"]> {
  if (!Number.isFinite(message.lineNum) || message.lineNum < 1) return { file };
  const line = Math.floor(message.lineNum);
  if (!Number.isFinite(message.linePos) || message.linePos < 1) return { file, line };
  return { file, line, column: Math.floor(message.linePos) };
}

export function toRuntimeDiagnostic(
  message: ShaderCompilationMessage,
  context: DiagnosticContext,
): RuntimeDiagnostic {
  const file = context.file ?? context.nodeId;
  return {
    severity: message.type,
    code: CODE_BY_TYPE[message.type],
    message: message.message,
    nodeId: context.nodeId,
    source: positionOf(message, file),
  };
}

export function toRuntimeDiagnostics(
  messages: readonly ShaderCompilationMessage[],
  context: DiagnosticContext,
): RuntimeDiagnostic[] {
  return messages.map((message) => toRuntimeDiagnostic(message, context));
}

/** §V27: warnings display separately from errors, so they are separated at the source. */
export function partitionDiagnostics(
  diagnostics: readonly RuntimeDiagnostic[],
): ShaderProblems {
  const errors: RuntimeDiagnostic[] = [];
  const warnings: RuntimeDiagnostic[] = [];
  const info: RuntimeDiagnostic[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.severity === "error") errors.push(diagnostic);
    else if (diagnostic.severity === "warning") warnings.push(diagnostic);
    else info.push(diagnostic);
  }
  return { errors, warnings, info };
}

/** Character offset of the start of every line, 0-based index → offset. */
export function lineStartOffsets(source: string): number[] {
  const starts = [0];
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === "\n") starts.push(index + 1);
  }
  return starts;
}

export interface SourceRange {
  readonly from: number;
  readonly to: number;
}

/**
 * Character range in `source` for a compilation message, clamped to the document.
 *
 * Prefers the implementation-reported UTF-16 `offset` when there is one; otherwise
 * converts 1-based line/column. A message with no position at all lands at offset 0 —
 * the top of the file, which is where a whole-module error belongs.
 */
export function messageRange(
  source: string,
  message: ShaderCompilationMessage,
): SourceRange {
  const length = source.length;
  const span = Number.isFinite(message.length) ? Math.max(0, Math.floor(message.length ?? 0)) : 0;

  const from = (() => {
    if (Number.isFinite(message.offset) && (message.offset ?? -1) >= 0) {
      return Math.min(Math.floor(message.offset ?? 0), length);
    }
    if (!Number.isFinite(message.lineNum) || message.lineNum < 1) return 0;

    const starts = lineStartOffsets(source);
    // 1-based line → 0-based index. Clamped: a message can outlive the edit that made it.
    const lineIndex = Math.min(Math.floor(message.lineNum) - 1, starts.length - 1);
    const lineStart = starts[lineIndex] ?? 0;
    const nextStart = starts[lineIndex + 1];
    const lineEnd = nextStart === undefined ? length : nextStart - 1;
    // 1-based column → 0-based offset within the line.
    const column = Number.isFinite(message.linePos) ? Math.max(0, Math.floor(message.linePos) - 1) : 0;
    return Math.min(lineStart + column, lineEnd);
  })();

  // A zero-width underline is invisible; give a positionless-length message one column.
  const to = Math.min(length, from + Math.max(span, 1));
  return { from, to: Math.max(from, to) };
}

/**
 * Diagnostics → editor markers. Goes back through the same 1-based → 0-based conversion
 * as `messageRange`, so the underline and the `line:column` in the problems tab cannot
 * disagree with each other.
 */
export function diagnosticsToMarkers(
  source: string,
  diagnostics: readonly RuntimeDiagnostic[],
): ShaderEditorMarker[] {
  return diagnostics.map((diagnostic) => {
    const { from, to } = messageRange(source, {
      type: diagnostic.severity,
      message: diagnostic.message,
      lineNum: diagnostic.source?.line ?? 0,
      linePos: diagnostic.source?.column ?? 0,
    });
    return { severity: diagnostic.severity, message: diagnostic.message, from, to };
  });
}

/** `file:line:column`, or as much of it as the compiler actually reported. */
export function formatDiagnosticLocation(diagnostic: RuntimeDiagnostic): string | null {
  const source = diagnostic.source;
  if (source === undefined || source.line === undefined) return null;
  const column = source.column === undefined ? "" : `:${source.column}`;
  return `${source.line}${column}`;
}

/** Best-effort message for a compile call that threw rather than reporting messages. */
export function describeCompileError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * The compile call itself threw — a lost device, a backend bug, an aborted fetch. It is
 * an error with no position in the shader, and it is deliberately *not* cached: unlike a
 * WGSL syntax error it is not a property of the text, so the same text may compile fine
 * a second later.
 */
export function internalCompileDiagnostic(
  error: unknown,
  context: DiagnosticContext,
): RuntimeDiagnostic {
  return {
    severity: "error",
    code: ShaderDiagnosticCode.internal,
    message: `Shader compilation failed: ${describeCompileError(error)}`,
    nodeId: context.nodeId,
    source: { file: context.file ?? context.nodeId },
  };
}

/** The diagnostic the app shows next to a stale output (§V9). */
export function staleOutputDiagnostic(nodeId: NodeId): RuntimeDiagnostic {
  return {
    severity: "warning",
    code: ShaderDiagnosticCode.stale,
    message: "Shader failed to compile. Showing the last output that did.",
    nodeId,
    suggestion: "Fix the errors in the problems tab; the output refreshes on the next successful compile.",
  };
}
