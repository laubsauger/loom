// @vitest-environment jsdom
import { flatDocument } from "@compiler/test-support.ts";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { Inspector } from "@editor/inspector/inspector.tsx";
import { installDomStubs } from "@ui/testing/install-dom-stubs.ts";
import { useComponentEditing } from "./use-component-editing.ts";
import { createAppRuntime, createRuntimeCatalogue, type AppRuntime } from "./app-runtime.ts";
import { NATIVE_DISCOVERY_INTERVAL_MS, useNativeInputs } from "./use-native-inputs.ts";
import { nativeSourceBindOperations } from "@devices/native-source-match.ts";
import { graphOf, instanceNode, node } from "@domain/components/test-support.ts";
import { effectiveParameterSchema } from "@domain/parameters/resolve.ts";
import { buildProjectFile, loadProject } from "@domain/project/index.ts";
import type { GraphComponentDefinition } from "@domain/types/components.ts";
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

/* VN113 (owner, 2026-10-14): "I want the Syphon node to remember the name between saves and
   loads", for a Syphon In inside a component too. stage-previz-14's StageFeeds is the shape:
   the component publishes each feed's `source` (the UUID) and, until the document publishes
   them, not its app + name. A bind learned at runtime must survive the real save path
   (`buildProjectFile` → `loadProject` → a runtime rebuilt around the loaded document, as
   `project.open` does), and a relaunch under a NEW UUID must rebind with nobody touching it. */
