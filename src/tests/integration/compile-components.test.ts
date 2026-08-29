import { describe, expect, it } from "vitest";
import { compileGraph } from "../../compiler/index.ts";
import { readExecutionPlan } from "../../runtime/backend/plan.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { createNodeRegistry } from "../../nodes/registry/registry.ts";
import { allNodeDefinitions } from "../../nodes/definitions/index.ts";
import {
  componentNodeType,
  createComponentSystem,
  PARENT_BINDINGS_STATE_KEY,
} from "../../domain/components/index.ts";
import type { GraphComponentDefinition } from "../../domain/types/components.ts";
import type { GraphDocument, GraphNode, ProjectSettings } from "../../domain/types/graph.ts";
import type { BackendCapabilities } from "../../domain/types/backend.ts";

/**
 * Cross-track integration: the REAL compiler, the REAL component API and the REAL node
 * catalogue, in one graph (T134, T135).
 *
 * The sibling `compile-real-nodes.test.ts` exists because two tracks each passed against
 * their own fixtures while disagreeing with each other, and only a test spanning both
 * caught it. Components add a third party to that agreement: the component registry
 * synthesizes a node manifest from exposed ports, the compiler flattens the graph behind
 * it, and the node definitions have to accept the compile context that comes out. Any
 * fixture written by one of the three would happily agree with itself.
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

const node = (id: string, type: string, overrides: Partial<GraphNode> = {}): GraphNode => ({
  id,
  type,
  definitionVersion: 1,
  position: { x: 0, y: 0 },
  parameters: {},
  ...overrides,
});

const graphOf = (nodes: GraphNode[], edges: GraphDocument["edges"] = {}): GraphDocument => ({
  revision: 1,
  nodes: Object.fromEntries(nodes.map((each) => [each.id, each])),
  edges,
  groups: {},
});

/**
 * "Bloom": two real Blur nodes in series, with one published knob driving both filter
 * sizes (§V80) and a Level node whose gain reads `parent.amount` lexically (§V81).
 */
const bloom: GraphComponentDefinition = {
  componentId: "bloom",
  version: 1,
  name: "Bloom",
  graph: graphOf(
    [
      node("wide", "blur", { parameters: { size: 4 } }),
      node("tight", "blur", { parameters: { size: 4 } }),
    ],
    {
      inner: {
        id: "inner",
        source: { nodeId: "wide", portId: "out" },
        target: { nodeId: "tight", portId: "input" },
      },
    },
  ),
  inputs: [{ externalId: "source", label: "Source", nodeId: "wide", portId: "input" }],
  outputs: [{ externalId: "out", label: "Out", nodeId: "tight", portId: "out" }],
  parameters: [
    {
      key: "amount",
      definition: { type: "number", label: "Amount", default: 8, min: 0, max: 128, unit: "px" },
      targets: [
        { nodeId: "wide", key: "size" },
        { nodeId: "tight", key: "size" },
      ],
    },
  ],
};

/** A component containing an instance of Bloom, so nesting is exercised end to end. */
const stack: GraphComponentDefinition = {
  componentId: "stack",
  version: 1,
  name: "Stack",
  graph: graphOf([
    node("bloom", componentNodeType("bloom", 1), {
      // The inner instance's own knob is bound to the outer component's, so the value has
      // to cross two boundaries: published fan-out, then lexical parent scope (§V81).
      state: { [PARENT_BINDINGS_STATE_KEY]: { amount: "parent.strength" } },
    }),
  ]),
  inputs: [{ externalId: "source", label: "Source", nodeId: "bloom", portId: "source" }],
  outputs: [{ externalId: "out", label: "Out", nodeId: "bloom", portId: "out" }],
  parameters: [
    {
      key: "strength",
      definition: { type: "number", label: "Strength", default: 8, min: 0, max: 128, unit: "px" },
      targets: [],
    },
  ],
};

function compile(graph: GraphDocument, definitions: GraphComponentDefinition[] = [bloom, stack]) {
  const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view(), definitions);
  return compileGraph({
    graph,
    settings,
    registry: system.nodes,
    capabilities,
    components: system.components.view(),
  });
}

const effectFor = (
  passes: ReadonlyArray<{ kind: string }>,
  nodeId: string,
): EffectPassDescriptor | undefined =>
  (passes as ReadonlyArray<EffectPassDescriptor>).find(
    (pass) => pass.kind === "effect" && pass.nodeId === nodeId,
  );

/** solid -> <instance> -> output: the minimum graph a component has to survive. */
const withInstance = (instanceNode: GraphNode): GraphDocument =>
  graphOf([node("solid", "solid"), instanceNode, node("out", "output")], {
    e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId: instanceNode.id, portId: "source" } },
    e2: { id: "e2", source: { nodeId: instanceNode.id, portId: "out" }, target: { nodeId: "out", portId: "input" } },
  });

