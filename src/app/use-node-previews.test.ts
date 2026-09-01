// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, renderHook } from "@testing-library/react";
import { createTestRegistry } from "@nodes/registry/test-nodes.ts";
import { createNodeRegistry } from "@nodes/registry/registry.ts";
import { allNodeDefinitions } from "@nodes/definitions/index.ts";
import { SINK_TARGET_PORT } from "@compiler/index.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { createNodeRuntimeStore } from "@editor/graph-canvas/index.ts";
import { createPreviewInterestStore, createPreviewSlotBounds, createPreviewViewStore } from "@editor/viewer/index.ts";
import { DEFAULT_PREVIEW_VIEW, previewShader, previewUniforms } from "@runtime/previews/index.ts";
import type { PreviewProgram } from "@runtime/previews/index.ts";
import type { BackendStatus } from "@runtime/backend/index.ts";
import type { ShaderloomBackend } from "@runtime/backend/index.ts";
import { previewCandidates, useNodePreviews } from "./use-node-previews.ts";

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
        documentIdentity: "document-under-test",
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
        documentIdentity: "document-under-test",
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
        documentIdentity: "document-under-test",
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
    expect(pass?.shader).toBe(previewShader("color", "linear"));
    expect(pass?.uniforms).toMatchObject(previewUniforms(DEFAULT_PREVIEW_VIEW));
  });

  it("compiles the isolating shader and its uniforms when a lens is set", () => {
    const views = createPreviewViewStore();
    views.set("n1", { lens: "g", exposureStops: 1, tonemap: true });

    const pass = renderWith(views).at(-1)?.passes[0];

    // Mode switches the PROGRAM (§V5: the shader text is in the structural key) …
    expect(pass?.shader).toBe(previewShader("channel", "linear"));
    // … while exposure, the mask and the tonemap are values in the block every mode shares.
    expect(pass?.uniforms).toMatchObject({ channel: 1, exposure: 2, tonemap: 1 });
  });

  it("keeps a lens on one node off every other node's preview", () => {
    const views = createPreviewViewStore();
    views.set("someone-else", { lens: "a" });
    const pass = renderWith(views).at(-1)?.passes[0];
    expect(pass?.shader).toBe(previewShader("color", "linear"));
  });
});

/**
 * The OUTPUT node's preview (§V25, §V117).
 *
 * An Output node declares no output port — it consumes one — so the candidate test
 * "has a texture2d output" skipped the one node whose content is the finished picture,
 * and its body was the only empty one in the graph. It does own a texture: the render
 * target the compiler materializes for every declared sink, under `SINK_TARGET_PORT`.
 *
 * The second assertion is the one that is easy to lose: a declared sink must NOT be
 * offered as a preview SINK. It is kept unconditionally already, and naming a port its
 * definition does not declare makes `resolveSinks` warn — a true, useless warning on the
 * problems surface, once per compile.
 */
