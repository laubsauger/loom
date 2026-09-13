import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import { isTextEntryTarget, strokeFromEvent, useOptionalKeymap } from "@editor/keymap/index.ts";
import { flyDeltaFor, flyStepFor, isFlyAxis } from "@editor/viewer/orbit-gestures.ts";
import type { FlyAxis } from "@editor/viewer/orbit-gestures.ts";
import type { PreviewOrbitStore } from "@editor/viewer/index.ts";
import { DEFAULT_PREVIEW_ORBIT, orbitFrame, orbitPose } from "@runtime/previews/index.ts";
import type { OrbitCameraBasis } from "@runtime/previews/index.ts";

/**
 * §T1311b(b) — THE VIEWER FLIES.
 *
 * The owner's ask, verbatim: "a proper blender thing with the proper control so that we can
 * fly around like our camera controls… so that it's very easy to turn the viewer into
 * something that we can use to explore around where we're not just stuck viewing a video
 * texture." The viewer has orbited, zoomed, homed and framed content since §T379, and
 * ⚑ **ORBIT IS NOT FLY** — anyone reading that working orbit will mark this done and be
 * wrong. An orbit turns the camera about a target it is fenced to: elevation stops short of
 * the poles, pan clamps at ±2 radii, and `distance` clamps to [0.2, 5]×, so NO combination
 * of orbit values ever puts the eye past the thing it was looking at. Flying is the other
 * interaction: the whole rig translates under its own heading, the target travels with it,
 * and the next drag orbits around where you arrived.
 *
 * ## Why this is a gesture with a binding table, and not simply a binding
 *
 * §V52 is explicit that a key's MEANING is data — no `if (event.key === "w")` in a
 * component — and the keymap's own table says the opposite thing about pointer gestures:
 * "pan/zoom mouse gestures… are pointer gestures on the canvas and belong to the
 * graph-canvas track, not to a key binding table". A held fly key is both. Dispatching one
 * command per keydown would hand the user the OS auto-repeat curve — half a second of
 * nothing, then a stutter — which is not a flight; integrating raw `event.key` in the pane
 * would make the keys unrebindable and invisible in the shortcut editor.
 *
 * So the two halves are split along what each is actually good at. **The keymap owns which
 * key means which direction**: six `viewer.fly` rows in the `viewer` context, rebindable,
 * listed in the shortcut editor, runnable from the palette and by an agent, and read from
 * HERE — rebind forward to `i` and the held gesture follows. **This hook owns the
 * integration**: press to start, release to stop, elapsed seconds × speed × the camera's
 * own axes, every frame. The `preventDefault` on a matched key is what keeps the keymap
 * from ALSO dispatching its discrete step on top of the gesture (`KeymapProvider` skips a
 * `defaultPrevented` event by design), so one press is one movement.
 *
 * ## View-only, by the same construction the rest of the camera is
 *
 * The flight lands in `PreviewOrbitStore`, which holds no bus and cannot reach the document
 * (§V527, gated by `no-document-store.test.ts`). From there it is read by whoever draws:
 * `orbitUniforms` for a scene rig, `use-view-camera.ts`'s eye/target/fov for a `customWgsl`
 * shader that declared the §T1311b(a) contract. Neither touches the authored pass. And a
 * store that does not implement `fly` — `createCameraGizmoStore`, whose writes go to a
 * document camera node (§T1314b) — gets no flight at all rather than a silently destructive
 * one.
 */

/** What the pane spreads onto the element that holds keyboard focus. */
export interface ViewerFlyHandlers {
  readonly onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly onKeyUp: (event: ReactKeyboardEvent<HTMLElement>) => void;
  readonly onBlur: () => void;
  /** True while at least one direction is held — the surface can say it is flying. */
  readonly flying: boolean;
  /**
   * One discrete step, for `viewer.fly` from the palette or an agent. Returns false when
   * there is no camera to fly, which is what the command turns into a refusal by name.
   */
  readonly step: (direction: FlyAxis) => boolean;
}

/** A frame longer than this is a tab that was in the background, not a slow frame. */
const MAX_FRAME_SECONDS = 0.1;

