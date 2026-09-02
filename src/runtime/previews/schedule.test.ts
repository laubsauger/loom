import { describe, expect, it } from "vitest";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import { createPreviewScheduler } from "./schedule.ts";
import type { ScheduleInput } from "./schedule.ts";
import { DEFAULT_PREVIEW_VIEW, previewKey } from "./types.ts";
import type { PreviewRequest, PreviewSchedule, SuspendReason } from "./types.ts";

const SURFACE = { x: 0, y: 0, width: 800, height: 600 };

function frame(timeSeconds: number, frameIndex = 0): FrameEvaluationInput {
  return { timeSeconds, deltaSeconds: 1 / 60, frameIndex, mode: "realtime", randomSeed: 1 };
}

function input(timeSeconds: number, overrides: Partial<ScheduleInput> = {}): ScheduleInput {
  return {
    frame: frame(timeSeconds),
    surface: SURFACE,
    devicePixelRatio: 2,
    previewFps: 15,
    previewLongEdge: 192,
    ...overrides,
  };
}

function request(id: string, overrides: Partial<PreviewRequest> = {}): PreviewRequest {
  return {
    ref: { nodeId: id, portId: "out" },
    source: { resourceId: `target/${id}`, size: [1280, 720], format: "rgba16float", space: "linear" },
    rect: { x: 10, y: 10, width: 192, height: 108 },
    area: { width: 192, height: 108 },
    visible: true,
    pinned: false,
    collapsed: false,
    occluded: false,
    view: DEFAULT_PREVIEW_VIEW,
    ...overrides,
  };
}

function reasons(schedule: PreviewSchedule): Record<string, SuspendReason> {
  return Object.fromEntries(
    schedule.suspended.map((entry) => [previewKey(entry.ref), entry.reason]),
  );
}

function activeKeys(schedule: PreviewSchedule): string[] {
  return schedule.active.map((entry) => previewKey(entry.ref));
}

describe("§V28 — only visible or pinned previews are scheduled", () => {
  it("schedules a visible preview and suspends every other kind with a stated reason", () => {
    const scheduler = createPreviewScheduler({ capacity: 16 });
    const schedule = scheduler.select(
      [
        request("visible"),
        request("hidden", { visible: false }),
        request("collapsed", { collapsed: true }),
        request("occluded", { occluded: true }),
        request("offscreen", { rect: { x: 4000, y: 4000, width: 192, height: 108 } }),
        request("tiny", { rect: { x: 10, y: 10, width: 12, height: 7 } }),
      ],
      input(0),
    );

    expect(activeKeys(schedule)).toEqual(["visible:out"]);
    expect(reasons(schedule)).toEqual({
      "hidden:out": "not-visible",
      "collapsed:out": "collapsed",
      "occluded:out": "occluded",
      "offscreen:out": "offscreen",
      "tiny:out": "too-small",
    });
  });

  it("keeps a pinned preview alive when it is scrolled off-screen or hidden", () => {
    // This is the whole point of pinning: the user asked for it to stay warm while they work
    // somewhere else in the graph. Without it, "pinned" would be a synonym for "visible".
    const scheduler = createPreviewScheduler({ capacity: 16 });
    const schedule = scheduler.select(
      [
        request("pinned-offscreen", {
          pinned: true,
          visible: false,
          rect: { x: 4000, y: 4000, width: 192, height: 108 },
        }),
        request("pinned-occluded", { pinned: true, occluded: true }),
      ],
      input(0),
    );
    expect(activeKeys(schedule).sort()).toEqual(["pinned-occluded:out", "pinned-offscreen:out"]);
    expect(schedule.suspended).toEqual([]);
  });

  it("still suspends a pinned preview on a collapsed node", () => {
    // A collapsed node has no preview area to composite into. The large viewer does not rely
    // on the node slot — it submits its own request — so this cannot blank the viewer pane.
    const scheduler = createPreviewScheduler({ capacity: 16 });
    const schedule = scheduler.select([request("n", { pinned: true, collapsed: true })], input(0));
    expect(activeKeys(schedule)).toEqual([]);
    expect(reasons(schedule)).toEqual({ "n:out": "collapsed" });
  });
});

