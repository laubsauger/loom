import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import { compileGraph, compiledWithoutCatalogue } from "../../compiler/index.ts";
import { flattenComponents } from "../../compiler/flatten.ts";
import { prepareFrameCompiler, structuralParameterKeys } from "../../compiler/frame-compile.ts";
import { graphChannelResolver } from "../../domain/channels/graph-channels.ts";
import { createComponentSystem } from "../../domain/components/index.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";
import { loadProject } from "../../domain/project/index.ts";
import type { FrameInputs } from "../../domain/types/backend.ts";
import type { FrameEvaluationInput } from "../../domain/types/frame.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";
import { expressionSlot } from "../../examples/documents/builders.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { prepareMesh } from "../../points/mesh.ts";
import { renderPassRuns } from "../../runtime/backend/plan.ts";
import { mockGpuHost } from "../../runtime/backend/vgpu/mock-gpu-host.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { forgetGeneratedText, generatedTextCounts } from "../../runtime/backend/wgsl.ts";
import { createNodeRegistry } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { LAMP_ATTRIBUTES, SCATTERED_LAMPS, lampsScene, mapped, type LampsScene } from "./light-points.fixture.ts";
import { LIGHT_GRID_SLICES, MAX_LIGHT_SLOTS, NAMED_LIGHT_STEP, lightGridDimensions, lightTableStorage } from "./light-records.ts";
import { LIGHT_TABLE_HEADER_WORDS, lightTableRowAt } from "../shaders/scene-lights.wgsl.ts";
import { sceneSurfaceWgsl } from "../shaders/scene-render.wgsl.ts";
import { lightNode } from "./scene.ts";
import { CASTERS_GLB } from "./shadow-casters.fixture.ts";
import { planFingerprint } from "./test-support.ts";

/**
 * T1589b, slice 1 — LIGHTS FROM A POINTSET, at the plan (no GPU).
 *
 * A Light in Points mode is one light at every point of a pointset; a Render culls such
 * lights on the GPU instead of unrolling a block of shader for each. What the pictures look
 * like is `light-points.gpu.test.ts`'s claim, on Dawn, over the same scenes
 * (`light-points.fixture.ts`). Here: what is refused and how it is said, what a lit draw
 * binds, what the device is asked for, and that a frame of driven values builds no text.
 *
 * T1623b slice 3 moved the Render's half: its table is there whatever it lists, a Light in
 * Single mode that does not cast is a row of it too (`light-rows.test.ts`), and each set is
 * gathered by a pass of its own.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 128, height: 128 },
  workingFormat: "rgba16float",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const compile = (graph: GraphDocument) => compileGraph({ graph, settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES });
const errorsOf = (options: LampsScene) => compile(lampsScene(options)).diagnostics.filter((entry) => entry.severity === "error");
const compiled = (options: LampsScene = {}) => {
  const plan = compile(lampsScene(options));
  expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
  return plan;
};
type AnyPass = {
  readonly id: string;
  readonly kind: string;
  readonly shader?: string;
  readonly buffers?: ReadonlyArray<{ readonly binding: string }>;
  readonly uniforms?: Readonly<Record<string, unknown>>;
  /** A `write` pass's rows (the buffer-values seam). */
  readonly values?: { readonly rows: number[]; readonly count: number };
};
const passesOf = (plan: { readonly passes: ReadonlyArray<unknown> }): ReadonlyArray<AnyPass> => plan.passes as unknown as ReadonlyArray<AnyPass>;
/** A pass's id as its node wrote it: the plan puts the node's id and a `#` in front. */
const bare = (id: string): string => id.slice(id.indexOf("#") + 1);
const pass = (plan: { readonly passes: ReadonlyArray<unknown> }, id: string): AnyPass => {
  const found = passesOf(plan).find((entry) => bare(entry.id) === id);
  if (found === undefined) throw new Error(`the plan has no pass "${id}"; it has ${passesOf(plan).map((entry) => bare(entry.id)).join(", ")}`);
  return found;
};

