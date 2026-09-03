// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { createNodeRuntimeStore } from "@editor/graph-canvas/index.ts";
import { createPreviewSlotBounds } from "@editor/viewer/index.ts";
import type { BackendStatus, LoomBackend } from "@runtime/backend/index.ts";
import type { PreviewProgram } from "@runtime/previews/index.ts";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { createPreviewSinkStore } from "../../app/preview-sinks.ts";
import { useGraphBackground } from "../../app/use-graph-background.ts";
import { useGraphCompile } from "../../app/use-graph-compile.ts";
import { useNodePreviews } from "../../app/use-node-previews.ts";

/**
 * T620 — THE PREVIEW PIPELINE MUST NOT FREEZE WHEN rAF DOES.
 *
 * Chrome suspends `requestAnimationFrame` entirely for a hidden page — a background
 * tab, or a fully occluded window, which it also reports as hidden. The frame driver,
 * document edits and recompiles all keep running underneath (an agent driving the app
 * through the MCP bridge is exactly this situation), and before this fix the sink store
 * and the preview program simply stopped following the document: every structural
 * recompile then diverged from the frozen preview program, and the preview host warned
 * `Pass "preview/pass/<feedback>:out" binds unknown texture "pingpong:…"` on every
 * retry — once a second, forever — while stale sinks poisoned every compile with
 * `sink-unknown`. Measured live on a plain solid → feedback document in an occluded
 * tab; the same document in a visible tab is steady and warning-free.
 *
 * The fix is one resync step per landed plan, gated on the page being hidden. So the
 * gate here drives the REAL composition (`useGraphCompile` → `PreviewSinkStore` →
 * `useNodePreviews`) with rAF never firing, and asserts the pipeline still follows the
 * document.
 */

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  limits: { maxTextureDimension2D: 8192 },
  timestampQuery: false,
};

function fakeBackend(onProgram: (program: PreviewProgram) => void): LoomBackend {
  const status: BackendStatus = {
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
  };
  return {
    status,
    previewHost: () => ({
      setPreviewProgram: onProgram,
      presentPreviews: () => {},
      dispose: () => {},
    }),
  } as unknown as LoomBackend;
}

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

let restoreVisibility: (() => void) | null = null;

/** jsdom reports "visible"; the defect exists only where Chrome reports "hidden". */
function hidePage(): void {
  const original = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
  restoreVisibility = () => {
    if (original) Object.defineProperty(Document.prototype, "visibilityState", original);
    delete (document as { visibilityState?: unknown }).visibilityState;
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  restoreVisibility?.();
  restoreVisibility = null;
  cleanup();
  vi.useRealTimers();
});

