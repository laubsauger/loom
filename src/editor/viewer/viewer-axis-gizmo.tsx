import { useCallback, useRef, useSyncExternalStore } from "react";
import type { NodeId } from "@domain/types/ids.ts";
import { DEFAULT_PREVIEW_ORBIT, orbitPose } from "@runtime/previews/index.ts";
import type { OrbitCameraBasis } from "@runtime/previews/index.ts";
import { axisGizmoMarks, axisSnapDelta } from "./axis-gizmo.ts";
import type { AxisMark } from "./axis-gizmo.ts";
import type { PreviewOrbitStore } from "./preview-orbit-store.ts";
import styles from "./viewer.module.css";

/**
 * §T1311b(c) — THE CORNER GIZMO. The owner asked for it by name: "a 3D viewport with an
 * access gizmo in the corner and like a proper blender thing with the proper control so
 * that we can fly around".
 *
 * ## It is an INSTRUMENT, and instruments answer one question
 *
 * The question is "where am I standing". §T1311b(a) gave a raymarched piece a camera the
 * viewer can move and (b) gave it a flight, and together they took away the one thing the
 * old fenced orbit guaranteed: that you were always looking at the author's subject from
 * somewhere near the author's framing. Four radii down E68's hall, with the target
 * travelling with you, "which way is the door" has no answer on screen — the picture is a
 * corridor, and a corridor looks the same facing either end. That is what this widget is
 * for, and it is why it belongs to the fly rather than being decoration on top of it.
 *
 * ## View-only, by having nothing to write with
 *
 * Every click lands in `PreviewOrbitStore`, which holds no bus and cannot reach the
 * document (§V527, gated by `no-document-store.test.ts` over this directory). That is the
 * same construction the orbit and the flight already stand on, not a new promise. ⚑ AND IT
 * IS THE REASON THIS IS NOT `PreviewGizmoOverlays`: that component (§T935) is the draggable
 * vec3 HANDLE, it writes the document through `Vec3GizmoStore`, and it is welded to React
 * Flow's node lookup besides. Mounting it here would have been a destructive path into the
 * pane the row's ruling exists to keep clean.
 *
 * ## §V986 — absent, never a confident default
 *
 * No basis means no measurable orientation, and the widget renders NOTHING rather than a
 * plausible tripod. The sentence explaining why a shader has no camera is
 * `viewCameraAbsentReason()`, it belongs to exactly one control (the viewer bar's camera
 * toggle, (b)), and a second copy here would be a second wording of one fact (§V349).
 *
 * ## Why a frame poll
 *
 * `PreviewOrbitStore` notifies on MODE changes only: `apply`, `zoom` and `fly` write
 * silently by design, because a notification per pointer move re-renders the tree at
 * pointer rate (§V16). So this polls while the camera is ADJUSTABLE — which is the only
 * state in which it can move — and not at all while it is home, exactly as
 * `use-view-camera.ts` does for the uniform push. The read is memoized on the placements,
 * so a frame that finds the camera still re-renders nothing.
 */

export interface ViewerAxisGizmoProps {
  readonly orbits: PreviewOrbitStore | undefined;
  /** The node whose inspection camera this is. */
  readonly nodeId: NodeId | null;
  /**
   * The compiler's published framing — `synthesis.orbit` for a scene rig, the `viewCamera`
   * row for a §T1311b(a) shader. Null means this output declares no camera: §V986, the
   * widget is absent rather than pointing somewhere it guessed.
   */
  readonly basis: OrbitCameraBasis | null;
}

/**
 * How far a ball centre travels from the middle, as a percentage of the box. 36 of 68px is
 * 24.5px, and a 17px ball adds 8.5 — so the farthest edge lands 1px inside the box and the
 * widget never clips against the picture's corner.
 */
const REACH = 36;

const AXIS_LABEL: Readonly<Record<AxisMark["axis"], string>> = { x: "X", y: "Y", z: "Z" };

