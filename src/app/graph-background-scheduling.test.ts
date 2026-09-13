// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { ResolvedOutput } from "@compiler/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import { useGraphBackground } from "./use-graph-background.ts";

const calls = vi.hoisted(() => ({ update: vi.fn(), reset: vi.fn() }));
vi.mock("@runtime/previews/index.ts", () => ({
  DEFAULT_PREVIEW_VIEW: {}, EMPTY_PREVIEW_PROGRAM: {}, createPreviewSystem: () => calls,
}));
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("background selection scans only on graph/output changes, while rendering still ticks", () => {
  let tick!: FrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { tick = callback; return 1; });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const ownKeys = vi.fn(Reflect.ownKeys);
  const graph = { revision: 1, nodes: new Proxy({
    a: { id: "a", type: "noise", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ui: { background: true } },
  }, { ownKeys }), edges: {}, groups: {} } as GraphDocument;
  const host = { dispose: vi.fn(), setPreviewProgram: vi.fn() };
  const backend = { previewHost: () => host, status: { deviceGeneration: 0 } } as unknown as LoomBackend;
  const canvasRef = { current: document.createElement("canvas") };
  const previewSinks = { set: vi.fn() };
  const inputs = { backend, canvasRef, graph, compiledOutputs: [] as ResolvedOutput[], previewSinks,
    previewFps: 30, previewLongEdge: 320, documentIdentity: "one" };
  const view = renderHook(props => useGraphBackground(props), { initialProps: inputs });
  act(() => { for (let i = 0; i < 60; i++) tick(i); });
  expect(ownKeys).toHaveBeenCalledTimes(1);
  expect(calls.update.mock.calls.length).toBeGreaterThanOrEqual(60);
  expect(previewSinks.set).toHaveBeenLastCalledWith([{ nodeId: "a", portId: "out" }]);

  const output = { nodeId: "a", portId: "out", resourceId: "target:a:out", resourceKind: "target",
    size: [1280, 720], format: "rgba8unorm", space: "linear", temporal: false } as ResolvedOutput;
  view.rerender({ ...inputs, compiledOutputs: [output] }); act(() => tick(61));
  expect(ownKeys).toHaveBeenCalledTimes(2);
  expect(calls.update.mock.lastCall?.[0].requests[0].source.resourceId).toBe("target:a:out");

  view.rerender({ ...inputs, graph: { ...graph, nodes: {} }, documentIdentity: "two" }); act(() => tick(62));
  expect(calls.update.mock.lastCall?.[0].requests).toEqual([]);
  expect(host.setPreviewProgram).toHaveBeenCalled();
  view.unmount(); expect(host.dispose).toHaveBeenCalledOnce();
});
