import { useEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import { parseHandleId, variadicHandleId } from "@domain/graph/edge-order.ts";
import type { RuntimeDiagnostic } from "@domain/types/diagnostics.ts";
import type { GraphDocument } from "@domain/types/graph.ts";
import type { EdgeId, NodeId, PortId } from "@domain/types/ids.ts";
import type { PortKind } from "@domain/types/ports.ts";
import type { NodeRegistryView } from "@nodes/registry/registry.ts";
import { connectDropOperations } from "@editor/edges/connect-drop.ts";
import { edgeFamilyColor } from "@editor/edges/flow.ts";
import { cssVars } from "@editor/graph-canvas/css-vars.ts";
import { EnumField } from "@ui/controls/enum-field.tsx";
import { cx } from "@ui/cx.ts";
import type { ParameterEditor } from "./parameter-editor.ts";
import { movedOrder, socketChoicesFor } from "./connections.ts";
import type { ConnectionModel, ConnectionOutputGroup, ConnectionRow } from "./connections.ts";
import styles from "./inspector.module.css";
import rows from "./connections.module.css";

/**
 * The CONNECTIONS view on the node Common page (T1049) — TD's connections overview.
 *
 * What is connected to this node, in and out, named by the node at the other end;
 * REORDERED and REASSIGNED from here, and disconnected from either side. The owner, on why
 * the second verb is not optional: "reordering AND reassigning and whatever was
 * specifically what we wanted… the whole exercise here was that we can also from here
 * quickly shuffle this around. That was like 50 percent of the request."
 *
 * The row model, and why in and out are different lists, is in `connections.ts`. What a
 * drop on a socket MEANS is in `@editor/edges/connect-drop.ts` — the same function the
 * canvas calls for the same gesture, extracted rather than copied on the owner's ruling
 * ("definitely don't duplicate it"). This file is the gesture and nothing else.
 *
 * ## Two gestures, and the line between them
 *
 * REORDER moves a wire within the port it already lands on. It is non-destructive, it
 * preserves edge identity, and the order it edits is the operation for Over and Composite
 * — so it happens LIVE, per position crossed, and you watch the picture restack.
 *
 * RE-TARGET moves a wire to a different port. It replaces whatever was in that socket
 * (T695's drop-replace, the canvas's rule), so it is destructive and it lands on DROP
 * only — dragging across four rows must not delete four connections on the way past.
 *
 * ## Both gestures are keyboard-reachable (§V19)
 *
 * Reorder: focus the grip, ArrowUp / ArrowDown, live on keydown, gesture closed on keyup —
 * so a held repeat is one undo entry. Re-target: the socket picker, a native `<select>`,
 * listing exactly the sockets that would accept this wire. A drag can be aimed at a socket
 * that cannot take the wire and is refused out loud (§V288); the picker cannot, because a
 * list of destinations is a better answer than a refusal you have to earn.
 *
 * ## Every write goes through the bus (§V29)
 *
 * `ParameterEditor` is the inspector's one bus adapter. There is no local order state to
 * fall out of step with the document — the rows render FROM the document, so a gesture
 * that has not landed has not moved anything.
 */

export interface ConnectionsSectionProps {
  nodeId: NodeId;
  graph: GraphDocument;
  registry: NodeRegistryView;
  model: ConnectionModel;
  editor: ParameterEditor;
  /**
   * A refused drop (§V288). Reported here rather than swallowed: the drop was aimed at a
   * named row, so "nothing happened" reads as a broken panel rather than as an answer.
   */
  onRefused?: (diagnostic: RuntimeDiagnostic) => void;
}

/**
 * ONE SOCKET of this node's input side — occupied or not.
 *
 * The flattened list is what the drag works in: a wire can be dropped on any socket, and
 * an empty one is a perfectly good destination. It mirrors what the NODE draws (T695: one
 * socket per edge, plus a spare on a variadic port), which is the point — the panel and
 * the canvas must be pointing at the same things.
 */
interface InputSocket {
  readonly key: string;
  readonly portId: PortId;
  readonly kind: PortKind | null;
  /** Which socket of a variadic port. Absent on an ordinary port. */
  readonly slot: number | undefined;
  /** The wire in it, or null for an empty or spare socket. */
  readonly row: ConnectionRow | null;
  readonly label: string;
  /** Its port orders its edges and has at least two — so this socket can be dragged. */
  readonly orderable: boolean;
  /** Its port's wires, in document order, for the reorder arithmetic. */
  readonly siblings: readonly ConnectionRow[];
}

function inputSockets(model: ConnectionModel): InputSocket[] {
  const sockets: InputSocket[] = [];
  for (const group of model.inputs) {
    for (const [slot, row] of group.rows.entries()) {
      sockets.push({
        key: row.edgeId,
        portId: group.portId,
        kind: group.kind,
        slot: group.variadic ? slot : undefined,
        row,
        label: row.socket,
        orderable: group.orderable,
        siblings: group.rows,
      });
    }
    // The spare socket a variadic port always draws, and — for an ordinary port with
    // nothing on it — the port itself. Both are drop targets and nothing else.
    if (group.variadic) {
      sockets.push({
        key: `${group.portId}#spare`,
        portId: group.portId,
        kind: group.kind,
        slot: group.rows.length,
        row: null,
        label: `${group.portLabel} ${String(group.rows.length + 1)}`,
        orderable: false,
        siblings: group.rows,
      });
    } else if (group.rows.length === 0) {
      sockets.push({
        key: `${group.portId}#empty`,
        portId: group.portId,
        kind: group.kind,
        slot: undefined,
        row: null,
        label: group.portLabel,
        orderable: false,
        siblings: group.rows,
      });
    }
  }
  return sockets;
}

export function ConnectionsSection({
  nodeId,
  graph,
  registry,
  model,
  editor,
  onRefused,
}: ConnectionsSectionProps) {
  return (
    <section className={styles.section} aria-label="Connections">
      <div className={styles.sectionHeader}>
        <span>Connections</span>
        <span className={styles.sectionRule} aria-hidden />
      </div>

      {/* §V91: the STATE, named. An empty box leaves the user guessing whether the panel
          is broken or the node is unwired. */}
      {model.total === 0 ? (
        <p className={styles.statusHint}>Nothing is wired to this node.</p>
      ) : null}

      {model.inputs.length === 0 ? null : (
        <div className={rows.side}>
          <div className={rows.sideHeader}>
            <span>In</span>
            <span className={rows.sideRule} aria-hidden />
          </div>
          <InputSide
            nodeId={nodeId}
            graph={graph}
            registry={registry}
            sockets={inputSockets(model)}
            editor={editor}
            {...(onRefused === undefined ? {} : { onRefused })}
          />
        </div>
      )}

      {model.outputs.length === 0 ? null : (
        <div className={rows.side}>
          <div className={rows.sideHeader}>
            <span>Out</span>
            <span className={rows.sideRule} aria-hidden />
          </div>
          {model.outputs.map((group) => (
            <OutputGroupRows key={group.portId} group={group} editor={editor} />
          ))}
        </div>
      )}
    </section>
  );
}

/** What the pointer is carrying: one wire, and the socket it came from. */
interface Held {
  readonly edgeId: EdgeId;
  readonly portId: PortId;
}

function InputSide({
  nodeId,
  graph,
  registry,
  sockets,
  editor,
  onRefused,
}: {
  nodeId: NodeId;
  graph: GraphDocument;
  registry: NodeRegistryView;
  sockets: readonly InputSocket[];
  editor: ParameterEditor;
  onRefused?: (diagnostic: RuntimeDiagnostic) => void;
}) {
  /**
   * State, not just a ref: the empty and spare sockets appear only while something is
   * being dragged, so picking a wire up has to re-render. The ref beside it is what the
   * handlers read — a `dragover` can fire before React has processed the state update, and
   * a gesture that depends on a render having happened is a gesture that drops events.
   */
  const [held, setHeld] = useState<Held | null>(null);
  const heldRef = useRef<Held | null>(null);
  const [over, setOver] = useState<string | null>(null);
  /**
   * The row the keyboard is holding, and the reason this keeps element refs.
   *
   * A reorder moves the row's DOM node, and moving a focused node is enough for a browser
   * to blur it — so the second press of a held ArrowUp would land on nothing and the
   * gesture would silently become one press. jsdom does not reproduce that, which is
   * exactly the §V850 shape: the obvious instrument reports success while the real thing is
   * broken. Focus is RESTORED after the row moves, and the gate blurs the grip on purpose.
   */
  const holding = useRef<EdgeId | null>(null);
  /** The port that keyboard gesture is on, so `endGesture` closes the right transaction. */
  const holdingPortRef = useRef<Held | null>(null);
  const grips = useRef(new Map<EdgeId, HTMLButtonElement>());
  /**
   * A reorder is in flight.
   *
   * `dragover` fires far faster than a patch round-trips, and the index a handler was
   * rendered with is stale the moment the previous patch lands. Sending a second
   * permutation computed from that stale reading is how a drag ends up somewhere nobody
   * aimed at — so the gesture waits for the document to catch up.
   */
  const inFlight = useRef(false);

  useEffect(() => {
    const key = holding.current;
    if (key === null) return;
    const grip = grips.current.get(key);
    if (grip !== undefined && document.activeElement !== grip) grip.focus();
  });

  /** Reorder within one port: the non-destructive, live half. */
  const reorderWithin = (portId: PortId, siblings: readonly ConnectionRow[], from: number, to: number): void => {
    if (inFlight.current) return;
    const next = movedOrder(
      siblings.map((row) => row.edgeId),
      from,
      to,
    );
    if (next === null) return;
    inFlight.current = true;
    void editor.reorderPortEdges(nodeId, portId, next).finally(() => {
      inFlight.current = false;
    });
  };

  /**
   * Re-target: move a wire to a socket on another port.
   *
   * Every decision — compatibility, what the occupant of that socket becomes, which
   * `order` puts the newcomer where the old one was — belongs to `connectDropOperations`,
   * which is the canvas's own. This function contributes the SOURCE of the wire being
   * moved and nothing else.
   */
  const retarget = (edgeId: EdgeId, portId: PortId, slot: number | undefined): void => {
    const edge = graph.edges[edgeId];
    if (edge === undefined) return;
    const drop = connectDropOperations({
      graph,
      registry,
      source: { nodeId: edge.source.nodeId, portId: edge.source.portId },
      target: { nodeId, portId, ...(slot === undefined ? {} : { slot }) },
      moving: edgeId,
    });
    if (drop.kind === "refused") {
      onRefused?.(drop.diagnostic);
      return;
    }
    if (drop.kind === "unchanged") return;
    void editor.retargetConnection(drop.operations, drop.label);
  };

  const endGesture = (): void => {
    // The PORT comes off the ref, not off state: state may not have been re-rendered yet,
    // and closing the wrong port's transaction would leave the real one open — every later
    // reorder on it would silently join this gesture's undo entry.
    const carried = heldRef.current ?? (holding.current === null ? null : holdingPortRef.current);
    heldRef.current = null;
    holding.current = null;
    setHeld(null);
    setOver(null);
    if (carried !== null) editor.endReorderGesture(nodeId, carried.portId);
  };

  const onDragOver = (event: DragEvent<HTMLLIElement>, socket: InputSocket): void => {
    const carried = heldRef.current;
    if (carried === null) return;
    // Claiming the drop is what makes the cursor say "move" instead of "no".
    event.preventDefault();
    setOver(socket.key);
    /*
     * LIVE only within the port. Crossing rows of another port must not rewire anything on
     * the way past — a re-target replaces the socket's occupant, and doing that once per
     * row the pointer travels over would delete connections the user never aimed at.
     */
    if (carried.portId !== socket.portId || socket.row === null || !socket.orderable) return;
    const from = socket.siblings.findIndex((row) => row.edgeId === carried.edgeId);
    const to = socket.siblings.findIndex((row) => row.edgeId === socket.row?.edgeId);
    if (from < 0 || to < 0) return;
    reorderWithin(socket.portId, socket.siblings, from, to);
  };

  const onDrop = (event: DragEvent<HTMLLIElement>, socket: InputSocket): void => {
    event.preventDefault();
    const carried = heldRef.current;
    if (carried !== null && carried.portId !== socket.portId) {
      retarget(carried.edgeId, socket.portId, socket.slot);
    }
    endGesture();
  };

  return (
    <ul className={rows.list}>
      {sockets.map((socket) => {
        // An empty socket is a destination, not a fact about the graph: it is chrome at
        // rest, so it only exists while there is something to drop on it.
        if (socket.row === null && held === null) return null;
        const row = socket.row;
        return (
          <li
            key={socket.key}
            className={cx(
              rows.row,
              over === socket.key && rows.rowTarget,
              row === null && rows.rowEmpty,
            )}
            style={cssVars({ "--row-color": edgeFamilyColor(socket.kind) })}
            data-edge-id={row?.edgeId}
            data-socket={socket.key}
            onDragOver={(event) => onDragOver(event, socket)}
            onDrop={(event) => onDrop(event, socket)}
          >
            {row === null ? (
              <span className={rows.gripSpacer} aria-hidden />
            ) : (
              <button
                type="button"
                className={rows.grip}
                ref={(element) => {
                  if (element === null) grips.current.delete(row.edgeId);
                  else grips.current.set(row.edgeId, element);
                }}
                draggable
                onDragStart={(event) => {
                  const carried = { edgeId: row.edgeId, portId: socket.portId };
                  heldRef.current = carried;
                  setHeld(carried);
                  event.dataTransfer.effectAllowed = "move";
                  event.dataTransfer.setData("text/plain", socket.label);
                }}
                onDragEnd={endGesture}
                onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  event.preventDefault();
                  if (!socket.orderable) return;
                  const from = socket.siblings.findIndex((entry) => entry.edgeId === row.edgeId);
                  if (from < 0) return;
                  holding.current = row.edgeId;
                  holdingPortRef.current = { edgeId: row.edgeId, portId: socket.portId };
                  reorderWithin(
                    socket.portId,
                    socket.siblings,
                    from,
                    from + (event.key === "ArrowUp" ? -1 : 1),
                  );
                }}
                onKeyUp={(event: KeyboardEvent<HTMLButtonElement>) => {
                  if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                  endGesture();
                }}
                /*
                 * Deliberately NOT closed on blur. A blur is not the end of a gesture — the
                 * row moving out from under the held key causes one — and treating it as one
                 * would put every press of a held key in its own undo entry in the browser
                 * while the jsdom gate stayed green. Both real gestures end on an event that
                 * always arrives: a key-up, or a drag-end.
                 */
                aria-label={`Move ${socket.label}`}
                title={socket.orderable ? "Drag or arrow keys to reorder" : "Drag onto another socket"}
              >
                ⠿
              </button>
            )}
            <span className={rows.family} aria-hidden />
            {row === null ? (
              <span className={cx(rows.socket, rows.socketEmpty)}>{socket.label}</span>
            ) : (
              <SocketCell
                nodeId={nodeId}
                graph={graph}
                registry={registry}
                socket={socket}
                row={row}
                onReorder={(to) => {
                  const from = socket.siblings.findIndex((entry) => entry.edgeId === row.edgeId);
                  if (from >= 0) reorderWithin(socket.portId, socket.siblings, from, to);
                }}
                onRetarget={(portId, slot) => retarget(row.edgeId, portId, slot)}
              />
            )}
            {row === null ? null : <RowBody row={row} incoming editor={editor} />}
          </li>
        );
      })}
    </ul>
  );
}

