import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";
import { useStoreApi } from "@xyflow/react";
import type { ReactFlowState } from "@xyflow/react";
import type { NodeId } from "@domain/types/ids.ts";
import { fitInsideRegion } from "@editor/nodes/preview-fit.ts";
import { cssVars } from "@editor/graph-canvas/css-vars.ts";
import { slotScreenRect } from "@runtime/previews/index.ts";
import type { OrbitCameraBasis, PreviewOrbit } from "@runtime/previews/index.ts";
import { handleScreenPoint, pointerToPlane, tileCamera } from "./gizmo-projection.ts";
import type { PictureRect, TileCamera } from "./gizmo-projection.ts";
import type { GizmoHandle, Vec3GizmoStore } from "./vec3-gizmo-store.ts";
import type { PreviewSlotBoundsStore } from "./preview-slot-bounds.ts";
import styles from "./viewer.module.css";

/**
 * T935 — THE HANDLES, DRAWN ON THE PICTURE THEY BELONG TO.
 *
 * ## The host, and why the viewer pane is not one yet
 *
 * §V633 is structural and it decides this file's shape: `.react-flow__viewport` is a
 * transformed element at z-index 2 and therefore a stacking context, while the shared
 * preview surface composites every live tile at 30 — so anything drawn inside a node's
 * preview slot is painted over exactly when the tile is live, which is exactly when there
 * is something to point at. §T892 already solved this once for the camera toggle: a
 * PANE-LEVEL layer that is a SIBLING of the compositing surface, at `--z-canvas-chrome`
 * (31), `pointer-events: none` with `auto` on each control. This is a second layer of the
 * same kind rather than more children of that one, because the two answer different
 * questions — one control per orbitable tile, versus N handles per parameter — and
 * `preview-inspect-overlay.tsx`'s selector is built around the first.
 *
 * The pointer problem solves itself here for §T892's reason, restated because it is the
 * load-bearing part: a handle is not a descendant of `NodePreviewSlot`, so pressing one
 * cannot start the tile's orbit gesture, and it is outside React Flow entirely, so
 * d3-zoom (which listens on `.react-flow__pane`) never sees the press either. Structure,
 * not a `stopPropagation` someone can delete.
 *
 * THE BIG VIEWER PANE HAS NO SUCH LAYER, and that is a finding rather than an omission:
 * `app/side-panes.tsx`'s viewer is a bare `<canvas>` inside a `.surface` that is not even
 * a positioning context, handed straight to `backend.present`. Gizmos there need that
 * pane to grow an overlay sibling first — a `src/app` change with its own hit-testing and
 * its own aspect story (the present blit STRETCHES to the canvas, where a node tile
 * letterboxes), which is why this row lands on the graph pane's tiles and says so.
 *
 * ## Positioned, never measured — with one deliberate exception
 *
 * Placement uses `slotScreenRect` over `fitInsideRegion`, which is the exact arithmetic
 * `use-node-previews.ts` composites the tile with (§V118's letterbox included — the
 * picture is not the slot whenever the output's aspect differs, and a handle placed on the
 * slot would sit in the black bars). Per-frame `getBoundingClientRect` is the
 * forced-layout-during-pan mistake design note §2 warns about.
 *
 * The exception is ONE measurement at `pointerdown`: pointer events carry client
 * coordinates and every rect above is in PANE coordinates, so the layer's own origin has
 * to be measured to convert. Once per gesture, at the moment of the action (§V657), never
 * per frame.
 *
 * ## Why an animation frame, and why it is not a per-frame re-render
 *
 * A handle must follow the camera. Canvas pan, canvas zoom and an uncommitted node drag
 * arrive through React Flow's own store (§V112). The INSPECTION ORBIT does not: `apply`
 * and `zoom` on `PreviewOrbitStore` deliberately notify nobody, because the preview tick
 * samples them per frame and §T714's stutter is what happens when that becomes React
 * state. So the subscription below composes React Flow's store with an animation frame,
 * and `read()` returns the CACHED array whenever nothing moved — the frame is a poll, and
 * a poll that finds no change re-renders nothing. During an orbit drag this layer costs
 * what §T892's button already costs during a pan: a few absolutely-positioned elements.
 *
 * The loop does not start at all while `active` is false, which is every document with no
 * 3D tile offering a world-space vec3.
 */

