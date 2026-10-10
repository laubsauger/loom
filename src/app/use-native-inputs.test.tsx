// @vitest-environment jsdom
import { flatDocument } from "@compiler/test-support.ts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createAppRuntime } from "./app-runtime.ts";
import { NATIVE_DISCOVERY_INTERVAL_MS, useNativeInputs } from "./use-native-inputs.ts";
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
  const view = renderHook(() => useNativeInputs(h.runtime, h.backend, flatDocument(h.graph), h.resolved));
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
  const view = renderHook(({ graph, resolved }) => useNativeInputs(h.runtime, h.backend, flatDocument(graph), resolved),
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
  const view = renderHook(({ runtime }) => useNativeInputs(runtime, h.backend, flatDocument(h.graph), h.resolved), { initialProps: { runtime: h.runtime } });
  view.rerender({ runtime: { ...h.runtime, documentIdentity: "replacement" } });
  expect(h.dispose).toHaveBeenCalledTimes(1);
  expect(createNativeInputSource).toHaveBeenCalledTimes(2);
  view.unmount(); expect(h.dispose).toHaveBeenCalledTimes(2);
});
/* T1340b: the three "there is no bridge" cases below used to assert a sentence THIS hook
   minted — a fourth wording of a fact the library tagged and the inspector re-phrased, and
   one that only appeared for a node the render was already demanding. The sentence moved to
   the node's own requirement warning; what this hook still owns, and what these assert, is
   that an absent bridge opens NOTHING and never substitutes a different transport. The
   warning itself is asserted against the same node type in
   `use-requirement-diagnostics.test.ts`, so neither half can go quiet unnoticed. */
it("clears its own diagnostics on document replacement", () => {
  const h = setup(); vi.mocked(desktopInputBridge).mockReturnValue({} as never);
  h.graph.nodes["input"]!.parameters = { source: "" };
  const view = renderHook(({ runtime, graph }) => useNativeInputs(runtime, h.backend, flatDocument(graph), h.resolved), { initialProps: { runtime: h.runtime, graph: h.graph } });
  expect(view.result.current.diagnostics[0]?.message).toContain("Select a Syphon source");
  view.rerender({ runtime: { ...h.runtime, documentIdentity: "empty" }, graph: { ...h.graph, nodes: {} } });
  expect(view.result.current.diagnostics).toEqual([]);
});

it("opens nothing at all when the machine has no Syphon bridge", () => {
  const h = setup(); vi.mocked(desktopInputBridge).mockReturnValue(undefined);
  const view = renderHook(() => useNativeInputs(h.runtime, h.backend, flatDocument(h.graph), h.resolved));
  expect(createNativeInputSource).not.toHaveBeenCalled();
  // And it does not mint a sentence of its own: the node carries exactly one requirement
  // warning, in the one vocabulary. Two rows saying the same thing differently is the
  // drift this row deleted.
  expect(view.result.current.diagnostics).toEqual([]);
});

it("selects NDI explicitly and retires an identically named Syphon session on transport change", () => {
  const h = setup();
  const syphon = {} as never, ndi = {} as never;
  vi.mocked(desktopInputBridge).mockImplementation(transport => transport === "ndi" ? ndi : syphon);
  const view = renderHook(({ graph }) => useNativeInputs(h.runtime, h.backend, flatDocument(graph), h.resolved),
    { initialProps: { graph: h.graph } });
  expect(createNativeInputSource).toHaveBeenLastCalledWith(syphon, "uuid", expect.anything());
  view.rerender({ graph: { ...h.graph, nodes: { input: { ...h.graph.nodes["input"]!, type: "ndiIn" } } } });
  expect(h.dispose).toHaveBeenCalledTimes(1);
  expect(h.unregister).toHaveBeenCalledTimes(1);
  expect(createNativeInputSource).toHaveBeenLastCalledWith(ndi, "uuid", expect.anything());
  expect(createNativeInputSource).toHaveBeenCalledTimes(2);
});