describe("compiler + real component API + real node definitions", () => {
  it("compiles a graph containing a component instance with no error diagnostics", () => {
    const plan = compile(
      withInstance(node("bloom1", componentNodeType("bloom", 1), { parameters: { amount: 12 } })),
    );

    expect(plan.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(plan.ok).toBe(true);
  });

  it("emits the component's internal passes, and a plan the backend accepts", () => {
    const plan = compile(withInstance(node("bloom1", componentNodeType("bloom", 1))));

    expect(plan.order).toEqual(expect.arrayContaining(["solid", "bloom1/wide", "bloom1/tight", "out"]));
    expect(effectFor(plan.passes, "bloom1/wide")).toBeDefined();
    const read = readExecutionPlan(plan);
    expect(read.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(read.ok).toBe(true);
  });

  it("wires the parent's edges through the exposed ports, in order", () => {
    const { order } = compile(withInstance(node("bloom1", componentNodeType("bloom", 1))));

    expect(order.indexOf("solid")).toBeLessThan(order.indexOf("bloom1/wide"));
    expect(order.indexOf("bloom1/wide")).toBeLessThan(order.indexOf("bloom1/tight"));
    expect(order.indexOf("bloom1/tight")).toBeLessThan(order.indexOf("out"));
  });

  /** §V80: one published value reaches every internal target, through a real node's compile. */
  it("drives both real Blur nodes from one published parameter", () => {
    const plan = compile(
      withInstance(node("bloom1", componentNodeType("bloom", 1), { parameters: { amount: 24 } })),
    );

    // The Blur node folds its filter size into a uniform; that is where the knob has to land.
    expect(effectFor(plan.passes, "bloom1/wide")?.uniforms?.["size"]).toBe(24);
    expect(effectFor(plan.passes, "bloom1/tight")?.uniforms?.["size"]).toBe(24);
  });

  it("keeps two instances of one component from colliding", () => {
    const graph = graphOf(
      [
        node("solid", "solid"),
        node("a", componentNodeType("bloom", 1), { parameters: { amount: 4 } }),
        node("b", componentNodeType("bloom", 1), { parameters: { amount: 40 } }),
        node("out", "output"),
      ],
      {
        e1: { id: "e1", source: { nodeId: "solid", portId: "out" }, target: { nodeId: "a", portId: "source" } },
        e2: { id: "e2", source: { nodeId: "a", portId: "out" }, target: { nodeId: "b", portId: "source" } },
        e3: { id: "e3", source: { nodeId: "b", portId: "out" }, target: { nodeId: "out", portId: "input" } },
      },
    );
    const plan = compile(graph);

    expect(plan.ok).toBe(true);
    expect(effectFor(plan.passes, "a/wide")?.uniforms?.["size"]).toBe(4);
    expect(effectFor(plan.passes, "b/wide")?.uniforms?.["size"]).toBe(40);
    expect(new Set(plan.passes.map((pass) => pass.id)).size).toBe(plan.passes.length);
  });

  /** §V82 + §V81: two levels deep, and the value crosses both boundaries. */
  it("flattens a nested component and reports the path a user can navigate", () => {
    const plan = compile(
      withInstance(node("stack1", componentNodeType("stack", 1), { parameters: { strength: 33 } })),
    );

    expect(plan.ok).toBe(true);
    expect(effectFor(plan.passes, "stack1/bloom/wide")?.uniforms?.["size"]).toBe(33);
    expect(plan.sources.find((source) => source.nodeId === "stack1/bloom/wide")?.sourcePath).toBe(
      "Main / Stack_1 / Bloom_1 / wide",
    );
  });

  /** §V25: flattening does not switch pruning off. */
  it("prunes a node inside a component that reaches no sink", () => {
    const withOrphan: GraphComponentDefinition = {
      ...bloom,
      graph: {
        ...bloom.graph,
        nodes: { ...bloom.graph.nodes, spare: node("spare", "solid") },
      },
    };
    const plan = compile(
      withInstance(node("bloom1", componentNodeType("bloom", 1))),
      [withOrphan, stack],
    );

    expect(plan.pruned).toContain("bloom1/spare");
    expect(effectFor(plan.passes, "bloom1/spare")).toBeUndefined();
  });

  /**
   * The tripwire the components track left for this one: an instance that reaches node
   * compilation fails loudly instead of quietly contributing nothing.
   */
  it("fails with component.notFlattened when the compiler is given no catalogue", () => {
    const system = createComponentSystem(createNodeRegistry(allNodeDefinitions).view(), [bloom]);
    const plan = compileGraph({
      graph: withInstance(node("bloom1", componentNodeType("bloom", 1))),
      settings,
      registry: system.nodes,
      capabilities,
    });

    expect(plan.ok).toBe(false);
    expect(plan.diagnostics.map((d) => d.code)).toContain("component.notFlattened");
  });
});
