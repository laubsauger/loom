// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T308 / B26 / §V5 — a value-only edit writes UNIFORMS and does not rebuild the plan.
 *
 * `classifyEdit` was defined, exported and unit-tested from T31 and called by nothing
 * outside its own tests, so every document revision reached `backend.compile`. Measured
 * on this exact fixture before the fix: five value-only parameter edits produced five
 * `compileGraph` calls, five `backend.compile` calls and ZERO `updateUniforms`. §V5's
 * fast path was not merely unenforced — for a static edit it did not exist, because
 * rebuilding the plan was the only way a new value ever reached the GPU. It was invisible
 * because §V62b's carry-over turns the rebuild into a cache hit rather than a visible
 * stall.
 *
 * So the assertions here are about WORK AVOIDED at the backend seam, not about a
 * classifier having been consulted: a test that checked the classification would pass
 * just as well if the decision were computed and then ignored, which is the failure this
 * whole task exists to correct.
 *
 * Every "did not compile" claim is paired with a control that DOES compile, because a
 * gate stuck shut passes every negative assertion ever written about it.
 */

beforeAll(() => {
  installDomStubs();
  installFlowStubs();
});
afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

interface Counters {
  /** Plan rebuilds. §V5's "⊥ recompile" is exactly this number not moving. */
  compiles: number;
  /** Every uniform block written, in order, with its values. */
  uniformWrites: Array<{ passId: string; values: Record<string, unknown> }>;
}

function countingBackend(): { backend: ShaderloomBackend; counters: Counters } {
  const counters: Counters = { compiles: 0, uniformWrites: [] };
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
    present: () => ({ id: "present-stub", outputId: "", setOutput: () => {}, dispose: () => {} }),
    onGpuTimings: () => () => {},
    compile: async () => {
      counters.compiles += 1;
      return { id: "plan", passes: [] };
    },
    render: () => {},
    resize: () => {},
    updateUniforms: (write: { passId: string; values: Record<string, unknown> }) => {
      counters.uniformWrites.push(write);
    },
    resetTemporalHistory: () => {},
    // T326: part of the backend contract; a fixture without it is incomplete.
    setCookPolicy() {},
    dispose: () => {},
  } as unknown as ShaderloomBackend;
  return { backend, counters };
}

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function patch(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations },
    runtime.invocation,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 40));
  });
}

