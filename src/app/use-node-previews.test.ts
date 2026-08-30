// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { createNodeRuntimeStore } from "@editor/graph-canvas/index.ts";
import { createPreviewSlotBounds, createPreviewViewStore } from "@editor/viewer/index.ts";
import { DEFAULT_PREVIEW_VIEW, previewShader, previewUniforms } from "@runtime/previews/index.ts";
import type { PreviewProgram } from "@runtime/previews/index.ts";
import type { BackendStatus } from "@runtime/backend/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { useNodePreviews } from "./use-node-previews.ts";

/**
 * T185 — the preview system had no caller anywhere in the app, so a node body stayed an
 * empty `<div>` even once T182 stopped pruning it. This exercises the caller in
 * isolation: given a disconnected texture node with a resolved output and a measured
 * slot, one tick must classify it and publish that classification onto the runtime
 * channel `NodeView` reads (§V16).
 */

function graphWith(type: string): GraphDocument {
  return {
    revision: 1,
    nodes: {
      n1: { id: "n1", type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    },
    edges: {},
    groups: {},
  };
}

function fakeBackend(): ShaderloomBackend {
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
      setPreviewProgram: () => {},
      presentPreviews: () => {},
      dispose: () => {},
    }),
  } as unknown as ShaderloomBackend;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useNodePreviews (T185)", () => {
  it("classifies a disconnected texture node and publishes it to the runtime channel", () => {
    const registry = createTestRegistry().view();
    const graph = graphWith("test.blur");
    const nodeRuntime = createNodeRuntimeStore();
    const bounds = createPreviewSlotBounds();
    // Large on-screen rect: well above §V28's `too-small` floor, well inside the surface.
    bounds.publish("n1", { x: 0, y: 0, width: 200, height: 120 });

    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300 }) as DOMRect;
    const canvasRef = { current: canvas };

    const compiledOutputs = [
      {
        nodeId: "n1",
        portId: "out",
        resourceId: "res:n1:out",
        resourceKind: "target" as const,
        size: [64, 64] as const,
        format: "rgba8unorm" as const,
        space: "linear" as const,
        temporal: false,
      },
    ];

    renderHook(() =>
      useNodePreviews({
        backend: fakeBackend(),
        canvasRef,
        bounds,
        graph,
        registry,
        compiledOutputs,
        nodeRuntime,
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        getNodePosition: () => ({ x: 0, y: 0 }),
        previewFps: 20,
        previewLongEdge: 192,
      }),
    );

    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(150); // let NodeRuntimeStore's coalesced flush fire (≤ 10 Hz, §V16)

    const snapshot = nodeRuntime.get("n1");
    expect(snapshot.preview).not.toBeNull();
    expect(snapshot.preview?.output).toEqual({ nodeId: "n1", portId: "out" });
    expect(snapshot.preview?.state.kind).toBe("live");
    // §V100/T197 — resolved facts travel with the classification regardless of whether
    // the tile is live, so a suspended slot never has to go blank to show something.
    expect(snapshot.preview?.facts).toEqual({ width: 64, height: 64, format: "rgba8unorm" });

    nodeRuntime.dispose();
  });

  it("marks a node idle when the compiler has not resolved an output for it yet", () => {
    const registry = createTestRegistry().view();
    const graph = graphWith("test.blur");
    const nodeRuntime = createNodeRuntimeStore();
    const bounds = createPreviewSlotBounds();
    bounds.publish("n1", { x: 0, y: 0, width: 200, height: 120 });

    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300 }) as DOMRect;
    const canvasRef = { current: canvas };

    renderHook(() =>
      useNodePreviews({
        backend: fakeBackend(),
        canvasRef,
        bounds,
        graph,
        registry,
        compiledOutputs: [],
        nodeRuntime,
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        getNodePosition: () => ({ x: 0, y: 0 }),
        previewFps: 20,
        previewLongEdge: 192,
      }),
    );

    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(150);

    expect(nodeRuntime.get("n1").preview?.state.kind).toBe("idle");
    nodeRuntime.dispose();
  });
});

/**
 * T336 — the LENS actually reaches the GPU program.
 *
 * This is the §V220 test, not a unit test. `PreviewRequest.view` existed from T34 and every
 * caller passed `DEFAULT_PREVIEW_VIEW`, so the channel/exposure/tonemap uniforms were a live
 * capability with nothing able to move them; a test that only checked the store, or only
 * checked `viewForLens`, would have stayed green through exactly that. So this asserts the
 * whole path: a lens set on the store lands in the uniform values of the pass the preview
 * host is asked to install.
 */
describe("useNodePreviews carries the preview lens (T336)", () => {
  function capturingBackend(): { backend: ShaderloomBackend; programs: PreviewProgram[] } {
    const programs: PreviewProgram[] = [];
    const base = fakeBackend();
    const backend = {
      ...base,
      previewHost: () => ({
        setPreviewProgram: (program: PreviewProgram) => programs.push(program),
        presentPreviews: () => {},
        dispose: () => {},
      }),
    } as unknown as ShaderloomBackend;
    return { backend, programs };
  }

  function renderWith(views: ReturnType<typeof createPreviewViewStore> | undefined) {
    const registry = createTestRegistry().view();
    const graph = graphWith("test.blur");
    const nodeRuntime = createNodeRuntimeStore();
    const bounds = createPreviewSlotBounds();
    bounds.publish("n1", { x: 0, y: 0, width: 200, height: 120 });

    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300 }) as DOMRect;

    const { backend, programs } = capturingBackend();
    renderHook(() =>
      useNodePreviews({
        backend,
        canvasRef: { current: canvas },
        bounds,
        graph,
        registry,
        compiledOutputs: [
          {
            nodeId: "n1",
            portId: "out",
            resourceId: "res:n1:out",
            resourceKind: "target" as const,
            size: [64, 64] as const,
            format: "rgba16float" as const,
            space: "linear" as const,
            temporal: false,
          },
        ],
        nodeRuntime,
        ...(views === undefined ? {} : { views }),
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        getNodePosition: () => ({ x: 0, y: 0 }),
        previewFps: 20,
        previewLongEdge: 192,
      }),
    );
    vi.advanceTimersToNextFrame();
    nodeRuntime.dispose();
    return programs;
  }

  it("renders the plain picture when no lens store is wired", () => {
    const programs = renderWith(undefined);
    const pass = programs.at(-1)?.passes[0];
    expect(pass).toBeDefined();
    expect(pass?.shader).toBe(previewShader("color"));
    expect(pass?.uniforms).toMatchObject(previewUniforms(DEFAULT_PREVIEW_VIEW));
  });

  it("compiles the isolating shader and its uniforms when a lens is set", () => {
    const views = createPreviewViewStore();
    views.set("n1", { lens: "g", exposureStops: 1, tonemap: true });

    const pass = renderWith(views).at(-1)?.passes[0];

    // Mode switches the PROGRAM (§V5: the shader text is in the structural key) …
    expect(pass?.shader).toBe(previewShader("channel"));
    // … while exposure, the mask and the tonemap are values in the block every mode shares.
    expect(pass?.uniforms).toMatchObject({ channel: 1, exposure: 2, tonemap: 1 });
  });

  it("keeps a lens on one node off every other node's preview", () => {
    const views = createPreviewViewStore();
    views.set("someone-else", { lens: "a" });
    const pass = renderWith(views).at(-1)?.passes[0];
    expect(pass?.shader).toBe(previewShader("color"));
  });
});
