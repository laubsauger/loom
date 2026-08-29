import type { NodeId } from "@domain/types/ids.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type {
  CompiledShaderProgram,
  ShaderCompileOutput,
  ShaderCompileRequest,
  ShaderCompiler,
} from "./compile-types.ts";
import { createShaderCompileCache } from "./shader-cache.ts";
import type { ShaderCompileCache } from "./shader-cache.ts";
import { shaderSignature } from "./shader-signature.ts";
import {
  internalCompileDiagnostic,
  partitionDiagnostics,
  toRuntimeDiagnostics,
} from "./shader-diagnostics.ts";

/**
 * The shader compile pipeline (T21, T22) — debounce, async compile, cache, and the
 * last-valid retention that §V9 turns on.
 *
 * ## Why this is not a React hook
 *
 * Every rule worth getting right is in here, and none of it is about rendering. Someone
 * mid-keystroke has invalid WGSL almost continuously; if a failed compile blanked the
 * output, the tool would flicker to black on most characters typed. So the pipeline
 * keeps the last program that compiled and flags the output stale instead (§V9), and
 * that behaviour is proven in a plain node test, not through a DOM.
 *
 * ## The rules, stated once
 *
 *  - A request never compiles immediately: it waits out a quiet window, so a burst of
 *    keystrokes costs one compile (doc §9.3).
 *  - A compile whose result arrives after a newer one started is dropped. The newest
 *    request always wins, whatever order the promises settle in.
 *  - Success installs the program and clears `stale`.
 *  - Failure changes nothing about the program. `stale` becomes true if — and only if —
 *    there is a retained program that the editor text no longer matches.
 *  - Every path settles. A compile that throws is still a settled failure, so `phase`
 *    always returns to `"idle"` and a stale flag always has a way out.
 */

export type ShaderCompilePhase = "idle" | "pending" | "compiling";

export interface ShaderCompileState {
  readonly phase: ShaderCompilePhase;
  /** The node whose shader the pipeline currently tracks. */
  readonly nodeId: NodeId | null;
  /** Last program that compiled. Retained across failures (§V9). */
  readonly program: CompiledShaderProgram | null;
  /** True when `program` is being rendered but no longer matches the editor text (§V9). */
  readonly stale: boolean;
  readonly errors: readonly RuntimeDiagnostic[];
  readonly warnings: readonly RuntimeDiagnostic[];
  readonly info: readonly RuntimeDiagnostic[];
  /** Compiles actually handed to the compiler — debounce coalescing is observable here. */
  readonly compileCount: number;
  readonly cacheHits: number;
}

export interface ShaderCompilePipeline {
  readonly state: ShaderCompileState;
  subscribe(listener: (state: ShaderCompileState) => void): () => void;
  /** Queue a compile for `request`, restarting the debounce window. */
  request(request: ShaderCompileRequest): void;
  /** Compile the queued request now and wait for it to settle (blur, explicit action, tests). */
  flush(): Promise<void>;
  dispose(): void;
}

/** Cancellable delay. Injected so tests drive the clock instead of waiting on it. */
export interface CompileScheduler {
  schedule(callback: () => void, delayMs: number): () => void;
}

export const timeoutScheduler: CompileScheduler = {
  schedule(callback, delayMs) {
    const handle = setTimeout(callback, delayMs);
    return () => {
      clearTimeout(handle);
    };
  },
};

/** Long enough to swallow a typing burst, short enough to feel live. */
export const DEFAULT_SHADER_DEBOUNCE_MS = 300;

export interface ShaderCompilePipelineOptions {
  readonly compiler: ShaderCompiler;
  readonly debounceMs?: number;
  readonly cache?: ShaderCompileCache;
  readonly scheduler?: CompileScheduler;
}

const INITIAL_STATE: ShaderCompileState = {
  phase: "idle",
  nodeId: null,
  program: null,
  stale: false,
  errors: [],
  warnings: [],
  info: [],
  compileCount: 0,
  cacheHits: 0,
};

