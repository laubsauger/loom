// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import type { InferenceRequest, InferenceResponse } from "@runtime/models/inference-protocol.ts";
import type { LoomBackend } from "@runtime/backend/index.ts";
import type { DispatchInputTiming } from "@runtime/backend/backend-types.ts";
import * as acquisitionModule from "@runtime/models/model-acquisition.ts";
import { act, cleanup, renderHook } from "@testing-library/react";
import { compileGraph } from "@compiler/index.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { FlatGraph, GraphDocument } from "@domain/types/graph.ts";
import { flatDocument } from "@compiler/test-support.ts";
import type { FrameEvaluationInput } from "@domain/types/frame.ts";
import { EXAMPLE_DOCUMENTS } from "@/examples/documents.ts";
import { TIER_B_CAPABILITIES, exampleRegistry } from "@/examples/runner.ts";
import { buildNotices, claimsNothingAfter, runNote, useModelInference } from "./use-model-inference.ts";
import * as nativeInference from "@devices/native-inference.ts";
import { DEPTH_COREML_UNAVAILABLE } from "@nodes/definitions/index.ts";

vi.mock("@devices/native-inference.ts", async (importOriginal) => ({
  ...await importOriginal<typeof import("@devices/native-inference.ts")>(), createNativeVisionSource: vi.fn(),
}));

/**
 * THE CONSTRUCTION SITE FOR THE MODEL NOTICES (B156, §V205, §T743).
 *
 * §T385 built a Depth node that renders its identity fallback when no model is held, so
 * that a document opens on a machine that cannot run it. §T759 shipped E44 Sounding as the
 * first example to exercise that path: with no weights it is a flat lattice over the live
 * plate, "clean and deliberate, not broken". The owner opened it and reported it as "not
 * really doing anything" — which is exactly what a flat lattice looks like.
 *
 * The only thing separating "correct and unavailable" from "broken" was one notice, and
 * §T743's worker had already written down that this notice is LOAD-BEARING. It had NO
 * TEST. `useModelInference` and `buildNotices` had no test of any kind — the factory
 * (acquisition, the seam, the worker runner) was covered end to end and the CONSTRUCTION
 * SITE, where they meet the document and the screen, was not. That is §V205's shape, and
 * it is why a green suite said nothing about a document the owner could not read.
 *
 * So these assert the SENTENCE, not the mechanism: for a real example document whose star
 * node has no model, a person must be told what is on the screen.
 */

const sounding = EXAMPLE_DOCUMENTS.find((entry) => entry.name === "E44 Sounding");

function planFor(graph: GraphDocument): CompiledGraph {
  return compileGraph({
    graph,
    settings: sounding!.settings,
    registry: exampleRegistry(),
    capabilities: TIER_B_CAPABILITIES,
  });
}

function preprocessId(plan: CompiledGraph, nodeId: string): string {
  const pass = plan.passes.find(candidate => candidate.kind === "dispatch" && candidate.nodeId === nodeId);
  if (pass === undefined) throw new Error(`No compiled preprocess for ${nodeId}`);
  return pass.id;
}

/** A document with nothing inferential in it — E44 with the graph emptied. */
const EMPTY_GRAPH: FlatGraph = flatDocument({ revision: 1, nodes: {}, edges: {}, groups: {} });

