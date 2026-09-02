import { describe, expect, it, vi } from "vitest";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import { createPreviewSystem } from "./system.ts";
import { previewPassId } from "./program.ts";
import { DEFAULT_PREVIEW_ORBIT, orbitViewProjection } from "./orbit.ts";
import type { PreviewOrbit } from "./orbit.ts";
import { DEFAULT_PREVIEW_VIEW, previewKey } from "./types.ts";
import type { PreviewFrameCommand, PreviewProgram, PreviewRequest, PreviewRuntimeHost } from "./types.ts";
import { POINTS_PREVIEW_DIAMETER_PX } from "../../nodes/shaders/points-preview.wgsl.ts";

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

  it("pushes lens VALUES on the command when the view changes — the other half of §V5 (B118)", () => {
    // The test above pins "exposure does not rebuild"; this pins that the value still
    // ARRIVES. Alone, the first half shipped a preview whose lens was recomputed every
    // tick and handed to a program object nobody ever uploaded — exposure, channel mask,
    // tonemap, checker size and signed scale had never reached the GPU. Both halves must
    // hold together: remove either and the other still passing is the bug.
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 8 });
    const passId = previewPassId(previewKey({ nodeId: "a", portId: "out" }));
    run(system, [request("a")], 2);
    // The first tick seeds the pushed set once; a steady view then pushes nothing.
    expect(host.commands[0]?.uniforms).toHaveLength(1);
    expect(host.commands[1]?.uniforms).toEqual([]);

    run(system, [request("a", { view: { ...DEFAULT_PREVIEW_VIEW, exposureStops: 3 } })], 2, {
      startIndex: 2,
    });
    expect(host.programs).toHaveLength(1); // still no rebuild —
    const push = host.commands[2]?.uniforms;
    expect(push).toHaveLength(1); // — and the value travels anyway,
    expect(push?.[0]?.passId).toBe(passId);
    expect(push?.[0]?.values["exposure"]).toBe(8); // pow(2, 3 stops), CPU-converted
    // — and forces a refresh THIS tick, so a nudge is visible off-cadence.
    expect(host.commands[2]?.refresh).toContain(passId);
    expect(host.commands[3]?.uniforms).toEqual([]);
  });

  it("pushes the inspection camera onto the synthesis passes — a drag re-renders, never rebuilds (T561)", () => {
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 8 });
    const basis = { eye: [1.7, 1.2, 2.4] as const, lookAt: [0, 0, 0] as const };
    const synthPassId = "a#pointsPreview:out";
    const synthesis = {
      depth: false,
      orbit: { ...basis, passIds: [synthPassId] },
      passes: [
        {
          kind: "draw",
          id: synthPassId,
          shader: "fn x() {}",
          target: "preview:points:a:out",
          topology: "triangle-list",
          instances: 1,
          vertexCount: 3,
          uniformBinding: "params",
          uniforms: { viewProjection: [] },
        },
      ],
    } as never as NonNullable<PreviewRequest["synthesis"]>;
    const synthesized = (orbit?: PreviewOrbit) =>
      request("a", {
        synthesis,
        ...(orbit === undefined ? {} : { orbit }),
        source: { ...request("a").source, resourceId: "preview:points:a:out" },
      });

    run(system, [synthesized()], 2);
    // The first tick pushes the IDENTITY camera once — the baked framing, so an
    // untouched preview shows exactly what the compiler framed — then goes quiet.
    const first = host.commands[0]?.uniforms?.find((update) => update.passId === synthPassId);
    expect(first?.values["viewProjection"]).toEqual(orbitViewProjection(basis, DEFAULT_PREVIEW_ORBIT));
    expect(host.commands[1]?.uniforms).toEqual([]);

    // The drag. A new orbit is a VALUE: new matrix pushed, synth pass refreshed this
    // tick so the gesture is live — and the program never rebuilds (§V5, §V330).
    const orbit = { azimuth: 1, elevation: 0.2, distance: 1, panX: 0, panY: 0 };
    run(system, [synthesized(orbit)], 1, { startIndex: 2 });
    const push = host.commands[2]?.uniforms?.find((update) => update.passId === synthPassId);
    expect(push?.values["viewProjection"]).toEqual(orbitViewProjection(basis, orbit));
    expect(host.commands[2]?.refresh).toContain(synthPassId);
    expect(host.programs).toHaveLength(1);

    // Releasing back to default pushes the baked framing again — a reset is arithmetic,
    // not a second copy of the default camera.
    run(system, [synthesized()], 1, { startIndex: 3 });
    const restored = host.commands[3]?.uniforms?.find((update) => update.passId === synthPassId);
    expect(restored?.values["viewProjection"]).toEqual(orbitViewProjection(basis, DEFAULT_PREVIEW_ORBIT));
  });

  it("gives a synthesized preview the GRANTED TILE's own shape, not a square (T663)", () => {
    /**
     * The last place the squareness lived. `tileSizeFor` has always derived the tile from
     * the source's aspect, and T663 made the compiler nominate a project-shaped source —
     * but `buildPreviewProgram` allocated `[max(w,h), max(w,h))]`, so the picture would
     * have been drawn square and shown wide, which is a stretch and looks like a picture.
     *
     * §V461's distinguishing fixture, and it has to be stated: the source here is 1280x720
     * and the assertion is that the target is NOT square. A square source could not tell
     * "took the tile's shape" from "squared it", which is exactly how this survived.
     */
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 8 });
    const synthesis = {
      depth: false,
      passes: [
        {
          kind: "draw",
          id: "a#pointsPreview:out",
          shader: "fn x() {}",
          target: "preview:points:a:out",
          topology: "triangle-list",
          instances: 1,
          vertexCount: 3,
          uniformBinding: "params",
          uniforms: {},
        },
      ],
    } as never as NonNullable<PreviewRequest["synthesis"]>;

    run(system, [request("a", { synthesis, source: { ...request("a").source, resourceId: "preview:points:a:out" } })], 1);
    const target = host.programs[0]?.resources.find(
      (resource): resource is Extract<typeof resource, { size: readonly [number, number] }> =>
        resource.id === "preview:points:a:out" && "size" in resource,
    );
    // dpr 2 on a 192px area is 384, snapped; the 16:9 source makes the short edge 216.
    expect(target?.size).toEqual([384, 216]);
  });

  /**
   * T952 — the splat's disc is a DEVICE-PIXEL diameter, so the program has to restate it
   * against the tile it just allocated.
   *
   * The compiler emits `pointSize` against its NOMINAL target (§V521: it owns WHAT is
   * drawn, and a pixel is a fact about WHERE), so the value that arrives here is a
   * placeholder. Without the restatement a boosted tile would draw the nominal fraction
   * and the disc would grow with the tile again — which is the whole defect §T952 names.
   *
   * The fixture is deliberately the NON-SQUARE one above, and both halves of the expected
   * pair are load-bearing (§V461):
   *
   *   - that they are DIFFERENT from each other is the roundness claim. One NDC unit is
   *     width/2 texels across and height/2 down, so the scalar this replaced drew an
   *     ELLIPSE — 5.8 x 3.2 texels in a 16:9 tile. Every Dawn gate renders square, so
   *     nothing ever caught it; a square fixture here could not tell a round disc from a
   *     squashed one either.
   *   - that they are 4/384 and 4/216 rather than the incoming placeholder is the
   *     restatement claim.
   *
   * The second pass carries no `pointSize` and must come through untouched: the rewrite
   * is keyed on the uniform being declared, never on a list of pass ids the compiler
   * publishes, so a pass that does not take one is out of scope by construction.
   */
  it("restates the splat's device-pixel disc against the GRANTED tile, and leaves other passes alone (T952)", () => {
    const host = fakeHost();
    const system = createPreviewSystem({ host, capacity: 8 });
    const draw = (id: string, uniforms: Record<string, unknown>) => ({
      kind: "draw",
      id,
      shader: "fn x() {}",
      target: "preview:points:a:out",
      topology: "triangle-list",
      instances: 1,
      vertexCount: 3,
      uniformBinding: "params",
      uniforms,
    });
    const synthesis = {
      depth: false,
      passes: [
        // The compiler's nominal value: square, and derived from a size that is not the
        // tile. Both wrongnesses have to be corrected here.
        draw("a#pointsPreview:out", { viewProjection: [1], pointSize: [0.5, 0.5] }),
        draw("a#backdrop:out", { viewProjection: [1] }),
      ],
    } as never as NonNullable<PreviewRequest["synthesis"]>;

    run(system, [request("a", { synthesis, source: { ...request("a").source, resourceId: "preview:points:a:out" } })], 1);
    const passes = host.programs[0]?.passes ?? [];
    const splat = passes.find((pass) => pass.id === "a#pointsPreview:out");
    const backdrop = passes.find((pass) => pass.id === "a#backdrop:out");

    expect((splat as { uniforms?: Record<string, unknown> } | undefined)?.uniforms).toEqual({
      viewProjection: [1],
      pointSize: [POINTS_PREVIEW_DIAMETER_PX / 384, POINTS_PREVIEW_DIAMETER_PX / 216],
    });
    expect((backdrop as { uniforms?: Record<string, unknown> } | undefined)?.uniforms).toEqual({
      viewProjection: [1],
    });
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
