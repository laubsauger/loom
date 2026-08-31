// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { FrameInputs } from "@domain/types/backend.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { componentNodeType } from "@domain/components/index.ts";
import {
  ANIMATED_COMPONENT_ID,
  animatedComponentDefinition,
} from "../tests/fixtures/animated-component.ts";
import { useValueGraph } from "./use-value-graph.ts";

/**
 * B27 — the value graph, evaluated (§V179, §V155, §V181, §V182).
 *
 * `value-graph.test.ts` already proves the evaluator: topological order, cycle rejection,
 * per-channel bags. What it cannot prove is that anything ever calls it, which is the
 * whole of B27 — `createValueGraphSession` had no caller, so `mouse1 → lag1 → parameter`
 * did nothing in the product while every suite stayed green.
 *
 * These tests are about the hook's three obligations, and each one is a property the
 * evaluator itself has no opinion about: evaluate EVERY frame (§V155 — a skipped stateful
 * stage diverges rather than going stale), publish the SAME pointer the shaders read
 * (§V182), and clear state on reset (§V181/§V170).
 */

afterEach(cleanup);

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

const frameAt = (frameIndex: number): FrameEvaluationInput => ({
  timeSeconds: frameIndex / 60,
  deltaSeconds: 1 / 60,
  frameIndex,
  mode: "offline",
  randomSeed: 1,
});

const inputsAt = (frameIndex: number, x: number): FrameInputs => ({
  frame: frameAt(frameIndex),
  pointer: { x, y: 0.25, buttons: 0 },
  resolution: [128, 128],
});

