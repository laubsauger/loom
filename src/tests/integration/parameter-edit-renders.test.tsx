// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * T714 — §V16 as a COUNT, on a graph big enough for the count to matter.
 *
 * The owner's report: "the whole system really glitches, chokes, stutters and lags when
 * adjusting basically any kind of parameter on any kind of node." Measured in the shipped
 * production build on E24 (70 nodes), a drag took the frame from 8.3 ms to 19.8 ms — and
 * the profile said where it went: 57% of the drag window was React render + commit and
 * 12.7% was the compiler. `compileGraph` was NOT the cost.
 *
 * The mechanism, measured rather than reasoned: `NodeView` is `memo`'d and its React Flow
 * payload is deliberately `{ nodeId }` and nothing else, and `derive.ts` goes to real
 * trouble to hand back the PREVIOUS projection object when nothing it derives changed —
 * all so that "a document revision that did not touch the graph view produces no re-render
 * at all". Every word of that is true and none of it worked, because `NodeView` also calls
 * `useGraphCanvas()`, and a CONTEXT value re-renders every consumer straight THROUGH a
 * `memo` boundary. `renderPreview` closed over the document and `previewInspect` closed
 * over two Sets rebuilt from each new compile, so the context value was new on every
 * revision. Counted live in the browser during a 200-frame drag on E24: 174 context
 * changes and 29,118 `NodeView` renders — 146 per frame, on 70 nodes.
 *
 * So the gate is a COUNT, and it is a count of the thing that SCALES. §V655's family of
 * blind gates has an obvious member here: a wall-clock assertion on a small graph passes
 * while the 70-node case still stutters, and an absolute render count tuned to one fixture
 * says nothing about the multiplication. What is asserted instead is that the number of
 * node views a value-only edit re-renders does not GROW with the number of nodes — the
 * multiplication IS the defect, so the ratio is the claim.
 *
 * The counter wraps the real `NodeView` in a component that is `memo`'d AND consumes the
 * same context, so it re-renders under exactly the two conditions the real one does:
 * its props changed, or the canvas context did. A wrapper that skipped `useGraphCanvas`
 * would go quiet during precisely the failure it exists to catch.
 */

const probe = vi.hoisted(() => ({ renders: 0 }));

vi.mock("@editor/nodes/node-view.tsx", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@editor/nodes/node-view.tsx")>();
  const react = await import("react");
  const context = await import("@editor/graph-canvas/canvas-context.ts");
  const Counting = react.memo(function CountingNodeView(props: Record<string, unknown>) {
    context.useGraphCanvas();
    probe.renders += 1;
    const Real = actual.NodeView as unknown as (p: Record<string, unknown>) => ReactNode;
    return react.createElement(Real, props);
  });
  return { ...actual, NodeView: Counting };
});

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

/** Compile count only — this gate is about RENDERS, and §T308 already gates the plan. */
function stubBackend(): { backend: LoomBackend; compiles: () => number } {
  let compiles = 0;
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
      compiles += 1;
      return { id: "plan", passes: [] };
    },
    render: () => {},
    resize: () => {},
    updateUniforms: () => {},
    resetTemporalHistory: () => {},
    setCookPolicy() {},
    dispose: () => {},
  } as unknown as LoomBackend;
  return { backend, compiles: () => compiles };
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

/**
 * A document of `count` sibling Solids, one of them wired to an Output.
 *
 * Siblings rather than a chain on purpose: the claim is about how many nodes REPAINT, and
 * a chain would let "downstream of the edit" stand in for "the whole graph" and make a
 * passing count ambiguous. Nothing here animates, so every render counted below is caused
 * by the edit and by nothing else.
 */
async function mount(count: number) {
  const runtime = createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
  const operations: GraphPatchOperation[] = [
    { op: "addNode", ref: "$out", type: "output", position: { x: 900, y: 0 } },
  ];
  for (let index = 0; index < count; index += 1) {
    operations.push({
      op: "addNode",
      ref: `$n${index}`,
      type: "solid",
      position: { x: (index % 8) * 220, y: Math.floor(index / 8) * 160 },
    });
  }
  operations.push({
    op: "connect",
    source: { nodeId: "$n0", portId: "out" },
    target: { nodeId: "$out", portId: "input" },
  });
  const seeded = await patch(runtime, operations);
  const ids = Array.from(
    { length: count },
    (_unused, index) => seeded.output.createdIds[`$n${index}`] as string,
  );

  const { backend, compiles } = stubBackend();
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
  render(
    <App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(status)} />,
  );
  await act(async () => {});
  // NON-VACUITY for every count below: the canvas really did mount these nodes. A harness
  // that rendered no node view at all would satisfy "did not re-render" perfectly.
  await waitFor(() => {
    expect(compiles()).toBeGreaterThan(0);
  });
  await settle();
  expect(probe.renders).toBeGreaterThanOrEqual(count);
  return { runtime, ids, compiles };
}

/** Node views re-rendered by one value-only parameter edit. */
async function rendersPerValueEdit(count: number, edits = 5): Promise<number> {
  const { runtime, ids } = await mount(count);
  await settle();
  probe.renders = 0;
  for (let step = 1; step <= edits; step += 1) {
    await act(async () => {
      await patch(runtime, [
        {
          op: "setParameters",
          nodeId: ids[0] as string,
          parameters: { color: [step / 10, 0.2, 0.3, 1] },
        },
      ]);
    });
  }
  await settle();
  return probe.renders;
}

describe("T714 — a parameter edit repaints ONE node, not the graph (§V16, §V5)", () => {
  it("re-renders a number of node views that does not grow with the graph", async () => {
    const small = await rendersPerValueEdit(6);
    cleanup();
    const large = await rendersPerValueEdit(60);

    /*
     * THE CLAIM. Ten times the nodes must not mean ten times the repaint: the edit touched
     * one node, so what redraws is that node (plus whatever the selection and the
     * inspector legitimately need), and a graph ten times the size costs the same.
     *
     * Stated as a difference rather than a ratio because the honest floor is not zero —
     * the edited node itself renders, and it must. Before the fix this read 6 → 60-odd per
     * edit and the difference grew with the fixture; a build that regresses trips this on
     * the DELTA, whatever the constant term happens to be.
     */
    expect(
      large - small,
      `a value-only edit re-rendered ${String(large)} node views on a 60-node graph and ` +
        `${String(small)} on a 6-node graph. The cost of editing one parameter is scaling ` +
        "with the size of the document, which is §V16 not holding: something above the " +
        "memoised NodeView — most likely the graph canvas CONTEXT VALUE — is new on every " +
        "document revision, and a context change re-renders every consumer through memo.",
    ).toBeLessThanOrEqual(2 * 5);
  }, 60_000);

  it("still repaints the graph when the TOPOLOGY changes (the control)", async () => {
    // Without this, every assertion above is satisfied by a canvas that renders nothing
    // at all — §V655's "count-only assertion a mis-wired replacement passes".
    const { runtime } = await mount(60);
    await settle();
    probe.renders = 0;
    await act(async () => {
      await patch(runtime, [
        { op: "addNode", ref: "$extra", type: "blur", position: { x: 400, y: 900 } },
      ]);
    });
    await settle();
    expect(probe.renders).toBeGreaterThan(0);
  }, 60_000);
});
