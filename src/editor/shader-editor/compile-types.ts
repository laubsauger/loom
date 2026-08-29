import type { NodeId } from "@domain/types/ids.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";

/**
 * The shader compile contract (doc §9.3, §V9, §V27).
 *
 * Nothing here touches WebGPU or `vgpu`. The editor talks to a `ShaderCompiler` that the
 * app wires to `src/runtime/backend`, and tests pass a fake — so every invariant in this
 * track is provable without a GPU (§V2, §V3).
 */

/** One entry in the pipeline's bind-group layout. Part of the cache key (doc §9.3). */
export interface ShaderBinding {
  readonly group: number;
  readonly binding: number;
  /** Resource class as the layout declares it: `sampler`, `texture`, `uniform`, … */
  readonly kind: string;
}

/**
 * Everything that can change the compiled artifact. Two requests with equal fields must
 * produce the same program — that is what makes the cache sound.
 */
export interface ShaderCompileRequest {
  readonly nodeId: NodeId;
  readonly source: string;
  readonly entryPoints: readonly string[];
  /** Render-target signature: colour formats, sample count, depth — whatever differs. */
  readonly targetSignature: string;
  /** Pipeline-overridable constants, by name. */
  readonly constants: Readonly<Record<string, number>>;
  readonly bindingLayout: readonly ShaderBinding[];
  /** Shown as `source.file` on diagnostics. Defaults to the node id. */
  readonly file?: string;
}

/**
 * A WebGPU `GPUCompilationMessage`, restated so this module does not depend on a GPU
 * type. Both `lineNum` and `linePos` are **1-based**, and `0` means "position unknown" —
 * that is the WebGPU contract, and the source of every off-by-one in this area.
 */
export interface ShaderCompilationMessage {
  readonly type: "error" | "warning" | "info";
  readonly message: string;
  /** 1-based line. 0 = unknown. */
  readonly lineNum: number;
  /** 1-based column in UTF-16 code units. 0 = unknown. */
  readonly linePos: number;
  /** UTF-16 offset into the source, when the implementation reports one. */
  readonly offset?: number;
  /** Length of the highlighted run in UTF-16 code units. */
  readonly length?: number;
}

/**
 * A program that compiled successfully. `artifact` is whatever the backend hands back
 * and is never inspected here — the editor only needs to know one exists and which
 * signature produced it (§V9).
 */
export interface CompiledShaderProgram {
  readonly signature: string;
  readonly artifact: unknown;
}

export interface ShaderCompileOutput {
  readonly status: "ok" | "failed";
  /** Present when `status === "ok"`. */
  readonly artifact?: unknown;
  readonly messages: readonly ShaderCompilationMessage[];
}

/**
 * The injected seam. The production implementation asks `RenderBackend` to compile;
 * tests pass a fake that resolves, rejects, or hangs on demand.
 */
export interface ShaderCompiler {
  compile(request: ShaderCompileRequest, signal: AbortSignal): Promise<ShaderCompileOutput>;
}

/**
 * A diagnostic resolved to a character range in the editor document (§V27).
 * Lives here rather than beside the React component so the mapping is testable without
 * a DOM.
 */
export interface ShaderEditorMarker {
  readonly severity: "error" | "warning" | "info";
  readonly message: string;
  readonly from: number;
  readonly to: number;
}

/** Errors, warnings and info, kept apart — §V27 requires warnings to display separately. */
export interface ShaderProblems {
  readonly errors: readonly RuntimeDiagnostic[];
  readonly warnings: readonly RuntimeDiagnostic[];
  readonly info: readonly RuntimeDiagnostic[];
}
