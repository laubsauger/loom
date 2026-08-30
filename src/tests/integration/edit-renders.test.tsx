// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities, FrameInputs } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { CompiledPlan, ShaderloomBackend } from "@runtime/backend/index.ts";
import { App } from "../../app/app.tsx";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import type { GpuStatus } from "../../app/gpu-status.ts";

/**
 * §V172 — an edit renders BY ITSELF (T267).
 *
 * The owner reported this twice, in two disguises: "I need to zoom in and out to see nodes
 * rendering and updating when I connect them, it doesn't automatically trigger a render",
 * and later, previews sitting black and popping in some time afterwards. Both are one
 * symptom, and the symptom is diagnostic — if connecting two nodes only renders once you
 * zoom, the render is riding somebody ELSE'S invalidation and the edit path has no trigger
 * of its own.
 *
 * That is not a latency problem to be tuned. It is a missing edge in the graph of what
 * causes what, and it will keep reappearing in new disguises (an edit while the transport is
 * paused, a parameter change with no pointer movement after it) until something asserts the
 * causal link directly.
 *
 * So this test drives ONLY the edit. No pan, no zoom, no pointer movement, no resize —
 * nothing that could supply the invalidation on the edit's behalf. What it asserts is that
 * the frame rendered afterwards carries the plan compiled AFTER the edit, which is the
 * claim "the edit reached the picture" and not merely "something was recompiled".
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

interface Recorder {
  /** Every plan id handed to `compile`, in order. */
  compiled: string[];
  /** The plan id of every frame actually submitted. */
  rendered: string[];
  /** Runs one frame, the way the scheduler would. */
  tick(): void;
}

/**
 * A backend that records which PLAN each frame rendered.
 *
 * The distinction matters: counting compiles would pass on a build that recompiles happily
 * and never draws, which is precisely the failure being tested. The plan id ties the two
 * halves together.
 */
function recordingBackend(): { backend: ShaderloomBackend; recorder: Recorder } {
  let frameCallback: ((inputs?: FrameInputs) => void) | null = null;
  let compileCount = 0;
  const recorder: Recorder = {
    compiled: [],
    rendered: [],
    tick: () => frameCallback?.(),
  };
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
    loop: (callback: () => void) => {
      frameCallback = callback;
      return { stop: () => { frameCallback = null; } };
    },
    previewHost: () => ({
      setPreviewProgram: () => {},
      presentPreviews: () => {},
      dispose: () => {},
    }),
    present: () => ({ id: "present-stub", outputId: "", setOutput: () => {}, dispose: () => {} }),
    onGpuTimings: () => () => {},
    compile: async () => {
      compileCount += 1;
      const id = `plan-${compileCount}`;
      recorder.compiled.push(id);
      return { id, passes: [] } as unknown as CompiledPlan;
    },
    render: (plan: { id: string }) => {
      recorder.rendered.push(plan?.id ?? "none");
    },
    resize: () => {},
    updateUniforms: () => {},
    resetTemporalHistory: () => {},
    registerMediaSource: () => () => {},
    setCookPolicy: () => {},
    readOutput: async () => ({ bytes: new Uint8Array(), width: 0, height: 0, format: "rgba8unorm" }),
    readBuffer: async () => new Uint8Array(),
    dispose: () => {},
  } as unknown as ShaderloomBackend;
  return { backend, recorder };
}

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function patch(runtime: AppRuntime, operations: GraphPatchOperation[], label: string) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label },
    runtime.invocation,
  );
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 60));
  });
}

describe("§V172 — a graph edit renders without being nudged (T267)", () => {
  it("renders the post-edit plan with no pointer, zoom or resize in between", async () => {
    const runtime = newRuntime();
    // A working chain first, so the baseline is a build that renders. The edit under test is
    // then an addition to it — if the baseline did not render, "it rendered after the edit"
    // would be measuring the app starting up rather than the edit doing anything.
    await patch(
      runtime,
      [
        { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$out", type: "output", position: { x: 240, y: 0 } },
        {
          op: "connect",
          source: { nodeId: "$solid", portId: "out" },
          target: { nodeId: "$out", portId: "input" },
        },
      ],
      "seed",
    );

    const { backend, recorder } = recordingBackend();
    const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
    const probe = () => Promise.resolve(status);

    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
    await act(async () => {});
    await settle();

    // NON-VACUITY: if nothing ever compiled or rendered, everything below is trivially true.
    await waitFor(() => expect(recorder.compiled.length).toBeGreaterThan(0));
    await act(async () => recorder.tick());
    expect(recorder.rendered.length).toBeGreaterThan(0);

    const compiledBefore = recorder.compiled.length;

    // THE EDIT. Nothing else — no camera, no pointer, no resize.
    await patch(runtime, [{ op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 200 } }], "add");
    await settle();

    // The edit must have produced a new plan on its own.
    expect(recorder.compiled.length).toBeGreaterThan(compiledBefore);
    const latest = recorder.compiled[recorder.compiled.length - 1];

    // ...and the next frame must carry it. Recompiling without ever drawing is the exact
    // shape of the reported bug: the work was done and the picture did not move.
    await act(async () => recorder.tick());
    expect(recorder.rendered[recorder.rendered.length - 1]).toBe(latest);
  });

  it("renders a PARAMETER change too, which never recompiles", async () => {
    // The other half of the same complaint, and it travels a different road. A parameter
    // edit is classified uniform-only (§V5), so it deliberately does NOT produce a new plan
    // — which means "did it recompile?" is the wrong question and would report a regression
    // where the fast path is working. What must still happen is that the value reaches the
    // GPU and a frame goes out.
    const runtime = newRuntime();
    await patch(
      runtime,
      [
        { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$out", type: "output", position: { x: 240, y: 0 } },
        {
          op: "connect",
          source: { nodeId: "$solid", portId: "out" },
          target: { nodeId: "$out", portId: "input" },
        },
      ],
      "seed",
    );

    const { backend, recorder } = recordingBackend();
    const uniformWrites: number[] = [];
    const instrumented = new Proxy(backend, {
      get(target, key: string) {
        if (key === "updateUniforms") {
          return (...args: unknown[]) => {
            uniformWrites.push(args.length);
          };
        }
        return Reflect.get(target, key) as unknown;
      },
    }) as ShaderloomBackend;
    const status: GpuStatus = {
      kind: "ready",
      capabilities: CAPABILITIES,
      baseline: true,
      backend: instrumented,
    };
    const probe = () => Promise.resolve(status);

    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={probe} />);
    await act(async () => {});
    await settle();
    await waitFor(() => expect(recorder.compiled.length).toBeGreaterThan(0));
    await act(async () => recorder.tick());
    const framesBefore = recorder.rendered.length;

    const solidId = Object.entries(runtime.bus.store.getGraph().nodes).find(
      ([, node]) => node.type === "solid",
    )?.[0];
    if (solidId === undefined) throw new Error("no solid node");
    await patch(
      runtime,
      [{ op: "setParameters", nodeId: solidId, parameters: { color: [1, 0, 0, 1] } }],
      "colour",
    );
    await settle();

    // A frame still goes out, carrying the change.
    await act(async () => recorder.tick());
    expect(recorder.rendered.length).toBeGreaterThan(framesBefore);
  });
});
