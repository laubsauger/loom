import { describe, expect, it } from "vitest";

import {
  GENERATOR_SHAPES,
  pointBoxNode,
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
  it("is one node per shape plus the menu, and the list is derived (§V316)", () => {
    // The presets are a Record over GENERATOR_SHAPES, so the count is forced: a shape
    // with no node to spell it by name would not compile, and could not slip in here.
    expect(pointGeneratorDefinitions).toHaveLength(GENERATOR_SHAPES.length + 1);
    const spelled = new Set(pointGeneratorDefinitions.map((definition) => definition.type));
    for (const shape of GENERATOR_SHAPES) {
      expect(spelled, `no preset node spells ${shape}`).toContain(
        `point${shape[0]?.toUpperCase()}${shape.slice(1)}`,
      );
    }
  });

  it("is eight spellings of one node: same schema minus the shape menu, same compile", () => {
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

  /**
   * T1057. The box is the shape that tests the T302 vocabulary rather than stretching
   * it: six DISJOINT faces are not one cols×rows sheet, and a `grid:` claim would hand
   * renderSurface a cell count whose quads straddle face boundaries — a picture, and a
   * wrong one. `points` is the honest claim, and the consumer refuses by name.
   */
  it("publishes `points` for the box: six faces are not one grid (T1057)", () => {
    const box = pointBoxNode.compile(
      compileContext({ nodeId: "gen", outputs: [], parameters: { count: 600, sizeX: 3, sizeY: 1, sizeZ: 0.5, cols: 48, rows: 24 } }),
    );
    expect(box.diagnostics ?? []).toEqual([]);
    expect(box.pointsets?.["out"]?.topology).toBe("points");
    expect(box.pointsets?.["out"]?.capacity).toBe(600);
    // cols/rows are set here and MUST NOT reach the claim — a box that quietly published
    // grid:48x24 would address 1152 points out of an edge that carries 600.
    const pass = box.passes[0] as DispatchShape;
    expect(pass.uniforms["shape"]).toBe(6);
    // All three extents reach the kernel, independently — the whole point of the shape.
    expect(pass.uniforms["sizeX"]).toBe(3);
    expect(pass.uniforms["sizeY"]).toBe(1);
    expect(pass.uniforms["sizeZ"]).toBe(0.5);
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
    // T1057: the box is the one shape that reads all three extents and no radius.
    expect(inactiveReason("sizeX", { shape: "box" })).toBeNull();
    expect(inactiveReason("sizeY", { shape: "box" })).toBeNull();
    expect(inactiveReason("sizeZ", { shape: "box" })).toBeNull();
    expect(inactiveReason("radius", { shape: "box" })).toContain("box");
    expect(inactiveReason("radius2", { shape: "box" })).toContain("box");
    expect(inactiveReason("cols", { shape: "box" })).toContain("box");
    expect(inactiveReason("rows", { shape: "box" })).toContain("box");
    // A preset answers from its FIXED shape, ignoring whatever values carry.
    expect(pointSphereNode.parameters["radius"]?.inactiveWhen?.({})).toBeNull();
    expect(pointSphereNode.parameters["cols"]?.inactiveWhen?.({})).toContain("sphere");
  });

  /**
   * §V831: a stored enum value with no matching option resolves to the DEFAULT with no
   * error, so appending is the only safe edit. Every shape any shipped document can hold
   * still has its row, and still reaches its own kernel branch.
   */
  it("keeps every previously shipped shape resolvable (§V831)", () => {
    // GENERATOR_SHAPES IS the option list (the menu maps over it), so its prefix is the
    // compatibility surface: box is APPENDED, nothing above it moved.
    expect(GENERATOR_SHAPES.slice(0, 6)).toEqual(["line", "circle", "grid", "sphere", "tube", "torus"]);
    expect(GENERATOR_SHAPES[6]).toBe("box");
    const indices = GENERATOR_SHAPES.map(
      (shape) =>
        (pointGeneratorNode.compile(compileContext({ nodeId: "gen", outputs: [], parameters: { shape } }))
          .passes[0] as DispatchShape).uniforms["shape"],
    );
    // Appended, never renumbered: torus is still 5 for every document that stored it.
    expect(indices).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });
});
