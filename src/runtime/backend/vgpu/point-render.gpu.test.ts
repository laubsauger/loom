import { describe, expect, it } from "vitest";

import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import { generateKernelModule } from "../../../points/codegen.ts";
import type { PointAttributeSchema } from "../../../points/attributes.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T172 end to end on a REAL device, through the REAL backend: a generated point kernel
 * runs as a dispatch pass, a vertex-pulling draw pass renders the points as sprites into
 * a target, and readOutput shows actual pixels. This is the last structural gap between
 * the point system and the screen, executed rather than asserted.
 */

const COUNT = 64;

const SCHEMA: ReadonlyArray<PointAttributeSchema> = [
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
];

/** Spread the points across a horizontal band in clip space, deterministically. */
const KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let t = (f32(ctx.index) + 0.5) / f32(ctx.count);
  q.position = vec3f(t * 2.0 - 1.0, 0.0, 0.0);
  return q;
}`;

const SPRITE_WGSL = `@group(0) @binding(0) var<storage, read> pos: array<vec3f>;
@vertex
fn vs(@builtin(instance_index) instance: u32) -> @builtin(position) vec4f {
  let p = pos[instance];
  return vec4f(p.xy, 0.0, 1.0);
}
@fragment
fn fs() -> @location(0) vec4f {
  return vec4f(1.0, 0.0, 0.0, 1.0);
}`;

describe("dispatch + draw through the backend on Dawn (T172)", () => {
  it("simulates, draws sprites, and the output target holds the pixels", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const module = generateKernelModule({
      attributes: SCHEMA,
      reads: [],
      writes: ["position"],
      kernel: KERNEL,
    });
    expect(module.ok).toBe(true);
    if (!module.ok) return;

    const plan: LogicalExecutionPlan = {
      resources: [
        { kind: "buffer", id: "pos-in", stride: 16, capacity: COUNT, usage: "storage-read" },
        { kind: "buffer", id: "pos-out", stride: 16, capacity: COUNT, usage: "storage" },
        { kind: "target", id: "out", size: [64, 64], format: "rgba8unorm" },
      ],
      passes: [
        {
          kind: "dispatch",
          id: "simulate",
          shader: module.wgsl,
          entryPoint: "main",
          workgroups: [Math.ceil(COUNT / module.workgroupSize), 1, 1],
          buffers: [
            { binding: "in_position", resourceId: "pos-in" },
            { binding: "out_position", resourceId: "pos-out" },
          ],
          uniforms: { timeSeconds: 0, deltaSeconds: 0, frameIndex: 0, seed: 7, count: COUNT },
          uniformBinding: "kernelFrame",
        },
        {
          kind: "draw",
          id: "sprites",
          shader: SPRITE_WGSL,
          target: "out",
          topology: "point-list",
          instances: COUNT,
          vertexCount: 1,
          buffers: [{ binding: "pos", resourceId: "pos-out" }],
        },
      ],
      diagnostics: [],
    };

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

      const image = await backend.readOutput("out");
      const bytes = image.bytes;
      expect(errors).toEqual([]);

      // A horizontal band of red points across the middle row of clip space.
      let redPixels = 0;
      for (let index = 0; index < bytes.byteLength; index += 4) {
        if ((bytes[index] ?? 0) > 200 && (bytes[index + 1] ?? 0) < 50) redPixels += 1;
      }
      expect(redPixels).toBeGreaterThanOrEqual(COUNT / 2);
      expect(redPixels).toBeLessThan(64 * 64); // not a fullscreen accident
    } finally {
      backend.dispose();
    }
  });
});
