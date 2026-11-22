import type { GraphDocument, GraphEdge } from "@domain/types/graph.ts";
import type { EdgeId, TieId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";

/**
 * What a tie gesture on the canvas means, as patch operations (T1821b, §V1040).
 *
 * Pure, like `edge-drop.ts` beside it: the graph and the gesture in, operations out, so each
 * meaning is tested without a pointer. Each gesture is ONE patch and one undo step
 * (§V15, §V32): the canvas dispatches what these return through `graph.applyPatch`.
 * Creating a tie on a wire is `graph.rerouteEdge` (the edge menu's door too), so it is not
 * here. The design is docs/wire-ties-design-2026-11-21.md.
 */

export interface TiePosition {
  readonly x: number;
  readonly y: number;
}

/** A tie let go somewhere that is not another tie or a wire: it moves there. */
export function moveTieOperations(graph: GraphDocument, tieId: TieId, to: TiePosition): GraphPatchOperation[] {
  const tie = graph.ties?.[tieId];
  if (tie === undefined || (tie.position.x === to.x && tie.position.y === to.y)) return [];
  return [{ op: "moveTies", positions: { [tieId]: { x: to.x, y: to.y } } }];
}

/**
 * A tie dropped ON another tie: the two become one. Every wire through `from` passes `into`
 * instead, at the place `from` held in its route, and `from` goes. A wire through both
 * keeps its place at `into` and loses `from`. This is how wires are bundled: tie each,
 * then drop one tie on the other.
 */
export function mergeTiesOperations(graph: GraphDocument, from: TieId, into: TieId): GraphPatchOperation[] {
  if (from === into || graph.ties?.[from] === undefined || graph.ties[into] === undefined) return [];
  const operations: GraphPatchOperation[] = [];
  for (const edgeId of Object.keys(graph.edges).sort()) {
    const via = graph.edges[edgeId]?.via;
    if (via === undefined || !via.includes(from)) continue;
    const route = via.includes(into) ? via.filter((tieId) => tieId !== from) : via.map((tieId) => (tieId === from ? into : tieId));
    operations.push({ op: "setEdgeVia", edgeId, via: route });
  }
  operations.push({ op: "removeTies", tieIds: [from] });
  return operations;
}

/**
 * A tie Shift-dropped on a WIRE: that wire joins it (Houdini's pick-up, with Shift because
 * Alt pans here, B195). `segment` is the leg of the wire it was dropped on, which is where
 * in the route the tie goes; the tie also lands where it was let go.
 */
export function joinTieOperations(
  graph: GraphDocument,
  tieId: TieId,
  edgeId: EdgeId,
  segment: number,
  at: TiePosition,
): GraphPatchOperation[] {
  const edge = graph.edges[edgeId];
  if (edge === undefined || graph.ties?.[tieId] === undefined) return [];
  const via = edge.via ?? [];
  if (via.includes(tieId)) return moveTieOperations(graph, tieId, at);
  const place = Math.max(0, Math.min(segment, via.length));
  return [
    ...moveTieOperations(graph, tieId, at),
    { op: "setEdgeVia", edgeId, via: [...via.slice(0, place), tieId, ...via.slice(place)] },
  ];
}

/** A double-clicked tie: gone, and every wire through it runs as it would without it. */
export function removeTieOperations(graph: GraphDocument, tieId: TieId): GraphPatchOperation[] {
  return graph.ties?.[tieId] === undefined ? [] : [{ op: "removeTies", tieIds: [tieId] }];
}

/**
 * The two halves of a wire's route when a node is spliced into it on leg `segment` (T213):
 * the ties before that leg stay with the upstream wire, the rest go with the downstream
 * one. Leg k runs from route point k to k + 1, point 0 being the output.
 */
export function splitRoute(edge: GraphEdge, segment: number): { upstream: TieId[]; downstream: TieId[] } {
  const via = edge.via ?? [];
  const at = Math.max(0, Math.min(segment, via.length));
  return { upstream: via.slice(0, at), downstream: via.slice(at) };
}
