import { describe, expect, it } from "vitest";

import { createUniformAnimator } from "./animate-parameters.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { UniformValues } from "@runtime/backend/plan.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";

/**
 * The per-frame push, on its own (T259, §V163, §V5).
 *
 * `parameter-animation.test.ts` proves the picture moves; this proves the two things a
 * pixel test cannot see. That only CHANGED blocks are written — a graph where one of many
 * passes animates must cost one buffer write per frame, not one per pass — and that a
 * per-frame plan which is NOT a values-only variation is refused rather than pushed,
 * because writing it would be a recompile at frame rate wearing another name (§V5).
 */

function plan(passes: ReadonlyArray<{ id: string; uniforms?: UniformValues }>): CompiledGraph {
  return {
    passes: passes.map((pass) => ({
      kind: "effect",
      id: pass.id,
      shader: "",
      target: "t",
      ...(pass.uniforms === undefined ? {} : { uniforms: pass.uniforms }),
    })),
    resources: [],
    // What `isUniformOnlyChange` compares. Same signatures = same structure.
    resourceSignatures: [{ id: "t", signature: "t@1" }],
    passSignatures: passes.map((pass) => ({ id: pass.id, signature: `${pass.id}@1` })),
    // The whole-plan signature is what `isUniformOnlyChange` compares, and uniform VALUES
    // are excluded from it by construction (§V5) — so it is derived from structure here.
    signature: passes.map((pass) => pass.id).join("|"),
  } as unknown as CompiledGraph;
}

function recordingBackend() {
  const writes: Array<{ passId: string; values: UniformValues }> = [];
  const backend = {
    updateUniforms(update: { passId: string; values: UniformValues }) {
      writes.push({ passId: update.passId, values: update.values });
    },
  } as unknown as LoomBackend;
  return { backend, writes };
}

describe("the per-frame uniform push", () => {
  it("writes only the blocks whose values actually moved", () => {
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = plan([
      { id: "a", uniforms: { level: 0 } },
      { id: "b", uniforms: { level: 5 } },
    ]);

    expect(
      animator.push(backend, base, plan([
        { id: "a", uniforms: { level: 1 } },
        { id: "b", uniforms: { level: 5 } },
      ])),
    ).toBe(1);
    expect(writes.map((write) => write.passId)).toEqual(["a"]);

    // Same values again: nothing to write. An animated parameter that is momentarily
    // still costs nothing.
    expect(
      animator.push(backend, base, plan([
        { id: "a", uniforms: { level: 1 } },
        { id: "b", uniforms: { level: 5 } },
      ])),
    ).toBe(0);
    expect(writes).toHaveLength(1);
  });

  it("compares vectors by value, not by identity", () => {
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = plan([{ id: "a", uniforms: { color: [1, 0, 0] } }]);

    expect(animator.push(backend, base, plan([{ id: "a", uniforms: { color: [1, 0, 0] } }]))).toBe(0);
    expect(animator.push(backend, base, plan([{ id: "a", uniforms: { color: [1, 0, 1] } }]))).toBe(1);
    expect(writes).toHaveLength(1);
  });

  it("refuses a plan that is not a values-only variation, and touches nothing", () => {
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = plan([{ id: "a", uniforms: { level: 0 } }]);
    // A second pass is STRUCTURE. The correct answer is to refuse, not to recompile.
    const structural = plan([
      { id: "a", uniforms: { level: 1 } },
      { id: "extra", uniforms: { level: 1 } },
    ]);

    expect(animator.push(backend, base, structural)).toBeNull();
    expect(writes).toEqual([]);
  });

  it("forgets what it pushed when the structural plan is replaced", () => {
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = plan([{ id: "a", uniforms: { level: 0 } }]);

    animator.push(backend, base, plan([{ id: "a", uniforms: { level: 1 } }]));
    animator.reset();
    // Without the reset this would compare against the last push and write nothing —
    // and the new program's buffers would keep the previous program's values.
    expect(animator.push(backend, base, plan([{ id: "a", uniforms: { level: 1 } }]))).toBe(1);
    expect(writes).toHaveLength(2);
  });
});

describe("a driven substeps parameter animates like a uniform (T425)", () => {
  const loopPlan = (count: number): CompiledGraph =>
    ({
      passes: [
        { kind: "loop", id: "state#loop:begin", edge: "begin", loopId: "state", count },
        { kind: "effect", id: "kernel", shader: "", target: "t", uniforms: { level: 1 } },
        { kind: "loop", id: "state#loop:end", edge: "end", loopId: "state" },
      ],
      resources: [],
      resourceSignatures: [{ id: "t", signature: "t@1" }],
      // T425: the count is OUT of the structure key, so two counts share one signature.
      passSignatures: [
        { id: "state#loop:begin", signature: "loop-begin@1" },
        { id: "kernel", signature: "kernel@1" },
        { id: "state#loop:end", signature: "loop-end@1" },
      ],
      signature: "loop-plan@1",
    }) as unknown as CompiledGraph;

  it("pushes the loop count as a one-value block when it moves, and only then", () => {
    const { backend, writes } = recordingBackend();
    const animator = createUniformAnimator();
    const base = loopPlan(1);

    expect(animator.push(backend, base, loopPlan(1))).toBe(0);
    expect(animator.push(backend, base, loopPlan(12))).toBe(1);
    expect(writes).toEqual([{ passId: "state#loop:begin", values: { count: 12 } }]);
    // Unchanged again: nothing rewritten.
    expect(animator.push(backend, base, loopPlan(12))).toBe(0);
  });
});

