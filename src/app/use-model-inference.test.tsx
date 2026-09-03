// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import { compileGraph } from "@compiler/index.ts";
import type { CompiledGraph } from "@compiler/index.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import { EXAMPLE_DOCUMENTS } from "@/examples/documents.ts";
import { TIER_B_CAPABILITIES, exampleRegistry } from "@/examples/runner.ts";
import { buildNotices, useModelInference } from "./use-model-inference.ts";

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

/** A document with nothing inferential in it — E44 with the graph emptied. */
const EMPTY_GRAPH: GraphDocument = { revision: 1, nodes: {}, edges: {}, groups: {} };

/** `refresh` reads the (absent) store on a microtask; let it land. */
async function settleRefresh(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  cleanup();
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
    const graph = sounding!.graph as GraphDocument;
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
    const graph = sounding!.graph as GraphDocument;
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
    const graph = sounding!.graph as GraphDocument;
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
    const graph = sounding!.graph as GraphDocument;
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
    const graph = sounding!.graph as GraphDocument;
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
 * silent. `buildNotices` is exercised directly here because these states are reached
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
  const acquisition = { acquire: () => undefined, cancel: () => {} };
  const ready = { "depth-accurate": { kind: "ready" } } as const;
  const notices = (health: Record<string, unknown>) =>
    // The shapes above are the parts of `DepthTarget` this function reads; a fixture
    // carrying a real 94 MB descriptor would prove less, not more.
    buildNotices(
      [target] as never,
      ready as never,
      acquisition,
      health as never,
    );

  it("says so, with the reason, instead of publishing grey in silence", () => {
    const list = notices({
      depth: { kind: "failed", reason: "no ExecutionProvider bound for depth-accurate" },
    });
    expect(list).toHaveLength(1);
    expect(list[0]!.tone).toBe("error");
    // T965: THE REASON IS THE HEADLINE. It used to be the detail, under a banner
    // announcing that the inference did not run — which the grey picture had already
    // said. The only line carrying information was the demoted one, so it is promoted,
    // and this asserts the promotion rather than merely that the reason appears
    // somewhere: a test that accepted it in either slot would go green on the copy that
    // buried it.
    expect(list[0]!.message).toContain("no ExecutionProvider bound for depth-accurate");
    expect(list[0]!.message).toContain("Depth");
    // And the detail says what is on screen instead, in a FRAGMENT — no "the document
    // still renders" clause, which tells someone looking at a rendered document that it
    // renders (§V852 later cut this from a sentence to three words).
    expect(list[0]!.detail).toContain("flat grey");
    expect(list[0]!.detail).not.toContain("still renders");
  });

  it("distinguishes 'still computing the first one' from 'failed'", () => {
    const list = notices({ depth: { kind: "waiting" } });
    expect(list).toHaveLength(1);
    expect(list[0]!.tone).toBe("info");
    expect(list[0]!.message).toContain("computing its first result");
    // §V852: the picture rides in the SAME sentence, and the rate no longer rides at all —
    // it changes every frame, so it belongs on the node info popup, not in an alert.
    expect(list[0]!.message).toContain("flat grey");
    expect(list[0]!.detail).toBeUndefined();
  });

  it("says NOTHING once results are landing", () => {
    // A permanent row about a thing that is working is noise (§V537), and the rate belongs
    // on the telemetry channel at <= 10 Hz (§V16) rather than in a strip. A healthy model
    // is read as the absence of a row plus a picture that moves.
    expect(notices({ depth: { kind: "running", claimsNothing: false } })).toEqual([]);
  });
});

/**
 * §V288 — THE FOURTH STATE, and the one that was silent.
 *
 * The rule above ("a healthy model is the absence of a row plus a picture that moves") is
 * right for depth and WRONG for a matte: a correct matte of a frame with nobody in it is
 * zero everywhere, does not move, and is pixel-for-pixel identical to no-model,
 * no-result-yet and failed-run. The owner read a working matte as broken twice in one day,
 * and nothing on screen could have told them otherwise.
 *
 * These assert the SENTENCE for the state that had none, and — the half that makes it a
 * refinement rather than a new banner — that it disappears the moment the matte claims
 * something. A row that stayed up while the feature worked would just be §V537 again.
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
  const notices = (health: Record<string, unknown>) =>
    buildNotices(
      [target] as never,
      { "modnet-photographic": { kind: "ready" } } as never,
      { acquire: () => undefined, cancel: () => {} },
      health as never,
    );

  it("says the model ran and returned nothing, rather than leaving black unexplained", () => {
    const list = notices({ cut: { kind: "running", claimsNothing: true } });
    expect(list).toHaveLength(1);
    expect(list[0]!.tone).toBe("info");
    // The two facts the black picture cannot carry: that it RAN, and that the emptiness is
    // the answer rather than a failure. Asserting both, because a row that only said
    // "empty" would read as one more way of saying the thing is broken.
    expect(list[0]!.message).toContain("ran");
    expect(list[0]!.message).toContain("found nothing");
    // §V852: and it points at what to do next in the same breath, with no second sentence.
    // The measured readouts it would otherwise cite live on the node info popup and on
    // `<name>:coverage`, which is where someone goes when this line is not enough.
    expect(list[0]!.detail).toBeUndefined();
  });

  it("goes away the moment the matte claims something", () => {
    // ⚠ The half that keeps this a refinement and not a permanent banner. If this ever
    // fires on a working matte it is noise on the one screen that must stay readable.
    expect(notices({ cut: { kind: "running", claimsNothing: false } })).toEqual([]);
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
    return {
      registered,
      backend: {
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
      view.result.current.track(graph, plan);
    });
    await settleRefresh();
    // The premise: backend one really did get it, so a failure below is the SWAP and not
    // a graph that never tracked anything.
    expect(first.registered, "the first backend was never given the matte's result source").toContain(
      "infer:cut",
    );

    // The device is replaced and the document recompiles against it — the ordering an HMR
    // update or a rebuilt device produces.
    live = second.backend;
    view.rerender();
    act(() => {
      view.result.current.track(graph, planFor(graph));
    });
    await settleRefresh();

    expect(
      second.registered,
      "the live backend has no source for the matte's result texture, so it will never be " +
        "uploaded and the node renders zero everywhere while reporting itself healthy",
    ).toContain("infer:cut");
  });
});
