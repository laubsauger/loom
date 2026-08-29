import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { spikeNodeDefinitions } from "../../nodes/definitions/index.ts";
import type { GraphDocument, ProjectSettings } from "../../domain/types/graph.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";

/**
 * Cross-track integration: the REAL compiler against the REAL node definitions.
 *
 * Each track verified against its own fixtures and both passed, yet the two disagreed on
 * the compile() context shape and on how a sink is declared — so the Output node would
 * have been pruned and nothing would have rendered. Neither track's suite could catch
 * that, because a fixture is an assumption written twice. This test is the seam.
 */

const settings: ProjectSettings = {
  outputResolution: { width: 1280, height: 720 },
  workingFormat: "rgba16float",
  randomSeed: 1,
  previewLongEdge: 192,
  previewFps: 20,
  limits: {
    maxResolution: 4096,
    maxDispatch: 65535,
    maxBufferBytes: 268_435_456,
    memoryBudgetBytes: 1_073_741_824,
  },
};

const capabilities: BackendCapabilities = {
  tier: "B",
  features: [],
  formats: ["rgba8unorm", "rgba8unorm-srgb", "rgba16float", "r32float", "depth24plus"],
  timestampQuery: false,
  limits: { maxTextureDimension2D: 8192 },
};

/** Solid → CustomWGSL → Output. The minimum graph that must render. */
function graph(): GraphDocument {
  return {
    revision: 1,
    nodes: {
      solid: { id: "solid", type: "solid", definitionVersion: 1, position: { x: 0, y: 0 }, parameters: {} },
      fx: { id: "fx", type: "customWgsl", definitionVersion: 1, position: { x: 200, y: 0 }, parameters: {} },
      out: { id: "out", type: "output", definitionVersion: 1, position: { x: 400, y: 0 }, parameters: {} },
    },
    edges: {
      e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "fx", portId: "input" } },
      e2: { id: "e2", source: { nodeId: "fx", portId: "out" }, target: { nodeId: "out", portId: "input" } },
    },
    groups: {},
  };
}

const compile = (doc: GraphDocument = graph()) =>
  compileGraph({ graph: doc, settings, registry: createNodeRegistry(spikeNodeDefinitions).view(), capabilities });

describe("compiler + real node definitions", () => {
  it("compiles the minimum renderable graph with no error diagnostics", () => {
    const plan = compile();
    const errors = plan.diagnostics.filter((d) => d.severity === "error");
    expect(errors).toEqual([]);
    expect(plan.ok).toBe(true);
  });

  /** §V25: the Output node is the sink. If it is pruned, nothing renders at all. */
  it("keeps the Output node rather than pruning it", () => {
    const plan = compile();
    expect(plan.pruned).not.toContain("out");
    expect(plan.order).toContain("out");
  });

  it("emits a plan the backend accepts", () => {
    const plan = compile();
    const read = readExecutionPlan(plan);
    expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(read.ok).toBe(true);
  });

  it("orders passes so each node follows its input", () => {
    const { order } = compile();
    expect(order.indexOf("solid")).toBeLessThan(order.indexOf("fx"));
    expect(order.indexOf("fx")).toBeLessThan(order.indexOf("out"));
  });

  /** §V25: a node feeding nothing is pruned; the sink chain is not. */
  it("prunes a node that reaches no sink", () => {
    const doc = graph();
    doc.nodes["orphan"] = {
      id: "orphan", type: "solid", definitionVersion: 1, position: { x: 0, y: 300 }, parameters: {},
    };
    const plan = compile(doc);
    expect(plan.pruned).toContain("orphan");
    expect(plan.order).not.toContain("orphan");
  });

  /** §V6: one output feeding two consumers renders once. */
  it("renders a fan-out source only once", () => {
    const doc = graph();
    doc.nodes["fx2"] = {
      id: "fx2", type: "customWgsl", definitionVersion: 1, position: { x: 200, y: 200 }, parameters: {},
    };
    doc.edges["e3"] = {
      id: "e3", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "fx2", portId: "input" },
    };
    const { order } = compile(doc);
    expect(order.filter((id) => id === "solid")).toHaveLength(1);
  });
});