export function createShaderCompilePipeline(
  options: ShaderCompilePipelineOptions,
): ShaderCompilePipeline {
  const { compiler } = options;
  const debounceMs = options.debounceMs ?? DEFAULT_SHADER_DEBOUNCE_MS;
  const cache = options.cache ?? createShaderCompileCache();
  const scheduler = options.scheduler ?? timeoutScheduler;

  const listeners = new Set<(state: ShaderCompileState) => void>();
  let state: ShaderCompileState = INITIAL_STATE;
  let pending: ShaderCompileRequest | null = null;
  let cancelDebounce: (() => void) | null = null;
  let inflight: { controller: AbortController; settled: Promise<void> } | null = null;
  /** Bumped whenever a newer compile starts; stale results check it and bail. */
  let generation = 0;
  let disposed = false;

  function commit(next: ShaderCompileState): void {
    state = next;
    for (const listener of [...listeners]) listener(state);
  }

  function clearDebounce(): void {
    if (cancelDebounce !== null) {
      cancelDebounce();
      cancelDebounce = null;
    }
  }

  function settle(
    request: ShaderCompileRequest,
    signature: string,
    output: ShaderCompileOutput,
  ): void {
    const context =
      request.file === undefined
        ? { nodeId: request.nodeId }
        : { nodeId: request.nodeId, file: request.file };
    const { errors, warnings, info } = partitionDiagnostics(
      toRuntimeDiagnostics(output.messages, context),
    );

    if (output.status === "ok") {
      commit({
        ...state,
        phase: "idle",
        nodeId: request.nodeId,
        program: { signature, artifact: output.artifact },
        stale: false,
        errors,
        warnings,
        info,
      });
      return;
    }

    // §V9. The program is untouched — the render keeps running on it — and the output is
    // flagged stale only when there is in fact a program behind it. A shader that has
    // never compiled has nothing to be stale about; it simply has no output yet.
    commit({
      ...state,
      phase: "idle",
      nodeId: request.nodeId,
      stale: state.program !== null,
      errors,
      warnings,
      info,
    });
  }

  function settleThrown(request: ShaderCompileRequest, error: unknown): void {
    const context =
      request.file === undefined
        ? { nodeId: request.nodeId }
        : { nodeId: request.nodeId, file: request.file };
    commit({
      ...state,
      phase: "idle",
      nodeId: request.nodeId,
      stale: state.program !== null,
      errors: [internalCompileDiagnostic(error, context)],
      warnings: [],
      info: [],
    });
  }

  async function start(): Promise<void> {
    const request = pending;
    pending = null;
    if (request === null || disposed) return;

    // Supersede anything already running: its result is about older text.
    generation += 1;
    const mine = generation;
    inflight?.controller.abort();
    inflight = null;

    const signature = shaderSignature(request);
    const cached = cache.get(signature);
    if (cached !== undefined) {
      commit({ ...state, cacheHits: state.cacheHits + 1 });
      settle(request, signature, cached);
      return;
    }

    const controller = new AbortController();
    commit({
      ...state,
      phase: "compiling",
      nodeId: request.nodeId,
      compileCount: state.compileCount + 1,
    });

    const settled = (async () => {
      let output: ShaderCompileOutput;
      try {
        output = await compiler.compile(request, controller.signal);
      } catch (error) {
        if (mine !== generation || disposed) return;
        inflight = null;
        // Not cached: a throw is a property of the moment, not of the text.
        settleThrown(request, error);
        return;
      }
      if (mine !== generation || disposed) return;
      inflight = null;
      cache.set(signature, output);
      settle(request, signature, output);
    })();

    inflight = { controller, settled };
    await settled;
  }

  return {
    get state() {
      return state;
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },

    request(next) {
      if (disposed) return;
      clearDebounce();
      pending = next;

      // A different node's shader is a different subject: its predecessor's program,
      // errors and stale flag must not be attributed to it.
      const switching = state.nodeId !== null && state.nodeId !== next.nodeId;
      commit(
        switching
          ? { ...state, phase: "pending", nodeId: next.nodeId, program: null, stale: false, errors: [], warnings: [], info: [] }
          : { ...state, phase: "pending", nodeId: next.nodeId },
      );

      cancelDebounce = scheduler.schedule(() => {
        cancelDebounce = null;
        void start();
      }, debounceMs);
    },

    async flush() {
      clearDebounce();
      if (pending !== null) {
        await start();
        return;
      }
      if (inflight !== null) await inflight.settled;
    },

    dispose() {
      disposed = true;
      clearDebounce();
      pending = null;
      inflight?.controller.abort();
      inflight = null;
      listeners.clear();
    },
  };
}
