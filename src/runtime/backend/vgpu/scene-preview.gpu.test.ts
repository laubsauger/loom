import { writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { probeDawn } from "./node-gpu-host.ts";
import { capturingHost, drawSynthesizedPreview } from "./preview-synthesis-fixture.ts";
import { encodePng } from "../../export/png.ts";
import type { GraphDocument, GraphNode } from "../../../domain/types/graph.ts";

/**
 * T462 on a REAL device, §V147-exact where the geometry allows it:
 *
 *  - the LIGHT stock's ball has its CENTRE facing the camera dead-on (the stock rig
 *    looks straight down -z), so a directional light straight down the axis gives
 *    |N·L| ≈ 1 within byte rounding;
 *  - the MATERIAL stock is a tilted torus since T665, so its centre texel is the HOLE,
 *    and the pins that matter are the hole's rims, the outer silhouette and a tiling
 *    map's repeat — see the two T665 blocks below for why each one can fail;
 *  - the BACKGROUND corner is a flat constant — §V384 as bytes;
 *  - a zero-intensity light previews BLACK, which is true and is the point;
 *  - the camera preview aimed straight at the gnomon's +z face reads that face's flat
 *    colour exactly.
 *
 * Each rendered tile is also written to the test output as a PNG for the §V383 look
 * pass — the bar "can I tell two materials apart at node size" has no assertion.
 */

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

const registry = createNodeRegistry(allNodeDefinitions).view();

function node(id: string, type: string, parameters: Record<string, unknown>, label: string): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, label } as never;
}

function graphOf(nodes: GraphNode[], edges: Record<string, unknown> = {}): GraphDocument {
  return {
    revision: 1,
    nodes: Object.fromEntries(nodes.map((entry) => [entry.id, entry])),
    edges,
    groups: {},
  } as never;
}

async function renderPreviews(
  graph: GraphDocument,
  sinks: Array<{ nodeId: string; portId: string }>,
): Promise<Map<string, Uint8Array>> {
  const plan = compileGraph({
    graph,
    settings: SETTINGS,
    registry,
    capabilities: CAPABILITIES,
    sinks: sinks.map((sink) => ({ ...sink, kind: "preview" as const })),
  } as never);
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const { host, session } = capturingHost();
  const backend = createVgpuBackend({ host });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    });
    // T563: the stock scenes render through the preview program, at this test's tile.
    const device = session()?.gpu.gpu as unknown as GPUDevice;
    const images = new Map<string, Uint8Array>();
    for (const sink of sinks) {
      drawSynthesizedPreview({ backend, device, outputs: plan.outputs, nodeId: sink.nodeId, portId: sink.portId, tileEdge: EDGE });
      await device.queue.onSubmittedWorkDone();
      const image = await backend.readOutput(`preview:scene:${sink.nodeId}:${sink.portId}`);
      images.set(sink.nodeId, image.bytes);
    }
    return images;
  } finally {
    backend.dispose();
  }
}

/**
 * The tile edge these tests grant (T563: the preview program sizes the target to the
 * granted tile). Every coordinate below is derived from it, so the picture asserted is
 * the same one at any size.
 */
const EDGE = 192 * 2;
const CENTRE = EDGE / 2;

const texel = (bytes: Uint8Array, x: number, y: number): [number, number, number] => {
  const at = (y * EDGE + x) * 4;
  return [bytes[at] ?? -1, bytes[at + 1] ?? -1, bytes[at + 2] ?? -1];
};

const savePng = (name: string, bytes: Uint8Array): void => {
  const png = encodePng({ width: EDGE, height: EDGE, data: bytes });
  writeFileSync(`test-results/${name}`, png.bytes);
};

/** The stock backdrop as bytes — the thing "background" means in every pin below. */
const BACKDROP: [number, number, number] = [
  Math.round(0.055 * 255),
  Math.round(0.06 * 255),
  Math.round(0.075 * 255),
];
const isBackdrop = (t: readonly [number, number, number]): boolean =>
  t[0] === BACKDROP[0] && t[1] === BACKDROP[1] && t[2] === BACKDROP[2];

/**
 * How many BANDS a scan line crosses: background / light / dark, counting a change of
 * band as a new run. On a flat unlit material with no map the whole surface is ONE
 * colour, so a scan line across the torus reads exactly `bg, surface, hole, surface, bg`
 * = 5. Every run beyond those five is a check of the map — which is what "the repeat is
 * legible" means as a number.
 */
const scanRuns = (samples: ReadonlyArray<[number, number, number]>): number => {
  let runs = 0;
  let previous = "";
  for (const sample of samples) {
    const band = isBackdrop(sample) ? "bg" : sample[0] > 127 ? "light" : "dark";
    if (band !== previous) runs += 1;
    previous = band;
  }
  return runs;
};

