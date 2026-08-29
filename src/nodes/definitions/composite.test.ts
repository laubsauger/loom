import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import {
  addNode,
  compositeNode,
  compositeNodes,
  crossNode,
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
      "composite",
      "cross",
      "difference",
      "mask",
      "multiply",
      "over",
      "screen",
    ]);
  });

  /**
   * The Composite node (T232) — TD's Composite TOP: the same blends, selected by parameter.
   *
   * The first test here is the one that matters. §V140 says a blend operation has ONE
   * implementation, and the way that claim dies is not deliberately: someone tweaks Over's
   * alpha handling in the named node, misses the Composite path, and the two silently
   * disagree for months because nothing compares them. Comparing the emitted SHADER TEXT is
   * the cheapest possible check that they are literally the same code, and it fails the
   * moment anyone forks the maths.
   */
  describe("the Composite node", () => {
    it("emits the identical shader to the named node for every operation (§V140)", () => {
      const named = { over: overNode, add: addNode, multiply: multiplyNode, screen: screenNode, difference: differenceNode };
      for (const [operation, node] of Object.entries(named)) {
        expect(firstPass(compositeNode, { operation }).shader).toBe(firstPass(node).shader);
      }
    });

    it("defaults to over, and falls back to over on an unknown operation", () => {
      const fallback = firstPass(compositeNode, { operation: "not-a-blend" }).shader;
      expect(firstPass(compositeNode).shader).toBe(firstPass(overNode).shader);
      // A project written by a newer build naming an operation this one lacks must still
      // render something recognisable rather than failing to compile.
      expect(fallback).toBe(firstPass(overNode).shader);
    });

    it("puts the operation in the pass id, so switching it is new contents not a carry-over", () => {
      // Carry-over keys on structure: if the id were stable across operations, switching
      // Over to Add would keep the old picture until something else invalidated it.
      expect(firstPass(compositeNode, { operation: "add" }).id).not.toBe(
        firstPass(compositeNode, { operation: "screen" }).id,
      );
    });

    it("marks the operation compile-time, since it selects the shader (§V141)", () => {
      // Not a uniform. §V5's uniform-only fast path only means anything while structural
      // changes are classified as structural, and a dropdown is exactly the parameter
      // someone would be tempted to treat as a value.
      expect(compositeNode.parameters["operation"]?.compileTime).toBe(true);
      expect(compositeNode.parameters["opacity"]?.compileTime).toBeUndefined();
    });

    it("keeps the named nodes free of an operation parameter", () => {
      // The named nodes exist to be self-documenting; giving them a menu would make them
      // Composite with extra steps.
      for (const node of blendNodes) expect(node.parameters["operation"]).toBeUndefined();
    });
  });

  describe("Cross (T234)", () => {
    it("is not an operation in Composite's menu", () => {
      // The design claim, pinned so it is not "tidied up" later by someone who notices
      // Cross looks like a blend. Every entry in that menu is a fixed function of two
      // pixels; Cross is a function of two pixels AND a factor, and the factor is the
      // reason you reach for it. In the menu it would need a control none of its
      // neighbours have.
      const operation = compositeNode.parameters["operation"];
      const options = operation?.type === "enum" ? operation.options : [];
      expect(options.map((option) => option.value)).not.toContain("cross");
      expect(crossNode.parameters["cross"]).toBeDefined();
    });

    it("passes the factor as a uniform rather than specialising the shader", () => {
      // The opposite call from `operation` (§V141), and for the opposite reason: this one
      // is meant to be animated every frame, so it must stay on §V5's uniform-only path.
      expect(crossNode.parameters["cross"]?.compileTime).toBeUndefined();
      expect(firstPass(crossNode, { cross: 0.25 }).uniforms).toEqual({ cross: 0.25 });
    });

    it("inherits resolution and format from input 1, so a dissolve does not resize", () => {
      expect(crossNode.resolutionPolicy).toEqual({ kind: "inherit", input: "in1" });
      expect(crossNode.formatPolicy).toEqual({ kind: "inherit", input: "in1" });
    });
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
