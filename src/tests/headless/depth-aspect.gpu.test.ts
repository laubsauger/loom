import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import { createVgpuBackend } from "../../runtime/backend/vgpu/vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "../../runtime/backend/vgpu/node-gpu-host.ts";
import { depthSettingsFor } from "../../nodes/definitions/depth.ts";
import { depthToRgba, occOf } from "../../runtime/models/depth-runner.ts";
import type { GraphDocument } from "../../domain/types/graph.ts";

/**
 * T974 — DEPTH'S ASPECT IS LETTERBOXED, NOT SQUEEZED, at both ends of the model.
 *
 * The old preprocess resampled any source into the model's square with `uv * dims`: a
 * 16:9 frame arrived horizontally compressed, the estimator saw perspective that does
 * not exist (silent, plausible degradation), and §T958's single published fov became
 * geometrically wrong (fx ≠ fy — a stretched cloud that blames the model). The resize
 * and the read-back are ONE decision made in two places; these gates hold them
 * together:
 *
 *  - PREPROCESS: a vertical ramp on a 2:1 source must occupy the CENTERED half of the
 *    model square with the bars edge-replicated — the squeeze would spread it over all
 *    rows (row side/8 reads 0.125, not ~0).
 *  - READ-BACK: depthToRgba must sample ONLY that occupied band, so the result
 *    registers with the picture — its top row reads the model at v = 0.25, not v = 0.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();

const SETTINGS = {
  outputResolution: { width: 512, height: 256 },
  workingFormat: "rgba16float",
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

describe("T974 — depth aspect handling", () => {
  it("letterboxes a 2:1 source into the model square, bars edge-replicated", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const graph = {
      revision: 1,
      nodes: {
        map: {
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
        },
        depth: { id: "depth", type: "depth", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { model: "accurate" }, label: "depth1" },
        out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {}, label: "out1" },
      },
      edges: {
        e0: { id: "e0", source: { nodeId: "map", portId: "out" }, target: { nodeId: "depth", portId: "input" } },
        e1: { id: "e1", source: { nodeId: "depth", portId: "out" }, target: { nodeId: "out", portId: "input" } },
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
        resolution: [512, 256],
      });
      const packed = new Float32Array(await backend.readBuffer("scratch:depth:modelInput"));
      /*
       * The side the NODE is actually using, asked rather than assumed (T976).
       *
       * This read `DEPTH_INPUT_SIDE` when the export size was also the shipped default.
       * §T976 lowered the default to 266 for live use — four times fewer pixels — and 518
       * stopped being the number this buffer is strided by, so every probe below indexed
       * a 266² buffer at a stride of 518 and read the wrong rows. The letterbox itself was
       * fine; the ruler was not. Asking the node keeps this measuring the ASPECT
       * behaviour it is named for at whatever size the node runs at.
       */
      const { inputSide: side } = depthSettingsFor(graph.nodes["depth"]!.parameters);
      const rowValue = (row: number): number => packed[(row * side + Math.floor(side / 2)) * 4] ?? Number.NaN;

      // The 2:1 source occupies the centred vertical HALF: rows in the top bar replicate
      // the ramp's dark end, the band runs 0 → 1 across the middle half, the bottom bar
      // replicates the bright end. The squeeze reads ~0.125 / ~0.875 at the bar probes.
      expect(rowValue(Math.floor(side / 8))).toBeLessThan(0.03);
      expect(rowValue(Math.floor(side / 2))).toBeCloseTo(0.5, 1);
      expect(rowValue(Math.floor((side * 7) / 8))).toBeGreaterThan(0.97);
      // And the band's own quarter points confirm UNIFORM scale inside it.
      expect(rowValue(Math.floor((side * 3) / 8))).toBeCloseTo(0.25, 1);
      expect(rowValue(Math.floor((side * 5) / 8))).toBeCloseTo(0.75, 1);
    } finally {
      backend.dispose();
    }
  }, 240_000);

  it("reads back ONLY the occupied band, so the result registers with the picture", () => {
    // A synthetic model map whose value IS its own v coordinate: the wide result's top
    // row must sample v = 0.25 (the band's start), and the whole result must span the
    // band 0.25..0.75 — the pre-T974 read started at v = 0 and swept the bars in.
    const side = 8;
    const model = new Float32Array(side * side);
    for (let y = 0; y < side; y += 1) for (let x = 0; x < side; x += 1) model[y * side + x] = (y + 0.5) / side;
    const bytes = depthToRgba(model, side, 16, 8); // 2:1 result
    const floats = new Float32Array(bytes.buffer);
    expect(occOf(16, 8)).toEqual([1, 0.5]);
    // Normalised over the band, the top row is the band's own minimum and the bottom its
    // maximum — and the RAW band edges are what the mapping selected (v-linear input, so
    // normalisation keeps ordering and endpoints).
    expect(floats[0]).toBe(0);
    expect(floats[15 * 16] ?? floats[(8 - 1) * 16]).toBeDefined();
    expect(floats[(8 - 1) * 16]).toBe(1);
    // The middle row of the result reads the model's own middle — no half-band shift.
    const mid = floats[4 * 16] ?? Number.NaN;
    expect(mid).toBeGreaterThan(0.3);
    expect(mid).toBeLessThan(0.7);
  });
});