describe("useNodePreviews previews the node that presents (§V25)", () => {
  const wired = (): GraphDocument => ({
    revision: 1,
    nodes: {
      src: { id: "src", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      out1: { id: "out1", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
    },
    edges: {
      e0: { id: "e0", source: { nodeId: "src", portId: "out" }, target: { nodeId: "out1", portId: "input" } },
    },
    groups: {},
  });

  function run(graph: GraphDocument, compiledOutputs: ReadonlyArray<Record<string, unknown>>) {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const nodeRuntime = createNodeRuntimeStore();
    const bounds = createPreviewSlotBounds();
    for (const nodeId of Object.keys(graph.nodes)) {
      bounds.publish(nodeId, { x: 0, y: 0, width: 200, height: 120 });
    }
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300 }) as DOMRect;
    const sinkSets: ReadonlyArray<{ nodeId: string; portId: string }>[] = [];

    renderHook(() =>
      useNodePreviews({
        backend: fakeBackend(),
        canvasRef: { current: canvas },
        bounds,
        graph,
        registry,
        compiledOutputs: compiledOutputs as never,
        nodeRuntime,
        previewSinks: { set: (refs) => sinkSets.push(refs) },
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        getNodePosition: () => ({ x: 0, y: 0 }),
        previewFps: 20,
        previewLongEdge: 192,
        documentIdentity: "document-under-test",
      }),
    );
    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(150);
    const snapshot = nodeRuntime.get("out1");
    nodeRuntime.dispose();
    return { snapshot, sinkSets };
  }

  const sinkTarget = {
    nodeId: "out1",
    portId: SINK_TARGET_PORT,
    resourceId: `target:out1:${SINK_TARGET_PORT}`,
    resourceKind: "target" as const,
    size: [1280, 720] as const,
    format: "rgba16float" as const,
    space: "linear" as const,
    temporal: false,
  };

  it("shows the presented image on the sink itself, without sinking it", () => {
    const { snapshot, sinkSets } = run(wired(), [sinkTarget]);

    expect(snapshot.preview?.output).toEqual({ nodeId: "out1", portId: SINK_TARGET_PORT });
    expect(snapshot.preview?.state.kind).toBe("live");
    expect(snapshot.preview?.facts).toEqual({ width: 1280, height: 720, format: "rgba16float" });
    // Never asked for as a preview sink: §V25 keeps it, and `resolveSinks` would warn.
    expect(sinkSets.flat().some((ref) => ref.nodeId === "out1")).toBe(false);
  });

  it("asks for nothing when the sink has no input, because it presents nothing", () => {
    const graph = wired();
    const empty = { ...graph, edges: {} };
    const { snapshot } = run(empty, [sinkTarget]);

    // A sink with nothing connected emits no pass, so its target exists in the plan and
    // in no built program: a tile asking for it makes the preview host report an
    // unresolvable binding on every retry, forever.
    expect(snapshot.preview).toBeNull();
  });
});

/**
 * The preview SWITCH (T353, §V297).
 *
 * The owner: "there is no way to disable preview for a node right now, they are basically
 * always on and P button is without function". So the assertion that matters is not that
 * a flag was written — it is that writing it stops the WORK. A test that only checked the
 * body's label would pass just as well against a hidden tile still being rendered every
 * frame, which is precisely the thing being complained about.
 */
describe("every point-producing definition is a preview candidate (T373, §V316, §V319)", () => {
  /**
   * Derived from the REGISTRY the app really passes (§V333 — asking the wrong harness
   * reports absence as truth), never from a list this test writes: the next generator
   * someone adds is covered here by construction, or this fails naming it.
   */
  it("offers a preview for every definition with a pointset or texture output", () => {
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const producers = registry
      .list()
      .filter((definition) =>
        definition.outputs.some((port) => port.type.kind === "pointset" || port.type.kind === "texture2d"),
      );
    expect(producers.length).toBeGreaterThan(10);
    const graph: GraphDocument = {
      revision: 1,
      nodes: Object.fromEntries(
        producers.map((definition, index) => [
          `n${index}`,
          {
            id: `n${index}`,
            type: definition.type,
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: {},
          },
        ]),
      ),
      edges: {},
      groups: {},
    } as never;
    const candidates = previewCandidates(graph, registry);
    const covered = new Set(candidates.map((candidate) => candidate.nodeId));
    const missing = producers
      .map((definition, index) => ({ definition, id: `n${index}` }))
      .filter((entry) => !covered.has(entry.id as never))
      .map((entry) => entry.definition.type);
    expect(missing).toEqual([]);
  });
});

