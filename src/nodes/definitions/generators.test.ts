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
      // uv's output is coordinates, not light — the one generator declaring `data`
      // (T768/§V57c); everything else is colour.
      expect(definition.outputs[0]?.type, definition.type).toEqual({
        kind: "texture2d",
        sample: "float",
        channels: 4,
        ...(definition.type === "uv" ? { space: "data" } : {}),
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

  describe("Ramp (T270)", () => {
    const stop = (position: number, color: readonly [number, number, number, number]) => ({
      position,
      color,
    });

    it("packs an N-stop list into the capped uniform table, count first", () => {
      const pass = firstPass(rampNode, {
        stops: [stop(0, [1, 0, 0, 1]), stop(0.5, [0, 1, 0, 1]), stop(1, [0, 0, 1, 0.5])],
        type: "radial",
        interp: "smooth",
      });
      expect(pass.uniforms).toMatchObject({
        count: 3,
        c0: [1, 0, 0, 1],
        c1: [0, 1, 0, 1],
        c2: [0, 0, 1, 0.5],
        // Four positions to a vector; the tail repeats the last stop so a stray read is
        // the edge colour rather than uninitialised memory.
        p0: [0, 0.5, 1, 1],
        rtype: 2,
        interp: 1,
      });
    });

    /**
     * `count` is the only thing that says how much of the table is real, so a shader that
     * read past it would render whatever the previous write left behind. The uniform is
     * asserted rather than assumed for exactly that reason.
     */
    it("says how many stops are live, and pads the rest", () => {
      const pass = firstPass(rampNode, { stops: [stop(0.25, [0.5, 0.5, 0.5, 1])] });
      expect(pass.uniforms?.["count"]).toBe(1);
      expect(pass.uniforms?.["c15"]).toEqual([0.5, 0.5, 0.5, 1]);
      expect(pass.uniforms?.["p3"]).toEqual([0.25, 0.25, 0.25, 0.25]);
    });

    it("reports the stops it could not fit instead of dropping them quietly", () => {
      const many = Array.from({ length: 20 }, (_, index) =>
        stop(index / 19, [index / 19, 0, 0, 1] as [number, number, number, number]),
      );
      const compiled = rampNode.compile(compileContext({ parameters: { stops: many } }));
      const capped = (compiled.diagnostics ?? []).find((d) => d.code === "ramp.stops.capped");
      // A gradient missing its last four colours with nothing to point at is the failure
      // this diagnostic exists to prevent.
      expect(capped?.message).toContain("20 stops");
      expect(capped?.message).toContain("first 16");
    });

    it("reports a list whose positions run backwards, because order is authored", () => {
      const compiled = rampNode.compile(
        compileContext({ parameters: { stops: [stop(0.8, [1, 1, 1, 1]), stop(0.2, [0, 0, 0, 1])] } }),
      );
      // Not re-sorted: the list order IS the gradient, so the editor and the picture
      // agree, and the thing that is odd gets said once.
      expect((compiled.diagnostics ?? []).map((d) => d.code)).toContain("ramp.stops.unordered");
    });

    /**
     * §V196 — the stop list carries colour, so it declares its space exactly as a `color`
     * parameter does, and the resolver decodes PER ENTRY. Decoding at the container level,
     * or not at all, is B8 once per stop with only one swatch being checked.
     */
    it("declares its stop list as display-space", () => {
      expect(rampNode.parameters["stops"]).toMatchObject({
        type: "stops",
        space: "display",
        maxStops: 16,
      });
    });

    /** §V10: a v1 Ramp's two keys ARE the two-stop degenerate case; nothing is guessed. */
    it("migrates a two-colour v1 Ramp into a two-stop list", () => {
      const migrated = rampNode.migrate?.(1, {
        color1: [1, 0, 0, 1],
        color2: [0, 0, 1, 1],
        type: "vertical",
        period: 2,
      });
      expect(migrated?.parameters).toEqual({
        type: "vertical",
        period: 2,
        stops: [
          { position: 0, color: [1, 0, 0, 1] },
          { position: 1, color: [0, 0, 1, 1] },
        ],
      });
    });

    it("leaves an already-migrated node alone", () => {
      const stops = [stop(0, [0, 0, 0, 1]), stop(1, [1, 1, 1, 1])];
      expect(rampNode.migrate?.(2, { stops })?.parameters).toEqual({ stops });
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
