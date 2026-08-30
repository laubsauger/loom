// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import { useGraphCompile } from "./use-graph-compile.ts";

/**
 * §V178 — a rate edit does not recompile (T272).
 *
 * The invariant names the exact mistake it exists to prevent: treat "settings changed" as
 * one event and dragging an fps field rebuilds every GPU resource sixty times a second —
 * while the user is adjusting how often the picture draws, which makes the stutter look
 * like their own change.
 *
 * The trap is subtle because settings are DOCUMENT state (§V177): an edit bumps the
 * revision, so the compile memo is handed a NEW graph object even though the document's
 * content is untouched. Every naive memo recompiles on that. So the assertion is plan
 * IDENTITY across edits — the strongest available statement that no compile ran, and one
 * that a "we only skipped the GPU half" implementation would fail.
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

async function seed(runtime: AppRuntime, operations: GraphPatchOperation[]) {
  return runtime.bus.execute(
    "graph.applyPatch",
    { baseRevision: runtime.bus.store.getRevision(), operations, label: "seed" },
    runtime.invocation,
  );
}

async function seedRenderable(runtime: AppRuntime): Promise<void> {
  await act(async () => {
    const result = await seed(runtime, [
      { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$out", type: "output", position: { x: 240, y: 0 } },
      {
        op: "connect",
        source: { nodeId: "$solid", portId: "out" },
        target: { nodeId: "$out", portId: "input" },
      },
    ]);
    expect(result.status).toBe("applied");
  });
}

const setSettings = async (runtime: AppRuntime, settings: Record<string, unknown>) => {
  await act(async () => {
    const result = await runtime.bus.execute(
      "project.setSettings",
      { settings } as never,
      runtime.invocation,
    );
    expect(result.status).toBe("applied");
  });
};

describe("§V178 — a rate edit costs no compile", () => {
  it("keeps the SAME plan across forty fps edits", async () => {
    const runtime = newRuntime();
    await seedRenderable(runtime);
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));

    const before = result.current.compiled;
    expect(before).not.toBeNull();

    // A drag, at the rate a drag happens.
    for (let step = 0; step < 40; step += 1) {
      await setSettings(runtime, { fps: 24 + step });
    }

    // Identity, not equality: a recompile produces a new plan object even when the plan
    // is identical, and that new object is what forces `backend.compile` downstream.
    expect(result.current.compiled).toBe(before);
    expect(runtime.settings.fps).toBe(63);
    runtime.dispose();
  });

  it("does the same for the other two rates", async () => {
    const runtime = newRuntime();
    await seedRenderable(runtime);
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    const before = result.current.compiled;

    await setSettings(runtime, { previewFps: 10 });
    await setSettings(runtime, { previewLongEdge: 96 });

    expect(result.current.compiled).toBe(before);
    runtime.dispose();
  });

  it("STILL recompiles for a structural edit — the gate is not 'never'", async () => {
    const runtime = newRuntime();
    await seedRenderable(runtime);
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    const before = result.current.compiled;

    // NON-VACUITY. Without this, an implementation that never recompiled anything would
    // satisfy both tests above and silently ignore a resolution change.
    await setSettings(runtime, { outputResolution: { width: 640, height: 480 } });

    expect(result.current.compiled).not.toBe(before);
    expect(result.current.compiled?.outputs[0]?.size).toEqual([640, 480]);
    runtime.dispose();
  });

  it("recompiles for a SEED edit, which no pipeline depends on", async () => {
    // §V45: the plan captures the seed at compile time, so a rate classification would
    // make the edit silently do nothing — worse than the rebuild it costs.
    const runtime = newRuntime();
    await seedRenderable(runtime);
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));
    const before = result.current.compiled;

    await setSettings(runtime, { randomSeed: 99 });

    expect(result.current.compiled).not.toBe(before);
    runtime.dispose();
  });

  it("still recompiles when the GRAPH changes during a rate edit", async () => {
    // The reuse is conditional on the document being untouched. A settings edit and a
    // graph edit landing in the same revision must not let the graph edit through.
    const runtime = newRuntime();
    await seedRenderable(runtime);
    const { result } = renderHook(() => useGraphCompile(runtime, CAPABILITIES));

    await setSettings(runtime, { fps: 30 });
    const afterRate = result.current.compiled;

    await act(async () => {
      await seed(runtime, [{ op: "addNode", ref: "$n", type: "noise", position: { x: 0, y: 400 } }]);
    });

    expect(result.current.compiled).not.toBe(afterRate);
    runtime.dispose();
  });
});

describe("§V177 — settings are live, not a snapshot", () => {
  it("reflects an edit through AppRuntime.settings immediately", async () => {
    const runtime = newRuntime();
    expect(runtime.settings.fps).not.toBe(24);
    await setSettings(runtime, { fps: 24 });
    // A value copied at construction could not do this, and that shape is what made a
    // project saved at 4K open at 1280x720 (T139).
    expect(runtime.settings.fps).toBe(24);
    runtime.dispose();
  });

  it("saves what was last set, not what the document was opened with", async () => {
    const runtime = newRuntime();
    await setSettings(runtime, { outputResolution: { width: 1920, height: 1080 } });
    expect(runtime.projectDocument().settings.outputResolution).toEqual({ width: 1920, height: 1080 });
    runtime.dispose();
  });
});