/** Everything one tile needs to place and drag its handles. */
export interface PreviewGizmoTile {
  /** The compiler's published basis for this tile's synthesized pass. */
  readonly basis: OrbitCameraBasis;
  /** This pane's live inspection deltas, or undefined for the baked framing. */
  readonly orbit: PreviewOrbit | undefined;
  /** The synthesized target's pixel size — §V118's letterbox input. */
  readonly source: readonly [number, number];
  readonly handles: readonly GizmoHandle[];
}

export interface PreviewGizmoOverlaysProps {
  /** Where each node's preview slot is, in its own node's coordinates (§V111). */
  bounds: PreviewSlotBoundsStore;
  /**
   * One tile's facts, or null where there is nothing to draw. Called per node per frame,
   * so the caller memoizes what it can — but it must read the ORBIT freshly, because that
   * is the input no store notifies about.
   */
  tile: (nodeId: NodeId) => PreviewGizmoTile | null;
  /** The document-writing store every drag goes through (§V29). */
  store: Vec3GizmoStore;
  /** False when no node in this document offers a handle: the frame loop stays off. */
  active: boolean;
}

interface Placement {
  readonly nodeId: NodeId;
  readonly handle: GizmoHandle;
  readonly camera: TileCamera;
  readonly rect: PictureRect;
  readonly x: number;
  readonly y: number;
  readonly zoom: number;
}

const EMPTY: readonly Placement[] = [];

function samePlacements(a: readonly Placement[], b: readonly Placement[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    if (right === undefined) return false;
    // The camera is compared through its POSE, not its matrix: two poses that project
    // this handle to the same pixel can still define different drag planes, and the
    // pointerdown handler reads the camera off the cached placement.
    const pose = (side: Placement): readonly number[] => [
      ...side.camera.pose.eye,
      ...side.camera.pose.lookAt,
    ];
    return (
      left.nodeId === right.nodeId &&
      left.handle.key === right.handle.key &&
      left.handle.refusal === right.handle.refusal &&
      left.handle.value.every((v, i) => v === right.handle.value[i]) &&
      left.x === right.x &&
      left.y === right.y &&
      left.zoom === right.zoom &&
      left.rect.x === right.rect.x &&
      left.rect.y === right.rect.y &&
      left.rect.width === right.rect.width &&
      left.rect.height === right.rect.height &&
      pose(left).every((v, i) => v === pose(right)[i])
    );
  });
}

export function PreviewGizmoOverlays({ bounds, tile, store, active }: PreviewGizmoOverlaysProps) {
  const boxes = useSyncExternalStore(bounds.subscribe, bounds.snapshot, bounds.snapshot);

  const select = useMemo(
    () =>
      (state: ReactFlowState): readonly Placement[] => {
        const [tx, ty, zoom] = state.transform;
        const placements: Placement[] = [];
        // Driven by the MEASURED SLOTS, exactly as the inspect overlay is: a node with no
        // published slot has no picture to draw a handle on.
        for (const [id, box] of boxes) {
          const facts = tile(id);
          if (facts === null || facts.handles.length === 0) continue;
          const internal = state.nodeLookup.get(id);
          if (internal === undefined) continue;
          // §V118 — the PICTURE, not the slot. `use-node-previews.ts` composites the tile
          // into this same fitted box, so a handle placed on the slot would land in the
          // letterbox bars whenever the output's aspect differs from the node's.
          const fitted = fitInsideRegion(box, facts.source);
          const rect = slotScreenRect(
            {
              x: internal.position.x + box.x + fitted.x,
              y: internal.position.y + box.y + fitted.y,
              width: fitted.width,
              height: fitted.height,
            },
            { x: tx, y: ty, zoom },
          );
          const camera = tileCamera(facts.basis, facts.orbit);
          for (const handle of facts.handles) {
            const point = handleScreenPoint(camera, handle.value, rect);
            // Off-frame and behind-camera are both "nowhere to draw it". The tile orbits
            // and dollies, so the value is one wheel turn from being reachable; a handle
            // clamped to the edge would claim a position the parameter does not have.
            if (!point.visible) continue;
            placements.push({ nodeId: id, handle, camera, rect, x: point.x, y: point.y, zoom });
          }
        }
        return placements;
      },
    [boxes, tile],
  );

  /*
   * React Flow's own store (a pan, a zoom, an uncommitted node drag — §V112) composed
   * with an animation frame (the inspection orbit, which notifies nobody by design).
   * Subscribed through `useStoreApi` rather than React Flow's selector hook, whose NAME
   * `no-document-store.test.ts` bans anywhere in this directory: in every other file here
   * it would mean a document subscription, and arguing that this instance means a
   * different store is exactly the erosion the guard exists to prevent.
   */
  const api = useStoreApi();
  const cached = useRef<readonly Placement[]>(EMPTY);
  const read = useCallback(() => {
    const next = select(api.getState());
    if (samePlacements(cached.current, next)) return cached.current;
    cached.current = next;
    return next;
  }, [api, select]);
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribe = api.subscribe(listener);
      if (!active) return unsubscribe;
      let frame = requestAnimationFrame(function poll() {
        listener();
        frame = requestAnimationFrame(poll);
      });
      return () => {
        cancelAnimationFrame(frame);
        unsubscribe();
      };
    },
    [api, active],
  );
  const placements = useSyncExternalStore(subscribe, read, read);

  const layer = useRef<HTMLDivElement | null>(null);
  if (placements.length === 0) return null;
  return (
    <div ref={layer} className={styles.previewChrome} data-testid="preview-gizmo-overlays">
      {placements.map((placement) => (
        <GizmoHandleControl
          key={`${placement.nodeId} ${placement.handle.key}`}
          placement={placement}
          store={store}
          layer={layer}
        />
      ))}
    </div>
  );
}

