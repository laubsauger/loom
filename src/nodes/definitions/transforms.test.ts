import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import {
  cropNode,
  flipNode,
  mirrorNode,
  tileNode,
  transformNode,
  transformNodes,
} from "./transforms.ts";
import { TRANSFORM_ORDER_OPTIONS } from "./parameter-readers.ts";
import { WGSL_TRANSFORM2D } from "../shaders/common.wgsl.ts";
import { compileContext, inputResourceId, outputResourceId, readNodePlan, TEST_SAMPLER_ID } from "./test-support.ts";

/** Geometry filters: Transform, Crop, Tile (T40). */

function firstPass(definition: NodeDefinition, parameters = {}) {
  const options = { inputs: ["input"], parameters } as const;
  const compiled = definition.compile(compileContext(options));
  const read = readNodePlan(compiled.passes, options);
  expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(read.ok).toBe(true);
  const pass = read.passes[0];
  if (pass?.kind !== "effect") throw new Error(`${definition.type} did not emit an effect pass.`);
  return pass;
}

describe("geometry filter nodes (T40)", () => {
  it("all register together with no manifest diagnostics", () => {
    for (const definition of transformNodes) expect(validateNodeDefinition(definition)).toEqual([]);
    expect(createNodeRegistry(transformNodes).list().map((d) => d.type)).toEqual([
      "crop",
      "flip",
      "mirror",
      "tile",
      "transform",
    ]);
  });

  /**
   * A filter inherits its input's size and format. Resolving to anything else would be an
   * implicit conversion the user never asked for and cannot see (§V13, §V21).
   */
  it("inherit resolution and format from their single input", () => {
    for (const definition of transformNodes) {
      expect(definition.inputs.map((port) => port.id), definition.type).toEqual(["input"]);
      expect(definition.resolutionPolicy, definition.type).toEqual({ kind: "inherit", input: "input" });
      expect(definition.formatPolicy, definition.type).toEqual({ kind: "inherit", input: "input" });
    }
  });

  it("bind the input texture and the plan's shared sampler", () => {
    for (const definition of transformNodes) {
      const pass = firstPass(definition);
      expect(pass.textures, definition.type).toEqual([
        { binding: "inputTexture", resourceId: inputResourceId("input") },
      ]);
      expect(pass.samplers, definition.type).toEqual([
        { binding: "inputSampler", resourceId: TEST_SAMPLER_ID },
      ]);
      expect(pass.target, definition.type).toBe(outputResourceId("out"));
    }
  });

  it("report a diagnostic instead of a malformed pass when the input is unbound", () => {
    for (const definition of transformNodes) {
      const compiled = definition.compile(compileContext({ inputs: [] }));
      expect(compiled.passes, definition.type).toEqual([]);
      expect(compiled.diagnostics?.[0]?.code, definition.type).toBe("node.compile.missingResource");
    }
  });

  describe("Transform", () => {
    it("converts rotation to radians and keeps everything else as authored", () => {
      const pass = firstPass(transformNode, { r: 180, t: [0.25, -0.5], s: [2, 2], p: [0.1, 0.1] });
      expect(pass.uniforms?.["rot"]).toBeCloseTo(Math.PI, 10);
      expect(pass.uniforms).toMatchObject({ t: [0.25, -0.5], s: [2, 2], piv: [0.1, 0.1] });
    });

    /**
     * The shader must have a branch per transform order. A missing one would silently fall
     * through to the default order, which looks almost right and is wrong — the hardest
     * kind of bug to notice in a transform.
     */
    it("implements every transform order it offers", () => {
      expect(transformNode.parameters["xord"]).toMatchObject({ type: "enum" });
      TRANSFORM_ORDER_OPTIONS.forEach((option, index) => {
        const branch = index === TRANSFORM_ORDER_OPTIONS.length - 1 ? "default: {" : `case ${index}u: {`;
        expect(WGSL_TRANSFORM2D, option.value).toContain(branch);
      });
    });

    it("passes the extend mode as an index the shader switches on", () => {
      expect(firstPass(transformNode, { extend: "mirror" }).uniforms?.["extend"]).toBe(2);
      expect(firstPass(transformNode, { extend: "zero" }).uniforms?.["extend"]).toBe(3);
    });
  });

  describe("Crop", () => {
    /**
     * TD's Crop resizes its output; ours cannot, because `ResolutionPolicy` has no kind
     * that derives a size from a parameter. The node keeps the input size and blanks the
     * outside, and the test pins that decision so a future change is deliberate.
     */
    it("keeps the input resolution rather than resizing to the crop region", () => {
      expect(cropNode.resolutionPolicy).toEqual({ kind: "inherit", input: "input" });
    });

    it("packs its four bounds into one vec4 in left/right/bottom/top order", () => {
      const pass = firstPass(cropNode, { left: 0.1, right: 0.8, bottom: 0.2, top: 0.9 });
      expect(pass.uniforms?.["bounds"]).toEqual([0.1, 0.8, 0.2, 0.9]);
    });
  });

  describe("Tile", () => {
    it("passes the two mirror flags as a vec2 of 0/1", () => {
      expect(firstPass(tileNode, { mirrorx: true }).uniforms?.["mirror"]).toEqual([1, 0]);
      expect(firstPass(tileNode, { mirrory: true }).uniforms?.["mirror"]).toEqual([0, 1]);
    });
  });
});

