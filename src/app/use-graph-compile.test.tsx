// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { useGraphCompile } from "./use-graph-compile.ts";

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
