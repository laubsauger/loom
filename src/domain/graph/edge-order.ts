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

/**
 * ONE VARIADIC PORT, N+1 SOCKETS: N occupied, and one empty at the end (T695, §V131).
 *
 * ## What the user gets, and why it needs this shape
 *
 * A single socket that swallows any number of wires can only be APPENDED to. There is no
 * target to aim at, so "drop this onto that input" cannot be said — which is the owner's
 * complaint: "prevents us from drop replacing new connections onto existing ones". Give
 * the port one socket per edge plus a spare and both gestures become expressible, on the
 * same drop: land on an occupied socket and you REPLACE its edge, land on the spare and
 * you APPEND, and a new spare appears. That is TouchDesigner's and ComfyUI's shape.
 *
 * ## What a socket IS, which is the whole of the design
 *
 * Slot k is **the edge whose `order` is k** — the field §V131 already put on the edge, and
 * which `apply-patch` already keeps DENSE (`compactPortOrder` renumbers 0..n-1 after every
 * disconnect). It is NOT "the k-th thing in whatever list the renderer happened to build".
 *
 * The difference is the difference between a working feature and a corrupting one. If a
 * slot were an index into a list, then the renderer sorting one way and the drop handler
 * sorting another would silently re-point a wire the user never touched: remove edge 2 of
 * 3 and edge 3 answers to a drop meant for edge 2. So the resolution lives HERE, beside
 * the comparator that defines the order, and every site — the ports the node draws, the
 * `targetHandle` the projection stamps on each edge, and the drop that lands on one —
 * calls this one function (§V487: four sites, four private lists, one missing kind).
 *
 * Renumbering on disconnect is not that bug wearing a hat: it is a document edit, one
 * patch, undoable, and it preserves every surviving edge's RELATIVE order. The edges keep
 * their identity; only their position closes up, which is what the user watching three
 * sockets become two is asking for.
 *
 * The socket LIST for a port is `incomingEdgesInOrder` — slot k is entry k — plus one
 * empty socket at index `length`. That function is already the single answer to "which
 * input is first" for the document layer and the compiler; this makes it the answer for
 * the editor too rather than opening a third one.
 *
 * ## Separator
 *
 * `#` because it cannot occur in a `PortId`: ports are declared as identifiers in node
 * definitions (`in1`, `scenes`, `lights`) and the patch layer matches them by exact
 * string against that declaration. `parseHandleId` does not RELY on that — it splits at
 * the last `#` and only when a run of digits follows — so a port id that somehow carried
 * one still round-trips instead of silently resolving to the wrong port.
 */
const SLOT_SEPARATOR = "#";

/** The React Flow handle id for one socket of a variadic port. */
export function variadicHandleId(portId: PortId, slot: number): string {
  return `${portId}${SLOT_SEPARATOR}${String(slot)}`;
}

/**
 * A React Flow handle id back into the port it belongs to, and the slot if it names one.
 *
 * Total, and deliberately so: every handle id in the app goes through here, including the
 * plain port ids that non-variadic ports and every output still use. A caller that has a
 * handle id and wants a port asks this rather than passing the raw string to
 * `registry.port`, which would answer `undefined` for `in2#1` and refuse a legal drop.
 */
export function parseHandleId(handleId: string): { portId: PortId; slot: number | undefined } {
  const cut = handleId.lastIndexOf(SLOT_SEPARATOR);
  if (cut <= 0) return { portId: handleId, slot: undefined };
  const suffix = handleId.slice(cut + 1);
  if (suffix.length === 0 || !/^\d+$/.test(suffix)) return { portId: handleId, slot: undefined };
  return { portId: handleId.slice(0, cut), slot: Number(suffix) };
}
