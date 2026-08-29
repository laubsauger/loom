import { describe, expect, it } from "vitest";
import { compileGraph } from "./compile.ts";
import {
  classifyEdit,
  diffPlans,
  downstreamOf,
  feedbackToReset,
  isUniformOnlyChange,
  targetsToRecreate,
} from "./recompile.ts";
import { pingPongResourceId, targetResourceId } from "./resources.ts";
import {
  createCompilerTestRegistry,
  testCapabilities,
  testEdge,
  testGraph,
  testNode,
  testSettings,
} from "./test-support.ts";
import type { GraphDocument, GraphNode } from "../domain/types/graph.ts";

const registry = createCompilerTestRegistry().view();

const compile = (graph: GraphDocument, settings = testSettings()) =>
  compileGraph({ graph, settings, registry, capabilities: testCapabilities() });

/** gen -> wgsl -> out, with a feedback pair hanging off the composite. */
const chain = (genOverrides: Partial<GraphNode> = {}): GraphDocument =>
  testGraph(
    [
      testNode("gen", "fx.generator", genOverrides),
      testNode("wgsl", "fx.wgsl"),
      testNode("out", "fx.output"),
    ],
    [
      testEdge("e1", ["gen", "out"], ["wgsl", "source"]),
      testEdge("e2", ["wgsl", "out"], ["out", "source"]),
    ],
  );

const context = { graph: chain(), registry };

describe("classifyEdit (T31, §V5)", () => {
  it("classifies a uniform-value parameter change as a uniform update only", () => {
    const decision = classifyEdit({ kind: "parameter", nodeId: "gen", parameters: ["amount"] }, context);

    expect(decision.work).toBe("uniform-update");
    expect(decision.nodes).toEqual(["gen"]);
    expect(decision.recreateTargets).toBe(false);
    expect(decision.resetFeedback).toBe(false);
  });

  it("escalates a compile-time parameter, because it changes shader structure", () => {
    const decision = classifyEdit({ kind: "parameter", nodeId: "wgsl", parameters: ["source"] }, context);
    expect(decision.work).toBe("recompile-region");
    expect(decision.nodes).toEqual(["out", "wgsl"]);
  });

  it("classifies a topology change as a region recompile over the affected nodes", () => {
    const decision = classifyEdit({ kind: "topology", nodeIds: ["gen"] }, context);

    expect(decision.work).toBe("recompile-region");
    expect(decision.nodes).toEqual(["gen", "out", "wgsl"]);
    expect(decision.recreateTargets).toBe(true);
  });

  it("keeps moving and selecting out of the GPU entirely", () => {
    expect(classifyEdit({ kind: "nodePosition" }, context).work).toBe("editor-only");
    expect(classifyEdit({ kind: "selection" }, context).work).toBe("editor-only");
    expect(classifyEdit({ kind: "nodePosition" }, context).nodes).toEqual([]);
  });

  it("treats preview visibility as a preview-plan change (§V28)", () => {
    const decision = classifyEdit({ kind: "nodeUi", nodeId: "gen", fields: ["preview"] }, context);
    expect(decision.work).toBe("preview-plan");
  });

  it("treats bypass and mute as structural, not cosmetic", () => {
    expect(classifyEdit({ kind: "nodeUi", nodeId: "gen", fields: ["bypassed"] }, context).work).toBe(
      "recompile-region",
    );
    expect(classifyEdit({ kind: "nodeUi", nodeId: "gen", fields: ["collapsed"] }, context).work).toBe(
      "editor-only",
    );
  });

  it("recompiles only the edited shader when its interface is unchanged", () => {
    const decision = classifyEdit(
      { kind: "shaderSource", nodeId: "wgsl", interfaceChanged: false },
      context,
    );
    expect(decision.work).toBe("recompile-shader");
    expect(decision.nodes).toEqual(["wgsl"]);
  });

  it("recompiles downstream too when the shader's interface changed", () => {
    const decision = classifyEdit(
      { kind: "shaderSource", nodeId: "wgsl", interfaceChanged: true },
      context,
    );
    expect(decision.work).toBe("recompile-region");
    expect(decision.nodes).toEqual(["out", "wgsl"]);
  });

  it("re-runs propagation for a resolution, format or project-settings change (§V21)", () => {
    expect(classifyEdit({ kind: "nodeResolution", nodeId: "gen" }, context).work).toBe("repropagate");
    expect(classifyEdit({ kind: "nodeFormat", nodeId: "gen" }, context).work).toBe("repropagate");

    const settings = classifyEdit({ kind: "projectSettings" }, context);
    expect(settings.work).toBe("repropagate");
    expect(settings.recreateTargets).toBe(true);
    expect(settings.nodes).toEqual(["gen", "out", "wgsl"]);
  });

  it("walks downstream deterministically", () => {
    expect(downstreamOf(chain(), ["gen"])).toEqual(["gen", "out", "wgsl"]);
    expect(downstreamOf(chain(), ["out"])).toEqual(["out"]);
  });
});