describe("useNodePreviews honours the preview switch (T353, §V297)", () => {
  function offGraph(preview: boolean | undefined): GraphDocument {
    return {
      revision: 1,
      nodes: {
        n1: {
          id: "n1",
          type: "test.blur",
          definitionVersion: 1,
          position: { x: 0, y: 0 },
          parameters: {},
          ...(preview === undefined ? {} : { ui: { preview } }),
        },
      },
      edges: {},
      groups: {},
    };
  }

  function run(graph: GraphDocument) {
    const registry = createTestRegistry().view();
    const nodeRuntime = createNodeRuntimeStore();
    const bounds = createPreviewSlotBounds();
    bounds.publish("n1", { x: 0, y: 0, width: 200, height: 120 });
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300 }) as DOMRect;

    const programs: PreviewProgram[] = [];
    const backend = {
      ...fakeBackend(),
      previewHost: () => ({
        setPreviewProgram: (program: PreviewProgram) => programs.push(program),
        presentPreviews: () => {},
        dispose: () => {},
      }),
    } as unknown as ShaderloomBackend;
    const sinkSets: ReadonlyArray<{ nodeId: string; portId: string }>[] = [];

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
            format: "rgba8unorm" as const,
            space: "linear" as const,
            temporal: false,
          },
        ],
        nodeRuntime,
        previewSinks: { set: (refs) => sinkSets.push(refs) },
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        getNodePosition: () => ({ x: 0, y: 0 }),
        previewFps: 20,
        previewLongEdge: 192,
        documentIdentity: "document-under-test",
      }),
    );
    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(150);
    const snapshot = nodeRuntime.get("n1");
    nodeRuntime.dispose();
    return { snapshot, sinkSets, programs };
  }

  it("costs nothing when off: no tile, no schedule, no sink", () => {
    const { snapshot, sinkSets, programs } = run(offGraph(false));

    // No GPU work: whatever the host was handed, it has nothing to draw.
    expect(programs.at(-1)?.passes ?? []).toHaveLength(0);
    expect(programs.at(-1)?.resources ?? []).toHaveLength(0);
    // Not a preview sink either, so the compiler is free to prune the node entirely —
    // "off" that still materialized a target would be the hidden-tile bug wearing a label.
    expect(sinkSets.flat()).toHaveLength(0);
    // And the body says which state it is in (§V91), with what the compiler resolved
    // still shown (§V100) because this node happens to render for something else.
    expect(snapshot.preview?.state.kind).toBe("off");
    expect(snapshot.preview?.facts).toEqual({ width: 64, height: 64, format: "rgba8unorm" });
  });

  it("is ON when the document says nothing, so an untouched node previews (§V28b)", () => {
    // NON-VACUITY for the test above: the same fixture with no flag does all the work.
    const { snapshot, sinkSets, programs } = run(offGraph(undefined));

    expect(programs.at(-1)?.passes ?? []).not.toHaveLength(0);
    expect(sinkSets.flat().map((ref) => ref.nodeId)).toContain("n1");
    expect(snapshot.preview?.state.kind).toBe("live");
  });

  it("treats an explicit true exactly like an untouched node", () => {
    expect(run(offGraph(true)).snapshot.preview?.state.kind).toBe("live");
  });
});

/**
 * T519 / B106 — a project LOAD drops every tile and every refresh clock.
 *
 * `PreviewSystem.reset()` has named its three callers since T34: "device loss, project
 * load, pane close". Two of them existed. The missing one is this bug: a tile is keyed by
 * NODE ID, two documents share node ids the moment they share node names, and every
 * shipped example has a node called `out`. So opening a second project finds the atlas
 * already holding a tile under the incoming document's key, the scheduler's refresh clock
 * says that key is not due yet, and the node shows the PREVIOUS PROJECT'S pixels — until
 * the user kicks it, which is exactly what the owner reported having to do.
 *
 * §V461 — the fixture must be able to distinguish what it asserts, so the middle step is
 * load-bearing: it proves the clock genuinely says NOT DUE at this moment. Without it, a
 * refresh after the identity change could just be the cadence coming round, and the test
 * would pass whether or not anything was reset.
 */
