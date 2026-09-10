// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createAppRuntime } from "./app-runtime.ts";
import { useNativeInputs } from "./use-native-inputs.ts";
import { desktopInputBridge, createNativeInputSource } from "@devices/native-input.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
vi.mock("@devices/native-input.ts", () => ({ desktopInputBridge: vi.fn(), createNativeInputSource: vi.fn() }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
function setup() {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "test", label: "Test" } });
  const graph: GraphDocument = { revision: 1, nodes: {
    input: { id: "input", type: "syphonIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { source: "uuid" } },
  }, edges: {}, groups: {} };
  const dispose = vi.fn(); const unregister = vi.fn();
  const registerMediaSource = vi.fn(() => unregister);
  const backend = { registerMediaSource } as unknown as LoomBackend;
  vi.mocked(desktopInputBridge).mockReturnValue({} as never);
  vi.mocked(createNativeInputSource).mockReturnValue({ source: { currentFrame: () => undefined }, dispose, ready: Promise.resolve() });
  const resolved = { order: ["input"], outputs: [{ nodeId: "input", size: [1920, 1080] as const }] };
  return { runtime, graph, dispose, unregister, registerMediaSource, backend, resolved };
}
it("opens demanded nodes only, preserves sessions across movement, and retires on pruning", async () => {
  const h = setup();
  const view = renderHook(({ graph, resolved }) => useNativeInputs(h.runtime, h.backend, graph, resolved),
    { initialProps: { graph: h.graph, resolved: { ...h.resolved, order: [] as string[] } } });
  expect(createNativeInputSource).not.toHaveBeenCalled();
  view.rerender({ graph: h.graph, resolved: h.resolved });
  await waitFor(() => expect(createNativeInputSource).toHaveBeenCalledTimes(1));
  expect(h.registerMediaSource).toHaveBeenCalledWith("media:input", expect.anything());
  view.rerender({ graph: { ...h.graph, nodes: { input: { ...h.graph.nodes["input"]!, position: { x: 99, y: 99 } } } }, resolved: h.resolved });
  expect(createNativeInputSource).toHaveBeenCalledTimes(1);
  view.rerender({ graph: h.graph, resolved: { ...h.resolved, order: [] } });
  expect(h.dispose).toHaveBeenCalledTimes(1); expect(h.unregister).toHaveBeenCalledTimes(1);
});
it("replacing the document retires the old session even when the node IDs match", () => {
  const h = setup();
  const view = renderHook(({ runtime }) => useNativeInputs(runtime, h.backend, h.graph, h.resolved), { initialProps: { runtime: h.runtime } });
  view.rerender({ runtime: { ...h.runtime, documentIdentity: "replacement" } });
  expect(h.dispose).toHaveBeenCalledTimes(1);
  expect(createNativeInputSource).toHaveBeenCalledTimes(2);
  view.unmount(); expect(h.dispose).toHaveBeenCalledTimes(2);
});
it("reports unsupported capability and clears old diagnostics on document replacement", () => {
  const h = setup(); vi.mocked(desktopInputBridge).mockReturnValue(undefined);
  const view = renderHook(({ runtime, graph }) => useNativeInputs(runtime, h.backend, graph, h.resolved), { initialProps: { runtime: h.runtime, graph: h.graph } });
  expect(view.result.current.diagnostics[0]?.message).toMatch(/macOS desktop/);
  view.rerender({ runtime: { ...h.runtime, documentIdentity: "empty" }, graph: { ...h.graph, nodes: {} } });
  expect(view.result.current.diagnostics).toEqual([]);
});