describe("T1589b: a Light in Points mode is rows of the Render's table, not a block of its shaders", () => {
  it("resolves in the Light; writes, gathers and sorts in the Render, ahead of everything that draws the colour", () => {
    const ids = passesOf(compiled()).map((entry) => bare(entry.id));
    const at = (id: string): number => ids.indexOf(id);
    // The kernel that makes the points, then the Light's own pass, then the Render's: its
    // table's values, a gather a set (its named rows' first, T1623b), and the grid.
    expect(at("light_lamps:lights:resolve")).toBeGreaterThan(ids.findIndex((id) => id.startsWith("kernel_lamps")));
    expect(ids.filter((id) => id.includes(":lights:"))).toEqual([
      "light_lamps:lights:resolve",
      "render_shot:lights:header",
      "render_shot:lights:named",
      "render_shot:lights:gather:0",
      "render_shot:lights:gather:1",
      "render_shot:lights:grid",
    ]);
    expect(at("render_shot:backdrop")).toBeGreaterThan(at("render_shot:lights:grid"));
  });

  it("gives the lit draw one buffer and no block, and holds no count in any text: three lamps, three hundred and nine hundred are the same shaders", () => {
    // The same kernel and the same maps at three capacities: two words a cell, eleven, and thirty.
    const plans = [3, 300, 900].map((count) => compiled({ count, kernel: SCATTERED_LAMPS }));
    const [few, many, most] = plans.map((plan) => pass(plan, "render_shot:scene:0"));
    for (const lit of [few, many, most]) {
      expect(lit?.buffers?.map((buffer) => buffer.binding)).toEqual(["positions", "lightTable"]);
      // Not one unrolled block: a casting Light would have put `light0Meta` here.
      expect(String(lit?.shader)).not.toContain("light0Meta");
    }
    // ONE string each, not one a count (T1623b's property): the lit draw, the Light's
    // resolve, the Render's gathers and the grid's build.
    for (const id of ["render_shot:scene:0", "light_lamps:lights:resolve", "render_shot:lights:gather:0", "render_shot:lights:gather:1", "render_shot:lights:grid"]) {
      const texts = plans.map((plan) => String(pass(plan, id).shader));
      expect([id, texts[1] === texts[0], texts[2] === texts[0]]).toEqual([id, true, true]);
    }
    // What a count moves is values: the table's header, which the CPU writes. Its room is
    // the named Lights' step and every slot of the set; its rows are the set's.
    const header = (plan: (typeof plans)[number]): unknown => pass(plan, "render_shot:lights:header").values?.rows;
    const room = (count: number): number => NAMED_LIGHT_STEP + count;
    expect(plans.map(header)).toEqual([
      [room(3), 2, LIGHT_TABLE_HEADER_WORDS + room(3) * 16, 0, 3, 0, 0, 0],
      [room(300), 11, LIGHT_TABLE_HEADER_WORDS + room(300) * 16, 0, 300, 0, 0, 0],
      [room(900), 30, LIGHT_TABLE_HEADER_WORDS + room(900) * 16, 0, 900, 0, 0, 0],
    ]);
  });

  it("sizes the table as a whole number of four-word elements, which is how the lit draw reads it", () => {
    // The lit draw sees the table as `array<vec4u>`: a last element cut short is out of its
    // reach, and the cell words in it would read as another cell's. The Render's own grids
    // have 24 slices and so always fit; a grid that does not is rounded up, never down.
    for (const [slots, grid] of [[33, [3, 3, 1]], [3, [5, 1, 1]], [1000, [16, 9, 24]]] as const) {
      const table = lightTableStorage("render_shot", slots, grid);
      const needed = table.cellsAt + table.cells * table.words;
      expect([slots, table.scratch.capacity % 4, table.scratch.capacity >= needed, table.scratch.capacity - needed < 4]).toEqual([slots, 0, true, true]);
      // The header and every region of rows start on an element too.
      expect([table.cellsAt % 4, lightTableRowAt("cone", slots) % 4]).toEqual([0, 0]);
    }
    expect((LIGHT_TABLE_HEADER_WORDS + 33 * 16 + 9 * 2) % 4).not.toBe(0);
  });

  it("keeps Type a value in Points mode too: a set of suns and a set of lamps are the same shaders, and a driven Type is a write", () => {
    // Type is a field of every row, so changing it compiles nothing (T1623b), in either mode.
    expect(structuralParameterKeys(lightNode, { mode: "points" }).has("kind")).toBe(false);
    expect(structuralParameterKeys(lightNode, { mode: "single" }).has("kind")).toBe(false);
    const lamps = compiled({ light: { kind: "point" } });
    const suns = compiled({ light: { kind: "directional", direction: [0, -1, 0] } });
    expect(passesOf(suns).map((entry) => String(entry.shader))).toEqual(passesOf(lamps).map((entry) => String(entry.shader)));
    // The difference is one float of the resolve's values, and the way the suns travel beside it.
    const shape = (plan: typeof lamps): number[] => pass(plan, "light_lamps:lights:resolve").uniforms?.["shape"] as number[];
    expect([shape(lamps)[2], shape(suns)[2]]).toEqual([1, 0]);
    expect(pass(suns, "light_lamps:lights:resolve").uniforms?.["aim"]).toEqual([0, -1, 0, 0]);
    // So a document that DRIVES Type stays on the values-only frame path.
    const driven = prepareFrameCompiler({ graph: lampsScene({ light: { kind: expressionSlot("0", 0) } }), settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES });
    expect(driven.uniformOnly).toBe(true);
  });

  it("stamps every row with its Light's place in the Render's Lights, a set's rows by its gather and a named Light's by its record", () => {
    const plan = compiled({
      nodes: [
        { id: "light_key", type: "light", parameters: { kind: "point", position: [0, 3, 0] } },
        { id: "light_more", type: "light", parameters: { mode: "points", kind: "point" } },
      ],
      edges: [["kernel_lamps", "light_more", "points"]],
      lights: "light_lamps light_key light_more",
    });
    // x: the row its records start at. y: how many. z: added to each row's source number.
    // The key has no Range: it is the one row that reaches every pixel, ahead of the two sets.
    const source = (index: number): unknown => pass(plan, `render_shot:lights:gather:${index}`).uniforms?.["source"];
    expect([source(0), source(1), source(2)]).toEqual([
      [0, 1, 0, 0],
      [1, 3, 0, 0],
      [4, 3, 2, 0],
    ]);
    // The named row carries its own Light's number, the last float of its record.
    const named = pass(plan, "render_shot:lights:named").values;
    expect([named?.count, named?.rows.length, named?.rows[15]]).toEqual([1, 16, 1]);
  });

  it("runs the lit generator's own light block for a light of the table: one falloff, one lobe", () => {
    // A block as the generator unrolls one where there is no table (a tile's preview does).
    const unrolled = String(sceneSurfaceWgsl({ model: "lambert", lightCount: 1 }));
    const points = String(pass(compiled(), "render_shot:scene:0").shader);
    expect(unrolled).toContain("light0Meta");
    expect(points).not.toContain("light0Meta");
    // The block, from its falloff to its closing brace, with its indentation taken off.
    const blockOf = (text: string): string => {
      const from = text.indexOf("var toLight: vec3f;");
      const to = text.indexOf("lit += albedo.rgb * radiance * lambert;", from);
      expect([from > 0, to > from]).toEqual([true, true]);
      return text.slice(from, to).split("\n").map((line) => line.trim()).join("\n");
    };
    expect(blockOf(points)).toBe(blockOf(unrolled));
  });

  it("makes the grid about 144 tiles as near square as the picture, by 24 slices", () => {
    expect(lightGridDimensions([1280, 720])).toEqual([16, 9, LIGHT_GRID_SLICES]);
    expect(lightGridDimensions([128, 128])).toEqual([12, 12, LIGHT_GRID_SLICES]);
    expect(lightGridDimensions([720, 1280])).toEqual([9, 16, LIGHT_GRID_SLICES]);
    // The Render hands the lit draw and the build the same grid, and the draw its own size in pixels.
    const plan = compiled({ render: { antialias: "ssaa" } });
    expect(pass(plan, "render_shot:lights:grid").uniforms?.["grid"]).toEqual([12, 12, 24, 1]);
    expect(pass(plan, "render_shot:scene:0").uniforms?.["lightGrid"]).toEqual([12, 12, 24, 1]);
    // Under SSAA the lit draw renders into a surface twice the size, and finds its tile from its own pixel.
    expect((pass(plan, "render_shot:scene:0").uniforms?.["lightLens"] as number[]).slice(0, 2)).toEqual([256, 256]);
    expect((pass(compiled(), "render_shot:scene:0").uniforms?.["lightLens"] as number[]).slice(0, 2)).toEqual([128, 128]);
  });

  it("keeps a CASTING Light in Single mode a block beside the table's walk, under B260's guard at every count", () => {
    const plan = compiled({
      nodes: [
        { id: "light_fill", type: "light", parameters: { kind: "point", position: [2, 3, 0] } },
        { id: "light_key", type: "light", parameters: { kind: "point", position: [0, 3, 0], shadows: true } },
      ],
      lights: "light_fill light_key light_lamps",
    });
    const lit = pass(plan, "render_shot:scene:0");
    // One block, the casting Light's, wherever it stands in the list; the fill is a row.
    expect(String(lit.shader)).toContain("light0Meta");
    expect(String(lit.shader)).not.toContain("light1Meta");
    expect(Object.keys(lit.uniforms ?? {}).filter((key) => /^light\d/.test(key)).sort()).toEqual(["light0Color", "light0Meta", "light0Vector"]);
    expect((lit.uniforms?.["light0Vector"] as number[]).slice(0, 3)).toEqual([0, 3, 0]);
    expect(lit.buffers?.map((buffer) => buffer.binding)).toEqual(["positions", "lightTable"]);
    // One block is far under the count B260's guard started at, and it is guarded all the same.
    expect(String(lit.shader)).toContain("if (lightMeta.y != 0.0) {");
  });
});

