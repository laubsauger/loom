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
    // And the detail says what is on screen instead, in one line — no "the document
    // still renders" clause, which tells someone looking at a rendered document that it
    // renders.
    expect(list[0]!.detail).toContain("flat grey");
    expect(list[0]!.detail).not.toContain("still renders");
  });

  it("distinguishes 'still computing the first one' from 'failed'", () => {
    const list = notices({ depth: { kind: "waiting" } });
    expect(list).toHaveLength(1);
    expect(list[0]!.tone).toBe("info");
    expect(list[0]!.message).toContain("computing its first result");
    // §T754 is a standing owner action about the observed update interval, so the moment
    // the model starts working is where the app points at the number.
    expect(list[0]!.detail).toContain("frames behind");
  });

  it("says NOTHING once results are landing", () => {
    // A permanent row about a thing that is working is noise (§V537), and the rate belongs
    // on the telemetry channel at <= 10 Hz (§V16) rather than in a strip. A healthy model
    // is read as the absence of a row plus a picture that moves.
    expect(notices({ depth: { kind: "running" } })).toEqual([]);
  });
});
