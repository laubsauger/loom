import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { useReactFlow } from "@xyflow/react";
import type { NodeId } from "@domain/types/ids.ts";
import { useNodeRuntime } from "@editor/graph-canvas/index.ts";
import type { NodeRuntimeSource } from "@editor/graph-canvas/index.ts";
import { DEFAULT_PREVIEW_LENS } from "@runtime/previews/index.ts";
import { cx } from "@ui/cx.ts";
import { NodePreview } from "./node-preview.tsx";
import type { PreviewOrbitStore } from "./preview-orbit-store.ts";
import type { PreviewSlotBoundsStore } from "./preview-slot-bounds.ts";
import type { PreviewViewSource } from "./preview-view-store.ts";
import styles from "./viewer.module.css";

/**
 * The composition root's `renderPreview` implementation for one node (T185).
 *
 * `NodeView` (`src/editor/nodes/`) knows nothing about the preview system — it only
 * calls `renderPreview(nodeId)` and renders whatever comes back — so this is where that
 * indirection is filled in. Two jobs, both per-node:
 *
 *  - measure this slot's offset and size WITHIN ITS OWN NODE, once on mount and again on
 *    resize, and publish that (§V111: never the slot's absolute screen rect, and never
 *    on a per-frame tick — that is the forced-layout-during-pan mistake design note §2
 *    warns about, and `slotScreenRect` exists so nobody has to). The offset is relative
 *    to `.react-flow__node`, react-flow's own wrapper, which moves with the node during
 *    an uncommitted drag — so the offset itself needs no re-measurement while dragging,
 *    only the LIVE node position added on top of it does (§V112, done by the reader in
 *    `use-node-previews.ts`, never here);
 *  - show whatever the preview scheduler most recently classified this node as, via its
 *    own slice of the runtime channel (§V16) — only this node repaints when its own
 *    preview state changes, exactly like `NodeView` itself.
 */
export interface NodePreviewSlotProps {
  nodeId: NodeId;
  runtime: NodeRuntimeSource;
  bounds: PreviewSlotBoundsStore;
  /**
   * The lens store (T336). Optional so a caller that wants a plain slot — a test, an
   * embedding — is not forced to wire one; absent means every preview is the plain picture.
   */
  views?: PreviewViewSource | undefined;
  /**
   * T561/T656: the pane's inspection store, plus whether THIS node's preview is a
   * synthesized 3D picture at all (the compiler marks orbitable outputs; a texture
   * preview has nothing to orbit, and a CAMERA payload draws through its own matrix so
   * an override would falsify the one thing its tile exists to show — §T614). Both keep
   * their plain pointer behaviour and are never offered the mode toggle.
   */
  orbits?: PreviewOrbitStore | undefined;
  orbitable?: boolean;
}

/**
 * T561: radians per CSS px, chosen so a full sweep across a 192px tile is about a half
 * turn — the whole object inspectable in one gesture.
 */
const RADIANS_PER_PX = 0.016;
/** T656: stock radii per CSS px — a full sweep across the tile pans about one radius. */
const RADII_PER_PX = 0.005;
/**
 * T656: how hard the wheel bites. One 100-unit notch is e^0.15 ≈ 1.16×, so the clamped
 * 0.2…5 range is about twenty notches end to end — findable, and not a hair trigger.
 */
const ZOOM_PER_DELTA = 0.0015;
/** A wheel reporting LINES or PAGES rather than pixels, normalized to pixels. */
const DELTA_MODE_SCALE = [1, 16, 100] as const;