describe("T1589b: what a Light in Points mode refuses, by name (§V288)", () => {
  it("refuses Points with nothing wired, and says what to wire", () => {
    const [error] = errorsOf({ unwired: true });
    expect(error?.code).toBe("node.scene.lightPoints");
    expect(error?.message).toContain("no pointset arrives");
    expect(error?.nodeId).toBe("light_lamps");
  });

  it("refuses no Type: a pointset of directional lights is that many suns, and legal", () => {
    expect(errorsOf({ light: { kind: "directional" } })).toEqual([]);
  });

  it("defaults Range to 10 in Points mode and leaves it unlimited in Single", () => {
    expect((effectiveParameterSchema(lightNode, { mode: "points" })["range"] as { default: number }).default).toBe(10);
    expect((effectiveParameterSchema(lightNode, {})["range"] as { default: number }).default).toBe(0);
    // And that default is what the resolve pass is handed when Range is not stored at all.
    const plan = compile(lampsScene({ light: { range: undefined } }));
    expect((pass(plan, "light_lamps:lights:resolve").uniforms?.["shape"] as number[])[0]).toBe(10);
  });

  it("refuses a map on a parameter that takes none, a map on an absent attribute, and one of the wrong shape", () => {
    const [unhonoured] = errorsOf({ light: { shadowBias: mapped("gain", 0) } });
    expect(unhonoured?.code).toBe("node.parameter.map");
    expect(unhonoured?.message).toContain("shadowBias is in map mode");
    expect(unhonoured?.message).toContain('"color", "intensity", "position", "range"');

    const [absent] = errorsOf({ light: { color: mapped("hue", [1, 1, 1, 1]) } });
    expect(absent?.code).toBe("node.parameter.map");
    expect(absent?.message).toContain('color maps attribute "hue", which the incoming pointset does not carry');
    // It says what there is to map instead.
    expect(absent?.suggestion).toContain("color, gain, pair, place, position, reach");

    // A colour is a whole vec4f, an intensity one number: a vector needs its channel named.
    expect(errorsOf({ light: { color: mapped("gain", [1, 1, 1, 1]) } })[0]?.message).toContain("needs a vec4f attribute");
    expect(errorsOf({ light: { intensity: mapped("pair", 1) } })[0]?.message).toContain("needs a channel (x/y)");
    expect(errorsOf({ light: { position: mapped("color", [0, 0, 0]) } })[0]?.message).toContain("needs a vec3f attribute");
    // And the legitimate cases the refusals could swallow: every map this node honours, at once.
    compiled({ light: { color: mapped("color", [1, 1, 1, 1]), intensity: mapped("gain", 1), range: mapped("pair", 1, "y"), position: mapped("place", [0, 0, 0]) } });
  });

  it("refuses any map on a Light in Single mode: one light has no points to read from", () => {
    const [error] = errorsOf({ light: { mode: "single", intensity: mapped("gain", 1) } });
    expect(error?.code).toBe("node.parameter.map");
    expect(error?.message).toContain("intensity is in map mode, but this Light is one light");
  });
});

