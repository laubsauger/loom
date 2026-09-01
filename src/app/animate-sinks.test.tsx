// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { isUniformOnlyChange } from "@compiler/recompile.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { useGraphCompile } from "./use-graph-compile.ts";
import { createPreviewSinkStore } from "./preview-sinks.ts";

/**
 * B95 — the per-frame animate compile uses the SAME sinks as the structural one.
 *
 * The bug this pins: `animate` omitted the sink argument, so it compiled against the
 * every-visible-node fallback while the base plan compiled against the preview
 * SCHEDULER's kept set. The two agree on a fresh load — which is why animation worked
 * and every unit suite was green — and diverge the moment the scheduler suspends one
 * offscreen preview: the base plan loses a pass, `isUniformOnlyChange` goes false, the
 * animator's push returns null, and EVERY driven parameter in the project silently
 * holds its last value for the rest of the session (one structuralDrift warning,
 * §V222's silent-rider shape). Measured live on E28: the orbiting caster froze the
 * moment a pane covered part of the graph.
 *
 * The fixture is the failure's exact geometry: one node OUTSIDE the kept set, one
 * driven parameter that must keep animating anyway.
 */

afterEach(cleanup);

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  limits: { maxTextureDimension2D: 8192 },
  timestampQuery: false,
};

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

describe("B95 — animate compiles with the scheduler's sinks", () => {
  it("stays a values-only variation when a preview is suspended", async () => {
    const runtime = newRuntime();
    let level = "";
    let lfo = "";
    let lfoName = "";
    let extra = "";
    await act(async () => {
      const result = await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          label: "seed",
          operations: [
            { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
            { op: "addNode", ref: "$level", type: "level", position: { x: 200, y: 0 } },
            { op: "addNode", ref: "$out", type: "output", position: { x: 400, y: 0 } },
            { op: "addNode", ref: "$lfo", type: "lfo", position: { x: 0, y: 200 } },
            // The node the scheduler will SUSPEND: previewable, off the render path.
            { op: "addNode", ref: "$extra", type: "solid", position: { x: 0, y: 400 } },
            { op: "connect", source: { nodeId: "$solid", portId: "out" }, target: { nodeId: "$level", portId: "input" } },
            { op: "connect", source: { nodeId: "$level", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
          ] satisfies GraphPatchOperation[],
        },
        runtime.invocation,
      );
      expect(result.status).toBe("applied");
      const created = (result.output as { createdIds: Record<string, string> }).createdIds;
      level = created["$level"] ?? "";
      extra = created["$extra"] ?? "";
      lfo = created["$lfo"] ?? "";
      lfoName = runtime.bus.store.getGraph().nodes[lfo]?.label ?? "";
    });
    expect(lfoName).not.toBe("");

    /**
     * B155 made the drive HONEST, and this fixture had to follow: a stock LFO (−1…1)
     * on a floor-0 brightness spends half its cycle out of range, and at t=5 the old
     * resolver ERRORED there and fell back to the retained static 1 — so the uniform
     * "movement" this test measured was the fallback moving, not the drive. The driven
     * value now pins into range, which parks the old fixture at 0 on both sampled
     * frames. Offset 2 keeps the whole swing inside the range, and 0.05 Hz puts t=5 a
     * quarter cycle up (2 → 3): the movement is the LFO's own.
     */
    await act(async () => {
      const result = await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          label: "lfo range",
          operations: [
            {
              op: "setParameters",
              nodeId: lfo,
              parameters: { frequency: 0.05, amplitude: 1, offset: 2 },
            } as GraphPatchOperation,
          ],
        },
        runtime.invocation,
      );
      expect(result.status).toBe("applied");
    });

    await act(async () => {
      const result = await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          label: "drive",
          operations: [
            {
              op: "setParameters",
              nodeId: level,
              parameters: {
                brightness: {
                  mode: "driven",
                  bindings: {
                    static: { kind: "static", value: 1 },
                    driven: { kind: "driven", channel: lfoName },
                  },
                },
              },
            } as GraphPatchOperation,
          ],
        },
        runtime.invocation,
      );
      expect(result.status).toBe("applied");
    });

    // The scheduler's kept set: everything EXCEPT the suspended extra node. This is
    // exactly the state a pane covering one node produces.
    const sinks = createPreviewSinkStore();
    const graph = runtime.bus.store.getGraph();
    const kept = Object.keys(graph.nodes)
      .filter((nodeId) => nodeId !== extra && graph.nodes[nodeId]?.type !== "output" && graph.nodes[nodeId]?.type !== "lfo")
      .map((nodeId) => ({ nodeId, portId: "out" }));
    act(() => {
      sinks.set(kept);
    });

    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES, sinks));
    const base = result.current.compiled;
    expect(base).not.toBeNull();
    const animate = result.current.animate;
    expect(animate).not.toBeNull();

    const next = animate?.({
      timeSeconds: 5,
      deltaSeconds: 1 / 60,
      frameIndex: 300,
      mode: "realtime",
      randomSeed: 7,
    });
    expect(next).not.toBeNull();
    if (base === null || next === null || next === undefined) throw new Error("unreachable");

    // The whole bug in one line: with mismatched sinks this is false, the animator
    // refuses every frame, and the driven brightness below never reaches the GPU.
    expect(isUniformOnlyChange(base, next)).toBe(true);

    // And the drive is real: the LFO moved brightness between t=0 and t=5, so at least
    // one uniform block differs — a vacuous pass (nothing driven) cannot pass this gate.
    const blocks = (plan: typeof base) =>
      new Map(plan.passes.map((pass) => [pass.id, "uniforms" in pass ? JSON.stringify(pass.uniforms) : ""]));
    const before = blocks(base);
    const moved = [...blocks(next)].filter(([id, uniforms]) => before.get(id) !== uniforms);
    expect(moved.length).toBeGreaterThan(0);
  });
});
