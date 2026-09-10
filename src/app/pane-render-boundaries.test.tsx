// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createMemoryStorage, installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { installFlowStubs } from "@editor/graph-canvas/testing.tsx";
import type { BackendCapabilities, CompiledExecutionPlan } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { App } from "./app.tsx";
import { createAppRuntime } from "./app-runtime.ts";
import type { AppRuntime } from "./app-runtime.ts";
import type { GpuStatus } from "./gpu-status.ts";

/**
 * T1238 — a document revision reaches only the panes that READ the document.
 *
 * `App` subscribes to the store and re-renders on every revision; that is its job. What
 * it must not do is take the node library's 108 rows with it: they render the registry,
 * which no edit touches. §T1235 measured the cost of exactly that on E24 — 118 commits
 * of `NodeIdentity×108 CostCell×94 Presence×44` at 15.7 ms each inside one 2 s knob
 * drag, 1.85 s of an 8.1 s window, and the input latency p50 of 30 ms that went with it.
 *
 * The library was re-rendering not because of a prop or a context but because `App`
 * built its pane ELEMENTS afresh on every render, and a fresh element is a re-render
 * whatever its props say. This fails the moment any route — a prop, a context, or
 * element identity — lets a revision back in. Red-verified by removing the `useMemo`
 * around the library slot in `app.tsx` (12 renders where 10 were expected: one per
 * revision).
 */

/**
 * The PANE is counted, not the row: a library row has no subscription of its own, so the
 * only way `NodeIdentity×108` renders is `NodeLibrary` rendering above it — and the
 * inspector's header is a `NodeIdentity` too, which legitimately renders on a selection.
 */
const libraryRenders = vi.hoisted(() => ({ count: 0 }));
/**
 * The shell's chrome is the other subtree a revision has no business in: every leaf's
 * tab strip, its menus and their tooltip triggers (~600 fibers, 10–12 ms per `App`
 * commit on chain-200) read the layout and nothing the document holds. Counted at the
 * leaf, which is where the whole strip hangs. Red-verified by removing the `useMemo`
 * around `body` in `app-shell.tsx` (60 leaf renders where 50 were expected: five leaves, one more each per revision).
 */
const leafRenders = vi.hoisted(() => ({ count: 0 }));

vi.mock("@editor/library/node-library.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("@editor/library/node-library.tsx")>();
  return {
    ...original,
    NodeLibrary: (props: Parameters<typeof original.NodeLibrary>[0]) => {
      libraryRenders.count += 1;
      return original.NodeLibrary(props);
    },
  };
});

vi.mock("./pane-leaf.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pane-leaf.tsx")>();
  return {
    ...original,
    PaneLeafView: (props: Parameters<typeof original.PaneLeafView>[0]) => {
      leafRenders.count += 1;
      return original.PaneLeafView(props);
    },
  };
});

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

function stubBackend(): LoomBackend {
  return {
    status: {
      initialized: true, disposed: false, halted: false, deviceGeneration: 1,
      temporalResets: 0, resourceBuilds: 0, framesSubmitted: 0, readbacks: 0,
      stale: false, estimatedResourceBytes: 0,
    },
    initialize: () => Promise.resolve(CAPABILITIES),
    compile: (plan: unknown) => Promise.resolve({ id: "f", logical: plan } as CompiledExecutionPlan),
    render() {}, resize() {},
    readOutput: () => Promise.reject(new Error("no GPU")),
    onDiagnostic: () => () => {},
    dispose() {},
    loop: () => ({ stop() {} }),
    updateUniforms() {}, resetTemporalHistory() {},
    recover: () => Promise.resolve(),
    present: (_canvas: unknown, options: { outputId: string }) => ({
      id: "p", outputId: options.outputId, setOutput() {}, dispose() {},
    }),
    previewHost: () => ({ setPreviewProgram() {}, presentPreviews() {}, dispose() {} }),
    onGpuTimings: () => () => {},
    onCpuTimings: () => () => {},
    compileShader: () => Promise.resolve({ ok: false, validated: false, diagnostics: [] }),
    readBuffer: () => Promise.reject(new Error("no GPU")),
    registerMediaSource: () => () => {},
    setCookPolicy() {},
  } as unknown as LoomBackend;
}

async function patch(runtime: AppRuntime, label: string, operations: GraphPatchOperation[]) {
  let output: unknown = null;
  await act(async () => {
    const result = await runtime.bus.execute(
      "graph.applyPatch",
      { baseRevision: runtime.bus.store.getRevision(), label, operations },
      runtime.invocation,
    );
    expect(result.status).toBe("applied");
    output = result.output;
  });
  return output as { createdIds: Record<string, string> };
}

describe("T1238 — the node library and the shell chrome do not re-render on a document revision", () => {
  it("renders its rows once, and never again for a knob edit or a selection change", async () => {
    const runtime = createAppRuntime({
      identityStorage: null,
      actor: { kind: "human", id: "tester", label: "Tester" },
    });
    const status: GpuStatus = { kind: "ready", capabilities: CAPABILITIES, baseline: true, backend: stubBackend() };
    await act(async () => {
      render(<App runtime={runtime} storage={createMemoryStorage()} gpuProbe={() => Promise.resolve(status)} />);
    });
    const { createdIds } = await patch(runtime, "seed", [
      { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
      { op: "addNode", ref: "$level", type: "level", position: { x: 200, y: 0 } },
      { op: "addNode", ref: "$out", type: "output", position: { x: 400, y: 0 } },
      { op: "connect", source: { nodeId: "$solid", portId: "out" }, target: { nodeId: "$level", portId: "input" } },
      { op: "connect", source: { nodeId: "$level", portId: "out" }, target: { nodeId: "$out", portId: "input" } },
    ]);
    const level = createdIds["$level"] ?? "";
    expect(level).not.toBe("");
    // The library is up and populated: the rows exist and have rendered at least once.
    expect(screen.getAllByRole("button", { name: /level/i }).length).toBeGreaterThan(0);
    const mounted = libraryRenders.count;
    expect(mounted).toBeGreaterThan(0);
    const leavesMounted = leafRenders.count;
    expect(leavesMounted).toBeGreaterThan(0);

    // Two revisions, the knob-drag shape: each one re-renders `App` (it reads the
    // document) and re-compiles. Neither may reach a library row.
    const before = runtime.bus.store.getRevision();
    await patch(runtime, "knob", [{ op: "setParameters", nodeId: level, parameters: { brightness: 0.4 } }]);
    await patch(runtime, "knob", [{ op: "setParameters", nodeId: level, parameters: { brightness: 0.7 } }]);
    expect(runtime.bus.store.getRevision()).toBe(before + 2);
    expect(libraryRenders.count).toBe(mounted);
    expect(leafRenders.count).toBe(leavesMounted);

    // And the other trigger §T1235 saw on chain-200: view state that lives in `App`
    // (selection, hover) changing under a stationary library.
    await act(async () => {
      const result = await runtime.bus.execute("graph.selectNodes", { nodeIds: [level] }, runtime.invocation);
      expect(result.status).toBe("applied");
    });
    expect(libraryRenders.count).toBe(mounted);
    expect(leafRenders.count).toBe(leavesMounted);

    runtime.dispose();
  });
});
