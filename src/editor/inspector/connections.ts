import { incomingEdgesInOrder } from "@domain/graph/edge-order.ts";
import { nodeDisplayName } from "@domain/graph/diagnostic-names.ts";
import type { GraphDocument, GraphEdge } from "@domain/types/graph.ts";
import type { EdgeId, NodeId, PortId } from "@domain/types/ids.ts";
import type { NodeDefinition } from "@domain/types/node-definition.ts";

/**
 * The CONNECTIONS row model (T1049) — TouchDesigner's connections overview, as data.
 *
 * The owner: "this overview of what is connected to this node… TouchDesigner shows it in
 * a way where we can drag and drop up and down the ORDER of who's connected to whom, so
 * we can swap and replace and reorder who's connected to which socket."
 *
 * ## Why this is worth a panel, and not a nicety
 *
 * Order is SEMANTIC. `graph.ts:135`: explicit "rather than derived from creation order,
 * because for Over and Composite the layer order IS the operation". §T695 sharpens it: a
 * variadic input draws one socket per edge plus a spare, so "the port" is not an address —
 * SLOT k is, and slot k is the edge whose `order` is k. Dragging a row here therefore
 * changes the picture: which source a Switch's index selects, which layer composites on
 * top. That is the claim the gate has to make (`connections-picture.gpu.test.ts`), because
 * a list that merely re-sorts its own rows looks identical from the outside.
 *
 * ## IN AND OUT ARE NOT THE SAME LIST, AND ARE DELIBERATELY NOT BUILT AS ONE
 *
 * An INPUT port's edges are an ordered sequence the consuming node folds in order, so the
 * arrangement is a document fact the user owns — `orderable`, and reorderable by drag and
 * by keyboard.
 *
 * An OUTPUT port's edges FAN OUT. Each consumer decides for itself where this wire sits in
 * its own input list, so there is no ordering question at this end to answer: "which of my
 * consumers is first" is not a property of anything, and `reorderEdges` would reject it
 * anyway (it is addressed by TARGET node and port). Offering a grip that could only
 * rearrange a cosmetic list would be the exact failure §T1049 warns about. So an output
 * group carries no `orderable` flag at all rather than one that is always false: there is
 * nothing here to disable (§V830 — absence of a gesture is not a greyed-out control), and
 * the two halves have different types because they mean different things.
 *
 * Output rows still name the peer's SLOT ("Behind 2") when the consumer's port is
 * variadic, because that is the fact you came looking for: which layer of that composite
 * this wire feeds. Reordering it is done from the consumer, where the question belongs.
 *
 * ## Names, not addresses (§B170)
 *
 * Every peer is named through `nodeDisplayName` — `label ?? id` — the same helper the
 * diagnostics, the header and the wires use. Two examples shipped dead because something
 * matched an id where a name was meant; a fourth private answer to "what is this node
 * called" is how that recurs.
 */

/** All this needs of the node registry: the definition behind a type, if there is one. */
export interface ConnectionsRegistry {
  get(type: string): NodeDefinition | undefined;
}

/** One wire, as the list shows it. */
export interface ConnectionRow {
  readonly edgeId: EdgeId;
  /**
   * The socket on THIS node. A variadic port's socket carries its 1-based slot the way
   * the node itself draws it (`node-view.tsx`: `${port.label} ${slot + 1}`) — the row and
   * the socket the user can point at must read the same, or the list is describing a
   * different graph from the canvas.
   */
  readonly socket: string;
  /** §B170: the node at the other end by NAME. Never its id, unless it has no name. */
  readonly peerName: string;
  readonly peerNodeId: NodeId;
  /** The port on the other node, by label — with the peer's own slot when it is variadic. */
  readonly peerPort: string;
}

