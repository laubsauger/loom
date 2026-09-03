import type { Edge, Node } from "@xyflow/react";
import { incomingEdgesInOrder, variadicHandleId } from "@domain/graph/edge-order.ts";
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
 * §V116 — node size is DOCUMENT state, so it projects exactly like position does.
 *
 * `undefined` on both sides means "no override": the node sizes itself from its content,
 * which is what an untouched node does and what an undo of a resize must restore.
 */
function sameSize(
  view: { width?: number | undefined; height?: number | undefined },
  domain: { width: number; height: number } | undefined,
): boolean {
  if (domain === undefined) return view.width === undefined && view.height === undefined;
  return view.width === domain.width && view.height === domain.height;
}

/**
 * T1102 — the DOCUMENT's stacking order, projected onto React Flow's `zIndex`.
 *
 * `undefined` on both sides means "no override", exactly as size does: React Flow reads an
 * absent `zIndex` as 0, which is where every node that has never been raised sits, so an
 * untouched document projects to nodes carrying no z-index at all rather than to a graph
 * full of explicit zeroes.
 *
 * This is load-bearing beyond the chrome. The preview compositor takes its tile order from
 * React Flow's computed `internals.z` (`app/graph-pane.tsx`), so if the document's order
 * did not arrive HERE the two stacking systems would disagree again — which is the bug.
 */
function sameZ(view: { zIndex?: number | undefined }, domain: number | undefined): boolean {
  return view.zIndex === domain;
}

function withZ(node: LoomNode, z: number | undefined): LoomNode {
  if (z === undefined) {
    const { zIndex: _zIndex, ...rest } = node;
    return rest as LoomNode;
  }
  return { ...node, zIndex: z };
}

function withSize(node: LoomNode, size: { width: number; height: number } | undefined): LoomNode {
  if (size === undefined) {
    const { width: _width, height: _height, ...rest } = node;
    return rest as LoomNode;
  }
  return { ...node, width: size.width, height: size.height };
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
        const fresh: LoomNode = {
          id: nodeId,
          type: LOOM_NODE_TYPE,
          position: { x: domain.position.x, y: domain.position.y },
          data: { nodeId },
        };
        return [withZ(withSize(fresh, domain.size), domain.ui?.z)];
      }
      // A node mid-GESTURE keeps the view's geometry until that gesture commits (§V15):
      // a drag and a resize are both deliberately uncommitted until release, so the
      // document is stale for the whole of one and must not be projected back over it.
      if (prior.dragging === true || prior.resizing === true) return [prior];
      const keepPosition = samePosition(prior.position, domain.position);
      const keepSize = sameSize(prior, domain.size);
      const keepZ = sameZ(prior, domain.ui?.z);
      if (keepPosition && keepSize && keepZ) return [prior];
      const moved: LoomNode = keepPosition
        ? prior
        : { ...prior, position: { x: domain.position.x, y: domain.position.y } };
      const sized = keepSize ? moved : withSize(moved, domain.size);
      return [keepZ ? sized : withZ(sized, domain.ui?.z)];
    });
  return stable(previous, next);
}

function isInactive(node: GraphNode | undefined): boolean {
  return node?.ui?.bypassed === true || node?.ui?.muted === true;
}

/**
 * The handle each edge's TARGET end is drawn to (T695).
 *
 * A variadic input renders one socket per edge plus an empty one, so "the port" is no
 * longer an address — slot k is, and slot k is the edge whose `order` is k. The map is
 * built by walking `incomingEdgesInOrder` per (node, port), which is the SAME function the
 * node's ports and the drop handler ask (§V487). Deriving the slot from `edge.order`
 * directly would be a second answer, and would disagree the moment a document arrived with
 * no orders on it (§V68) — every edge would claim slot `undefined`.
 */
function targetHandles(
  edges: Readonly<Record<string, GraphEdge>>,
  nodes: Readonly<Record<NodeId, GraphNode>>,
  registry: NodeRegistryView,
): Map<string, string> {
  const handles = new Map<string, string>();
  const seen = new Set<string>();
  for (const edge of Object.values(edges)) {
    const key = `${edge.target.nodeId} ${edge.target.portId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = nodes[edge.target.nodeId];
    if (node === undefined) continue;
    if (registry.port(node.type, edge.target.portId, "input")?.variadic !== true) continue;
    incomingEdgesInOrder({ edges }, edge.target.nodeId, edge.target.portId).forEach(
      (occupant, slot) => {
        handles.set(occupant.id, variadicHandleId(occupant.target.portId, slot));
      },
    );
  }
  return handles;
}

export function projectEdges(
  edges: Readonly<Record<string, GraphEdge>>,
  nodes: Readonly<Record<NodeId, GraphNode>>,
  registry: NodeRegistryView,
  previous: readonly LoomEdge[] = [],
): LoomEdge[] {
  const before = new Map(previous.map((edge) => [edge.id, edge]));
  const handles = targetHandles(edges, nodes, registry);
  const next = Object.keys(edges)
    .sort()
    .flatMap((edgeId): LoomEdge[] => {
      const domain = edges[edgeId];
      if (domain === undefined) return [];
      const targetHandle = handles.get(edgeId) ?? domain.target.portId;
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
        prior.targetHandle === targetHandle &&
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
          targetHandle,
          data,
        },
      ];
    });
  return stable(previous, next);
}