describe("T1589b: the Render's limits are numbers known at compile, and going past one is said by name", () => {
  it(`holds ${MAX_LIGHT_SLOTS} rows, a step of ${NAMED_LIGHT_STEP} of them kept for the named Lights, and refuses one more, naming each Light and what it holds`, () => {
    const room = MAX_LIGHT_SLOTS - NAMED_LIGHT_STEP;
    compiled({ count: room, kernel: SCATTERED_LAMPS });
    const [error] = errorsOf({ count: room + 1, kernel: SCATTERED_LAMPS });
    expect(error?.code).toBe("node.scene.lightCapacity");
    expect(error?.message).toContain(`its light table would hold ${MAX_LIGHT_SLOTS + 1} rows, and it holds at most ${MAX_LIGHT_SLOTS}`);
    expect(error?.message).toContain(`${NAMED_LIGHT_STEP} kept for its 0 Lights in Single mode that do not cast`);
    expect(error?.message).toContain(`"light_lamps" ${room + 1}`);
    expect(error?.nodeId).toBe("render_shot");
    // Two Lights are counted together: every slot of every one.
    const second = { id: "light_more", type: "light", parameters: { mode: "points", kind: "point" } };
    const two: LampsScene = { count: 500, kernel: SCATTERED_LAMPS, nodes: [second], edges: [["kernel_lamps", "light_more", "points"]], lights: "light_lamps light_more" };
    expect(errorsOf(two)[0]?.message).toContain('"light_lamps" 500, "light_more" 500');
    compiled({ ...two, count: room / 2 });
  });

  it("gathers as many Lights in Points mode as the Render lists: a pass a set, all of ONE text (T1628b)", () => {
    // Twelve, where the gather that bound every set at once stopped at seven.
    const names = Array.from({ length: 11 }, (_, index) => `light_set${index}`);
    const plan = compiled({
      nodes: names.map((id) => ({ id, type: "light", parameters: { mode: "points", kind: "point" } })),
      edges: names.map((id) => ["kernel_lamps", id, "points"] as const),
      lights: ["light_lamps", ...names].join(" "),
    });
    const gathers = passesOf(plan).filter((entry) => bare(entry.id).startsWith("render_shot:lights:gather:"));
    // The named rows' set, then the twelve.
    expect(gathers.map((entry) => bare(entry.id))).toEqual(Array.from({ length: 13 }, (_, index) => `render_shot:lights:gather:${index}`));
    expect(new Set(gathers.map((entry) => String(entry.shader))).size).toBe(1);
    // Each binds the table and its own set, whatever the Render lists: two storage buffers.
    for (const gather of gathers) expect(gather.buffers?.map((buffer) => buffer.binding)).toEqual(["lightTable", "lightSet"]);
    // Where a set's rows go and which Light they are of are values: twelve sets of three.
    expect(gathers.slice(1).map((entry) => (entry.uniforms?.["source"] as number[]).slice(0, 3))).toEqual(Array.from({ length: 12 }, (_, index) => [index * 3, 3, index]));
    expect(plan.diagnostics.filter((entry) => entry.severity !== "info")).toEqual([]);
  });

  it("fits a fully attributed mesh Surface in the baseline's eight storage buffers, table included", () => {
    const facts = prepareMesh(CASTERS_GLB, "box")?.facts;
    if (facts === undefined) throw new Error('the fixture has no "box"');
    const plan = compiled({
      nodes: [
        { id: "mesh_box", type: "meshFileIn", parameters: { select: "box", ...facts } },
        { id: "geometry_box", type: "geometry", parameters: { mode: "surface" } },
      ],
      edges: [["mesh_box", "geometry_box", "points"]],
      scenes: "geometry_floor geometry_box",
    });
    // Compiled at the baseline tier, where eight is the limit and a ninth is a compile error
    // (`compiled` has already refused any): every row a mesh carries, and the table.
    const lit = pass(plan, "render_shot:scene:1");
    expect(lit.buffers?.map((buffer) => buffer.binding)).toEqual(["positions", "pointColors", "meshIndices", "meshNormals", "meshUvs", "meshSurface", "meshEmissive", "lightTable"]);
  });

  it("says that primitive instances, points and beams are not lit by these lights yet, rather than drawing them dark", () => {
    const plan = compile(
      lampsScene({
        nodes: [{ id: "geometry_boxes", type: "geometry", parameters: { mode: "instances", shape: "box" } }],
        edges: [["kernel_lamps", "geometry_boxes", "points"]],
        scenes: "geometry_floor geometry_boxes",
      }),
    );
    const warning = plan.diagnostics.find((entry) => entry.code === "node.scene.lightDraw");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toContain('geometry "geometry_boxes" is drawn as primitive instances');
    // The floor, a Surface, is lit and is not warned about; nor is it told it has no lights.
    expect(plan.diagnostics.filter((entry) => entry.code === "node.scene.unlit")).toEqual([
      expect.objectContaining({ message: expect.stringContaining('"geometry_boxes"') }),
    ]);
  });
});

/* ------------------------------------------------------------------------------------ */
/* What the device is asked for                                                          */
/* ------------------------------------------------------------------------------------ */

const input: FrameInputs = {
  frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "realtime", randomSeed: 7 },
  pointer: { x: 0, y: 0, buttons: 0 },
  resolution: [128, 128],
};

/** One frame of a document on the mock device: the compute and render passes it was asked to begin. */
async function deviceCalls(options: LampsScene): Promise<{ computePasses: number; renderPasses: number; dispatches: number }> {
  const plan = compiled(options);
  const host = mockGpuHost({});
  const backend = createVgpuBackend({ host });
  try {
    await backend.initialize({});
    const device = host.device;
    if (device === undefined) throw new Error("the mock host has no device");
    const seen = { computePasses: 0, renderPasses: 0 };
    const createEncoder = device.createCommandEncoder.bind(device);
    vi.spyOn(device, "createCommandEncoder").mockImplementation((descriptor) => {
      const encoder = createEncoder(descriptor);
      const beginCompute = encoder.beginComputePass.bind(encoder);
      vi.spyOn(encoder, "beginComputePass").mockImplementation((passDescriptor) => {
        seen.computePasses += 1;
        return beginCompute(passDescriptor);
      });
      const beginRender = encoder.beginRenderPass.bind(encoder);
      vi.spyOn(encoder, "beginRenderPass").mockImplementation((passDescriptor) => {
        seen.renderPasses += 1;
        return beginRender(passDescriptor);
      });
      return encoder;
    });
    const program = await backend.compile(plan);
    backend.render(program, input);
    const before = { ...seen };
    backend.render(program, input);
    return {
      computePasses: seen.computePasses - before.computePasses,
      renderPasses: seen.renderPasses - before.renderPasses,
      dispatches: plan.passes.filter((entry) => entry.kind === "dispatch").length,
    };
  } finally {
    backend.dispose();
    vi.restoreAllMocks();
  }
}

