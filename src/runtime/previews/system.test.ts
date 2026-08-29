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
    source: { resourceId: `target/${id}`, size: [1280, 720], format: "rgba16float" },
    rect: { x: 10, y: 10, width: 192, height: 108 },
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

  it("empties the program when nothing is left to preview", () => {
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 4 });
    run(system, [request("a")], 1);
    run(system, [], 1, { startIndex: 1 });
    expect(host.programs[host.programs.length - 1]?.passes).toEqual([]);
    expect(host.programs[host.programs.length - 1]?.resources).toEqual([]);
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