describe("tile budget", () => {
  it("suspends the surplus when more previews are visible than tiles exist", () => {
    const scheduler = createPreviewScheduler({ capacity: 2 });
    const schedule = scheduler.select(
      [request("a"), request("b"), request("c"), request("d")],
      input(0),
    );
    expect(schedule.active).toHaveLength(2);
    expect(schedule.suspended).toHaveLength(2);
    expect(schedule.suspended.every((entry) => entry.reason === "budget")).toBe(true);
  });

  it("spends the budget on pinned previews first, then on the largest on screen", () => {
    const scheduler = createPreviewScheduler({ capacity: 2 });
    const schedule = scheduler.select(
      [
        request("small", { rect: { x: 0, y: 0, width: 40, height: 30 } }),
        request("large", { rect: { x: 0, y: 0, width: 300, height: 200 } }),
        request("pinned", { pinned: true, rect: { x: 0, y: 0, width: 40, height: 30 } }),
      ],
      input(0),
    );
    expect(activeKeys(schedule)).toEqual(["pinned:out", "large:out"]);
    expect(reasons(schedule)).toEqual({ "small:out": "budget" });
  });

  it("orders identically-sized previews by key, so the kept set cannot flicker", () => {
    // Without a total order the survivors depend on iteration order and previews blink in and
    // out between frames for no reason a user can see.
    const scheduler = createPreviewScheduler({ capacity: 2 });
    const forward = scheduler.select([request("b"), request("a"), request("c")], input(0));
    scheduler.reset();
    const reversed = scheduler.select([request("c"), request("b"), request("a")], input(0));
    expect(activeKeys(forward)).toEqual(["a:out", "b:out"]);
    expect(activeKeys(reversed)).toEqual(activeKeys(forward));
  });

  it("gives up the tile budget the moment a preview is suspended", () => {
    const scheduler = createPreviewScheduler({ capacity: 1 });
    const first = scheduler.select([request("a"), request("b")], input(0));
    expect(activeKeys(first)).toEqual(["a:out"]);
    const second = scheduler.select(
      [request("a", { visible: false }), request("b")],
      input(0.001),
    );
    expect(activeKeys(second)).toEqual(["b:out"]);
  });
});

describe("refresh rate", () => {
  it("refreshes at previewFps, not at the frame rate", () => {
    const scheduler = createPreviewScheduler({ capacity: 4 });
    const requests = [request("a")];
    // 60 display frames per second, 15 fps previews: due on roughly every fourth frame.
    let due = 0;
    for (let index = 0; index < 60; index += 1) {
      const schedule = scheduler.select(requests, input(index / 60));
      if (schedule.active[0]?.due === true) due += 1;
    }
    expect(due).toBe(15);
  });

  it("honours a per-preview rate independently of the project default", () => {
    const scheduler = createPreviewScheduler({ capacity: 4 });
    const requests = [request("slow", { fps: 5 }), request("fast", { fps: 30 })];
    const counts = { slow: 0, fast: 0 };
    for (let index = 0; index < 60; index += 1) {
      const schedule = scheduler.select(requests, input(index / 60));
      for (const entry of schedule.active) {
        if (entry.due) {
          if (entry.ref.nodeId === "slow") counts.slow += 1;
          else counts.fast += 1;
        }
      }
    }
    expect(counts).toEqual({ slow: 5, fast: 30 });
  });

  it("renders immediately after a clock rebase rather than stalling", () => {
    // T100 rebases f32 time; treating a backwards jump as "not due" would freeze every preview
    // until the clock caught up again.
    const scheduler = createPreviewScheduler({ capacity: 4 });
    const requests = [request("a")];
    scheduler.select(requests, input(1000));
    const rebased = scheduler.select(requests, input(0));
    expect(rebased.active[0]?.due).toBe(true);
  });

  it("re-renders on the first frame after a suspended preview comes back", () => {
    const scheduler = createPreviewScheduler({ capacity: 4 });
    const requests = [request("a")];
    scheduler.select(requests, input(0));
    scheduler.select([request("a", { visible: false })], input(0.01));
    const returned = scheduler.select(requests, input(0.02));
    expect(returned.active[0]?.due).toBe(true);
  });
});

