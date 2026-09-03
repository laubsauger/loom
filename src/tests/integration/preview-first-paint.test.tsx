// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendCapabilities } from "@domain/types/backend.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { NodeId } from "@domain/types/ids.ts";
import { createNodeRuntimeStore } from "@editor/graph-canvas/index.ts";
import { createPreviewSlotBounds } from "@editor/viewer/index.ts";
import type { BackendStatus, LoomBackend } from "@runtime/backend/index.ts";
import { createAppRuntime } from "../../app/app-runtime.ts";
import type { AppRuntime } from "../../app/app-runtime.ts";
import { createPreviewSinkStore } from "../../app/preview-sinks.ts";
import { useGraphCompile } from "../../app/use-graph-compile.ts";
import { useNodePreviews } from "../../app/use-node-previews.ts";

/**
 * T501 — FIRST PAINT, and T502 — THE BOOST REACHES THE PICTURE.
 *
 * Both live here because both are properties of the COMPOSITION, not of any one part:
 * the preview scheduler, the sink store and the compiler each behaved exactly as their
 * own suites said, and the defect was in what they add up to.
 *
 * ## T501 — what was measured
 *
 * 44 texture nodes + 8 point generators, every one on screen, every one inside the
 * 48-tile budget. Before the fix, on 60 ticks:
 *
 *     textures painted 44/44 on tick 2
 *     point generators painted 4/8 on tick 2 — and the other 4 NEVER
 *
 * Never, not late, and deterministically the same four: the sink set is capped at the
 * tile capacity, previews that were ALREADY drawing filled it, and the previews still
 * waiting to materialize were served with the leftover — which is zero from tick 2
 * onwards. Point (and camera/light/material) previews take all of that damage because a
 * synthesized preview does not EXIST until its sink triggers the synthesis, so the idle
 * queue is the only door it has, while a texture node walks through once and never
 * returns to it.
 *
 * The fix is §V454's shape: first paint is RESERVED out of the same pool, before the
 * drawing set spends the rest. It is bounded so a burst cannot evict the screen, and it
 * is self-cancelling — materializing retires the claim, after which the scheduler's
 * stated policy decides. `suspended` is an answer; black-and-silent was not.
 *
 * ## T502 — what was measured
 *
 * A point preview's tile DID take the budgeted ladder step (T490 works). Its SOURCE — the
 * target the compiler synthesizes for the splat — was pinned at `previewLongEdge` = 192,
 * BELOW the 384 px base tile every preview is guaranteed, so it was an upscale before
 * anyone zoomed and a 6× one after. Readback settled that the content scales with the
 * target (24 lit texels at 192, 853 at 1152 — the same fraction of area), so a bigger
 * target is real detail rather than a bigger blur.
 *
 * The source is now the base tile. It is deliberately NOT the granted step: see the
 * second describe below, and §V142.
 */

const CAPABILITIES: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  limits: { maxTextureDimension2D: 8192 },
  timestampQuery: false,
};

function fakeBackend(): LoomBackend {
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
  } as unknown as LoomBackend;
}

function newRuntime(): AppRuntime {
  return createAppRuntime({
    identityStorage: null,
    actor: { kind: "human", id: "tester", label: "Tester" },
  });
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

interface View {
  zoom: number;
  /** Graph-space pan, so a node can be scrolled off the surface without moving it. */
  x: number;
}

/**
 * The app's real composition: `useGraphCompile` feeding `useNodePreviews` through the
 * real `PreviewSinkStore`, on the real registry. Only the GPU is a stub — nothing below
 * `setPreviewProgram` is what either defect lives in.
 */
async function mount(operations: GraphPatchOperation[], view: View = { zoom: 1, x: 0 }) {
  const runtime = newRuntime();
  let created: Record<string, string> = {};
  await act(async () => {
    const result = await runtime.bus.execute(
      "graph.applyPatch",
      { baseRevision: runtime.bus.store.getRevision(), label: "seed", operations },
      runtime.invocation,
    );
    expect(result.status).toBe("applied");
    created = (result.output as { createdIds: Record<string, string> }).createdIds;
  });

  const previewSinks = createPreviewSinkStore();
  // Flush the classification channel on every publish: a per-FRAME measurement cannot
  // afford the store's 10 Hz coalescing (§V16), which would otherwise cost ~9 frames per
  // observation and hide the very latency being measured.
  const nodeRuntime = createNodeRuntimeStore({ intervalMs: 0 });
  const bounds = createPreviewSlotBounds();
  const positions = new Map<string, { x: number; y: number }>();
  const graph = runtime.bus.store.getGraph();
  let index = 0;
  for (const nodeId of Object.keys(graph.nodes)) {
    bounds.publish(nodeId, { x: 0, y: 0, width: 120, height: 90 });
    positions.set(nodeId, { x: (index % 9) * 130, y: Math.floor(index / 9) * 100 });
    index += 1;
  }

  const canvas = document.createElement("canvas");
  canvas.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: 1200, bottom: 900, width: 1200, height: 900 }) as DOMRect;
  const canvasRef = { current: canvas };

  const hook = renderHook(() => {
    const compile = useGraphCompile(runtime, CAPABILITIES, previewSinks);
    useNodePreviews({
      previewSinks,
      backend: fakeBackend(),
      canvasRef,
      bounds,
      graph: compile.graph,
      registry: runtime.registry,
      compiledOutputs: compile.compiled?.outputs ?? [],
      nodeRuntime,
      getViewport: () => ({ x: view.x, y: 0, zoom: view.zoom }),
      getNodePosition: (nodeId: NodeId) => positions.get(nodeId),
      getNodeBoxes: () => [],
      previewFps: 20,
      previewLongEdge: 192,
      documentIdentity: "document-under-test",
    });
    return compile;
  });

  /** One DISPLAY FRAME. The unit both defects are measured in. */
  const tick = async (count: number): Promise<void> => {
    for (let i = 0; i < count; i += 1) {
      await act(async () => {
        vi.advanceTimersToNextFrame();
      });
    }
  };

  /** Every synthesized preview source in the current plan, by node, in device px. */
  const synthesized = (): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const output of hook.result.current.compiled?.outputs ?? []) {
      if (!output.resourceId.startsWith("preview:")) continue;
      out[output.nodeId] = output.size[0];
    }
    return out;
  };

  return { runtime, created, nodeRuntime, hook, previewSinks, view, tick, synthesized };
}