describe("T620 — a hidden page's preview pipeline still follows the document", () => {
  it("a feedback added while hidden reaches the sink set and the preview program with rAF never firing", async () => {
    hidePage();
    const runtime = newRuntime();
    const previewSinks = createPreviewSinkStore();
    const nodeRuntime = createNodeRuntimeStore({ intervalMs: 0 });
    const bounds = createPreviewSlotBounds();
    const positions = new Map<string, { x: number; y: number }>();
    const programs: PreviewProgram[] = [];

    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 900, width: 1200, height: 900 }) as DOMRect;
    const canvasRef = { current: canvas };
    const backend = fakeBackend((program) => programs.push(program));

    const hook = renderHook(() => {
      const compile = useGraphCompile(runtime, CAPABILITIES, previewSinks);
      useNodePreviews({
        previewSinks,
        backend,
        canvasRef,
        bounds,
        graph: compile.graph,
        registry: runtime.registry,
        compiledOutputs: compile.compiled?.outputs ?? [],
        nodeRuntime,
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        getNodePosition: (nodeId: NodeId) => positions.get(nodeId),
        getNodeBoxes: () => [],
        previewFps: 20,
        previewLongEdge: 192,
        documentIdentity: "document-under-test",
      });
      return compile;
    });

    // The agent's edit, landing while the page is hidden. NO rAF frame is ever advanced
    // in this test — vi.advanceTimersToNextFrame is deliberately absent — so anything
    // asserted below happened without the tick loop's cadence.
    let created: Record<string, string> = {};
    await act(async () => {
      const result = await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          label: "seed",
          operations: [
            { op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } },
            { op: "addNode", ref: "$feedback", type: "feedback", position: { x: 200, y: 0 } },
          ],
        },
        runtime.invocation,
      );
      expect(result.status).toBe("applied");
      created = (result.output as { createdIds: Record<string, string> }).createdIds;
    });
    for (const nodeId of Object.values(created)) {
      bounds.publish(nodeId, { x: 0, y: 0, width: 120, height: 90 });
      positions.set(nodeId, { x: 0, y: 0 });
    }
    // A second edit gives the resync a plan whose outputs include what the first one
    // registered — the same two-beat dance the visible tick loop performs.
    await act(async () => {
      const result = await runtime.bus.execute(
        "node.rename",
        { nodeId: created["$solid"] as NodeId, label: "renamed" },
        runtime.invocation,
      );
      expect(result.status).toBe("applied");
    });

    // The sink set followed the document: both nodes registered, so the compile
    // materialized both — the feedback as its ping-pong pair.
    const sinkNodes = previewSinks.get().map((sink) => sink.nodeId);
    expect(sinkNodes).toContain(created["$solid"]);
    expect(sinkNodes).toContain(created["$feedback"]);
    const outputs = hook.result.current.compiled?.outputs ?? [];
    const pair = outputs.find((output) => output.nodeId === created["$feedback"]);
    expect(pair?.resourceKind).toBe("pingPong");

    // And the preview program followed the plan: its passes bind resources the CURRENT
    // plan carries — the exact invariant whose violation was the once-a-second
    // `binds unknown texture` warning.
    const latest = programs.at(-1);
    expect(latest).toBeDefined();
    const planResources = new Set((hook.result.current.compiled?.resources ?? []).map((r) => r.id));
    const programResources = new Set((latest?.resources ?? []).map((r) => r.id));
    for (const pass of latest?.passes ?? []) {
      for (const binding of pass.textures ?? []) {
        expect(
          planResources.has(binding.resourceId) || programResources.has(binding.resourceId),
          `preview pass "${pass.id}" binds "${binding.resourceId}", which neither the plan nor the preview program carries`,
        ).toBe(true);
      }
    }
    expect((latest?.passes ?? []).length).toBeGreaterThan(0);
  });
});

describe("T634 — the graph background follows the document while hidden too", () => {
  it("a node marked as background while hidden reaches the sink set with rAF never firing", async () => {
    hidePage();
    const runtime = newRuntime();
    const previewSinks = createPreviewSinkStore();
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 900, width: 1200, height: 900 }) as DOMRect;
    const canvasRef = { current: canvas };
    const backend = fakeBackend(() => {});

    const hook2 = renderHook(() => {
      const compile = useGraphCompile(runtime, CAPABILITIES, previewSinks);
      useGraphBackground({
        backend,
        canvasRef,
        graph: compile.graph,
        compiledOutputs: compile.compiled?.outputs ?? [],
        previewSinks,
        previewFps: 20,
        previewLongEdge: 192,
        documentIdentity: "document-under-test",
      });
      return compile;
    });

    let solidId = "";
    await act(async () => {
      const result = await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          label: "seed",
          operations: [{ op: "addNode", ref: "$solid", type: "solid", position: { x: 0, y: 0 } }],
        },
        runtime.invocation,
      );
      expect(result.status).toBe("applied");
      solidId = (result.output as { createdIds: Record<string, string> }).createdIds["$solid"] ?? "";
    });
    await act(async () => {
      const result = await runtime.bus.execute(
        "graph.applyPatch",
        {
          baseRevision: runtime.bus.store.getRevision(),
          label: "mark",
          operations: [
            { op: "setNodeUi", nodeId: solidId as NodeId, ui: { background: true } } as never,
          ],
        },
        runtime.invocation,
      );
      expect(result.status).toBe("applied");
    });

    // Marking IS watching (T252): the mark registered the sink without a single rAF
    // frame, so the recompile materializes the background's source.
    expect(hook2.result.current.graph.nodes[solidId as NodeId]?.ui?.background).toBe(true);
    expect(previewSinks.get().map((sink) => sink.nodeId)).toContain(solidId);
  });
});
