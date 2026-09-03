// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { createDomainBus } from "@domain/commands/index.ts";
import { createGraphStore } from "@domain/graph/store.ts";
import { createSequentialIdFactory } from "@domain/graph/ids.ts";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { DEFAULT_PROJECT_SETTINGS } from "./app-runtime.ts";
import { useFrameLoop } from "./use-frame-loop.ts";

/**
 * T308's fail-safe: the classification is CHECKED against the real plans, never trusted.
 *
 * This is the test that separates an optimisation from a new class of bug. `valuesOnly`
 * is a claim made by a document diff (`classify-revision.ts`) about what a revision cost.
 * If that claim is ever wrong — a node field nobody classified, a compiler change that
 * makes an edit structural, a bug in the diff itself — the consequence must be a wasted
 * comparison and a recompile, NOT a plan quietly left stale while uniforms are written
 * into passes that no longer match it.
 *
 * So the flag is deliberately LIED TO here. `useFrameLoop` is handed `valuesOnly: true`
 * alongside a plan whose structure genuinely changed, and what is asserted is that it
 * compiled anyway — because `animate-parameters.ts` asserts `isUniformOnlyChange` on the
 * two real plans and refuses when they disagree.
 *
 * Nothing else can test this. The classifier's own tests prove it answers correctly; only
 * a lie proves what happens when it does not.
 */

afterEach(cleanup);

interface Seen {
  compiles: CompiledGraph[];
  uniformWrites: number;
}

function countingBackend(): { backend: LoomBackend; seen: Seen } {
  const seen: Seen = { compiles: [], uniformWrites: 0 };
  const backend = {
    status: {
      initialized: true,
      disposed: false,
      halted: false,
      deviceGeneration: 1,
      temporalResets: 0,
      resourceBuilds: 0,
      framesSubmitted: 0,
      readbacks: 0,
      stale: false,
      estimatedResourceBytes: 0,
    },
    onDiagnostic: () => () => {},
    recover: async () => {},
    loop: () => ({ stop: () => {} }),
    previewHost: () => ({
      setPreviewProgram: () => {},
      presentPreviews: () => {},
      dispose: () => {},
    }),
    present: () => ({ id: "p", outputId: "", setOutput: () => {}, dispose: () => {} }),
    onGpuTimings: () => () => {},
    onCpuTimings: () => () => {},
    compile: async (plan: CompiledGraph) => {
      seen.compiles.push(plan);
      return { id: "plan", passes: [] };
    },
    render: () => {},
    resize: () => {},
    updateUniforms: () => {
      seen.uniformWrites += 1;
    },
    resetTemporalHistory: () => {},
    // T326: part of the backend contract; a fixture without it is incomplete.
    setCookPolicy() {},
    dispose: () => {},
  } as unknown as LoomBackend;
  return { backend, seen };
}

function bus() {
  const store = createGraphStore({
    ids: createSequentialIdFactory("n"),
    now: () => "2026-08-30T00:00:00.000Z",
  });
  return createDomainBus({ store, registry: createTestRegistry().view() }).bus;
}

/**
 * Two plans that share a pass id and differ only in that pass's uniform VALUES, and a
 * third that is structurally different. Hand-built on purpose: the point is what
 * `useFrameLoop` does with plans of a given shape, and building them by compiling would
 * make the fixture depend on the very classification under test.
 */
function planWith(passes: CompiledGraph["passes"], signature: string): CompiledGraph {
  return {
    ok: true,
    signature,
    passes,
    resources: [],
    outputs: [],
    diagnostics: [],
    feedback: [],
    pruned: [],
    resourceSignatures: [],
    passSignatures: [],
    sources: [],
  } as unknown as CompiledGraph;
}

const effect = (id: string, amount: number) =>
  ({ kind: "effect", id, shader: "// same", target: "t", uniformBinding: "params", uniforms: { amount } }) as unknown as CompiledGraph["passes"][number];

describe("T308 fail-safe — a wrong `valuesOnly` costs a recompile, never a wrong frame", () => {
  it("compiles anyway when the flag says values-only and the plans disagree", async () => {
    const { backend, seen } = countingBackend();
    const structural = planWith([effect("a:fill", 1)], "sig-a");

    const view = renderHook(
      ({ plan, valuesOnly }: { plan: CompiledGraph; valuesOnly: boolean }) =>
        useFrameLoop({
          bus: bus(),
          backend,
          compiled: plan,
          settings: DEFAULT_PROJECT_SETTINGS,
          valuesOnly,
        }),
      { initialProps: { plan: structural, valuesOnly: false } },
    );
    await act(async () => {});
    expect(seen.compiles).toHaveLength(1);

    // THE LIE: a structurally different plan (different signature, different pass set)
    // announced as values-only.
    const different = planWith([effect("b:fill", 1)], "sig-b");
    await act(async () => {
      view.rerender({ plan: different, valuesOnly: true });
    });

    // It compiled. `isUniformOnlyChange` saw two plans that are not values-only
    // variations of each other and refused, so the flag lost to the evidence.
    expect(seen.compiles).toHaveLength(2);
    expect(seen.compiles[1]).toBe(different);
    // And nothing was written into a plan the backend no longer holds.
    expect(seen.uniformWrites).toBe(0);
  });

  it("takes the values path when the flag is right, so the guard is not just 'always compile'", async () => {
    const { backend, seen } = countingBackend();
    const first = planWith([effect("a:fill", 1)], "sig-a");

    const view = renderHook(
      ({ plan, valuesOnly }: { plan: CompiledGraph; valuesOnly: boolean }) =>
        useFrameLoop({
          bus: bus(),
          backend,
          compiled: plan,
          settings: DEFAULT_PROJECT_SETTINGS,
          valuesOnly,
        }),
      { initialProps: { plan: first, valuesOnly: false } },
    );
    await act(async () => {});
    expect(seen.compiles).toHaveLength(1);

    // Same structure, same signature, one uniform value moved.
    const second = planWith([effect("a:fill", 2)], "sig-a");
    await act(async () => {
      view.rerender({ plan: second, valuesOnly: true });
    });

    expect(seen.compiles).toHaveLength(1);
    expect(seen.uniformWrites).toBe(1);
  });
});
