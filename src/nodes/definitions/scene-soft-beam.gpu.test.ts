import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { toRgba8 } from "../../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";

/**
 * T917 — the SOFT ADDITIVE BEAM (§T845's gap, third sighting, finally closed).
 *
 * Two claims, each §V812-shaped (a render, an exact read-back, no self-agreement):
 *
 *  - SOFT: the beam's coverage falls off across its own width — §T845's AA formula on the
 *    ribbon's cross axis — and soft = 0 keeps today's hard edge, so every shipped picture
 *    is undisturbed.
 *  - ADDITIVE: two crossing beams SUM where they overlap instead of one winning the
 *    z-buffer, and depth is not written, so the draw order cannot occlude light with light.
 */

const SETTINGS = {
  outputResolution: { width: 256, height: 256 },
  workingFormat: "rgba8unorm" as const,
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tip", type: "vec3f", default: [0, 0, 0] },
]);

/** Two beams crossing in an X at the origin, in the z = 0 plane. */
const CROSS_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let first = ctx.index == 0u;
  q.position = vec3f(-0.8, select(0.5, -0.5, first), 0.0);
  q.tip = vec3f(0.8, select(-0.5, 0.5, first), 0.0);
  return q;
}`;

/** One horizontal beam through the middle, for the edge-profile read. */
const SINGLE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(-0.8, 0.0, 0.0);
  q.tip = vec3f(0.8, 0.0, 0.0);
  return q;
}`;

function graphFor(options: { kernel: string; count: number; soft: number; blend: "opaque" | "additive" }): GraphDocument {
  return {
    revision: 1,
    nodes: {
      gen: {
        id: "gen", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: { capacity: options.count, seed: 7, group: "", attributes: ATTRIBUTES, kernel: options.kernel, value1: 0, value2: 0, value3: 0, value4: 0 },
        label: "gen1",
      },
      mat: { id: "mat", type: "materialUnlit", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { color: [0.5, 0.5, 0.5, 1] }, label: "mat1" },
      tile: {
        id: "tile", type: "geometry", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: { mode: "beam", endpoint: "tip", scale: 0.12, taper: 1, soft: options.soft, blend: options.blend, material: "mat1", tint: [1, 1, 1, 1] },
        label: "tile1",
      },
      eye: {
        id: "eye", type: "camera", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: { eye: [0, 0, 3], lookAt: [0, 0, 0], fov: 45, near: 0.1, far: 20, ortho: false },
        label: "eye1",
      },
      shot: {
        id: "shot", type: "render", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: { scenes: "tile1", camera: "eye1", lights: "", ambientColor: [0, 0, 0, 1], ambientIntensity: 0, background: [0, 0, 0, 1] },
        label: "shot1",
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "out1" },
    },
    edges: {
      e0: { id: "e0", source: { nodeId: "gen", portId: "out" }, target: { nodeId: "tile", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "shot", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as unknown as GraphDocument;
}

let dawnError: string | undefined;
beforeAll(async () => {
  dawnError = (await probeDawn()).error;
}, 60_000);

async function shoot(graph: GraphDocument): Promise<(x: number, y: number) => number> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph,
    settings: SETTINGS,
    frames: 1,
    capture: [0],
    animate: true,
    outputNodeId: "out",
  });
  const errors = result.diagnostics.filter((d) => d.severity === "error");
  if (errors.length > 0) throw new Error(errors.map((d) => d.message).join("; "));
  const frame = result.frames[0]!;
  const space = result.plan.outputs.find((o) => o.nodeId === "out")?.space ?? "linear";
  const image = toRgba8(
    { width: frame.width, height: frame.height, format: frame.format, bytes: frame.bytes, rowStride: frame.width * (BYTES_PER_PIXEL[frame.format] ?? 8) },
    { space },
  );
  return (x, y) => image.data[(y * 256 + x) * 4] ?? 0; // red channel; the beams are grey
}

describe("T917 — the soft additive beam", () => {
  it("soft = 0 keeps the hard edge: full brightness one row inside, zero one row outside", async () => {
    if (dawnError !== undefined) return;
    const read = await shoot(graphFor({ kernel: SINGLE_KERNEL, count: 1, soft: 0, blend: "opaque" }));
    const centre = read(128, 128);
    expect(centre).toBeGreaterThan(80);
    // Walk down from the centreline: the hard beam holds its value, then DROPS to zero
    // within at most two rows — a cliff, not a slope.
    let previous = centre;
    let cliff = 0;
    for (let y = 129; y < 160; y += 1) {
      const value = read(128, y);
      if (previous > 80 && value < 10) cliff += 1;
      previous = value;
    }
    expect(cliff).toBe(1);
  });

  it("soft = 1 falls off monotonically from the centreline to the edge", async () => {
    if (dawnError !== undefined) return;
    const read = await shoot(graphFor({ kernel: SINGLE_KERNEL, count: 1, soft: 1, blend: "opaque" }));
    const centre = read(128, 128);
    expect(centre).toBeGreaterThan(80);
    // Sample along the falloff: strictly non-increasing, and genuinely graded — at least
    // four distinct levels between the centre and the dark, or it is a cliff wearing a knob.
    const levels = new Set<number>();
    let previous = 255;
    for (let y = 128; y < 168; y += 1) {
      const value = read(128, y);
      expect(value).toBeLessThanOrEqual(previous + 6); // monotone within quantisation
      previous = value;
      levels.add(Math.round(value / 16));
    }
    expect(levels.size).toBeGreaterThanOrEqual(4);
  });

  it("additive: crossing beams SUM where they overlap — light on light, not z-fight", async () => {
    if (dawnError !== undefined) return;
    const additive = await shoot(graphFor({ kernel: CROSS_KERNEL, count: 2, soft: 1, blend: "additive" }));
    const opaque = await shoot(graphFor({ kernel: CROSS_KERNEL, count: 2, soft: 1, blend: "opaque" }));
    // An arm away from the crossing reads one beam's value in both modes …
    const armAdditive = additive(48, 84);
    const armOpaque = opaque(48, 84);
    expect(armAdditive).toBeGreaterThan(30);
    // … but AT the crossing, additive carries genuinely more light than one arm, while
    // opaque lets one quad win. The margin is the claim: the overlap is a SUM.
    expect(additive(128, 128)).toBeGreaterThan(armAdditive * 1.5);
    expect(opaque(128, 128)).toBeLessThanOrEqual(armOpaque * 1.25 + 8);
  });
});
