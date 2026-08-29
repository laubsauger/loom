import { describe, expect, it } from "vitest";
import { validateGraph, validateRequiredInputs } from "./validate.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { createCompilerTestRegistry, testEdge, testGraph, testNode } from "./test-support.ts";

const registry = createCompilerTestRegistry().view();

describe("validateGraph — definitions and parameters (T24)", () => {
  it("reports an unknown node type instead of throwing", () => {
    const graph = testGraph([testNode("a", "fx.nope")]);
    const result = validateGraph(graph, registry);

    expect(result.nodes.has("a")).toBe(false);
    expect(result.diagnostics.map((d) => d.code)).toContain(CompilerDiagnosticCode.unknownNodeType);
  });

  it("fills declared parameters from their defaults", () => {
    const result = validateGraph(testGraph([testNode("a", "fx.blur")]), registry);
    expect(result.nodes.get("a")?.parameters).toEqual({ radius: 4 });
  });

  /** A wrong-typed value is a reported error and falls back to the default — never a silent cast. */
  it("rejects an out-of-range parameter and uses the default", () => {
    const graph = testGraph([testNode("a", "fx.blur", { parameters: { radius: 999 } })]);
    const result = validateGraph(graph, registry);

    expect(result.nodes.get("a")?.parameters["radius"]).toBe(4);
    expect(result.diagnostics.some((d) => d.severity === "error" && d.nodeId === "a")).toBe(true);
  });

  it("warns about a parameter the definition does not declare", () => {
    const graph = testGraph([testNode("a", "fx.blur", { parameters: { radius: 2, ghost: 1 } })]);
    const result = validateGraph(graph, registry);

    expect(
      result.diagnostics.some((d) => d.code === CompilerDiagnosticCode.parameterUnknown),
    ).toBe(true);
  });

  it("warns when the saved definition version differs from the registry's", () => {
    const graph = testGraph([testNode("a", "fx.blur", { definitionVersion: 0 })]);
    const result = validateGraph(graph, registry);

    expect(
      result.diagnostics.some((d) => d.code === CompilerDiagnosticCode.definitionVersion),
    ).toBe(true);
  });
});

describe("validateGraph — connections (§V13, §V14)", () => {
  it("rejects a connection between different port types", () => {
    const graph = testGraph(
      [testNode("gen", "fx.generator"), testNode("mono", "fx.mono")],
      [testEdge("e1", ["gen", "out"], ["mono", "source"])],
    );
    const result = validateGraph(graph, registry);

    expect(result.edges).toHaveLength(0);
    const diagnostic = result.diagnostics.find(
      (d) => d.code === CompilerDiagnosticCode.portIncompatible,
    );
    expect(diagnostic?.severity).toBe("error");
    // §V13: the fix is a conversion node, and the message has to say so.
    expect(diagnostic?.suggestion).toMatch(/conversion/i);
  });

  it("rejects a second edge into a non-variadic input and keeps the first", () => {
    const graph = testGraph(
      [testNode("a", "fx.generator"), testNode("b", "fx.generator"), testNode("blur", "fx.blur")],
      [
        testEdge("e1", ["a", "out"], ["blur", "source"]),
        testEdge("e2", ["b", "out"], ["blur", "source"]),
      ],
    );
    const result = validateGraph(graph, registry);

    expect(result.edges.map((edge) => edge.id)).toEqual(["e1"]);
    expect(result.diagnostics.some((d) => d.code === CompilerDiagnosticCode.portOccupied)).toBe(true);
  });

  it("accepts many edges into a variadic input", () => {
    const graph = testGraph(
      [testNode("a", "fx.generator"), testNode("b", "fx.generator"), testNode("c", "fx.composite")],
      [
        testEdge("e1", ["a", "out"], ["c", "layers"]),
        testEdge("e2", ["b", "out"], ["c", "layers"]),
      ],
    );
    const result = validateGraph(graph, registry);

    expect(result.edges.map((edge) => edge.id)).toEqual(["e1", "e2"]);
    expect(result.diagnostics).toHaveLength(0);
  });

  it("marks an edge leaving a declared temporal output as temporal (§V4)", () => {
    const graph = testGraph(
      [testNode("fb", "fx.feedback"), testNode("blur", "fx.blur")],
      [testEdge("e1", ["fb", "out"], ["blur", "source"])],
    );
    const result = validateGraph(graph, registry);
    expect(result.edges[0]?.temporal).toBe(true);
  });

  it("reports a required input with nothing connected, for kept nodes only", () => {
    const graph = testGraph([testNode("blur", "fx.blur"), testNode("lonely", "fx.blur")]);
    const result = validateGraph(graph, registry);

    const reported = validateRequiredInputs(result.nodes, result.edges, new Set(["blur"]));
    expect(reported).toHaveLength(1);
    expect(reported[0]?.code).toBe(CompilerDiagnosticCode.inputMissing);
    expect(reported[0]?.nodeId).toBe("blur");
  });
});
