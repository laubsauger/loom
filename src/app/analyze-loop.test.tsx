// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { ChannelResolver } from "@domain/parameters/resolve.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { scratchResourceId } from "@compiler/resources.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { useAnalyzeChannels } from "./use-analyze-channels.ts";
import { useGraphCompile } from "./use-graph-compile.ts";

/**
 * B25 / T305 — the image→parameter loop, closed in the COMPOSITION (§V144, §V205).
 *
 * `analyze.gpu.test.ts` already proves the service works on real Dawn: a colour goes in, a
 * number comes out. What no unit test could see is whether anything constructs it — and
 * nothing did, for weeks, while every suite was green. `composition-seams.test.ts` now
 * enumerates that construction. This file proves the two things enumeration cannot:
 * that the value REACHES a parameter, and that the sample runs in the one slot where a
 * readback is legal.
 *
 * The frame-guard model below is not invented. Measured against the real backend:
 *
 *   readBuffer outside a frame                -> resolves
 *   readBuffer from inside the loop callback  -> FrameEncodingViolation
 *   readBuffer from a microtask queued there  -> resolves
 *
 * `AnalyzeChannels.sample` swallows a failed read by contract (§V144: stale beats
 * stalled), so getting that slot wrong produces a channel that silently never updates —
 * B25 again, one layer down, and invisible to any test that does not assert a VALUE.
 */

afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

