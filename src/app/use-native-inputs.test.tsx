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
function setup(type = "syphonIn") {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "test", label: "Test" } });
  const graph: GraphDocument = { revision: 1, nodes: {
    input: { id: "input", type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { source: "uuid" } },
  }, edges: {}, groups: {} };
  const dispose = vi.fn(); const unregister = vi.fn(); const releaseForNavigation = vi.fn();
  const registerMediaSource = vi.fn(() => unregister);
  const backend = { registerMediaSource } as unknown as LoomBackend;
  vi.mocked(desktopInputBridge).mockReturnValue({} as never);
  vi.mocked(createNativeInputSource).mockReturnValue({ source: { currentFrame: () => undefined }, dispose, releaseForNavigation, ready: Promise.resolve() });
  const resolved = { order: ["input"], outputs: [{ nodeId: "input", size: [1920, 1080] as const }] };
  return { runtime, graph, dispose, releaseForNavigation, unregister, registerMediaSource, backend, resolved };
}
it.each(["pagehide", "loom-native-input-retire"])("%s releases document-owned frames without waiting for React unmount", (event) => {
  const h = setup();
  const view = renderHook(() => useNativeInputs(h.runtime, h.backend, h.graph, h.resolved));
  window.dispatchEvent(new Event(event));
  expect(h.releaseForNavigation).toHaveBeenCalledTimes(1);
  expect(h.unregister).toHaveBeenCalledTimes(1);
  expect(h.dispose).not.toHaveBeenCalled();
  view.unmount();
  window.dispatchEvent(new Event(event));
  expect(h.releaseForNavigation).toHaveBeenCalledTimes(1);
});
it.each(["syphonIn", "ndiIn", "spoutIn"])("%s opens demanded nodes only, preserves sessions across movement, and retires on pruning", async type => {
  const h = setup(type);
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

it("selects NDI explicitly and retires an identically named Syphon session on transport change", () => {
  const h = setup();
  const syphon = {} as never, ndi = {} as never;
  vi.mocked(desktopInputBridge).mockImplementation(transport => transport === "ndi" ? ndi : syphon);
  const view = renderHook(({ graph }) => useNativeInputs(h.runtime, h.backend, graph, h.resolved),
    { initialProps: { graph: h.graph } });
  expect(createNativeInputSource).toHaveBeenLastCalledWith(syphon, "uuid", expect.anything());
  view.rerender({ graph: { ...h.graph, nodes: { input: { ...h.graph.nodes["input"]!, type: "ndiIn" } } } });
  expect(h.dispose).toHaveBeenCalledTimes(1);
  expect(h.unregister).toHaveBeenCalledTimes(1);
  expect(createNativeInputSource).toHaveBeenLastCalledWith(ndi, "uuid", expect.anything());
  expect(createNativeInputSource).toHaveBeenCalledTimes(2);
});

it("reports an absent NDI capability without opening another transport", () => {
  const h = setup();
  vi.mocked(desktopInputBridge).mockImplementation(transport => transport === "ndi" ? undefined : {} as never);
  const graph = { ...h.graph, nodes: { input: { ...h.graph.nodes["input"]!, type: "ndiIn" } } };
  const view = renderHook(() => useNativeInputs(h.runtime, h.backend, graph, h.resolved));
  expect(view.result.current.diagnostics[0]?.message).toContain("explicit local NDI SDK");
  expect(createNativeInputSource).not.toHaveBeenCalled();
});

it("Spout preparation reports unimplemented native sharing without opening another transport", () => {
  const h = setup("spoutIn");
  vi.mocked(desktopInputBridge).mockImplementation(transport => transport === "spout" ? undefined : {} as never);
  const view = renderHook(() => useNativeInputs(h.runtime, h.backend, h.graph, h.resolved));
  expect(desktopInputBridge).toHaveBeenCalledWith("spout");
  expect(view.result.current.diagnostics[0]?.message).toMatch(/Windows.*not implemented/);
  expect(createNativeInputSource).not.toHaveBeenCalled();
});

it("empty Spout selection never opens the SDK's active sender", () => {
  const h = setup("spoutIn");
  h.graph.nodes["input"]!.parameters = { source: "" };
  const view = renderHook(() => useNativeInputs(h.runtime, h.backend, h.graph, h.resolved));
  expect(view.result.current.diagnostics[0]?.message).toContain("Select a Spout source");
  expect(createNativeInputSource).not.toHaveBeenCalled();
});

it("switching to Spout retires the previous transport even for the same source name", () => {
  const h = setup();
  const syphon = {} as never, spout = {} as never;
  vi.mocked(desktopInputBridge).mockImplementation(transport => transport === "spout" ? spout : syphon);
  const view = renderHook(({ graph }) => useNativeInputs(h.runtime, h.backend, graph, h.resolved), { initialProps: { graph: h.graph } });
  view.rerender({ graph: { ...h.graph, nodes: { input: { ...h.graph.nodes["input"]!, type: "spoutIn" } } } });
  expect(h.dispose).toHaveBeenCalledOnce();
  expect(createNativeInputSource).toHaveBeenLastCalledWith(spout, "uuid", expect.anything());
});
