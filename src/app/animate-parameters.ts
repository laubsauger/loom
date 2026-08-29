import { isUniformOnlyChange } from "@compiler/index.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { UniformValue, UniformValues } from "@runtime/backend/plan.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";

/**
 * Pushing animated parameter VALUES, every frame, without recompiling (T259, §V163, §V5).
 *
 * ## The gap this closes
 *
 * An LFO in the document drives a parameter by name, deterministically, from the frame
 * input — and the resolver was the only thing that knew. Nothing re-resolved per frame, so
 * the number moved and the picture did not. A correct resolver is not the feature; the
 * feature is the push.
 *
 * ## Why it cannot be a recompile
 *
 * §V5: dragging a slider must not rebuild a pipeline, and an animated parameter is a
 * slider being dragged sixty times a second. So the per-frame plan is compiled with the
 * SAME graph, topology and resources — only `resolution` (the frame, and the channel
 * resolver) differs — and the only thing that can therefore differ in the result is pass
 * uniform VALUES. `isUniformOnlyChange` is asserted rather than assumed: if a frame ever
 * produces a structurally different plan, this refuses to touch the GPU and says so,
 * because silently recompiling at frame rate is exactly what §V5 forbids.
 *
 * ## Why it is stateful
 *
 * Only CHANGED blocks are written. A graph where one of forty passes animates must cost
 * one `writeBuffer` per frame, not forty — and a parameter that is animated but momentarily
 * still costs nothing at all.
 */

export interface UniformAnimator {
  /**
   * Writes the uniform blocks that changed since the last push.
   *
   * Returns the number of blocks written, or `null` when `next` is not a values-only
   * variation of `base` — which is a bug in the caller's gating, never something to
   * recover from by recompiling.
   */
  push(backend: ShaderloomBackend, base: CompiledGraph, next: CompiledGraph): number | null;
  /** Forget what was pushed. Call when the structural plan is replaced. */
  reset(): void;
}

function sameValue(a: UniformValue | undefined, b: UniformValue | undefined): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => entry === b[index]);
  }
  return false;
}

function sameBlock(a: UniformValues | undefined, b: UniformValues | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  const keys = Object.keys(b);
  if (Object.keys(a).length !== keys.length) return false;
  return keys.every((key) => sameValue(a[key], b[key]));
}

/** Every pass that carries a uniform block, by id. Swap passes carry none. */
function blocksOf(plan: CompiledGraph): Map<string, UniformValues> {
  const blocks = new Map<string, UniformValues>();
  for (const pass of plan.passes) {
    const uniforms = "uniforms" in pass ? pass.uniforms : undefined;
    if (uniforms !== undefined) blocks.set(pass.id, uniforms);
  }
  return blocks;
}

export function createUniformAnimator(): UniformAnimator {
  let pushed: Map<string, UniformValues> | null = null;

  return {
    push(backend, base, next) {
      if (!isUniformOnlyChange(base, next)) return null;

      const blocks = blocksOf(next);
      // The first push of a plan compares against the STRUCTURAL plan's own values, so a
      // frame whose values happen to equal the compile-time ones writes nothing.
      const previous = pushed ?? blocksOf(base);

      let written = 0;
      for (const [passId, values] of blocks) {
        if (sameBlock(previous.get(passId), values)) continue;
        backend.updateUniforms({ passId, values });
        written += 1;
      }
      pushed = blocks;
      return written;
    },
    reset() {
      pushed = null;
    },
  };
}
