import type { NodeRegistryView } from "../../nodes/registry/registry.ts";
import type { GraphDocument, GraphNode } from "../types/graph.ts";
import type { NodeId } from "../types/ids.ts";
import { NODE_WIDTH, nodeBox } from "./node-box.ts";

/**
 * Deterministic auto-layout (§V78's one-implementation rule made literal): the SAME
 * function serves the canvas menu's "Layout", the `L`/`l` keybindings, and the agent's
 * `layout_graph` tool — an agent-built graph and a human-tidied one converge on the
 * same picture, which is most of what "agents building beautiful graphs" means.
 *
 * ## B84 — the second size model this file used to carry
 *
 * That "SAME function" sentence was true of the maths and FALSE of the geometry. This
 * module sized a node as `node.size ?? {180, 100}` while `node-box.ts` — the model
 * MEASURED against real `offsetWidth`/`offsetHeight` in Chrome across 108 node instances
 * (T460, `src/tests/e2e/node-box.spec.ts`) — says an unsized node is **178** wide and
 * between 36 and 172 tall depending on whether it previews and how many port rows survive
 * the reference filter. Two size models is two layouts, and §V189's promise ("same graph
 * → same positions, for all time") would have broken the first time an agent and a human
 * both pressed the button. There is now ONE answer and this function asks for it: the
 * registry comes in as an argument precisely so the question cannot be dodged.
 *
 * That is also why `node-box.ts` moved from `src/editor/nodes/` into this directory. It
 * models a DOM, but it is a pure function of `GraphNode` and `NodeDefinition`, and a
 * layout that runs headless (the MCP server has no editor) cannot import the editor.
 *
 * ## The algorithm, chosen for being fully deterministic
 *
 *  - RANK  = longest-path depth from the sources, so a node sits one column right of
 *    its deepest producer and data always flows left → right;
 *  - ORDER within a rank = barycenter of the producers' orders (one downward sweep),
 *    ties broken by node id — crossings shrink, nothing depends on iteration luck;
 *  - POSITION = column pitch from the widest box in the column, rows centred per rank
 *    (§V116: a user-sized node keeps its size and layout works around it).
 *
 * Cycles (feedback) are fine: the temporal back-edge is simply ignored for ranking, so
 * a feedback loop lays out as the forward chain it reads as. The result is a POSITION
 * MAP, not a mutation — callers apply it as one `moveNodes` patch, one undo group.
 *
 * ## What this is NOT, stated rather than implied (§V328)
 *
 * A layered sweep with ONE barycenter pass is a tidy, not a crossing minimiser. It puts
 * a chain in reading order and stops crossings that come from insertion order; it will
 * not untangle a dense many-to-many patch the way an iterated Sugiyama would, and it does
 * nothing about edge routing. The one pass is deliberate — iteration count is exactly the
 * kind of thing §V189 forbids depending on — but "minimizes crossings" would be a promise
 * this does not keep.
 */

export interface LayoutOptions {
  /** Only these nodes move; absent = the whole document. Ranks still consider everyone. */
  readonly only?: ReadonlySet<NodeId>;
  readonly columnGap?: number;
  readonly rowGap?: number;
  /** Top-left origin of the arrangement. */
  readonly origin?: { readonly x: number; readonly y: number };
}

/**
 * The default gaps are the `src/examples/layout.test.ts` gutters, and they are different
 * numbers for that gate's reasons: 32 vertical because the diagnostic row and the
 * agent-activity row are RUNTIME state `nodeBox` deliberately does not model and they only
 * ever push a node DOWN, 16 horizontal because `--node-width` is a constant and nothing at
 * runtime widens a node. Laying a graph out must not produce a graph that gate would
 * reject; these are the smallest values for which that is true, and the defaults below are
 * comfortably above them.
 */
export const MIN_LAYOUT_ROW_GAP = 32;
export const MIN_LAYOUT_COLUMN_GAP = 16;

/** `placeRelative`'s gaps — the layout defaults, so a drop and a tidy read the same. */
const RELATIVE_COLUMN_GAP = 80;
const RELATIVE_ROW_GAP = 40;

const sizeOf = (
  node: GraphNode,
  registry: NodeRegistryView,
): { width: number; height: number } => {
  const box = nodeBox(node, registry.get(node.type));
  return { width: box.width, height: box.height };
};

export function layoutGraph(
  graph: GraphDocument,
  registry: NodeRegistryView,
  options: LayoutOptions = {},
): Record<NodeId, { x: number; y: number }> {
  const columnGap = Math.max(options.columnGap ?? 80, MIN_LAYOUT_COLUMN_GAP);
  const rowGap = Math.max(options.rowGap ?? 40, MIN_LAYOUT_ROW_GAP);
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
    const boxes = column.map((nodeId) => sizeOf(graph.nodes[nodeId] as GraphNode, registry));
    const widths = boxes.map((box) => box.width);
    const heights = boxes.map((box) => box.height);
    const totalHeight = heights.reduce((sum, height) => sum + height, 0) + rowGap * Math.max(0, column.length - 1);
    let y = origin.y - totalHeight / 2;
    column.forEach((nodeId, index) => {
      if (options.only === undefined || options.only.has(nodeId)) {
        positions[nodeId] = { x, y };
      }
      y += (heights[index] ?? 0) + rowGap;
    });
    x += Math.max(...widths, NODE_WIDTH) + columnGap;
  }

  return positions;
}

/**
 * The one-line placement an agent (or the paste flow) uses instead of inventing
 * coordinates: next to an existing node, offset by its size plus a gap, in reading
 * direction. Deterministic and collision-naive on purpose — a full tidy is
 * `layoutGraph`'s job; this keeps an incrementally-built chain readable as it grows.
 *
 * It takes the registry for the same B84 reason `layoutGraph` does: this was the second
 * caller of the 180×100 guess, so an agent adding a node "below" one that previews used to
 * overlap it by 62px. Collision-naive is a choice about NEIGHBOURS; it was never a licence
 * to be wrong about the anchor's own box.
 */
export function placeRelative(
  graph: GraphDocument,
  registry: NodeRegistryView,
  relativeTo: NodeId,
  direction: "right" | "below" | "left" | "above" = "right",
): { x: number; y: number } {
  const anchor = graph.nodes[relativeTo];
  if (anchor === undefined) return { x: 0, y: 0 };
  const { width, height } = sizeOf(anchor, registry);
  switch (direction) {
    case "left":
      return { x: anchor.position.x - width - RELATIVE_COLUMN_GAP, y: anchor.position.y };
    case "below":
      return { x: anchor.position.x, y: anchor.position.y + height + RELATIVE_ROW_GAP };
    case "above":
      return { x: anchor.position.x, y: anchor.position.y - height - RELATIVE_ROW_GAP };
    default:
      return { x: anchor.position.x + width + RELATIVE_COLUMN_GAP, y: anchor.position.y };
  }
}
