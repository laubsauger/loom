// @vitest-environment jsdom
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities, CompiledExecutionPlan } from "@domain/types/backend.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "./app.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";
import { useFrameLoop } from "./use-frame-loop.ts";

/**
 * B27 — the value graph, in the COMPOSED app (§V179, §V222).
 *
 * `use-value-graph.test.tsx` proves the hook and `value-graph.test.ts` proves the
 * evaluator. Neither can see what B27 actually was: nothing constructed a session, so
 * value EDGES, `valueEvaluate` and every stateful stage were dead in the product while
 * both suites stayed green.
 *
 * The chain here is `mouse1 → math1 → level.brightness`, and the choice is deliberate: a
 * Math node is unresolvable WITHOUT a value-graph session, because `graphChannelResolver`
 * answers only for nodes declaring `valueChannel` and Math declares `valueEvaluate`. A
 * brightness that is 0.7 rather than its retained static 1 can only have come from an edge
 * being traversed and a stage being evaluated.
 *
 * WHAT THIS FILE DOES NOT CLAIM, and cannot: that a value chain MOVES in the running app.
 * It cannot today, for two reasons outside this wiring — nothing calls `PointerSource.set`,
 * so Mouse reads a constant zero; and LFO/Constant/Timer declare no ports at all, so they
 * cannot feed a value edge. Mouse is the only value source with an output port. Both are
 * reported rather than papered over, and the constant 0.7 below is the honest shape of
 * that: the chain evaluates, and its input never changes.
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

function fixtureBackend(): {
  backend: LoomBackend;
  tick: () => void;
  /** The last plan the app handed the backend — what it actually compiled. */
  lastPlan: () => CompiledGraph | null;
} {
  let onFrame: (() => void) | null = null;
  let lastPlan: CompiledGraph | null = null;
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
    initialize: () => Promise.resolve(CAPABILITIES),
    compile: (plan: unknown) => {
      lastPlan = plan as CompiledGraph;
      return Promise.resolve({ id: "fixture", logical: plan } as CompiledExecutionPlan);
    },
    render() {},
    resize() {},
    readOutput: () => Promise.reject(new Error("no GPU")),
    onDiagnostic: () => () => {},
    dispose() {},
    loop: (callback: () => void) => {
      onFrame = callback;
      return { stop() {} };
    },
    updateUniforms() {},
    resetTemporalHistory() {},
    recover: () => Promise.resolve(),
    present: (_canvas: unknown, options: { outputId: string }) => ({
      id: "p",
      outputId: options.outputId,
      setOutput() {},
      dispose() {},
    }),
    previewHost: () => ({ setPreviewProgram() {}, presentPreviews() {}, dispose() {} }),
    onGpuTimings: () => () => {},
    onCpuTimings: () => () => {},
    compileShader: () => Promise.resolve({ ok: false, validated: false, diagnostics: [] }),
    readBuffer: () => Promise.reject(new Error("no GPU")),
    registerMediaSource: () => () => {},
    setCookPolicy() {},
  } as unknown as LoomBackend;
  return {
    backend,
    tick: () => {
      if (onFrame === null) throw new Error("the app registered no frame loop");
      onFrame();
    },
    lastPlan: () => lastPlan,
  };
}