function sameMarks(a: readonly AxisMark[], b: readonly AxisMark[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((left, index) => {
    const right = b[index];
    return (
      right !== undefined &&
      left.key === right.key &&
      left.x === right.x &&
      left.y === right.y &&
      left.depth === right.depth
    );
  });
}

const EMPTY: readonly AxisMark[] = [];

export function ViewerAxisGizmo({ orbits, nodeId, basis }: ViewerAxisGizmoProps) {
  const cached = useRef<readonly AxisMark[]>(EMPTY);

  const read = useCallback((): readonly AxisMark[] => {
    if (basis === null || nodeId === null) return EMPTY;
    // The SAME pose the uniform push delivers, from the same basis and the same deltas.
    // A second derivation of the camera would be a second truth, and it would disagree
    // precisely on the gestures that moved it.
    const next = axisGizmoMarks(orbitPose(basis, orbits?.get(nodeId) ?? DEFAULT_PREVIEW_ORBIT));
    if (sameMarks(cached.current, next)) return cached.current;
    cached.current = next;
    return next;
  }, [basis, nodeId, orbits]);

  const subscribe = useCallback(
    (listener: () => void) => {
      if (orbits === undefined || nodeId === null) return () => undefined;
      let frame: number | null = null;
      const poll = (): void => {
        listener();
        frame = requestAnimationFrame(poll);
      };
      const sync = (): void => {
        listener();
        if (orbits.mode(nodeId) === "adjustable") {
          if (frame === null) frame = requestAnimationFrame(poll);
          return;
        }
        if (frame !== null) cancelAnimationFrame(frame);
        frame = null;
      };
      sync();
      const unsubscribe = orbits.subscribe(nodeId, sync);
      return () => {
        unsubscribe();
        if (frame !== null) cancelAnimationFrame(frame);
      };
    },
    [nodeId, orbits],
  );

  const marks = useSyncExternalStore(subscribe, read, read);

  const snap = useCallback(
    (mark: AxisMark) => {
      if (orbits === undefined || nodeId === null || basis === null) return;
      // Entering is the same latch a drag on the canvas uses (T656): a snap IS looking
      // around, so `h` returns from it exactly as it returns from a drag or a flight.
      orbits.setMode(nodeId, "adjustable");
      const orbit = orbits.get(nodeId) ?? DEFAULT_PREVIEW_ORBIT;
      orbits.apply(nodeId, axisSnapDelta(basis, orbit, mark));
    },
    [basis, nodeId, orbits],
  );

  if (marks.length === 0) return null;
  return (
    <div className={styles.axisGizmo} data-testid="viewer-axis-gizmo" aria-label="View orientation">
      {/*
       * The stems, under every ball and out of the accessibility tree: they carry no
       * information the balls do not, they are what makes six dots read as one tripod.
       * Drawn to the POSITIVE ends only, which is the convention every 3D editor uses and
       * the reason a negative ball needs no letter to be unambiguous.
       */}
      <svg className={styles.axisStems} viewBox="-50 -50 100 100" aria-hidden="true">
        {marks
          .filter((mark) => mark.positive)
          .map((mark) => (
            <line
              key={mark.key}
              className={styles.axisStem}
              data-axis={mark.axis}
              x1={0}
              y1={0}
              x2={mark.x * REACH}
              y2={-mark.y * REACH}
            />
          ))}
      </svg>
      {marks.map((mark, index) => (
        <button
          key={mark.key}
          type="button"
          className={styles.axisBall}
          data-testid={`viewer-axis-${mark.key}`}
          data-axis={mark.axis}
          data-positive={mark.positive ? "true" : undefined}
          data-depth={mark.depth.toFixed(4)}
          aria-label={`View from ${mark.positive ? "+" : "−"}${AXIS_LABEL[mark.axis]}`}
          title={`Look from ${mark.positive ? "+" : "−"}${AXIS_LABEL[mark.axis]}`}
          style={{
            left: `${String(50 + mark.x * REACH)}%`,
            top: `${String(50 - mark.y * REACH)}%`,
            // `marks` is sorted farthest first, so the index IS the paint order and the
            // near ball covers the far one instead of whichever React rendered last.
            zIndex: index,
            // Perspective without a matrix: the far side of the tripod reads as far away.
            opacity: 0.45 + 0.55 * ((mark.depth + 1) / 2),
          }}
          onClick={() => snap(mark)}
        >
          {mark.positive ? AXIS_LABEL[mark.axis] : ""}
        </button>
      ))}
    </div>
  );
}
