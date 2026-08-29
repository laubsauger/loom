import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { blurNode, displaceNode, filterNodes } from "./filters.ts";
import { EXTEND_OPTIONS } from "./parameter-readers.ts";
import { WGSL_EXTEND } from "../shaders/common.wgsl.ts";
import { compileContext, inputResourceId, readNodePlan } from "./test-support.ts";

/** Neighbourhood filters: Blur, Displace (T40). */

function firstPass(definition: NodeDefinition, parameters = {}, resolution?: readonly [number, number]) {
  const options = {
    inputs: definition.inputs.map((port) => port.id),
    parameters,
    ...(resolution === undefined ? {} : { resolution }),
  };
  const compiled = definition.compile(compileContext(options));
  const read = readNodePlan(compiled.passes, options);
  expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(read.ok).toBe(true);
  const pass = read.passes[0];
  if (pass?.kind !== "effect") throw new Error(`${definition.type} did not emit an effect pass.`);
  return pass;
}

describe("filter nodes (T40)", () => {
  it("all register together with no manifest diagnostics", () => {
    for (const definition of filterNodes) expect(validateNodeDefinition(definition)).toEqual([]);
    expect(createNodeRegistry(filterNodes).list().map((d) => d.type)).toEqual(["blur", "displace"]);
  });

  it("agree with the shader about which extend mode each enum index means", () => {
    expect(EXTEND_OPTIONS.map((option) => option.value)).toEqual([
      "hold",
      "repeat",
      "mirror",
      "zero",
    ]);
    expect(WGSL_EXTEND).toContain("if (m == 1u)");
    expect(WGSL_EXTEND).toContain("if (m == 2u)");
    expect(WGSL_EXTEND).toContain("u32(mode + 0.5) == 3u");
  });

  describe("Blur", () => {
    /**
     * A blur radius is in pixels, so the node needs its own texel size. It comes from the
     * COMPILE-time resolved resolution (§V21), never from the shared frame block, whose
     * `resolution` is the presentation surface's rather than this pass's target's.
     */
    it("derives its texel size from the resolved output size", () => {
      const pass = firstPass(blurNode, {}, [800, 400]);
      expect(pass.uniforms?.["texel"]).toEqual([1 / 800, 1 / 400]);
    });

    it("changes only a uniform when the size or filter changes (§V5)", () => {
      const base = firstPass(blurNode);
      const bigger = firstPass(blurNode, { size: 32, filter: "box" });
      expect(bigger.uniforms).toMatchObject({ size: 32, ftype: 1 });
      expect(bigger.shader).toBe(base.shader);
    });

    it("inherits resolution and format from its input", () => {
      expect(blurNode.resolutionPolicy).toEqual({ kind: "inherit", input: "input" });
      expect(blurNode.formatPolicy).toEqual({ kind: "inherit", input: "input" });
    });
  });

  describe("Displace", () => {
    /**
     * §V56/§V57: the displacement input is DATA. Colour-converting it would rescale the
     * offsets through a gamma curve and silently move the geometry. The port says so, and
     * the node converts neither input.
     */
    it("declares the displacement input as data, not colour", () => {
      const disp = displaceNode.inputs.find((port) => port.id === "disp");
      expect(disp?.description).toMatch(/DATA, not colour/);
    });

    /**
     * Shape follows the image being displaced, not the field doing the displacing — a
     * low-resolution noise driving a full-resolution image is normal, and must not shrink
     * the result.
     */
    it("takes resolution and format from the source, not the displacement field", () => {
      expect(displaceNode.resolutionPolicy).toEqual({ kind: "inherit", input: "source" });
      expect(displaceNode.formatPolicy).toEqual({ kind: "inherit", input: "source" });
    });

    it("binds both textures and defaults to red/green as the two drivers, TD-style", () => {
      const pass = firstPass(displaceNode);
      expect(pass.textures).toEqual([
        { binding: "inputTexture", resourceId: inputResourceId("source") },
        { binding: "displaceTexture", resourceId: inputResourceId("disp") },
      ]);
      expect(pass.uniforms).toMatchObject({
        sourcex: 1,
        sourcey: 2,
        weight: [0.1, 0.1],
        offset: [0.5, 0.5],
      });
    });

    it("reports which input is missing rather than emitting half a pass", () => {
      const compiled = displaceNode.compile(compileContext({ inputs: ["source"] }));
      expect(compiled.passes).toEqual([]);
      expect(compiled.diagnostics?.[0]?.message).toContain('input port "disp"');
    });
  });
});
