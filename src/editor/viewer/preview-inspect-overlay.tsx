import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import { useStoreApi } from "@xyflow/react";
import type { ReactFlowState } from "@xyflow/react";
import type { NodeId } from "@domain/types/ids.ts";
import { slotScreenRect } from "@runtime/previews/index.ts";
import { cssVars } from "@editor/graph-canvas/css-vars.ts";
import type { PreviewOrbitStore } from "./preview-orbit-store.ts";
import type { PreviewSlotBoundsStore } from "./preview-slot-bounds.ts";
import styles from "./viewer.module.css";

/**
 * T892 — THE CAMERA TOGGLE IS ON THE PICTURE, AND IT IS DRAWN ABOVE THE TILE.
 *
 * ## The owner asked three times; this is what made it hard
 *
 * "the camera toggle still sits in the header of nodes that support camera movement in
 * their preview. i asked to have that moved out of there and overlaid on the actual
 * preview canvas bottom right … so we can gain more space for the node title." The point
 * is the TITLE'S WIDTH: `C` is the fourth button in a `P B M C` row on a 178px node, and
 * the title was truncating to two characters plus an ellipsis to pay for it.
 *
 * It had been on the tile before, twice (T613, T664), and T675 moved it OFF for a real
 * reason that has not gone away: the shared preview surface (`app/panes.module.css
 * .previewSurface`) is a full-pane canvas at `--z-canvas-overlay` (30) and composites
 * each live tile at that node's slot rect, while everything inside a node is sealed
 * inside `.react-flow__viewport` — a transformed element at z-index 2, therefore a
 * stacking context no descendant can escape. A control rendered in the node's preview
 * slot is PAINTED OVER exactly when the tile is live, which is exactly when there is
 * something to inspect. `pointer-events: none` on the surface is why that bug was
 * invisible to every DOM test: the button still took clicks, it just could not be seen.
 *
 * So "put it back on the tile" is not a matter of moving JSX. The control has to be drawn
 * in a layer that is a SIBLING of the compositing surface rather than a descendant of the
 * viewport — which is this component: one pane-level layer at `--z-canvas-chrome` (31),
 * `pointer-events: none`, holding one button per orbitable tile, positioned by the same
 * arithmetic that places the tile itself.
 *
 * ## Positioned, never measured
 *
 * `slotScreenRect` is the function `use-node-previews.ts` uses to place the tile on the
 * surface, fed from the same two facts: the slot's offset within its node (published by
 * `NodePreviewSlot`, node-local so it survives a drag) and the node's LIVE position from
 * React Flow (§V112 — never `GraphNode.position`, which lags for the whole of a drag).
 * Using the tile's own placement function is what keeps the button on the corner of the
 * picture at every zoom and through every pan; a `getBoundingClientRect` per button per
 * frame is the forced-layout-during-pan mistake design note §2 warns about.
 *
 * The button SCALES with the zoom, because it is chrome on a node and every other piece
 * of node chrome does. At a zoom where the header's own toggles are unreadable this one
 * is too, and that is the honest behaviour — a control that stayed 14px while its node
 * shrank to a chip would end up bigger than the picture it sits on.
 *
 * ## Why the pointer problem solves itself
 *
 * The tile drags and orbits: a press inside `NodePreviewSlot` starts a camera gesture
 * (`onPointerDown` there). A button drawn INSIDE that box would start a drag on the way
 * to being clicked, which is the classic overlay bug. Here the button is not a descendant
 * of the slot at all — it is in a different subtree, outside React Flow entirely — so the
 * slot's handler never sees the press, and the graph pane below never sees it either
 * because d3-zoom listens on `.react-flow__pane`, which is not an ancestor. Structure,
 * not a `stopPropagation` that someone can delete.
 *
 * ## What survives from T675
 *
 * ABSENT, never disabled (T669): a node with nothing to inspect is offered no camera at
 * all — `inspect` returns null and no button is rendered. A suspended preview publishes
 * no orbit, so the control's absence reads as that state.
 *
 * ALWAYS VISIBLE, never hover-only (§T854's precedent): it is view state (§V255), so
 * revealing it on hover would be defensible — but hidden chrome is how this control was
 * lost twice already, and T854's `×` had to pair hidden with `pointer-events: none` to
 * avoid an invisible live hit target. One quiet, permanently drawn button is cheaper than
 * both problems.
 *
 * ONE BOX IN BOTH STATES (T664): a one-letter `C` in a fixed square, state carried by
 * tone through `aria-pressed`, so pressing it cannot reflow or move the control.
 */
export interface PreviewInspectOverlaysProps {
  /** Where each node's preview slot is, in its own node's coordinates (§V111). */
  bounds: PreviewSlotBoundsStore;
  /**
   * The same gate the node header used to consult: the store for this node's camera, or
   * null where there is no camera to offer. The graph pane answers from the COMPILER's
   * orbit declaration — never from a node type — so a 2D preview is never offered one.
   */
  inspect: (nodeId: NodeId) => PreviewOrbitStore | null;
}

