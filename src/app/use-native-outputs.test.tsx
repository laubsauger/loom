// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { createAppRuntime } from "./app-runtime.ts";
import { useNativeOutputs } from "./use-native-outputs.ts";
import { renderRangeHolderFor } from "./render-range.ts";
import { desktopOutputBridge } from "@devices/native-output.ts";
import { createNativeOutputSession } from "@devices/native-output-session.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
vi.mock("@devices/native-output.ts", () => ({ desktopOutputBridge: vi.fn() }));
vi.mock("@devices/native-output-session.ts", () => ({ createNativeOutputSession: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
function setup() {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "test", label: "Test" } });
  const graph: GraphDocument = { revision: 1, groups: {}, nodes: {
    source: { id: "source", type: "checker", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    sink: { id: "sink", type: "syphonOut", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { name: "Test" } },
  }, edges: { wire: { id: "wire", source: { nodeId: "source", portId: "out" }, target: { nodeId: "sink", portId: "input" } } } };
  const compiled = { order: ["source", "sink"], outputs: [{ nodeId: "source", portId: "out", resourceId: "source:out", size: [1920, 1080] }] } as unknown as CompiledGraph;
  const backend = {} as LoomBackend;
  const sessions: ReturnType<typeof createNativeOutputSession>[] = [];
  vi.mocked(desktopOutputBridge).mockReturnValue({} as never);
  vi.mocked(createNativeOutputSession).mockImplementation(() => {
    const session = { ready: Promise.resolve(), pump: vi.fn(), update: vi.fn(async () => {}), close: vi.fn(async () => {}), status: vi.fn(async () => ({ copied: 1, dropped: 0, error: null })) };
    sessions.push(session); return session;
  });
  let callback: FrameRequestCallback;
  vi.stubGlobal("requestAnimationFrame", vi.fn((fn: FrameRequestCallback) => { callback = fn; return 1; }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const tick = () => act(async () => { callback(0); });
  const view = renderHook(({ graph, compiled }) => useNativeOutputs(runtime, backend, graph, compiled), { initialProps: { graph, compiled } });
  return { runtime, graph, compiled, sessions, tick, view };
}
it("publishes full input size, survives movement, closes on deletion", async () => {
  const h = setup(); await h.tick();
  expect(createNativeOutputSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), { resourceId: "source:out", size: [1920, 1080] }, "Test");
  h.view.rerender({ graph: { ...h.graph, revision: 2 }, compiled: h.compiled }); await h.tick();
  expect(h.sessions).toHaveLength(1);
  const resized = { ...h.compiled, outputs: h.compiled.outputs.map(output => ({ ...output, size: [1280, 720] as const })) };
  h.view.rerender({ graph: h.graph, compiled: resized }); await h.tick();
  expect(h.sessions).toHaveLength(1);
  expect(h.sessions[0]!.update).toHaveBeenCalledWith({ resourceId: "source:out", size: [1280, 720] });
  h.view.rerender({ graph: { ...h.graph, nodes: {} }, compiled: h.compiled }); await h.tick();
  expect(h.sessions[0]!.close).toHaveBeenCalledOnce();
});
it("retiring one of two outputs leaves the other session intact", async () => {
  const h = setup();
  const graph = { ...h.graph, nodes: { ...h.graph.nodes, second: { ...h.graph.nodes["sink"]!, id: "second", parameters: { name: "Second" } } },
    edges: { ...h.graph.edges, secondWire: { ...h.graph.edges["wire"]!, id: "secondWire", target: { nodeId: "second", portId: "input" } } } };
  h.view.rerender({ graph, compiled: { ...h.compiled, order: ["source", "sink", "second"] } });
  await h.tick(); expect(h.sessions).toHaveLength(2);
  h.view.rerender({ graph: h.graph, compiled: h.compiled }); await h.tick();
  expect(h.sessions[0]!.close).not.toHaveBeenCalled();
  expect(h.sessions[1]!.close).toHaveBeenCalledOnce();
});
it("awaits GPU drainage, does not publish during a take, resumes afterward", async () => {
  const h = setup(); await h.tick();
  let finish!: () => void;
  vi.mocked(h.sessions[0]!.close).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  let busy = true;
  renderRangeHolderFor(h.runtime.bus).current = { busy: () => busy, render: vi.fn() };
  let done = false;
  const suspended = h.view.result.current.suspend().then(() => { done = true; });
  await h.tick(); expect(done).toBe(false); expect(h.sessions).toHaveLength(1);
  expect(h.view.result.current.diagnostics[0]?.message).toContain("only a live session");
  finish(); await suspended;
  await h.tick(); expect(h.sessions).toHaveLength(1);
  busy = false; await h.tick(); expect(h.sessions).toHaveLength(2);
});
it("unsupported browser reports without creating transport", async () => {
  vi.mocked(desktopOutputBridge).mockReturnValue(undefined);
  const h = setup(); h.view.unmount();
  vi.mocked(desktopOutputBridge).mockReturnValue(undefined);
  const backend = {} as LoomBackend;
  const view = renderHook(() => useNativeOutputs(h.runtime, backend, h.graph, h.compiled));
  await h.tick();
  expect(createNativeOutputSession).not.toHaveBeenCalled();
  expect(view.result.current.diagnostics[0]?.message).toContain("macOS desktop");
});