describe("VN113 named sources inside a component instance", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  type Launch = { id: string; app: string; name: string }[];
  /** `published`: which of the Syphon node's keys the component's page publishes. */
  function feedsComponent(runtime: AppRuntime, published: readonly ("source" | "sourceApp" | "sourceName")[]): GraphComponentDefinition {
    const schema = effectiveParameterSchema(runtime.registry.get("syphonIn")!, {});
    const keys = { source: "serverDS", sourceApp: "serverDSApp", sourceName: "serverDSName" } as const;
    return {
      componentId: "stageFeeds", version: 1, name: "Stage Feeds",
      graph: graphOf([node("syphonDS", "syphonIn", { source: "" })]), inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "syphonDS", portId: "out" }],
      parameters: published.map(key => ({ key: keys[key], definition: schema[key]!, targets: [{ nodeId: "syphonDS", key }] })),
    };
  }

  /** The hook over a runtime as the app drives it: its one flattening attached to the bus. */
  function drive(runtime: AppRuntime, planNodeId: string, launch: { current: Launch }) {
    runtime.bus.attachFlattenedGraph(() => runtime.flattened.current());
    vi.mocked(desktopInputBridge).mockReturnValue({ list: vi.fn(async () => launch.current) } as never);
    vi.mocked(createNativeInputSource).mockImplementation(() => ({
      source: { currentFrame: () => undefined }, dispose: vi.fn(), releaseForNavigation: vi.fn(), ready: Promise.resolve() }));
    const backend = { registerMediaSource: vi.fn(() => vi.fn()) } as unknown as LoomBackend;
    const resolved = { order: [planNodeId], outputs: [{ nodeId: planNodeId, size: [1920, 1080] as const }] };
    const graph = () => runtime.flattened.current().graph;
    const view = renderHook(({ graph }) => useNativeInputs(runtime, backend, graph, resolved), { initialProps: { graph: graph() } });
    const tick = async () => {
      await act(async () => { await vi.advanceTimersByTimeAsync(NATIVE_DISCOVERY_INTERVAL_MS); });
      view.rerender({ graph: graph() });
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    };
    return { view, tick, flat: () => runtime.flattened.current().graph.nodes[planNodeId]!.parameters };
  }

  /** The real save and open: the file's bytes, its library, and a runtime rebuilt around them. */
  function saveAndReopen(runtime: AppRuntime): AppRuntime {
    const text = buildProjectFile({ document: runtime.projectDocument(), components: runtime.components.all() }).text;
    const incoming = createRuntimeCatalogue();
    const loaded = loadProject(text, { nodes: incoming.registry, components: incoming.components });
    if (!loaded.ok) throw new Error(loaded.reason);
    return createAppRuntime({ identityStorage: null, document: loaded.document, components: loaded.components });
  }

  async function placed(published: readonly ("source" | "sourceApp" | "sourceName")[]) {
    const runtime = createAppRuntime({ identityStorage: null });
    runtime.components.register(feedsComponent(runtime, published));
    const instance = await runtime.bus.execute("component.instantiate", { componentId: "stageFeeds", position: { x: 0, y: 0 } }, runtime.invocation);
    const instanceId = instance.output.nodeId!;
    // Picked by UUID before VN113, as the stage-previz-14 instance stores it.
    const seeded = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), label: "seed",
      operations: [{ op: "setParameters", nodeId: instanceId, parameters: { serverDS: "launch-1" } }] }, runtime.invocation);
    expect(seeded.status).toBe("applied");
    return { runtime, instanceId, planNodeId: `${instanceId}/syphonDS` };
  }

  it.each([
    { published: ["source"] as const, where: "the instance's own override (names unpublished)" },
    { published: ["source", "sourceApp", "sourceName"] as const, where: "the instance's published page" },
  ])("a bind learned inside a component survives save → open and rebinds a relaunch by name: $where", async ({ published }) => {
    const { runtime, instanceId, planNodeId } = await placed(published);
    const launch = { current: [{ id: "launch-1", app: "Arena", name: "DS" }] as Launch };
    const first = drive(runtime, planNodeId, launch);
    expect(createNativeInputSource).toHaveBeenLastCalledWith(expect.anything(), "launch-1", expect.anything());
    await first.tick();
    // What the node reads back: the name it learned, through its instance.
    expect(first.flat()).toMatchObject({ source: "launch-1", sourceApp: "Arena", sourceName: "DS" });
    const instance = runtime.bus.store.getGraph().nodes[instanceId]!;
    if (published.length === 3) {
      expect(instance.parameters).toMatchObject({ serverDS: "launch-1", serverDSApp: "Arena", serverDSName: "DS" });
      expect(instance.state?.["componentOverrides"]).toBeUndefined();
    } else {
      expect(instance.state?.["componentOverrides"]).toEqual({ "syphonDS/sourceApp": "Arena", "syphonDS/sourceName": "DS" });
    }
    // The definition every other instance shares is untouched.
    expect(runtime.components.get("stageFeeds", 1)!.graph.nodes["syphonDS"]!.parameters).toEqual({ source: "" });
    first.view.unmount();

    // Save, quit, Arena relaunches with a fresh UUID, open: no picker, no user action.
    const reopened = saveAndReopen(runtime);
    vi.mocked(createNativeInputSource).mockClear();
    launch.current = [{ id: "launch-2-comp", app: "Arena", name: "Composition" }, { id: "launch-2", app: "Arena", name: "DS" }];
    const second = drive(reopened, planNodeId, launch);
    expect(second.flat()).toMatchObject({ sourceApp: "Arena", sourceName: "DS" });
    await second.tick();
    expect(createNativeInputSource).toHaveBeenCalledTimes(1);
    expect(createNativeInputSource).toHaveBeenLastCalledWith(expect.anything(), "launch-2", expect.anything());
    // The new UUID lands where `source` is kept: the instance's published `serverDS`.
    expect(reopened.bus.store.getGraph().nodes[instanceId]!.parameters["serverDS"]).toBe("launch-2");
    expect(second.flat()).toMatchObject({ source: "launch-2", sourceApp: "Arena", sourceName: "DS" });
  });

  it("a bind inside a component nested in a component persists through the root instance's override", async () => {
    const runtime = createAppRuntime({ identityStorage: null });
    runtime.components.register(feedsComponent(runtime, []));
    runtime.components.register({ componentId: "rig", version: 1, name: "Rig",
      graph: graphOf([instanceNode("feeds", "stageFeeds", 1)]), inputs: [], outputs: [], parameters: [] });
    const instance = await runtime.bus.execute("component.instantiate", { componentId: "rig", position: { x: 0, y: 0 } }, runtime.invocation);
    const rigId = instance.output.nodeId!;
    const planNodeId = `${rigId}/feeds/syphonDS`;
    runtime.bus.attachFlattenedGraph(() => runtime.flattened.current());
    // The one write the hook and the inspector's pick both send.
    await act(async () => {
      const result = await runtime.bus.execute("graph.applyPatch", { baseRevision: runtime.bus.store.getRevision(), label: "pick",
        operations: nativeSourceBindOperations(planNodeId, { source: "launch-1", sourceApp: "Arena", sourceName: "DS" },
          runtime.flattened.current().publishedOrigins) }, runtime.invocation);
      expect(result.status, result.diagnostics.map(d => d.message).join()).toBe("applied");
    });
    expect(runtime.bus.store.getGraph().nodes[rigId]!.state?.["componentOverrides"]).toMatchObject({ "feeds/syphonDS/sourceName": "DS" });
    const reopened = saveAndReopen(runtime);
    expect(reopened.flattened.current().graph.nodes[planNodeId]!.parameters).toMatchObject({ source: "launch-1", sourceApp: "Arena", sourceName: "DS" });
  });
});

