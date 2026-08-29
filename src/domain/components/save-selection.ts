import type { ExposedPort, GraphComponentDefinition } from "../types/components.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { GraphDocument, GraphEdge, GraphNode } from "../types/graph.ts";
import type { ComponentId, EdgeId, NodeId, PortId } from "../types/ids.ts";
import type { NodeRegistryView } from "../../nodes/registry/registry.ts";

/**
 * Save selection as a component (T129, §V79).
 *
 * A pure transform: given a graph and a set of selected nodes, work out the internal
 * network, the ports that CROSSED the selection boundary, and how the parent graph must
 * be rewired to talk to the instance that replaces the selection. Nothing here mutates;
 * the command applies the result in one patch.
 *
 * Boundary ports are the whole trick. A selection is almost never closed — the user
 * picked three nodes in the middle of a chain — so every edge with exactly one end inside
 * becomes an exposed port, and the outer end reconnects to the instance. Get that wrong
 * and "make this a component" silently deletes the user's wiring.
 */

export interface SelectionWiring {
  externalId: PortId;
  /** The endpoint OUTSIDE the selection that reconnects to the instance. */
  outer: { nodeId: NodeId; portId: PortId };
}

export interface ComponentFromSelection {
  definition: GraphComponentDefinition;
  /** Outside source -> instance input, one per exposed input that was wired. */
  inputWiring: readonly SelectionWiring[];
  /** Instance output -> outside target. One exposed output may feed several. */
  outputWiring: readonly SelectionWiring[];
  /** Edges the parent graph loses: everything with at least one end inside. */
  removedEdgeIds: readonly EdgeId[];
  /** Where to put the instance node: the centre of what it replaces. */
  position: { x: number; y: number };
  diagnostics: readonly RuntimeDiagnostic[];
}

export interface SaveSelectionInput {
  graph: GraphDocument;
  nodeIds: readonly NodeId[];
  componentId: ComponentId;
  version?: number;
  name: string;
  description?: string;
  nodes: NodeRegistryView;
}

function uniqueId(taken: Set<PortId>, preferred: PortId): PortId {
  if (!taken.has(preferred)) {
    taken.add(preferred);
    return preferred;
  }
  let suffix = 2;
  while (taken.has(`${preferred}_${suffix}`)) suffix += 1;
  const id = `${preferred}_${suffix}`;
  taken.add(id);
  return id;
}

export function buildComponentFromSelection(input: SaveSelectionInput): ComponentFromSelection {
  const diagnostics: RuntimeDiagnostic[] = [];
  // Sorted and deduplicated: two actors running the same command must build the same
  // component, down to the order of the exposed ports (§V40).
  const selected = [...new Set(input.nodeIds)].sort();
  const inside = new Set<NodeId>();
  const nodes: Record<NodeId, GraphNode> = {};

  for (const nodeId of selected) {
    const node = input.graph.nodes[nodeId];
    if (node === undefined) {
      diagnostics.push({
        severity: "error",
        code: "component.selection.missingNode",
        message: `Cannot include "${nodeId}" in a component: it is not in the graph.`,
        nodeId,
      });
      continue;
    }
    inside.add(nodeId);
    // Internal node ids are kept. They are globally unique already (§V40), they never
    // collide with the parent's because the internal graph is a separate document, and
    // keeping them means a diagnostic path still names something the author recognises.
    nodes[nodeId] = node;
  }

  const edges: Record<EdgeId, GraphEdge> = {};
  const removedEdgeIds: EdgeId[] = [];
  const inputs: ExposedPort[] = [];
  const outputs: ExposedPort[] = [];
  const inputWiring: SelectionWiring[] = [];
  const outputWiring: SelectionWiring[] = [];
  const takenIds = new Set<PortId>();
  /** One exposed output per internal source port, however many outside targets it feeds. */
  const outputByInternal = new Map<string, PortId>();

  for (const edgeId of Object.keys(input.graph.edges).sort()) {
    const edge = input.graph.edges[edgeId];
    if (edge === undefined) continue;
    const sourceInside = inside.has(edge.source.nodeId);
    const targetInside = inside.has(edge.target.nodeId);
    if (!sourceInside && !targetInside) continue;

    removedEdgeIds.push(edgeId);

    if (sourceInside && targetInside) {
      edges[edgeId] = edge;
      continue;
    }

    if (targetInside) {
      const node = input.graph.nodes[edge.target.nodeId];
      const port = node === undefined ? undefined : input.nodes.port(node.type, edge.target.portId, "input");
      const externalId = uniqueId(takenIds, edge.target.portId);
      inputs.push({
        externalId,
        label: port?.label ?? edge.target.portId,
        nodeId: edge.target.nodeId,
        portId: edge.target.portId,
      });
      inputWiring.push({ externalId, outer: { ...edge.source } });
      continue;
    }

    const internalKey = `${edge.source.nodeId}/${edge.source.portId}`;
    let externalId = outputByInternal.get(internalKey);
    if (externalId === undefined) {
      const node = input.graph.nodes[edge.source.nodeId];
      const port = node === undefined ? undefined : input.nodes.port(node.type, edge.source.portId, "output");
      externalId = uniqueId(takenIds, edge.source.portId);
      outputByInternal.set(internalKey, externalId);
      outputs.push({
        externalId,
        label: port?.label ?? edge.source.portId,
        nodeId: edge.source.nodeId,
        portId: edge.source.portId,
      });
    }
    outputWiring.push({ externalId, outer: { ...edge.target } });
  }

  if (inside.size === 0) {
    diagnostics.push({
      severity: "error",
      code: "component.selection.empty",
      message: "Select at least one node to save as a component.",
    });
  }

  let x = 0;
  let y = 0;
  for (const nodeId of inside) {
    const node = input.graph.nodes[nodeId];
    if (node === undefined) continue;
    x += node.position.x;
    y += node.position.y;
  }
  const count = Math.max(1, inside.size);

  const definition: GraphComponentDefinition = {
    componentId: input.componentId,
    version: input.version ?? 1,
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    graph: { revision: 0, nodes, edges, groups: {} },
    inputs,
    outputs,
    // Nothing is published yet: publishing is a separate, deliberate act of re-authoring
    // a control, not a bulk copy of every internal parameter (§V80).
    parameters: [],
  };

  return {
    definition,
    inputWiring,
    outputWiring,
    removedEdgeIds,
    position: { x: Math.round(x / count), y: Math.round(y / count) },
    diagnostics,
  };
}
