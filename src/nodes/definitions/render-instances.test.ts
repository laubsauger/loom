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

/**
 * T369 — per-point colour on renderInstances, the T364 path extended to the LIT renderer.
 *
 * The gap this closes is a real authoring dead end, not a nicety: `renderPoints` has taken
 * a mapped colour since T364, so a graph that wanted thousands of individually coloured
 * things had to draw them as flat additive sprites. Choosing between spectral and lit is
 * exactly the choice the map mode exists to abolish.
 */
describe("renderInstances — colour in map mode (T369)", () => {
  const edge = {
    points: {
      pairs: {
        position: { pair: "scratch:gen:position", half: "write" as const, type: "vec3f" },
        tint: { pair: "scratch:gen:tint", half: "write" as const, type: "vec4f" },
        pscale: { pair: "scratch:gen:pscale", half: "write" as const, type: "f32" },
      },
      capacity: 64,
      topology: "points",
    },
  };
  const mapped = (binding: { attribute: string; channel?: string; port?: string }, key = "color") =>
    renderInstancesNode.compile(
      compileContext({
        nodeId: "draw",
        inputs: ["points"],
        sources: { points: "gen" },
        pointsets: edge,
        parameters: { count: 64 },
        parameterMaps: { [key]: binding },
      }),
    );

  it("binds the attribute's pair and drops colour OUT of the uniform block", () => {
    const result = mapped({ attribute: "tint" });
    expect(result.diagnostics ?? []).toEqual([]);
    const pass = result.passes[0] as DrawShape & { shader: string };
    expect(pass.buffers).toContainEqual({
      binding: "mapColors",
      resourceId: "scratch:gen:tint",
      half: "write",
    });
    // The struct and the record must agree exactly — vgpu writes by NAME, so a `color`
    // left in the record with no member is silently dropped and one with no record entry
    // silently reads zero. Neither shows up as an error; both show up as a wrong picture.
    expect(pass.uniforms["color"]).toBeUndefined();
    // Out of the STRUCT specifically — `@location(1) color: vec4f` is the same spelling
    // one line later, and that one is the point.
    expect(pass.shader).not.toContain("  viewProjection: mat4x4f,\n  color: vec4f,");
    expect(pass.shader).toContain("  @location(1) color: vec4f,");
    expect(pass.shader).toContain("var<storage, read> mapColors: array<vec4f>;");
    // The point of putting it HERE rather than on renderPoints: the lighting still runs.
    expect(pass.shader).toContain("input.color.rgb * shade");
    // ...and the block itself survives, unlike the sprite path — the camera cannot map.
    expect(pass.uniformBinding).toBe("params");
    expect(Object.keys(pass.uniforms).sort()).toEqual(["rotate", "scale", "shape", "viewProjection"]);
  });

  it("refuses by name, never falling back to the static (§V288)", () => {
    expect(mapped({ attribute: "missing" }).diagnostics?.[0]?.message).toContain(
      'which the incoming pointset does not carry',
    );
    expect(mapped({ attribute: "missing" }).diagnostics?.[0]?.suggestion).toContain("position, pscale, tint");
    expect(mapped({ attribute: "pscale" }).diagnostics?.[0]?.message).toContain('"pscale" is f32');
    expect(mapped({ attribute: "tint", channel: "x" }).diagnostics?.[0]?.message).toContain(
      "a channel belongs on a component slot",
    );
    expect(mapped({ attribute: "tint", port: "points2" }).diagnostics?.[0]?.message).toContain(
      'only pointset input is "points"',
    );
  });

  /**
   * §V288's other half, and the reason this is an ERROR rather than an omission: map mode
   * is offered on EVERY parameter in the inspector (§V107/§V108 store it anywhere), so
   * before T369 a map on `scale` here compiled happily and drew the retained static. A
   * parameter that looks mapped and is not is the silence the invariant forbids.
   */
  it("names a map it cannot honour instead of ignoring it", () => {
    const result = mapped({ attribute: "pscale" }, "scale");
    expect(result.passes).toEqual([]);
    expect(result.diagnostics?.[0]?.message).toContain('scale is in map mode, but renderInstances maps only "color"');
  });

  it("unmapped, the shipped shader and uniform block are byte-identical (§V309)", () => {
    const result = renderInstancesNode.compile(
      compileContext({ nodeId: "draw", inputs: ["points"], sources: { points: "gen" }, pointsets: edge, parameters: { count: 64 } }),
    );
    const pass = result.passes[0] as DrawShape & { shader: string };
    expect(pass.shader).toContain("  viewProjection: mat4x4f,\n  color: vec4f,\n  rotate: vec3f,");
    expect(pass.shader).not.toContain("mapColors");
    expect(pass.shader).not.toContain("@location(1)");
    expect(pass.shader).toContain("  @location(0) normal: vec3f,\n};");
    expect(pass.shader).toContain("params.color.rgb * shade");
    expect(Object.keys(pass.uniforms).sort()).toEqual(["color", "rotate", "scale", "shape", "viewProjection"]);
  });
});
