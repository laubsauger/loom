import type { GraphDocument, GraphEdge } from "../types/graph.ts";
import type { NodeId, PortId } from "../types/ids.ts";

/**
 * The order of the edges landing on a variadic input port (T225, §V131).
 *
 * ONE definition of "which input is first", shared by the document layer that writes it
 * and the compiler that reads it. Two comparators would be two answers to a question the
 * user can see the result of: for Over, layer order IS the operation, so a document that
 * says "b is on top" and a compiler that renders a on top is not a rounding difference,
 * it is the wrong picture.
 *
 * WHY THE EDGE CARRIES IT rather than the port holding a list. An edge is the thing that
 * gets created, deleted and undone; a list on the node would need keeping in step with
 * every one of those, and the two would disagree the first time a patch was rejected
 * halfway. §V40's cascade already deletes edges for us — the order goes with them.
 *
 * AN ABSENT ORDER SORTS LAST, ties broken by id. That makes the field additive: a document
 * saved before this existed has no orders at all, so every edge falls through to the id
 * comparison and the graph compiles exactly as it did (§V68). It also means an edge minted
 * by some path that does not yet assign one — component instantiation, a hand-written
 * document — appends rather than silently displacing the edges someone deliberately
 * arranged.
 */

/** Sort key for an edge that never declared a position. */
const UNORDERED = Number.MAX_SAFE_INTEGER;

/** The minimum an edge needs to be placed: its identity, and its order if it has one. */
export interface OrderableEdge {
  readonly id: string;
  readonly order?: number;
}

export function edgeOrderKey(edge: OrderableEdge): number {
  return edge.order ?? UNORDERED;
}

/**
 * Total order over edges into one port: declared order first, then id.
 *
 * The id tiebreak is what keeps this DETERMINISTIC for every actor (§V40) when two edges
 * claim the same position — which a hand-edited document can do and which nothing in the
 * patch layer can produce.
 */
export function compareEdgeOrder(a: OrderableEdge, b: OrderableEdge): number {
  const byOrder = edgeOrderKey(a) - edgeOrderKey(b);
  return byOrder !== 0 ? byOrder : a.id.localeCompare(b.id);
}

/** Every edge landing on one input port, in the order the consuming node will see them. */
export function incomingEdgesInOrder(
  graph: Pick<GraphDocument, "edges">,
  nodeId: NodeId,
  portId: PortId,
): GraphEdge[] {
  const edges: GraphEdge[] = [];
  for (const edge of Object.values(graph.edges)) {
    if (edge.target.nodeId === nodeId && edge.target.portId === portId) edges.push(edge);
  }
  return edges.sort(compareEdgeOrder);
}