const FRAME: FrameEvaluationInput = {
  timeSeconds: 0,
  deltaSeconds: 1 / 60,
  frameIndex: 0,
  mode: "offline",
  randomSeed: 1,
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

/** Lets a queued microtask run. The deferral this whole wiring depends on. */
const flushMicrotasks = (): Promise<void> => Promise.resolve().then(() => undefined);

/**
 * A backend that enforces the frame guard the way the real one does.
 *
 * `encoding` stands for `FrameGuard.depth > 0`: while a frame is open, `readBuffer`
 * rejects. Everything else is the minimum a hook needs.
 */
function guardedBackend(average: number) {
  let encoding = false;
  let reads = 0;
  let refusals = 0;
  const backend = {
    readBuffer(resourceId: string): Promise<ArrayBuffer> {
      if (encoding) {
        refusals += 1;
        return Promise.reject(
          new Error(`${resourceId} was read while a frame was being encoded (§V8).`),
        );
      }
      reads += 1;
      // The reduction layout the Analyze kernel writes: [average, min, max, 1].
      return Promise.resolve(Float32Array.from([average, average, average, 1]).buffer);
    },
  } as unknown as ShaderloomBackend;
  return {
    backend,
    /** Runs `body` with a frame open, exactly as `runFrame` does — restored in a finally. */
    duringFrame(body: () => void): void {
      encoding = true;
      try {
        body();
      } finally {
        encoding = false;
      }
    },
    get reads() {
      return reads;
    },
    get refusals() {
      return refusals;
    },
  };
}

describe("T305 — the Analyze channel is constructed and sampled between frames", () => {
  it("defers the readback out of the open frame, and the value lands", async () => {
    const runtime = newRuntime();
    const gpu = guardedBackend(0.375);
    let analyzeNodeId = "";

    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$meter", type: "analyze", position: { x: 240, y: 0 } },
        {
          op: "connect",
          source: { nodeId: "$noise", portId: "out" },
          target: { nodeId: "$meter", portId: "input" },
        },
      ]);
      expect(result.status).toBe("applied");
      analyzeNodeId = result.output.createdIds["$meter"] ?? "";
    });
    expect(analyzeNodeId).not.toBe("");
    const channelName = runtime.bus.store.getGraph().nodes[analyzeNodeId]?.label ?? "";
    expect(channelName).not.toBe("");

    const { result } = renderHook(() => {
      const analyze = useAnalyzeChannels(gpu.backend, runtime.registry);
      const compile = useGraphCompile(runtime, CAPABILITIES);
      return { analyze, compile };
    });

    await act(async () => {
      result.current.analyze.track(result.current.compile.graph, result.current.compile.compiled);
    });

    // Nothing has been sampled yet: §V144's retained-value rule means the channel is
    // simply unknown, not zero.
    expect(result.current.analyze.resolver(channelName, { frame: FRAME } as never)).toBeUndefined();

    // The observer runs INSIDE the open frame, which is where the real frame driver calls
    // it. A direct read there is refused; the deferral is what makes this work at all.
    await act(async () => {
      gpu.duringFrame(() => result.current.analyze.observe(FRAME));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(gpu.refusals).toBe(0);
    expect(gpu.reads).toBeGreaterThan(0);
    expect(result.current.analyze.resolver(channelName, { frame: FRAME } as never)).toBeCloseTo(
      0.375,
      6,
    );

    runtime.dispose();
  });

  it("would be refused if the sample ran inside the frame — the reason for the deferral", async () => {
    // NON-VACUITY for the test above. If `observe` ever calls `sample()` synchronously,
    // this is the failure it produces: a rejected read, swallowed, and a channel that
    // stays undefined forever while every other test still passes.
    const gpu = guardedBackend(0.5);
    let rejected = false;
    gpu.duringFrame(() => {
      void gpu.backend.readBuffer("scratch:meter:result").catch(() => {
        rejected = true;
      });
    });
    await flushMicrotasks();
    expect(rejected).toBe(true);
    expect(gpu.refusals).toBe(1);
  });

  it("tracks only readbacks the PLAN allocated, so an unconnected Analyze makes no noise", async () => {
    const runtime = newRuntime();
    const gpu = guardedBackend(0.25);
    let orphanId = "";

    await act(async () => {
      const result = await seed(runtime, [
        // No input: Analyze compiles to no passes and declares no reduction buffer, so
        // reading it would report `unknownResource` into the diagnostics hub every frame.
        { op: "addNode", ref: "$meter", type: "analyze", position: { x: 0, y: 0 } },
      ]);
      orphanId = result.output.createdIds["$meter"] ?? "";
    });

    const { result } = renderHook(() => {
      const analyze = useAnalyzeChannels(gpu.backend, runtime.registry);
      const compile = useGraphCompile(runtime, CAPABILITIES);
      return { analyze, compile };
    });

    const allocated = (result.current.compile.compiled?.resources ?? []).map(
      (resource) => resource.id,
    );
    expect(allocated).not.toContain(scratchResourceId(orphanId, "result"));

    await act(async () => {
      result.current.analyze.track(result.current.compile.graph, result.current.compile.compiled);
      gpu.duringFrame(() => result.current.analyze.observe(FRAME));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(gpu.reads).toBe(0);
    runtime.dispose();
  });

  it("survives having no backend at all, rather than throwing out of the frame loop", async () => {
    const runtime = newRuntime();
    const { result } = renderHook(() => useAnalyzeChannels(null, runtime.registry));
    await act(async () => {
      result.current.observe(FRAME);
      await flushMicrotasks();
      await flushMicrotasks();
    });
    // No device is an ordinary state (§V12), not an exception. The channel stays unknown.
    expect(result.current.resolver("anything", { frame: FRAME } as never)).toBeUndefined();
    runtime.dispose();
  });
});

describe("T305 — the Analyze resolver is merged in FRONT of the graph resolver", () => {
  it("lets a readback channel outrank a same-named value node", async () => {
    const runtime = newRuntime();
    let lfoId = "";
    let levelId = "";

    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$level", type: "level", position: { x: 240, y: 0 } },
        { op: "addNode", ref: "$lfo", type: "lfo", position: { x: 0, y: 200 } },
        {
          op: "connect",
          source: { nodeId: "$noise", portId: "out" },
          target: { nodeId: "$level", portId: "input" },
        },
      ]);
      expect(result.status).toBe("applied");
      lfoId = result.output.createdIds["$lfo"] ?? "";
      levelId = result.output.createdIds["$level"] ?? "";
    });

    const channel = runtime.bus.store.getGraph().nodes[lfoId]?.label ?? "";
    expect(channel).not.toBe("");

    await act(async () => {
      const result = await seed(runtime, [
        {
          op: "setParameters",
          nodeId: levelId,
          parameters: {
            brightness: {
              mode: "driven",
              bindings: {
                static: { kind: "static", value: 1 },
                driven: { kind: "driven", channel },
              },
            },
          },
        } as GraphPatchOperation,
      ]);
      expect(result.status).toBe("applied");
    });

    /** Stands in for the Analyze binding: answers the same channel name, with 3. */
    const ahead: ChannelResolver = (name) => (name === channel ? 3 : undefined);

    const withAnalyze = renderHook(() =>
      useGraphCompile(runtime, CAPABILITIES, undefined, [ahead]),
    );
    const without = renderHook(() => useGraphCompile(runtime, CAPABILITIES));

    const brightnessOf = (compiled: ReturnType<typeof useGraphCompile>["compiled"]): unknown => {
      const pass = (compiled?.passes ?? []).find(
        (entry) => "nodeId" in entry && entry.nodeId === levelId && "uniforms" in entry,
      );
      return (pass as { uniforms?: Record<string, unknown> } | undefined)?.uniforms?.["brightness"];
    };

    // The whole point of the merge order: a readback is a MEASUREMENT of the running
    // program and a value node is a computation about it. `undefined` means "not mine",
    // which is why first-non-undefined-wins is the rule and not last-writer-wins.
    expect(brightnessOf(withAnalyze.result.current.compiled)).toBe(3);
    // NON-VACUITY: without the extra resolver the same graph resolves to the LFO's own
    // value, so the assertion above is about the merge and not about the default.
    expect(brightnessOf(without.result.current.compiled)).not.toBe(3);

    runtime.dispose();
  });
});
