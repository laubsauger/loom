// @vitest-environment jsdom
import { flatDocument } from "@compiler/test-support.ts";
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
// VNB25: the encode decision (`nativeOutputEncodes`) is the real one; only the bridge is stubbed.
vi.mock("@devices/native-output.ts", async original => ({ ...await original<object>(), desktopOutputBridge: vi.fn() }));
vi.mock("@devices/native-output-session.ts", () => ({ createNativeOutputSession: vi.fn() }));
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.resetAllMocks(); });
function setup(type = "syphonOut", backend = {} as LoomBackend) {
  const runtime = createAppRuntime({ identityStorage: null, actor: { kind: "human", id: "test", label: "Test" } });
  const graph: GraphDocument = { revision: 1, groups: {}, nodes: {
    source: { id: "source", type: "checker", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    sink: { id: "sink", type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { name: "Test" } },
  }, edges: { wire: { id: "wire", source: { nodeId: "source", portId: "out" }, target: { nodeId: "sink", portId: "input" } } } };
  const compiled = { order: ["source", "sink"], outputs: [{ nodeId: "source", portId: "out", resourceId: "source:out", size: [1920, 1080] }] } as unknown as CompiledGraph;
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
  const view = renderHook(({ graph, compiled }) => useNativeOutputs(runtime, backend, flatDocument(graph), compiled), { initialProps: { graph, compiled } });
  return { runtime, graph, compiled, sessions, tick, view };
}
it.each(["syphonOut", "ndiOut", "spoutOut"])("%s publishes full input size, survives movement, closes on deletion", async type => {
  const h = setup(type); await h.tick();
  expect(createNativeOutputSession).toHaveBeenCalledWith(expect.anything(), expect.anything(), { resourceId: "source:out", size: [1920, 1080], encode: false }, "Test");
  h.view.rerender({ graph: { ...h.graph, revision: 2 }, compiled: h.compiled }); await h.tick();
  expect(h.sessions).toHaveLength(1);
  const resized = { ...h.compiled, outputs: h.compiled.outputs.map(output => ({ ...output, size: [1280, 720] as const })) };
  h.view.rerender({ graph: h.graph, compiled: resized }); await h.tick();
  expect(h.sessions).toHaveLength(1);
  expect(h.sessions[0]!.update).toHaveBeenCalledWith({ resourceId: "source:out", size: [1280, 720], encode: false });
  h.view.rerender({ graph: { ...h.graph, nodes: {} }, compiled: h.compiled }); await h.tick();
  expect(h.sessions[0]!.close).toHaveBeenCalledOnce();
});
/* T1409b: with a perform window driving the show, the pump runs on ITS frames. The editor's
   rAF is the stub `setup` installs, and nothing here ever calls it — a hidden editor. */
it("publishes on the perform window's frames while the editor's are parked", async () => {
  const waiting: Array<(time: number) => void> = [];
  const performWindow = {
    requestAnimationFrame: (callback: (time: number) => void) => waiting.push(callback),
    cancelAnimationFrame: () => {},
  };
  const h = setup("syphonOut", { frames: performWindow } as unknown as LoomBackend);
  for (let frame = 0; frame < 2; frame += 1) {
    await act(async () => { for (const callback of waiting.splice(0)) callback(0); });
  }
  expect(createNativeOutputSession).toHaveBeenCalledOnce();
  expect(h.sessions[0]!.pump).toHaveBeenCalledTimes(2);
});
/* T1489b: a Syphon/NDI error reaches the UI within one poll period while the editor is
   hidden and a perform window drives the show. The editor's timers are the throttled
   ones here: `setInterval` is stubbed to a timer that never fires. */
function statusHarness() {
  let clock = 0;
  const now = vi.spyOn(performance, "now").mockImplementation(() => clock);
  let poll: (() => void) | null = null;
  vi.stubGlobal("setInterval", vi.fn((callback: () => void) => { poll = callback; return 7; }));
  vi.stubGlobal("clearInterval", vi.fn());
  const fail = (session: ReturnType<typeof createNativeOutputSession>) =>
    vi.mocked(session.status).mockResolvedValue({ copied: 1, dropped: 0, error: "Syphon server stopped" });
  const settle = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });
  return { now, fail, settle, advance: (ms: number) => { clock += ms; }, poll: () => poll?.() };
}
it("reports a status error within one poll period on the perform window's frames", async () => {
  const s = statusHarness();
  try {
    const waiting: Array<(time: number) => void> = [];
    const performWindow = { requestAnimationFrame: (callback: (time: number) => void) => waiting.push(callback), cancelAnimationFrame: () => {} };
    const h = setup("syphonOut", { frames: performWindow } as unknown as LoomBackend);
    const frame = () => act(async () => { for (const callback of waiting.splice(0)) callback(0); });
    await frame(); await s.settle();
    s.fail(h.sessions[0]!);
    // Not once per frame: a frame inside the period does not ask.
    s.advance(999); await frame(); await s.settle();
    expect(h.sessions[0]!.status).not.toHaveBeenCalled();
    s.advance(1); await frame(); await s.settle();
    expect(h.view.result.current.diagnostics.map(d => d.message)).toEqual(["Error: Syphon server stopped"]);
    expect(h.sessions[0]!.close).toHaveBeenCalledOnce();
  } finally { s.now.mockRestore(); }
});
/* T1489b: with no frames served at all (a hidden editor, no perform window) the editor's
   timer still polls, as it always has. */
