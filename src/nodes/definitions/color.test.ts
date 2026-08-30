import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { colorNodes, hsvNode, levelNode, limitNode, lookupNode, thresholdNode } from "./color.ts";
import { CHANNEL_OPTIONS } from "./parameter-readers.ts";
import { WGSL_CHANNEL, WGSL_LUMA } from "../shaders/common.wgsl.ts";
import { compileContext, inputResourceId, readNodePlan } from "./test-support.ts";

/** Colour operators: Level, HSV, Threshold, Lookup (T40). */

function firstPass(definition: NodeDefinition, parameters = {}) {
  const options = { inputs: definition.inputs.map((port) => port.id), parameters };
  const compiled = definition.compile(compileContext(options));
  const read = readNodePlan(compiled.passes, options);
  expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  expect(read.ok).toBe(true);
  const pass = read.passes[0];
  if (pass?.kind !== "effect") throw new Error(`${definition.type} did not emit an effect pass.`);
  return pass;
}

describe("colour nodes (T40)", () => {
  it("all register together with no manifest diagnostics", () => {
    for (const definition of colorNodes) expect(validateNodeDefinition(definition)).toEqual([]);
    expect(createNodeRegistry(colorNodes).list().map((d) => d.type)).toEqual([
      "hsv",
      "level",
      "limit",
      "lookup",
      "threshold",
    ]);
  });

  it("each emit one pass the backend accepts, and report rather than emit when unbound", () => {
    for (const definition of colorNodes) {
      expect(firstPass(definition).uniformBinding, definition.type).toBe("params");
      const unbound = definition.compile(compileContext({ inputs: [] }));
      expect(unbound.passes, definition.type).toEqual([]);
      expect(unbound.diagnostics?.[0]?.code, definition.type).toBe("node.compile.missingResource");
    }
  });

  /**
   * §V56: the working space is linear, and a colour node that reduces a colour to one
   * number must weight LINEAR light. Rec.709 weights applied to encoded values are a
   * classic silent wrongness — visible on saturated colours, invisible in a diff.
   */
  it("reduce colour to luminance with linear-light Rec.709 weights", () => {
    expect(WGSL_LUMA).toContain("vec3f(0.2126, 0.7152, 0.0722)");
    expect(WGSL_CHANNEL).toContain("luma(c.rgb)");
  });

  it("agree with the shader about which channel each enum index means", () => {
    CHANNEL_OPTIONS.forEach((option, index) => {
      const branch = index === CHANNEL_OPTIONS.length - 1 ? "default: { return" : `case ${index}u: { return`;
      expect(WGSL_CHANNEL, option.value).toContain(branch);
    });
    expect(CHANNEL_OPTIONS.map((option) => option.value)).toEqual([
      "luminance",
      "red",
      "green",
      "blue",
      "alpha",
    ]);
  });

  describe("Level", () => {
    it("uses TD's parameter names and round-trips them into uniforms", () => {
      expect(Object.keys(levelNode.parameters).sort()).toEqual([
        "blacklevel",
        "brightness",
        "contrast",
        "gamma1",
        "invert",
        "opacity",
        "whitelevel",
      ]);
      const pass = firstPass(levelNode, { gamma1: 2.2, contrast: 1.5, blacklevel: 0.1 });
      expect(pass.uniforms).toMatchObject({ gamma1: 2.2, contrast: 1.5, blacklevel: 0.1 });
    });

    it("changes only uniform values when a control moves, never the shader (§V5)", () => {
      expect(firstPass(levelNode, { brightness: 2 }).shader).toBe(firstPass(levelNode).shader);
    });

    it("inherits resolution and format from its input", () => {
      expect(levelNode.resolutionPolicy).toEqual({ kind: "inherit", input: "input" });
      expect(levelNode.formatPolicy).toEqual({ kind: "inherit", input: "input" });
    });
  });

  describe("HSV", () => {
    /** Degrees in the UI, turns in the shader — the conversion belongs in one place. */
    it("converts the hue offset from degrees to turns", () => {
      expect(firstPass(hsvNode, { hueoffset: 180 }).uniforms?.["hueoffset"]).toBeCloseTo(0.5, 10);
    });

    it("states that it works in linear RGB, with no sRGB round trip (§V56)", () => {
      expect(hsvNode.description).toMatch(/linear/i);
    });
  });

  describe("Threshold", () => {
    /** The output is a mask — data shaped like a colour, and the port has to say so. */
    it("documents its output as a mask in every channel", () => {
      expect(thresholdNode.outputs[0]?.description).toMatch(/DATA/);
    });

    it("passes the compare direction as an index, not a second shader", () => {
      const greater = firstPass(thresholdNode);
      const less = firstPass(thresholdNode, { compare: "less" });
      expect(greater.uniforms?.["compare"]).toBe(0);
      expect(less.uniforms?.["compare"]).toBe(1);
      expect(less.shader).toBe(greater.shader);
    });
  });

  describe("Lookup", () => {
    /**
     * The two inputs mean different things, and the policies encode that: the image shape
     * comes from `source`, the pixels (and therefore the colour space) come from `lookup`.
     * Inheriting both from the same port would make a Lookup fed by an encoded palette
     * claim to be linear.
     */
    it("takes its resolution from the source and its format from the lookup", () => {
      expect(lookupNode.resolutionPolicy).toEqual({ kind: "inherit", input: "source" });
      expect(lookupNode.formatPolicy).toEqual({ kind: "inherit", input: "lookup" });
    });

    it("requires both inputs, and says which one is data and which is colour", () => {
      expect(lookupNode.inputs.map((port) => port.id)).toEqual(["source", "lookup"]);
      expect(lookupNode.inputs.every((port) => port.optional !== true)).toBe(true);
      expect(lookupNode.inputs[0]?.description).toMatch(/DATA/);
      expect(lookupNode.inputs[1]?.description).toMatch(/colour space/i);
    });

    it("binds both textures to their own names", () => {
      expect(firstPass(lookupNode).textures).toEqual([
        { binding: "inputTexture", resourceId: inputResourceId("source") },
        { binding: "lookupTexture", resourceId: inputResourceId("lookup") },
      ]);
    });

    it("reports which input is missing rather than emitting half a pass", () => {
      const compiled = lookupNode.compile(compileContext({ inputs: ["source"] }));
      expect(compiled.passes).toEqual([]);
      expect(compiled.diagnostics?.[0]?.message).toContain('input port "lookup"');
    });
  });
});

/** Limit (T283) — the decisions that are arguments rather than code. */
describe("Limit (T283)", () => {
  it("quantizes to LEVELS, with the top step reaching the maximum", () => {
    // `steps - 1` divisions, not `steps`. Dividing by the step COUNT leaves the brightest
    // level permanently unreachable, which reads as a washed-out posterise and is the
    // classic off-by-one in this operator.
    const shader = firstPass(limitNode, { mode: "quantize" }).shader;
    expect(shader).toContain("levels - 1.0");
  });

  it("leaves alpha alone", () => {
    // Limiting COVERAGE is a different intent from limiting colour, and quantizing alpha
    // turns a soft edge into a stair — never what someone posterising an image asked for.
    expect(firstPass(limitNode).shader).toContain("vec4f(rgb, source.a)");
  });

  it("defaults to clamp, the mode that cannot surprise anyone", () => {
    // Loop and zigzag change the picture dramatically; a node that did either on being
    // dropped would look broken rather than useful.
    const uniforms = firstPass(limitNode).uniforms as Record<string, unknown>;
    expect(uniforms["mode"]).toBe(0);
  });
});