/**
 * Flip and Mirror (T242) — the two claims that are arguments rather than code.
 */
describe("Flip and Mirror (T242)", () => {
  it("flips without resampling, which is why it is not just Transform with a negative scale", () => {
    // The whole justification for a separate node: reversing a coordinate lands on texel
    // centres, where a -1 scale runs the image through the sampler's filter and softens it
    // slightly every time. If this shader ever grows a matrix, that argument is gone.
    const shader = firstPass(flipNode, { flipx: true }).shader;
    expect(shader).toContain("vec2f(1.0) - uv");
    expect(shader).not.toContain("matrix");
  });

  it("has no transpose, because a resolution-preserving one squashes non-square images", () => {
    // A `swap` exchanging x and y reads as a free 90 degree rotation and silently squashes
    // every non-square image, since the output keeps the input's resolution. TD splits the
    // two operations across two nodes for exactly this reason. Pinned so it is not helpfully
    // re-added by someone who notices Flip "should" be able to rotate.
    expect(flipNode.parameters["swap"]).toBeUndefined();
    expect(firstPass(flipNode).shader).not.toContain("uv.yx");
  });

  it("folds across a ROTATED line, which is what makes a kaleidoscope", () => {
    // Folding on x or y is symmetry; folding across an arbitrary diagonal is the operation
    // people actually want a Mirror for.
    expect(mirrorNode.parameters["rotate"]).toBeDefined();
    const shader = firstPass(mirrorNode).shader;
    expect(shader).toContain("invRotate2");
    // Rotated in, folded, rotated back — so the pivot stays the point the image folds
    // about rather than drifting as the angle changes.
    expect(shader).toContain("params.pivot + invRotate2");
  });

  it("mirrors about a pivot, not just the centre", () => {
    // Folding about the centre is the boring case; folding about 0.3 is what makes this a
    // design tool rather than a checkbox on Flip. Pinned so the pivot is not "simplified"
    // away later.
    const uniforms = firstPass(mirrorNode, { pivot: [0.3, 0.5] }).uniforms as Record<string, unknown>;
    expect(uniforms["pivot"]).toEqual([0.3, 0.5]);
    expect(firstPass(mirrorNode).shader).toContain("abs(local)");
  });

  it("samples the fold through the extend helper, because folded coords leave [0,1]", () => {
    // At pivot 0.2 the far edge maps to -0.6. Sampling that directly would clamp silently
    // on one backend and wrap on another.
    expect(firstPass(mirrorNode).shader).toContain("sampleExtend");
  });
});