it("still polls status on the editor's timer when no frames are served", async () => {
  const s = statusHarness();
  try {
    const h = setup(); await h.tick(); await s.settle();
    s.fail(h.sessions[0]!);
    s.advance(1000); await act(async () => { s.poll(); }); await s.settle();
    expect(h.view.result.current.diagnostics.map(d => d.message)).toEqual(["Error: Syphon server stopped"]);
    expect(h.sessions[0]!.close).toHaveBeenCalledOnce();
  } finally { s.now.mockRestore(); }
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
it.each(["syphonOut", "ndiOut", "spoutOut"])("%s awaits GPU drainage, does not publish during a take, resumes afterward", async type => {
  const h = setup(type); await h.tick();
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
/* T1340b: the host-absent SENTENCE moved onto the node (see the note in
   `use-native-inputs.test.tsx`). What these three still assert is this hook's own claim —
   an absent bridge publishes nothing and never substitutes a different transport — plus
   that it mints no second wording of its own. */
it("publishes nothing, and says nothing of its own, when there is no bridge", async () => {
  vi.mocked(desktopOutputBridge).mockReturnValue(undefined);
  const h = setup(); h.view.unmount();
  vi.mocked(desktopOutputBridge).mockReturnValue(undefined);
  const backend = {} as LoomBackend;
  const view = renderHook(() => useNativeOutputs(h.runtime, backend, flatDocument(h.graph), h.compiled));
  await h.tick();
  expect(createNativeOutputSession).not.toHaveBeenCalled();
  expect(view.result.current.diagnostics).toEqual([]);
});

it("NDI output selects its own capability and cannot reuse a Syphon session", async () => {
  const h = setup();
  const syphon = {} as never, ndi = {} as never;
  vi.mocked(desktopOutputBridge).mockImplementation(transport => transport === "ndi" ? ndi : syphon);
  await h.tick();
  expect(createNativeOutputSession).toHaveBeenLastCalledWith(expect.anything(), syphon, expect.anything(), "Test");
  const graph = { ...h.graph, nodes: { ...h.graph.nodes, sink: { ...h.graph.nodes["sink"]!, type: "ndiOut" } } };
  h.view.rerender({ graph, compiled: h.compiled });
  await h.tick(); await h.tick();
  expect(h.sessions[0]!.close).toHaveBeenCalledOnce();
  expect(createNativeOutputSession).toHaveBeenLastCalledWith(expect.anything(), ndi, expect.anything(), "Test");
});

it("refuses to publish through Syphon when the NDI bridge is absent", async () => {
  const h = setup();
  vi.mocked(desktopOutputBridge).mockImplementation(transport => transport === "ndi" ? undefined : {} as never);
  const graph = { ...h.graph, nodes: { ...h.graph.nodes, sink: { ...h.graph.nodes["sink"]!, type: "ndiOut" } } };
  h.view.rerender({ graph, compiled: h.compiled }); await h.tick();
  // A Syphon bridge IS available here — the substitution the claim is about.
  expect(desktopOutputBridge).toHaveBeenCalledWith("ndi");
  expect(createNativeOutputSession).not.toHaveBeenCalled();
  expect(h.view.result.current.diagnostics).toEqual([]);
});

it("Spout preparation opens no other transport in place of the one that does not exist", async () => {
  const h = setup("spoutOut");
  vi.mocked(desktopOutputBridge).mockImplementation(transport => transport === "spout" ? undefined : {} as never);
  await h.tick();
  expect(desktopOutputBridge).toHaveBeenCalledWith("spout");
  expect(createNativeOutputSession).not.toHaveBeenCalled();
  expect(h.view.result.current.diagnostics).toEqual([]);
});

it("switching to Spout drains the previous publisher before opening a dedicated session", async () => {
  const h = setup();
  const syphon = {} as never, spout = {} as never;
  vi.mocked(desktopOutputBridge).mockImplementation(transport => transport === "spout" ? spout : syphon);
  await h.tick();
  let finish!: () => void;
  vi.mocked(h.sessions[0]!.close).mockReturnValue(new Promise(resolve => { finish = resolve; }));
  h.view.rerender({ graph: { ...h.graph, nodes: { ...h.graph.nodes, sink: { ...h.graph.nodes["sink"]!, type: "spoutOut" } } }, compiled: h.compiled });
  await h.tick();
  expect(h.sessions).toHaveLength(1);
  expect(h.sessions[0]!.close).toHaveBeenCalledOnce();
  finish(); await h.tick(); await h.tick();
  expect(createNativeOutputSession).toHaveBeenLastCalledWith(expect.anything(), spout, expect.anything(), "Test");
});

/* §T1559b (2), ruled live: Publish follows a driven value. The request read `enabled` from
   the document (`resolveStored`), so an expression on it was read at the zero frame and the
   output never followed the clock. The bus carries the frame on screen as the composition
   root attaches it (`attachFrame`), and the hook reads through `bus.readScope()`. The value
   is read every frame, but the session reacts to its EDGES: one open per rising edge, one
   close per falling edge, nothing re-applied while it holds. */
it("§T1559b — Publish driven by an expression opens and closes on the resolved value's edges", async () => {
  let seconds = 0;
  const h = setup();
  h.runtime.bus.attachFrame(() => ({ timeSeconds: seconds, deltaSeconds: 1 / 60, frameIndex: Math.round(seconds * 60), mode: "realtime", randomSeed: 0 }));
  const enabled = { mode: "expression", bindings: { static: { kind: "static", value: false }, expression: { kind: "expression", source: "(time > 1) * (time < 3)" } } };
  const driven = { ...h.graph, revision: 2, nodes: { ...h.graph.nodes, sink: { ...h.graph.nodes["sink"]!, parameters: { name: "Test", enabled } } } } as GraphDocument;
  h.view.rerender({ graph: driven, compiled: h.compiled });
  await h.tick(); await h.tick();
  // t = 0: the expression says off (and so does the retained static), so nothing opens.
  expect(createNativeOutputSession).not.toHaveBeenCalled();
  seconds = 2; await h.tick(); await h.tick(); await h.tick();
  // t = 2: on — the bug never got here. ONE session across three frames of "on": an edge,
  // not a re-open per frame.
  expect(h.sessions).toHaveLength(1);
  expect(h.sessions[0]!.close).not.toHaveBeenCalled();
  expect(h.sessions[0]!.pump).toHaveBeenCalledTimes(3);
  seconds = 4; await h.tick(); await h.tick();
  // t = 4: off again — closed once, and not reopened.
  expect(h.sessions[0]!.close).toHaveBeenCalledOnce();
  expect(h.sessions).toHaveLength(1);
});

/*
 * VNB25: a native output sends what the Output node would show. The selection says whether
 * the presentation blit encodes, from the space the compiler published for the SOURCE and
 * the project's display transform. A change of it is a selection update: the publisher
 * stays up and `attachNativeOutput` swaps the presentation.
 */
it.each(["syphonOut", "ndiOut", "spoutOut"])("%s encodes a linear source, passes encoded and data through, and keeps its publisher on a change", async type => {
  const h = setup(type);
  const withSource = (format: string, space: string) => ({ ...h.compiled,
    outputs: h.compiled.outputs.map(output => ({ ...output, format, space })) }) as unknown as CompiledGraph;
  const linear = withSource("rgba16float", "linear");
  h.view.rerender({ graph: h.graph, compiled: linear }); await h.tick(); await h.tick();
  expect(vi.mocked(createNativeOutputSession).mock.calls.at(-1)![2]).toEqual({ resourceId: "source:out", size: [1920, 1080], encode: true });
  const session = h.sessions.at(-1)!;
  for (const [format, space, encode] of [["rgba16float", "encoded", false], ["rgba16float", "data", false],
    ["rgba8unorm-srgb", "linear", false], ["rgba8unorm", "linear", true]] as const) {
    h.view.rerender({ graph: h.graph, compiled: withSource(format, space) }); await h.tick(); await h.tick();
    expect(vi.mocked(session.update).mock.calls.at(-1)?.[0]).toEqual({ resourceId: "source:out", size: [1920, 1080], encode });
  }
  expect(h.sessions.at(-1)).toBe(session);
  expect(session.close).not.toHaveBeenCalled();
  // `displayTransform: "none"` is raw values out at the Output node, so here too.
  await act(async () => {
    const result = await h.runtime.bus.execute("project.setSettings",
      { settings: { colorPolicy: { workingSpace: "linear", displayTransform: "none" } } } as never, h.runtime.invocation);
    expect(result.status).toBe("applied");
  });
  h.view.rerender({ graph: h.graph, compiled: linear }); await h.tick(); await h.tick();
  expect(vi.mocked(session.update).mock.calls.at(-1)![0]).toEqual({ resourceId: "source:out", size: [1920, 1080], encode: false });
});
