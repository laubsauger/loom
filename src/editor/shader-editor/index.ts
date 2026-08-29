/**
 * WGSL shader editor and its diagnostics (T20, T21, T22).
 *
 * Two halves, deliberately separable:
 *  - the compile pipeline — debounce, cache, last-valid retention, line/column mapping —
 *    which is plain logic and carries every invariant (§V9, §V27);
 *  - a CodeMirror 6 surface and three dock components that render it.
 *
 * The app fills the shell's `shaderEditor` and `problems` slots with `ShaderEditorPanel`
 * and `ProblemsPanel`, and the graph canvas places `ShaderStatusBadge` on the node.
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
export { ShaderEditorPanel } from "./shader-editor-panel.tsx";
export type { ShaderEditorPanelProps } from "./shader-editor-panel.tsx";
export { ProblemsPanel } from "./problems-panel.tsx";
export type { ProblemsPanelProps } from "./problems-panel.tsx";
export { ShaderStatusBadge } from "./shader-status-badge.tsx";
export { shaderStatusBadgeProps } from "./shader-status.ts";
export type { ShaderStatusBadgeProps } from "./shader-status.ts";