const scanRow = (bytes: Uint8Array, y: number): Array<[number, number, number]> =>
  Array.from({ length: EDGE }, (_, x) => texel(bytes, x, y));
const scanColumn = (bytes: Uint8Array, x: number): Array<[number, number, number]> =>
  Array.from({ length: EDGE }, (_, y) => texel(bytes, x, y));

describe("scene payload previews render exactly (T462, §V147, §V384)", () => {
  /**
   * T665 — THE MATERIAL STOCK IS A TORUS, AND THE HOLE IS THE PROOF.
   *
   * §V461: this file used to assert `centre == red`, which is true of a ball, a torus
   * seen edge-on, a cube and a full-tile quad — it could not distinguish the form at
   * all. The centre texel is the one place the two stocks can never agree: on a sphere
   * the centre is always SURFACE (it is the point facing the camera), and on a torus
   * tilted enough to be worth looking at it is always BACKGROUND. So it is asserted as
   * background, and the rest of the row pins the shape either side of it.
   *
   * The row pins are exact and they are the FRAMING claim as bytes (R + r = 1.0, so the
   * torus reaches exactly as far from the origin as the unit ball did and the stock
   * camera in compile.ts was not touched):
   *  - the outer silhouette on the centre row ends between x = 375 and x = 376, mirrored
   *    at 8 / 7. A torus 1% smaller moves that edge ~4px and reddens this;
   *  - the hole spans x = 116..267 — 152px of background inside a 368px-wide form. A
   *    torus with too fat a tube closes the hole and reddens this;
   *  - nothing reaches the tile border, so nothing is clipped.
   */
  it("an unlit material previews on a TORUS: the centre is the HOLE, the tube is the albedo", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const images = await renderPreviews(
      graphOf([node("skin", "materialUnlit", { color: [1, 0, 0, 1] }, "skin1")]),
      [{ nodeId: "skin", portId: "out" }],
    );
    const bytes = images.get("skin")!;
    savePng("scene-preview-material-unlit.png", bytes);

    // THE HOLE. A sphere cannot produce this texel; that is the whole point of T665.
    expect(texel(bytes, CENTRE, CENTRE)).toEqual(BACKDROP);
    // The tube itself is the albedo exactly — 0/1 fixed points of the display decode
    // (§V56), and unlit, so no rig can be blamed for the value.
    expect(texel(bytes, 30, CENTRE)).toEqual([255, 0, 0]);
    expect(texel(bytes, 350, CENTRE)).toEqual([255, 0, 0]);
    // The hole's two rims on the centre row, to the texel.
    expect([texel(bytes, 115, CENTRE), texel(bytes, 116, CENTRE)]).toEqual([[255, 0, 0], BACKDROP]);
    expect([texel(bytes, 267, CENTRE), texel(bytes, 268, CENTRE)]).toEqual([BACKDROP, [255, 0, 0]]);
    // The outer silhouette, to the texel: this is "outer radius 1.0" as a picture.
    expect([texel(bytes, 7, CENTRE), texel(bytes, 8, CENTRE)]).toEqual([BACKDROP, [255, 0, 0]]);
    expect([texel(bytes, 375, CENTRE), texel(bytes, 376, CENTRE)]).toEqual([[255, 0, 0], BACKDROP]);
    // §V384 as bytes: the corner is the painted backdrop, not unrendered black.
    expect(texel(bytes, 2, 2)).toEqual(BACKDROP);
    // And the stock camera still FRAMES the form: no texel on the tile border is object.
    const border: Array<[number, number, number]> = [];
    for (let i = 0; i < EDGE; i += 1) {
      border.push(texel(bytes, i, 0), texel(bytes, i, EDGE - 1), texel(bytes, 0, i), texel(bytes, EDGE - 1, i));
    }
    expect(border.filter((sample) => !isBackdrop(sample)).length).toBe(0);
  });

  /**
   * T665 — A TILING MAP'S REPEAT IS LEGIBLE, IN BOTH DIRECTIONS.
   *
   * This is the reason the owner asked for the change and the reason TD previews MATs on
   * a torus: a sphere's UV wraps once, so a map that tiles badly tiles invisibly. The
   * torus wraps in u AND v, so the map lands on the form twice over.
   *
   * §V461 — the CONTROL is what makes this falsifiable. The identical unlit material
   * with NO map is rendered alongside, and an unlit flat colour crosses exactly five
   * bands on any scan line through the form (bg, tube, hole, tube, bg). The mapped one
   * crosses 13 across and 11 down. A preview that dropped the map, or sampled one texel
   * of it, or wrapped only one axis, reads 5 on the axis it lost.
   */
  it("a TILING map repeats visibly across u and down v (T665)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const images = await renderPreviews(
      graphOf(
        [
          // The default 8x8 black/white checker: it tiles perfectly, so what shows on
          // the form is its REPEAT rather than an artefact of one particular image.
          node("plate", "checker", {}, "plate1"),
          node("mapped", "materialUnlit", { color: [1, 1, 1, 1] }, "mapped1"),
          node("plain", "materialUnlit", { color: [1, 1, 1, 1] }, "plain1"),
        ],
        { m1: { id: "m1", source: { nodeId: "plate", portId: "out" }, target: { nodeId: "mapped", portId: "albedo" } } },
      ),
      [
        { nodeId: "mapped", portId: "out" },
        { nodeId: "plain", portId: "out" },
      ],
    );
    const mapped = images.get("mapped")!;
    const plain = images.get("plain")!;
    savePng("scene-preview-material-tiling.png", mapped);

    // The control: one flat colour on the same form, both axes.
    expect([scanRuns(scanRow(plain, CENTRE)), scanRuns(scanColumn(plain, CENTRE))]).toEqual([5, 5]);
    // The map, on the same form: checks across the ring AND around the tube.
    expect([scanRuns(scanRow(mapped, CENTRE)), scanRuns(scanColumn(mapped, CENTRE))]).toEqual([13, 11]);

    // Exact texels, so "13 runs" cannot be satisfied by noise: unlit white × a 0/1
    // checker is exactly white or exactly black, alternating along both scans.
    const WHITE: [number, number, number] = [255, 255, 255];
    const BLACK: [number, number, number] = [0, 0, 0];
    expect([30, 70, 105, 275, 300, 350, 373].map((x) => texel(mapped, x, CENTRE))).toEqual([
      WHITE, BLACK, WHITE, BLACK, WHITE, BLACK, WHITE,
    ]);
    expect([76, 95, 125, 150, 255, 290, 340, 368].map((y) => texel(mapped, CENTRE, y))).toEqual([
      BLACK, WHITE, BLACK, WHITE, BLACK, WHITE, BLACK, WHITE,
    ]);
    // The hole is still the hole with a map bound.
    expect(texel(mapped, CENTRE, CENTRE)).toEqual(BACKDROP);
  }, 120_000);

  it("a light previews the ball lit by ONLY itself — and zero intensity is black", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    // Straight down the preview axis: |N·L| = 1 at the centre, so the centre texel is
    // baseColor 0.8 × intensity 1 — no ambient in a light preview, by design.
    //
    // T665: this is also the gate on the LIGHT stock STAYING A BALL. A light preview
    // reads falloff and the terminator across a KNOWN form, and a torus's apparent
    // self-occlusion — which this shader does not actually shadow — would confound the
    // light with the shape. A torus here would put the HOLE at the centre texel, i.e.
    // background, so this line reddens the day someone "finishes the job".
    const images = await renderPreviews(
      graphOf([
        node("sun", "light", { kind: "directional", direction: [0, 0, -1], intensity: 1 }, "sun1"),
        node("dark", "light", { kind: "directional", direction: [0, 0, -1], intensity: 0 }, "dark1"),
      ]),
      [
        { nodeId: "sun", portId: "out" },
        { nodeId: "dark", portId: "out" },
      ],
    );
    const lit = images.get("sun")!;
    expect(texel(lit, CENTRE, CENTRE)).toEqual([204, 204, 204]);
    // Zero intensity: BLACK ball on the painted backdrop — true, and the point.
    const dark = images.get("dark")!;
    expect(texel(dark, CENTRE, CENTRE)).toEqual([0, 0, 0]);
    expect(texel(dark, 2, 2)).not.toEqual([0, 0, 0]);
    savePng("scene-preview-light.png", lit);
    savePng("scene-preview-light-zero.png", dark);
  });

  it("a camera aimed at the gnomon's front face reads that face's flat colour exactly", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const images = await renderPreviews(
      graphOf([node("cam", "camera", { eye: [0, 0.45, 3], lookAt: [0, 0.45, 0] }, "cam1")]),
      [{ nodeId: "cam", portId: "out" }],
    );
    const bytes = images.get("cam")!;
    // The +z box face: flat [0.24, 0.42, 0.9] — no lighting in the stock scene. Each
    // channel quantizes from its f32 value (0.9 is 0.89999997… as f32, hence 229).
    expect(texel(bytes, CENTRE, CENTRE)).toEqual(
      [0.24, 0.42, 0.9].map((channel) => Math.round(Math.fround(channel) * 255)),
    );
    savePng("scene-preview-camera.png", bytes);
  });

  it("look-pass fixtures: two materials must read apart at node size (§V383)", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const graph = graphOf(
      [
        node("plate", "checker", {}, "plate1"),
        node("gold", "materialPhong", { color: [0.9, 0.7, 0.2, 1], specular: [1, 1, 1, 1], shininess: 48 }, "gold1"),
        node("chalk", "materialPbr", { color: [0.85, 0.85, 0.9, 1], metallic: 0, roughness: 1 }, "chalk1"),
        node("mapped", "materialPhong", { color: [1, 1, 1, 1] }, "mapped1"),
      ],
      {
        m1: { id: "m1", source: { nodeId: "plate", portId: "out" }, target: { nodeId: "mapped", portId: "albedo" } },
      },
    );
    const images = await renderPreviews(graph, [
      { nodeId: "gold", portId: "out" },
      { nodeId: "chalk", portId: "out" },
      { nodeId: "mapped", portId: "out" },
    ]);
    savePng("scene-preview-material-gold.png", images.get("gold")!);
    savePng("scene-preview-material-chalk.png", images.get("chalk")!);
    savePng("scene-preview-material-mapped.png", images.get("mapped")!);
    // The assertable half of "readable apart": the two materials differ in actual bytes,
    // and the mapped one shows the checker (two points on the TUBE differ — T665 moved
    // the sample off the centre, which is the hole now).
    expect(images.get("gold")).not.toEqual(images.get("chalk"));
    const mapped = images.get("mapped")!;
    expect(texel(mapped, 30, CENTRE)).not.toEqual(texel(mapped, 70, CENTRE));
  }, 120_000);

  /**
   * T532 — the geometry variant, on a real device.
   *
   * The compiler tests pin that the passes exist and carry the right values; this is the
   * half they cannot answer, and the half T462's geometry hole actually failed: does
   * anything reach the pixels? Three assertions, each of which a plausible half-fix would
   * fail — a backdrop with no object (§V384's inverse), an object with no backdrop, and
   * two geometries whose only difference is the thing the node uniquely decides.
   */
  it("a geometry previews its OWN object, and instancing changes the picture", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const geometry = (id: string, parameters: Record<string, unknown>) =>
      graphOf(
        [node("grid", "pointGrid", { cols: 24, rows: 24 }, "grid1"), node(id, "geometry", parameters, `${id}1`)],
        { e1: { id: "e1", source: { nodeId: "grid", portId: "out" }, target: { nodeId: id, portId: "points" } } },
      );

    const surface = (await renderPreviews(geometry("surf", { mode: "surface" }), [{ nodeId: "surf", portId: "out" }])).get("surf")!;
    savePng("scene-preview-geometry-surface.png", surface);
    // The BACKDROP is painted (§V384): a corner is the stock backdrop, not black.
    expect(texel(surface, 2, 2)).toEqual([
      Math.round(0.055 * 255),
      Math.round(0.06 * 255),
      Math.round(0.075 * 255),
    ]);
    // And the OBJECT is drawn over it: the centre is not the backdrop.
    expect(texel(surface, CENTRE, CENTRE)).not.toEqual(texel(surface, 2, 2));

    // Instancing is the thing a geometry node uniquely decides, and it must be VISIBLE:
    // the same points worn as small boxes and as large octahedra are different pictures.
    const small = (await renderPreviews(
      geometry("small", { mode: "instances", shape: "box", scale: 0.02 }),
      [{ nodeId: "small", portId: "out" }],
    )).get("small")!;
    const big = (await renderPreviews(
      geometry("big", { mode: "instances", shape: "octahedron", scale: 0.12 }),
      [{ nodeId: "big", portId: "out" }],
    )).get("big")!;
    savePng("scene-preview-geometry-instances.png", big);
    expect(small).not.toEqual(big);
    // Both draw something; neither is the backdrop alone.
    for (const [name, bytes] of [["small", small], ["big", big]] as const) {
      const ink = countDifferingFromBackdrop(bytes);
      expect([name, ink > 0]).toEqual([name, true]);
    }
    // The bigger primitive covers strictly more of the tile — the scale reaches pixels.
    expect(countDifferingFromBackdrop(big)).toBeGreaterThan(countDifferingFromBackdrop(small));
  }, 120_000);
});

/** Texels that are not the painted backdrop — "how much object is in this picture". */
function countDifferingFromBackdrop(bytes: Uint8Array): number {
  const backdrop = texel(bytes, 2, 2);
  let count = 0;
  for (let y = 0; y < EDGE; y += 1) {
    for (let x = 0; x < EDGE; x += 1) {
      const here = texel(bytes, x, y);
      if (here[0] !== backdrop[0] || here[1] !== backdrop[1] || here[2] !== backdrop[2]) count += 1;
    }
  }
  return count;
}
