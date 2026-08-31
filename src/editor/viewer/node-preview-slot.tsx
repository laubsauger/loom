import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
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
   * T675 — ALT IS THE CAMERA KEY, and this is the primary fix.
   *
   * The owner: "cant use orbit or any camera controls here in this geometry node… where
   * did the button go to unlock camera controls in 3d nodes?". Geometry was orbitable the
   * whole time; the toggle was unreachable — painted under the composited tile (see
   * `canvas-context.ts`) and, before that, a 14px glyph at opacity 0.35 revealed on hover
   * (T664). Their own proposal is TouchDesigner's model and is the right one: a modifier
   * that ENTERS the mode, so the camera is reachable without finding any chrome at all.
   *
   * WHICH MODIFIER, and what it costs. Alt is the only one free: React Flow holds shift
   * (`selectionKeyCode`), meta (`multiSelectionKeyCode`), ctrl (`zoomActivationKeyCode`,
   * and the macOS context-menu chord) and space (`panActivationKeyCode`). T656 had already
   * taken alt for PAN inside adjustable mode, so alt cannot mean two things and PAN MOVES
   * TO SHIFT. That is a deliberate change to a T656 decision, and the reason it is safe is
   * the reason T656 avoided shift in the first place no longer applies here: T656 was
   * reasoning about the CANVAS, and an adjustable tile is outside React Flow's gesture
   * space entirely — `nodrag`/`nopan` on the slot, `nowheel` while adjustable, and the
   * node view stops the pointer press from reaching the drag listener at all (§V20). The
   * rule is now one sentence: alt reaches the camera, shift pans instead of orbiting.
   *
   * Middle-drag stays deliberately unwired, for T656's reason: the owner is on a Mac
   * trackpad, which has no middle button.
   *
   * TWO WAYS IN, and they differ in whether they LATCH:
   *
   *  - alt + press = COMMIT. The tile enters adjustable and stays there when alt is
   *    released; the header toggle lights, and `h` or the toggle returns it home. The same
   *    gesture orbits immediately, so the first alt-drag does the thing the owner asked
   *    for rather than arming something.
   *  - alt held while hovering = PEEK. The tile goes adjustable so the cursor and the
   *    toggle say the camera is live, and releasing alt without having dragged puts it
   *    back home. Without this the discovery is silent; with it, sweeping the canvas with
   *    alt down does not leave a trail of tiles that have quietly stolen the wheel.
   *
   * All of it is VIEW STATE — the store makes no document revision and the preview tick
   * samples it per frame, so a gesture repaints the tile and re-renders nothing but the
   * one toggle that reports the mode.
   */
  const peeking = useRef(false);
  const enter = useCallback(() => {
    if (!orbitable || orbits === undefined) return;
    orbits.setMode(nodeId, "adjustable");
  }, [orbitable, orbits, nodeId]);

  const drag = useRef<{ pointerId: number; x: number; y: number; pan: boolean } | null>(null);
  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (!orbitable || orbits === undefined || event.button !== 0) return;
      // The modifier's own path: a press with alt down reaches the camera whether or not
      // the tile was already adjustable, and whether or not anyone found the toggle.
      if (event.altKey) enter();
      else if (!adjustable) return;
      // A press that used the peek COMMITS it — that is what makes the alt release
      // below leave an intentionally-adjusted tile alone.
      peeking.current = false;
      drag.current = {
        pointerId: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        pan: event.shiftKey,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
    },
    [adjustable, enter, orbitable, orbits, nodeId],
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
          ? // SHIFT-drag (T675 moved this off alt). The camera follows the drag, the same
            // convention the orbit already uses: drag right and the eye AND look-at slide
            // right, so the object goes left.
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

  /**
   * T664 — `h` over the tile returns it home, so the toggle is not the only way back.
   *
   * TouchDesigner's muscle memory, and the key is free here by an earlier deliberate
   * decision rather than by luck: `H` (shifted) is `view.home`, the canvas's 1:1 zoom,
   * and `defaults.ts` records that lowercase `h` was left OUT because "home selected"
   * stopped meaning anything once `H` became about scale. `key === "h"` never matches
   * the shifted form, so the canvas binding is untouched.
   *
   * It stays out of the keymap registry on purpose. §V78 routes a COMMAND's key through
   * the registry so the menu and the palette can show it; this has no command to route,
   * because §V527's whole point is that the inspection store holds no bus. It is a
   * gesture on a hovered tile, the same kind of thing as the drag beside it.
   *
   * Listener attached only while a tile is actually hovered AND adjustable: one listener
   * for the whole canvas rather than one per preview, and no chance of swallowing `h`
   * from a text field, which cannot be hovered and focused as this tile at once.
   */
  const [hovered, setHovered] = useState(false);

  /**
   * T675 — the PEEK half of the modifier path.
   *
   * Holding alt over an orbitable tile makes its camera live, so the affordance announces
   * itself the instant the key goes down rather than waiting to be found. Releasing alt
   * without having pressed puts it back home: a peek that latched would mean sweeping the
   * canvas with alt held left every tile it passed holding the wheel, which is a worse
   * version of the bug this task is fixing.
   *
   * `event.altKey` rather than `event.key === "Alt"`, so alt arriving as part of a chord
   * still counts; the keyup half checks `altKey` going false for the same reason. The
   * listener is attached only while a tile is hovered AND home, which is one listener for
   * the whole canvas and none at all once a tile is committed.
   */
  useEffect(() => {
    if (!hovered || !orbitable || orbits === undefined || mode !== "home") return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!event.altKey) return;
      peeking.current = true;
      orbits.setMode(nodeId, "adjustable");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hovered, orbitable, orbits, nodeId, mode]);

  useEffect(() => {
    if (!peeking.current || orbits === undefined) return;
    const end = (): void => {
      if (!peeking.current) return;
      peeking.current = false;
      orbits.setMode(nodeId, "home");
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.altKey) return;
      end();
    };
    // A pointer that leaves the tile ends the peek too: alt released outside the window
    // never reaches the keyup listener, and a tile left adjustable by a key nobody saw is
    // the same "control with a mind of its own" this task exists to remove.
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", end);
    };
  }, [orbits, nodeId, mode]);

  useEffect(() => {
    if (!hovered || !adjustable || orbits === undefined) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== "h" || event.altKey || event.ctrlKey || event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      orbits.setMode(nodeId, "home");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hovered, adjustable, orbits, nodeId]);

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
      onPointerEnter={() => setHovered(true)}
      onPointerLeave={() => {
        setHovered(false);
        // An un-committed peek does not survive the pointer leaving the tile.
        if (peeking.current) {
          peeking.current = false;
          orbits?.setMode(nodeId, "home");
        }
      }}
    >
      {/*
        T675 — THE TOGGLE IS NOT HERE ANY MORE, and its absence is the fix.

        T613/T656 put it at the tile's corner, TouchDesigner's position, and T664 shrank it
        to a glyph when the word reflowed. Both were arguing about how loud a control was
        while it was not on screen at all: the shared preview surface is a full-pane canvas
        at `--z-canvas-overlay` (30) and everything inside a node is sealed inside
        `.react-flow__viewport`'s stacking context at 2, so the composited tile paints over
        anything drawn in this box, and no z-index reachable from here can cross that.
        `pointer-events: none` on the surface is why it was invisible rather than DEAD —
        clicks still landed, so every test that found the button by test-id and clicked it
        passed (§V461: a DOM query cannot see occlusion).

        So the control lives in the node's HEADER now, beside P/B/M, where nothing is ever
        composited — `previewInspect` in `canvas-context.ts`. What stays here is the part
        that must be on the picture: the gestures, and the cursor that says they are live.
      */}
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