/** One input port's edges, in the order the consuming node folds them (§V131). */
export interface ConnectionInputGroup {
  readonly portId: PortId;
  readonly portLabel: string;
  /**
   * True only when this port ORDERS its edges and there are at least two to arrange.
   * A single wire has no arrangement, and an ordinary port has no order at all —
   * `reorderEdges` rejects both (`port.notVariadic`), so offering the gesture would be
   * offering a refusal.
   */
  readonly orderable: boolean;
  readonly rows: readonly ConnectionRow[];
}

/** One output port's consumers. No order — see the docblock above. */
export interface ConnectionOutputGroup {
  readonly portId: PortId;
  readonly portLabel: string;
  readonly rows: readonly ConnectionRow[];
}

export interface ConnectionModel {
  readonly inputs: readonly ConnectionInputGroup[];
  readonly outputs: readonly ConnectionOutputGroup[];
  /** Wires in total, so a caller can say "nothing is connected" without re-counting. */
  readonly total: number;
}

const EMPTY: ConnectionModel = { inputs: [], outputs: [], total: 0 };

/**
 * Move the row at `from` to index `to`, giving the port's new edge order.
 *
 * `null` when the move changes nothing — an out-of-range grab, or a drop back where the
 * row started. The caller sends no patch for a null, which is what keeps a drag that
 * wanders over its own row from writing a document revision per pointer event.
 *
 * `to` is CLAMPED rather than refused: the user has already released the pointer or held
 * the arrow key at the end of the list, and an off-by-one they cannot see is not their
 * bug (the same ruling `edge-order.ts` makes for a drop past the last socket).
 */
export function movedOrder(
  edgeIds: readonly EdgeId[],
  from: number,
  to: number,
): EdgeId[] | null {
  if (from < 0 || from >= edgeIds.length) return null;
  const target = Math.max(0, Math.min(edgeIds.length - 1, to));
  if (target === from) return null;
  const next = [...edgeIds];
  const [moved] = next.splice(from, 1);
  if (moved === undefined) return null;
  next.splice(target, 0, moved);
  return next;
}

/**
 * Every wire touching one node, grouped by the port it lands on.
 *
 * Pure and headless: a document, a registry view and a node id in, rows out. The panel
 * renders this and owns no second reading of the graph.
 */