async function mount() {
  const runtime = newRuntime();
  const seeded = await patch(runtime, [
    { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
    { op: "addNode", ref: "$out", type: "output", position: { x: 240, y: 0 } },
    {
      op: "connect",
      source: { nodeId: "$solid", portId: "out" },
      target: { nodeId: "$out", portId: "input" },
    },
  ]);
  const ids = {
    solid: seeded.output.createdIds["$solid"] as string,
    out: seeded.output.createdIds["$out"] as string,
  };

  const { backend, counters } = countingBackend();
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
  const probe = () => Promise.resolve(status);

  render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
  await act(async () => {});
  // NON-VACUITY for everything below: the backend really is being driven. A fixture that
  // never compiled at all would satisfy every "did not compile" assertion in this file.
  await waitFor(() => {
    expect(counters.compiles).toBeGreaterThan(0);
  });
  await settle();
  return { runtime, ids, counters };
}

describe("T308 — a value-only edit writes uniforms, not a plan (§V5, B26)", () => {
  it("does not reach backend.compile, and the new values do reach the GPU", async () => {
    const { runtime, ids, counters } = await mount();
    const compilesBefore = counters.compiles;
    const writesBefore = counters.uniformWrites.length;

    for (let step = 1; step <= 5; step += 1) {
      await act(async () => {
        await patch(runtime, [
          { op: "setParameters", nodeId: ids.solid, parameters: { color: [step / 10, 0.2, 0.3, 1] } },
        ]);
      });
    }
    await settle();

    // THE CLAIM: five value edits, no plan rebuilds.
    expect(counters.compiles).toBe(compilesBefore);
    // ...and the values are not merely "not recompiled", they are ON THE GPU. Before this
    // task that count was zero: nothing wrote a uniform for a static edit, ever.
    const writes = counters.uniformWrites.slice(writesBefore);
    expect(writes.length).toBeGreaterThan(0);
    // The pushed value went through the REAL resolver, not a copy of the raw parameter:
    // Solid's colour is declared `space: "display"`, so what reaches a uniform is the
    // LINEAR working-space value (§V56) and never the sRGB number the user typed. A push
    // that shortcut the resolver would write 0.5 here, and every colour in the project
    // would be wrong in a way that looks like a lighting choice.
    const last = writes[writes.length - 1]?.values["color"] as number[] | undefined;
    expect(last).toBeDefined();
    expect(last?.[0]).toBeGreaterThan(0);
    expect(last?.[0]).toBeLessThan(0.5);
    // Alpha is not a colour channel and is never transformed, so it pins the shape.
    expect(last?.[3]).toBe(1);
    // It TRACKS THE EDITS rather than repeating one: red climbed 0.1 → 0.5 across the
    // five patches, so the last write must exceed the first. A push against a stale base
    // — the bug the `planRef` advance below prevents — fails exactly here.
    const first = writes[0]?.values["color"] as number[] | undefined;
    expect(last?.[0]).toBeGreaterThan(first?.[0] ?? 1);
    // The document agrees, so this is one story and not two.
    expect(runtime.bus.store.getGraph().nodes[ids.solid]?.parameters["color"]).toEqual([
      0.5, 0.2, 0.3, 1,
    ]);
  }, 30_000);

  it("still rebuilds the plan when the TOPOLOGY changes (the control)", async () => {
    const { runtime, ids, counters } = await mount();
    const before = counters.compiles;

    await act(async () => {
      await patch(runtime, [
        { op: "addNode", ref: "$blur", type: "blur", position: { x: 120, y: 160 } },
        {
          op: "connect",
          source: { nodeId: ids.solid, portId: "out" },
          target: { nodeId: "$blur", portId: "input" },
        },
      ]);
    });
    await settle();

    expect(counters.compiles).toBeGreaterThan(before);
  }, 30_000);

  it("still rebuilds for a compileTime parameter, which LOOKS like a value edit (§V5)", async () => {
    // The trap this gate has to survive, and `composite.ts` names it in its own manifest:
    // the blend `operation` selects the SHADER, so it recompiles rather than branching per
    // pixel — and "leaving it a uniform would also quietly weaken §V5, because the
    // uniform-only fast path only means anything while structural changes are classified
    // as structural". To a document diff this is a `setParameters` like any other; only
    // the manifest's `compileTime` flag tells them apart, and only `classifyEdit` reads it.
    const runtime = newRuntime();
    const seeded = await patch(runtime, [
      { op: "addNode", ref: "$a", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$b", type: "solid", position: { x: 0, y: 200 } },
      { op: "addNode", ref: "$mix", type: "composite", position: { x: 240, y: 0 } },
      { op: "addNode", ref: "$out", type: "output", position: { x: 480, y: 0 } },
      {
        op: "connect",
        source: { nodeId: "$a", portId: "out" },
        target: { nodeId: "$mix", portId: "in1" },
      },
      {
        op: "connect",
        source: { nodeId: "$b", portId: "out" },
        target: { nodeId: "$mix", portId: "in2" },
      },
      {
        op: "connect",
        source: { nodeId: "$mix", portId: "out" },
        target: { nodeId: "$out", portId: "input" },
      },
    ]);
    const mix = seeded.output.createdIds["$mix"] as string;

    const { backend, counters } = countingBackend();
    const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
    const probe = () => Promise.resolve(status);
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
    await act(async () => {});
    await waitFor(() => {
      expect(counters.compiles).toBeGreaterThan(0);
    });
    await settle();

    const before = counters.compiles;
    await act(async () => {
      await patch(runtime, [
        { op: "setParameters", nodeId: mix, parameters: { operation: "screen" } },
      ]);
    });
    await settle();

    expect(counters.compiles).toBeGreaterThan(before);
  }, 30_000);

  it("does not rebuild the plan for a node MOVE or RESIZE (§V190, §V116)", async () => {
    // §V190 says laying out a 200-node graph must cost zero GPU work. It said so while
    // every move recompiled; this is the first time anything checks it.
    const { runtime, ids, counters } = await mount();
    const before = counters.compiles;

    await act(async () => {
      await patch(runtime, [{ op: "moveNodes", positions: { [ids.solid]: { x: 500, y: 300 } } }]);
      await patch(runtime, [
        { op: "setNodeSize", nodeId: ids.solid, size: { width: 320, height: 240 } },
      ]);
    });
    await settle();

    expect(counters.compiles).toBe(before);
    // The edits really landed — otherwise "no compile" is just "no edit".
    expect(runtime.bus.store.getGraph().nodes[ids.solid]?.position).toEqual({ x: 500, y: 300 });
    expect(runtime.bus.store.getGraph().nodes[ids.solid]?.size).toEqual({
      width: 320,
      height: 240,
    });
  }, 30_000);
});
