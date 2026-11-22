import { memo, useEffect, useRef, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent, MouseEvent as ReactMouseEvent } from "react";
import { ViewportPortal, useStoreApi } from "@xyflow/react";
import type { TieId } from "@domain/types/ids.ts";
import type { GraphPatchOperation } from "@domain/types/patch.ts";
import { useGraphCanvas } from "@editor/graph-canvas/canvas-context.ts";
import { EDGE_HIT_TOLERANCE_PX } from "./edge-geometry.ts";
import { joinTieOperations, mergeTiesOperations, moveTieOperations, removeTieOperations } from "./tie-gestures.ts";
import { tiesTouching, type TiePoint } from "./tie-view.ts";
import styles from "./wire-ties.module.css";

/**
 * The wire ties on the canvas, and the gestures on them (T1821b, §V1040; design:
 * docs/wire-ties-design-2026-11-21.md).
 *
 * One dot per tie, above the wires and the nodes — a reroute hidden under a node cannot be
 * grabbed. Its size is in graph units, like the nodes. What a press on it can mean:
 *
 *  - drag: the tie moves; the wires through it follow live through the tie view, and the
 *    document is written once, at the release (§V15);
 *  - drop on another tie: the two merge — how wires are bundled into one strand;
 *  - Shift-drop on a wire: that wire joins the tie (Houdini's pick-up; Shift because Alt
 *    pans on this canvas, B195);
 *  - double-click: the tie goes, and every wire through it runs as it would without it.
 *
 * Each is one patch through `apply` — the canvas's `graph.applyPatch` door — so each is one
 * undo step. A tie is made by double-clicking a wire or the edge menu's "Add tie", both
 * `graph.rerouteEdge`, which the canvas owns.
 *
 * T1821b(c): a box selection takes the ties it touches, as Houdini's takes network dots —
 * the library's Shift-drag box is read here, off its store, and the right-drag box in
 * `right-drag-select.tsx`. A selected tie is drawn ringed and moves with the selected nodes
 * (`graph-canvas.tsx`); any other change of the node selection, or a click on the empty
 * canvas, lets it go.
 */

/** The dot, and the invisible ring around it that takes the press, in graph units. */
export const TIE_DOT_RADIUS = 4.5;
const TIE_HIT_RADIUS = 11;
/** How near another tie a dropped one must land to merge into it, in screen pixels. */
const MERGE_RADIUS_PX = 14;
/** A press that moves less than this, in screen pixels, is a click, not a drag. */
const DRAG_THRESHOLD_PX = 3;

interface Gesture {
  readonly tieId: TieId;
  readonly pointerId: number;
  readonly startClient: TiePoint;
  readonly startAt: TiePoint;
  readonly zoom: number;
  moved: boolean;
  at: TiePoint;
}

