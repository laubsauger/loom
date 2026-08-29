import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile.ts";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { orderNodes } from "./topology.ts";
import type { CompileEdge } from "./types.ts";
import {
  createCompilerTestRegistry,
  testCapabilities,
  testEdge,
  testGraph,
  testNode,
  testSettings,
} from "./test-support.ts";
import type { GraphDocument } from "../domain/types/graph.ts";

const registry = createCompilerTestRegistry().view();

const compile = (graph: GraphDocument) =>
  compileGraph({ graph, settings: testSettings(), registry, capabilities: testCapabilities() });

const edge = (id: string, from: string, to: string, temporal = false): CompileEdge => ({
  id,
  source: { nodeId: from, portId: "out" },
  target: { nodeId: to, portId: "source" },
  temporal,
});

describe("orderNodes (T25, §V4)", () => {
  it("orders a chain by dependency", () => {
    const result = orderNodes(new Set(["c", "a", "b"]), [edge("e1", "a", "b"), edge("e2", "b", "c")]);
    expect(result.order).toEqual(["a", "b", "c"]);
    expect(result.cycles).toEqual([]);
  });

  it("breaks ties by node id, so the order is stable across identical graphs", () => {
    const edges = [edge("e1", "a", "z"), edge("e2", "m", "z")];
    const forward = orderNodes(new Set(["a", "m", "z"]), edges);
    const shuffled = orderNodes(new Set(["z", "m", "a"]), [...edges].reverse());
    expect(forward.order).toEqual(["a", "m", "z"]);
    expect(shuffled.order).toEqual(forward.order);
  });

  it("removes temporal edges before ordering, so a temporal loop is orderable", () => {
    const result = orderNodes(new Set(["a", "b"]), [edge("e1", "a", "b"), edge("e2", "b", "a", true)]);
    expect(result.cycles).toEqual([]);
    expect(result.order).toEqual(["a", "b"]);
    expect(result.temporalEdges.map((entry) => entry.id)).toEqual(["e2"]);
    expect(result.currentFrameEdges.map((entry) => entry.id)).toEqual(["e1"]);
  });

  it("names only the nodes that actually form the cycle, not everything downstream", () => {
    const result = orderNodes(new Set(["a", "b", "tail"]), [
      edge("e1", "a", "b"),
      edge("e2", "b", "a"),
      edge("e3", "b", "tail"),
    ]);
    expect(result.cycles).toEqual([["a", "b"]]);
    expect(result.order).toEqual([]);
  });

  it("catches a node wired to itself", () => {
    const result = orderNodes(new Set(["a"]), [edge("e1", "a", "a")]);
    expect(result.cycles).toEqual([["a"]]);
  });
});

describe("compileGraph — cycles (§V4)", () => {
  const ordinaryCycle = (): GraphDocument =>
    testGraph(
      [testNode("b1", "fx.blur"), testNode("b2", "fx.blur"), testNode("out", "fx.output")],
      [
        testEdge("e1", ["b1", "out"], ["b2", "source"]),
        testEdge("e2", ["b2", "out"], ["b1", "source"]),
        testEdge("e3", ["b1", "out"], ["out", "source"]),
      ],
    );

  it("rejects an ordinary cycle with a diagnostic naming the participants", () => {
    const plan = compile(ordinaryCycle());

    expect(plan.ok).toBe(false);
    expect(plan.passes).toEqual([]);
    const diagnostic = plan.diagnostics.find((d) => d.code === CompilerDiagnosticCode.cycle);
    expect(diagnostic?.severity).toBe("error");
    expect(diagnostic?.message).toContain("b1");
    expect(diagnostic?.message).toContain("b2");
    // The fix is a temporal node, and the message has to say so.
    expect(diagnostic?.suggestion).toMatch(/temporal/i);
  });

  it("compiles a cycle that passes through a temporal node", () => {
    const graph = testGraph(
      [testNode("fb", "fx.feedback"), testNode("blur", "fx.blur"), testNode("out", "fx.output")],
      [
        testEdge("e1", ["fb", "out"], ["blur", "source"]),
        testEdge("e2", ["blur", "out"], ["fb", "source"]),
        testEdge("e3", ["blur", "out"], ["out", "source"]),
      ],
    );
    const plan = compile(graph);

    expect(plan.diagnostics.filter((d) => d.code === CompilerDiagnosticCode.cycle)).toEqual([]);
    expect(plan.ok).toBe(true);
    expect(plan.order).toEqual(["blur", "fb", "out"]);
  });
});