describe("useNodePreviews resets at a document boundary (T519, B106)", () => {
  it("refreshes a tile the refresh clock says is NOT due, because the document changed", () => {
    const registry = createTestRegistry().view();
    const nodeRuntime = createNodeRuntimeStore();
    const bounds = createPreviewSlotBounds();
    bounds.publish("n1", { x: 0, y: 0, width: 200, height: 120 });
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300 }) as DOMRect;

    const refreshes: ReadonlyArray<string>[] = [];
    const backend = {
      ...fakeBackend(),
      previewHost: () => ({
        setPreviewProgram: () => {},
        presentPreviews: (command: { refresh: ReadonlyArray<string> }) => {
          refreshes.push(command.refresh);
        },
        dispose: () => {},
      }),
    } as unknown as ShaderloomBackend;

    // Two documents that share the node id `n1` — the whole point. Their content is
    // irrelevant here: what must not survive the boundary is the TILE.
    const graph = graphWith("test.blur");
    const { rerender } = renderHook(
      ({ documentIdentity }: { documentIdentity: string }) =>
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
              format: "rgba8unorm" as const,
              space: "linear" as const,
              temporal: false,
            },
          ],
          nodeRuntime,
          getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
          getNodePosition: () => ({ x: 0, y: 0 }),
          // A slow cadence, so "not due" lasts long enough to be a fact rather than a race.
          previewFps: 1,
          previewLongEdge: 192,
          documentIdentity,
        }),
      { initialProps: { documentIdentity: "project-a" } },
    );

    // 1. FIRST PAINT. A key with no refresh clock is always due, so this must draw —
    //    and if it does not, every assertion below is about an empty system.
    vi.advanceTimersToNextFrame();
    expect(refreshes.at(-1)?.length ?? 0).toBeGreaterThan(0);

    // 2. NOT DUE. The clock has barely moved and the cadence is one frame a second, so
    //    the same key must draw nothing. THIS IS THE NON-VACUITY CHECK: it establishes
    //    that a refresh in step 3 cannot be the cadence coming round on its own.
    vi.advanceTimersToNextFrame();
    expect(refreshes.at(-1)).toEqual([]);

    // 3. A DIFFERENT DOCUMENT IS OPEN. Same node id, same clock, still not due — and it
    //    must draw anyway, because the tile behind that key belongs to a project that is
    //    no longer open.
    rerender({ documentIdentity: "project-b" });
    vi.advanceTimersToNextFrame();
    expect(refreshes.at(-1)?.length ?? 0).toBeGreaterThan(0);

    // 4. ...and the boundary is crossed ONCE. Staying in the new document goes straight
    //    back to the cadence, or the fix would be a permanent full-rate repaint.
    vi.advanceTimersToNextFrame();
    expect(refreshes.at(-1)).toEqual([]);

    nodeRuntime.dispose();
  });
});

describe("componentPreviewTarget resolves an instance's preview to an inner node (T601)", () => {
  const makeSystem = async () => {
    const { createComponentSystem } = await import("@domain/components/index.ts");
    const { createNodeRegistry } = await import("@nodes/registry/registry.ts");
    const { allNodeDefinitions } = await import("@nodes/definitions/index.ts");
    const { componentNodeType } = await import("@domain/components/component-type.ts");
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const definition = {
      componentId: "fan",
      version: 1,
      name: "Fan",
      graph: {
        revision: 1,
        nodes: {
          entry: { id: "entry", type: "componentIn", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "feed" },
          blurA: { id: "blurA", type: "blur", definitionVersion: 1, position: { x: 240, y: 0 }, parameters: {} },
          exit: { id: "exit", type: "componentOut", definitionVersion: 1, position: { x: 480, y: 0 }, parameters: {}, label: "result" },
        },
        edges: {
          e0: { id: "e0", source: { nodeId: "entry", portId: "out" }, target: { nodeId: "blurA", portId: "input" } },
          e1: { id: "e1", source: { nodeId: "blurA", portId: "out" }, target: { nodeId: "exit", portId: "in" } },
        },
        groups: {},
      },
      inputs: [],
      outputs: [],
      parameters: [],
    } as never;
    const system = createComponentSystem(registry, [definition]);
    return { system, type: componentNodeType("fan", 1) };
  };

  const inputsFor = (
    system: { nodes: unknown; components: { view(): unknown } },
    type: string,
    ui?: Record<string, unknown>,
  ) =>
    ({
      graph: {
        revision: 1,
        nodes: { c1: { id: "c1", type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, ...(ui === undefined ? {} : { ui }) } },
        edges: {},
        groups: {},
      },
      registry: system.nodes,
      components: system.components.view(),
    }) as never;

  it("defaults to the node behind the FIRST output socket — the Out node (T607)", async () => {
    const { componentPreviewTarget } = await import("./use-node-previews.ts");
    const { system, type } = await makeSystem();
    const target = componentPreviewTarget(inputsFor(system, type), "c1" as never);
    // The Out node itself is a wire; its previewable port resolves and the flat id is
    // the §V82 path the compiler mints for it.
    expect(target).toEqual({ nodeId: "c1/exit", portId: "out" });
  });

  it("ui.componentPreview points the preview at ANY inner node — TD's debug view", async () => {
    const { componentPreviewTarget } = await import("./use-node-previews.ts");
    const { system, type } = await makeSystem();
    const target = componentPreviewTarget(
      inputsFor(system, type, { componentPreview: "blurA" }),
      "c1" as never,
    );
    expect(target).toEqual({ nodeId: "c1/blurA", portId: "out" });
  });

  it("an invalid choice falls back to the default rather than a dead preview", async () => {
    const { componentPreviewTarget } = await import("./use-node-previews.ts");
    const { system, type } = await makeSystem();
    const target = componentPreviewTarget(
      inputsFor(system, type, { componentPreview: "gone" }),
      "c1" as never,
    );
    expect(target?.nodeId).toBe("c1/exit");
  });

  it("a non-instance resolves to nothing — the ordinary path is untouched", async () => {
    const { componentPreviewTarget } = await import("./use-node-previews.ts");
    const { system } = await makeSystem();
    expect(componentPreviewTarget(inputsFor(system, "blur"), "c1" as never)).toBeUndefined();
  });
});

