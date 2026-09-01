// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { useMemo } from "react";
import { componentNodeType } from "@domain/components/index.ts";
import { hasAnimatedParameters } from "@domain/channels/graph-channels.ts";
import {
  ANIMATED_COMPONENT_ID,
  animatedComponentDefinition,
} from "../tests/fixtures/animated-component.ts";
import { useGraphCompile } from "./use-graph-compile.ts";
import { useValueGraph } from "./use-value-graph.ts";

/**
 * §V28b/T182 — a disconnected texture-producing node must still compile and preview.
 *
 * Before this, the composition root passed no explicit sink list at all, so a node with
 * no downstream connection reached no active sink, was pruned by §V25, and rendered
 * nothing — the "add a Noise node and see an empty body" bug. The fix is the composition
 * root deriving every visible texture-producing node as a preview sink on every compile
 * (§V28a: the list must be complete, never partial), independent of `ui.preview`, which
 * §V28b repurposes as a pin rather than the on-switch.
 */

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

describe("useGraphCompile — default-on previews (§V28a, §V28b, §V28c)", () => {
  it("does not prune a disconnected texture-producing node, and gives it a preview sink", async () => {
    const runtime = newRuntime();
    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } },
      ]);
      expect(result.status).toBe("applied");
    });

    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));

    const compiled = result.current.compiled;
    expect(compiled).not.toBeNull();
    const plan = compiled!;
    expect(plan.pruned).toHaveLength(0);
    const nodeId = Object.keys(runtime.bus.store.getGraph().nodes)[0];
    expect(nodeId).toBeDefined();
    expect(plan.order).toContain(nodeId);
    expect(plan.outputs.some((output) => output.nodeId === nodeId)).toBe(true);

    runtime.dispose();
  });

  it("still prunes a node with no texture output and no declared sink", async () => {
    // A graph with only a non-texture-producing node (none exist in the v1 catalogue
    // without an output) would compile empty; this asserts the derivation adds nothing
    // when the graph itself is empty, i.e. it never invents a sink.
    const runtime = newRuntime();
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    expect(result.current.compiled?.pruned ?? []).toHaveLength(0);
    expect(result.current.compiled?.order ?? []).toHaveLength(0);
    runtime.dispose();
  });
});

/**
 * T615 — THE ANIMATE GATE, on a document whose ONLY animation is inside a component.
 *
 * This is the largest and least obvious half of the defect. `hasAnimatedParameters` read
 * the RAW document, which contains one component instance node and no animated parameter
 * at all — so `animate` was NULL, so the frame loop had no per-frame compile to call, so
 * every driven parameter AND every expression inside the component was frozen. Nothing
 * reported anything: the plan compiled, the passes ran, the picture simply never moved.
 *
 * Two instances with different published rates, because a single instance cannot show
 * that each one got its OWN number (§V79, §V461).
 */
describe("useGraphCompile — a component's internal animation opens the gate (T615)", () => {
  async function seedInstances(runtime: AppRuntime): Promise<{ one: string; two: string }> {
    runtime.components.register(animatedComponentDefinition());
    let one = "";
    let two = "";
    await act(async () => {
      const result = await seed(runtime, [
        { op: "addNode", ref: "$gen", type: "solid", position: { x: 0, y: 0 } },
        {
          op: "addNode",
          ref: "$one",
          type: componentNodeType(ANIMATED_COMPONENT_ID, 1),
          position: { x: 240, y: 0 },
          parameters: { rate: 0.5 },
        },
        {
          op: "addNode",
          ref: "$two",
          type: componentNodeType(ANIMATED_COMPONENT_ID, 1),
          position: { x: 480, y: 0 },
          parameters: { rate: 2 },
        },
        { op: "connect", source: { nodeId: "$gen", portId: "out" }, target: { nodeId: "$one", portId: "source" } },
        { op: "connect", source: { nodeId: "$one", portId: "out" }, target: { nodeId: "$two", portId: "source" } },
      ]);
      expect(result.status).toBe("applied");
      one = result.output.createdIds["$one"] ?? "";
      two = result.output.createdIds["$two"] ?? "";
    });
    return { one, two };
  }

  it("is NOT null, and each instance's driven blur takes its own number", async () => {
    const runtime = newRuntime();
    const { one, two } = await seedInstances(runtime);
    // The app's channel ladder, in the app's order: the value graph in front of the
    // compile's own shorthand (§V144). Rendered together because the number under test
    // travels from one to the other — a compile with no resolver would fall back to the
    // driven slot's retained static and prove nothing.
    const { result } = renderHook(() => {
      const valueGraph = useValueGraph(runtime);
      const resolvers = useMemo(() => [valueGraph.resolver], [valueGraph.resolver]);
      return { valueGraph, compile: useGraphCompile(runtime, CAPABILITIES, undefined, resolvers) };
    });

    // The raw document declares no animated parameter anywhere. The flattened one does.
    expect(hasAnimatedParameters(runtime.bus.store.getGraph())).toBe(false);
    expect(result.current.compile.animate, "compile.animate was null, so nothing animates").not.toBeNull();

    const frame = {
      timeSeconds: 0.25,
      deltaSeconds: 1 / 60,
      frameIndex: 15,
      mode: "offline" as const,
      randomSeed: 1,
    };
    act(() => {
      for (let index = 0; index <= 15; index += 1) {
        result.current.valueGraph.evaluate({
          frame: { ...frame, timeSeconds: index / 60, frameIndex: index },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [128, 128],
        });
      }
    });
    const plan = result.current.compile.animate?.(frame);
    expect(plan).not.toBeNull();

    const blurSize = (instance: string): number => {
      const pass = plan?.passes.find(
        (entry) => entry.kind === "effect" && entry.id.endsWith(`${instance}/blur:blur-h`),
      );
      if (pass === undefined || pass.kind !== "effect") {
        throw new Error(`no blur pass for ${instance}`);
      }
      return pass.uniforms?.["size"] as number;
    };
    expect(blurSize(one)).not.toBe(blurSize(two));

    runtime.dispose();
  });

  it("publishes the FLAT document, so Analyze and the plot can find the internals", async () => {
    const runtime = newRuntime();
    const { one, two } = await seedInstances(runtime);
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    const flat = result.current.flatGraph;
    expect(Object.keys(flat.nodes)).toContain(`${one}/an`);
    expect(Object.keys(flat.nodes)).toContain(`${two}/an`);
    // And it is the SAME object the runtime memoizes, not a second flattening (§V109).
    expect(flat).toBe(runtime.flattened.current().graph);
    runtime.dispose();
  });
});