export const WireTies = memo(function WireTies({
  colors,
  apply,
}: {
  /** The colour each tie's dot is drawn in: the hue of the first wire through it (§V26). */
  readonly colors: ReadonlyMap<TieId, string>;
  /** The canvas's `graph.applyPatch` door; resolves whether the patch applied. */
  readonly apply: (operations: GraphPatchOperation[], label: string) => Promise<boolean>;
}) {
  const { ties, store, edgeGeometry } = useGraphCanvas();
  const api = useStoreApi();
  // Renders when a tie moves (the view's version), and reads the view then.
  useSyncExternalStore(ties.subscribe, ties.version);
  const drawn = ties.all();
  const selected = ties.selection();
  const gesture = useRef<Gesture | null>(null);

  // T1821b(c): the library's own box (Shift-drag) takes the ties it touches, live, as it
  // takes the nodes. It always starts a fresh selection, so the box's ties replace the last.
  useEffect(
    () =>
      api.subscribe((state, previous) => {
        const rect = state.userSelectionRect;
        if (rect === previous.userSelectionRect || rect === null || !state.userSelectionActive) return;
        const [x, y, zoom] = state.transform;
        const area = { x: (rect.x - x) / zoom, y: (rect.y - y) / zoom, width: rect.width / zoom, height: rect.height / zoom };
        ties.select(tiesTouching(ties, area, TIE_DOT_RADIUS));
      }),
    [api, ties],
  );

  const finish = (operations: GraphPatchOperation[], label: string): void => {
    if (operations.length === 0) {
      ties.setDrag(null);
      return;
    }
    // Drawn where it was let go until the document agrees, so the wires do not flash back.
    ties.release();
    void apply(operations, label).then((applied) => {
      if (!applied) ties.setDrag(null);
    });
  };

  const onPointerDown = (event: ReactPointerEvent<SVGCircleElement>, tieId: TieId, at: TiePoint): void => {
    if (event.button !== 0) return;
    // The press is the tie's: not a pan, not a box selection, not a node drag.
    event.stopPropagation();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const zoom = api.getState().transform[2];
    gesture.current = {
      tieId,
      pointerId: event.pointerId,
      startClient: { x: event.clientX, y: event.clientY },
      startAt: at,
      zoom: zoom > 0 ? zoom : 1,
      moved: false,
      at,
    };
  };

  const onPointerMove = (event: ReactPointerEvent<SVGCircleElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startClient.x;
    const dy = event.clientY - current.startClient.y;
    if (!current.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
    current.moved = true;
    current.at = { x: current.startAt.x + dx / current.zoom, y: current.startAt.y + dy / current.zoom };
    ties.setDrag({ tieId: current.tieId, position: current.at });
  };

  const onPointerUp = (event: ReactPointerEvent<SVGCircleElement>): void => {
    const current = gesture.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    gesture.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    if (!current.moved) return;
    const graph = store.getGraph();
    const { tieId, at, zoom } = current;

    const under = ties
      .all()
      .find((other) => other.id !== tieId && Math.hypot(other.position.x - at.x, other.position.y - at.y) <= MERGE_RADIUS_PX / zoom);
    if (under !== undefined) {
      finish(mergeTiesOperations(graph, tieId, under.id), "Merge ties");
      return;
    }
    if (event.shiftKey) {
      const hit = edgeGeometry.hit(at, EDGE_HIT_TOLERANCE_PX / zoom, (edgeId) => graph.edges[edgeId]?.via?.includes(tieId) === true);
      if (hit !== null) {
        finish(joinTieOperations(graph, tieId, hit.edgeId, hit.segment, at), "Tie wires");
        return;
      }
    }
    finish(moveTieOperations(graph, tieId, at), "Move tie");
  };

  const onPointerCancel = (): void => {
    if (gesture.current === null) return;
    gesture.current = null;
    ties.setDrag(null);
  };

  const onDoubleClick = (event: ReactMouseEvent<SVGCircleElement>, tieId: TieId): void => {
    // Not the canvas's: a double-click on the background opens the node browser.
    event.stopPropagation();
    const operations = removeTieOperations(store.getGraph(), tieId);
    if (operations.length > 0) void apply(operations, "Remove tie");
  };

  if (drawn.length === 0) return null;
  const xs = drawn.map((tie) => tie.position.x);
  const ys = drawn.map((tie) => tie.position.y);
  const box = {
    x: Math.min(...xs) - TIE_HIT_RADIUS,
    y: Math.min(...ys) - TIE_HIT_RADIUS,
    width: Math.max(...xs) - Math.min(...xs) + 2 * TIE_HIT_RADIUS,
    height: Math.max(...ys) - Math.min(...ys) + 2 * TIE_HIT_RADIUS,
  };

  return (
    <ViewportPortal>
      <svg
        className={styles.layer}
        // Sized and placed from what it draws, with a matching viewBox: an outermost svg with
        // an empty viewport paints nothing (B47, `reference-lines.tsx`).
        style={{ left: box.x, top: box.y, width: box.width, height: box.height }}
        viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
        data-testid="wire-ties"
      >
        {drawn.map((tie) => (
          <g
            key={tie.id}
            data-testid={`wire-tie-${tie.id}`}
            data-x={tie.position.x}
            data-y={tie.position.y}
            data-selected={selected.has(tie.id) ? "" : undefined}
          >
            <title>Tie — drag to move, drop on another tie to merge, Shift-drop on a wire to add it, double-click to remove</title>
            <circle
              className={selected.has(tie.id) ? `${styles.dot} ${styles.selected}` : styles.dot}
              cx={tie.position.x}
              cy={tie.position.y}
              r={TIE_DOT_RADIUS}
              style={{ fill: colors.get(tie.id) ?? "var(--text-dim)" }}
            />
            <circle
              // `nopan nodrag`: React Flow's own markers for "this press is not the canvas's".
              className={`${styles.hit} nopan nodrag`}
              cx={tie.position.x}
              cy={tie.position.y}
              r={TIE_HIT_RADIUS}
              data-testid={`wire-tie-hit-${tie.id}`}
              onPointerDown={(event) => onPointerDown(event, tie.id, tie.position)}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerCancel}
              onDoubleClick={(event) => onDoubleClick(event, tie.id)}
            />
          </g>
        ))}
      </svg>
    </ViewportPortal>
  );
});