export function connectionModel(
  graph: GraphDocument,
  registry: ConnectionsRegistry,
  nodeId: NodeId,
): ConnectionModel {
  const node = graph.nodes[nodeId];
  if (node === undefined) return EMPTY;
  const definition = registry.get(node.type);

  /**
   * §V487 — ONE reading of "which edge is in slot k", cached per port.
   *
   * Both halves need it: this node's own input rows, and the peer slot an output row
   * names. `incomingEdgesInOrder` is the single answer the compiler and the canvas
   * already use; a private sort here would be the second one, and the two would disagree
   * the first time an edge arrived with no `order` at all (§V68 sorts those last).
   */
  const cache = new Map<string, readonly GraphEdge[]>();
  const arrival = (target: NodeId, portId: PortId): readonly GraphEdge[] => {
    const key = `${target} ${portId}`;
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const computed = incomingEdgesInOrder(graph, target, portId);
    cache.set(key, computed);
    return computed;
  };

  const peerPortName = (
    peerNodeId: NodeId,
    portId: PortId,
    direction: "input" | "output",
    edgeId: EdgeId,
  ): string => {
    const peer = graph.nodes[peerNodeId];
    const peerDefinition = peer === undefined ? undefined : registry.get(peer.type);
    const port = (direction === "input" ? peerDefinition?.inputs : peerDefinition?.outputs)?.find(
      (candidate) => candidate.id === portId,
    );
    // An unknown type (§V10's uninstalled package) still has wires; naming the port by its
    // id says less than a label but says something true, which beats hiding the row.
    if (port === undefined) return portId;
    if (direction !== "input" || port.variadic !== true) return port.label;
    const slot = arrival(peerNodeId, portId).findIndex((edge) => edge.id === edgeId);
    return slot < 0 ? port.label : `${port.label} ${String(slot + 1)}`;
  };

  const inputRow = (edge: GraphEdge, socket: string): ConnectionRow => ({
    edgeId: edge.id,
    socket,
    peerName: nodeDisplayName(graph, edge.source.nodeId),
    peerNodeId: edge.source.nodeId,
    peerPort: peerPortName(edge.source.nodeId, edge.source.portId, "output", edge.id),
  });

  const inputs: ConnectionInputGroup[] = [];
  const claimedInputPorts = new Set<PortId>();
  for (const port of definition?.inputs ?? []) {
    claimedInputPorts.add(port.id);
    const edges = arrival(nodeId, port.id);
    if (edges.length === 0) continue;
    inputs.push({
      portId: port.id,
      portLabel: port.label,
      orderable: port.variadic === true && edges.length > 1,
      rows: edges.map((edge, slot) =>
        inputRow(edge, port.variadic === true ? `${port.label} ${String(slot + 1)}` : port.label),
      ),
    });
  }

  /**
   * Wires landing on a port the definition does not declare — an uninstalled node package,
   * a document saved against a later catalogue. They are shown, named by port id, and not
   * offered a reorder: nothing here knows whether that port orders its edges, and guessing
   * would put a grip on a gesture the patch layer refuses (§V91 — say what the state is).
   */
  const strayInputs = new Map<PortId, GraphEdge[]>();
  const strayOutputs = new Map<PortId, GraphEdge[]>();
  const outputEdges = new Map<PortId, GraphEdge[]>();
  const claimedOutputPorts = new Set((definition?.outputs ?? []).map((port) => port.id));
  for (const edge of Object.values(graph.edges)) {
    if (edge.target.nodeId === nodeId && !claimedInputPorts.has(edge.target.portId)) {
      const list = strayInputs.get(edge.target.portId) ?? [];
      list.push(edge);
      strayInputs.set(edge.target.portId, list);
    }
    if (edge.source.nodeId !== nodeId) continue;
    const bucket = claimedOutputPorts.has(edge.source.portId) ? outputEdges : strayOutputs;
    const list = bucket.get(edge.source.portId) ?? [];
    list.push(edge);
    bucket.set(edge.source.portId, list);
  }

  for (const [portId, edges] of [...strayInputs].sort(([a], [b]) => a.localeCompare(b))) {
    inputs.push({
      portId,
      portLabel: portId,
      orderable: false,
      rows: [...edges]
        .sort((a, b) => a.id.localeCompare(b.id))
        .map((edge) => inputRow(edge, portId)),
    });
  }

  /**
   * Consumers are sorted by NAME, then by edge id for determinism (§V40). Not by anything
   * the document calls an order: this end has none, and a stable presentation order is a
   * different thing from a semantic one — it must never be draggable.
   */
  const outputRows = (socket: string, edges: readonly GraphEdge[]) =>
    [...edges]
      .map(
        (edge): ConnectionRow => ({
          edgeId: edge.id,
          socket,
          peerName: nodeDisplayName(graph, edge.target.nodeId),
          peerNodeId: edge.target.nodeId,
          peerPort: peerPortName(edge.target.nodeId, edge.target.portId, "input", edge.id),
        }),
      )
      .sort((a, b) => a.peerName.localeCompare(b.peerName) || a.edgeId.localeCompare(b.edgeId));

  const outputs: ConnectionOutputGroup[] = [];
  for (const port of definition?.outputs ?? []) {
    const edges = outputEdges.get(port.id) ?? [];
    if (edges.length === 0) continue;
    outputs.push({
      portId: port.id,
      portLabel: port.label,
      rows: outputRows(port.label, edges),
    });
  }
  for (const [portId, edges] of [...strayOutputs].sort(([a], [b]) => a.localeCompare(b))) {
    outputs.push({ portId, portLabel: portId, rows: outputRows(portId, edges) });
  }

  const total =
    inputs.reduce((sum, group) => sum + group.rows.length, 0) +
    outputs.reduce((sum, group) => sum + group.rows.length, 0);
  return { inputs, outputs, total };
}