/**
 * T527 — WHICH output the slot binds, on a node that has more than one.
 *
 * `ResolvedOutput`'s own docblock states the rule: "Identity is port-scoped, never
 * node-scoped ... `${nodeId}:${portId}` is the only safe key", because one node can
 * materialize several outputs — a render emitting colour and depth is the shape the
 * compiler already anticipates (`depthOutputs`). The lookup here matched on nodeId ALONE
 * and then built the request from the matched row's own `portId`, so it bound whichever
 * row `find` reached first and labelled the tile with that port. Every shipped node has
 * exactly one previewable output today, which is why this stayed invisible.
 *
 * §V461 — a single-output fixture cannot distinguish "matched the right port" from
 * "matched the only port", so the fixture here declares TWO previewable texture outputs
 * and the assertions name the one `previewablePort` picks (`out`, declared first). The
 * two cases differ only in ARRAY ORDER, which is deliberate: `compiledOutputs` is a
 * `ReadonlyArray` with no ordering contract — the compiler happens to sort by
 * `${nodeId}:${portId}`, so `depth` really does arrive before `out` — and a consumer that
 * reads the right row only for one ordering is not reading the right row.
 */
describe("useNodePreviews binds the PORT it asked for, not the node's first row (T527)", () => {
  const gbufferNode = {
    type: "test.gbuffer",
    version: 1,
    title: "GBuffer",
    category: "generator",
    inputs: [],
    // `out` first: this is the port `previewablePort` picks and therefore the one the
    // slot, the sink and the tile all mean.
    outputs: [
      { id: "out", label: "Colour", type: { kind: "texture2d", sample: "float", channels: 4 } },
      { id: "depth", label: "Depth", type: { kind: "texture2d", sample: "float", channels: 1 } },
    ],
    parameters: {},
    compile: () => ({ passes: [] }),
  } as never;

  const rowFor = (portId: string, size: readonly [number, number], format: string) => ({
    nodeId: "n1",
    portId,
    resourceId: `res:n1:${portId}`,
    resourceKind: "target" as const,
    size,
    format,
    space: "linear" as const,
    temporal: false,
  });

  function run(compiledOutputs: ReadonlyArray<Record<string, unknown>>) {
    const registry = createNodeRegistry([gbufferNode]).view();
    const nodeRuntime = createNodeRuntimeStore();
    const bounds = createPreviewSlotBounds();
    bounds.publish("n1", { x: 0, y: 0, width: 200, height: 120 });
    const canvas = document.createElement("canvas");
    canvas.getBoundingClientRect = () =>
      ({ x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 300, width: 400, height: 300 }) as DOMRect;

    renderHook(() =>
      useNodePreviews({
        backend: fakeBackend(),
        canvasRef: { current: canvas },
        bounds,
        graph: graphWith("test.gbuffer"),
        registry,
        compiledOutputs: compiledOutputs as never,
        nodeRuntime,
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        getNodePosition: () => ({ x: 0, y: 0 }),
        previewFps: 20,
        previewLongEdge: 192,
        documentIdentity: "document-under-test",
      }),
    );
    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(150);
    const snapshot = nodeRuntime.get("n1");
    nodeRuntime.dispose();
    return snapshot;
  }

  it("shows the previewable port even when another row comes first", () => {
    // The compiler's own order: "n1:depth" sorts before "n1:out".
    const snapshot = run([
      rowFor("depth", [32, 32], "r32float"),
      rowFor("out", [64, 64], "rgba8unorm"),
    ]);

    expect(snapshot.preview?.state.kind).toBe("live");
    // Matching by node id alone bound `depth` here and published it as the slot's port.
    expect(snapshot.preview?.output).toEqual({ nodeId: "n1", portId: "out" });
  });

  it("states the RESOLVED FACTS of that port, not of the node's last row (§V100)", () => {
    // Same fixture, opposite order: now the tile was already right by luck and it is the
    // facts — keyed by node, so last row won — that named the wrong port's picture.
    const snapshot = run([
      rowFor("out", [64, 64], "rgba8unorm"),
      rowFor("depth", [32, 32], "r32float"),
    ]);

    expect(snapshot.preview?.output).toEqual({ nodeId: "n1", portId: "out" });
    expect(snapshot.preview?.facts).toEqual({ width: 64, height: 64, format: "rgba8unorm" });
  });
});

