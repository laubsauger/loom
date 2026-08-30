import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T401 on a REAL device: a kernel downstream of a generator DISPLACES, it does not
 * SIMULATE. Reading the upstream pair every frame is the whole difference — a source
 * kernel reads its own last frame and accumulates; a processor reads the generator
 * fresh, so the same displacement applied twice lands in the same place. Frame 2
 * equalling frame 1 is therefore the sharpest single assertion this feature has, and
 * it is exact (§V147).
 */

describe("pointKernel processor on Dawn (T401)", () => {
  it("displaces the generator's positions by an exact offset, and does not accumulate", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const kernel = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = p.position + vec3f(0.5, 0.25, 0.125);
  return q;
}`;
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          gen: { id: "gen", type: "pointLine", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 8, sizeX: 2 } },
          k: { id: "k", type: "pointKernel", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { capacity: 8, kernel } },
          draw: { id: "draw", type: "renderPoints", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: { count: 8 } },
          out: { id: "out", type: "output", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
        },
        edges: {
          e1: { id: "e1", source: { nodeId: "gen", portId: "out" }, target: { nodeId: "k", portId: "in" } },
          e2: { id: "e2", source: { nodeId: "k", portId: "out" }, target: { nodeId: "draw", portId: "points" } },
          e3: { id: "e3", source: { nodeId: "draw", portId: "out" }, target: { nodeId: "out", portId: "input" } },
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
      const renderFrame = (frameIndex: number): void =>
        backend.render(compiled, {
          frame: { timeSeconds: frameIndex / 60, deltaSeconds: 1 / 60, frameIndex, mode: "offline", randomSeed: 7 },
          pointer: { x: 0, y: 0, buttons: 0 },
          resolution: [64, 64],
        });

      renderFrame(0);
      expect(errors).toEqual([]);
      const source = new Float32Array(await backend.readBuffer("scratch:gen:position"));
      const displaced = new Float32Array(await backend.readBuffer("scratch:k:position"));
      for (let point = 0; point < 8; point += 1) {
        const base = point * 4; // vec3f strides at 16 bytes
        // EXACT (§V147): +0.5/+0.25/+0.125 are dyadic — f32 addition is lossless on the
        // line generator's coordinates, so equality is by construction, not tolerance.
        expect(displaced[base], `point ${point} x`).toBe((source[base] ?? 0) + 0.5);
        expect(displaced[base + 1], `point ${point} y`).toBe((source[base + 1] ?? 0) + 0.25);
        expect(displaced[base + 2], `point ${point} z`).toBe((source[base + 2] ?? 0) + 0.125);
      }

      // Frame 2: STILL source + one offset. A kernel that read its own last frame — the
      // pre-T401 source behaviour — would be at two offsets by now.
      renderFrame(1);
      expect(errors).toEqual([]);
      const second = new Float32Array(await backend.readBuffer("scratch:k:position"));
      for (let point = 0; point < 8; point += 1) {
        const base = point * 4;
        expect(second[base], `frame-2 point ${point} x`).toBe((source[base] ?? 0) + 0.5);
      }
    } finally {
      backend.dispose();
    }
  });
});