/** `refresh` reads the (absent) store on a microtask; let it land. */
async function settleRefresh(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function dispatchGates() {
  const gates = new Map<string, (frame: FrameEvaluationInput) => boolean>();
  const callbacks = new Map<string, (frame: FrameEvaluationInput, timing: DispatchInputTiming) => boolean>();
  const removed = vi.fn();
  return {
    gates, callbacks, removed,
    registerDispatchGate: vi.fn((passId: string, gate: (frame: FrameEvaluationInput, timing: DispatchInputTiming) => boolean) => {
      callbacks.set(passId, gate);
      // Existing fixtures model direct, already-submitted current-frame input. Tests
      // exercising open-frame provenance call callbacks with their explicit source.
      gates.set(passId, frame => gate(frame, {
        renderIndex: frame.frameIndex + 1,
        source: { renderIndex: frame.frameIndex + 1, frameIndex: frame.frameIndex,
          timeSeconds: frame.absTimeSeconds ?? frame.timeSeconds },
      }));
      return () => { gates.delete(passId); callbacks.delete(passId); removed(passId); };
    }),
  };
}

function inferenceFrame(index: number): FrameEvaluationInput {
  return { frameIndex: index, timeSeconds: index / 60, deltaSeconds: 1 / 60, mode: "realtime", randomSeed: 7 };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it("T1323: graph deletion retires worker history; lack of demand does not", async () => {
  const createAcquisition = acquisitionModule.createModelAcquisition;
  vi.spyOn(acquisitionModule, "createModelAcquisition").mockImplementation(options => ({
    ...createAcquisition(options),
    refresh: async descriptor => {
      options.onStateChange?.(descriptor.id, { kind: "ready" });
      return { kind: "ready" };
    },
    // Exercise worker construction, never download or run real model weights.
    acquire: async () => undefined,
  }));
  const sent: InferenceRequest[] = [];
  let workers = 0;
  vi.stubGlobal("Worker", class {
    constructor() { workers++; }
    postMessage(message: InferenceRequest) { sent.push(message); }
    addEventListener() {}
    terminate() {}
  });
  const gates = dispatchGates();
  const backend = {
    status: { framesSubmitted: 0 },
    registerDispatchGate: gates.registerDispatchGate,
    readBuffer: async () => new ArrayBuffer(16),
    registerMediaSource: () => () => undefined,
  } as unknown as LoomBackend;
  const graph = flatDocument(sounding!.graph as GraphDocument);
  const plan = planFor(graph);
  const view = renderHook(() => useModelInference(backend));
  act(() => view.result.current.track(graph, plan));
  await settleRefresh();
  const release = await view.result.current.prepareForRender();
  const depthId = Object.keys(graph.nodes).find(id => graph.nodes[id]!.type === "depth")!;
  expect(gates.gates.get(preprocessId(plan, depthId))!(inferenceFrame(0))).toBe(true);
  await act(async () => { await view.result.current.settle(0); });
  release();
  expect(workers).toBe(1);
  act(() => view.result.current.track(graph, { ...plan, resources: [], passes: [] }));
  expect(sent.filter(message => message.kind === "forget")).toEqual([]);
  act(() => view.result.current.track(EMPTY_GRAPH, planFor(EMPTY_GRAPH)));
  expect(depthId).toBeDefined();
  expect(sent.filter(message => message.kind === "forget"))
    .toEqual([{ kind: "forget", nodeIds: [depthId] }]);
});

/**
 * T1487b — THE RUN STATE IS PUBLISHED TO THE NODE, THROUGH THE HOOK THE APP MOUNTS.
 *
 * The owner saw "Matte ran and found nothing" flicker in the app-wide strip, pushing the
 * whole layout down and back up. The sentence moved onto the node; this asserts it arrives
 * there from a real document — E44's Depth node, weights "held", no result yet — and that
 * it is cleared when the node leaves the document, so a note cannot outlive its node.
 */
it("T1487b: a held model's run state is published to its node, and cleared when the node goes", async () => {
  const createAcquisition = acquisitionModule.createModelAcquisition;
  vi.spyOn(acquisitionModule, "createModelAcquisition").mockImplementation(options => ({
    ...createAcquisition(options),
    refresh: async descriptor => {
      options.onStateChange?.(descriptor.id, { kind: "ready" });
      return { kind: "ready" };
    },
    acquire: async () => undefined,
  }));
  // A worker that never answers: the model is held and has produced nothing yet.
  vi.stubGlobal("Worker", class {
    postMessage() {}
    addEventListener() {}
    terminate() {}
  });
  const backend = {
    status: { framesSubmitted: 0 },
    readBuffer: async () => new ArrayBuffer(16),
    registerMediaSource: () => () => undefined,
    registerDispatchGate: dispatchGates().registerDispatchGate,
  } as unknown as LoomBackend;
  const published: Array<[string, unknown]> = [];
  const sink = {
    publish: (nodeId: string, patch: Record<string, unknown>) => {
      if ("inferenceNote" in patch) published.push([nodeId, patch["inferenceNote"]]);
    },
  };
  const graph = flatDocument(sounding!.graph as GraphDocument);
  const depthId = Object.keys(graph.nodes).find(id => graph.nodes[id]!.type === "depth")!;
  const frame = { frameIndex: 0, timeSeconds: 0, absTimeSeconds: 0 } as never;
  const view = renderHook(() => useModelInference(backend, sink as never));
  act(() => view.result.current.track(graph, planFor(graph)));
  await settleRefresh();
  act(() => view.result.current.observe(frame));
  expect(published).toHaveLength(1);
  expect(published[0]![0]).toBe(depthId);
  expect(published[0]![1]).toMatchObject({ tone: "info" });
  expect((published[0]![1] as { text: string }).text).toContain("computing its first result");
  // And the strip says nothing about it: the model is held, so there is no decision to make.
  expect(view.result.current.notices).toEqual([]);

  // A second frame in the same state publishes nothing — transitions only, never per frame.
  act(() => view.result.current.observe(frame));
  expect(published).toHaveLength(1);

  act(() => view.result.current.track(EMPTY_GRAPH, planFor(EMPTY_GRAPH)));
  act(() => view.result.current.observe(frame));
  expect(published.at(-1)).toEqual([depthId, null]);
});

describe("T1487b — 'found nothing' has hysteresis, so the node's note does not blink", () => {
  it("holds its state inside the band between the set and clear lines", () => {
    // 0.2% of the frame sits between the two lines. Coming from "claiming something" it is
    // still something; coming from "found nothing" it is still nothing. A single line here
    // is what made the note flip on every result while coverage hovered near it.
    expect(claimsNothingAfter(false, 0.002)).toBe(false);
    expect(claimsNothingAfter(true, 0.002)).toBe(true);
  });

  it("still sets on a truly empty frame and clears on a real subject", () => {
    expect(claimsNothingAfter(false, 0.0001)).toBe(true);
    expect(claimsNothingAfter(true, 0.05)).toBe(false);
    // No coverage reading yet is not a claim of nothing.
    expect(claimsNothingAfter(true, undefined)).toBe(false);
  });
});

/**
 * §T976 — THE PUBLISHER HALF, AT ITS CONSTRUCTION SITE.
 *
 * The seam's own tests assert the NUMBERS at exact values. These assert the thing §V205
 * keeps catching: that the resolver is reachable from a real document through the hook the
 * app actually mounts, and is merged into the composition root's channel resolver.
 * `createInferenceSources` was fully tested and had exactly one construction site — its
 * own GPU test — the last time nobody checked, and that is B25's whole shape.
 */
describe("§T976 — a real document's Depth node publishes its timing channels", () => {
  const frame = { frameIndex: 0, timeSeconds: 0, absTimeSeconds: 0 } as never;
  const askThrough = (view: { result: { current: { resolver: (c: string, ctx: never) => unknown } } }, channel: string) =>
    view.result.current.resolver(channel, { frame } as never);

  it("answers `<nodeName>:ready` for E44's Depth node, tracked from the real graph", async () => {
    const graph = flatDocument(sounding!.graph as GraphDocument);
    const view = renderHook(() => useModelInference(null));
    act(() => {
      view.result.current.track(graph, planFor(graph));
    });
    await settleRefresh();

    // jsdom has no Worker, so no result can ever land here — which is exactly the state
    // the channel has to describe honestly. NOT ready, as a NUMBER: a switch expression
    // reading this must get 0, not an unknown channel that fails the expression.
    expect(askThrough(view, "depth1:ready")).toBe(0);
    expect(askThrough(view, "depth1:lagFrames")).toBe(0);
    expect(askThrough(view, "depth1:fps")).toBe(0);
  });

  it("refuses a channel it does not own, so it can sit in the merge without shadowing", async () => {
    const graph = flatDocument(sounding!.graph as GraphDocument);
    const view = renderHook(() => useModelInference(null));
    act(() => {
      view.result.current.track(graph, planFor(graph));
    });
    await settleRefresh();

    // The three resolvers ahead of it own `midi:`, `osc:` and bare node names. This one
    // must answer for none of those, and for no unknown field either.
    expect(askThrough(view, "midi:cc1")).toBeUndefined();
    expect(askThrough(view, "osc:/x")).toBeUndefined();
    expect(askThrough(view, "depth1")).toBeUndefined();
    expect(askThrough(view, "depth1:whatever")).toBeUndefined();
  });

  it("stops answering for a node the document no longer has", async () => {
    const graph = flatDocument(sounding!.graph as GraphDocument);
    const view = renderHook(() => useModelInference(null));
    act(() => {
      view.result.current.track(graph, planFor(graph));
    });
    await settleRefresh();
    expect(askThrough(view, "depth1:ready")).toBe(0);

    act(() => {
      view.result.current.track(EMPTY_GRAPH, planFor(EMPTY_GRAPH));
    });
    await settleRefresh();
    // A channel that outlived its node would let an expression keep reading a number for
    // something nobody can see — the stale-notice defect one seam over.
    expect(askThrough(view, "depth1:ready")).toBeUndefined();
  });
});

describe("the model notice for a document whose star node has no model", () => {
  it("names what is ON THE SCREEN for E44 Sounding, and warns rather than offers", async () => {
    expect(sounding, "E44 Sounding is missing from the catalogue").toBeDefined();
    const graph = flatDocument(sounding!.graph as GraphDocument);
    const plan = planFor(graph);

    const view = renderHook(() => useModelInference(null));
    act(() => {
      view.result.current.track(graph, plan);
    });
    await settleRefresh();

    const notices = view.result.current.notices;
    // The whole defect in one assertion: a document reduced to its placeholder must
    // produce a row. Before B156 this was reachable only through a ref the memo did not
    // depend on, and nothing anywhere asserted it fired at all.
    expect(notices).toHaveLength(1);
    const notice = notices[0]!;

    // A degraded document is not an optional extra. `info` is what the owner's eye slid
    // past; if this ever goes back to `info` the defect is back.
    expect(notice.tone).toBe("warn");

    // It must describe the PICTURE. "Depth needs Depth Anything V2" was true, and told a
    // person looking at a flat grid nothing about why it was flat.
    expect(notice.message).toContain("Depth has no model");
    expect(notice.message).toContain("flat grey");
    expect(notice.message).not.toMatch(/^Depth needs/);

    // And it must still be actionable: the 94 MB is spent by pressing this and nowhere
    // else (§V721).
    expect(notice.actions?.map((action) => action.label)).toEqual(["Download"]);
    expect(notice.detail).toContain("94 MB");
  });

  it("goes away when the document that needed it is closed", async () => {
    const graph = flatDocument(sounding!.graph as GraphDocument);
    const view = renderHook(() => useModelInference(null));
    act(() => {
      view.result.current.track(graph, planFor(graph));
    });
    await settleRefresh();
    expect(view.result.current.notices).toHaveLength(1);

    // Loading a document with no model node in it. The tracked set is now empty, so the
    // acquisition state does not change — which is precisely why the notices memo used to
    // keep the previous row on screen. A warning about a picture that is no longer open
    // is worse than the quiet offer it replaced.
    act(() => {
      view.result.current.track(EMPTY_GRAPH, planFor(EMPTY_GRAPH));
    });
    await settleRefresh();
    expect(view.result.current.notices).toEqual([]);
  });
});

/**
 * The RUN half. Acquisition answering "ready" says the bytes are on the machine and
 * nothing at all about whether a session started, and both failures render the same flat
 * picture — so before B156 a model that downloaded and could not run was completely
 * silent. `runNote` is exercised directly here because these states are reached
 * through a live worker, an ORT session and a 94 MB file, none of which belong in a gate.
 */
describe("a model that is held but does not run", () => {
  const target = {
    nodeId: "depth",
    kind: {
      nodeType: "depth",
      label: "Depth",
      neutralPicture: "flat grey — no relief at all, so anything reading it stays flat",
    },
    descriptor: { id: "depth-accurate", label: "Depth Anything V2", bytes: 99_060_839 },
    size: [8, 8] as const,
  };
  // The shapes above are the parts of `DepthTarget` these functions read; a fixture
  // carrying a real 94 MB descriptor would prove less, not more.
  const note = (run: unknown) => runNote(target as never, run as never);

  it("says so on the node, with the reason, instead of publishing grey in silence", () => {
    const said = note({ kind: "failed", reason: "no ExecutionProvider bound for depth-accurate" });
    expect(said?.tone).toBe("error");
    // T965: THE REASON IS THE HEADLINE — the grey picture already says it did not run, so
    // the only information is the reason, and it leads.
    expect(said?.text).toContain("no ExecutionProvider bound for depth-accurate");
    expect(said?.text).toContain("Depth");
  });

  it("distinguishes 'still computing the first one' from 'failed'", () => {
    const said = note({ kind: "waiting" });
    expect(said?.tone).toBe("info");
    expect(said?.text).toContain("computing its first result");
    // §V852: the picture rides in the SAME sentence.
    expect(said?.text).toContain("flat grey");
  });

  it("says NOTHING once results are landing", () => {
    // A permanent line about a thing that is working is noise (§V537).
    expect(note({ kind: "running", claimsNothing: false })).toBeNull();
  });

  it("never puts the run state in the app-wide strip (T1487b)", () => {
    // The owner: a strip row that came and went with the camera pushed the whole layout
    // around, and it was a fact about one node. Acquisition — a decision with a button —
    // is the only thing the strip still carries for a model.
    const ready = { "depth-accurate": { kind: "ready" } } as const;
    expect(buildNotices([target] as never, ready as never, { acquire: () => undefined, cancel: () => {} })).toEqual([]);
    const absent = { "depth-accurate": { kind: "absent" } } as const;
    expect(buildNotices([target] as never, absent as never, { acquire: () => undefined, cancel: () => {} })).toHaveLength(1);
  });
});

/**
 * §V288 — THE FOURTH STATE, and the one that was silent.
 *
 * The rule above ("a healthy model is the absence of a line plus a picture that moves") is
 * right for depth and WRONG for a matte: a correct matte of a frame with nobody in it is
 * zero everywhere, does not move, and is pixel-for-pixel identical to no-model,
 * no-result-yet and failed-run. The owner read a working matte as broken twice in one day,
 * and nothing on screen could have told them otherwise.
 *
 * These assert the SENTENCE for the state that had none, and that it disappears the moment
 * the matte claims something. Since T1487b the sentence is on the node, not in the strip.
 */
describe("a matte that runs and finds nothing", () => {
  const target = {
    nodeId: "cut",
    channel: "cut1",
    kind: {
      nodeType: "matte",
      label: "Matte",
      neutralPicture: "zero everywhere — nobody is here",
      coverage: () => 0,
    },
    descriptor: { id: "modnet-photographic", label: "MODNet", bytes: 25_888_640 },
    size: [8, 8] as const,
  };
  const note = (run: unknown) => runNote(target as never, run as never);

  it("says the model ran and returned nothing, rather than leaving black unexplained", () => {
    const said = note({ kind: "running", claimsNothing: true });
    expect(said?.tone).toBe("info");
    // The two facts the black picture cannot carry: that it RAN, and that the emptiness is
    // the answer rather than a failure.
    expect(said?.text).toContain("ran");
    expect(said?.text).toContain("found nothing");
  });

  it("goes away the moment the matte claims something", () => {
    // ⚠ The half that keeps this a refinement and not a permanent line.
    expect(note({ kind: "running", claimsNothing: false })).toBeNull();
  });
});

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * A REPLACED BACKEND GETS THE INFERENCE RESULT REGISTERED ON IT (T1044)
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The owner's matte was intermittent across one page: nothing, nothing, a clean silhouette
 * after a refresh, then nothing again — same document, same weights, same machine. A stale
 * build is stable, so intermittence on one page is a lifecycle fault, and this is the one
 * in this file.
 *
 * `track` remembers its media-source registrations in a map keyed by SOURCE ID ALONE and
 * skips any id already in it. The id does not change when the BACKEND does, so a second
 * backend never receives the `infer:` registration the first one got — and an external
 * texture with no registered source is never uploaded (`uploadExternalTextures` skips it),
 * which renders as a matte of zero everywhere. That is pixel-for-pixel the no-model
 * picture, the no-result picture and the empty-room picture, so nothing anywhere says it
 * happened: `ready` is 1, the coverage channel reports a real number, the node info popup
 * reports a backend and a millisecond figure, and the picture is black.
 *
 * `use-media-sources.ts` cannot have this bug because its whole open-and-register effect
 * is keyed on `[backend, ...]` and tears down with it. This seam registers from a callback
 * and observes backend identity nowhere, and that asymmetry is the defect.
 *
 * WHEN A BACKEND IS REPLACED, in a build the owner is actually running: `sharedGpuProbe`
 * memoises the device in a MODULE-level variable, so a Vite HMR update that replaces
 * `gpu-status.ts` — or any module it re-exports through — resets that memo and the next
 * render gets a new backend object. The owner watches a live dev page while several
 * sessions commit, which makes this a routine event rather than an exotic one.
 *
 * Asserted as WHAT THE SECOND BACKEND WAS TOLD, not as the shape of the map: the consumer
 * of this seam is the backend's media registry, and what it needs is a source it can pull
 * frames from.
 */
describe("T1044 — the inference result is registered on whichever backend is live", () => {
  function matteGraph(): GraphDocument {
    return {
      revision: 1,
      nodes: {
        src: { id: "src", type: "noise", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "src" },
        cut: { id: "cut", type: "matte", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "cut1" },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "out" },
      },
      edges: {
        e1: { id: "e1", source: { nodeId: "src", portId: "out" }, target: { nodeId: "cut", portId: "input" } },
        e2: { id: "e2", source: { nodeId: "cut", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
      groups: {},
    } as never;
  }

  /** Records what it was asked to serve. Only the two methods this seam ever calls. */
  function recordingBackend() {
    const registered: string[] = [];
    const gateRegistry = dispatchGates();
    return {
      registered,
      gateRegistry,
      backend: {
        status: { framesSubmitted: 0 },
        registerDispatchGate: gateRegistry.registerDispatchGate,
        registerMediaSource: (sourceId: string) => {
          registered.push(sourceId);
          return () => {};
        },
        readBuffer: () => Promise.reject(new Error("not asked for in this test")),
      } as never,
    };
  }

  it("registers `infer:cut` on a second backend that replaced the first", async () => {
    const graph = matteGraph();
    const plan = planFor(graph);
    const first = recordingBackend();
    const second = recordingBackend();

    let live = first.backend;
    const view = renderHook(() => useModelInference(live));
    act(() => {
      view.result.current.track(flatDocument(graph), plan);
    });
    await settleRefresh();
    // The premise: backend one really did get it, so a failure below is the SWAP and not
    // a graph that never tracked anything.
    expect(first.registered, "the first backend was never given the matte's result source").toContain(
      "infer:cut",
    );
    expect(first.gateRegistry.gates.has(preprocessId(plan, "cut"))).toBe(true);
    expect(first.gateRegistry.gates.get(preprocessId(plan, "cut"))!(inferenceFrame(0))).toBe(false);

    // The device is replaced and the document recompiles against it — the ordering an HMR
    // update or a rebuilt device produces.
    live = second.backend;
    view.rerender();
    act(() => {
      view.result.current.track(flatDocument(graph), planFor(graph));
    });
    await settleRefresh();

    expect(
      second.registered,
      "the live backend has no source for the matte's result texture, so it will never be " +
        "uploaded and the node renders zero everywhere while reporting itself healthy",
    ).toContain("infer:cut");
    expect(first.gateRegistry.gates.size).toBe(0);
    expect(second.gateRegistry.gates.has(preprocessId(plan, "cut"))).toBe(true);
    view.unmount();
    expect(second.gateRegistry.gates.size).toBe(0);
  });
});

it("an offline lease prepares each export input and releases to the live rate gate idempotently", async () => {
  const createAcquisition = acquisitionModule.createModelAcquisition;
  vi.spyOn(acquisitionModule, "createModelAcquisition").mockImplementation(options => ({
    ...createAcquisition(options),
    refresh: async descriptor => {
      options.onStateChange?.(descriptor.id, { kind: "ready" });
      return { kind: "ready" };
    },
    acquire: async () => undefined,
  }));
  vi.stubGlobal("Worker", class { postMessage() {} addEventListener() {} terminate() {} });
  const gates = dispatchGates();
  const readBuffer = vi.fn(async () => new ArrayBuffer(16));
  const backend = {
    status: { framesSubmitted: 0 },
    readBuffer, registerDispatchGate: gates.registerDispatchGate, registerMediaSource: () => () => undefined,
  } as unknown as LoomBackend;
  const graph = flatDocument(structuredClone(sounding!.graph) as GraphDocument);
  const depthId = Object.keys(graph.nodes).find(id => graph.nodes[id]!.type === "depth")!;
  graph.nodes[depthId]!.parameters["rateLimit"] = 2;
  const plan = planFor(graph);
  const view = renderHook(() => useModelInference(backend));
  act(() => view.result.current.track(graph, plan));
  const gate = gates.gates.get(preprocessId(plan, depthId))!;
  await settleRefresh();
  const live = inferenceFrame(0);
  expect(gate(live)).toBe(true);
  await act(async () => { view.result.current.observe(live); await settleRefresh(); });
  expect(readBuffer).toHaveBeenCalledOnce();
  expect(gate(inferenceFrame(1))).toBe(false);

  const release = await view.result.current.prepareForRender();
  for (let index = 1; index <= 2; index++) {
    const current = inferenceFrame(index);
    expect(gate(current)).toBe(true); // Export still uses the live transport's mode.
    await act(async () => { view.result.current.observe(current); await settleRefresh(); });
    expect(readBuffer).toHaveBeenCalledTimes(index);
    await act(async () => { await view.result.current.settle(index); });
    expect(readBuffer).toHaveBeenCalledTimes(index + 1);
  }
  release(); release();
  expect(gate(inferenceFrame(3))).toBe(false);
  view.unmount();
  expect(gates.gates.size).toBe(0);
});

it.each(["depth", "pose", "matte"])("%s skips unsubmitted input and preserves captured timing and source extent through retracking", async type => {
  const createAcquisition = acquisitionModule.createModelAcquisition;
  vi.spyOn(acquisitionModule, "createModelAcquisition").mockImplementation(options => ({
    ...createAcquisition(options),
    refresh: async descriptor => {
      options.onStateChange?.(descriptor.id, { kind: "ready" });
      return { kind: "ready" };
    },
    acquire: async () => new ArrayBuffer(16),
  }));
  const requests: Array<Extract<InferenceRequest, { kind: "run" }>> = [];
  vi.stubGlobal("Worker", class {
    listener: ((event: { data: InferenceResponse }) => void) | undefined;
    addEventListener(kind: string, listener: (event: { data: InferenceResponse }) => void) {
      if (kind === "message") this.listener = listener;
    }
    postMessage(request: InferenceRequest) {
      if (request.kind === "forget") return;
      if (request.kind === "run") requests.push(request);
      const response: InferenceResponse = request.kind === "load"
        ? { kind: "loaded", sessionKey: request.sessionKey, backend: "stub", millis: 1, isolated: true }
        : { kind: "result", requestId: request.requestId, bytes: new ArrayBuffer(16), backend: "stub", millis: 1, isolated: true };
      queueMicrotask(() => this.listener?.({ data: response }));
    }
    terminate() {}
  });
  const nodeId = "component/inner#model:opaque";
  const graph: GraphDocument = {
    revision: 1, groups: {},
    nodes: {
      src: { id: "src", type: "solid", definitionVersion: 1, parameters: {}, position: { x: 0, y: 0 } },
      [nodeId]: { id: nodeId, type, definitionVersion: 1, parameters: {}, position: { x: 250, y: 0 }, label: "model1" },
      out: { id: "out", type: "output", definitionVersion: 1, parameters: {}, position: { x: 500, y: 0 } },
    },
    edges: {
      a: { id: "a", source: { nodeId: "src", portId: "out" }, target: { nodeId, portId: "input" } },
      b: { id: "b", source: { nodeId, portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
  };
  const plan = planFor(graph);
  expect(plan.ok).toBe(true);
  const gates = dispatchGates();
  const readBuffer = vi.fn(async () => new ArrayBuffer(16));
  const status = { framesSubmitted: 0 };
  const backend = {
    status,
    readBuffer, registerDispatchGate: gates.registerDispatchGate, registerMediaSource: () => () => undefined,
  } as unknown as LoomBackend;
  const view = renderHook(() => useModelInference(backend));
  act(() => view.result.current.track(flatDocument(graph), plan));
  await settleRefresh();
  const gate = gates.gates.get(preprocessId(plan, nodeId));
  expect(gate).toBeTypeOf("function");
  if (gate === undefined) throw new Error("Compiled preprocess has no consumer gate");
  const frame = inferenceFrame(0);
  const callback = gates.callbacks.get(preprocessId(plan, nodeId));
  if (callback === undefined) throw new Error("Compiled preprocess has no provenance callback");
  expect(callback(frame, { renderIndex: 1, source: undefined })).toBe(false);
  await act(async () => { view.result.current.observe(frame); await view.result.current.settle(0); });
  expect(readBuffer).not.toHaveBeenCalled();
  expect(requests).toEqual([]);
  expect(view.result.current.resolver("model1:ready", { frame } as never)).toBe(0);
  expect(view.result.current.resolver("model1:cacheFrames", { frame } as never)).toBe(0);
  expect(gate(frame)).toBe(true);
  status.framesSubmitted = 1;
  await act(async () => { view.result.current.observe(frame); await view.result.current.settle(0); });
  expect(readBuffer).toHaveBeenCalledOnce();
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ nodeId, nodeType: type, sourceWidth: 1280, sourceHeight: 720 });
  if (type === "pose") expect(requests[0]).toMatchObject({ width: 17, height: 1 });
  // Uniform-only tracking retains the gate; the next real compiled dispatch still starts.
  act(() => view.result.current.track(flatDocument({ ...graph, revision: 2 }), planFor(graph)));
  expect(gates.registerDispatchGate).toHaveBeenCalledOnce();
  const next = inferenceFrame(60);
  // The live open-frame dispatch sees render1's pixels, even though the project
  // skipped to frame60. The compensation must count stored renders, not frame labels.
  expect(callback(next, { renderIndex: 2,
    source: { renderIndex: 1, frameIndex: 0, timeSeconds: 0 },
  })).toBe(true);
  status.framesSubmitted = 2;
  await act(async () => { view.result.current.observe(next); await view.result.current.settle(60); });
  expect(readBuffer).toHaveBeenCalledTimes(2);
  expect(view.result.current.resolver("model1:ready", { frame: next } as never)).toBe(1);
  expect(view.result.current.resolver("model1:lagFrames", { frame: next } as never)).toBe(60);
  expect(view.result.current.resolver("model1:cacheFrames", { frame: next } as never)).toBe(2);
  expect(view.result.current.resolver("model1:delaySeconds", { frame: next } as never)).toBe(1);
  view.unmount();
  expect(gates.gates.size).toBe(0);
});

it("T1816b: the sizes readout names the node's own box and the share of it the picture fills", async () => {
  const { inferenceShapeOf } = await import("./use-model-inference.ts");
  const settings = { inputSide: 640, inputBox: { width: 672, height: 384 } } as never;
  // 1920×1080 into 672×384: 1.778 against 1.75 — full width, 98.4 % of the height.
  const wide = inferenceShapeOf({ settings, sourceSize: [1920, 1080], size: [1920, 1080] });
  expect(wide.box).toEqual([672, 384]);
  expect(wide.fill).toBeCloseTo(1.75 / (16 / 9), 12);
  // The same picture in a square Input Size box (Depth Anything at 266): 56 %.
  const square = inferenceShapeOf({ settings: { inputSide: 266 } as never, sourceSize: [1920, 1080], size: [960, 540] });
  expect(square).toEqual({ picture: [1920, 1080], box: [266, 266], fill: 1080 / 1920, output: [960, 540] });
});

/**
 * T1816b — THE NODE'S FIELD OF VIEW REACHES THE WORKER, through the hook the app mounts.
 *
 * Depth Pro 2 turns Field of View into its focal-length input. The value is read here
 * and then handed to the worker runner, and that handoff dropped it: every live Depth
 * Pro 2 node ran at the worker's 60° default whatever the node said. So this drives E44's
 * real Depth node, switched to Depth Pro 2 at 90°, down to the run request the worker gets.
 */
it("T1816b: a Depth Pro 2 node's Field of View is in the run request its worker receives", async () => {
  const createAcquisition = acquisitionModule.createModelAcquisition;
  vi.spyOn(acquisitionModule, "createModelAcquisition").mockImplementation(options => ({
    ...createAcquisition(options),
    refresh: async descriptor => {
      options.onStateChange?.(descriptor.id, { kind: "ready" });
      return { kind: "ready" };
    },
    // Stand-in bytes: the stub worker below never opens a session on them.
    acquire: async () => new ArrayBuffer(8),
  }));
  const sent: InferenceRequest[] = [];
  vi.stubGlobal("Worker", class {
    private listener: ((event: { data: InferenceResponse }) => void) | null = null;
    postMessage(message: InferenceRequest) {
      sent.push(message);
      if (message.kind === "load") {
        queueMicrotask(() => this.listener?.({ data: { kind: "loaded", sessionKey: message.sessionKey,
          backend: "wasm", millis: 1, isolated: true } }));
      }
      // The request is the claim; answer it so the hook's settle has something to wait on.
      if (message.kind === "run") {
        queueMicrotask(() => this.listener?.({ data: { kind: "error", requestId: message.requestId,
          message: "stub worker runs nothing" } }));
      }
    }
    addEventListener(type: string, handler: (event: { data: InferenceResponse }) => void) {
      if (type === "message") this.listener = handler;
    }
    terminate() {}
  });
  const gates = dispatchGates();
  const backend = {
    status: { framesSubmitted: 0 },
    registerDispatchGate: gates.registerDispatchGate,
    readBuffer: async () => new ArrayBuffer(640 * 480 * 16),
    registerMediaSource: () => () => undefined,
  } as unknown as LoomBackend;
  const document = structuredClone(sounding!.graph) as GraphDocument;
  const depthId = Object.keys(document.nodes).find(id => document.nodes[id]!.type === "depth")!;
  const runAt = async (fieldOfView: number | undefined) => {
    sent.length = 0;
    const node = document.nodes[depthId]!;
    const { fieldOfView: _previous, ...rest } = node.parameters;
    void _previous;
    node.parameters = { ...rest, model: "depthpro2-s-fp32", ...(fieldOfView === undefined ? {} : { fieldOfView }) };
    const graph = flatDocument(document);
    const plan = planFor(graph);
    const view = renderHook(() => useModelInference(backend));
    act(() => view.result.current.track(graph, plan));
    await settleRefresh();
    const release = await view.result.current.prepareForRender();
    expect(gates.gates.get(preprocessId(plan, depthId))!(inferenceFrame(0))).toBe(true);
    await act(async () => { await view.result.current.settle(0); });
    release();
    view.unmount();
    const run = sent.find((message): message is Extract<InferenceRequest, { kind: "run" }> => message.kind === "run");
    expect(run?.modelId).toBe("depthpro2-s-fp32");
    return run?.fieldOfView;
  };
  expect(await runAt(90)).toBe(90);
  // A fresh node carries the definition's default, not the worker's fallback.
  expect(await runAt(undefined)).toBe(60);
});

/**
 * T1818b — A CORE ML DEPTH NODE, THROUGH THE HOOK THE APP MOUNTS.
 *
 * E44's real Depth node switched to Depth Pro 2 S on Core ML. In a browser it must never
 * start the worker or fetch a byte, and its notice must say it runs in the desktop app —
 * not that a download failed. In the desktop app nothing downloads until the person presses
 * Download, and then the session that opens is this node's model, function and box.
 */
it("T1818b: a Core ML Depth node says 'desktop app' in a browser, and in the app downloads on consent, then opens its session", async () => {
  const createAcquisition = acquisitionModule.createModelAcquisition;
  vi.spyOn(acquisitionModule, "createModelAcquisition").mockImplementation(options => ({
    ...createAcquisition(options),
    refresh: async descriptor => { options.onStateChange?.(descriptor.id, { kind: "ready" }); return { kind: "ready" }; },
    acquire: async () => undefined,
  }));
  let workers = 0;
  vi.stubGlobal("Worker", class { constructor() { workers++; } postMessage() {} addEventListener() {} terminate() {} });
  const fetches = vi.fn();
  vi.stubGlobal("fetch", fetches);
  const gates = dispatchGates();
  const backend = {
    status: { framesSubmitted: 0 },
    registerDispatchGate: gates.registerDispatchGate,
    readBuffer: async () => new ArrayBuffer(16),
    registerMediaSource: () => () => undefined,
    present: () => ({ dispose() {}, describe: () => ({ presentedFrames: 0 }) }),
  } as unknown as LoomBackend;
  const document = structuredClone(sounding!.graph) as GraphDocument;
  const depthId = Object.keys(document.nodes).find(id => document.nodes[id]!.type === "depth")!;
  document.nodes[depthId]!.parameters = { ...document.nodes[depthId]!.parameters, model: "depthpro2-s-coreml", modelInput: "640x360" };
  const graph = flatDocument(document);
  const plan = planFor(graph);

  // A browser: no desktop app behind the page.
  const browser = renderHook(() => useModelInference(backend));
  act(() => browser.result.current.track(graph, plan));
  await settleRefresh();
  const said = browser.result.current.notices.find(notice => notice.id === "model-host-depthpro2-s-coreml");
  expect(said?.message).toMatch(/only in the Loom desktop app/);
  expect(said?.detail).toBe(DEPTH_COREML_UNAVAILABLE);
  expect(said?.actions).toEqual([]);
  expect(browser.result.current.notices.some(notice => /could not be downloaded/.test(notice.message))).toBe(false);
  // The worker's path starts at the preprocess gate; a Core ML node has none.
  expect(gates.gates.has(preprocessId(plan, depthId))).toBe(false);
  browser.unmount();

  // The desktop app: the service answers, nothing is cached yet.
  let finish!: () => void;
  const depth = {
    probe: vi.fn(async () => ({ available: true, models: [{ id: "depthpro2-s-coreml", bytes: 52_953_390, cached: false }] })),
    prepare: vi.fn(() => new Promise<void>(resolve => { finish = resolve; })),
    open: vi.fn(async (name: string) => name), close: vi.fn(async () => {}),
    status: vi.fn(async () => ({ frames: 0, busy: false, error: null })), reset: vi.fn(async () => {}),
  };
  vi.stubGlobal("window", Object.assign(window, { loomDesktop: { depth } }));
  const sessions = vi.mocked(nativeInference.createNativeVisionSource);
  sessions.mockImplementation((_backend, bridge, options) => {
    void bridge.open(`${options.namePrefix}session`, ...options.inputSize, ...options.outputSize, async () => {});
    return { source: { currentFrame: () => undefined }, ready: new Promise(() => {}), available: false,
      run: vi.fn(), close: vi.fn(async () => {}) } as never;
  });
  const app = renderHook(() => useModelInference(backend));
  act(() => app.result.current.track(graph, plan));
  await settleRefresh();
  const consent = app.result.current.notices.find(notice => notice.id === "model-consent-depthpro2-s-coreml");
  expect(consent?.actions?.map(action => action.label)).toEqual(["Download"]);
  expect(depth.prepare).not.toHaveBeenCalled();
  expect(depth.open).not.toHaveBeenCalled();
  await act(async () => { consent!.actions![0]!.onSelect(); await Promise.resolve(); });
  expect(depth.prepare).toHaveBeenCalledWith("depthpro2-s-coreml", expect.any(Function));
  await act(async () => { finish(); await Promise.resolve(); await Promise.resolve(); });
  const [width, height] = plan.outputs.find(output => output.nodeId === depthId)!.size;
  expect(depth.open).toHaveBeenCalledWith("loom-native-depth-session", "depthpro2-s-coreml", "res_640x360", 640, 360, width, height, expect.any(Function));
  expect(workers).toBe(0);
  expect(fetches).not.toHaveBeenCalled();
  expect(gates.gates.has(preprocessId(plan, depthId))).toBe(false);
  app.unmount();
  delete (window as { loomDesktop?: unknown }).loomDesktop;
});