/** `mouse1 → lag1` — the chain §V179's own task row names. */
async function seedMouseLag(runtime: AppRuntime): Promise<{ mouse: string; lag: string }> {
  let mouse = "";
  let lag = "";
  await act(async () => {
    const result = await seed(runtime, [
      { op: "addNode", ref: "$mouse", type: "mouse", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$lag", type: "valueLag", position: { x: 240, y: 0 } },
      {
        op: "connect",
        source: { nodeId: "$mouse", portId: "out" },
        target: { nodeId: "$lag", portId: "in" },
      },
    ]);
    expect(result.status).toBe("applied");
    mouse = result.output.createdIds["$mouse"] ?? "";
    lag = result.output.createdIds["$lag"] ?? "";
  });
  return { mouse, lag };
}

const nameOf = (runtime: AppRuntime, nodeId: string): string =>
  runtime.bus.store.getGraph().nodes[nodeId]?.label ?? "";

describe("B27 — the value graph runs, and its channels reach a resolver", () => {
  it("answers nothing until a frame has been evaluated, then answers", async () => {
    const runtime = newRuntime();
    const { mouse } = await seedMouseLag(runtime);
    const mouseName = nameOf(runtime, mouse);
    expect(mouseName).not.toBe("");

    const { result } = renderHook(() => useValueGraph(runtime));

    // Before any frame there is no answer — deliberately undefined rather than 0, so the
    // structural compile falls through to the zero-frame resolver behind this one instead
    // of being handed a number from a frame that never happened.
    expect(result.current.resolver(`${mouseName}:x`, { frame: frameAt(0) } as never)).toBeUndefined();

    act(() => result.current.evaluate(inputsAt(0, 0.75)));

    // §V182: the SAME pointer the shaders read, not a second listener.
    expect(result.current.resolver(`${mouseName}:x`, { frame: frameAt(0) } as never)).toBe(0.75);
    expect(result.current.resolver(`${mouseName}:y`, { frame: frameAt(0) } as never)).toBe(0.25);
    runtime.dispose();
  });

  it("integrates a stateful stage across frames, which is the point of the graph", async () => {
    const runtime = newRuntime();
    const { lag } = await seedMouseLag(runtime);
    const lagName = nameOf(runtime, lag);

    const { result } = renderHook(() => useValueGraph(runtime));
    const trace: number[] = [];
    act(() => {
      for (let frameIndex = 0; frameIndex < 20; frameIndex += 1) {
        // A step: five frames at 0, then hold at 1. A Lag seeds at its input, so the
        // first frames are 0 and the approach starts when the input moves.
        result.current.evaluate(inputsAt(frameIndex, frameIndex < 5 ? 0 : 1));
        trace.push(result.current.resolver(`${lagName}:x`, { frame: frameAt(frameIndex) } as never) as number);
      }
    });

    expect(trace.slice(0, 5)).toEqual([0, 0, 0, 0, 0]);
    // Monotonic approach, never reaching the target: that is smoothing, and it is only
    // possible because state carried across frames.
    for (let index = 6; index < trace.length; index += 1) {
      expect(trace[index] as number).toBeGreaterThan(trace[index - 1] as number);
      expect(trace[index] as number).toBeLessThan(1);
    }
    // NON-VACUITY: a hook that re-created the session every frame would emit the input
    // verbatim, and every assertion above except this one would still hold.
    expect(trace[trace.length - 1] as number).toBeGreaterThan(0.5);
    runtime.dispose();
  });

  it("keeps its state across a document EDIT — an edit is not a reset (§V155)", async () => {
    const runtime = newRuntime();
    const { lag } = await seedMouseLag(runtime);
    const lagName = nameOf(runtime, lag);
    const { result } = renderHook(() => useValueGraph(runtime));

    act(() => {
      // Stepped, so the stage is still climbing at frame 12 rather than saturated: a
      // saturated Lag would make the "did it keep integrating" check below unfalsifiable.
      for (let frameIndex = 0; frameIndex < 12; frameIndex += 1) {
        result.current.evaluate(inputsAt(frameIndex, frameIndex < 5 ? 0 : 1));
      }
    });
    const before = result.current.resolver(`${lagName}:x`, { frame: frameAt(12) } as never) as number;
    expect(before).toBeGreaterThan(0.2);
    expect(before).toBeLessThan(1);

    // Adding an unrelated node bumps the revision. If the session were keyed on the graph
    // the trajectory would restart here, and every Lag in the project would jump — §V155's
    // divergence arriving through the back door.
    await act(async () => {
      await seed(runtime, [{ op: "addNode", ref: "$n", type: "noise", position: { x: 0, y: 400 } }]);
    });
    act(() => result.current.evaluate(inputsAt(12, 1)));
    const after = result.current.resolver(`${lagName}:x`, { frame: frameAt(12) } as never) as number;
    expect(after).toBeGreaterThan(before);
    runtime.dispose();
  });

  it("clears stateful stages on reset, so a replayed seek is not another history (§V170)", async () => {
    const runtime = newRuntime();
    const { lag } = await seedMouseLag(runtime);
    const lagName = nameOf(runtime, lag);
    const { result } = renderHook(() => useValueGraph(runtime));

    const run = (): number => {
      act(() => {
        for (let frameIndex = 0; frameIndex < 10; frameIndex += 1) {
          result.current.evaluate(inputsAt(frameIndex, frameIndex < 5 ? 0 : 1));
        }
      });
      return result.current.resolver(`${lagName}:x`, { frame: frameAt(10) } as never) as number;
    };

    const first = run();
    act(() => result.current.reset());
    // The channels go with the state: after a reset there is nothing to answer with, and
    // holding the pre-reset number would hand the first replayed frame a value belonging
    // to the history that was just discarded.
    expect(result.current.resolver(`${lagName}:x`, { frame: frameAt(0) } as never)).toBeUndefined();

    // §V170's actual requirement: replaying the same frames from a cleared state produces
    // the same trajectory. Without reset the second run would start where the first ended.
    expect(run()).toBeCloseTo(first, 12);
    runtime.dispose();
  });

  it("reports a cycle rather than emitting numbers from a graph that has none", async () => {
    const runtime = newRuntime();
    let a = "";
    let b = "";
    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$a", type: "valueLag", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$b", type: "valueLag", position: { x: 240, y: 0 } },
      ]);
      a = result.output.createdIds["$a"] ?? "";
      b = result.output.createdIds["$b"] ?? "";
    });
    // Built by hand: the command layer refuses a cycle (§V152) and this is the runtime
    // backstop behind it, so the fixture has to bypass the gate that would stop a user.
    const graph = runtime.bus.store.getGraph();
    const cyclic = {
      ...graph,
      edges: {
        ab: { id: "ab", source: { nodeId: a, portId: "out" }, target: { nodeId: b, portId: "in" } },
        ba: { id: "ba", source: { nodeId: b, portId: "out" }, target: { nodeId: a, portId: "in" } },
      },
    };
    const { result } = renderHook(() => useValueGraph(runtime));
    act(() => {
      // Reach past the store for this one case — see above.
      const session = result.current;
      Object.defineProperty(runtime.bus.store, "getGraph", { value: () => cyclic, configurable: true });
      session.evaluate(inputsAt(0, 0));
    });
    expect(result.current.diagnostics.map((diagnostic) => diagnostic.code)).toContain(
      "valueGraph.cycle",
    );

    // §V16: the condition is stable, so it must cost ONE render and then nothing. A
    // diagnostics array rebuilt per frame would re-render the whole tree sixty times a
    // second — the exact mistake §V16 exists to prevent, arriving through a panel nobody
    // suspected of being a per-frame producer.
    const first = result.current.diagnostics;
    act(() => {
      for (let frameIndex = 1; frameIndex < 10; frameIndex += 1) {
        result.current.evaluate(inputsAt(frameIndex, 0));
      }
    });
    expect(result.current.diagnostics).toBe(first);
    runtime.dispose();
  });

  it("stops reporting once the cycle is gone", async () => {
    const runtime = newRuntime();
    await seedMouseLag(runtime);
    const { result } = renderHook(() => useValueGraph(runtime));
    act(() => result.current.evaluate(inputsAt(0, 0)));
    // A clean graph reports nothing, and reports it as the SAME empty array every frame.
    expect(result.current.diagnostics).toEqual([]);
    const empty = result.current.diagnostics;
    act(() => result.current.evaluate(inputsAt(1, 0)));
    expect(result.current.diagnostics).toBe(empty);
    runtime.dispose();
  });
});

