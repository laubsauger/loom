import { describe, expect, it } from "vitest";

import { viewProjection } from "../../domain/geometry/camera.ts";
import { INSTANCE_VERTEX_COUNT } from "../shaders/render-instances.wgsl.ts";
import { renderInstancesNode } from "./render-instances.ts";
import { pointPairId } from "./points.ts";
import { compileContext } from "./test-support.ts";

/**
 * RenderInstances at the fixture level (T299): manifest, emission, the §V198 camera
 * riding in as uniform VALUES, and shape staying a uniform. The pixels-on-Dawn half
 * lives in `src/runtime/backend/vgpu/render-instances.gpu.test.ts`.
 */

type DrawShape = {
  kind: string;
  instances: number;
  vertexCount: number;
  buffers: Array<{ binding: string; resourceId: string; half: string }>;
  uniforms: Record<string, number | readonly number[]>;
  uniformBinding: string;
};

describe("renderInstances — manifest and emission (T299)", () => {
  it("declares a depth attachment on its output — 3D needs a z-buffer (T295)", () => {
    expect(renderInstancesNode.depthOutputs).toEqual(["out"]);
    const input = renderInstancesNode.inputs[0];
    expect(input?.type.kind).toBe("pointset");
  });

  it("emits one instanced draw off the edge map's position pair", () => {
    const result = renderInstancesNode.compile(
      compileContext({ nodeId: "draw", inputs: ["points"], sources: { points: "gen" }, parameters: { count: 300 } }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    const pass = result.passes[0] as DrawShape;
    expect(pass.kind).toBe("draw");
    expect(pass.instances).toBe(300);
    expect(pass.vertexCount).toBe(INSTANCE_VERTEX_COUNT);
    expect(pass.buffers).toEqual([
      { binding: "positions", resourceId: pointPairId("gen", "position"), half: "write" },
    ]);
  });

  it("uploads the §V198 camera as sixteen floats — a value, never structure (§V5)", () => {
    const parameters = { eye: [1, 2, 5], lookAt: [0, 1, 0], fov: 45, near: 0.5, far: 50 };
    const result = renderInstancesNode.compile(
      compileContext({
        nodeId: "draw",
        inputs: ["points"],
        sources: { points: "gen" },
        parameters,
        resolution: [640, 360],
      }),
    );
    const pass = result.passes[0] as DrawShape;
    const expected = viewProjection([1, 2, 5], [0, 1, 0], {
      fovY: (45 * Math.PI) / 180,
      aspect: 640 / 360,
      near: 0.5,
      far: 50,
    });
    expect(pass.uniforms["viewProjection"]).toEqual(Array.from(expected));
  });

  it("passes shape as a uniform integer and rotation in radians", () => {
    const result = renderInstancesNode.compile(
      compileContext({
        nodeId: "draw",
        inputs: ["points"],
        sources: { points: "gen" },
        parameters: { shape: "octahedron", rotate: [90, 0, -180] },
      }),
    );
    const pass = result.passes[0] as DrawShape;
    expect(pass.uniforms["shape"]).toBe(2);
    const radians = pass.uniforms["rotate"] as readonly number[];
    expect(radians[0]).toBeCloseTo(Math.PI / 2, 10);
    expect(radians[1]).toBe(0);
    expect(radians[2]).toBeCloseTo(-Math.PI, 10);
  });
});
