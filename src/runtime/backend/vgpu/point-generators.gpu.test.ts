import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T298 on a REAL device: a generator's positions read back as floats and proven
 * analytically — every Fibonacci-sphere point sits ON the sphere, |p| = radius — then
 * drawn through renderPoints to show the T296 edge map carries the generator's pair to
 * a consumer that binds it by id. Exact-value assertions per §V147: a radius band that
 * "roughly holds" would tolerate a wrong shape.
 */

describe("point generators end to end on Dawn (T298)", () => {
  it("sphere positions have |p| = radius, and they draw", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          gen: { id: "gen", type: "pointSphere", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 256, radius: 1.5 } },
          draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 256, sizePixels: 4 } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "gen", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
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
      for (let frameIndex = 0; frameIndex < 2; frameIndex += 1) {
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });
      }
      expect(errors).toEqual([]);

      const raw = await backend.readBuffer("scratch:gen:position");
      const positions = new Float32Array(raw);
      expect(positions.length).toBeGreaterThanOrEqual(256 * 4);
      for (let point = 0; point < 256; point += 1) {
        const base = point * 4; // vec3f strides at 16 bytes
        const x = positions[base] ?? 0;
        const y = positions[base + 1] ?? 0;
        const z = positions[base + 2] ?? 0;
        expect(Math.hypot(x, y, z), `point ${point}`).toBeCloseTo(1.5, 4);
      }
      // Fibonacci coverage, not a degenerate ring: both hemispheres populated.
      const ys = Array.from({ length: 256 }, (_, point) => positions[point * 4 + 1] ?? 0);
      expect(Math.min(...ys)).toBeLessThan(-0.9);
      expect(Math.max(...ys)).toBeGreaterThan(0.9);

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
