import { describe, expect, it } from "vitest";
import { pointStorageId } from "./point-storage.ts";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";

/**
 * Range (T983) on a REAL device, asserted on what the consumer reads back: the output
 * position buffer. Exact values per §V147 — a kept point is the input's own bytes, a
 * dropped one is the park spot, and the expectation for every slot is DERIVED from the
 * read-back input rather than tolerated into a band.
 *
 * The partition test is §T983's design property made falsifiable: an inside and an
 * outside instance over ONE range must split the cloud with no point kept twice and
 * none lost — that is the contract §T979's backdrop-outside-the-subject's-slab builds
 * on. If the boundary rule drifted (say `>` where `>=` belongs), a lattice z that lands
 * exactly on the edge would vanish from both cohorts and this fails.
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

const RAMP = {
  id: "map",
  type: "ramp",
  definitionVersion: 2,
  position: { x: 0, y: 0 },
  parameters: {
    type: "vertical",
    interp: "linear",
    phase: 0,
    period: 1,
    stops: [
      { position: 0, color: [0, 0, 0, 1] },
      { position: 1, color: [1, 1, 1, 1] },
    ],
  },
  label: "map1",
};

const node = (id: string, type: string, parameters: Record<string, unknown>) => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters,
  label: `${id}1`,
});

const edge = (id: string, source: [string, string], target: [string, string]) => ({
  id,
  source: { nodeId: source[0], portId: source[1] },
  target: { nodeId: target[0], portId: target[1] },
});

const PARKED_Z = -1.0e6;
const COUNT = 256; // 16 × 16 grid

async function renderAndRead(
  graph: unknown,
  buffers: ReadonlyArray<string>,
): Promise<Record<string, Float32Array>> {
  const probe = await probeDawn();
  if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
  const registry = createNodeRegistry(allNodeDefinitions).view();
  const plan = compileGraph({ graph: graph as never, settings: SETTINGS as never, registry, capabilities: CAPABILITIES });
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
      frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
      pointer: { x: 0, y: 0, buttons: 0 },
      resolution: [64, 64],
    });
    expect(errors).toEqual([]);
    const read: Record<string, Float32Array> = {};
    for (const id of buffers) read[id] = new Float32Array(await backend.readBuffer(id));
    return read;
  } finally {
    backend.dispose();
  }
}

describe("pointRange end to end on Dawn (T983)", () => {
  it("a position.z slab: inside and outside instances partition the cloud EXACTLY", async () => {
    const slabGraph = (lo: number, hi: number) => ({
      revision: 1,
      nodes: {
        map: RAMP,
        pts: node("pts", "pointsFromTexture", { mode: "grid", cols: 16, rows: 16, sizeX: 2, sizeY: 2, depth: 1, threshold: 0 }),
        zin: node("zin", "pointRange", { attribute: "position", component: "z", from: lo, to: hi, mode: "inside" }),
        zout: node("zout", "pointRange", { attribute: "position", component: "z", from: lo, to: hi, mode: "outside" }),
        drawA: node("drawA", "renderPoints", { count: COUNT, sizePixels: 4 }),
        drawB: node("drawB", "renderPoints", { count: COUNT, sizePixels: 4 }),
        mix: node("mix", "add", {}),
        out: node("out", "output", {}),
      },
      edges: {
        e0: edge("e0", ["map", "out"], ["pts", "texture"]),
        e1: edge("e1", ["pts", "out"], ["zin", "points"]),
        e2: edge("e2", ["pts", "out"], ["zout", "points"]),
        e3: edge("e3", ["zin", "out"], ["drawA", "points"]),
        e4: edge("e4", ["zout", "out"], ["drawB", "points"]),
        e5: edge("e5", ["drawA", "out"], ["mix", "in1"]),
        e6: edge("e6", ["drawB", "out"], ["mix", "in2"]),
        e7: edge("e7", ["mix", "out"], ["out", "input"]),
      },
      groups: {},
    });

    /* T1076: each of these producers owns exactly ONE attribute, so its packed buffer IS
       that attribute's region — the generator's position, each Range's fresh position. */
    const BUFFERS = [pointStorageId("pts"), pointStorageId("zin"), pointStorageId("zout")];
    const read = await renderAndRead(slabGraph(0.25, 0.75), BUFFERS);
    const input = read[pointStorageId("pts")]!;
    const inside = read[pointStorageId("zin")]!;
    const outside = read[pointStorageId("zout")]!;

    const assertPartition = (
      inputs: Float32Array,
      kept: Float32Array,
      parked: Float32Array,
      inZone: (z: number) => boolean,
    ): void => {
      let held = 0;
      let gone = 0;
      for (let point = 0; point < COUNT; point += 1) {
        const base = point * 4; // vec3f strides at 16 bytes
        const z = inputs[base + 2]!;
        const [holder, parker] = inZone(z) ? [kept, parked] : [parked, kept];
        // The keeper republishes the input's own bytes — a copy, not a recomputation.
        expect(holder[base], `point ${point} x`).toBe(inputs[base]!);
        expect(holder[base + 1], `point ${point} y`).toBe(inputs[base + 1]!);
        expect(holder[base + 2], `point ${point} z`).toBe(z);
        // The other instance parks the same point: the cohorts never overlap.
        expect(parker[base + 2], `point ${point} parked z`).toBe(PARKED_Z);
        if (inZone(z)) held += 1;
        else gone += 1;
      }
      // Neither cohort may be empty, or every assertion above ran one-sided.
      expect(held).toBeGreaterThan(0);
      expect(gone).toBeGreaterThan(0);
    };
    assertPartition(input, inside, outside, (z) => z >= 0.25 && z <= 0.75);

    // THE BOUNDARY BELONGS TO INSIDE, pinned on values that LAND exactly on it: no
    // lattice z falls on 0.25, so the assertions above cannot see an off-by-inclusion
    // (`>` for `>=` passed them — measured). Re-render with the range's own edges set
    // to two read-back z values; the points carrying them must be INSIDE's, exactly.
    const zs = [...new Set(Array.from({ length: COUNT }, (_, p) => input[p * 4 + 2]!))].sort((a, b) => a - b);
    const lo = zs[Math.floor(zs.length / 4)]!;
    const hi = zs[Math.floor((zs.length * 3) / 4)]!;
    const exact = await renderAndRead(slabGraph(lo, hi), BUFFERS);
    assertPartition(
      exact[pointStorageId("pts")]!,
      exact[pointStorageId("zin")]!,
      exact[pointStorageId("zout")]!,
      (z) => z >= lo && z <= hi,
    );
  }, 240_000);

  it("a carried attribute (sample.x) selects through the in_attr binding path", async () => {
    const graph = {
      revision: 1,
      nodes: {
        map: RAMP,
        pts: node("pts", "pointsFromTexture", { mode: "grid", cols: 16, rows: 16, sizeX: 2, sizeY: 2, depth: 1, threshold: 0 }),
        tta: node("tta", "textureToAttribute", { count: COUNT }),
        zone: node("zone", "pointRange", { attribute: "sample", component: "x", from: 0.25, to: 0.75, mode: "inside" }),
        draw: node("draw", "renderPoints", { count: COUNT, sizePixels: 4 }),
        out: node("out", "output", {}),
      },
      edges: {
        e0: edge("e0", ["map", "out"], ["pts", "texture"]),
        e1: edge("e1", ["map", "out"], ["tta", "texture"]),
        e2: edge("e2", ["pts", "out"], ["tta", "points"]),
        e3: edge("e3", ["tta", "out"], ["zone", "points"]),
        e4: edge("e4", ["zone", "out"], ["draw", "points"]),
        e5: edge("e5", ["draw", "out"], ["out", "input"]),
      },
      groups: {},
    };

    const read = await renderAndRead(graph, [pointStorageId("pts"), pointStorageId("tta"), pointStorageId("zone")]);
    const positions = read[pointStorageId("pts")]!;
    const samples = read[pointStorageId("tta")]!;
    const output = read[pointStorageId("zone")]!;

    let kept = 0;
    let dropped = 0;
    for (let point = 0; point < COUNT; point += 1) {
      const base = point * 4;
      const value = samples[base]!; // sample.x — the tested component
      if (value >= 0.25 && value <= 0.75) {
        expect(output[base], `point ${point} x`).toBe(positions[base]!);
        expect(output[base + 1], `point ${point} y`).toBe(positions[base + 1]!);
        expect(output[base + 2], `point ${point} z`).toBe(positions[base + 2]!);
        kept += 1;
      } else {
        expect(output[base + 2], `point ${point} parked z`).toBe(PARKED_Z);
        dropped += 1;
      }
    }
    expect(kept).toBeGreaterThan(0);
    expect(dropped).toBeGreaterThan(0);
  }, 240_000);
});