it("refuses to stand a Syphon bridge in for an absent NDI one", () => {
  const h = setup();
  vi.mocked(desktopInputBridge).mockImplementation(transport => transport === "ndi" ? undefined : {} as never);
  const graph = { ...h.graph, nodes: { input: { ...h.graph.nodes["input"]!, type: "ndiIn" } } };
  renderHook(() => useNativeInputs(h.runtime, h.backend, flatDocument(graph), h.resolved));
  // A Syphon bridge IS available in this test, which is the substitution the claim is
  // about: asking for NDI and silently getting the other transport's picture.
  expect(desktopInputBridge).toHaveBeenCalledWith("ndi");
  expect(createNativeInputSource).not.toHaveBeenCalled();
});

it("Spout preparation reports unimplemented native sharing without opening another transport", () => {
  const h = setup("spoutIn");
  vi.mocked(desktopInputBridge).mockImplementation(transport => transport === "spout" ? undefined : {} as never);
  const view = renderHook(() => useNativeInputs(h.runtime, h.backend, flatDocument(h.graph), h.resolved));
  expect(desktopInputBridge).toHaveBeenCalledWith("spout");
  expect(view.result.current.diagnostics).toEqual([]);
  expect(createNativeInputSource).not.toHaveBeenCalled();
});

it("empty Spout selection never opens the SDK's active sender", () => {
  const h = setup("spoutIn");
  h.graph.nodes["input"]!.parameters = { source: "" };
  const view = renderHook(() => useNativeInputs(h.runtime, h.backend, flatDocument(h.graph), h.resolved));
  expect(view.result.current.diagnostics[0]?.message).toContain("Select a Spout source");
  expect(createNativeInputSource).not.toHaveBeenCalled();
});

it("switching to Spout retires the previous transport even for the same source name", () => {
  const h = setup();
  const syphon = {} as never, spout = {} as never;
  vi.mocked(desktopInputBridge).mockImplementation(transport => transport === "spout" ? spout : syphon);
  const view = renderHook(({ graph }) => useNativeInputs(h.runtime, h.backend, flatDocument(graph), h.resolved), { initialProps: { graph: h.graph } });
  view.rerender({ graph: { ...h.graph, nodes: { input: { ...h.graph.nodes["input"]!, type: "spoutIn" } } } });
  expect(h.dispose).toHaveBeenCalledOnce();
  expect(createNativeInputSource).toHaveBeenLastCalledWith(spout, "uuid", expect.anything());
});

/* VN113 (owner ruling 2026-10-10): a Syphon In is kept by its server's app + name, so a
   relaunched publisher with a fresh UUID comes back without anyone touching the picker. The
   fake bridge below mints a new UUID per "launch" and keeps the names, which is what
   Resolume does. */
