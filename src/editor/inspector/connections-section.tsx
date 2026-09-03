import { useEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent } from "react";
import type { EdgeId, NodeId } from "@domain/types/ids.ts";
import { cx } from "@ui/cx.ts";
import type { ParameterEditor } from "./parameter-editor.ts";
import { movedOrder } from "./connections.ts";
import type { ConnectionInputGroup, ConnectionModel, ConnectionOutputGroup, ConnectionRow } from "./connections.ts";
import styles from "./inspector.module.css";
import rows from "./connections.module.css";

/**
 * The CONNECTIONS view on the node Common page (T1049) — TD's connections overview.
 *
 * What is connected to this node, in and out, named by the node at the other end; the
 * input side reorderable by drag AND by keyboard, both sides disconnectable. It lives on
 * COMMON at the owner's instruction — "in the Common page, to keep Parameters clean".
 *
 * The row model, and the reasoning for why in and out are different lists, is in
 * `connections.ts`. This file is the gesture and nothing else.
 *
 * ## Every write goes through the bus (§V29)
 *
 * `ParameterEditor` is the inspector's one bus adapter, so a reorder here is the same
 * `graph.applyPatch` an agent would send: audited, revision-checked, undoable. There is no
 * local order state to fall out of step with the document — the rows are rendered FROM the
 * document, and a gesture that has not landed yet has not moved anything.
 *
 * ## One gesture is one undo entry (§V15)
 *
 * A reorder is emitted per position CROSSED, not once on release, because layer order is
 * the operation and the point is watching the picture restack while you drag. Every one of
 * those patches shares the gesture's transaction, so undo after a three-row drag lands on
 * the order the drag started from in one step — the shape `label-drag.ts` established for
 * a held arrow key, applied to a discrete gesture.
 *
 * ## The keyboard is not an afterthought (§V19)
 *
 * The grip is a real button: focus it and ArrowUp / ArrowDown move the row, live on
 * keydown, and the gesture closes on keyup — so a held repeat is still one undo entry. A
 * reorder that only worked under a pointer would be half a feature, and the semantics it
 * edits are not decoration.
 */

export interface ConnectionsSectionProps {
  nodeId: NodeId;
  model: ConnectionModel;
  editor: ParameterEditor;
}

export function ConnectionsSection({ nodeId, model, editor }: ConnectionsSectionProps) {
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
          {model.inputs.map((group) => (
            <InputGroupRows key={group.portId} nodeId={nodeId} group={group} editor={editor} />
          ))}
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

function InputGroupRows({
  nodeId,
  group,
  editor,
}: {
  nodeId: NodeId;
  group: ConnectionInputGroup;
  editor: ParameterEditor;
}) {
  const edgeIds = group.rows.map((row) => row.edgeId);
  /** The row under the pointer, so the drop target is visible before release. */
  const [over, setOver] = useState<EdgeId | null>(null);
  const dragging = useRef<EdgeId | null>(null);
  /**
   * A reorder is in flight.
   *
   * `dragover` fires far faster than a patch round-trips, and the index a handler was
   * rendered with is stale the moment the previous patch lands. Sending a second
   * permutation computed from that stale reading is how a drag ends up somewhere nobody
   * aimed at — so the gesture waits for the document to catch up. Crossings are a handful
   * per drag and key repeat is ~30 Hz, so nothing the user does is dropped in practice.
   */
  const inFlight = useRef(false);
  /**
   * THE ROW THE KEYBOARD IS HOLDING, and the reason this component keeps element refs.
   *
   * A reorder moves the row's DOM node, and moving a focused node is enough for a browser
   * to blur it — so the second press of a held ArrowUp would land on nothing, and the
   * gesture would silently become one press. jsdom does not reproduce that (it keeps focus
   * across a move), which is exactly the §V850 shape: the obvious instrument reports
   * success while the real thing is broken. So focus is RESTORED after the row moves,
   * for as long as the key is down, and the gate blurs the grip on purpose to prove it.
   */
  const holding = useRef<EdgeId | null>(null);
  const grips = useRef(new Map<EdgeId, HTMLButtonElement>());

  useEffect(() => {
    const held = holding.current;
    if (held === null) return;
    const grip = grips.current.get(held);
    if (grip !== undefined && document.activeElement !== grip) grip.focus();
  });

  const move = (from: number, to: number): void => {
    if (inFlight.current) return;
    const next = movedOrder(edgeIds, from, to);
    if (next === null) return;
    inFlight.current = true;
    void editor.reorderPortEdges(nodeId, group.portId, next).finally(() => {
      inFlight.current = false;
    });
  };

  const endGesture = (): void => {
    dragging.current = null;
    holding.current = null;
    setOver(null);
    editor.endReorderGesture(nodeId, group.portId);
  };

  const onDragOver = (event: DragEvent<HTMLLIElement>, index: number): void => {
    const held = dragging.current;
    if (held === null) return;
    // Claiming the drop is what makes the cursor say "move" instead of "no".
    event.preventDefault();
    const row = group.rows[index];
    setOver(row?.edgeId ?? null);
    const from = edgeIds.indexOf(held);
    if (from < 0) return;
    move(from, index);
  };

  return (
    <ul className={rows.list}>
      {group.rows.map((row, index) => (
        <li
          key={row.edgeId}
          className={cx(rows.row, over === row.edgeId && rows.rowTarget)}
          data-edge-id={row.edgeId}
          data-slot={index}
          {...(group.orderable
            ? {
                onDragOver: (event: DragEvent<HTMLLIElement>) => onDragOver(event, index),
                onDrop: (event: DragEvent<HTMLLIElement>) => {
                  event.preventDefault();
                  endGesture();
                },
              }
            : {})}
        >
          {group.orderable ? (
            <button
              type="button"
              className={rows.grip}
              ref={(element) => {
                if (element === null) grips.current.delete(row.edgeId);
                else grips.current.set(row.edgeId, element);
              }}
              draggable
              onDragStart={(event) => {
                dragging.current = row.edgeId;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", row.socket);
              }}
              onDragEnd={endGesture}
              onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                holding.current = row.edgeId;
                move(index, index + (event.key === "ArrowUp" ? -1 : 1));
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
              aria-label={`Reorder ${row.socket}, ${String(index + 1)} of ${String(group.rows.length)}`}
              title="Drag or arrow keys to reorder"
            >
              ⠿
            </button>
          ) : (
            <span className={rows.gripSpacer} aria-hidden />
          )}
          <RowBody row={row} incoming editor={editor} />
        </li>
      ))}
    </ul>
  );
}

/**
 * Consumers of one output port.
 *
 * No grip, and deliberately not a disabled one: an output's edges fan out to consumers
 * that each decide their own order, so there is no arrangement at this end to offer
 * (§V830 — a control that cannot act is not a control that is greyed out; it is a control
 * that does not exist). The peer's own slot is still named on the row, which is where that
 * wire's order actually lives and where it can be changed.
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
        <li key={row.edgeId} className={rows.row} data-edge-id={row.edgeId}>
          <span className={rows.gripSpacer} aria-hidden />
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
      <span className={rows.socket} title={row.socket}>
        {row.socket}
      </span>
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
