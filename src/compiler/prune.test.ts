import { describe, expect, it } from "vitest";
import { CompilerDiagnosticCode } from "./diagnostics.ts";
import { isDeclaredSink, pruneToActiveSinks, resolveSinks } from "./prune.ts";
import { validateGraph } from "./validate.ts";
import {
  blurNode,
  createCompilerTestRegistry,
  outputNode,
  readbackNode,
  testEdge,
  testGraph,
  testNode,
} from "./test-support.ts";

const registry = createCompilerTestRegistry().view();

/** gen -> blur -> out, with a second dead branch gen -> dead. */
const graph = () =>
  testGraph(
    [
      testNode("gen", "fx.generator"),
      testNode("blur", "fx.blur"),
      testNode("out", "fx.output"),
      testNode("dead", "fx.blur"),
    ],
    [
      testEdge("e1", ["gen", "out"], ["blur", "source"]),
      testEdge("e2", ["blur", "out"], ["out", "source"]),
      testEdge("e3", ["gen", "out"], ["dead", "source"]),
    ],
  );

describe("isDeclaredSink (§V25)", () => {
  it("reads the manifest rather than inferring from port counts", () => {
    expect(isDeclaredSink(outputNode)).toBe(true);
    // A side-effect node with outputs is still a sink...
    expect(isDeclaredSink(readbackNode)).toBe(true);
    expect(readbackNode.outputs.length).toBeGreaterThan(0);
    // ...and an ordinary filter is not.
    expect(isDeclaredSink(blurNode)).toBe(false);
  });
});

describe("resolveSinks (T26)", () => {
  it("adds declared sinks and preview-enabled nodes to the caller's list", () => {
    const document = testGraph([
      testNode("out", "fx.output"),
      testNode("peek", "fx.generator", { ui: { preview: true } }),
      testNode("quiet", "fx.generator"),
    ]);
    const validated = validateGraph(document, registry);
    const { sinks } = resolveSinks(validated.nodes, []);

    expect(sinks.map((sink) => `${sink.nodeId}:${sink.kind}`).sort()).toEqual([
      "out:output",
      "peek:preview",
    ]);
  });

  it("warns about a sink naming a node or port that does not exist", () => {
    const validated = validateGraph(testGraph([testNode("out", "fx.output")]), registry);
    const { sinks, diagnostics } = resolveSinks(validated.nodes, [
      { nodeId: "ghost", kind: "output" },
      { nodeId: "out", portId: "nope", kind: "readback" },
    ]);

    expect(sinks.map((sink) => sink.nodeId)).toEqual(["out"]);
    expect(diagnostics.filter((d) => d.code === CompilerDiagnosticCode.sinkUnknown)).toHaveLength(2);
  });

  it("does not duplicate a sink the caller already named", () => {
    const validated = validateGraph(testGraph([testNode("out", "fx.output")]), registry);
    const { sinks } = resolveSinks(validated.nodes, [{ nodeId: "out", kind: "output" }]);
    expect(sinks).toHaveLength(1);
  });
});

describe("pruneToActiveSinks (§V25)", () => {
  it("keeps only what a sink reaches backward", () => {
    const validated = validateGraph(graph(), registry);
    const result = pruneToActiveSinks(validated.nodes, validated.edges, [
      { nodeId: "out", kind: "output" },
    ]);

    expect([...result.kept].sort()).toEqual(["blur", "gen", "out"]);
    expect(result.pruned).toEqual(["dead"]);
  });

  it("keeps a producer alive across a temporal edge — the value is a frame old, not free", () => {
    const document = testGraph(
      [testNode("gen", "fx.generator"), testNode("fb", "fx.feedback"), testNode("blur", "fx.blur")],
      [
        testEdge("e1", ["gen", "out"], ["fb", "source"]),
        testEdge("e2", ["fb", "out"], ["blur", "source"]),
      ],
    );
    const validated = validateGraph(document, registry);
    const result = pruneToActiveSinks(validated.nodes, validated.edges, [
      { nodeId: "blur", kind: "preview" },
    ]);

    expect([...result.kept].sort()).toEqual(["blur", "fb", "gen"]);
  });
});