describe("tile sizing", () => {
  it("scales with device pixel ratio and snaps to the ladder", () => {
    const scheduler = createPreviewScheduler({ capacity: 4 });
    const at1 = scheduler.select([request("a")], input(0, { devicePixelRatio: 1 }));
    scheduler.reset();
    const at2 = scheduler.select([request("a")], input(0, { devicePixelRatio: 2 }));
    expect(at1.active[0]?.tileSize[0]).toBe(192);
    // 192 CSS px * dpr 2 = 384, which is the cap AND a ladder step.
    expect(at2.active[0]?.tileSize[0]).toBe(384);
  });

  it("a huge preview area sharpens WITHIN the budget, never past what the pool affords (T891)", () => {
    // The old contract capped everyone at 2× previewLongEdge; the owner resizes nodes to
    // inspect. A lone huge preview may now take what the pixel pool affords — here a
    // 4-tile pool grants 576, one rung up.
    const scheduler = createPreviewScheduler({ capacity: 4 });
    const schedule = scheduler.select(
      [request("a", { area: { width: 480, height: 270 } })],
      input(0, { devicePixelRatio: 2 }),
    );
    expect(schedule.active[0]?.tileSize[0]).toBe(576);
    const wide = createPreviewScheduler({ capacity: 48 });
    const roomy = wide.select(
      [request("a", { area: { width: 2000, height: 1100 } })],
      input(0, { devicePixelRatio: 2 }),
    );
    // T891: 2000 CSS × dpr2 asks 4000 and the SUM is what says no. A 48-tile pool holds
    // 48 × 384² = 7 077 888 long-edge squares, so one preview alone on screen can afford
    // a 2660-px edge — 2592 on the ladder. The number that used to answer here was 1152,
    // and it was a PER-NODE cap (6 × previewLongEdge) that said no with five sixths of
    // the pool unspent, which is the whole of §T891.
    expect(roomy.active[0]?.tileSize[0]).toBe(2592);
    expect(2592 * 2592).toBeLessThanOrEqual(48 * 384 * 384);
  });

  it("forty on screen: everyone gets the guaranteed base, nobody is suspended for sharpness (T490)", () => {
    const scheduler = createPreviewScheduler({ capacity: 48 });
    const zoomedIn = Array.from({ length: 40 }, (_unused, index) =>
      request(`node-${index}`, {
        rect: { x: (index % 8) * 60, y: Math.floor(index / 8) * 60, width: 480, height: 270 },
      }),
    );
    const schedule = scheduler.select(zoomedIn, input(0, { devicePixelRatio: 2 }));
    expect(schedule.active).toHaveLength(40);
    // The pool cannot give forty previews 960-px asks; each falls back a rung at a time
    // and the tail lands on the base — but every one keeps a tile.
    const sizes = schedule.active.map((entry) => entry.tileSize[0]);
    expect(Math.min(...sizes)).toBe(384);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(1152);
    // The pool holds absolutely: bases are reserved, boosts spend only the headroom.
    const spent = sizes.reduce((sum, size) => sum + size * size, 0);
    expect(spent).toBeLessThanOrEqual(48 * 384 * 384);
  });

  it("zoomed OUT the camera cannot resize a tile; zoomed IN it may, quantised (§V142, T490)", () => {
    // B13's rule survives where it mattered: at or below 1:1 the node-area floor rules and
    // the camera reallocates nothing. Above it, T490's budget lets the on-screen ask buy a
    // LADDER STEP — the amendment the owner requested, still never a per-tick size.
    const scheduler = createPreviewScheduler({ capacity: 16 });
    const at = (zoom: number) => {
      scheduler.reset();
      const schedule = scheduler.select(
        [
          request("a", {
            rect: { x: 120 * zoom, y: 40 * zoom, width: 192 * zoom, height: 108 * zoom },
          }),
        ],
        input(0, { devicePixelRatio: 2 }),
      );
      return schedule.active[0]?.tileSize.join("x") ?? "";
    };
    expect(new Set([0.25, 0.4, 0.75, 1].map(at)).size).toBe(1);
    const zoomedIn = [1.6, 2.5].map(at);
    expect(new Set(zoomedIn).size).toBe(2);
    for (const size of zoomedIn) expect(Number(size.split("x")[0])).toBeGreaterThan(384);
  });

  it("keeps the source aspect ratio", () => {
    const scheduler = createPreviewScheduler({ capacity: 4 });
    const schedule = scheduler.select(
      [request("tall", { source: { resourceId: "t", size: [512, 1024], format: "rgba8unorm", space: "linear" } })],
      input(0, { devicePixelRatio: 1 }),
    );
    expect(schedule.active[0]?.tileSize).toEqual([96, 192]);
  });
});

