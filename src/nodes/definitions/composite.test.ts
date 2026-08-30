import { describe, expect, it } from "vitest";

import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import {
  addNode,
  compositeNode,
  MAX_COMPOSITE_LAYERS,
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
        expect(definition.inputs[1]?.label, definition.type).toBe("Behind");
        // T226: the layers behind the front one are one VARIADIC port, not a second slot.
        expect(definition.inputs[1]?.variadic, definition.type).toBe(true);
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
          { binding: "backTexture0", resourceId: inputResourceId("in2") },
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
      // Over is now the Porter-Duff sum with weights (1, 1-a.a) rather than a hand-written
      // formula (T282). Algebraically identical — `Ap*1 + Bp*(1-a.a)` over
      // `a.a*1 + b.a*(1-a.a)` IS the classic source-over — so the claim is unchanged and
      // the weights are what to pin: they are the thing that would be wrong if someone
      // mistyped one.
      const shader = firstPass(overNode).shader;
      expect(shader).toContain("porterDuff(front, back, 1.0, 1.0 - front.a)");
      expect(shader).toContain("rgb / max(outAlpha, 1e-6)");
    });

    it("gives every Porter-Duff operator its own distinct weights (T282)", () => {
      // The failure this catches is a copy-paste: six operators built from one function
      // differ ONLY in two numbers, so a duplicated weight pair produces two operators that
      // silently do the same thing. Distinctness is the whole assertion.
      const shaders = ["over", "under", "inside", "outside", "atop", "xor"].map(
        (operation) => firstPass(compositeNode, { operation }).shader,
      );
      expect(new Set(shaders).size).toBe(shaders.length);
    });

    it("keeps the Porter-Duff operators out of the node library", () => {
      // Menu-only, deliberately: a named node earns its place by being recognisable at a
      // glance, and "Xor" is not that. Someone reaching for it already knows they want a
      // compositing algebra.
      for (const operation of ["under", "inside", "outside", "atop", "xor"]) {
        expect(compositeNodes.some((node) => node.type === operation)).toBe(false);
      }
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

/**
 * The family goes variadic (T226) — the decisions that are arguments, not code.
 */
describe("variadic compositing (T226, §V131)", () => {
  /** One front layer and `count` layers behind it, in that declared order. */
  function foldPass(definition: NodeDefinition, count: number, parameters = {}) {
    const inputs = ["in1", ...Array.from({ length: count }, () => "in2")];
    const options = { inputs, parameters };
    const compiled = definition.compile(compileContext(options));
    return { compiled, read: readNodePlan(compiled.passes, options) };
  }

  it("folds left to right with the FIRST input in front", () => {
    // Not a coin flip between two readings. Folding the other way would still be a
    // composite — and every two-input graph ever saved would render its layers swapped,
    // because `over` is asymmetric. This direction degenerates to exactly the old
    // two-input shader at one layer, which is what makes the change invisible to existing
    // documents (the Dawn pixel test in src/tests/headless/porter-duff.test.ts is the
    // other half of that claim). It also matters beyond Over: `difference` is not
    // associative, so the fold direction changes the picture from identical wiring.
    const { read } = foldPass(overNode, 3);
    const pass = read.passes[0];
    const shader = pass?.kind === "effect" ? pass.shader : "";

    const acc = shader.indexOf("var acc = textureSampleLevel(frontTexture");
    const first = shader.indexOf("blendPixel(acc, textureSampleLevel(backTexture0");
    const second = shader.indexOf("blendPixel(acc, textureSampleLevel(backTexture1");
    const third = shader.indexOf("blendPixel(acc, textureSampleLevel(backTexture2");
    expect(acc).toBeGreaterThan(-1);
    expect(first).toBeGreaterThan(acc);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
  });

  it("binds one texture per layer, in the order the compiler hands them over", () => {
    // The compiler sorts a variadic port's bindings by the document's declared order
    // (§V131, T225); this node must not re-sort, filter or reverse them. Any rearranging
    // here would be a second opinion about layer order, and the user's would lose.
    const { read } = foldPass(overNode, 3);
    const pass = read.passes[0];
    expect(pass?.kind === "effect" ? pass.textures : undefined).toEqual([
      { binding: "frontTexture", resourceId: inputResourceId("in1") },
      { binding: "backTexture0", resourceId: inputResourceId("in2", 0) },
      { binding: "backTexture1", resourceId: inputResourceId("in2", 1) },
      { binding: "backTexture2", resourceId: inputResourceId("in2", 2) },
    ]);
  });

  it("keeps one definition of the blend maths at every layer count (§V140)", () => {
    // The whole reason the factory exists. Composite and the named node must still agree
    // once the shader depends on how many inputs are wired — otherwise a three-layer Over
    // and a three-layer Composite-set-to-over are two programs, and only one gets the next
    // fix. The blend itself appears exactly once in the text no matter how deep the fold.
    for (const layers of [1, 3]) {
      const named = foldPass(overNode, layers).read.passes[0];
      const menu = foldPass(compositeNode, layers, { operation: "over" }).read.passes[0];
      const namedShader = named?.kind === "effect" ? named.shader : "named";
      const menuShader = menu?.kind === "effect" ? menu.shader : "menu";
      expect(namedShader, `${layers} layers`).toBe(menuShader);
      expect(namedShader.match(/porterDuff\(front, back/g), `${layers} layers`).toHaveLength(1);
    }
  });

  it("changes its pass id with the layer count, so a new layer is new contents", () => {
    // The pass id feeds the structure key: if adding a layer kept the id, the backend
    // could carry the old pass — and its old bindings — across the rebuild (§V62b).
    const one = foldPass(overNode, 1).compiled.passes[0] as { id: string };
    const two = foldPass(overNode, 2).compiled.passes[0] as { id: string };
    expect(one.id).not.toBe(two.id);
  });

  it("refuses more layers than it can bind, naming the way out", () => {
    // WebGPU guarantees only 16 sampled textures per stage, so the cap is real rather than
    // stylistic. Folding the first eight and dropping the rest would be a layer that is
    // visibly wired and invisibly ignored — the exact failure a diagnostic exists for.
    const { compiled } = foldPass(overNode, MAX_COMPOSITE_LAYERS + 1);
    expect(compiled.passes).toEqual([]);
    expect(compiled.diagnostics?.[0]?.code).toBe("node.compile.tooManyInputs");
    expect(compiled.diagnostics?.[0]?.suggestion).toMatch(/second Composite/);
  });

  it("still requires something behind the front layer", () => {
    // A variadic port is not an optional one. "Composite with nothing to composite
    // against" is a half-built graph, and saying so beats rendering the front layer and
    // letting the user wonder which operation did nothing.
    const compiled = overNode.compile(compileContext({ inputs: ["in1"] }));
    expect(compiled.passes).toEqual([]);
    expect(compiled.diagnostics?.[0]?.message).toContain('input port "in2"');
  });
});
