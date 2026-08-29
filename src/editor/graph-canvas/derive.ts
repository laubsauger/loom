import type { Edge, Node } from "@xyflow/react";
import type { GraphEdge, GraphNode } from "@domain/types/graph.ts";
import type { NodeId } from "@domain/types/ids.ts";
import type { PortKind } from "@domain/types/ports.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * Projection of the domain graph onto React Flow's arrays (§V1).
 *
 * The direction matters and is the whole point of this file: the domain document is the
 * source of truth and React Flow is a view of it. Nothing here ever reads a value out of
 * the React Flow array and calls it authoritative — identity, type and position always
 * come from the domain node. The only fields carried over from the previous projection
 * are the ones React Flow itself owns and the document deliberately does not model:
 * selection, measured size, and the in-flight drag position (which becomes a domain
 * position only when the drag commits through the bus, §V15).
 *
 * The projection also reuses the previous object whenever nothing it derives has
 * changed. That reference stability is what keeps memoised node components from
 * re-rendering on every unrelated document revision (§V16).
 */

export const LOOM_NODE_TYPE = "loom";
export const SIGNAL_EDGE_TYPE = "signal";

/**
 * Node payload is the id and nothing else. Copying parameters or metrics in here would
 * re-render every node on every document revision; instead each node subscribes to its
 * own slice of the store and its own runtime channel (§V16).
 */
export type LoomNodeData = { nodeId: NodeId };
export type LoomNode = Node<LoomNodeData, typeof LOOM_NODE_TYPE>;

export type SignalEdgeData = {
  /**
   * §V26 — the edge's hue IS the source port's family. `null` only when the source port
   * cannot be resolved (an unresolved placeholder node, §V10), which renders neutral
   * rather than picking an arbitrary hue.
   */
  portKind: PortKind | null;
  /** The pass whose GPU time drives this edge's flow (§C signature element). */
  sourceNodeId: NodeId;
  /** Source pass is bypassed or muted: it does no GPU work, so the edge cannot flow. */
  inactive: boolean;
};
export type LoomEdge = Edge<SignalEdgeData, typeof SIGNAL_EDGE_TYPE>;

function samePosition(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return a.x === b.x && a.y === b.y;
}

/**
 * Returns `previous` itself when the new projection is element-wise identical, so a
 * document revision that did not touch the graph view produces no re-render at all.
 */
function stable<T>(previous: readonly T[], next: T[]): T[] {
  if (previous.length !== next.length) return next;
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) return next;
  }
  return previous as T[];
}

export function projectNodes(
  nodes: Readonly<Record<NodeId, GraphNode>>,
  previous: readonly LoomNode[] = [],
): LoomNode[] {
  const before = new Map(previous.map((node) => [node.id, node]));
  // Sorted so two clients projecting the same document produce the same array (§V40).
  const next = Object.keys(nodes)
    .sort()
    .flatMap((nodeId): LoomNode[] => {
      const domain = nodes[nodeId];
      if (domain === undefined) return [];
      const prior = before.get(nodeId);
      if (prior === undefined) {
        return [
          {
            id: nodeId,
            type: LOOM_NODE_TYPE,
            position: { x: domain.position.x, y: domain.position.y },
            data: { nodeId },
          },
        ];
      }
      // A node being dragged keeps the view position until the drag commits (§V15);
      // anything else takes its position from the document.
      const keepPosition = prior.dragging === true || samePosition(prior.position, domain.position);
      if (keepPosition) return [prior];
      return [{ ...prior, position: { x: domain.position.x, y: domain.position.y } }];
    });
  return stable(previous, next);
}

function isInactive(node: GraphNode | undefined): boolean {
  return node?.ui?.bypassed === true || node?.ui?.muted === true;
}

export function projectEdges(
  edges: Readonly<Record<string, GraphEdge>>,
  nodes: Readonly<Record<NodeId, GraphNode>>,
  registry: NodeRegistryView,
  previous: readonly LoomEdge[] = [],
): LoomEdge[] {
  const before = new Map(previous.map((edge) => [edge.id, edge]));
  const next = Object.keys(edges)
    .sort()
    .flatMap((edgeId): LoomEdge[] => {
      const domain = edges[edgeId];
      if (domain === undefined) return [];
      const sourceNode = nodes[domain.source.nodeId];
      const port =
        sourceNode === undefined
          ? undefined
          : registry.port(sourceNode.type, domain.source.portId, "output");
      const data: SignalEdgeData = {
        portKind: port?.type.kind ?? null,
        sourceNodeId: domain.source.nodeId,
        inactive: isInactive(sourceNode),
      };
      const prior = before.get(edgeId);
      if (
        prior !== undefined &&
        prior.source === domain.source.nodeId &&
        prior.target === domain.target.nodeId &&
        prior.sourceHandle === domain.source.portId &&
        prior.targetHandle === domain.target.portId &&
        prior.data?.portKind === data.portKind &&
        prior.data.sourceNodeId === data.sourceNodeId &&
        prior.data.inactive === data.inactive
      ) {
        return [prior];
      }
      return [
        {
          ...(prior ?? {}),
          id: edgeId,
          type: SIGNAL_EDGE_TYPE,
          source: domain.source.nodeId,
          sourceHandle: domain.source.portId,
          target: domain.target.nodeId,
          targetHandle: domain.target.portId,
          data,
        },
      ];
    });
  return stable(previous, next);
}