describe("project.compile answers for THIS document (T764, §B140)", () => {
  it("does not serve document A's plan to document B when their revisions collide", async () => {
    /* Every shipped example is revision 1, so a revision-only cache key is
       structurally blind across ANY pair of loads — and `project.compile`'s report
       carries an `outputs` listing, which is the owner's stale-listings symptom
       arriving from this third seam. Two runtimes are built to the SAME revision with
       DIFFERENT content; the hook (and with it compileNow's cache) survives the swap
       exactly as it does across adoptDocument, which remounts nothing. */
    const runtimeA = newRuntime();
    await act(async () => {
      await seed(runtimeA, [{ op: "addNode", ref: "$noise", type: "noise", position: { x: 0, y: 0 } }]);
    });
    const runtimeB = newRuntime();
    await act(async () => {
      await seed(runtimeB, [{ op: "addNode", ref: "$ramp", type: "ramp", position: { x: 0, y: 0 } }]);
    });
    expect(runtimeA.bus.store.getRevision()).toBe(runtimeB.bus.store.getRevision());
    expect(runtimeA.documentIdentity).not.toBe(runtimeB.documentIdentity);

    /* The window is DEVICE RECOVERY: the memo's null-capability branch returns early
       without touching the cache, so a load during recovery leaves document A's entry
       standing — and with a revision-only key, B's first project.compile answered with
       A's plan and its outputs listing. (A healthy-device swap is safe by ordering:
       the memo recompiles during render, before the command can run — the first
       version of this test proved itself decorative against exactly that, §V461.) */
    const { rerender } = renderHook(
      ({ runtime, capabilities }: { runtime: AppRuntime; capabilities: BackendCapabilities | null }) =>
        useGraphCompile(runtime, capabilities),
      { initialProps: { runtime: runtimeA, capabilities: CAPABILITIES as BackendCapabilities | null } },
    );
    // Prime the cache from document A through the command itself.
    const reportA = (await runtimeA.bus.execute("project.compile", {}, runtimeA.invocation))
      .output as { outputs: ReadonlyArray<{ nodeId: string }> };
    const nodeA = Object.keys(runtimeA.bus.store.getGraph().nodes)[0]!;
    expect(reportA.outputs.some((output) => output.nodeId === nodeA)).toBe(true);

    // The device drops, and the load lands while it is down.
    rerender({ runtime: runtimeB, capabilities: null });
    const reportB = (await runtimeB.bus.execute("project.compile", {}, runtimeB.invocation))
      .output as { compiled: boolean; outputs: ReadonlyArray<{ nodeId: string }> };
    // Honest answer: no device, no plan — NEVER document A's plan wearing B's name.
    expect(reportB.outputs.some((output) => output.nodeId === nodeA)).toBe(false);
    expect(reportB.compiled).toBe(false);

    runtimeA.dispose();
    runtimeB.dispose();
  });
});
