import { arePortsCompatible } from "@domain/graph/port-compat.ts";
import type { GraphDocument, GraphEdge } from "@domain/types/graph.ts";
import type { EdgeId, NodeId, PortId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * What a drop ON AN EDGE means (T212, T213, §V14b, §V13, §V32).
 *
 * Pure functions over the document: given the edge that was hit and what was dropped on
 * it, they return the operations for ONE patch. Nothing here talks to React Flow, to the
 * bus, or to the pointer — the canvas supplies the hit and dispatches the result, which
 * is what makes both gestures testable as rules and, more importantly, keeps them from
 * quietly disagreeing with each other. They are siblings: same hit area, same "one patch,
 * one undo group" contract, and the same refusal to guess when the types do not fit.
 *
 * Both return an EMPTY array when the drop cannot mean anything, and the caller
 * dispatches nothing. A refusal is silent on purpose: the user has released the pointer
 * over a wire that cannot take what they dropped, and the honest outcome is that nothing
 * happened — not a diagnostic they now have to dismiss.
 */

/** The end of a connection drag the user released over an edge. */
export interface DraggedPort {
  readonly nodeId: NodeId;
  readonly portId: PortId;
  /** Which end of the wire the user grabbed. An output looks for an input, and vice versa. */
  readonly direction: "input" | "output";
}

function edgesInto(graph: GraphDocument, nodeId: NodeId, portId: PortId): EdgeId[] {
  return Object.values(graph.edges)
    .filter((edge) => edge.target.nodeId === nodeId && edge.target.portId === portId)
    .map((edge) => edge.id)
    .sort();
}

function compatible(
  registry: NodeRegistryView,
  graph: GraphDocument,
  source: { nodeId: NodeId; portId: PortId },
  target: { nodeId: NodeId; portId: PortId },
): boolean {
  const sourceNode = graph.nodes[source.nodeId];
  const targetNode = graph.nodes[target.nodeId];
  if (sourceNode === undefined || targetNode === undefined) return false;
  const sourcePort = registry.port(sourceNode.type, source.portId, "output");
  const targetPort = registry.port(targetNode.type, target.portId, "input");
  if (sourcePort === undefined || targetPort === undefined) return false;
  // §V13 — exact match. A near miss is a missing conversion node, not a cast, and a
  // gesture is the last place to start inventing one.
  return arePortsCompatible(sourcePort.type, targetPort.type);
}

/** Ops that free a non-variadic input before something else lands on it (§V14, §V14a). */
function displace(
  registry: NodeRegistryView,
  graph: GraphDocument,
  target: { nodeId: NodeId; portId: PortId },
  already: ReadonlySet<EdgeId>,
): GraphPatchOperation[] {
  const node = graph.nodes[target.nodeId];
  const port = node === undefined ? undefined : registry.port(node.type, target.portId, "input");
  if (port?.variadic === true) return [];
  const occupying = edgesInto(graph, target.nodeId, target.portId).filter((id) => !already.has(id));
  return occupying.length === 0 ? [] : [{ op: "disconnect", edgeIds: occupying }];
}

/**
 * T212 / §V14b — a connection released over an edge REPLACES it.
 *
 * "The drag takes that edge's target": dragging an output onto a wire hands that wire's
 * consumer a new producer. Dragging an INPUT onto a wire is the mirror image — the port
 * you are holding takes that wire's producer — because both ends of a connection are
 * draggable and a gesture that works in one direction and silently does nothing in the
 * other reads as a bug, not as a rule.
 *
 * The disconnect and the connect are in ONE patch, so the graph never exists in the
 * intermediate state where the old edge is gone and the new one has not landed, and one
 * undo puts the wire back exactly as it was (§V32, §V34).
 */
export function replaceEdgeOperations(
  graph: GraphDocument,
  registry: NodeRegistryView,
  edge: GraphEdge,
  dragged: DraggedPort,
): GraphPatchOperation[] {
  // Dropping a port onto a wire it is already an end of is a no-op, not a rewire.
  if (dragged.direction === "output") {
    if (edge.source.nodeId === dragged.nodeId && edge.source.portId === dragged.portId) return [];
    const source = { nodeId: dragged.nodeId, portId: dragged.portId };
    if (!compatible(registry, graph, source, edge.target)) return [];
    return [
      { op: "disconnect", edgeIds: [edge.id] },
      { op: "connect", source, target: { ...edge.target } },
    ];
  }

  if (edge.target.nodeId === dragged.nodeId && edge.target.portId === dragged.portId) return [];
  const target = { nodeId: dragged.nodeId, portId: dragged.portId };
  if (!compatible(registry, graph, edge.source, target)) return [];
  const replaced = new Set<EdgeId>([edge.id]);
  return [
    { op: "disconnect", edgeIds: [edge.id] },
    // The dragged input may already be occupied; that edge goes too, in the same patch
    // (§V14a — the drop is unambiguous, so refusing would only make the user hunt).
    ...displace(registry, graph, target, replaced),
    { op: "connect", source: { ...edge.source }, target },
  ];
}

/** Can `from` reach `to` by following edges forward? Used to refuse a splice that loops. */
function reaches(graph: GraphDocument, from: NodeId, to: NodeId): boolean {
  const seen = new Set<NodeId>([from]);
  const queue: NodeId[] = [from];
  while (queue.length > 0) {
    const current = queue.shift();
    if (current === undefined) break;
    if (current === to) return true;
    for (const edge of Object.values(graph.edges)) {
      if (edge.source.nodeId !== current) continue;
      if (seen.has(edge.target.nodeId)) continue;
      seen.add(edge.target.nodeId);
      queue.push(edge.target.nodeId);
    }
  }
  return false;
}

/**
 * The ports a splice would use: the node's first input that can take the upstream type,
 * and its first output the downstream can take.
 *
 * First rather than "best": the definition's declaration order is the author's own
 * ordering, it is what the node shows top to bottom, and a scoring function would make
 * the same gesture pick different ports on two nodes that look identical.
 */
function splicePorts(
  graph: GraphDocument,
  registry: NodeRegistryView,
  nodeId: NodeId,
  edge: GraphEdge,
): { input: PortId; output: PortId } | null {
  const node = graph.nodes[nodeId];
  const definition = node === undefined ? undefined : registry.get(node.type);
  if (definition === undefined) return null;

  const input = definition.inputs.find((port) =>
    compatible(registry, graph, edge.source, { nodeId, portId: port.id }),
  );
  const output = definition.outputs.find((port) =>
    compatible(registry, graph, { nodeId, portId: port.id }, edge.target),
  );
  if (input === undefined || output === undefined) return null;
  return { input: input.id, output: output.id };
}

/**
 * T213 / §V14b's sibling — a NODE dropped on an edge SPLICES into it.
 *
 * upstream → node → downstream, in one patch: the old edge goes, two new ones arrive,
 * and one undo restores the original wire and removes both (§V32, §V34). The node's
 * own move is part of the same gesture and belongs in the same patch, which is why the
 * caller prepends it rather than dispatching twice.
 *
 * Refused, quietly, when:
 *  - the node is already an end of that edge (dropping it on its own wire means nothing);
 *  - no pair of its ports fits the two ends (§V13 — no implicit conversion);
 *  - the splice would close a loop. A cycle is legal only across an explicit temporal
 *    node (§V4), and a gesture that silently creates an illegal one hands the user a
 *    graph that no longer compiles for a reason they cannot see. Refusing costs them a
 *    drag; not refusing costs them a debugging session.
 */
export function spliceNodeOperations(
  graph: GraphDocument,
  registry: NodeRegistryView,
  edge: GraphEdge,
  nodeId: NodeId,
): GraphPatchOperation[] {
  if (edge.source.nodeId === nodeId || edge.target.nodeId === nodeId) return [];
  const ports = splicePorts(graph, registry, nodeId, edge);
  if (ports === null) return [];
  // Ignoring the edge about to be removed would be wrong here: it is still in the graph
  // this walk is reading, but every path through it is about to cease to exist.
  const withoutEdge: GraphDocument = {
    ...graph,
    edges: Object.fromEntries(Object.entries(graph.edges).filter(([id]) => id !== edge.id)),
  };
  if (reaches(withoutEdge, nodeId, edge.source.nodeId)) return [];
  if (reaches(withoutEdge, edge.target.nodeId, nodeId)) return [];

  const target = { nodeId, portId: ports.input };
  const replaced = new Set<EdgeId>([edge.id]);
  return [
    { op: "disconnect", edgeIds: [edge.id] },
    // The downstream input needs no displacement: the only thing on it is the edge
    // being spliced. The node's own input might be occupied, though — a node already
    // wired elsewhere is a perfectly ordinary thing to drop on a wire.
    ...displace(registry, graph, target, replaced),
    { op: "connect", source: { ...edge.source }, target },
    { op: "connect", source: { nodeId, portId: ports.output }, target: { ...edge.target } },
  ];
}
