import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { RAY_ATTRIBUTES } from "../../../nodes/definitions/points.ts";
import { pointStorageId } from "../../../nodes/definitions/point-storage.ts";
import { pointRegionSlice } from "../../../nodes/definitions/test-support.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";
import type { GraphDocument } from "../../../domain/types/graph.ts";

/**
 * T483 on a REAL device, §V147-exact by construction: a FLAT height field makes the
 * secant refinement exact (the surface is globally linear), so the hit height, the
 * travelled distance and the normal are all closed-form numbers — and a ray aimed
 * where no surface is proves the miss contract with the same precision.
 */

const SETTINGS = {
  outputResolution: { width: 8, height: 8 },
  workingFormat: "rgba8unorm",
  randomSeed: 7,
  previewLongEdge: 192,
  previewFps: 20,
  limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
} as never;

function rayGraph(): GraphDocument {
  const node = (id: string, type: string, parameters: Record<string, unknown>, label: string) => ({
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
    label,
  });
  return {
    revision: 1,
    nodes: Object.fromEntries(
      [
        // The field: solid white — display 1 decodes to linear 1, a fixed point — so
        // the surface is exactly y = 1 × 0.5 + 0 = 0.5, everywhere.
        node("terrain", "solid", { color: [1, 1, 1, 1] }, "terrain1"),
        node("src", "pointKernel", {
          capacity: 4,
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
          ]),
          // Point 0 starts at (0, 2, 0) and rains down onto the y = 0.5 plate; the
          // rest start BELOW the surface, so their rays never cross it from above.
          kernel:
            "fn process(p: Point, ctx: PointCtx) -> Point {\n  var q = p;\n  q.position = select(vec3f(0.0, -3.0, 0.0), vec3f(0.0, 2.0, 0.0), ctx.index == 0u);\n  return q;\n}",
        }, "src1"),
        node("ray", "pointRay", { steps: 32, maxDistance: 4, heightScale: 0.5 }, "ray1"),
        node("draw", "renderPoints", { count: 4 }, "draw1"),
        node("out", "output", {}, "out1"),
      ].map((entry) => [entry.id, entry]),
    ),
    edges: {
      e1: { id: "e1", source: { nodeId: "src", portId: "out" }, target: { nodeId: "ray", portId: "points" } },
      e2: { id: "e2", source: { nodeId: "terrain", portId: "out" }, target: { nodeId: "ray", portId: "field" } },
      e3: { id: "e3", source: { nodeId: "ray", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
      e4: { id: "e4", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  } as never;
}

describe("pointRay hits a flat field exactly (T483, §V147)", () => {
  it("the falling ray lands on y = 0.5 at distance 1.5 with an up normal; the buried one misses", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);
    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: rayGraph(),
      settings: SETTINGS,
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      } as never,
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const backend = createVgpuBackend({ host: nodeGpuHost() });
    try {
      await backend.initialize({});
      const compiled = await backend.compile(plan);
      backend.render(compiled, {
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 7 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [8, 8],
      });

      /* T1076: ONE readback of the ray node's packed buffer; each result is a region of
         it, sliced by the same layout the node allocated with. */
      const packed = await backend.readBuffer(pointStorageId("ray"));
      const region = (name: string) => pointRegionSlice(packed, RAY_ATTRIBUTES, 4, name).floats;
      const hits = region("hit");
      const positions = region("hitPosition");
      const normals = region("hitNormal");
      const distances = region("hitDistance");

      // Point 0: origin (0, 2, 0), straight down onto y = 0.5. A flat surface makes
      // the secant EXACT: hit height 0.5, distance 1.5, normal straight up.
      expect(hits[0]).toBe(1);
      expect(positions[1]).toBeCloseTo(0.5, 5); // vec3f stride 16: [x, y, z, pad]
      expect(distances[0]).toBeCloseTo(1.5, 5);
      expect([normals[0], normals[1], normals[2]]).toEqual([0, 1, 0]);

      // Point 1 starts under the surface: no above→below crossing, so a MISS — the
      // ray's end, the full distance, and the sentinel-free flag.
      expect(hits[1]).toBe(0);
      expect(distances[1]).toBe(4);
      expect(positions[4 + 1]).toBeCloseTo(-3 - 4, 5); // y = origin − maxDistance
    } finally {
      backend.dispose();
    }
  }, 120_000);
});
