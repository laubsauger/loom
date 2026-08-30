import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";

/**
 * Deterministic auto-layout (§V78's one-implementation rule made literal): the SAME
 * function serves the canvas menu's "layout", the `L` keybinding, and the agent's
 * `layout_graph` tool — an agent-built graph and a human-tidied one converge on the
 * same picture, which is most of what "agents building beautiful graphs" means.
 *
 * The algorithm is a classic layered layout, chosen for being fully deterministic:
 *
 *  - RANK  = longest-path depth from the sources, so a node sits one column right of
 *    its deepest producer and data always flows left → right;
 *  - ORDER within a rank = barycenter of the producers' orders (one downward sweep),
 *    ties broken by node id — crossings shrink, nothing depends on iteration luck;
 *  - POSITION = fixed column pitch, rows centred per rank, spacing derived from the
 *    largest node in the column (§V116: size is document state and layout respects it).
 *
 * Cycles (feedback) are fine: the temporal back-edge is simply ignored for ranking, so
 * a feedback loop lays out as the forward chain it reads as. The result is a POSITION
 * MAP, not a mutation — callers apply it as one `moveNodes` patch, one undo group.
 */

export interface LayoutOptions {
  /** Only these nodes move; absent = the whole document. Ranks still consider everyone. */
  readonly only?: ReadonlySet<NodeId>;
  readonly columnGap?: number;
  readonly rowGap?: number;
  /** Top-left origin of the arrangement. */
  readonly origin?: { readonly x: number; readonly y: number };
}

const DEFAULT_NODE_WIDTH = 180;
const DEFAULT_NODE_HEIGHT = 100;

const sizeOf = (node: GraphNode): { width: number; height: number } => ({
  width: node.size?.width ?? DEFAULT_NODE_WIDTH,
  height: node.size?.height ?? DEFAULT_NODE_HEIGHT,
});

export function layoutGraph(
  graph: GraphDocument,
  options: LayoutOptions = {},
): Record<NodeId, { x: number; y: number }> {
  const columnGap = options.columnGap ?? 80;
  const rowGap = options.rowGap ?? 40;
  const origin = options.origin ?? { x: 0, y: 0 };
  const nodeIds = Object.keys(graph.nodes).sort();
  if (nodeIds.length === 0) return {};

  const producers = new Map<NodeId, NodeId[]>();
  for (const edgeId of Object.keys(graph.edges).sort()) {
    const edge = graph.edges[edgeId];
    if (edge === undefined) continue;
    if (graph.nodes[edge.source.nodeId] === undefined || graph.nodes[edge.target.nodeId] === undefined) continue;
    const producerList = producers.get(edge.target.nodeId) ?? [];
    producerList.push(edge.source.nodeId);
    producers.set(edge.target.nodeId, producerList);
  }

  // Longest-path rank via memoized DFS; a visiting mark breaks cycles (the feedback
  // back-edge contributes no rank, which is exactly the forward-chain reading).
  const ranks = new Map<NodeId, number>();
  const visiting = new Set<NodeId>();
  const rankOf = (nodeId: NodeId): number => {
    const known = ranks.get(nodeId);
    if (known !== undefined) return known;
    if (visiting.has(nodeId)) return 0;
    visiting.add(nodeId);
    let rank = 0;
    for (const upstream of [...(producers.get(nodeId) ?? [])].sort()) {
      rank = Math.max(rank, rankOf(upstream) + 1);
    }
    visiting.delete(nodeId);
    ranks.set(nodeId, rank);
    return rank;
  };
  for (const nodeId of nodeIds) rankOf(nodeId);

  const columns = new Map<number, NodeId[]>();
  for (const nodeId of nodeIds) {
    const rank = ranks.get(nodeId) ?? 0;
    const column = columns.get(rank) ?? [];
    column.push(nodeId);
    columns.set(rank, column);
  }
  const rankKeys = [...columns.keys()].sort((a, b) => a - b);

  // One downward barycenter sweep: order within a rank follows the mean order of the
  // producers in the previous ranks; sources sort by id. Ties break by id — stable.
  const orderIndex = new Map<NodeId, number>();
  for (const rank of rankKeys) {
    const column = columns.get(rank) ?? [];
    const keyed = column.map((nodeId) => {
      const upstream = (producers.get(nodeId) ?? []).filter((id) => orderIndex.has(id));
      const barycenter =
        upstream.length === 0
          ? Number.POSITIVE_INFINITY
          : upstream.reduce((sum, id) => sum + (orderIndex.get(id) ?? 0), 0) / upstream.length;
      return { nodeId, barycenter };
    });
    keyed.sort((a, b) =>
      a.barycenter === b.barycenter ? a.nodeId.localeCompare(b.nodeId) : a.barycenter - b.barycenter,
    );
    keyed.forEach((entry, index) => {
      orderIndex.set(entry.nodeId, index);
    });
    columns.set(rank, keyed.map((entry) => entry.nodeId));
  }

  // Positions: columns advance by the widest node so far; rows centre around origin.y.
  const positions: Record<NodeId, { x: number; y: number }> = {};
  let x = origin.x;
  for (const rank of rankKeys) {
    const column = columns.get(rank) ?? [];
    const widths = column.map((nodeId) => sizeOf(graph.nodes[nodeId] as GraphNode).width);
    const heights = column.map((nodeId) => sizeOf(graph.nodes[nodeId] as GraphNode).height);
    const totalHeight = heights.reduce((sum, height) => sum + height, 0) + rowGap * Math.max(0, column.length - 1);
    let y = origin.y - totalHeight / 2;
    column.forEach((nodeId, index) => {
      if (options.only === undefined || options.only.has(nodeId)) {
        positions[nodeId] = { x, y };
      }
      y += (heights[index] ?? DEFAULT_NODE_HEIGHT) + rowGap;
    });
    x += Math.max(...widths, DEFAULT_NODE_WIDTH) + columnGap;
  }

  return positions;
}

/**
 * The one-line placement an agent (or the paste flow) uses instead of inventing
 * coordinates: next to an existing node, offset by its size plus a gap, in reading
 * direction. Deterministic and collision-naive on purpose — a full tidy is
 * `layoutGraph`'s job; this keeps an incrementally-built chain readable as it grows.
 */
export function placeRelative(
  graph: GraphDocument,
  relativeTo: NodeId,
  direction: "right" | "below" | "left" | "above" = "right",
): { x: number; y: number } {
  const anchor = graph.nodes[relativeTo];
  if (anchor === undefined) return { x: 0, y: 0 };
  const { width, height } = sizeOf(anchor);
  const gap = 80;
  switch (direction) {
    case "left":
      return { x: anchor.position.x - width - gap, y: anchor.position.y };
    case "below":
      return { x: anchor.position.x, y: anchor.position.y + height + 40 };
    case "above":
      return { x: anchor.position.x, y: anchor.position.y - height - 40 };
    default:
      return { x: anchor.position.x + width + gap, y: anchor.position.y };
  }
}
