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
 *  - the preview ball's CENTRE faces the camera dead-on (the stock rig looks straight
 *    down -z), so an unlit material's centre is its baseColor to the byte, and a
 *    directional light straight down the axis gives |N·L| ≈ 1 within byte rounding;
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

describe("scene payload previews render exactly (T462, §V147, §V384)", () => {
  it("unlit red ball centre is red; the background corner is the stock backdrop", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const images = await renderPreviews(
      graphOf([node("skin", "materialUnlit", { color: [1, 0, 0, 1] }, "skin1")]),
      [{ nodeId: "skin", portId: "out" }],
    );
    const bytes = images.get("skin")!;
    // 0/1 fixed points of the display decode (§V56): linear red exactly.
    expect(texel(bytes, CENTRE, CENTRE)).toEqual([255, 0, 0]);
    // §V384 as bytes: the corner is the painted backdrop, not unrendered black.
    expect(texel(bytes, 2, 2)).toEqual([
      Math.round(0.055 * 255),
      Math.round(0.06 * 255),
      Math.round(0.075 * 255),
    ]);
    savePng("scene-preview-material-unlit.png", bytes);
  });

  it("a light previews the ball lit by ONLY itself — and zero intensity is black", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    // Straight down the preview axis: |N·L| = 1 at the centre, so the centre texel is
    // baseColor 0.8 × intensity 1 — no ambient in a light preview, by design.
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
    // The assertable half of "readable apart": the two balls differ in actual bytes,
    // and the mapped ball shows the checker (two sample points on the ball differ).
    expect(images.get("gold")).not.toEqual(images.get("chalk"));
    const mapped = images.get("mapped")!;
    expect(texel(mapped, CENTRE, CENTRE)).not.toEqual(texel(mapped, CENTRE - 40, CENTRE));
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
