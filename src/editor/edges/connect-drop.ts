import { incomingEdgesInOrder } from "@domain/graph/edge-order.ts";
import { arePortsCompatible, describePortType } from "@domain/graph/port-compat.ts";
import { nodeDisplayName } from "@domain/graph/diagnostic-names.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { EdgeId, NodeId, PortId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";

/**
 * WHAT A CONNECTION DROPPED ON A SOCKET MEANS — the one answer, for every surface
 * (T695, T1049, §V13, §V14, §V14a, §V32).
 *
 * This used to live inside `graph-canvas.tsx`'s `onConnect`, which was fine while the
 * canvas was the only place a wire could be aimed. The Connections panel (T1049) aims
 * wires too, and the owner ruled on the shape before it could become a second copy:
 * "we can easily reuse the logic that we have on the canvas… the worst that can happen
 * is that we have to EXTRACT it so that we can reuse it. Definitely don't duplicate it."
 *
 * The reason that matters more than the tidiness: "can this wire go here, and what does
 * landing it do to what is already there" is ONE question, and two implementations of it
 * are two answers that agree until the day someone edits one. This project has spent
 * whole sessions on exactly that failure — a name and an address derived twice, drifting
 * the moment either moved. So the canvas, the panel, and anything that aims a wire next
 * call this, and there is one place to fix when §V14 changes.
 *
 * ## What it decides
 *
 * SLOT k IS THE ADDRESS, not the port (§T695). Landing on an occupied socket REPLACES the
 * wire in it, in place — the `order` on the connect is what puts the newcomer where the old
 * one was, because the disconnect would otherwise compact the survivors and the
 * replacement would append. Landing on the spare socket past the end APPENDS. An ordinary
 * input displaces whatever was on it (§V14a: the drop is the user's intent, and making
 * them hunt down the old wire first is the wrong answer to it).
 *
 * ## Refusal is a RESULT, not an empty array
 *
 * `edge-drop.ts`'s siblings return `[]` for "this cannot mean anything", and that is right
 * there: the user released a wire over empty canvas and nothing happening IS the feedback.
 * It is wrong here. A drop aimed at a named row in a list is unambiguous about what was
 * intended, so a silent no-op reads as a broken panel. §V288's rule — fail loud where the
 * thing is meaningless, and NAME what was wrong — gives the third case: `refused`, with a
 * diagnostic that says which two types did not meet. The caller decides whether to show it;
 * the canvas already refuses incompatible drops under the cursor (`isValidConnection`) and
 * so never sees one.
 */

/** A socket a wire can be aimed at: a port, or one numbered socket of a variadic port. */
export interface SocketTarget {
  readonly nodeId: NodeId;
  readonly portId: PortId;
  /**
   * T695: which socket of a variadic port. Absent means the port itself — an ordinary
   * input, or an append. A slot past the last edge is the spare socket, and appends.
   */
  readonly slot?: number;
}

export type ConnectDrop =
  /** Do this, as ONE patch: it is one gesture, so it is one undo entry (§V32, §V34). */
  | { readonly kind: "connect"; readonly operations: GraphPatchOperation[]; readonly label: string }
  /** The graph already says this. Nothing to do, and nothing went wrong. */
  | { readonly kind: "unchanged" }
  /** §V288: refused, and the reason is sayable. The graph is untouched. */
  | { readonly kind: "refused"; readonly diagnostic: RuntimeDiagnostic };

/** The document fields this reads. Narrow so a caller holding a projection can pass it. */
export type ConnectDropGraph = Pick<GraphDocument, "nodes" | "edges">;

export interface ConnectDropRequest {
  readonly graph: ConnectDropGraph;
  readonly registry: NodeRegistryView;
  readonly source: { readonly nodeId: NodeId; readonly portId: PortId };
  readonly target: SocketTarget;
  /**
   * An EXISTING edge whose target end is being moved here, rather than a new wire.
   *
   * It is disconnected in the same patch, and it is excluded from the displacement scan —
   * without that, re-targeting a wire within a port that already holds it would disconnect
   * the very edge being moved twice and count the sockets wrong.
   */
  readonly moving?: EdgeId;
}

function refusal(code: string, message: string, nodeId: NodeId, suggestion?: string): ConnectDrop {
  return {
    kind: "refused",
    diagnostic: {
      severity: "error",
      code,
      message,
      nodeId,
      ...(suggestion === undefined ? {} : { suggestion }),
    },
  };
}

