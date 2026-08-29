import type { ShaderCompileState } from "./compile-pipeline.ts";

export interface ShaderStatusBadgeProps {
  errorCount: number;
  warningCount: number;
  /** Output is running the last program that compiled (§V9). */
  stale?: boolean | undefined;
  compiling?: boolean | undefined;
  className?: string | undefined;
}

/** The node badge's inputs, derived from a pipeline state (§V27). */
export function shaderStatusBadgeProps(state: ShaderCompileState): ShaderStatusBadgeProps {
  return {
    errorCount: state.errors.length,
    warningCount: state.warnings.length,
    stale: state.stale,
    compiling: state.phase === "compiling",
  };
}
