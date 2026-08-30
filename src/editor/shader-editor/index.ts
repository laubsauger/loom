/**
 * WGSL shader editor and its diagnostics (T20, T21, T22).
 *
 * Two halves, deliberately separable:
 *  - the compile pipeline — debounce, cache, last-valid retention, line/column mapping —
 *    which is plain logic and carries every invariant (§V9, §V27);
 *  - a CodeMirror 6 surface and three dock components that render it.
 *
 * The app fills the shell's `shaderEditor` slot with `ShaderPane` (`app/dock-panes.tsx`),
 * which wraps the `ShaderEditor` surface below; it fills `problems` with `ProblemsPanel`,
 * and the graph canvas places `ShaderStatusBadge` on the node.
 *
 * There is no `ShaderEditorPanel` here any more, and the sentence that used to name one is
 * why this needed a task (B35, T337). It stated that the app mounted this module's pane
 * while nothing did — a docblock asserting its own liveness is how the next person stops
 * checking, and it is what made this a fourteenth instance rather than a first discovery.
 * Its §V9 stale line and its §V27 counts were folded into `ShaderPane`, which owns the
 * commit buffer and the keymap context and was already the one the app renders (§V242:
 * fold, do not switch).
 */

export { wgsl, wgslLanguage, wgslStreamParser, WGSL_TOKEN_TABLE } from "./wgsl-language.ts";
export type { WgslTokenName, WgslTokenizerState } from "./wgsl-language.ts";

export {
  REQUESTED_SYNTAX_TOKENS,
  shaderEditorHighlighting,
  shaderEditorTheme,
  wgslHighlightStyle,
} from "./theme.ts";

export type {
  CompiledShaderProgram,
  ShaderBinding,
  ShaderCompilationMessage,
  ShaderCompileOutput,
  ShaderCompileRequest,
  ShaderCompiler,
  ShaderEditorMarker,
  ShaderProblems,
} from "./compile-types.ts";

export { normalizeShaderSource, shaderSignature } from "./shader-signature.ts";
export {
  DEFAULT_SHADER_CACHE_SIZE,
  createShaderCompileCache,
} from "./shader-cache.ts";
export type { ShaderCompileCache } from "./shader-cache.ts";

export {
  ShaderDiagnosticCode,
  describeCompileError,
  diagnosticsToMarkers,
  formatDiagnosticLocation,
  internalCompileDiagnostic,
  lineStartOffsets,
  messageRange,
  partitionDiagnostics,
  staleOutputDiagnostic,
  toRuntimeDiagnostic,
  toRuntimeDiagnostics,
} from "./shader-diagnostics.ts";
export type { DiagnosticContext, SourceRange } from "./shader-diagnostics.ts";

export {
  DEFAULT_SHADER_DEBOUNCE_MS,
  createShaderCompilePipeline,
  timeoutScheduler,
} from "./compile-pipeline.ts";
export type {
  CompileScheduler,
  ShaderCompilePhase,
  ShaderCompilePipeline,
  ShaderCompilePipelineOptions,
  ShaderCompileState,
} from "./compile-pipeline.ts";

export { SHADER_EDIT_LABEL, commitShaderSource, shaderSourcePatch } from "./commit-shader-source.ts";
export type { CommitShaderSourceOptions } from "./commit-shader-source.ts";

export { useShaderCompileState } from "./use-shader-compile.ts";

export { ShaderEditor } from "./shader-editor.tsx";
export type { ShaderEditorProps } from "./shader-editor.tsx";
export { ProblemsPanel } from "./problems-panel.tsx";
export type { ProblemsPanelProps } from "./problems-panel.tsx";
export { ShaderStatusBadge } from "./shader-status-badge.tsx";
export { shaderStatusBadgeProps } from "./shader-status.ts";
export type { ShaderStatusBadgeProps } from "./shader-status.ts";