/**
 * The socket a wire lands in, as a CHOICE where there is one to make.
 *
 * A native `<select>` is the keyboard half of re-targeting (§V19) and costs no new
 * control. Where the wire has exactly one place it could be — a node with a single
 * compatible input — the picker would be a control with no choice in it, so the socket is
 * plain text instead.
 */
function SocketCell({
  nodeId,
  graph,
  registry,
  socket,
  row,
  onReorder,
  onRetarget,
}: {
  nodeId: NodeId;
  graph: GraphDocument;
  registry: NodeRegistryView;
  socket: InputSocket;
  row: ConnectionRow;
  onReorder: (to: number) => void;
  onRetarget: (portId: PortId, slot: number | undefined) => void;
}) {
  const choices = socketChoicesFor(graph, registry, nodeId, row.edgeId);
  const current = socket.slot === undefined ? socket.portId : variadicHandleId(socket.portId, socket.slot);
  if (choices.length <= 1) {
    return (
      <span className={rows.socket} title={socket.label}>
        {socket.label}
      </span>
    );
  }
  return (
    <span className={rows.socketPicker}>
      <EnumField
        label={`Socket for the wire from ${row.peerName}`}
        value={current}
        options={[...choices]}
        onChange={(next) => {
          const { portId, slot } = parseHandleId(next);
          // Within its own port this is a REORDER: identity survives, and the order is the
          // thing being edited. Across ports it is a re-target, and a different patch.
          if (portId === socket.portId) onReorder(slot ?? 0);
          else onRetarget(portId, slot);
        }}
      />
    </span>
  );
}

