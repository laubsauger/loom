import type { GraphComponentDefinition, PublishedParameter } from "../types/components.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { ComponentId, NodeId } from "../types/ids.ts";
import type { ParameterValue } from "../types/parameters.ts";
import { createGraphStore, type GraphStore } from "../graph/store.ts";
import { createSequentialIdFactory } from "../graph/ids.ts";
import { createDomainBus } from "../commands/index.ts";
import type { ShaderloomBus } from "../commands/bus.ts";
import { createTestRegistry } from "../../nodes/registry/test-nodes.ts";
import { componentNodeType } from "./component-type.ts";
import { registerComponentCommands } from "./commands.ts";
import { createComponentSystem, type ComponentRegistry } from "./registry.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";

/** Fixtures for the component tests. Deterministic ids and timestamps throughout. */

export interface ComponentHarness {
  store: GraphStore;
  bus: ShaderloomBus;
  components: ComponentRegistry;
  nodes: NodeRegistryView;
}

export function createComponentHarness(
  idPrefix = "t",
  initialGraph?: GraphDocument,
): ComponentHarness {
  const store = createGraphStore({
    ids: createSequentialIdFactory(idPrefix),
    now: () => "2026-08-29T00:00:00.000Z",
    ...(initialGraph === undefined ? {} : { initialGraph }),
  });
  const system = createComponentSystem(createTestRegistry().view());
  const { bus } = createDomainBus({ store, registry: system.nodes });
  registerComponentCommands(bus, { components: system.components });
  return { store, bus, components: system.components, nodes: system.nodes };
}

export function node(
  id: NodeId,
  type: string,
  parameters: Record<string, ParameterValue> = {},
  extra: Partial<GraphNode> = {},
): GraphNode {
  return {
    id,
    type,
    definitionVersion: 1,
    position: { x: 0, y: 0 },
    parameters,
    ...extra,
  };
}

export function instanceNode(
  id: NodeId,
  componentId: ComponentId,
  version: number,
  parameters: Record<string, ParameterValue> = {},
): GraphNode {
  return {
    id,
    type: componentNodeType(componentId, version),
    definitionVersion: version,
    position: { x: 0, y: 0 },
    parameters,
  };
}

export function graphOf(nodes: GraphNode[], edges: GraphDocument["edges"] = {}): GraphDocument {
  const record: GraphDocument["nodes"] = {};
  for (const each of nodes) record[each.id] = each;
  return { revision: 0, nodes: record, edges, groups: {} };
}

/**
 * A bloom-shaped component: three internal blurs whose radii one published knob drives.
 * Exactly the §V80 example, so the headline test reads like the invariant.
 */
export function bloomComponent(
  componentId: ComponentId = "bloom",
  version = 1,
  published: PublishedParameter[] = [],
): GraphComponentDefinition {
  return {
    componentId,
    version,
    name: "Bloom",
    graph: graphOf([
      node("blurA", "test.blur", { radius: 4 }, { position: { x: 0, y: 0 } }),
      node("blurB", "test.blur", { radius: 4 }, { position: { x: 100, y: 0 } }),
      node("blurC", "test.blur", { radius: 4 }, { position: { x: 200, y: 0 } }),
    ]),
    inputs: [{ externalId: "source", label: "Source", nodeId: "blurA", portId: "source" }],
    outputs: [{ externalId: "out", label: "Out", nodeId: "blurC", portId: "out" }],
    parameters: published,
  };
}

/** The §V80 knob: one control, three internal radii. */
export const blurKnob: PublishedParameter = {
  key: "blur",
  definition: { type: "number", label: "Blur", default: 4, min: 0, max: 64, unit: "px" },
  targets: [
    { nodeId: "blurA", key: "radius" },
    { nodeId: "blurB", key: "radius" },
    { nodeId: "blurC", key: "radius" },
  ],
};
