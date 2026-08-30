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

  it("a huge preview area sharpens WITHIN the budget, never past the boost cap (T490)", () => {
    // The old contract capped everyone at 2× previewLongEdge; the owner resizes nodes to
    // inspect. A lone huge preview may now take what the pixel pool affords — here a
    // 4-tile pool grants 576, one rung up — and a pool large enough grants up to the
    // stated boost ceiling, never beyond it.
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
    // 2000 CSS × dpr2 asks 4000; the honest ceiling is 6 × previewLongEdge = 1152 (V328).
    expect(roomy.active[0]?.tileSize[0]).toBe(1152);
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