/**
 * Consumers of one output port.
 *
 * No grip and no picker, and deliberately not disabled ones: an output's edges fan out to
 * consumers that each decide their own order and their own socket, so there is no
 * arrangement at this end to offer (§V830 — a control that cannot act is not a control
 * that is greyed out; it is a control that does not exist). The peer's own slot is named
 * on the row, which is where that wire's order actually lives.
 */
function OutputGroupRows({
  group,
  editor,
}: {
  group: ConnectionOutputGroup;
  editor: ParameterEditor;
}) {
  return (
    <ul className={rows.list}>
      {group.rows.map((row) => (
        <li
          key={row.edgeId}
          className={rows.row}
          style={cssVars({ "--row-color": edgeFamilyColor(group.kind) })}
          data-edge-id={row.edgeId}
        >
          <span className={rows.gripSpacer} aria-hidden />
          <span className={rows.family} aria-hidden />
          <span className={rows.socket} title={row.socket}>
            {row.socket}
          </span>
          <RowBody row={row} incoming={false} editor={editor} />
        </li>
      ))}
    </ul>
  );
}

function RowBody({
  row,
  incoming,
  editor,
}: {
  row: ConnectionRow;
  incoming: boolean;
  editor: ParameterEditor;
}) {
  return (
    <>
      <span className={rows.arrow} aria-hidden>
        {incoming ? "←" : "→"}
      </span>
      {/* §B170: the NAME. The id is an address, and the user never typed it. */}
      <span className={rows.peer} title={`${row.peerName} · ${row.peerPort}`}>
        {row.peerName} <span className={rows.peerPort}>{row.peerPort}</span>
      </span>
      <button
        type="button"
        className={rows.drop}
        aria-label={`Disconnect ${row.socket} from ${row.peerName}`}
        onClick={() => void editor.disconnectEdges([row.edgeId])}
      >
        ✕
      </button>
    </>
  );
}