export function connectDropOperations(request: ConnectDropRequest): ConnectDrop {
  const { graph, registry, source, target, moving } = request;
  const sourceNode = graph.nodes[source.nodeId];
  const targetNode = graph.nodes[target.nodeId];
  if (sourceNode === undefined || targetNode === undefined) {
    return refusal("connect.noSuchNode", "One end of that wire is no longer in the graph.", target.nodeId);
  }
  const sourcePort = registry.port(sourceNode.type, source.portId, "output");
  const targetPort = registry.port(targetNode.type, target.portId, "input");
  if (sourcePort === undefined || targetPort === undefined) {
    const missing = sourcePort === undefined ? source.portId : target.portId;
    return refusal(
      "connect.noSuchPort",
      `Port "${missing}" is not declared by any installed definition.`,
      target.nodeId,
    );
  }

  /*
   * §V13 — EXACT match, and the refusal names both sides. A near miss is a missing
   * conversion node, not a cast, and a gesture is the last place to start inventing one.
   * The canvas checks this under the cursor as well (`isValidConnection`), so this is the
   * backstop for every surface that has no cursor to check under.
   */
  if (!arePortsCompatible(sourcePort.type, targetPort.type)) {
    return refusal(
      "connect.incompatible",
      `${nodeDisplayName(graph, source.nodeId)}.${sourcePort.label} is ${describePortType(sourcePort.type)}; ${targetPort.label} takes ${describePortType(targetPort.type)}.`,
      target.nodeId,
      "Insert a node that converts between them (§V13).",
    );
  }

  const operations: GraphPatchOperation[] = [];
  const spent = new Set<EdgeId>();
  if (moving !== undefined) {
    operations.push({ op: "disconnect", edgeIds: [moving] });
    spent.add(moving);
  }

  let order: number | undefined;
  if (targetPort.variadic !== true) {
    // §V14a — an occupied ordinary input is REPLACED, in the same patch.
    const occupying = incomingEdgesInOrder(graph, target.nodeId, target.portId).filter(
      (edge) => !spent.has(edge.id),
    );
    const only = occupying.length === 1 ? occupying[0] : undefined;
    // Dropping the wire that is already there is not a rewire; it is nothing.
    if (only?.source.nodeId === source.nodeId && only?.source.portId === source.portId) {
      return { kind: "unchanged" };
    }
    if (occupying.length > 0) {
      operations.push({ op: "disconnect", edgeIds: occupying.map((edge) => edge.id) });
    }
  } else if (target.slot !== undefined) {
    /*
     * `incomingEdgesInOrder` and not a filter of our own: this has to resolve "slot 2" to
     * the same edge the node drew at slot 2 and the projection stamped on the wire
     * (§V487). A drop on the SPARE socket resolves to nothing and falls through to a
     * plain append, which is what the spare socket means.
     */
    const arriving = incomingEdgesInOrder(graph, target.nodeId, target.portId);
    const movingIndex = moving === undefined ? -1 : arriving.findIndex((e) => e.id === moving);

    if (movingIndex >= 0) {
      /*
       * REPOSITION, not replace — and the distinction is a connection's life.
       *
       * The wire is already on this port, so aiming it at an occupied socket is
       * rearranging, exactly as dragging a row is. Taking the replace branch here would
       * DELETE the sibling that happened to be sitting at the destination, which is a
       * layer the user never touched. Replace is right only for a wire ARRIVING from
       * another port, where the socket genuinely has to make room.
       *
       * The disconnect above compacts everything above the wire's own position, so a move
       * DOWNWARD lands one place late unless the order is stated one lower. Moving up
       * needs no adjustment: nothing below it shifted.
       */
      if (movingIndex === target.slot) return { kind: "unchanged" };
      order = movingIndex < target.slot ? Math.max(0, target.slot - 1) : target.slot;
    } else {
      const occupant = arriving[target.slot];
      if (occupant !== undefined) {
        if (occupant.source.nodeId === source.nodeId && occupant.source.portId === source.portId) {
          return { kind: "unchanged" };
        }
        operations.push({ op: "disconnect", edgeIds: [occupant.id] });
        order = target.slot;
      }
    }
  }

  operations.push({
    op: "connect",
    source: { nodeId: source.nodeId, portId: source.portId },
    target: { nodeId: target.nodeId, portId: target.portId },
    ...(order === undefined ? {} : { order }),
  });

  return {
    kind: "connect",
    operations,
    label: moving !== undefined ? "Move connection" : order === undefined ? "Connect ports" : "Replace connection",
  };
}
