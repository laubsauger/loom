import { describe, expect, it } from "vitest";

import { compileGraph } from "../../compiler/index.ts";
import type { GraphDocument, GraphNode, NodeResolutionOverride } from "../../domain/types/graph.ts";
import { TIER_B_CAPABILITIES } from "../../examples/runner.ts";
import { settings } from "../../examples/documents/builders.ts";
import { createNodeRegistry, validateNodeDefinition } from "../registry/registry.ts";
import { allNodeDefinitions } from "./index.ts";
import { fitNode, fitNodes, resolutionNode } from "./fit.ts";
import { effectiveParameterSchema } from "../../domain/parameters/resolve.ts";

/**
 * Fit and Resolution (T1824b, T1825b) through the real compiler: what size each comes out
 * at, and what the one shared pass is told. The pixels are `fit.gpu.test.ts`'s.
 */

const registry = createNodeRegistry(allNodeDefinitions).view();
const project = settings({ outputResolution: { width: 100, height: 50 }, colorPolicy: { workingSpace: "linear", displayTransform: "none" } });

function node(id: string, type: string, parameters: GraphNode["parameters"] = {}, resolution?: NodeResolutionOverride): GraphNode {
  return { id, type, definitionVersion: 1, position: { x: 0, y: 0 }, parameters, ...(resolution === undefined ? {} : { resolution }) };
}

