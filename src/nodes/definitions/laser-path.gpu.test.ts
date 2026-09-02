import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";

/**
 * Laser Path (T947) on Dawn — THE PLAN'S ARITHMETIC, EXACTLY.
 *
 * The fixture is a unit square whose coordinates are exact in f32 (±0.5, axis-aligned
 * sides of length 1), so every quantity below is derivable by hand with no tolerance:
 * a 90° corner's steepness is exactly 0.5 (dot of exact unit vectors is exactly 0), a
 * side at maxStep 0.26 subdivides into exactly 4 steps, and every subdivision lerp
 * lands on an exact quarter. §V147: exact or analytically derived, never bands.
 *
 * The scan-window test is the row's honesty claim: an over-budget plan is not clamped
 * and not fully drawn — each frame lights exactly the pps × dt slice at the cursor,
 * which is WHY an overdriven scanner flickers. The lit set is asserted per slot from
 * the cursor arithmetic.
 */

const SETTINGS = {
  outputResolution: { width: 64, height: 64 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as const;

const CAPABILITIES = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
} as never;

/* Slot i of 4 → the unit square's corners, counter-clockwise, exact in f32. */
const SQUARE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let i = ctx.index % 4u;
  var x = -0.5;
  var y = -0.5;
  if (i == 1u) { x = 0.5; }
  if (i == 2u) { x = 0.5; y = 0.5; }
  if (i == 3u) { y = 0.5; }
  q.position = vec3f(x, y, 0.0);
  return q;
}`;

const ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
]);

const SLOTS = 16;
const CAPACITY = 4;
const OUT_CAPACITY = CAPACITY * SLOTS;

// The square at maxStep 0.26, holdMin 0, holdMax 8: every corner is 90°, steepness
// exactly 0.5, hold = round(8 · 0.5) = 4; every side has length exactly 1, so
// subdiv = ceil(1/0.26) − 1 = 3. Per point: 1 + 4 + 3 = 8 samples; the plan is 32.
const HOLD = 4;
const SUBDIV = 3;
const PER_POINT = 1 + HOLD + SUBDIV;
const TOTAL = CAPACITY * PER_POINT;

const CORNERS: ReadonlyArray<readonly [number, number]> = [
  [-0.5, -0.5],
  [0.5, -0.5],
  [0.5, 0.5],
  [-0.5, 0.5],
];

function graphWith(pps: number) {
  return {
    revision: 1,
    nodes: {
      gen: {
        id: "gen",
        type: "pointKernel",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { capacity: CAPACITY, seed: 7, attributes: ATTRIBUTES, kernel: SQUARE_KERNEL },
        label: "gen1",
      },
      plan: {
        id: "plan",
        type: "laserPath",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: {
          pps,
          maxStep: 0.26,
          holdMin: 0,
          holdMax: 8,
          closed: true,
          color: [1, 0.5, 0.25, 1],
          slots: SLOTS,
        },
        label: "plan1",
      },
      draw: {
        id: "draw",
        type: "renderPoints",
        definitionVersion: 1,
        position: { x: 0, y: 0 },
        parameters: { count: OUT_CAPACITY, sizePixels: 2 },
        label: "draw1",
      },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "out1" },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "gen", portId: "out" }, target: { nodeId: "plan", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "plan", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
      e3: { id: "e3", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

async function renderAt(pps: number, timeSeconds: number) {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const plan = compileGraph({ graph: graphWith(pps) as never, settings: SETTINGS as never, registry, capabilities: CAPABILITIES });
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const backend = createVgpuBackend({ host: nodeGpuHost() });
  const errors: string[] = [];
  backend.onDiagnostic((d) => {
    if (d.severity === "error") errors.push(`${d.code}: ${d.message}`);
  });
  try {
    await backend.initialize({});
    const compiled = await backend.compile(plan);
    backend.render(compiled, {
      frame: { timeSeconds, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    });
    expect(errors).toEqual([]);
    return {
      total: new Uint32Array(await backend.readBuffer("scratch:plan:total")),
      position: new Float32Array(await backend.readBuffer("scratch:plan:position")),
      tint: new Float32Array(await backend.readBuffer("scratch:plan:tint")),
      meta: new Float32Array(await backend.readBuffer("scratch:plan:meta")),
    };
  } finally {
    backend.dispose();
  }
}

describe("laserPath end to end on Dawn (T947)", () => {
  it("plans the square exactly: 4 corner dwells + 3 subdivisions per point, phase-ordered, tail parked", async () => {
    const read = await renderAt(96000, 0); // budget 1600 ≥ 32: the whole plan is lit
    expect(read.total[0]).toBe(TOTAL);

    for (let point = 0; point < CAPACITY; point += 1) {
      const [cx, cy] = CORNERS[point]!;
      const [nx, ny] = CORNERS[(point + 1) % CAPACITY]!;
      for (let j = 0; j < PER_POINT; j += 1) {
        const slot = point * PER_POINT + j;
        const base = slot * 4;
        if (j <= HOLD) {
          // 1 + HOLD coincident samples AT the corner — the dwell that makes the
          // corner hot. Nobody draws a dot; five samples deposit five ticks here.
          expect(read.position[base], `slot ${slot} x`).toBe(cx);
          expect(read.position[base + 1], `slot ${slot} y`).toBe(cy);
          expect(read.meta[slot * 2], `slot ${slot} dwell`).toBe(HOLD + 1);
        } else {
          // Subdivisions at exact quarters of the outgoing side.
          const t = (j - HOLD) / (SUBDIV + 1);
          expect(read.position[base], `slot ${slot} x`).toBe(cx + (nx - cx) * t);
          expect(read.position[base + 1], `slot ${slot} y`).toBe(cy + (ny - cy) * t);
          expect(read.meta[slot * 2], `slot ${slot} dwell`).toBe(1);
        }
        // The whole plan is inside the budget, so every sample is lit this frame.
        expect(read.tint[base], `slot ${slot} r`).toBe(1);
        expect(read.tint[base + 3], `slot ${slot} a`).toBe(1);
        // Phase is the sample's place in the scan, monotone across the plan.
        expect(read.meta[slot * 2 + 1], `slot ${slot} phase`).toBe(slot / TOTAL);
      }
    }
    // Slots past the plan's total are parked and dark.
    for (let slot = TOTAL; slot < OUT_CAPACITY; slot += 1) {
      expect(read.position[slot * 4 + 2], `slot ${slot} parked z`).toBe(-1.0e6);
      expect(read.tint[slot * 4 + 3], `slot ${slot} parked a`).toBe(0);
    }
  }, 240_000);

  it("over budget, a frame lights EXACTLY the pps × dt slice at the cursor — the honest flicker", async () => {
    // pps 600 at 1/60 s → a 10-sample window against a 32-sample plan: the square
    // cannot be drawn in one frame, which is precisely the overdriven-scanner state.
    const litSlots = (read: Awaited<ReturnType<typeof renderAt>>): number[] => {
      const lit: number[] = [];
      for (let slot = 0; slot < TOTAL; slot += 1) if (read.tint[slot * 4 + 3] === 1) lit.push(slot);
      return lit;
    };

    const atZero = await renderAt(600, 0); // cursor floor(0·600) % 32 = 0
    expect(litSlots(atZero)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const later = await renderAt(600, 0.1); // cursor floor(60) % 32 = 28 → wraps
    expect(litSlots(later)).toEqual([0, 1, 2, 3, 4, 5, 28, 29, 30, 31]);
  }, 240_000);
});