/**
 * One handle. A press either opens a gesture or is REFUSED with its reason (§T935(b)).
 *
 * The refusal is not a disabled attribute: a disabled control shows no tooltip, which is
 * how §T896's picker lost the ability to say why, and the whole point of showing a driven
 * parameter's handle is that the user can find out what owns it. So the element stays
 * live, the press writes nothing, and the reason is on the accessible name and the title —
 * one string, `GIZMO_LOCKED_REASON`, read by both and by the test.
 */
function GizmoHandleControl({
  placement,
  store,
  layer,
}: {
  placement: Placement;
  store: Vec3GizmoStore;
  layer: RefObject<HTMLDivElement | null>;
}) {
  const { nodeId, handle, camera, rect, x, y, zoom } = placement;
  const locked = handle.refusal !== null;
  /** Captured at pointerdown and not re-read: the drag's plane is the one it began on. */
  const drag = useRef<{
    pointerId: number;
    origin: { x: number; y: number };
    grabX: number;
    grabY: number;
    start: readonly [number, number, number];
    camera: TileCamera;
    rect: PictureRect;
  } | null>(null);

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      // Refused BEFORE the pointer is captured, so a locked handle leaves the press to
      // whatever is under it rather than swallowing it into a gesture that writes nothing.
      if (store.begin(nodeId, handle) !== null) return;
      const box = layer.current?.getBoundingClientRect();
      const origin = { x: box?.left ?? 0, y: box?.top ?? 0 };
      drag.current = {
        pointerId: event.pointerId,
        origin,
        // Press-anywhere-on-the-handle must not teleport the value to the pointer: the
        // offset between the press and the handle's own centre rides along.
        grabX: event.clientX - origin.x - x,
        grabY: event.clientY - origin.y - y,
        start: handle.value,
        camera,
        rect,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.stopPropagation();
    },
    [camera, handle, layer, nodeId, rect, store, x, y],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      const active = drag.current;
      if (active === null || active.pointerId !== event.pointerId) return;
      const world = pointerToPlane(active.camera, active.start, active.rect, {
        x: event.clientX - active.origin.x - active.grabX,
        y: event.clientY - active.origin.y - active.grabY,
      });
      store.drag(nodeId, handle.key, world);
    },
    [handle.key, nodeId, store],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (drag.current?.pointerId !== event.pointerId) return;
      drag.current = null;
      store.end(nodeId, handle.key);
    },
    [handle.key, nodeId, store],
  );

  return (
    <button
      type="button"
      className={styles.gizmoHandle}
      data-testid={`preview-gizmo-${nodeId}-${handle.key}`}
      data-locked={locked ? "true" : undefined}
      aria-label={locked ? `${handle.label} handle — ${handle.refusal ?? ""}` : `${handle.label} handle`}
      title={locked ? (handle.refusal ?? "") : `Drag ${handle.label} across the view plane`}
      style={{ ...cssVars({ "--chrome-zoom": zoom }), left: `${String(x)}px`, top: `${String(y)}px` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    />
  );
}
