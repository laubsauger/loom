import { describe, expect, it } from "vitest";
import { DEFAULT_POINT_ATTRIBUTES } from "../../../nodes/definitions/points.ts";
import { readPointAttribute } from "../../../nodes/definitions/test-support.ts";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T300 on a REAL device, on VALUES (§V218's lesson applied from the start): the group
 * predicate must gate the kernel PER POINT — members transformed, non-members
 * byte-identical — which a mechanism test (the predicate text made it into the module)
 * cannot prove. Even slots move to x = 5, odd slots keep their zeros, exactly.
 */

const MARK_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(5.0, 5.0, 5.0);
  return q;
}`;

describe("group predicate end to end on Dawn (T300)", () => {
  it("transforms exactly the members; non-members pass through untouched", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          sim: {
            id: "sim",
            type: "pointKernel",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: { capacity: 8, seed: 7, kernel: MARK_KERNEL, group: "ctx.index % 2u == 0u" },
          },
          draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 8 } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "sim", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: {
        outputResolution: { width: 64, height: 64 },
        workingFormat: "rgba8unorm",
        randomSeed: 7,
        previewLongEdge: 192,
        previewFps: 20,
        limits: { maxResolution: 4096, maxDispatch: 65535, maxBufferBytes: 268_435_456, memoryBudgetBytes: 1_073_741_824 },
      },
      registry,
      capabilities: {
        tier: "B",
        features: [],
        formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float"],
        timestampQuery: false,
        limits: { maxTextureDimension2D: 8192 },
      },
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);

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

      // Post-swap the read half is this frame's writes. Members marked, the rest zero.
      /* T1076: the default schema's `position` is region 0 of the kernel's packed
         buffer — read it through the layout rather than assuming that. */
      const positions = (
        await readPointAttribute(backend.readBuffer, "sim", DEFAULT_POINT_ATTRIBUTES, 8, "position")
      ).floats;
      for (let slot = 0; slot < 8; slot += 1) {
        const expected = slot % 2 === 0 ? 5 : 0;
        expect(positions[slot * 4], `slot ${slot} x`).toBeCloseTo(expected, 5);
        expect(positions[slot * 4 + 1], `slot ${slot} y`).toBeCloseTo(expected, 5);
      }
    } finally {
      backend.dispose();
    }
  });
});
