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
 * T344 / §V275 — the plot shows the number that drives the parameter.
 *
 * The owner's ask: "LFOs and other non shader/texture things need a preview too to show
 * their curve or the value". TD draws a CHOP's channel in the node, which is why a TD
 * network reads at a glance — you see the SIGNAL, not just the wire.
 *
 * §V275 is the constraint that makes it trustworthy: the plot reads the SAME channel the
 * resolver reads, sampled once per frame at the single evaluation point. Not a second
 * evaluation — a stateful stage evaluated twice per frame would advance twice, so a Lag
 * would run at double rate purely because someone was looking at it, and the plot would
 * disagree with the picture.
 *
 * So the assertion is agreement: the number in the node's plot is the number PUSHED as
 * the uniform for the same frame. A plot that merely MOVES would pass a weaker test while
 * being a second, wrong evaluation.
 *
 * One thing that comparison taught, worth stating because it looks like a bug: plot and
 * uniform agree only where the parameter does not COERCE. `brightness` declares `min: 0`,
 * so an LFO swinging through -1..1 reaches the uniform clamped while the CHANNEL is
 * negative — correct on both sides, and not a disagreement. The fixture picks an LFO range
 * the parameter accepts so this test measures §V275 rather than clamping.
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

/** noise → level → output, with an LFO driving the level's brightness. */
async function seedLfoChain(runtime: AppRuntime): Promise<{ lfo: string; level: string }> {
  let lfo = "";
  let level = "";
  await act(async () => {
    const result = await seed(runtime, [
      { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$level", type: "level", position: { x: 240, y: 0 } },
      { op: "addNode", ref: "$out", type: "output", position: { x: 480, y: 0 } },
      { op: "addNode", ref: "$lfo", type: "lfo", position: { x: 0, y: 300 } },
      {
        op: "connect",
        source: { nodeId: "$noise", portId: "out" },
        target: { nodeId: "$level", portId: "input" },
      },
      {
        op: "connect",
        source: { nodeId: "$level", portId: "out" },
        target: { nodeId: "$out", portId: "input" },
      },
      // Amplitude and offset put the channel in 0..1 so `brightness` (min 0) does not
      // CLAMP it. That clamp is correct behaviour and it would break the comparison
      // below for a reason that has nothing to do with the plot: the resolver coerces a
      // channel into the parameter's declared range, so plot and uniform agree only
      // where no coercion happens. Choosing a range that avoids it keeps this test about
      // §V275 rather than about clamping.
      {
        op: "setParameters",
        nodeId: "$lfo",
        parameters: { shape: "sine", frequency: 4, amplitude: 0.5, offset: 0.5 },
      },
    ]);
    expect(result.status).toBe("applied");
    lfo = result.output.createdIds["$lfo"] ?? "";
    level = result.output.createdIds["$level"] ?? "";
  });

  const name = runtime.bus.store.getGraph().nodes[lfo]?.label ?? "";
  expect(name).not.toBe("");
  await act(async () => {
    const result = await seed(runtime, [
      {
        op: "setParameters",
        nodeId: level,
        parameters: {
          brightness: {
            mode: "driven",
            bindings: {
              static: { kind: "static", value: 1 },
              driven: { kind: "driven", channel: name },
            },
          },
        },
      } as GraphPatchOperation,
    ]);
    expect(result.status).toBe("applied");
  });
  return { lfo, level };
}

async function mount(runtime: AppRuntime, backend: ShaderloomBackend) {
  const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend };
  await act(async () => {
    render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(status)} />);
  });
}

describe("T344 — a value node shows its signal in the composed app", () => {
  it("plots the LFO, and the plotted number IS the driving number (§V275)", async () => {
    const runtime = newRuntime();
    const { lfo } = await seedLfoChain(runtime);
    const gpu = fixture();
    await mount(runtime, gpu.backend);

    // Before any frame the node has produced nothing, and says so rather than drawing a
    // flat line at a value it never emitted.
    expect(screen.getByTestId(`value-plot-${lfo}`).textContent).toContain("no signal yet");

    await act(async () => {
      for (let frame = 0; frame < 40; frame += 1) gpu.tick();
      // The window notifies at <= 10 Hz (§V16), so let its tick land.
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    const plot = screen.getByTestId(`value-plot-${lfo}`);
    expect(plot.textContent).not.toContain("no signal yet");
    // A line was actually drawn, not just a reading printed.
    expect(plot.querySelectorAll("path").length).toBeGreaterThan(0);

    // §V275's real claim: the number under the plot is the number the parameter got.
    // The per-frame value reaches the GPU through `updateUniforms`, not through a
    // recompile (§V5), so the last WRITE is this frame's answer — the structural plan
    // still carries the zero-frame value and would be the wrong thing to compare.
    const pushed = gpu.writes
      .map((values) => values["brightness"])
      .filter((value): value is number => typeof value === "number");
    expect(pushed.length).toBeGreaterThan(0);
    expect(plot.textContent).toContain((pushed[pushed.length - 1] as number).toFixed(3));

    runtime.dispose();
  });

  it("plots every channel a Mouse publishes, not just the first", async () => {
    const runtime = newRuntime();
    let mouse = "";
    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$mouse", type: "mouse", position: { x: 0, y: 0 } },
      ]);
      mouse = result.output.createdIds["$mouse"] ?? "";
    });
    const gpu = fixture();
    await mount(runtime, gpu.backend);

    await act(async () => {
      for (let frame = 0; frame < 5; frame += 1) gpu.tick();
      await new Promise((resolve) => setTimeout(resolve, 150));
    });

    // "x is moving and y is not" is exactly what someone opens a plot to see, so all three
    // channels are drawn rather than one being chosen for them.
    const plot = screen.getByTestId(`value-plot-${mouse}`);
    expect(plot.textContent).toContain("x");
    expect(plot.textContent).toContain("y");
    expect(plot.textContent).toContain("buttons");
    expect(plot.querySelectorAll("path").length).toBe(3);
    runtime.dispose();
  });

  it("gives a TEXTURE node no plot — the gate is not 'every node'", async () => {
    const runtime = newRuntime();
    let noise = "";
    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } },
      ]);
      noise = result.output.createdIds["$noise"] ?? "";
    });
    const gpu = fixture();
    await mount(runtime, gpu.backend);
    // NON-VACUITY: a gate that matched everything would satisfy every assertion above.
    expect(screen.queryByTestId(`value-plot-${noise}`)).toBeNull();
    runtime.dispose();
  });
});
