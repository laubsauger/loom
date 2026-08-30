// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities, CompiledExecutionPlan } from "@domain/types/backend.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { App } from "./app.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";

/**
 * T459 — the plot draws the CURVE, and the playhead moves along it.
 *
 * The owner, on the LFO bodies: they "struggle to render a smooth shape" and it is "kinda
 * hard to see what the actual full curve would look like at a glance". Two complaints,
 * one cause — the plot recorded sampled HISTORY at frame rate, so a fast LFO ALIASED into
 * a polygon, and a history tail is not a curve at all: it shows where the value has been,
 * never the shape it makes.
 *
 * `value-function.test.ts` proves the maths headlessly, including that every shipped pure
 * source really is pure enough to evaluate ahead. What only the composed app can show is
 * that the graph pane CHOOSES the function plot for a pure node and the history plot for
 * a stateful one, and that the playhead actually advances — §V147: a picture that never
 * moves passes any "does it draw?" check, and a static waveform with a frozen marker is
 * exactly that shape.
 *
 * §V339 applies and is stated rather than worked around: jsdom paints nothing, so these
 * assert the GEOMETRY the renderer emits — the path's segment count, the playhead's x —
 * not that pixels appeared. The look pass is in the report.
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

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

function fixture() {
  let onFrame: (() => void) | null = null;
  let lastPlan: CompiledGraph | null = null;
  const writes: Array<Record<string, unknown>> = [];
  const backend = {
    status: {
      initialized: true, disposed: false, halted: false, deviceGeneration: 1,
      temporalResets: 0, resourceBuilds: 0, framesSubmitted: 0, readbacks: 0,
      stale: false, estimatedResourceBytes: 0,
    },
    initialize: () => Promise.resolve(CAPABILITIES),
    compile: (plan: unknown) => {
      lastPlan = plan as CompiledGraph;
      return Promise.resolve({ id: "f", logical: plan } as CompiledExecutionPlan);
    },
    render() {}, resize() {},
    readOutput: () => Promise.reject(new Error("no GPU")),
    onDiagnostic: () => () => {},
    dispose() {},
    loop: (callback: () => void) => {
      onFrame = callback;
      return { stop() {} };
    },
    updateUniforms: (update: { values: Record<string, unknown> }) => writes.push({ ...update.values }),
    resetTemporalHistory() {},
    recover: () => Promise.resolve(),
    present: (_canvas: unknown, options: { outputId: string }) => ({
      id: "p", outputId: options.outputId, setOutput() {}, dispose() {},
    }),
    previewHost: () => ({ setPreviewProgram() {}, presentPreviews() {}, dispose() {} }),
    onGpuTimings: () => () => {},
    compileShader: () => Promise.resolve({ ok: false, validated: false, diagnostics: [] }),
    readBuffer: () => Promise.reject(new Error("no GPU")),
    registerMediaSource: () => () => {},
    setCookPolicy() {},
  } as unknown as ShaderloomBackend;
  return {
    backend,
    writes,
    plan: () => lastPlan,
    tick() {
      if (onFrame === null) throw new Error("the app registered no frame loop");
      onFrame();
    },
  };
}

async function mount(runtime: AppRuntime, backend: ShaderloomBackend) {
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
  await act(async () => {
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(status)} />);
  });
}


/** A bare LFO plus a Lag fed from it: one pure source, one stateful stage. */
async function seedPlots(
  runtime: AppRuntime,
  frequency: number,
): Promise<{ lfo: string; lag: string }> {
  let lfo = "";
  let lag = "";
  await act(async () => {
    const result = await seed(runtime, [
      { op: "addNode", ref: "$lfo", type: "lfo", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$lag", type: "valueLag", position: { x: 240, y: 0 } },
      {
        op: "connect",
        source: { nodeId: "$lfo", portId: "out" },
        target: { nodeId: "$lag", portId: "in" },
      },
      {
        op: "setParameters",
        nodeId: "$lfo",
        parameters: { shape: "sine", frequency, amplitude: 1, offset: 0 },
      },
    ]);
    expect(result.status).toBe("applied");
    lfo = result.output.createdIds["$lfo"] ?? "";
    lag = result.output.createdIds["$lag"] ?? "";
  });
  return { lfo, lag };
}

/** Runs frames and lets the window's <=10 Hz notification land (§V16). */
async function run(gpu: { tick(): void }, frames: number): Promise<void> {
  await act(async () => {
    for (let frame = 0; frame < frames; frame += 1) gpu.tick();
    await new Promise((resolve) => setTimeout(resolve, 150));
  });
}

function playheadX(nodeId: string): number {
  const line = screen.getByTestId(`value-playhead-${nodeId}`);
  return Number.parseFloat(line.getAttribute("x1") ?? "NaN");
}

function curveOf(nodeId: string): string {
  const path = screen.getByTestId(`value-plot-${nodeId}`).querySelector("path");
  return path?.getAttribute("d") ?? "";
}

describe("T459 — a pure source draws its function, a stateful one draws its history", () => {
  it("gives the LFO a playhead and the Lag none", async () => {
    const runtime = newRuntime();
    const { lfo, lag } = await seedPlots(runtime, 4);
    const gpu = fixture();
    await mount(runtime, gpu.backend);
    await run(gpu, 40);

    // The split is `isPureValueSource`, and this is what it BUYS: the LFO is a function
    // of the frame and gets its curve; the Lag's output depends on everything before it
    // and cannot be evaluated ahead at all, so it keeps the tail.
    expect(screen.queryByTestId(`value-playhead-${lfo}`)).not.toBeNull();
    expect(
      screen.queryByTestId(`value-playhead-${lag}`),
      "a stateful node was given a function plot — its output is not a function of the frame",
    ).toBeNull();
    runtime.dispose();
  });

  it("advances the playhead while holding the curve still", async () => {
    const runtime = newRuntime();
    const { lfo } = await seedPlots(runtime, 1);
    const gpu = fixture();
    await mount(runtime, gpu.backend);

    await run(gpu, 4);
    const firstX = playheadX(lfo);
    const firstCurve = curveOf(lfo);
    expect(Number.isNaN(firstX)).toBe(false);

    await run(gpu, 12);
    const laterX = playheadX(lfo);

    // §V147: the marker MOVES. A static waveform with a frozen playhead would pass every
    // "is a plot drawn?" assertion while telling the user nothing is running.
    expect(laterX, "the playhead did not advance — the plot is a diagram, not an instrument").not.toBe(
      firstX,
    );
    // And the curve does NOT move. A window sliding with the clock would put back exactly
    // the drift this replaced, at higher resolution.
    expect(curveOf(lfo), "the curve moved — it is following the clock again").toBe(firstCurve);
    runtime.dispose();
  });

  /*
   * NOT asserted here: "no playhead before the first frame time". The premise does not
   * hold at this mount — history arrives during the mount's own effects, so there is no
   * moment to observe. `value-function.test.ts` gates the null-phase behaviour directly,
   * where the input can actually be null. Writing it here anyway would have meant a test
   * that passes for a reason unrelated to its name (§V238).
   */
  it("draws a fast LFO with the same resolution as a slow one — the aliasing is gone", async () => {
    // THE ORIGINAL COMPLAINT, at the composed surface. At 30 Hz the history window held
    // two samples per cycle, so the "sine" was a zigzag; the function plot's resolution
    // does not depend on the frame rate, so the segment count is identical.
    const slowRuntime = newRuntime();
    const slow = await seedPlots(slowRuntime, 0.5);
    const slowGpu = fixture();
    await mount(slowRuntime, slowGpu.backend);
    await run(slowGpu, 20);
    const slowSegments = curveOf(slow.lfo).split("L").length;
    slowRuntime.dispose();
    cleanup();

    const fastRuntime = newRuntime();
    const fast = await seedPlots(fastRuntime, 30);
    const fastGpu = fixture();
    await mount(fastRuntime, fastGpu.backend);
    await run(fastGpu, 20);
    const fastSegments = curveOf(fast.lfo).split("L").length;

    expect(fastSegments).toBe(slowSegments);
    // Non-vacuity: it is a real curve, not two points. Ninety-six samples means
    // ninety-five line segments, which no 60fps history window could give a 30 Hz signal.
    expect(fastSegments).toBeGreaterThan(90);
    fastRuntime.dispose();
  });
});
