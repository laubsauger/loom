import { describe, expect, it, vi } from "vitest";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import { createPreviewSystem } from "./system.ts";
import { previewPassId } from "./program.ts";
import { DEFAULT_PREVIEW_VIEW, previewKey } from "./types.ts";
import type { PreviewFrameCommand, PreviewProgram, PreviewRequest, PreviewRuntimeHost } from "./types.ts";

const SURFACE = { x: 0, y: 0, width: 800, height: 600 };

function frame(timeSeconds: number, frameIndex: number): FrameEvaluationInput {
  return { timeSeconds, deltaSeconds: 1 / 60, frameIndex, mode: "realtime", randomSeed: 1 };
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

interface FakeHost extends PreviewRuntimeHost {
  readonly programs: PreviewProgram[];
  readonly commands: PreviewFrameCommand[];
}

function fakeHost(): FakeHost {
  const programs: PreviewProgram[] = [];
  const commands: PreviewFrameCommand[] = [];
  return {
    programs,
    commands,
    setPreviewProgram(program) {
      programs.push(program);
    },
    presentPreviews(command) {
      commands.push(command);
    },
  };
}

function run(
  system: ReturnType<typeof createPreviewSystem>,
  requests: ReadonlyArray<PreviewRequest>,
  frames: number,
  options: { previewFps?: number; startIndex?: number } = {},
): void {
  const start = options.startIndex ?? 0;
  for (let index = start; index < start + frames; index += 1) {
    system.update({
      requests,
      frame: frame(index / 60, index),
      surface: SURFACE,
      devicePixelRatio: 2,
      previewFps: options.previewFps ?? 15,
      previewLongEdge: 192,
    });
  }
}

describe("preview system", () => {
  it("builds the program ONCE for a steady set of previews (§V8)", () => {
    // A program rebuilt per frame is a render-target allocation per frame, which is the single
    // most expensive way to get §V8 wrong.
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 8 });
    run(system, [request("a"), request("b")], 120);
    expect(host.programs).toHaveLength(1);
    expect(host.commands).toHaveLength(120);
  });

  it("does not rebuild the program while the graph pans", () => {
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 8 });
    for (let index = 0; index < 30; index += 1) {
      system.update({
        requests: [request("a", { rect: { x: index * 7, y: 20, width: 192, height: 108 } })],
        frame: frame(index / 60, index),
        surface: SURFACE,
        devicePixelRatio: 2,
        previewFps: 15,
        previewLongEdge: 192,
      });
    }
    expect(host.programs).toHaveLength(1);
    // The tile moves every frame even though it re-renders on a quarter of them.
    const destinations = host.commands.map((command) => command.composite[0]?.dest.x);
    expect(new Set(destinations).size).toBe(30);
  });

  it("zoom rebuilds are QUANTISED to ladder steps with hysteresis, never per tick (§V142, T490)", () => {
    // B13's rule, as T490 amended it: zoom MAY buy a bigger tile now (the owner zooms in
    // to inspect), but only when the ask crosses a ladder step — and a granted step is
    // KEPT until the ask falls a full rung below it, so boundary jitter costs nothing.
    // The host still rebuilds every tile when one changes, which is why this counts
    // programs across a whole sweep instead of forbidding change outright.
    const host = fakeHost();
    // 16 tiles of budget: enough pool for one preview to reach the top rung — the
    // production node-preview capacity is 48; 8 would stop the sweep at 864.
    const system = createPreviewSystem({ host, capacity: 16 });
    const at = (zoom: number) =>
      system.update({
        requests: [
          request("a", {
            rect: { x: 100 * zoom, y: 20 * zoom, width: 192 * zoom, height: 108 * zoom },
          }),
        ],
        frame: frame(0, 0),
        surface: SURFACE,
        devicePixelRatio: 2,
        previewFps: 15,
        previewLongEdge: 192,
      });
    // Zoomed OUT: the node-area floor rules and nothing reallocates, exactly as before.
    for (const zoom of [0.25, 0.4, 0.75, 1]) at(zoom);
    expect(host.programs).toHaveLength(1);
    // Zooming IN crosses three ladder steps (576, 864, 1152) across the whole sweep:
    // three rebuilds, not one per tick — six updates, four programs total.
    for (const zoom of [1.5, 1.6, 2.5, 2.4, 2.5, 2.45]) at(zoom);
    expect(host.programs).toHaveLength(4);
    // Hysteresis on the way back: easing off within a rung keeps the granted step.
    for (const zoom of [2.2, 2.0, 2.2]) at(zoom);
    expect(host.programs).toHaveLength(4);
  });

  it("keeps a tile allocated for a preview that scrolled off screen (§V142)", () => {
    // Suspension is a per-frame decision about GPU work (§V28); it is not a reason to free
    // a tile, because freeing one reinstalls the program and blanks every OTHER preview for
    // a frame. The pool is what bounds this, not visibility.
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 8 });
    run(system, [request("a"), request("b")], 1);

    const scrolled = system.update({
      requests: [request("a"), request("b", { rect: { x: 4000, y: 4000, width: 192, height: 108 } })],
      frame: frame(1 / 60, 1),
      surface: SURFACE,
      devicePixelRatio: 2,
      previewFps: 15,
      previewLongEdge: 192,
    });

    expect(scrolled.schedule.suspended.map((entry) => entry.reason)).toEqual(["offscreen"]);
    // Not drawn — and not reallocated either.
    expect(scrolled.command.composite.map((tile) => tile.ref.nodeId)).toEqual(["a"]);
    expect(host.programs).toHaveLength(1);
  });

  it("gives an on-screen preview a tile ahead of one that is only holding one", () => {
    // The pool is the bound on retention: when it is full, a preview that is actually
    // drawing takes the slot from one that is not.
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 1 });
    run(system, [request("a")], 1);

    const swapped = system.update({
      requests: [request("a", { rect: { x: 4000, y: 4000, width: 192, height: 108 } }), request("b")],
      frame: frame(1 / 60, 1),
      surface: SURFACE,
      devicePixelRatio: 2,
      previewFps: 15,
      previewLongEdge: 192,
    });
    expect(swapped.command.composite.map((tile) => tile.ref.nodeId)).toEqual(["b"]);
    expect(swapped.program.passes).toHaveLength(1);
  });

  it("rebuilds the program when a debug mode changes, and not when exposure does", () => {
    // Mode is a different PROGRAM; exposure is a uniform value, and §V5 keeps values out of the
    // structural key by construction.
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 8 });
    run(system, [request("a")], 1);
    run(system, [request("a", { view: { ...DEFAULT_PREVIEW_VIEW, exposureStops: 3 } })], 1, {
      startIndex: 1,
    });
    expect(host.programs).toHaveLength(1);
    run(system, [request("a", { view: { ...DEFAULT_PREVIEW_VIEW, mode: "nan" } })], 1, {
      startIndex: 2,
    });
    expect(host.programs).toHaveLength(2);
  });

  it("composites every active tile every frame but refreshes only the due ones", () => {
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 8 });
    run(system, [request("a")], 60, { previewFps: 15 });
    const refreshed = host.commands.filter((command) => command.refresh.length > 0).length;
    const composited = host.commands.filter((command) => command.composite.length === 1).length;
    expect(refreshed).toBe(15);
    expect(composited).toBe(60);
  });

  it("names the pass it wants encoded, not the whole plan", () => {
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 8 });
    const result = system.update({
      requests: [request("a")],
      frame: frame(0, 0),
      surface: SURFACE,
      devicePixelRatio: 2,
      previewFps: 15,
      previewLongEdge: 192,
    });
    expect(result.command.refresh).toEqual([previewPassId(previewKey({ nodeId: "a", portId: "out" }))]);
    expect(result.program.passes.map((pass) => pass.id)).toEqual(result.command.refresh);
  });

  it("emits a pass bound to the source resource and the tile target", () => {
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 8 });
    const result = system.update({
      requests: [request("a")],
      frame: frame(0, 0),
      surface: SURFACE,
      devicePixelRatio: 2,
      previewFps: 15,
      previewLongEdge: 192,
    });
    const pass = result.program.passes[0];
    expect(pass?.textures?.[0]?.resourceId).toBe("target/a");
    expect(pass?.target).toBe(result.command.composite[0]?.resourceId);
    expect(result.program.resources.some((resource) => resource.kind === "sampler")).toBe(true);
  });

  it("suspends the surplus and gives it no tile at all", () => {
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 1 });
    const result = system.update({
      requests: [request("a"), request("b")],
      frame: frame(0, 0),
      surface: SURFACE,
      devicePixelRatio: 2,
      previewFps: 15,
      previewLongEdge: 192,
    });
    expect(result.schedule.active).toHaveLength(1);
    expect(result.command.composite).toHaveLength(1);
    expect(result.program.resources.filter((resource) => resource.kind === "target")).toHaveLength(1);
  });

  it("§V28a — an empty request list means NONE, never 'carry on with last frame'", () => {
    // The mistake this guards is specific: treating an empty authoritative sink list as
    // "nothing was said" and leaving the previous tiles live. Empty must free every tile.
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 4 });
    run(system, [request("a"), request("b")], 1);
    expect(host.programs[0]?.passes).toHaveLength(2);

    const emptied = system.update({
      requests: [],
      frame: frame(1 / 60, 1),
      surface: SURFACE,
      devicePixelRatio: 2,
      previewFps: 15,
      previewLongEdge: 192,
    });
    expect(emptied.schedule.active).toEqual([]);
    expect(emptied.command.refresh).toEqual([]);
    expect(emptied.command.composite).toEqual([]);
    expect(host.programs[host.programs.length - 1]?.passes).toEqual([]);
    expect(host.programs[host.programs.length - 1]?.resources).toEqual([]);
  });

  it("§V28a — the request list is the only thing consulted; nothing is unioned in", () => {
    // The scheduler reads `requests` and nothing else. A node whose document `ui.preview` flag
    // is set but which the composition root did not pass simply is not previewing.
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 8 });
    run(system, [request("a"), request("b")], 1);
    const narrowed = system.update({
      requests: [request("b")],
      frame: frame(1 / 60, 1),
      surface: SURFACE,
      devicePixelRatio: 2,
      previewFps: 15,
      previewLongEdge: 192,
    });
    expect(narrowed.schedule.active.map((entry) => entry.ref.nodeId)).toEqual(["b"]);
    expect(narrowed.schedule.suspended).toEqual([]);
  });

  describe("phase split against the real host contract", () => {
    it("plan() is the only phase that hands the host a program", () => {
      // `setPreviewProgram` allocates and the backend asserts it runs outside frame encoding
      // (§V8). `present()` must therefore never reach it, or driving previews from inside
      // backend.loop() would throw the first time a mode changed.
      const host = fakeHost();
      const system = createPreviewSystem({ host, capacity: 4 });
      const planned = system.plan({
        requests: [request("a")],
        frame: frame(0, 0),
        surface: SURFACE,
        devicePixelRatio: 2,
        previewFps: 15,
        previewLongEdge: 192,
      });
      expect(host.programs).toHaveLength(1);
      expect(host.commands).toHaveLength(0);

      system.present(planned.command);
      expect(host.programs).toHaveLength(1);
      expect(host.commands).toEqual([planned.command]);
    });

    it("present() can be replayed inside a frame without touching the program", () => {
      const host = fakeHost();
      const system = createPreviewSystem({ host, capacity: 4 });
      const planned = system.plan({
        requests: [request("a")],
        frame: frame(0, 0),
        surface: SURFACE,
        devicePixelRatio: 2,
        previewFps: 15,
        previewLongEdge: 192,
      });
      system.present(planned.command);
      system.present(planned.command);
      expect(host.programs).toHaveLength(1);
      expect(host.commands).toHaveLength(2);
    });
  });

  it("never asks the host for anything but a program and a frame command (§V7)", () => {
    // Structural, not aspirational: the host interface has no read method, so nothing on this
    // path CAN read pixels back. A future addition would have to change the interface.
    const host = fakeHost();
    const spy = { setPreviewProgram: vi.fn(host.setPreviewProgram), presentPreviews: vi.fn(host.presentPreviews) };
    const system = createPreviewSystem({ host: spy, capacity: 4 });
    run(system, [request("a")], 5);
    expect(Object.keys(spy).sort()).toEqual(["presentPreviews", "setPreviewProgram"]);
    expect(spy.presentPreviews).toHaveBeenCalledTimes(5);
  });
});