describe("the viewer's interest pins a hidden tile (T756)", () => {
  it("requests a node with NO measured slot when the viewer presents it — as a pin, through the one path", () => {
    const registry = createTestRegistry().view();
    const graph = graphWith("test.blur");
    const nodeRuntime = createNodeRuntimeStore();
    // NO bounds published: the tile is hidden — exactly the stale-viewer case.
    const bounds = createPreviewSlotBounds();

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

    const interest = createPreviewInterestStore();
    interest.set("n1" as never);

    renderHook(() =>
      useNodePreviews({
        backend: fakeBackend(),
        canvasRef,
        bounds,
        graph,
        registry,
        compiledOutputs,
        nodeRuntime,
        interest,
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        getNodePosition: () => ({ x: 0, y: 0 }),
        previewFps: 20,
        previewLongEdge: 192,
        documentIdentity: "document-under-test",
      }),
    );

    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(150);

    // The node is LIVE — a request was assembled despite the hidden tile, so the
    // viewer's target keeps rendering. Without interest this exact setup goes idle
    // (the assertion below the withdrawal proves the gate is the interest, §V461).
    expect(nodeRuntime.get("n1").preview?.state.kind).toBe("live");
    nodeRuntime.dispose();
  });

  it("goes idle again when the interest is withdrawn — a closed viewer pins nothing", () => {
    const registry = createTestRegistry().view();
    const graph = graphWith("test.blur");
    const nodeRuntime = createNodeRuntimeStore();
    const bounds = createPreviewSlotBounds();
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
    const interest = createPreviewInterestStore();
    interest.set(null);

    renderHook(() =>
      useNodePreviews({
        backend: fakeBackend(),
        canvasRef,
        bounds,
        graph,
        registry,
        compiledOutputs,
        nodeRuntime,
        interest,
        getViewport: () => ({ x: 0, y: 0, zoom: 1 }),
        getNodePosition: () => ({ x: 0, y: 0 }),
        previewFps: 20,
        previewLongEdge: 192,
        documentIdentity: "document-under-test",
      }),
    );

    vi.advanceTimersToNextFrame();
    vi.advanceTimersByTime(150);

    expect(nodeRuntime.get("n1").preview?.state.kind ?? "idle").toBe("idle");
    nodeRuntime.dispose();
  });
});