/**
 * T615 — THE SAME HOOK, ON A COMPONENT.
 *
 * The cases above all use root-level nodes, which is exactly why the defect survived: on
 * a root-level graph the raw document and the flattened one are the same nodes with the
 * same ids, so every assertion in this file passed while a value node inside a component
 * instance was never evaluated at all.
 *
 * Two instances with different published rates, because one instance passes even when the
 * two share one bag of state (§V79, §V461).
 */
describe("useValueGraph on a COMPONENT — the internals evaluate, per instance (T615)", () => {
  async function seedTwoInstances(runtime: AppRuntime): Promise<{ one: string; two: string }> {
    runtime.components.register(animatedComponentDefinition());
    let one = "";
    let two = "";
    await act(async () => {
      const result = await seed(runtime, [
        {
          op: "addNode",
          ref: "$one",
          type: componentNodeType(ANIMATED_COMPONENT_ID, 1),
          position: { x: 0, y: 0 },
          parameters: { rate: 0.5 },
        },
        {
          op: "addNode",
          ref: "$two",
          type: componentNodeType(ANIMATED_COMPONENT_ID, 1),
          position: { x: 240, y: 0 },
          parameters: { rate: 2 },
        },
      ]);
      expect(result.status).toBe("applied");
      one = result.output.createdIds["$one"] ?? "";
      two = result.output.createdIds["$two"] ?? "";
    });
    return { one, two };
  }

  it("evaluates each instance's internal LFO, keyed by FLAT ID and reading its own rate", async () => {
    const runtime = newRuntime();
    const { one, two } = await seedTwoInstances(runtime);
    const { result } = renderHook(() => useValueGraph(runtime));

    act(() => {
      for (let frameIndex = 0; frameIndex < 16; frameIndex += 1) {
        result.current.evaluate(inputsAt(frameIndex, 0));
      }
    });

    const bags = result.current.channels();
    const first = bags.get(`${one}/wob`)?.["value"];
    const second = bags.get(`${two}/wob`)?.["value"];
    expect(typeof first).toBe("number");
    expect(typeof second).toBe("number");
    // Different published rate, different number. A shared evaluation would tie them.
    expect(first).not.toBe(second);
    runtime.dispose();
  });

  it("gives the two instances two Lag TRAJECTORIES, not one shared bag (§V79)", async () => {
    const runtime = newRuntime();
    const { one, two } = await seedTwoInstances(runtime);
    const { result } = renderHook(() => useValueGraph(runtime));

    const first: number[] = [];
    const second: number[] = [];
    act(() => {
      for (let frameIndex = 0; frameIndex < 24; frameIndex += 1) {
        result.current.evaluate(inputsAt(frameIndex, 0));
        const bags = result.current.channels();
        first.push(bags.get(`${one}/lag`)?.["value"] as number);
        second.push(bags.get(`${two}/lag`)?.["value"] as number);
      }
    });

    expect(first.every((value) => Number.isFinite(value))).toBe(true);
    expect(first).not.toEqual(second);
    runtime.dispose();
  });

  it("answers a driven channel inside a component at the FRAMELESS zero frame too", async () => {
    const runtime = newRuntime();
    await seedTwoInstances(runtime);
    const { result } = renderHook(() => useValueGraph(runtime));
    // The structural compile's question: no frame at all. Before T615 this resolved
    // against the raw document and answered `undefined`, which the problems tab reported
    // as "channel amt is not attached" on a graph that animates perfectly well.
    const zeroFrame = result.current.resolver("amt", {} as never);
    expect(typeof zeroFrame).toBe("number");
    runtime.dispose();
  });
});