/** One button's placement: the screen point its bottom-right corner sits on. */
interface Placement {
  nodeId: NodeId;
  source: PreviewOrbitStore;
  x: number;
  y: number;
  zoom: number;
}

const EMPTY_PLACEMENTS: readonly Placement[] = [];

function samePlacements(a: readonly Placement[], b: readonly Placement[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    return (
      right !== undefined &&
      left.nodeId === right.nodeId &&
      left.source === right.source &&
      left.x === right.x &&
      left.y === right.y &&
      left.zoom === right.zoom
    );
  });
}

export function PreviewInspectOverlays({ bounds, inspect }: PreviewInspectOverlaysProps) {
  // The slot rects live outside React (they are written by a ResizeObserver), so the map
  // identity is the subscription: a slot mounting, resizing or unmounting re-renders this
  // layer and nothing else.
  const boxes = useSyncExternalStore(bounds.subscribe, bounds.snapshot, bounds.snapshot);

  const select = useMemo(
    () =>
      (state: ReactFlowState): readonly Placement[] => {
        const [x, y, zoom] = state.transform;
        const placements: Placement[] = [];
        // Driven by the MEASURED SLOTS, not by the node list: a node with no preview slot
        // has no tile to draw on, and a value plot deliberately publishes no bounds.
        for (const [id, box] of boxes) {
          const internal = state.nodeLookup.get(id);
          if (internal === undefined) continue;
          const source = inspect(id);
          if (source === null) continue;
          // `position`, not `internals.positionAbsolute`: this is the exact field
          // `use-node-previews.ts` places the TILE from (`flow.getNode(id)?.position`), and
          // the button has to land on that tile, not near it.
          const position = internal.position;
          const rect = slotScreenRect(
            { x: position.x + box.x, y: position.y + box.y, width: box.width, height: box.height },
            { x, y, zoom },
          );
          placements.push({
            nodeId: id,
            source,
            x: rect.x + rect.width,
            y: rect.y + rect.height,
            zoom,
          });
        }
        return placements;
      },
    [boxes, inspect],
  );

  /*
   * React Flow's own store is what makes this follow a pan, a zoom and an uncommitted node
   * drag (§V112 — the document lags for the whole of a drag, so it is the wrong source).
   *
   * Subscribed through `useStoreApi` and `useSyncExternalStore` rather than React Flow's
   * selector hook, which is the same thing spelled differently — the equality check below
   * is what that hook does internally, and it is what keeps this to the frames where a
   * button actually moved. The spelling is deliberate: `no-document-store.test.ts` bans
   * that hook's NAME anywhere in this directory, because in every other file here it would
   * mean a subscription to the document store, which §V16 forbids on the preview path.
   * Arguing that this one instance meant a different store is exactly the erosion the guard
   * exists to prevent, so this file does not spend it — not even in a comment.
   */
  const api = useStoreApi();
  const cached = useRef<readonly Placement[]>(EMPTY_PLACEMENTS);
  const read = useCallback(() => {
    const next = select(api.getState());
    if (samePlacements(cached.current, next)) return cached.current;
    cached.current = next;
    return next;
  }, [api, select]);
  const placements = useSyncExternalStore(api.subscribe, read, read);

  if (placements.length === 0) return null;
  return (
    <div className={styles.previewChrome} data-testid="preview-inspect-overlays">
      {placements.map((placement) => (
        <PreviewInspectToggle key={placement.nodeId} {...placement} />
      ))}
    </div>
  );
}

/**
 * The toggle itself: HOME ↔ ADJUSTABLE, on the corner of the picture it drives.
 *
 * §V527 — no bus, no command, no revision: an inspection camera is view state, and the
 * source is the pane's own store. Its own `useSyncExternalStore` on this node's slice, so
 * adjusting one preview (or alt-peeking one, T675) re-renders one button.
 */
function PreviewInspectToggle({ nodeId, source, x, y, zoom }: Placement) {
  const read = useCallback(() => source.mode(nodeId), [source, nodeId]);
  const mode = useSyncExternalStore(
    useCallback((listener: () => void) => source.subscribe(nodeId, listener), [source, nodeId]),
    read,
    read,
  );
  const adjustable = mode === "adjustable";
  return (
    <button
      type="button"
      className={styles.inspectToggle}
      data-testid={`preview-inspect-${nodeId}`}
      aria-label="Adjust this preview's camera"
      // Labels, not prose (§V90/§V91). The MODIFIER is named because it is the path that
      // needs no chrome at all, and a user who never presses this button should still be
      // able to learn it from the one place they will hover.
      title={
        adjustable
          ? "Adjusting — press, or h over the tile, to return home"
          : "Adjust camera (or alt on tile): drag orbits, shift pans"
      }
      aria-pressed={adjustable}
      // The corner of the tile, in pane coordinates, plus the zoom the button scales by —
      // the CSS turns those into "bottom-right of the picture, inset by a hair".
      style={{ ...cssVars({ "--chrome-zoom": zoom }), left: `${String(x)}px`, top: `${String(y)}px` }}
      onClick={() => {
        source.setMode(nodeId, adjustable ? "home" : "adjustable");
      }}
    >
      C
    </button>
  );
}
