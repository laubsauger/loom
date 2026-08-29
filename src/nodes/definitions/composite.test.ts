import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import {
  addNode,
  compositeNodes,
  differenceNode,
  maskNode,
  multiplyNode,
  overNode,
  screenNode,
} from "./composite.ts";
import { compileContext, inputResourceId, readNodePlan } from "./test-support.ts";

/** Compositing: Over, Add, Multiply, Screen, Difference, Mask (T40). */

const blendNodes = [overNode, addNode, multiplyNode, screenNode, differenceNode];

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

describe("compositing nodes (T40)", () => {
  it("all register together with no manifest diagnostics", () => {
    for (const definition of compositeNodes) expect(validateNodeDefinition(definition)).toEqual([]);
    expect(createNodeRegistry(compositeNodes).list().map((d) => d.type)).toEqual([
      "add",
      "difference",
      "mask",
      "multiply",
      "over",
      "screen",
    ]);
  });

  describe("the blend family", () => {
    /**
     * TD's rule: input 1 goes OVER input 2. Every node in the family uses the same order,
     * so wiring one teaches you all five — and `opacity` always scales the front.
     */
    it("share TD's input order: front then back", () => {
      for (const definition of blendNodes) {
        expect(definition.inputs.map((port) => port.id), definition.type).toEqual(["in1", "in2"]);
        expect(definition.inputs[0]?.label, definition.type).toBe("Front");
        expect(definition.inputs[1]?.label, definition.type).toBe("Back");
      }
    });

    /** A composite has to pick one input to inherit from; it is the layer being placed. */
    it("inherit resolution and format from the front input", () => {
      for (const definition of blendNodes) {
        expect(definition.resolutionPolicy, definition.type).toEqual({ kind: "inherit", input: "in1" });
        expect(definition.formatPolicy, definition.type).toEqual({ kind: "inherit", input: "in1" });
      }
    });

    it("bind front and back to their own texture names", () => {
      for (const definition of blendNodes) {
        expect(firstPass(definition).textures, definition.type).toEqual([
          { binding: "frontTexture", resourceId: inputResourceId("in1") },
          { binding: "backTexture", resourceId: inputResourceId("in2") },
        ]);
      }
    });

    /**
     * Five nodes built from one factory must still be five DIFFERENT programs — if the
     * factory ever handed them the same shader text, Add and Multiply would both render
     * whichever one compiled first, and every plan signature would collide.
     */
    it("each carry their own shader text", () => {
      const shaders = blendNodes.map((definition) => firstPass(definition).shader);
      expect(new Set(shaders).size).toBe(blendNodes.length);
    });

    it("expose opacity as a uniform, so dragging it never recompiles (§V5)", () => {
      const full = firstPass(overNode);
      const half = firstPass(overNode, { opacity: 0.5 });
      expect(half.uniforms).toEqual({ opacity: 0.5 });
      expect(half.shader).toBe(full.shader);
    });

    /**
     * Straight (non-premultiplied) alpha, catalogue-wide: Over weights each layer by its
     * own coverage and divides the result back out. The division is the tell — a
     * premultiplied composite would not need it.
     */
    it("composite Over with straight alpha", () => {
      const shader = firstPass(overNode).shader;
      expect(shader).toContain("front.a + (back.a * (1.0 - front.a))");
      expect(shader).toContain("rgb / max(outAlpha, 1e-6)");
    });

    it("report which input is missing rather than emitting half a pass", () => {
      for (const definition of blendNodes) {
        const compiled = definition.compile(compileContext({ inputs: ["in1"] }));
        expect(compiled.passes, definition.type).toEqual([]);
        expect(compiled.diagnostics?.[0]?.message, definition.type).toContain('input port "in2"');
      }
    });
  });

  describe("Mask", () => {
    /** §V56/§V57: coverage, not light. Nothing may colour-convert it. */
    it("declares the mask input as data, not colour", () => {
      expect(maskNode.inputs.find((port) => port.id === "mask")?.description).toMatch(
        /DATA, not colour/,
      );
    });

    it("keeps the source's shape and binds both textures", () => {
      expect(maskNode.resolutionPolicy).toEqual({ kind: "inherit", input: "input" });
      expect(firstPass(maskNode).textures).toEqual([
        { binding: "inputTexture", resourceId: inputResourceId("input") },
        { binding: "maskTexture", resourceId: inputResourceId("mask") },
      ]);
    });

    it("multiplies alpha only, leaving colour untouched", () => {
      expect(firstPass(maskNode).shader).toContain("vec4f(source.rgb, source.a * coverage)");
    });
  });
});