/**
 * T891 — THE ZOOMED-IN PICTURE, AND WHAT IT IS ALLOWED TO COST.
 *
 * The owner, with a screenshot: *preview for points nodes is still very low res even when
 * we zoom in*. A POINTS node is the sharpest case in the catalogue because its preview is
 * SYNTHESIZED — the compiler nominates a size and the preview program renders the splat at
 * the GRANTED TILE (T563/§V521), so the tile IS the content resolution. A texture node has
 * its own output to fall back on; a points node has exactly what the scheduler gave it.
 *
 * The three properties below are the ones that can regress independently, so they are
 * gated independently: zoom BUYS pixels, the SUM stays inside the pool, and neither of
 * those is allowed to reallocate on a per-frame basis (B13, §V142).
 */
describe("T891 — zoom buys resolution, the SUM is what says no", () => {
  const SLOT = { width: 192, height: 108 };
  /** A points node: synthesized source, one node-body slot, drawn at `zoom`. */
  function points(id: string, zoom: number, at = { x: 20, y: 20 }): PreviewRequest {
    return request(id, {
      source: {
        resourceId: `preview/points/${id}`,
        size: [384, 216],
        format: "rgba8unorm",
        space: "linear",
      },
      area: SLOT,
      rect: {
        x: at.x,
        y: at.y,
        width: SLOT.width * zoom,
        height: SLOT.height * zoom,
      },
      synthesis: { passes: [], depth: false },
    });
  }
  const longEdges = (schedule: PreviewSchedule): number[] =>
    [...schedule.active, ...schedule.suspended].map((entry) => Math.max(...entry.tileSize));

  it("(a) a zoomed points preview renders from MORE device pixels than an unzoomed one", () => {
    // The bug as the owner sees it. At rest the tile is the slot at dpr — 192 × 2 = 384,
    // exactly 1:1, no upscale. Zoomed to 8× the slot covers 1536 CSS px and the splat must
    // be rendered from more than 384 texels or the picture is a 4× magnification of a
    // thumbnail. Exact values, because "bigger" would pass on one rung of improvement.
    const scheduler = createPreviewScheduler({ capacity: 48 });
    const rest = scheduler.select([points("gen", 1)], input(0, { devicePixelRatio: 2 }));
    expect(rest.active[0]?.tileSize).toEqual([384, 216]);
    scheduler.reset();
    const zoomed = scheduler.select([points("gen", 8)], input(0, { devicePixelRatio: 2 }));
    // 1536 CSS × dpr 2 asks 3072; the pool affords 2592 (see the ceiling test above).
    expect(zoomed.active[0]?.tileSize).toEqual([2592, 1458]);
    // The point of the row, as a ratio: 45× the texels, not 1×.
    expect((2592 * 1458) / (384 * 216)).toBeCloseTo(45.56, 2);
  });

  it("(b) the SUM of every allocated tile stays inside the pool at every zoom", () => {
    // The budget is the cost ceiling and it is a TOTAL, so it has to hold while the camera
    // moves — including for the tiles suspended previews are still HOLDING, which is where
    // a boost would otherwise accumulate: pan across a zoomed graph and every node visited
    // would leave a 27 MB tile behind. A holder is charged the area it holds ABOVE its own
    // base and surrenders it to whatever is on screen (§V455 keeps the tile; it does not
    // promise the boost is free).
    const capacity = 48;
    const budget = capacity * 384 * 384;
    const scheduler = createPreviewScheduler({ capacity });
    const nodes = Array.from({ length: 12 }, (_unused, index) => `n${index}`);
    /**
     * Two numbers per frame, because the pool guarantees two different things.
     *
     * `boost` is what the budget RATIONS: every kept preview's grant, plus the area a
     * suspended preview is holding ABOVE its own base. That is the one the allocator
     * enforces exactly, and it is what stops a boost accumulating across a pan.
     *
     * `total` is every tile that physically exists. It can exceed the pool by the bases
     * of the previews that are only HOLDING — §V455's deliberate cost, one base per
     * slot — so its honest bound is TWO pools, and stating it is what keeps the holder
     * set from quietly becoming the expensive half.
     */
    const measure = (schedule: PreviewSchedule): { boost: number; total: number } => {
      let boost = 0;
      let total = 0;
      for (const entry of [...schedule.active, ...schedule.suspended]) {
        const edge = Math.max(...entry.tileSize);
        const base = Math.min(Math.max(entry.request.area.width, entry.request.area.height) * 2, 384);
        const kept = schedule.active.some((other) => previewKey(other.ref) === previewKey(entry.ref));
        boost += kept ? edge * edge : Math.max(0, edge * edge - base * base);
        total += edge * edge;
      }
      return { boost, total };
    };
    let worst = 0;
    for (const zoom of [1, 1.5, 2, 3, 4, 6, 8, 6, 4, 2, 1]) {
      // Zooming in walks nodes off the surface: only the first stays under the camera.
      const requests = nodes.map((id, index) =>
        points(id, zoom, { x: 20 + index * 300 * zoom, y: 20 }),
      );
      const { boost, total } = measure(scheduler.select(requests, input(0, { devicePixelRatio: 2 })));
      worst = Math.max(worst, boost);
      expect(boost).toBeLessThanOrEqual(budget);
      expect(total).toBeLessThanOrEqual(2 * budget);
    }
    // And the budget is actually being SPENT, or "within budget" would be trivially true
    // of a scheduler that granted everyone 64 px.
    expect(worst).toBeGreaterThan(budget / 2);

    // THE ACCUMULATION CASE, which is what the holder charge exists for: pan across a
    // zoomed-in graph, stopping on each node in turn. Every node visited is boosted and
    // then left behind holding its tile, so without the charge the pool would carry one
    // deep boost per node visited — twelve 2592² tiles, 322 MB of them.
    for (let index = 0; index < nodes.length; index += 1) {
      const requests = nodes.map((id, other) =>
        points(id, 8, { x: 20 + (other - index) * 300 * 8, y: 20 }),
      );
      const { boost, total } = measure(scheduler.select(requests, input(0, { devicePixelRatio: 2 })));
      expect(boost).toBeLessThanOrEqual(budget);
      expect(total).toBeLessThanOrEqual(2 * budget);
    }
  });

  it("(c) B13 — a zoom sweep reallocates on RUNG CROSSINGS, never once per frame", () => {
    /*
     * The regression this row is most able to cause, and the one §V142 exists for: a tile
     * sized from the on-screen rect follows the camera CONTINUOUSLY, so every frame of a
     * zoom gesture resizes every tile and the host reinstalls the preview program. B13 is
     * what that looks like from the outside — all previews blinking together while you
     * move the camera.
     *
     * The guard is the ladder plus §V310's hysteresis, and it is stated as a RATE: over a
     * 41-frame sweep from 1× to 8× the sizes may change on at most a handful of frames
     * (the rungs between 384 and 2592 — 576, 864, 1152, 1728, 2592 — is five), and a pure
     * PAN at fixed zoom must change nothing at all.
     */
    const scheduler = createPreviewScheduler({ capacity: 48 });
    const nodes = Array.from({ length: 8 }, (_unused, index) => `n${index}`);
    const frameOf = (zoom: number, pan = 0): number[] =>
      longEdges(
        scheduler.select(
          nodes.map((id, index) => points(id, zoom, { x: 20 + pan + index * 24, y: 20 })),
          input(0, { devicePixelRatio: 2 }),
        ),
      );

    let previous = frameOf(1);
    let framesThatResized = 0;
    for (let step = 1; step <= 40; step += 1) {
      const next = frameOf(1 + (7 * step) / 40);
      if (next.join() !== previous.join()) framesThatResized += 1;
      previous = next;
    }
    // Five rungs above the base are reachable; a continuous resize would be 40.
    expect(framesThatResized).toBeLessThanOrEqual(5);
    expect(framesThatResized).toBeGreaterThan(0);

    // A pan is FREE — the camera translating changes the rect and nothing else (§V142).
    const held = frameOf(8);
    for (const pan of [7, 19, 40, 96]) expect(frameOf(8, pan)).toEqual(held);
  });
});