describe("T1589b: what the lights cost the device in passes", () => {
  it("is the Light's resolve and its set's gather, and not one render pass more: the colour target is still one run", async () => {
    // The same floor under one Light in Single mode: the lamps' kernel is then read by nothing and is not in the plan.
    const single = await deviceCalls({ light: { mode: "single" }, unwired: true });
    const points = await deviceCalls({});
    const kernel = passesOf(compiled()).filter((entry) => entry.kind === "dispatch" && bare(entry.id).startsWith("kernel_lamps")).length;
    expect(kernel).toBeGreaterThan(0);
    // Every dispatch of the plan is a compute pass of the frame. A Render with a lit Surface
    // gathers its named rows and builds its grid whatever it lists (T1623b): the same two
    // under either Light. The Light in Points mode adds its resolve and its set's gather.
    expect(points.computePasses).toBe(points.dispatches);
    expect(single.computePasses).toBe(single.dispatches);
    expect(points.dispatches).toBe(single.dispatches + kernel + 2);
    expect(points.renderPasses).toBe(single.renderPasses);

    // And in the plan: the device's render passes are the runs they were under a Light in
    // Single mode, draw for draw. The backdrop's run still reaches the first lit draw: none
    // of the table's passes stands between them (T1604b).
    const runs = (options: LampsScene): string[][] => renderPassRuns(compiled(options).passes).map((run) => run.passIds.map(bare));
    const two = "geometry_floor geometry_wall";
    expect(runs({ scenes: two })).toEqual(runs({ scenes: two, light: { mode: "single" }, unwired: true }));
    expect(runs({ scenes: two })[0]).toEqual(["render_shot:backdrop", "render_shot:scene:0"]);
  });
});

/* ------------------------------------------------------------------------------------ */
/* Values stay values                                                                    */
/* ------------------------------------------------------------------------------------ */

const frameAt = (frameIndex: number): FrameEvaluationInput => ({ timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 });

