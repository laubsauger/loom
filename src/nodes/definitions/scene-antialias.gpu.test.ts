import { beforeAll, describe, expect, it } from "vitest";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { renderHeadless } from "../../tests/headless/render-harness.ts";
import { toRgba8 } from "../../runtime/export/image.ts";
import { BYTES_PER_PIXEL } from "../../runtime/export/pixel-format.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";

/**
 * T939 — ANTIALIASING on the scene target (2x SSAA + box resolve), measured as what it
 * IS: intermediate coverage.
 *
 * A hard-edged diagonal beam aliases into a staircase — every scanline crosses the edge
 * in ONE pixel, full-bright to black, no values between. With `antialias: true` the
 * whole scene renders at 2x and box-resolves, so the edge crossing carries partial
 * coverage: pixels BETWEEN dark and bright appear. The claim is differential and
 * two-sided, so neither a broken resolve (all dark / all bright) nor a no-op flag
 * (identical images) can pass it.
 *
 * Two modes, one instrument: MSAA 4x (hardware coverage samples — needs the repo's
 * vgpu patch, which stores multisample attachments across the chain's preserve passes
 * and resolves every pass) and SSAA 2x (the scene at double resolution, box-resolved —
 * four SHADED samples). Both must produce intermediates; "none" must produce none.
 */

const SETTINGS = {
  outputResolution: { width: 256, height: 256 },
  workingFormat: "rgba8unorm" as const,
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
};

/** One hard diagonal beam — the aliasing worst case a prism fan is made of. */
const DIAGONAL_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(-0.9, -0.7, 0.0);
  q.tip = vec3f(0.9, 0.7, 0.0);
  return q;
}`;

function graphFor(antialias: string): GraphDocument {
  const attributes = JSON.stringify([
    { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
    { name: "tip", type: "vec3f", default: [0, 0, 0] },
  ]);
  return {
    revision: 1,
    nodes: {
      gen: {
        id: "gen", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: { capacity: 1, seed: 7, group: "", attributes, kernel: DIAGONAL_KERNEL, value1: 0, value2: 0, value3: 0, value4: 0 },
        label: "gen1",
      },
      mat: { id: "mat", type: "materialUnlit", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { color: [1, 1, 1, 1] }, label: "mat1" },
      tile: {
        id: "tile", type: "geometry", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: { mode: "beam", endpoint: "tip", scale: 0.15, taper: 1, soft: 0, blend: "opaque", material: "mat1", tint: [1, 1, 1, 1] },
        label: "tile1",
      },
      eye: {
        id: "eye", type: "camera", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: { eye: [0, 0, 3], lookAt: [0, 0, 0], fov: 45, near: 0.1, far: 20, ortho: false },
        label: "eye1",
      },
      shot: {
        id: "shot", type: "render", definitionVersion: 1, position: { x: 0, y: 0 },
        parameters: { scenes: "tile1", camera: "eye1", lights: "", ambientColor: [0, 0, 0, 1], ambientIntensity: 0, background: [0, 0, 0, 1], antialias },
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

async function shoot(antialias: string): Promise<(x: number, y: number) => number> {
  const result = await renderHeadless({
    host: nodeGpuHost(),
    graph: graphFor(antialias),
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
  return (x, y) => image.data[(y * 256 + x) * 4] ?? 0;
}

/** Count columns whose top edge crossing holds at least one INTERMEDIATE pixel. */
function blendedColumns(read: (x: number, y: number) => number): number {
  let blended = 0;
  for (let x = 40; x < 216; x += 4) {
    let sawIntermediate = false;
    for (let y = 1; y < 255; y += 1) {
      const value = read(x, y);
      if (value > 24 && value < 216) sawIntermediate = true;
    }
    if (sawIntermediate) blended += 1;
  }
  return blended;
}

describe("T939 — SSAA antialias on the render target", () => {
  it("a hard diagonal edge gains intermediate coverage in BOTH aa modes, and has none without", async () => {
    if (dawnError !== undefined) return;
    const off = await shoot("none");
    const ssaa = await shoot("ssaa");
    const msaa = await shoot("msaa");

    // All three images actually contain the beam — a black frame proves nothing.
    expect(off(128, 128)).toBeGreaterThan(200);
    expect(ssaa(128, 128)).toBeGreaterThan(200);
    expect(msaa(128, 128)).toBeGreaterThan(200);

    // NONE: the staircase — sampled columns cross the edge with no in-between values.
    expect(blendedColumns(off)).toBe(0);
    // Each mode resolves genuinely intermediate pixels on most columns.
    expect(blendedColumns(ssaa)).toBeGreaterThan(20);
    expect(blendedColumns(msaa)).toBeGreaterThan(20);
  }, 240_000);
});
