import { describe, expect, it } from "vitest";

import {
  GENERATOR_SHAPES,
  pointGeneratorDefinitions,
  pointGeneratorNode,
  pointSphereNode,
  pointTorusNode,
} from "./point-generators.ts";
import { pointPairId } from "./points.ts";
import { compileContext } from "./test-support.ts";

/**
 * The generator family at the fixture level (T298): one implementation behind seven
 * spellings, the T296 pointset publication, and the V146 applicability data. The
 * positions-on-Dawn half lives in
 * `src/runtime/backend/vgpu/point-generators.gpu.test.ts`.
 */

type DispatchShape = {
  kind: string;
  buffers: Array<{ binding: string; resourceId: string; half: string }>;
  uniforms: Record<string, number>;
  uniformBinding: string;
};

describe("point generator family (T298)", () => {
  it("is seven spellings of one node: same schema minus the shape menu, same compile", () => {
    expect(pointGeneratorDefinitions).toHaveLength(7);
    for (const definition of pointGeneratorDefinitions) {
      expect(definition.category).toBe("points");
      expect(definition.inputs).toEqual([]);
      expect(definition.outputs[0]?.type.kind).toBe("pointset");
    }
    // The generic node has the menu; every preset drops it and keeps the rest.
    expect(Object.keys(pointGeneratorNode.parameters)).toContain("shape");
    const presetKeys = Object.keys(pointSphereNode.parameters);
    expect(presetKeys).not.toContain("shape");
    expect(presetKeys).toEqual(Object.keys(pointGeneratorNode.parameters).filter((key) => key !== "shape"));
  });

  it("emits one dispatch that writes the position pair it owns (§V197)", () => {
    const result = pointSphereNode.compile(
      compileContext({ nodeId: "gen", outputs: [], parameters: { count: 500, radius: 2 } }),
    );
    expect(result.diagnostics ?? []).toEqual([]);
    expect(result.passes).toHaveLength(1);
    const pass = result.passes[0] as DispatchShape;
    expect(pass.kind).toBe("dispatch");
    expect(pass.uniformBinding).toBe("params");
    expect(pass.uniforms["count"]).toBe(500);
    expect(pass.uniforms["shape"]).toBe(3);
    expect(pass.uniforms["radius"]).toBe(2);
    // A generator only writes — it never reads a previous frame, so there is no in_*.
    expect(pass.buffers).toEqual([
      { binding: "out_position", resourceId: pointPairId("gen", "position"), half: "write" },
    ]);
    expect(result.scratch).toEqual([
      { key: "position", kind: "bufferPair", stride: 16, capacity: 500 },
    ]);
  });

  it("publishes the T296 edge map with capacity and analytic topology", () => {
    const sphere = pointSphereNode.compile(
      compileContext({ nodeId: "gen", outputs: [], parameters: { count: 500 } }),
    );
    expect(sphere.pointsets).toEqual({
      out: {
        pairs: { position: { pair: pointPairId("gen", "position"), half: "write", type: "vec3f" } },
        capacity: 500,
        topology: "points",
      },
    });

    const torus = pointTorusNode.compile(
      compileContext({ nodeId: "gen", outputs: [], parameters: { count: 4096, cols: 48, rows: 24 } }),
    );
    expect(torus.pointsets?.["out"]?.topology).toBe("grid:48x24:wrapUV");
  });

  it("switches shape through a uniform, never a recompile (§V5)", () => {
    const passFor = (shape: string): DispatchShape =>
      pointGeneratorNode.compile(
        compileContext({ nodeId: "gen", outputs: [], parameters: { shape } }),
      ).passes[0] as DispatchShape;
    const shaders = new Set(GENERATOR_SHAPES.map((shape) => passFor(shape)));
    const shapeIndices = [...shaders].map((pass) => pass.uniforms["shape"]);
    // Six shapes, six distinct shape uniforms, ONE shader module.
    expect(new Set(shapeIndices).size).toBe(GENERATOR_SHAPES.length);
    expect(new Set([...shaders].map((pass) => (pass as unknown as { shader: string }).shader)).size).toBe(1);
  });

  it("marks the knobs a shape does not read as inactive, with the shape named (§V146)", () => {
    const inactiveReason = (key: string, values: Record<string, string>): string | null => {
      const definition = pointGeneratorNode.parameters[key];
      return definition?.inactiveWhen?.(values) ?? null;
    };
    // Sphere reads radius and nothing else.
    expect(inactiveReason("radius", { shape: "sphere" })).toBeNull();
    expect(inactiveReason("cols", { shape: "sphere" })).toContain("sphere");
    expect(inactiveReason("sizeX", { shape: "sphere" })).toContain("sphere");
    // Grid reads its extent and subdivision, not the radii.
    expect(inactiveReason("cols", { shape: "grid" })).toBeNull();
    expect(inactiveReason("sizeY", { shape: "grid" })).toBeNull();
    expect(inactiveReason("radius", { shape: "grid" })).toContain("grid");
    // A preset answers from its FIXED shape, ignoring whatever values carry.
    expect(pointSphereNode.parameters["radius"]?.inactiveWhen?.({})).toBeNull();
    expect(pointSphereNode.parameters["cols"]?.inactiveWhen?.({})).toContain("sphere");
  });
});