describe("VN113 named sources", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });
  async function named(parameters: Record<string, string>) {
    const h = setup();
    // The node lives in the runtime's own document, so write-backs land somewhere readable.
    await h.runtime.bus.execute("graph.applyPatch", { baseRevision: h.runtime.bus.store.getRevision(), label: "add",
      operations: [{ op: "addNode", ref: "input", type: "syphonIn", position: { x: 0, y: 0 }, parameters }] }, h.runtime.invocation);
    let launch: { id: string; name: string; app: string }[] = [];
    const list = vi.fn(async () => launch);
    const bridge = { list };
    vi.mocked(desktopInputBridge).mockReturnValue(bridge as never);
    const reports: ((message: string | null) => void)[] = [];
    vi.mocked(createNativeInputSource).mockImplementation((_bridge, _uuid, options) => {
      reports.push(options.report);
      return { source: { currentFrame: () => undefined }, dispose: h.dispose, releaseForNavigation: h.releaseForNavigation, ready: Promise.resolve() };
    });
    const graph = () => flatDocument(h.runtime.bus.store.getGraph());
    const view = renderHook(({ graph }) => useNativeInputs(h.runtime, h.backend, graph, h.resolved), { initialProps: { graph: graph() } });
    const tick = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(NATIVE_DISCOVERY_INTERVAL_MS); }); view.rerender({ graph: graph() }); await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
    const stored = () => h.runtime.bus.store.getGraph().nodes["input"]!.parameters;
    return { h, view, tick, stored, reports, list, setLaunch(next: typeof launch) { launch = next; } };
  }

  it("reconnects to the same app + name after the publisher relaunches with a new UUID", async () => {
    const t = await named({ source: "launch-1", sourceApp: "Arena", sourceName: "LED FX" });
    // Arena is not running yet: the node waits, naming what it waits for, and opens nothing.
    await t.tick();
    expect(createNativeInputSource).not.toHaveBeenCalled();
    expect(t.view.result.current.diagnostics.map(d => d.message).join()).toContain("Waiting for Arena – LED FX");
    // First launch: a fresh UUID under the same name.
    t.setLaunch([{ id: "launch-2", app: "Arena", name: "Composition" }, { id: "launch-2-led", app: "Arena", name: "LED FX" }]);
    await t.tick();
    expect(createNativeInputSource).toHaveBeenCalledTimes(1);
    expect(createNativeInputSource).toHaveBeenLastCalledWith(expect.anything(), "launch-2-led", expect.anything());
    // The document now shows the bound id; app + name are untouched, and the write-back did not reopen.
    expect(t.stored()).toMatchObject({ source: "launch-2-led", sourceApp: "Arena", sourceName: "LED FX" });
    expect(createNativeInputSource).toHaveBeenCalledTimes(1);
    act(() => t.reports[0]!(null)); // frames flow
    expect(t.view.result.current.diagnostics).toEqual([]);
    // Arena quits: the session goes offline and discovery no longer lists the server.
    t.setLaunch([]);
    act(() => t.reports[0]!("Native source offline; retained image is stale. Waiting for the selected source to return."));
    await t.tick();
    expect(t.h.dispose).not.toHaveBeenCalled(); // the last image is held
    expect(t.view.result.current.diagnostics.map(d => d.message).join()).toContain("Waiting for Arena – LED FX");
    // Second launch, another UUID: the node rebinds by itself.
    t.setLaunch([{ id: "launch-3-led", app: "Arena", name: "LED FX" }]);
    await t.tick();
    expect(t.h.dispose).toHaveBeenCalledTimes(1);
    expect(createNativeInputSource).toHaveBeenCalledTimes(2);
    expect(createNativeInputSource).toHaveBeenLastCalledWith(expect.anything(), "launch-3-led", expect.anything());
    expect(t.stored()).toMatchObject({ source: "launch-3-led" });
  });

  it("an older document opens by UUID, learns its server's name once, and keeps its session", async () => {
    const t = await named({ source: "old-uuid" });
    expect(createNativeInputSource).toHaveBeenCalledWith(expect.anything(), "old-uuid", expect.anything());
    t.setLaunch([{ id: "old-uuid", app: "Arena", name: "LED FX" }]);
    await t.tick();
    expect(t.stored()).toMatchObject({ source: "old-uuid", sourceApp: "Arena", sourceName: "LED FX" });
    await t.tick();
    expect(createNativeInputSource).toHaveBeenCalledTimes(1);
    expect(t.h.dispose).not.toHaveBeenCalled();
    // Learned once: no more discovery for a delivering node.
    act(() => t.reports[0]!(null));
    const calls = t.list.mock.calls.length;
    await t.tick(); await t.tick();
    expect(t.list.mock.calls.length).toBe(calls);
  });

  it("several servers with the same name: the stored UUID wins, and the node says how many", async () => {
    const t = await named({ source: "b", sourceApp: "Arena", sourceName: "LED FX" });
    t.setLaunch([{ id: "a", app: "Arena", name: "LED FX" }, { id: "b", app: "Arena", name: "LED FX" }]);
    await t.tick();
    expect(createNativeInputSource).toHaveBeenLastCalledWith(expect.anything(), "b", expect.anything());
    expect(t.view.result.current.diagnostics.map(d => d.message).join()).toContain("2 live servers are named Arena – LED FX");
  });
});
