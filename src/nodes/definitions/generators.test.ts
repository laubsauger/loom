import { describe, expect, it } from "vitest";

import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { checkerNode, circleNode, generatorNodes, rampNode, uvNode } from "./generators.ts";
import { compileContext, readNodePlan } from "./test-support.ts";

/** Source nodes: Ramp, UV, Checker, Circle (T40). */

function firstPass(definition: (typeof generatorNodes)[number], parameters = {}) {
  const compiled = definition.compile(compileContext({ parameters }));
  const read = readNodePlan(compiled.passes);
  expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(read.ok).toBe(true);
  const pass = read.passes[0];
  if (pass?.kind !== "effect") throw new Error(`${definition.type} did not emit an effect pass.`);
  return pass;
}

describe("generator nodes (T40)", () => {
  it("all register together in one registry with no manifest diagnostics", () => {
    for (const definition of generatorNodes) expect(validateNodeDefinition(definition)).toEqual([]);
    const registry = createNodeRegistry(generatorNodes);
    expect(registry.list().map((definition) => definition.type)).toEqual([
      "checker",
      "circle",
      "ramp",
      "rectangle",
      "uv",
    ]);
  });

  /**
   * A generator has no input, so it has nothing to inherit a size or a format from.
   * `{kind:"project"}` is the only honest policy — anything else would be a size nobody
   * chose (§V21).
   */
  it("take their resolution and format from the project, and declare no inputs", () => {
    for (const definition of generatorNodes) {
      expect(definition.inputs, definition.type).toEqual([]);
      expect(definition.resolutionPolicy, definition.type).toEqual({ kind: "project" });
      expect(definition.formatPolicy, definition.type).toEqual({ kind: "project" });
      expect(definition.outputs.map((port) => port.id), definition.type).toEqual(["out"]);
      expect(definition.outputs[0]?.type, definition.type).toEqual({
        kind: "texture2d",
        sample: "float",
        channels: 4,
      });
    }
  });

  it("each emit exactly one pass the backend accepts", () => {
    for (const definition of generatorNodes) {
      const pass = firstPass(definition);
      expect(pass.uniformBinding, definition.type).toBe("params");
      expect(pass.textures, definition.type).toEqual([]);
    }
  });

  it("report a diagnostic instead of a malformed pass when no target was assigned", () => {
    for (const definition of generatorNodes) {
      const compiled = definition.compile(compileContext({ outputs: [] }));
      expect(compiled.passes, definition.type).toEqual([]);
      expect(compiled.diagnostics?.[0]?.code, definition.type).toBe("node.compile.missingResource");
    }
  });

  describe("Ramp", () => {
    it("round-trips its colour keys and type into the uniforms", () => {
      const pass = firstPass(rampNode, {
        color1: [1, 0, 0, 1],
        color2: [0, 0, 1, 0.5],
        type: "radial",
        interp: "smooth",
      });
      expect(pass.uniforms).toMatchObject({
        color1: [1, 0, 0, 1],
        color2: [0, 0, 1, 0.5],
        rtype: 2,
        interp: 1,
      });
    });

    /**
     * A colour parameter comes out of a picker, which shows perceptual values — the same
     * claim the Solid node makes. Decoding it belongs to the parameter layer, not to a
     * shader quietly applying a curve (§V13, §V56).
     */
    it("declares its colour parameters as display-space", () => {
      for (const key of ["color1", "color2"]) {
        expect(rampNode.parameters[key]).toMatchObject({ type: "color", space: "display" });
      }
    });
  });

  describe("UV", () => {
    /** Coordinates are DATA (§V56): nothing may colour-convert them. */
    it("says on the port that its output is data, not colour", () => {
      expect(uvNode.outputs[0]?.description).toMatch(/DATA/);
    });

    it("flips v as a uniform, not as a different shader", () => {
      expect(firstPass(uvNode).uniforms).toEqual({ flipv: 0 });
      expect(firstPass(uvNode, { flipv: true }).uniforms).toEqual({ flipv: 1 });
    });
  });

  describe("Checker", () => {
    it("passes size and offset through as vec2 uniforms", () => {
      const pass = firstPass(checkerNode, { size: [4, 3], offset: [0.5, 0] });
      expect(pass.uniforms).toMatchObject({ size: [4, 3], offset: [0.5, 0] });
    });
  });

  describe("Circle", () => {
    it("switches between fill and signed distance by uniform, without recompiling (§V5)", () => {
      const fill = firstPass(circleNode);
      const distance = firstPass(circleNode, { mode: "distance" });
      expect(fill.uniforms?.["mode"]).toBe(0);
      expect(distance.uniforms?.["mode"]).toBe(1);
      expect(distance.shader).toBe(fill.shader);
    });

    it("derives aspect correction from the resolved size, and honours turning it off", () => {
      const on = circleNode.compile(compileContext({ resolution: [800, 400] }));
      expect((on.passes[0] as { uniforms: { aspect: number } }).uniforms.aspect).toBe(2);
      const off = circleNode.compile(
        compileContext({ resolution: [800, 400], parameters: { aspectcorrect: false } }),
      );
      expect((off.passes[0] as { uniforms: { aspect: number } }).uniforms.aspect).toBe(1);
    });

    /** The distance mode makes the output DATA; the port has to say so (§V56, §V57). */
    it("documents that its output space depends on the mode", () => {
      expect(circleNode.outputs[0]?.description).toMatch(/DATA/);
    });
  });
});