describe("plan diffing (§V5, §V50)", () => {
  it("sees a parameter-only edit as no structural change at all", () => {
    const before = compile(chain());
    const after = compile(chain({ parameters: { amount: 0.25 } }));

    expect(isUniformOnlyChange(before, after)).toBe(true);
    expect(targetsToRecreate(before, after)).toEqual([]);
    expect(diffPlans(before, after).passesToBuild).toEqual([]);
  });

  it("recreates only the resources whose size actually changed", () => {
    const before = compile(chain());
    const after = compile(chain(), testSettings({ outputResolution: { width: 960, height: 540 } }));

    // Everything in this chain follows the project resolution, so everything moves...
    expect(targetsToRecreate(before, after)).toEqual([
      targetResourceId("gen", "out"),
      targetResourceId("out", "out"),
      targetResourceId("wgsl", "out"),
    ]);
  });

  it("leaves unrelated resources — and their contents — alone when a node is added", () => {
    const before = compile(chain());
    const graph = chain();
    graph.nodes["extra"] = testNode("extra", "fx.generator");
    graph.nodes["side"] = testNode("side", "fx.readback");
    graph.edges["e3"] = testEdge("e3", ["extra", "out"], ["side", "source"]);
    const after = compile(graph);

    const diff = diffPlans(before, after);
    expect(diff.resourcesToCreate).toEqual([
      targetResourceId("extra", "out"),
      targetResourceId("side", "out"),
    ]);
    expect(diff.resourcesToKeep).toContain(targetResourceId("gen", "out"));
    expect(diff.resourcesToDestroy).toEqual([]);
    expect(diff.feedbackToReset).toEqual([]);
  });
});

describe("feedback reset triggers (T33, §V22)", () => {
  const feedbackGraph = (fbOverrides: Partial<GraphNode> = {}): GraphDocument =>
    testGraph(
      [
        testNode("gen", "fx.generator"),
        testNode("fb", "fx.feedback", fbOverrides),
        testNode("out", "fx.output"),
      ],
      [
        testEdge("e1", ["gen", "out"], ["fb", "source"]),
        testEdge("e2", ["fb", "out"], ["out", "source"]),
      ],
    );

  it("resets a pair that is new", () => {
    const plan = compile(feedbackGraph());
    expect(feedbackToReset(undefined, plan)).toEqual([pingPongResourceId("fb", "out")]);
  });

  it("keeps history when nothing about the pair changed", () => {
    const before = compile(feedbackGraph());
    const after = compile(feedbackGraph());
    expect(feedbackToReset(before, after)).toEqual([]);
  });

  it("resets when the pair's resolution changes (§V50)", () => {
    const before = compile(feedbackGraph());
    const after = compile(feedbackGraph({ resolution: { mode: "fixed", width: 512, height: 512 } }));

    expect(feedbackToReset(before, after)).toEqual([pingPongResourceId("fb", "out")]);
    expect(targetsToRecreate(before, after)).toContain(pingPongResourceId("fb", "out"));
  });

  it("resets when the pair's format changes (§V51)", () => {
    const before = compile(feedbackGraph());
    const after = compile(feedbackGraph({ format: { mode: "fixed", format: "rgba8unorm" } }));
    expect(feedbackToReset(before, after)).toEqual([pingPongResourceId("fb", "out")]);
  });

  it("does not reset a pair because an unrelated node was added", () => {
    const before = compile(feedbackGraph());
    const graph = feedbackGraph();
    graph.nodes["extra"] = testNode("extra", "fx.generator");
    graph.nodes["side"] = testNode("side", "fx.readback");
    graph.edges["e3"] = testEdge("e3", ["extra", "out"], ["side", "source"]);
    const after = compile(graph);

    expect(feedbackToReset(before, after)).toEqual([]);
  });
});
