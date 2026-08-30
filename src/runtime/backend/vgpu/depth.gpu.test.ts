import { describe, expect, it } from "vitest";

import type { LogicalExecutionPlan } from "../../../domain/types/backend.ts";
import { viewProjection } from "../../../domain/geometry/camera.ts";
import { createVgpuBackend } from "./vgpu-backend.ts";
import { nodeGpuHost, probeDawn } from "./node-gpu-host.ts";

/**
 * T295 on Dawn: a depth-attached target plus the published camera order (§V198),
 * proven with texels. Two overlapping quads; the NEARER one wins even though it is
 * drawn FIRST — which is exactly the claim "we have a depth buffer" and exactly what
 * draw order would get wrong without one.
 */

const QUAD_WGSL = `struct Params {
  viewProj: mat4x4f,
  offsetZ: f32,
  colorR: f32,
};
@group(0) @binding(0) var<uniform> params: Params;

@vertex
fn vs(@builtin(vertex_index) vertex: u32) -> @builtin(position) vec4f {
  var corners = array<vec2f, 6>(
    vec2f(-0.6, -0.6), vec2f(0.6, -0.6), vec2f(-0.6, 0.6),
    vec2f(-0.6, 0.6), vec2f(0.6, -0.6), vec2f(0.6, 0.6),
  );
  let corner = corners[vertex];
  return params.viewProj * vec4f(corner, params.offsetZ, 1.0);
}

@fragment
fn fs() -> @location(0) vec4f {
  return vec4f(params.colorR, 1.0 - params.colorR, 0.0, 1.0);
}`;

describe("depth attachment + camera (T295, §V198) on Dawn", () => {
  it("the nearer quad wins although drawn first", async () => {
    const probe = await probeDawn();
    if (!probe.available) throw new Error(`Dawn unavailable: ${probe.error}`);

    const vp = viewProjection([0, 0, 3], [0, 0, 0], { fovY: Math.PI / 2, aspect: 1, near: 0.1, far: 10 });
    const plan: LogicalExecutionPlan = {
      resources: [{ kind: "target", id: "out", size: [32, 32], format: "rgba8unorm", depth: true }],
      passes: [
        // RED quad NEAR the camera (z = 1 → view depth 2), drawn FIRST.
        {
          kind: "draw",
          id: "near",
          shader: QUAD_WGSL,
          target: "out",
          topology: "triangle-list",
          vertexCount: 6,
          instances: 1,
          uniforms: { viewProj: [...vp], offsetZ: 1, colorR: 1 },
          uniformBinding: "params",
        },
        // GREEN quad FARTHER (z = -1 → view depth 4), drawn second, must NOT overwrite.
        {
          kind: "draw",
          id: "far",
          shader: QUAD_WGSL,
          target: "out",
          topology: "triangle-list",
          vertexCount: 6,
          instances: 1,
          clear: false,
          uniforms: { viewProj: [...vp], offsetZ: -1, colorR: 0 },
          uniformBinding: "params",
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
        frame: { timeSeconds: 0, deltaSeconds: 1 / 60, frameIndex: 0, mode: "offline", randomSeed: 1 },
        pointer: { x: 0, y: 0, buttons: 0 },
        resolution: [32, 32],
      });

      const image = await backend.readOutput("out");
      expect(errors).toEqual([]);
      const centre = (16 * 32 + 16) * 4;
      const [r, g] = [image.bytes[centre] ?? 0, image.bytes[centre + 1] ?? 0];
      // Depth decides: RED (near, drawn first) stands; GREEN (far, drawn last) lost.
      expect(r).toBeGreaterThan(200);
      expect(g).toBeLessThan(50);
    } finally {
      backend.dispose();
    }
  });
});
