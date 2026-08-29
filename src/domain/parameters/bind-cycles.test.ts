import { describe, expect, it } from "vitest";
import type { GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import type { ParameterSchema, ParameterSlot } from "../types/parameters.ts";
import { bindCycleDiagnostics } from "./bind-cycles.ts";

/**
 * §V110: a bind cycle is an authoring-time diagnostic, never a per-frame hang. These
 * tests are the reason the patch gate can refuse a cycle by calling one function.
 */

const schema: ParameterSchema = {
  a: { type: "number", label: "A", default: 0 },
  b: { type: "number", label: "B", default: 0 },
  c: { type: "number", label: "C", default: 0 },
  color: { type: "color", label: "Color", default: [0, 0, 0, 1], space: "linear" },
};

function bindSlot(ref: string): ParameterSlot {
  return { mode: "bind", bindings: { bind: { kind: "bind", ref } } };
}

function nodeWith(parameters: GraphNode["parameters"]): GraphNode {
  return {
    id: "n1" as NodeId,
    type: "test.node",
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
  };
}

describe("bindCycleDiagnostics (T205, §V110)", () => {
  it("accepts an acyclic chain", () => {
    const node = nodeWith({ a: bindSlot("b"), b: bindSlot("c"), c: 3 });
    expect(bindCycleDiagnostics(node, schema)).toEqual([]);
  });

  it("names a two-step loop in full", () => {
    const node = nodeWith({ a: bindSlot("b"), b: bindSlot("a") });
    const found = bindCycleDiagnostics(node, schema);
    expect(found).toHaveLength(1);
    expect(found[0]?.code).toBe("parameter.bindCycle");
    expect(found[0]?.message).toMatch(/a → b → a|b → a → b/);
  });

  it("catches a self-bind", () => {
    const found = bindCycleDiagnostics(nodeWith({ a: bindSlot("a") }), schema);
    expect(found).toHaveLength(1);
  });

  it("sees the loop that closes through compound assembly (§V113)", () => {
    // a binds color.r; resolving color.r resolves color, which assembles color.g,
    // which binds a. No single bind is circular — the assembly edges close it.
    const node = nodeWith({ a: bindSlot("color.r"), "color.g": bindSlot("a") });
    const found = bindCycleDiagnostics(node, schema);
    expect(found).toHaveLength(1);
    expect(found[0]?.message).toContain("color");
  });

  it("ignores parent refs (the chain outward is a DAG by construction, §V81)", () => {
    const node = nodeWith({ a: bindSlot("parent.a") });
    expect(bindCycleDiagnostics(node, schema)).toEqual([]);
  });

  it("ignores a RETAINED bind while another mode is active (§V108)", () => {
    // The bind payload loops, but neither slot is IN bind mode: retained data is not a
    // dependency, and activating it is a patch that re-runs this check.
    const dormant: ParameterSlot = {
      mode: "static",
      bindings: { static: { kind: "static", value: 1 }, bind: { kind: "bind", ref: "b" } },
    };
    const node = nodeWith({ a: dormant, b: bindSlot("a") });
    expect(bindCycleDiagnostics(node, schema)).toEqual([]);
  });
});
