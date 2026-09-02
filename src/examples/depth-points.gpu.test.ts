import { describe, expect, it } from "vitest";

import { compileGraph } from "../compiler/index.ts";
import { createNodeRegistry } from "../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../nodes/definitions/index.ts";
import { createVgpuBackend } from "../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../runtime/backend/vgpu/node-gpu-host.ts";
import type { GraphDocument } from "../domain/types/graph.ts";
import { DEPTH_CARVE_KERNEL, DEPTH_PAINT_KERNEL } from "./shaders/depth-points.wgsl.ts";

/**
 * T958 — the DepthPoints component's physics, against float64 and against its own
 * modes (§V683's discipline: the domain, not the kernel's own text).
 *
 *  - UNPROJECTION IS PERSPECTIVE: with a CONSTANT depth map the cloud is a flat sheet
 *    whose half-width is exactly tan(fov/2)·aspect·metres·displace — the scene spreads
 *    with distance, which is what separates "proper" from a relief carving. The
 *    heightfield mode, same input, keeps the fixed ±1 footprint.
 *  - THE ENCODING IS DECLARED, NOT ASSUMED: on a vertical gradient, flipping
 *    inverseDepth inverts which edge of the map lands closer — the §T958 trap (ML
 *    disparity vs metric depth) surfaced as a knob with a measurable consequence.
 *  - RETEXTURING REGISTERS: each point's tint is the colour texel at its own grid uv,
 *    asserted against the ramp the colour input actually is.
 */

const GRID = 16;
const CAPACITY = GRID * GRID;
const registry = createNodeRegistry(allNodeDefinitions).view();

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

const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "depthN", type: "f32", default: [0] },
]);

interface CarveParams {
  readonly unproject: number;
  readonly fov: number;
  readonly inverseDepth: number;
  readonly near: number;
  readonly far: number;
  readonly displace: number;
}

/** depth ramp → carve → paint (colour ramp) → draw, returning positions and tints. */
async function runCloud(
  carve: CarveParams,
  depthStops: ReadonlyArray<{ position: number; color: readonly [number, number, number, number] }>,
): Promise<{ positions: Float32Array; tints: Float32Array }> {
  const ramp = (id: string, stops: unknown, label: string) => ({
    id,
    type: "ramp",
    definitionVersion: 2,
    position: { x: 0, y: 0 },
    parameters: { type: "vertical", interp: "linear", phase: 0, period: 1, stops },
    label,
  });
  const graph = {
    revision: 1,
    nodes: {
      depthmap: ramp("depthmap", depthStops, "depthmap1"),
      colour: {
        ...ramp(
          "colour",
          [
            { position: 0, color: [0, 0, 0, 1] },
            { position: 1, color: [1, 1, 1, 1] },
          ],
          "colour1",
        ),
        parameters: { type: "horizontal", interp: "linear", phase: 0, period: 1, stops: [
          { position: 0, color: [0, 0, 0, 1] },
          { position: 1, color: [1, 1, 1, 1] },
        ] },
      },
      grid: {
        id: "grid",
        type: "pointGrid",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { count: CAPACITY, cols: GRID, rows: GRID, sizeX: 2, sizeY: 2 },
        label: "grid1",
      },
      carve: {
        id: "carve",
        type: "pointKernel",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { capacity: CAPACITY, seed: 7, attributes: ATTRIBUTES, kernel: DEPTH_CARVE_KERNEL, ...carve },
        label: "carve1",
      },
      paint: {
        id: "paint",
        type: "pointKernel",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { capacity: CAPACITY, seed: 7, attributes: ATTRIBUTES, kernel: DEPTH_PAINT_KERNEL, gain: 1, heat: 0 },
        label: "paint1",
      },
      draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "draw1" },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "out1" },
    },
    edges: {
      e0: { id: "e0", source: { nodeId: "depthmap", portId: "out" }, target: { nodeId: "carve", portId: "field" } },
      e1: { id: "e1", source: { nodeId: "colour", portId: "out" }, target: { nodeId: "paint", portId: "field" } },
      e2: { id: "e2", source: { nodeId: "grid", portId: "out" }, target: { nodeId: "carve", portId: "in" } },
      e3: { id: "e3", source: { nodeId: "carve", portId: "out" }, target: { nodeId: "paint", portId: "in" } },
      e4: { id: "e4", source: { nodeId: "paint", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
      e5: { id: "e5", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never as GraphDocument;

  const plan = compileGraph({ graph, settings: SETTINGS, registry, capabilities: CAPABILITIES });
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    });
    return {
      positions: new Float32Array(await backend.readBuffer("scratch:paint:position")),
      tints: new Float32Array(await backend.readBuffer("scratch:paint:tint")),
    };
  } finally {
    backend.dispose();
  }
}