describe("B27 — a value CHAIN reaches a parameter in the composed app", () => {
  it("resolves a driven parameter through a value edge and a valueEvaluate stage", async () => {
    const runtime = newRuntime();
    let level = "";
    let math = "";
    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$level", type: "level", position: { x: 240, y: 0 } },
        { op: "addNode", ref: "$out", type: "output", position: { x: 480, y: 0 } },
        { op: "addNode", ref: "$mouse", type: "mouse", position: { x: 0, y: 300 } },
        { op: "addNode", ref: "$math", type: "valueMath", position: { x: 240, y: 300 } },
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
        // THE VALUE EDGE. Nothing in the product traversed one of these before B27.
        {
          op: "connect",
          source: { nodeId: "$mouse", portId: "out" },
          target: { nodeId: "$math", portId: "a" },
        },
        { op: "setParameters", nodeId: "$math", parameters: { operation: "add", operand: 0.7 } },
      ]);
      expect(result.status).toBe("applied");
      level = result.output.createdIds["$level"] ?? "";
      math = result.output.createdIds["$math"] ?? "";
    });

    const mathName = runtime.bus.store.getGraph().nodes[math]?.label ?? "";
    expect(mathName).not.toBe("");
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
                // `name:channel` addressing (T274): Mouse publishes x, y and buttons, so
                // there is no bare `value` channel to fall back to.
                driven: { kind: "driven", channel: `${mathName}:x` },
              },
            },
          },
        } as GraphPatchOperation,
      ]);
      expect(result.status).toBe("applied");
    });

    const fixture = fixtureBackend();
    const status: GpuStatus = {
      kind: "ready",
      capabilities: CAPABILITIES,
      baseline: true,
      backend: fixture.backend,
    };
    await act(async () => {
      render(
        <App
          runtime={runtime}
          storage={createMemoryStorage()}
          gpuProbe={() => Promise.resolve(status)}
        />,
      );
    });
    await act(async () => {
      fixture.tick();
    });

    // The plan the app HANDED THE BACKEND — the composed answer, not a re-compile the
    // test performed with its own resolvers, which would prove nothing about the app.
    const compiled = fixture.lastPlan();
    expect(compiled).not.toBeNull();
    const pass = (compiled?.passes ?? []).find(
      (entry) => "nodeId" in entry && entry.nodeId === level && "uniforms" in entry,
    );
    const brightness = (pass as { uniforms?: Record<string, unknown> } | undefined)?.uniforms?.[
      "brightness"
    ];

    // 0 (the pointer) + 0.7 (the operand). Only a traversed value edge and an evaluated
    // stage produce that number; without the session the parameter falls back to its
    // retained static 1, which is what it did before this wiring.
    expect(brightness).toBeCloseTo(0.7, 10);
    expect(brightness).not.toBe(1);
    runtime.dispose();
  });
});

/**
 * THE RIDER, AND ITS ORDER (T319, §V222).
 *
 * `advanceChannels` has to run BEFORE `animate` asks the resolver for this frame's
 * numbers. One line of ordering, and getting it wrong costs a frame of latency on every
 * value-driven parameter with nothing failing — the failure mode §V222 exists for.
 */
describe("the frame seam advances channels before it resolves them", () => {
  const plan = (): CompiledGraph =>
    ({
      ok: true,
      id: "p",
      signature: "sig",
      passes: [],
      resources: [],
      order: [],
      pruned: [],
      sources: [],
      outputs: [],
      diagnostics: [],
      estimatedResourceBytes: 0,
    }) as unknown as CompiledGraph;

  function harness() {
    const calls: string[] = [];
    const fixture = fixtureBackend();
    const runtime = newRuntime();
    const view = renderHook(() =>
      useFrameLoop({
        bus: runtime.bus,
        backend: fixture.backend,
        compiled: plan(),
        settings: runtime.settings,
        animate: () => {
          calls.push("animate");
          return null;
        },
        advanceChannels: () => calls.push("advance"),
        observe: () => calls.push("observe"),
        onReset: () => calls.push("reset"),
      }),
    );
    return { calls, fixture, runtime, view };
  }

  it("calls advanceChannels, then animate, then observe — every frame", async () => {
    const { calls, fixture, runtime } = harness();
    await act(async () => {});
    await act(async () => {
      fixture.tick();
      fixture.tick();
    });
    expect(calls).toEqual(["advance", "animate", "observe", "advance", "animate", "observe"]);
    runtime.dispose();
  });

  it("clears value state on a seek, beside the GPU's temporal history (§V181, §V170)", async () => {
    const { calls, runtime } = harness();
    await act(async () => {});
    await act(async () => {
      await runtime.bus.execute("transport.seek", { frameIndex: 0 }, runtime.invocation);
    });
    // A replay that starts from a state belonging to a different history is a scrub that
    // looks like it works and is a lie; the CPU half of that rule is this call.
    expect(calls).toContain("reset");
    runtime.dispose();
  });
});
