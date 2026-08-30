import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T301 on a REAL device: pointGrid → renderSurface → output. A FLAT grid facing +z is
 * the analytic case (§V147/§V218): every vertex normal is (0,0,1), so the whole lit
 * surface must land on EXACTLY ONE intensity — ambient + (1-ambient)·|z·L| — and it
 * must cover a large connected region, which unordered points cannot do. One number
 * checks shading, normals, topology unwrap and the camera at once.
 */

describe("renderSurface end to end on Dawn (T301)", () => {
  it("shades a flat grid as one continuous surface at the analytic intensity", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          gen: { id: "gen", type: "pointGrid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 1024, cols: 32, rows: 32 } },
          surf: { id: "surf", type: "renderSurface", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "gen", portId: "out" }, target: { nodeId: "surf", portId: "points" } },
          e2: { id: "e2", source: { nodeId: "surf", portId: "out" }, target: { nodeId: "out", portId: "input" } },
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

    const surfaceTarget = plan.outputs.find((output) => output.nodeId === "surf");
    const descriptor = plan.resources.find((resource) => resource.id === surfaceTarget?.resourceId);
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

      const image = await backend.readOutput(surfaceTarget?.resourceId ?? "");
      let litPixels = 0;
      const intensities = new Set<number>();
      for (let index = 0; index < image.bytes.byteLength; index += 4) {
        const red = image.bytes[index] ?? 0;
        if (red > 0) {
          litPixels += 1;
          intensities.add(red);
        }
      }
      // A 2×2-unit grid seen from z=3 at 60° fov fills a solid block of the frame —
      // scattered sprites cannot, so coverage IS the topology check.
      expect(litPixels).toBeGreaterThan(96 * 96 * 0.25);
      // The analytic single intensity: normal (0,0,1) everywhere, one light, so
      // shade = 0.25 + 0.75·|L.z| — a second value would mean broken normals or a
      // torn unwrap.
      const expected = Math.round(255 * (0.25 + 0.75 * 0.556086));
      expect(intensities.size).toBe(1);
      const [only] = [...intensities];
      expect(Math.abs((only ?? 0) - expected)).toBeLessThanOrEqual(1);
    } finally {
      backend.dispose();
    }
  });
});