/** A 64x32 solid → the node under test → Output. */
function chain(type: string, parameters: GraphNode["parameters"] = {}, resolution?: NodeResolutionOverride, source: GraphNode = node("src", "solid", { color: [1, 1, 1, 1] }, { mode: "fixed", width: 64, height: 32 })): GraphDocument {
  return {
    revision: 1,
    nodes: { src: source, fx: node("fx", type, parameters, resolution), out: node("out", "output") },
    edges: {
      a: { id: "a", source: { nodeId: "src", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
      b: { id: "b", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

function compiled(graph: GraphDocument) {
  const plan = compileGraph({ graph, settings: project, registry, capabilities: TIER_B_CAPABILITIES });
  expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  const pass = plan.passes.find((entry) => entry.kind === "effect" && entry.nodeId === "fx");
  if (pass?.kind !== "effect") throw new Error("the node under test emitted no effect pass");
  const size = plan.outputs.find((output) => output.nodeId === "fx")?.size;
  return { pass, size };
}

describe("Fit and Resolution (T1824b, T1825b)", () => {
  it("register with no manifest diagnostics, as TD's vocabulary", () => {
    for (const definition of fitNodes) expect(validateNodeDefinition(definition), definition.type).toEqual([]);
    expect(fitNodes.map((definition) => definition.type)).toEqual(["fit", "resolution"]);
  });

  /**
   * THE OUTPUT SIZE IS THE COMMON PAGE'S. Neither node has a size parameter: the per-node
   * override every node has is what sizes these too, so "how big is this node" has one
   * answer. And the shader places the input by the size the target actually has.
   */
  describe("their output size", () => {
    it("Fit: the project frame by default, whatever the input's shape", () => {
      const { size, pass } = compiled(chain("fit"));
      expect(size).toEqual([100, 50]);
      expect(pass.uniforms?.["targetSize"]).toEqual([100, 50]);
    });

    it("Fit: the Common Custom resolution when one is set", () => {
      const { size, pass } = compiled(chain("fit", {}, { mode: "fixed", width: 30, height: 40 }));
      expect(size).toEqual([30, 40]);
      expect(pass.uniforms?.["targetSize"]).toEqual([30, 40]);
    });

    it("Resolution: half the input by default, the Common preset or Use Input when set", () => {
      expect(compiled(chain("resolution")).size).toEqual([32, 16]);
      expect(compiled(chain("resolution", {}, { mode: "scale", factor: 2 })).size).toEqual([128, 64]);
      expect(compiled(chain("resolution", {}, { mode: "input" })).size).toEqual([64, 32]);
      expect(compiled(chain("resolution", {}, { mode: "limit", width: 16, height: 16 })).size).toEqual([16, 8]);
    });

    it("both keep the input's format: a resize is not a conversion (§V13)", () => {
      const plan = compileGraph({ graph: chain("fit"), settings: project, registry, capabilities: TIER_B_CAPABILITIES });
      const format = (id: string) => plan.outputs.find((output) => output.nodeId === id)?.format;
      expect(format("fx")).toBe(format("src"));
    });
  });

  it("Fit tells the shader its mode, justify, extend and background as the shader reads them", () => {
    const { pass } = compiled(chain("fit", { fit: "fitoutside", justifyh: "right", justifyv: "top", extend: "mirror" }));
    // fitoutside is TD's fifth mode; right is all of the slack on the left; top (TD's y up) is
    // none of it above, in the shader's top-down space; mirror is Extend's code 2.
    expect(pass.uniforms).toMatchObject({ fit: 4, justify: [1, 0], extend: 2 });
    const defaults = compiled(chain("fit")).pass.uniforms;
    expect(defaults).toMatchObject({ fit: 3, justify: [0.5, 0.5], extend: 3, smoothing: 1, background: [0, 0, 0, 0] });
    expect(compiled(chain("fit", { justifyh: "left", justifyv: "bottom" })).pass.uniforms?.["justify"]).toEqual([0, 1]);
  });

  /** The swatch shows display values; the picture is linear (§V56), so the colour is decoded. */
  it("Fit's background is the picked colour in linear light", () => {
    const { pass } = compiled(chain("fit", { bgcolor: [1, 0.5, 0, 0.25] }));
    const background = pass.uniforms?.["background"] as number[];
    expect(background[0]).toBe(1);
    expect(background[1]).toBeCloseTo(((0.5 + 0.055) / 1.055) ** 2.4, 6);
    expect(background[2]).toBe(0);
    expect(background[3]).toBe(0.25);
  });

  it("T1826b: a fresh Fit carries the identity transform, so the shader takes its untransformed path", () => {
    expect(compiled(chain("fit")).pass.uniforms).toMatchObject({ t: [0, 0], s: [1, 1], piv: [0, 0], rot: 0, xord: 0 });
  });

  it("T1826b: Fit's transform reaches the shader as the Transform node sends it — radians, TD's order index", () => {
    const { pass } = compiled(chain("fit", { t: [0.25, -0.5], r: 90, s: [2, -1], p: [0.1, 0.2], xord: "trs" }));
    expect(pass.uniforms).toMatchObject({ t: [0.25, -0.5], s: [2, -1], piv: [0.1, 0.2], xord: 5 });
    expect(pass.uniforms?.["rot"]).toBeCloseTo(Math.PI / 2, 12);
  });

  it("T1826b: Resolution has no transform page and always sends the identity", () => {
    expect(effectiveParameterSchema(resolutionNode, {})["t"]).toBeUndefined();
    expect(compiled(chain("resolution")).pass.uniforms).toMatchObject({ t: [0, 0], rot: 0, s: [1, 1], piv: [0, 0] });
  });

  it("Resolution is Fit at Fill, with Average Pixels by default", () => {
    const { pass } = compiled(chain("resolution"));
    expect(pass.uniforms).toMatchObject({ fit: 0, extend: 0, smoothing: 2 });
    expect(compiled(chain("resolution", { smoothing: "nearest" })).pass.uniforms?.["smoothing"]).toBe(0);
  });

  /**
   * A 32-bit float data map resizes on a device that cannot FILTER 32-bit floats (Tier B,
   * no float32-filterable): the pass reads with textureLoad and filters in the shader, so
   * the compiler's unfilterable-binding refusal never fires (§V57).
   */
  it("resize an r32float data map on Tier B without a binding refusal, and it stays data", () => {
    const field = node("src", "floatMapIn", { file: "", emptySource: "constant", emptyValue: 0.75, interpretation: "mask" });
    for (const definition of [fitNode, resolutionNode]) {
      const plan = compileGraph({ graph: chain(definition.type, {}, undefined, field), settings: project, registry, capabilities: TIER_B_CAPABILITIES });
      expect(plan.outputs.find((output) => output.nodeId === "src")?.format, definition.type).toBe("r32float");
      // The Output's own present pass samples whatever it shows, so on Tier B it refuses an
      // r32float picture whatever feeds it; the claim here is the resize's own pass.
      expect(plan.diagnostics.filter((d) => d.severity === "error" && d.nodeId === "fx"), definition.type).toEqual([]);
      expect(plan.passes.some((pass) => pass.kind === "effect" && pass.nodeId === "fx"), definition.type).toBe(true);
      const out = plan.outputs.find((output) => output.nodeId === "fx");
      expect([out?.format, out?.space], definition.type).toEqual(["r32float", "data"]);
    }
  });

  it("an unwired input is a diagnostic, not a malformed pass", () => {
    const graph = chain("fit");
    const { a: _wire, ...edges } = graph.edges;
    void _wire;
    const plan = compileGraph({ graph: { ...graph, edges }, settings: project, registry, capabilities: TIER_B_CAPABILITIES });
    expect(plan.passes.some((pass) => pass.kind === "effect" && pass.nodeId === "fx")).toBe(false);
    expect(plan.diagnostics.some((d) => d.nodeId === "fx")).toBe(true);
  });
});