/** How many ticks each node took to report `live`, or null if it never did. */
async function firstPaint(
  created: Record<string, string>,
  nodeRuntime: ReturnType<typeof createNodeRuntimeStore>,
  tick: (count: number) => Promise<void>,
  ticks: number,
): Promise<Map<string, number | null>> {
  const seen = new Map<string, number | null>();
  for (const ref of Object.keys(created)) seen.set(ref, null);
  for (let index = 1; index <= ticks; index += 1) {
    await tick(1);
    for (const [ref, nodeId] of Object.entries(created)) {
      if (seen.get(ref) !== null) continue;
      if (nodeRuntime.get(nodeId).preview?.state.kind === "live") seen.set(ref, index);
    }
  }
  return seen;
}

describe("T501 — every visible preview gets a first paint", () => {
  /**
   * THE REGRESSION, at its exact geometry. 52 previews, 48 tiles: the four that must go
   * without are chosen by the scheduler's stated policy, and every one of the 52 has
   * MATERIALIZED — none is left black with nothing to say.
   *
   * SENSITIVITY: set `FIRST_PAINT_RESERVE` to 0 in `use-node-previews.ts` and this goes
   * red at 4/8 point generators painted and 4 never painting at all.
   */
  it("44 texture nodes and 8 point generators: all 52 paint, none is starved", async () => {
    const operations: GraphPatchOperation[] = [];
    for (let i = 0; i < 44; i += 1) {
      operations.push({ op: "addNode", ref: `$s${i}`, type: "solid", position: { x: 0, y: 0 } });
    }
    for (let i = 0; i < 8; i += 1) {
      operations.push({ op: "addNode", ref: `$p${i}`, type: "pointGenerator", position: { x: 0, y: 0 } });
    }
    const { created, nodeRuntime, tick, synthesized } = await mount(operations);
    const paint = await firstPaint(created, nodeRuntime, tick, 30);

    const points = Object.keys(created).filter((ref) => ref.startsWith("$p"));
    const textures = Object.keys(created).filter((ref) => ref.startsWith("$s"));
    expect(points).toHaveLength(8);
    expect(textures).toHaveLength(44);

    // EXACT DISPLAY FRAMES, not "eventually". Frame 1 registers the sinks it can, the
    // recompile materializes them, frame 2 draws and frame 3 is where the classification
    // is observable. Forty-eight land there; the four the first tick had no room for
    // land on frame 4 — ONE frame later, because the reservation is what they wait for
    // rather than a leftover that never comes.
    const frames = [...paint.values()];
    expect(frames.filter((at) => at === 3)).toHaveLength(48);
    expect(frames.filter((at) => at === 4)).toHaveLength(4);
    expect(frames.filter((at) => at === null)).toHaveLength(0);
    // No preview kind is behind any other: every point generator is inside the same bound.
    for (const ref of points) expect([ref, (paint.get(ref) ?? 99) <= 4]).toEqual([ref, true]);
    for (const ref of textures) expect([ref, (paint.get(ref) ?? 99) <= 4]).toEqual([ref, true]);

    // And every point generator's splat target actually exists in the plan.
    expect(Object.keys(synthesized())).toHaveLength(8);
  }, 60_000);

  /**
   * The other half of "some never show": a preview that cannot draw must SAY so, and it
   * must be chosen by the STATED rule.
   *
   * 52 previews, 48 tiles — four have to go without. They are suspended for `budget` (a
   * state the node body renders), they are TEXTURE nodes picked by the scheduler's own
   * largest-on-screen-then-key order, and the picture is stable across 200 frames. What
   * decides who waits is the published policy, not which door a preview came in through.
   */
  it("who goes without is decided by the scheduler's policy, and it holds for 200 frames", async () => {
    const operations: GraphPatchOperation[] = [];
    for (let i = 0; i < 44; i += 1) {
      operations.push({ op: "addNode", ref: `$s${i}`, type: "solid", position: { x: 0, y: 0 } });
    }
    for (let i = 0; i < 8; i += 1) {
      operations.push({ op: "addNode", ref: `$p${i}`, type: "pointGenerator", position: { x: 0, y: 0 } });
    }
    const { created, nodeRuntime, tick } = await mount(operations);
    const census = () => {
      const counts: Record<string, number> = {};
      for (const nodeId of Object.values(created)) {
        const state = nodeRuntime.get(nodeId).preview?.state;
        const kind = state === undefined ? "none" : state.kind === "suspended" ? `suspended:${state.reason}` : state.kind;
        counts[kind] = (counts[kind] ?? 0) + 1;
      }
      return counts;
    };
    await tick(20);
    expect(census()).toEqual({ live: 48, "suspended:budget": 4 });
    // Not a transient: no oscillation between materialized and pruned, and no preview
    // sliding back into `idle` when the sink store's removal grace expires.
    await tick(180);
    expect(census()).toEqual({ live: 48, "suspended:budget": 4 });
    // Every point generator is among the 48. The budget is paid by the previews the
    // stated order puts last, which here are texture nodes.
    for (const ref of Object.keys(created).filter((entry) => entry.startsWith("$p"))) {
      const nodeId = created[ref] ?? "";
      expect([ref, nodeRuntime.get(nodeId).preview?.state.kind]).toEqual([ref, "live"]);
    }
  }, 60_000);
});