const FLAT_WHITE = [
  { position: 0, color: [1, 1, 1, 1] as const },
  { position: 1, color: [1, 1, 1, 1] as const },
];
const GRADIENT = [
  { position: 0, color: [0, 0, 0, 1] as const },
  { position: 1, color: [1, 1, 1, 1] as const },
];

const at = (buffer: Float32Array, index: number): [number, number, number] => [
  buffer[index * 4] ?? 0,
  buffer[index * 4 + 1] ?? 0,
  buffer[index * 4 + 2] ?? 0,
];

describe("the DepthPoints kernels (T958)", () => {
  it("unprojects a constant map into a sheet exactly tan(fov/2)·metres wide — and the heightfield does not spread", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const base: CarveParams = { unproject: 1, fov: 60, inverseDepth: 0, near: 0.5, far: 4, displace: 1 };
    // A WHITE linear map decodes to exactly `far` metres everywhere.
    const { positions } = await runCloud(base, FLAT_WHITE);
    // The grid's corner point sat at clip (±(1), ±(1)) scaled by (cols-1)/cols spacing;
    // read the actual grid xy back from the ray arithmetic instead: x = px·tan(30°)·aspect·m.
    // The depth ramp renders square here, so aspect = 1.
    const tanHalf = Math.tan((60 * Math.PI) / 360);
    for (const index of [0, GRID - 1, CAPACITY - 1, (GRID / 2) * GRID + GRID / 2]) {
      const [x, y, z] = at(positions, index);
      // Recover the grid clip position this index was generated at from the unprojection
      // itself being linear: x / (tanHalf·m) must land within the clip square …
      expect(Math.abs(x)).toBeLessThanOrEqual(tanHalf * 4 * 1.0001);
      expect(Math.abs(y)).toBeLessThanOrEqual(tanHalf * 4 * 1.0001);
      // … and every point sits on ONE plane: z = −m + mid (the sheet), exactly.
      expect(z).toBeCloseTo(-4 + (0.5 + 4) / 2, 4);
    }
    // The sheet's total width is 2·tan(fov/2)·m — the perspective claim, in numbers.
    let minX = Infinity;
    let maxX = -Infinity;
    for (let i = 0; i < CAPACITY; i += 1) {
      const [x] = at(positions, i);
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
    }
    expect(maxX - minX).toBeCloseTo(2 * tanHalf * 4, 3);

    // HEIGHTFIELD, same map: the footprint stays the grid's own ±1 — no spread.
    const { positions: relief } = await runCloud({ ...base, unproject: 0 }, FLAT_WHITE);
    let reliefMax = -Infinity;
    for (let i = 0; i < CAPACITY; i += 1) reliefMax = Math.max(reliefMax, Math.abs(at(relief, i)[0]));
    expect(reliefMax).toBeLessThanOrEqual(1.0001);
  }, 240_000);

  it("declares the encoding: flipping inverseDepth inverts which edge lands closer", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const base: CarveParams = { unproject: 1, fov: 60, inverseDepth: 1, near: 0.5, far: 4, displace: 1 };
    /* fieldAt inverts y (world +y up, texel row 0 top): the grid's FIRST index sits at
       clip y = -1 and samples the vertical ramp's stop-1 end — the BRIGHT end. */
    const bright = 0;
    const dark = CAPACITY - 1;

    const inverse = (await runCloud(base, GRADIENT)).positions;
    const linear = (await runCloud({ ...base, inverseDepth: 0 }, GRADIENT)).positions;

    // Inverse: bright = CLOSE (larger z, toward the viewer). Linear: bright = FAR.
    const dzInverse = at(inverse, bright)[2] - at(inverse, dark)[2];
    const dzLinear = at(linear, bright)[2] - at(linear, dark)[2];
    expect(dzInverse).toBeGreaterThan(0.5);
    expect(dzLinear).toBeLessThan(-0.5);
  }, 240_000);

  it("retextures in register: each point's tint is the colour ramp at its own u", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const base: CarveParams = { unproject: 1, fov: 60, inverseDepth: 1, near: 0.5, far: 4, displace: 1 };
    const { tints } = await runCloud(base, FLAT_WHITE);
    // The colour input is a horizontal black→white ramp: tint tracks u monotonically
    // across a row and spans a real range (a broken uv would flatten or shuffle it).
    const row = (GRID / 2) * GRID;
    let previous = -1;
    for (let i = 0; i < GRID; i += 1) {
      const r = tints[(row + i) * 4] ?? 0;
      expect(r).toBeGreaterThanOrEqual(previous - 0.02);
      previous = Math.max(previous, r);
    }
    expect((tints[(row + GRID - 1) * 4] ?? 0) - (tints[row * 4] ?? 0)).toBeGreaterThan(0.6);
  }, 240_000);
});
