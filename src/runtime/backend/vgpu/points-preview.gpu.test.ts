import { describe, expect, it } from "vitest";

import { compileGraph } from "../../../compiler/index.ts";
import { pointsPreviewResourceId } from "../../../compiler/resources.ts";
import { viewProjection } from "../../../domain/geometry/camera.ts";
import { createNodeRegistry } from "../../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../../nodes/definitions/index.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T373 on a REAL device: a watched point generator's synthesized splat pass actually
 * puts ink where the point projects.
 *
 * One point, so the picture is fully predictable: the position is read back, projected
 * through the SAME default camera the compiler bakes into the pass, and the splat's
 * center texel is asserted against the shader's own math (§V147 — a value derived from
 * the contract, not "some pixels lit"). The zero ring proves the splat is local; a
 * full-screen wash or a stuck clear both fail loudly.
 */

/** The synthesized target's edge: `previewLongEdge` × MAX_TILE_SCALE (T502, §V454). */
const EDGE = 384;
const PREVIEW_LONG_EDGE = 192;
const POINT_SIZE = 0.03; // must match POINTS_PREVIEW_POINT_SIZE in compile.ts — pinned below

describe("pointset preview splat on Dawn (T373)", () => {
  it("splats the single point exactly where the default camera projects it", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const registry = createNodeRegistry(allNodeDefinitions).view();
    const plan = compileGraph({
      graph: {
        revision: 1,
        nodes: {
          gen: {
            id: "gen",
            type: "pointLine",
            definitionVersion: 1,
            position: { x: 0, y: 0 },
            parameters: { count: 1, sizeX: 2 },
          },
        },
        edges: {},
        groups: {},
      },
      settings: {
        outputResolution: { width: 64, height: 64 },
        workingFormat: "rgba8unorm",
        randomSeed: 7,
        previewLongEdge: PREVIEW_LONG_EDGE,
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
      sinks: [{ nodeId: "gen", portId: "out", kind: "preview" }],
    });
    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);
    const previewId = pointsPreviewResourceId("gen", "out");
    const pass = plan.passes.find((entry) => entry.id === "gen#pointsPreview:out");
    expect(pass).toBeDefined();
    // The constant this test's own projection uses must be the one the pass carries.
    expect((pass as { uniforms?: { pointSize?: number } }).uniforms?.pointSize).toBe(POINT_SIZE);

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

      // The point's actual position, then the SAME projection the compiler bakes in.
      const raw = new Float32Array(await backend.readBuffer("scratch:gen:position"));
      const point: [number, number, number] = [raw[0] ?? 0, raw[1] ?? 0, raw[2] ?? 0];
      const camera = viewProjection([1.7, 1.2, 2.4], [0, 0, 0], { aspect: 1 });
      // Column-major mat4 × vec4(point, 1).
      const clip = [0, 1, 2, 3].map(
        (row) =>
          (camera[row] ?? 0) * point[0] +
          (camera[4 + row] ?? 0) * point[1] +
          (camera[8 + row] ?? 0) * point[2] +
          (camera[12 + row] ?? 0),
      );
      const w = clip[3] ?? 1;
      const ndc = [(clip[0] ?? 0) / w, (clip[1] ?? 0) / w];
      const centerPx = [((ndc[0] ?? 0) + 1) * 0.5 * EDGE, (1 - ((ndc[1] ?? 0) + 1) * 0.5) * EDGE];

      const image = await backend.readOutput(previewId);
      expect([image.width, image.height]).toEqual([EDGE, EDGE]);
      const byteAt = (x: number, y: number, channel: number): number =>
        image.bytes[(y * EDGE + x) * 4 + channel] ?? 0;

      // The texel whose center is nearest the projected point: its uv distance is
      // |texelCenter - splatCenter| / halfExtentPx, and the shader writes
      // (1, 0.62, 0.24) * alpha with alpha = 1 - distance, alpha-blended over a clear.
      const texel = [Math.floor(centerPx[0] ?? 0), Math.floor(centerPx[1] ?? 0)];
      const halfExtentPx = (POINT_SIZE * EDGE) / 2;
      const dx = (texel[0] ?? 0) + 0.5 - (centerPx[0] ?? 0);
      const dy = (texel[1] ?? 0) + 0.5 - (centerPx[1] ?? 0);
      const alpha = Math.max(0, 1 - Math.hypot(dx, dy) / halfExtentPx);
      expect(alpha).toBeGreaterThan(0.5); // the nearest texel is well inside the disc
      for (const [channel, tint] of [
        [0, 1.0],
        [1, 0.62],
        [2, 0.24],
      ] as const) {
        const expected = Math.round(tint * alpha * 255);
        const actual = byteAt(texel[0] ?? 0, texel[1] ?? 0, channel);
        // ±1: f32 interpolation of uv across the quad rounds the last bit differently
        // than this f64 reconstruction; one quantization step is the honest bound.
        expect(Math.abs(actual - expected), `channel ${channel}`).toBeLessThanOrEqual(1);
      }

      // Locality: outside the disc the target is exactly the clear — a wash or a
      // stuck-open blend fails here.
      const off = Math.ceil(halfExtentPx) + 2;
      for (const [x, y] of [
        [(texel[0] ?? 0) + off, texel[1] ?? 0],
        [texel[0] ?? 0, (texel[1] ?? 0) + off],
        [0, 0],
        [EDGE - 1, EDGE - 1],
      ]) {
        expect(byteAt(x as number, y as number, 0), `(${x},${y})`).toBe(0);
      }
    } finally {
      backend.dispose();
    }
  });
});