export function useViewerFly(options: {
  readonly orbits: PreviewOrbitStore | undefined;
  /** The node whose inspection camera this is. */
  readonly nodeId: NodeId | null;
  /**
   * The stock framing the flight is measured against — the compiler's own, from either
   * `synthesis.orbit` (a scene rig) or `viewCamera` (a shader that opted in). Null means
   * this output declares no camera, and the whole gesture is inert: §V986's rule, one
   * layer up — an unmeasurable framing reads as absent rather than as a unit-sphere guess.
   */
  readonly basis: OrbitCameraBasis | null;
}): ViewerFlyHandlers {
  const keymap = useOptionalKeymap();
  const [flying, setFlying] = useState(false);

  /**
   * Key name → direction, straight off the resolved keymap. Built from `sequence` rather
   * than from the `keys` string so an override goes through the same parser the engine
   * matches with; a chord (more than one stroke) is skipped, because a held chord is not a
   * gesture anybody can hold.
   */
  const directions = useMemo(() => {
    const map = new Map<string, FlyAxis>();
    for (const binding of keymap?.resolved.byCommand.get("viewer.fly") ?? []) {
      if (!binding.isBound || binding.sequence.length !== 1) continue;
      const stroke = binding.sequence[0];
      const direction = (binding.input as { direction?: unknown } | undefined)?.direction;
      if (stroke === undefined || !isFlyAxis(direction)) continue;
      // Shift is the THROTTLE, so a binding that wants shift held is not a fly key; any
      // other modifier means the row is somebody's deliberate chord, not a direction.
      if (stroke.mod || stroke.ctrl || stroke.alt || stroke.meta || stroke.shift) continue;
      map.set(stroke.key, direction);
    }
    return map;
  }, [keymap?.resolved]);

  /*
   * The loop reads the live values through a ref rather than closing over them: a
   * recompile mints a new `basis` object every time, and restarting the rAF loop on that
   * would drop a held key's motion every frame the graph changed.
   */
  const live = useRef(options);
  live.current = options;

  const held = useRef(new Map<string, FlyAxis>());
  const frame = useRef<number | null>(null);
  const lastAt = useRef<number | null>(null);
  /** Shift, sampled on the key events — the throttle, not a seventh direction. */
  const boosted = useRef(false);

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    lastAt.current = null;
    held.current.clear();
    setFlying(false);
  }, []);

  const tick = useCallback((at: number): void => {
    frame.current = null;
    const { orbits, nodeId, basis } = live.current;
    const previous = lastAt.current;
    lastAt.current = at;
    if (held.current.size === 0) return;
    if (orbits?.fly !== undefined && nodeId !== null && basis !== null && previous !== null) {
      // The camera's axes come from where it ACTUALLY IS, not from the stock basis: after
      // a drag, W must go where the picture points, and after a flight it must keep going
      // from the new position rather than re-resolving against the author's framing.
      const pose = orbitPose(basis, orbits.get(nodeId) ?? DEFAULT_PREVIEW_ORBIT);
      const seconds = Math.min(MAX_FRAME_SECONDS, (at - previous) / 1000);
      const delta = flyDeltaFor(held.current.values(), seconds, orbitFrame(pose), {
        boost: boosted.current,
      });
      if (delta !== null) orbits.fly(nodeId, delta);
    }
    frame.current = requestAnimationFrame(tick);
  }, []);

  const start = useCallback(() => {
    if (frame.current !== null) return;
    lastAt.current = null;
    frame.current = requestAnimationFrame(tick);
  }, [tick]);

  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      const { orbits, nodeId, basis } = live.current;
      if (orbits?.fly === undefined || nodeId === null || basis === null) return;
      // The output picker lives inside this pane and its type-ahead is its own; so is any
      // text field that ever lands here (§V53's rule, applied at the gesture).
      const tag = (event.target as { tagName?: unknown } | null)?.tagName;
      if (typeof tag === "string" && tag.toUpperCase() === "SELECT") return;
      if (isTextEntryTarget(event.target)) return;
      // Sampled before the direction lookup, so pressing shift DURING a flight speeds it up
      // — the throttle is a modifier on the gesture, not a property of the key that started
      // it, and it must answer to a press of its own.
      boosted.current = event.shiftKey;
      const stroke = strokeFromEvent(event);
      if (stroke === null || stroke.ctrl || stroke.alt || stroke.meta) return;
      const direction = directions.get(stroke.key);
      if (direction === undefined) return;
      /*
       * Consumed HERE, which is the whole reason the gesture and the binding can coexist:
       * `KeymapProvider` skips an event whose default was prevented, so the keymap does
       * not also fire `viewer.fly`'s discrete step on top of the held motion. Without
       * this line every press would move the camera twice, and auto-repeat would make the
       * second movement arrive in stutters.
       */
      event.preventDefault();
      if (event.repeat) return;
      // Entering adjustable is what makes the store accept the write at all (it is inert
      // while home), and it is the same entry the first orbit drag makes — one mode for
      // both gestures, so `h` still returns from either (§T656, §T380).
      orbits.setMode(nodeId, "adjustable");
      held.current.set(stroke.key, direction);
      setFlying(true);
      start();
    },
    [directions, start],
  );

  const onKeyUp = useCallback(
    (event: ReactKeyboardEvent<HTMLElement>) => {
      // Releasing shift drops back to cruise mid-flight, for the reason above.
      boosted.current = event.shiftKey;
      const stroke = strokeFromEvent(event);
      if (stroke === null) return;
      if (!held.current.delete(stroke.key)) return;
      event.preventDefault();
      if (held.current.size > 0) return;
      stop();
    },
    [stop],
  );

  /*
   * Losing focus releases everything. A keyup that lands on another element never reaches
   * this one, so without it a held W survives an alt-tab and the camera flies away on its
   * own — the same defect class as a drag that never sees its pointerup.
   */
  const onBlur = useCallback(() => {
    if (held.current.size === 0) return;
    stop();
  }, [stop]);

  const step = useCallback((direction: FlyAxis): boolean => {
    const { orbits, nodeId, basis } = live.current;
    if (orbits?.fly === undefined || nodeId === null || basis === null) return false;
    orbits.setMode(nodeId, "adjustable");
    const pose = orbitPose(basis, orbits.get(nodeId) ?? DEFAULT_PREVIEW_ORBIT);
    const delta = flyStepFor(direction, orbitFrame(pose));
    if (delta === null) return false;
    orbits.fly(nodeId, delta);
    return true;
  }, []);

  useEffect(() => stop, [stop]);

  return { onKeyDown, onKeyUp, onBlur, flying, step };
}
