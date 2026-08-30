import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions, liveCountBufferId } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T322 on a REAL device, asserted on VALUES (the orchestrated condition): a same-frame
 * consumer of an advanced kernel must see the COMPACTED data. Which buffer id got
 * bound is the mechanism; a build binding the right id to STALE values would pass a
 * mechanism test and lie — so this reads the numbers back and matches them against the
 * analytically-known survivors, plus the live count, plus pixels through the whole
 * indirect draw path.
 *
 * The kernel: ids self-seed from the slot on frame zero, positions are a pure function
 * of id, odd ids die. Survivors are exactly ids 0,2,4,6 in order (scan compaction is
 * order-preserving and deterministic, §V74), forever after frame zero.
 */

const TEST_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  if (ctx.frameIndex == 0u) {
    q.id = ctx.index;
  }
  q.position = vec3f(f32(q.id) * 0.2 - 0.7, 0.0, 0.0);
  q.velocity = vec3f(0.0);
  if (q.id % 2u == 1u) {
    q.alive = 0u;
  }
  return q;
}`;

describe("advanced kernel end to end on Dawn (T322)", () => {
  it("kills odd ids; the consumer sees exactly the survivors, by value", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          sim: { id: "sim", type: "pointKernelAdvanced", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 8, seed: 7, kernel: TEST_KERNEL } },
          draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 8, sizePixels: 6 } },
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
      for (let frameIndex = 0; frameIndex < 3; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
      }
      expect(errors).toEqual([]);

      // The live count: 8 born, 4 killed on frame zero, stable thereafter.
      const countRaw = await backend.readBuffer(liveCountBufferId("sim"));
      expect(new Uint32Array(countRaw)[0]).toBe(4);

      // THE VALUES. readBuffer reads the pair's read half — where scatter landed the
      // survivors, and exactly what the edge map told the consumer to bind. Survivors
      // are ids 0,2,4,6 in slot order; position.x = id * 0.2 - 0.7 by construction.
      const positions = new Float32Array(await backend.readBuffer("scratch:sim:position"));
      const survivors = [0, 2, 4, 6];
      survivors.forEach((id, slot) => {
        expect(positions[slot * 4], `slot ${slot} (id ${id})`).toBeCloseTo(id * 0.2 - 0.7, 5);
        expect(positions[slot * 4 + 1], `slot ${slot} y`).toBeCloseTo(0, 5);
      });
      // Ids rode the compaction with their points (§V73).
      const ids = new Uint32Array(await backend.readBuffer("scratch:sim:id"));
      expect([...ids.slice(0, 4)]).toEqual(survivors);

      // And the whole indirect path draws: four sprites, not eight, not zero.
      const renderTarget = plan.outputs.find((output) => output.nodeId === "draw");
      const image = await backend.readOutput(renderTarget?.resourceId ?? "");
      let litPixels = 0;
      for (let index = 0; index < image.bytes.byteLength; index += 4) {
        if ((image.bytes[index] ?? 0) > 0) litPixels += 1;
      }
      expect(litPixels).toBeGreaterThan(0);
      expect(litPixels).toBeLessThan(64 * 64);
    } finally {
      backend.dispose();
    }
  });
});