export function NodePreviewSlot({ nodeId, runtime, bounds, views, orbits, orbitable = false }: NodePreviewSlotProps) {
  const flow = useReactFlow();
  const ref = useRef<HTMLDivElement | null>(null);

  /**
   * T656 — the MODE. `home` is the stock framing and no interaction; `adjustable` means
   * the preview owns the gestures. The toggle below is both the affordance and the
   * indicator (T613 closed the badge question with it), so this one piece of inspection
   * state does re-render, unlike the orbit itself which the preview tick samples.
   */
  const readMode = useCallback(
    () => (orbits === undefined ? "home" : orbits.mode(nodeId)),
    [orbits, nodeId],
  );
  const mode = useSyncExternalStore(
    useCallback(
      (listener: () => void) => orbits?.subscribe(nodeId, listener) ?? (() => {}),
      [orbits, nodeId],
    ),
    readMode,
    readMode,
  );
  const adjustable = orbitable && orbits !== undefined && mode === "adjustable";

  /**
   * T561/T656: the inspection gestures, live ONLY in adjustable mode.
   *
   * Plain drag orbits (T561, unchanged). ALT-drag pans, and alt is the choice because it
   * is the one modifier React Flow has not already claimed: shift is `selectionKeyCode`,
   * meta is `multiSelectionKeyCode`, ctrl is `zoomActivationKeyCode` and the macOS
   * context-menu chord, space is `panActivationKeyCode`. Middle-drag would be the other
   * convention and is deliberately NOT wired: a Mac trackpad has no middle button, so it
   * would be an affordance half the users cannot perform.
   *
   * The gesture arrives uncontested: the slot carries `nodrag`/`nopan` and the node view
   * stops pointer-press propagation (§V20), so nothing here fights React Flow. All of it
   * is VIEW STATE — the store makes no document revision and the preview tick samples it
   * per frame, so a gesture repaints the tile and re-renders nothing.
   */
  const drag = useRef<{ pointerId: number; x: number; y: number; pan: boolean } | null>(null);
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!adjustable || event.button !== 0) return;
      drag.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        pan: event.altKey,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [adjustable],
  );
  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const active = drag.current;
      if (active === null || active.pointerId !== event.pointerId || orbits === undefined) return;
      const dx = event.clientX - active.x;
      const dy = event.clientY - active.y;
      orbits.apply(
        nodeId,
        active.pan
          ? // The camera follows the drag, the same convention the orbit already uses:
            // drag right and the eye AND look-at slide right, so the object goes left.
            { panX: dx * RADII_PER_PX, panY: -dy * RADII_PER_PX }
          : // Drag right walks the camera rightward around the object; drag up raises it.
            { azimuth: dx * RADIANS_PER_PX, elevation: -dy * RADIANS_PER_PX },
      );
      active.x = event.clientX;
      active.y = event.clientY;
    },
    [nodeId, orbits],
  );
  const onPointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId === event.pointerId) drag.current = null;
  }, []);

  /**
   * T656 — the wheel, and the reason T561 could not ship zoom.
   *
   * T561 stopped here saying "the wheel fights the canvas zoom". The MODE dissolves that:
   * in adjustable mode the preview OWNS the wheel and the canvas never sees it, and in
   * home mode this listener is not attached at all, so the event reaches React Flow
   * exactly as it does today. `nowheel` is React Flow's own opt-out and is applied on the
   * same condition; `stopPropagation` on a NON-PASSIVE native listener is the load-bearing
   * half, because d3-zoom listens on an ancestor with a native listener that React's
   * synthetic (passive) `onWheel` could neither stop nor `preventDefault`.
   *
   * The zoom itself writes T561's EXISTING `distance` delta — the same field, clamp and
   * `orbitPose` the orbit already used. There is no second distance path.
   */
  useEffect(() => {
    const element = ref.current;
    if (element === null || !adjustable || orbits === undefined) return;
    const onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      event.stopPropagation();
      const scale = DELTA_MODE_SCALE[event.deltaMode] ?? 1;
      // Scroll away from you (deltaY < 0) moves in; the exponential keeps a notch worth
      // the same proportion of the picture at every distance.
      orbits.zoom(nodeId, Math.exp(event.deltaY * scale * ZOOM_PER_DELTA));
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [adjustable, nodeId, orbits]);

  const toggleMode = useCallback(() => {
    orbits?.setMode(nodeId, mode === "adjustable" ? "home" : "adjustable");
  }, [orbits, nodeId, mode]);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;

    const measure = (): void => {
      const nodeElement = element.closest(".react-flow__node");
      if (nodeElement === null) return;
      const slotRect = element.getBoundingClientRect();
      const nodeRect = nodeElement.getBoundingClientRect();
      const zoom = flow.getViewport().zoom;
      if (!(zoom > 0) || slotRect.width <= 0 || slotRect.height <= 0) return;
      // A rect DELTA between two elements measured at the same instant cancels pan
      // entirely, so only zoom converts screen px to the node's own local (graph-space)
      // px — this offset stays correct at any pan and needs no re-measurement for one.
      bounds.publish(nodeId, {
        x: (slotRect.left - nodeRect.left) / zoom,
        y: (slotRect.top - nodeRect.top) / zoom,
        width: slotRect.width / zoom,
        height: slotRect.height / zoom,
      });
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => {
      observer.disconnect();
      bounds.clear(nodeId);
    };
  }, [bounds, flow, nodeId]);

  const snapshot = useNodeRuntime(runtime, nodeId);
  const preview = snapshot.preview;

  // Its own slice, like the runtime channel above: setting a lens on one node repaints that
  // node's slot and nothing else, and the store only notifies when a lens actually changed.
  const readLens = useCallback(
    () => (views === undefined ? DEFAULT_PREVIEW_LENS : views.get(nodeId)),
    [views, nodeId],
  );
  const lens = useSyncExternalStore(
    useCallback(
      (listener: () => void) => views?.subscribe(nodeId, listener) ?? (() => {}),
      [views, nodeId],
    ),
    readLens,
    readLens,
  );

  return (
    <div
      ref={ref}
      // `nowheel` ONLY while adjustable: in home mode the wheel must reach the canvas and
      // zoom the graph exactly as it does today (§V461 — the mode has to turn OFF).
      className={cx(styles.inspectHost, adjustable ? "nowheel" : undefined)}
      data-inspect={orbitable ? mode : undefined}
      style={adjustable ? { cursor: "grab", touchAction: "none" } : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {/*
        T613/T656 — the toggle IS the affordance and the indicator, so there is no second
        badge. Offered only where an orbit is (pointset and geometry syntheses): a texture
        preview has no camera, and a CAMERA payload's tile draws through the payload's own
        matrix, so offering to override it would be an affordance that lies (§T639(a)).
      */}
      {orbitable && orbits !== undefined ? (
        <button
          type="button"
          className={cx(styles.inspectToggle, "nodrag", "nopan")}
          data-testid={`preview-inspect-${nodeId}`}
          data-mode={mode}
          aria-pressed={mode === "adjustable"}
          aria-label="Adjust this preview's camera"
          // Labels, not prose (§V90/§V91): the copy guard caps chrome strings at a
          // phrase, and what the gestures ARE belongs in the help surface, not here.
          title={
            mode === "adjustable"
              ? "Adjusting — press to return to the stock framing"
              : "Adjust this preview's camera — orbit, zoom, pan"
          }
          // The press is the toggle's own; it must not also start an orbit drag.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={toggleMode}
        >
          {mode === "adjustable" ? "ADJUST" : "HOME"}
        </button>
      ) : null}
      {preview === null ? (
        /**
         * §V303 — a slot with nothing published still has to COVER.
         *
         * The live slot is a hole through the node chrome and the shared surface
         * composites the tile behind it; a canvas keeps its last presented pixels, so an
         * empty `<div>` here is a window onto whatever was drawn in that spot last. That
         * is the "shown anyway, just not updating" report: a frozen picture that reads as
         * a live one. `NodePreview`'s opaque background is the cover, and the ONLY
         * transparent case is `live`, so the rule holds with no exceptions.
         */
        <NodePreview output={{ nodeId, portId: "" }} state={{ kind: "idle" }} lens={lens} />
      ) : (
        <NodePreview
          output={preview.output}
          state={preview.state}
          facts={preview.facts}
          lens={lens}
        />
      )}
    </div>
  );
}
