import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T299 on a REAL device: generator → renderInstances → output through the whole
 * stack. What this pins beyond "it draws": the `depthOutputs` declaration actually
 * reaches the plan as a depth-attached target (the compiler seam, through the REAL
 * compiler), and the image is genuinely SHADED 3D — many distinct lit intensities,
 * which flat unlit billboards cannot produce.
 */

describe("renderInstances end to end on Dawn (T299)", () => {
  it("draws depth-tested shaded boxes on a sphere of points", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          gen: { id: "gen", type: "pointSphere", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 128, radius: 1 } },
          draw: { id: "draw", type: "renderInstances", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 128, shape: "box", scale: 0.12 } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "gen", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
        },
        groups: {},
      },
      settings: {
        outputResolution: { width: 96, height: 96 },
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

    // The compiler seam: `depthOutputs: ["out"]` materialized a depth-attached target.
    const drawTarget = plan.outputs.find((output) => output.nodeId === "draw");
    expect(drawTarget).toBeDefined();
    const descriptor = plan.resources.find((resource) => resource.id === drawTarget?.resourceId);
    expect(descriptor).toMatchObject({ kind: "target", depth: true });

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
          resolution: [96, 96],
        });
      }
      expect(errors).toEqual([]);

      const image = await backend.readOutput(drawTarget?.resourceId ?? "");
      let litPixels = 0;
      const intensities = new Set<number>();
      for (let index = 0; index < image.bytes.byteLength; index += 4) {
        const red = image.bytes[index] ?? 0;
        if (red > 0) {
          litPixels += 1;
          intensities.add(red);
        }
      }
      expect(litPixels).toBeGreaterThan(0);
      expect(litPixels).toBeLessThan(96 * 96);
      // Per-face lambert: every box is axis-aligned (rotate = 0), so the eye at +z
      // sees exactly THREE face orientations (+z, ±one lateral pair toward the light)
      // — three distinct intensities, no more, no fewer. An unshaded path collapses
      // to one; a per-pixel-noise path explodes past six.
      expect(intensities.size).toBe(3);
    } finally {
      backend.dispose();
    }
  });
});