describe("T1589b: a driven light and a moving camera are writes, never a rebuild (§V5, T1603b)", () => {
  it("keeps a frame of driven Intensity, Range, Color and camera on the values-only path, and builds no shader text for it", () => {
    const graph = lampsScene({
      light: {
        intensity: expressionSlot("2 + sin(abstime * 3)", 2),
        range: expressionSlot("3 + abstime", 3),
        "color.r": expressionSlot("0.5 + 0.5 * sin(abstime)", 1),
      },
      camera: { ortho: false, eye: [0, 6, 9], "eye.x": expressionSlot("sin(abstime) * 4", 0) },
    });
    const channels = graphChannelResolver(compiledWithoutCatalogue(graph), registry);
    const request = { graph, settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES, resolution: { channels } };
    forgetGeneratedText();
    const prepared = prepareFrameCompiler(request);
    expect(prepared.base.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(prepared.uniformOnly, prepared.reason ?? "").toBe(true);

    const uniformsOf = (plan: { readonly passes: ReadonlyArray<unknown> }, id: string) => pass(plan, id).uniforms as Record<string, number[]>;
    const first = { resolve: uniformsOf(prepared.base, "light_lamps:lights:resolve"), grid: uniformsOf(prepared.base, "render_shot:lights:grid") };
    for (const frameIndex of [1, 2, 30]) {
      const resolution = { frame: frameAt(frameIndex), channels };
      const before = generatedTextCounts();
      const spliced = prepared.compileFrame(resolution);
      const after = generatedTextCounts();
      expect(spliced, prepared.reason ?? "").not.toBeNull();
      if (spliced === null) return;
      // No generator ran and no template built: the three passes and the lit draw are remembered text.
      const ran = Object.fromEntries(
        Object.entries(after.byGenerator)
          .map(([name, counts]) => [name, counts.generated - (before.byGenerator[name]?.generated ?? 0)] as const)
          .filter(([, count]) => count !== 0),
      );
      expect([frameIndex, ran, after.built - before.built]).toEqual([frameIndex, {}, 0]);
      // What was asked was answered from memory: the Render's two gathers (its named rows' and
      // the set's) and its grid, which its light table still plans. The Light's resolve pass and
      // the lit draw's surface module are not asked at all: both nodes' values come from their
      // value functions, which build no text (T1719b).
      const reused = Object.fromEntries(
        ["lightResolveWgsl", "lightGatherWgsl", "lightGridWgsl", "sceneSurfaceModule"].map((name) => [name, (after.byGenerator[name]?.reused ?? 0) - (before.byGenerator[name]?.reused ?? 0)]),
      );
      expect([frameIndex, reused]).toEqual([frameIndex, { lightResolveWgsl: 0, lightGatherWgsl: 2, lightGridWgsl: 1, sceneSurfaceModule: 0 }]);
      // The values moved: the Light's into its resolve pass, the camera's into the grid's build.
      expect(uniformsOf(spliced, "light_lamps:lights:resolve")["color"]).not.toEqual(first.resolve["color"]);
      expect(uniformsOf(spliced, "light_lamps:lights:resolve")["shape"]).not.toEqual(first.resolve["shape"]);
      expect(uniformsOf(spliced, "render_shot:lights:grid")["viewProjection"]).not.toEqual(first.grid["viewProjection"]);
      // Byte for byte what a full compile produces at this frame with nothing remembered.
      forgetGeneratedText();
      const full = compileGraph({ ...request, resolution });
      expect(spliced.passes).toEqual(full.passes);
    }
  });

  it("gives, after a structural change, the plan a compile with nothing remembered gives", () => {
    forgetGeneratedText();
    const base = passesOf(compiled()).map((entry) => `${entry.id}\u0000${String(entry.shader ?? "")}`);
    const changes: ReadonlyArray<readonly [string, LampsScene]> = [
      ["Color in Map mode", { light: { color: mapped("color", [1, 1, 1, 1]) } }],
      ["Intensity in Map mode", { light: { intensity: mapped("gain", 1) } }],
      ["Intensity on one channel of a vector", { light: { intensity: mapped("pair", 1, "y") } }],
      ["Range in Map mode", { light: { range: mapped("reach", 1) } }],
      ["Position in Map mode", { light: { position: mapped("place", [0, 0, 0]) } }],
      ["a counted pointset", { counted: true, count: 2, kernel: "fn process(p: Point, ctx: PointCtx) -> Point {\n  return p;\n}" }],
      ["more lamps", { count: 40 }],
      ["a second Light in Points mode", { nodes: [{ id: "light_more", type: "light", parameters: { mode: "points", kind: "point" } }], edges: [["kernel_lamps", "light_more", "points"]], lights: "light_lamps light_more" }],
      ["a surface twice the size", { render: { antialias: "ssaa" } }],
    ];
    const moved: string[] = [];
    for (const [label, options] of changes) {
      const graph = lampsScene(options);
      const warm = compile(graph);
      forgetGeneratedText();
      const cold = compile(graph);
      expect(warm.diagnostics.filter((entry) => entry.severity === "error"), label).toEqual([]);
      expect(warm.passes, label).toEqual(cold.passes);
      const texts = passesOf(cold).map((entry) => `${entry.id}\u0000${String(entry.shader ?? "")}`);
      if (texts.join("\u0001") !== base.join("\u0001")) moved.push(label);
      // And back: the change did not overwrite what the base remembered.
      expect(passesOf(compile(lampsScene())).map((entry) => `${entry.id}\u0000${String(entry.shader ?? "")}`), `${label}, then back`).toEqual(base);
    }
    // Every one of them is a different program: a memory keyed too coarsely would have handed back the base's.
    expect(moved).toEqual(changes.map(([label]) => label));
  });
});

/* ------------------------------------------------------------------------------------ */
/* Slice 2: a spot is a kind of row                                                      */
/* ------------------------------------------------------------------------------------ */

describe("T1589b slice 2: a spot is a kind of row, and its cone and its aim are values", () => {
  const texts = (plan: { readonly passes: ReadonlyArray<unknown> }): string[] => passesOf(plan).map((entry) => String(entry.shader));
  const resolveOf = (options: LampsScene): Record<string, number[]> => pass(compiled(options), "light_lamps:lights:resolve").uniforms as Record<string, number[]>;

  it("compiles a set of spots, of lamps and of suns to the same shaders: Type, Cone, Cone Softness, Direction and Orient are floats of the Light's own pass", () => {
    const lamps = compiled({ light: { kind: "point" } });
    const spots = compiled({ light: { kind: "spot", cone: 90, coneSoftness: 0.1, direction: [0, -1, 0], orient: [0, 0.6, 0, 0.8] } });
    expect(texts(spots)).toEqual(texts(lamps));
    expect(texts(compiled({ light: { kind: "directional" } }))).toEqual(texts(lamps));
    const values = pass(spots, "light_lamps:lights:resolve").uniforms as Record<string, number[]>;
    // z of `shape` is the Type: 0 directional, 1 point, 2 spot.
    expect([resolveOf({ light: { kind: "directional" } })["shape"]?.[2], resolveOf({ light: { kind: "point" } })["shape"]?.[2], values["shape"]?.[2]]).toEqual([0, 1, 2]);
    expect(values["cone"]).toEqual([90, 0.1, 0, 0]);
    expect(values["aim"]).toEqual([0, -1, 0, 0]);
    expect(values["orient"]).toEqual([0, 0.6, 0, 0.8]);
    // What a Light that says nothing about them is handed: the declared defaults.
    const defaults = resolveOf({});
    expect([defaults["cone"], defaults["orient"]]).toEqual([[60, 0.4, 0, 0], [0, 0, 0, 1]]);
  });

  it("keeps a frame of driven Type, Cone, Cone Softness, Direction and Orient on the values-only path, and builds no shader text for it", () => {
    const graph = lampsScene({
      light: {
        kind: expressionSlot("2", 1),
        cone: expressionSlot("60 + 30 * sin(abstime)", 60),
        coneSoftness: expressionSlot("0.5 + 0.4 * sin(abstime * 2)", 0.4),
        "direction.x": expressionSlot("sin(abstime)", 0),
        "orient.y": expressionSlot("sin(abstime * 0.5)", 0),
      },
    });
    const channels = graphChannelResolver(compiledWithoutCatalogue(graph), registry);
    const request = { graph, settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES, resolution: { channels } };
    forgetGeneratedText();
    const prepared = prepareFrameCompiler(request);
    expect(prepared.base.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    expect(prepared.uniformOnly, prepared.reason ?? "").toBe(true);
    const uniformsOf = (plan: { readonly passes: ReadonlyArray<unknown> }) => pass(plan, "light_lamps:lights:resolve").uniforms as Record<string, number[]>;
    const first = uniformsOf(prepared.base);
    const resolution = { frame: frameAt(30), channels };
    const before = generatedTextCounts();
    const spliced = prepared.compileFrame(resolution);
    const after = generatedTextCounts();
    expect(spliced, prepared.reason ?? "").not.toBeNull();
    if (spliced === null) return;
    expect([after.generated - before.generated, after.built - before.built]).toEqual([0, 0]);
    for (const key of ["cone", "aim", "orient"]) expect([key, uniformsOf(spliced)[key]]).not.toEqual([key, first[key]]);
    forgetGeneratedText();
    expect(spliced.passes).toEqual(compileGraph({ ...request, resolution }).passes);
  });

  it("maps Direction, Orient and Cone in Points mode, each to its own shape of attribute, and Cone Softness to none", () => {
    const [soft] = errorsOf({ light: { coneSoftness: mapped("gain", 0.4) } });
    expect(soft?.code).toBe("node.parameter.map");
    expect(soft?.message).toContain("coneSoftness is in map mode");
    expect(soft?.message).toContain('"color", "intensity", "position", "range", "direction", "orient", "cone"');
    // A direction is a whole vec3f, a turn a whole vec4f, a cone one number.
    expect(errorsOf({ light: { direction: mapped("color", [0, -1, 0]) } })[0]?.message).toContain("needs a vec3f attribute");
    expect(errorsOf({ light: { orient: mapped("place", [0, 0, 0, 1]) } })[0]?.message).toContain("needs a vec4f attribute");
    expect(errorsOf({ light: { cone: mapped("pair", 60) } })[0]?.message).toContain("needs a channel (x/y)");
    // The legitimate cases: every one of the three, and each is a different program.
    const base = texts(compiled({ light: { kind: "spot" } })).join("\u0001");
    const moved = (
      [
        ["Direction", { direction: mapped("place", [0, -1, 0]) }],
        ["Orient", { orient: mapped("color", [0, 0, 0, 1]) }],
        ["Cone", { cone: mapped("gain", 60) }],
        ["Cone on one channel", { cone: mapped("pair", 60, "y") }],
      ] as const
    ).filter(([, light]) => texts(compiled({ light: { kind: "spot", ...light } })).join("\u0001") !== base);
    expect(moved.map(([label]) => label)).toEqual(["Direction", "Orient", "Cone", "Cone on one channel"]);
    // And the lit draw's text is none of theirs: a map is the Light's own pass's business.
    expect(String(pass(compiled({ light: { kind: "spot", cone: mapped("gain", 60) } }), "render_shot:scene:0").shader)).toBe(String(pass(compiled(), "render_shot:scene:0").shader));
  });

  it("says, by the node's name, that a CASTING Spot in Single mode shines as a Point light, and compiles it as exactly that", () => {
    const single = (light: Record<string, unknown>): LampsScene => ({ unwired: true, light: { mode: "single", position: [0, 2, 0], shadows: true, ...light } });
    const spot = compile(lampsScene(single({ kind: "spot", cone: 30 })));
    const said = spot.diagnostics.filter((entry) => entry.code === "node.scene.lightSpot");
    expect(said).toHaveLength(1);
    expect([said[0]?.severity, said[0]?.nodeId]).toEqual(["warning", "light_lamps"]);
    expect(said[0]?.message).toContain('Node "light_lamps": Type is Spot and Cast Shadows is on');
    expect(said[0]?.message).toContain("shines as a Point light");
    expect(spot.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
    // It is not a refusal and decides nothing: the plan is the casting Point light's plan, value for value.
    const point = compile(lampsScene(single({ kind: "point", cone: 30 })));
    expect(planFingerprint(spot)).toBe(planFingerprint(point));
    expect(passesOf(spot).some((entry) => String(entry.shader).includes("light0Meta"))).toBe(true);
    // A casting Point light says nothing; neither does a Spot in Points mode, nor a Spot in
    // Single mode that does not cast: each of those two is a row with its cone (T1623b).
    expect(point.diagnostics.filter((entry) => entry.code === "node.scene.lightSpot")).toEqual([]);
    expect(compiled({ light: { kind: "spot" } }).diagnostics.filter((entry) => entry.code === "node.scene.lightSpot")).toEqual([]);
    expect(compiled(single({ kind: "spot", cone: 30, shadows: false })).diagnostics.filter((entry) => entry.code === "node.scene.lightSpot")).toEqual([]);
    // Type stays a value there too: a document that drives it compiles frames by values.
    const driven = prepareFrameCompiler({ graph: lampsScene(single({ kind: expressionSlot("2", 2) })), settings: SETTINGS, registry, capabilities: TIER_B_CAPABILITIES });
    expect(driven.uniformOnly, driven.reason ?? "").toBe(true);
    expect(structuralParameterKeys(lightNode, { mode: "single" }).has("kind")).toBe(false);
  });

  it("marks the rows a Light does not read: a cone on anything but a Spot, a casting Spot's cone, Orient outside Points mode", () => {
    const schema = effectiveParameterSchema(lightNode, {});
    const inactive = (key: string, values: Record<string, unknown>): string | null => (schema[key] as { inactiveWhen?: (values: Record<string, unknown>) => string | null }).inactiveWhen?.(values) ?? null;
    for (const key of ["cone", "coneSoftness"]) {
      expect([key, inactive(key, { kind: "spot", mode: "points" })]).toEqual([key, null]);
      expect(inactive(key, { kind: "point", mode: "points" })).toContain("Only a Spot");
      // A Spot in Single mode has its cone (T1623b slice 3), unless it casts.
      expect([key, inactive(key, { kind: "spot", mode: "single" })]).toEqual([key, null]);
      expect(inactive(key, { kind: "spot", mode: "single", shadows: true })).toContain("shines as a Point light");
      // The shadow rows of a Light in Points mode are not read, so a stored `shadows` there shuts no cone.
      expect([key, inactive(key, { kind: "spot", mode: "points", shadows: true })]).toEqual([key, null]);
    }
    expect(inactive("orient", { kind: "spot", mode: "points" })).toBeNull();
    expect(inactive("orient", { kind: "directional", mode: "points" })).toBeNull();
    expect(inactive("orient", { kind: "spot", mode: "single" })).toContain("Mode: Points");
    // A spot stands at a place: it has a Falloff and a Range, as a point light has, and a Direction, as a sun has.
    for (const key of ["falloff", "range", "direction"]) expect([key, inactive(key, { kind: "spot", mode: "points" })]).toEqual([key, null]);
    expect(inactive("direction", { kind: "point", mode: "points" })).toContain("shines everywhere");
  });
});

/* ------------------------------------------------------------------------------------ */
/* Nothing else moved                                                                    */
/* ------------------------------------------------------------------------------------ */

/**
 * The plans of five shipped examples that light a Render with Lights in Single mode, as
 * `planFingerprint` reads them: every pass's id, shader text, bindings and uniform values.
 *
 * A fingerprint here moves when the Render's program for such a scene moves, by any hand. It
 * is a tripwire for the whole lit path: a change that is meant to move one re-takes it on
 * purpose, and says so here.
 *
 * RE-TAKEN ON PURPOSE BY §B255 (2026-10-06), all five: each of these examples draws a grid
 * Surface, and the lit grid chunk's texture coordinate line changed (an axis divides by its
 * cells, so a wrapped one reaches 1 at its seam). Before: E13 359501820ee04eb2, E33
 * 3bbe8f637a87f0ca, E28 ead2f43368e32c56, E69 9277401191f84901, E79 e81ee4bea6dbf553.
 *
 * RE-TAKEN ON PURPOSE BY T1623b SLICE 3 (2026-10-06), all five. A Render that draws a lit
 * Surface has a light table now, lights or none: its Lights in Single mode that do not cast
 * are rows of it, and its casting Lights' blocks stand under B260's guard at every count. So
 * four of the five gain the table's four passes, and their lit Surface draws the walk's text.
 * E13 gains nothing: its one Light lights nothing (its Surfaces are unlit and glass), so it
 * has no table. What moved there is the unlit wall's text, which no longer declares the
 * three uniform rows of a Light it never read. Each one's picture was compared before and
 * after (frames 0 and 60, the Render's own target): E13 the same bytes; the other four
 * differ in 61 to 118 channel values of 3.7 to 5.3 million, each by one step of a half
 * float. Before: E13 b0ae17f85a00fa66, E33 5a7d8127aa370b62, E28 9cd4c3c06215a84f, E69
 * 962a4048645d64ce, E79 6bd605b4e59f4207.
 *
 * RE-TAKEN ON PURPOSE BY T1623b SLICE 4 (2026-10-06), the four that have a casting Light, and
 * NOT FOR ANY SHADER TEXT: every module of these plans is the string it was. A casting
 * light's shadow map is a layer of one of the Render's two layered targets now, so the plan
 * NAMES it otherwise: its sweep's passes draw into `shadowMaps` or `shadowCubes` at a layer
 * where they drew into a target of the light's own, and the lit draws' `shadowMap{s}`
 * binding names that resource and that layer. Each one's picture is the bytes it was
 * (frames 0 and 60, the Render's own target, main against this slice). E13 has no casting
 * light and did not move. Before: E33 9aefeca06bc7bde5, E28 393eb505a3d99752, E69
 * 923972675c8cd9d1, E79 921e038a3a933358.
 */
const PINNED: ReadonlyArray<readonly [example: string, fingerprint: string, casting: number, table: boolean]> = [
  ["E13-Prism", "f6cab593f8e8d50a", 0, false],
  ["E33-Obol", "744b970a16cfaded", 1, true],
  ["E28-Sundial", "de0f0fc3267944b4", 1, true],
  ["E69-Burnish", "2ab7ef7524fc78db", 1, true],
  ["E79-Crucible", "9ae189909229718d", 2, true],
];

function examplePlan(name: string) {
  const text = readFileSync(new URL(`../../../examples/${name}.loom.json`, import.meta.url), "utf8");
  const system = createComponentSystem(registry);
  const loaded = loadProject(text, { nodes: system.nodes });
  if (!loaded.ok) throw new Error(`${name} does not load`);
  for (const definition of loaded.components) system.components.register(definition);
  const components = system.components.view();
  const flattened = flattenComponents({ graph: loaded.document.graph, registry: system.nodes, components });
  const channels = graphChannelResolver(flattened.graph, system.nodes);
  return compileGraph({ graph: loaded.document.graph, settings: loaded.document.settings, registry: system.nodes, capabilities: TIER_B_CAPABILITIES, components, flattened, resolution: { channels } });
}

describe("T1589b, T1623b: the plans of five shipped Renders with Lights in Single mode, pinned", () => {
  for (const [name, fingerprint, casting, table] of PINNED) {
    it(`${name}: every pass, its shader text, its bindings and its uniforms are what they were when its pin was last taken`, () => {
      const plan = examplePlan(name);
      expect(plan.diagnostics.filter((entry) => entry.severity === "error")).toEqual([]);
      // The Surface generator unrolls a block for a casting Light and for no other: the
      // uniform rows `light<i>Meta` of the lit Surface draws count the casting Lights.
      const surfaces = passesOf(plan).filter((entry) => /:scene:\d+$/.test(entry.id) && String(entry.shader).includes("lightTable"));
      const blocks = (entry: AnyPass): number => Object.keys(entry.uniforms ?? {}).filter((key) => /^light\d+Meta$/.test(key)).length;
      expect([name, surfaces.length > 0, [...new Set(surfaces.map(blocks))]]).toEqual([name, table, table ? [casting] : []]);
      // The table's own passes: its header, its named rows, their gather, the grid.
      expect(passesOf(plan).filter((entry) => entry.id.includes(":lights:")).map((entry) => bare(entry.id).replace(/^[^:]+/, "render"))).toEqual(
        table ? ["render:lights:header", "render:lights:named", "render:lights:gather:0", "render:lights:grid"] : [],
      );
      expect(planFingerprint(plan)).toBe(fingerprint);
    });
  }

  it("the lamps' attributes are what the fixture says they are", () => {
    // The refusals above list them; a fixture that changed would make those sentences stale.
    expect(LAMP_ATTRIBUTES.map((attribute) => attribute.name).sort()).toEqual(["color", "gain", "pair", "place", "position", "reach"]);
  });
});