/* VN113: the inspector's pick for a Syphon In inside a component, with the editor dived into
   the instance and the panel wired as `side-panes.tsx` wires it. The parameter editor alone
   would split the three keys between the instance (`source`, published) and the definition
   (the names), and refuse the mix. */
describe("VN113 inspector pick inside a component instance", () => {
  beforeAll(installDomStubs);
  function Panel({ runtime }: { runtime: AppRuntime }) {
    const editing = useComponentEditing(runtime);
    if (!editing.insideComponent) return null;
    const prefix = editing.path.join("/");
    return <Inspector bus={editing.bus} context={runtime.invocation} nodeId="syphonDS" settings={runtime.settings}
      planNodeId={`${prefix}/syphonDS`} flattened={() => runtime.flattened.current()}
      {...(editing.instanceParameters === undefined ? {} : { instanceParameters: editing.instanceParameters })} />;
  }

  it.each([["source"], ["source", "sourceApp", "sourceName"]] as const)("persists app + name + UUID through the instance (published: %s)", async (...published) => {
    const runtime = createAppRuntime({ identityStorage: null });
    runtime.bus.attachFlattenedGraph(() => runtime.flattened.current());
    const schema = effectiveParameterSchema(runtime.registry.get("syphonIn")!, {});
    const keys = { source: "serverDS", sourceApp: "serverDSApp", sourceName: "serverDSName" } as const;
    runtime.components.register({ componentId: "stageFeeds", version: 1, name: "Stage Feeds",
      graph: graphOf([node("syphonDS", "syphonIn", { source: "" })]), inputs: [],
      outputs: [{ externalId: "out", label: "Out", nodeId: "syphonDS", portId: "out" }],
      parameters: published.map(key => ({ key: keys[key], definition: schema[key]!, targets: [{ nodeId: "syphonDS", key }] })) });
    const placed = await runtime.bus.execute("component.instantiate", { componentId: "stageFeeds", position: { x: 0, y: 0 } }, runtime.invocation);
    const instanceId = placed.output.nodeId!;
    vi.mocked(desktopInputBridge).mockReturnValue({ list: vi.fn(async () => [{ id: "launch-1", app: "Arena", name: "DS" }]) } as never);
    render(<Panel runtime={runtime} />);
    await act(async () => { await runtime.bus.execute("graph.diveIn", { nodeId: instanceId }, runtime.invocation); });
    await screen.findByText("Arena / DS");
    await act(async () => { fireEvent.change(screen.getByLabelText("Syphon source"), { target: { value: "launch-1" } }); });
    await waitFor(() => expect(runtime.flattened.current().graph.nodes[`${instanceId}/syphonDS`]!.parameters)
      .toMatchObject({ source: "launch-1", sourceApp: "Arena", sourceName: "DS" }));
    // The panel reads it back through the same resolution the hook opens with.
    expect(await screen.findByText("Bound to Arena – DS")).toBeTruthy();
    const instance = runtime.bus.store.getGraph().nodes[instanceId]!;
    expect(instance.parameters["serverDS"]).toBe("launch-1");
    if (published.length === 1) expect(instance.state?.["componentOverrides"]).toEqual({ "syphonDS/sourceApp": "Arena", "syphonDS/sourceName": "DS" });
    else expect(instance.parameters).toMatchObject({ serverDSApp: "Arena", serverDSName: "DS" });
    expect(runtime.components.get("stageFeeds", 1)!.graph.nodes["syphonDS"]!.parameters).toEqual({ source: "" });
    // One undo step takes the whole pick back.
    await act(async () => { await runtime.bus.execute("graph.undo", {}, runtime.invocation); });
    const undone = runtime.flattened.current().graph.nodes[`${instanceId}/syphonDS`]!.parameters;
    expect([undone["source"], undone["sourceApp"] ?? "", undone["sourceName"] ?? ""]).toEqual(["", "", ""]);
  });
});