describe("T502 — the boost does not reach a synthesized preview, and §V142 is why", () => {
  /**
   * §V437's shape retired: ONE rule reaches a pointset splat and a scene payload alike,
   * because both read `previewTargetEdge` in the compiler and neither knows the other
   * exists. `preview-resolution.test.ts` is the gate that keeps kind N+1 covered.
   *
   * And the rule is CAMERA-FREE, which this pins. Zooming to 4× and 8× moves the tile up
   * the ladder (that is T490, and it still works) and does not move the plan at all. It
   * must not: a sink set that carried zoom would recompile on a ladder crossing, and the
   * reallocated target is not redrawn while the transport is paused — MEASURED in the
   * running app on E16 as a point preview that goes black and stays black until playback
   * resumes, because the splat pass lives in the main plan and the preview program does
   * not. §V142's "a camera move must not recompile" is that failure, stated in advance.
   */
  it("the synthesized source is the base tile at every zoom, for every preview kind", async () => {
    const view: View = { zoom: 1, x: 0 };
    const { created, tick, synthesized } = await mount(
      [
        { op: "addNode", ref: "$points", type: "pointGenerator", position: { x: 0, y: 0 } },
        { op: "addNode", ref: "$camera", type: "camera", position: { x: 0, y: 0 } },
      ],
      view,
    );
    const points = created["$points"] ?? "";
    const camera = created["$camera"] ?? "";
    const base = { [points]: 384, [camera]: 384 };

    await tick(4);
    // 384, not 192: a synthesized preview is no longer an upscale of its own base tile.
    expect(synthesized()).toEqual(base);

    for (const zoom of [4, 8, 0.5]) {
      view.zoom = zoom;
      await tick(6);
      expect([zoom, synthesized()]).toEqual([zoom, base]);
    }
  }, 60_000);

  /**
   * §V455, audited on the axis T501 changes.
   *
   * The first-paint reservation changes what ACTIVE previews get — it can push the tail of
   * the drawing set out of the sink set for a tick — so what a SUSPENDED preview reports
   * has to be checked, which is the whole of §V455. A preview panned off screen must keep
   * reporting `suspended` with its plan resource intact, not fall back to `idle` and have
   * its target reallocated on the way out and again on the way back (B13's shape).
   */
  it("a preview panned off screen keeps its materialized source while suspended", async () => {
    const view: View = { zoom: 1, x: 0 };
    const { created, nodeRuntime, tick, synthesized } = await mount(
      [{ op: "addNode", ref: "$points", type: "pointGenerator", position: { x: 0, y: 0 } }],
      view,
    );
    const points = created["$points"] ?? "";
    await tick(6);
    expect(synthesized()).toEqual({ [points]: 384 });

    view.x = -100_000;
    await tick(10);
    expect(nodeRuntime.get(points).preview?.state.kind).toBe("suspended");
    expect(synthesized()).toEqual({ [points]: 384 });

    view.x = 0;
    await tick(6);
    expect(nodeRuntime.get(points).preview?.state.kind).toBe("live");
    expect(synthesized()).toEqual({ [points]: 384 });
  }, 60_000);
});
