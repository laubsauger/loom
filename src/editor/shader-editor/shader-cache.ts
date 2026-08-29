import type { ShaderCompileOutput } from "./compile-types.ts";

/**
 * Bounded LRU of compile results, keyed by `shaderSignature` (doc §9.3).
 *
 * Failures are cached too. Typing back into a broken state is the single most common
 * edit in a shader editor — undo, retype, undo — and recompiling known-bad text costs
 * the same as recompiling good text while producing an answer we already have.
 */
export interface ShaderCompileCache {
  get(signature: string): ShaderCompileOutput | undefined;
  set(signature: string, output: ShaderCompileOutput): void;
  readonly size: number;
  clear(): void;
}

export const DEFAULT_SHADER_CACHE_SIZE = 32;

export function createShaderCompileCache(
  maxEntries: number = DEFAULT_SHADER_CACHE_SIZE,
): ShaderCompileCache {
  const limit = Math.max(1, Math.floor(maxEntries));
  // Map preserves insertion order, so the first key is always the least recently used
  // once every read re-inserts.
  const entries = new Map<string, ShaderCompileOutput>();

  return {
    get size() {
      return entries.size;
    },
    get(signature) {
      const hit = entries.get(signature);
      if (hit === undefined) return undefined;
      entries.delete(signature);
      entries.set(signature, hit);
      return hit;
    },
    set(signature, output) {
      entries.delete(signature);
      entries.set(signature, output);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    clear() {
      entries.clear();
    },
  };
}
