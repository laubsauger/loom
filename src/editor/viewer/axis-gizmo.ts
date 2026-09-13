import {
  clampOrbitElevation,
  framedBasis,
  orbitFrame,
  orbitPose,
} from "@runtime/previews/index.ts";
import type { OrbitCameraBasis, OrbitPose, PreviewOrbit } from "@runtime/previews/index.ts";

/**
 * §T1311b(c) — THE CORNER GIZMO's arithmetic: which way is up, and how to get there.
 *
 * ## What this is NOT, because the name collides with two things that already ship
 *
 * `preview-gizmo-overlay.tsx` (§T935) is the DRAGGABLE POINT — one handle per world-space
 * `vec3` PARAMETER, projected through the tile's own perspective matrix, and every drag
 * writes the DOCUMENT through the command bus. `camera-gizmo-store.ts` (§T692/§T1314b) is
 * the same idea for a `camera` node's own pose. Both are authoring surfaces and both are
 * destructive by design, which is exactly what §T1311b's ruling forbids here. Neither is a
 * corner gizmo: they have no axes, no corner, and nothing to say about which way the view
 * is facing. This module shares no code with them and must not grow any.
 *
 * ## The projection is ORTHOGRAPHIC, and that is the whole point of a corner widget
 *
 * `gizmo-projection.ts` places a world POINT on the picture, so it needs the picture's fov,
 * aspect and rectangle, and a point behind the eye has nowhere to go. A corner gizmo places
 * a DIRECTION in a fixed little box: it answers "which way is +X from here", which has the
 * same answer at every distance, every focal length and every window size. So the marks
 * below come from the camera's own screen axes (`orbitFrame`, the derivation §T1311b(b)
 * already exported for the fly) and nothing else — no matrix, no rect, no perspective
 * divide, and all six axes are always placeable because a direction is never "behind" you,
 * only pointing away.
 *
 * ## Why the pose is the only input
 *
 * The widget must agree with the picture to the frame, and the one way to guarantee that is
 * to derive it from the SAME `orbitPose(basis, orbit)` the uniform push delivers
 * (`use-view-camera.ts` for a §T1311b(a) shader, `orbitUniforms` for a scene rig). A second
 * copy of the camera would be a second truth, and it would drift on exactly the gestures
 * that matter — the fly, which moves the rig without turning it, and the elevation clamp.
 */

/** Which world axis a mark names. */
export type GizmoAxis = "x" | "y" | "z";

/** One ball on the widget: a world axis direction, placed and depth-sorted. */
export interface AxisMark {
  /** Stable across frames — the React key and the test's handle. */
  readonly key: `${"+" | "-"}${GizmoAxis}`;
  readonly axis: GizmoAxis;
  readonly positive: boolean;
  /** Right-positive, in [-1, 1] of the widget's radius. */
  readonly x: number;
  /** UP-positive, in [-1, 1]. CSS wants it flipped; the caller does that, not this. */
  readonly y: number;
  /**
   * Toward the viewer, in [-1, 1]. 1 means this axis points straight at the eye, which is
   * what a snapped view looks like; −1 means it points straight away.
   */
  readonly depth: number;
}

/** The six directions, in a fixed order so a stable sort has something stable to keep. */
const AXES: ReadonlyArray<{ key: AxisMark["key"]; axis: GizmoAxis; positive: boolean; v: readonly [number, number, number] }> = [
  { key: "+x", axis: "x", positive: true, v: [1, 0, 0] },
  { key: "+y", axis: "y", positive: true, v: [0, 1, 0] },
  { key: "+z", axis: "z", positive: true, v: [0, 0, 1] },
  { key: "-x", axis: "x", positive: false, v: [-1, 0, 0] },
  { key: "-y", axis: "y", positive: false, v: [0, -1, 0] },
  { key: "-z", axis: "z", positive: false, v: [0, 0, -1] },
];

/**
 * Where each world axis sits on the widget, FARTHEST FIRST.
 *
 * The order is the paint order (§V-preview's honesty applied to a 12-pixel widget): drawn
 * back to front, the ball nearest the eye covers the one behind it, so the widget reads as
 * a solid object rather than as six dots whose stacking depends on declaration order. A
 * stable sort keeps `AXES`'s order among ties, which is what an axis exactly edge-on is.
 */
export function axisGizmoMarks(pose: OrbitPose): readonly AxisMark[] {
  const { right, up } = orbitFrame(pose);
  const dx = pose.eye[0] - pose.lookAt[0];
  const dy = pose.eye[1] - pose.lookAt[1];
  const dz = pose.eye[2] - pose.lookAt[2];
  const length = Math.max(1e-6, Math.hypot(dx, dy, dz));
  /** From the target TOWARD the eye — so a positive `depth` is a ball facing the viewer. */
  const back: readonly [number, number, number] = [dx / length, dy / length, dz / length];
  const dot = (a: readonly [number, number, number], b: readonly [number, number, number]): number =>
    a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  return AXES.map(({ key, axis, positive, v }) => ({
    key,
    axis,
    positive,
    x: dot(v, right),
    y: dot(v, up),
    depth: dot(v, back),
  })).sort((a, b) => a.depth - b.depth);
}

/**
 * The orbit DELTA that stands the camera on a world axis, looking back at its target.
 *
 * Returned as a delta rather than as a state because `PreviewOrbitStore.apply` is the only
 * way in and it accumulates — which is also why this cannot be "set azimuth to A": the
 * store holds no setter, deliberately (§V527), and the pan, the dolly and the flight must
 * survive a snap exactly as they survive a drag. Blender's axis buttons behave the same
 * way: the pivot and the distance are yours, the DIRECTION is what the button sets.
 *
 * ⚑ The elevation goes through `clampOrbitElevation`, so a +Y click lands the accumulator
 * ON the fence rather than 0.08 rad past it. `orbitPose` clamps on read either way — the
 * difference is whether the next downward drag does nothing for its first 0.08 radians.
 * §V986 is why the widget must then re-read the pose rather than assume the click landed:
 * a top view that the rig refuses is a measured 85.4°, not a claimed 90°.
 */
export function axisSnapDelta(
  basis: OrbitCameraBasis,
  orbit: PreviewOrbit,
  mark: Pick<AxisMark, "axis" | "positive">,
): { readonly azimuth: number; readonly elevation: number } {
  // The frame is applied BEFORE the deltas inside `orbitPose`, so the stock angles this
  // delta is measured against are the framed ones whenever a content frame is in force.
  const framed = orbit.frame === undefined ? basis : framedBasis(basis, orbit.frame);
  const dx = framed.eye[0] - framed.lookAt[0];
  const dy = framed.eye[1] - framed.lookAt[1];
  const dz = framed.eye[2] - framed.lookAt[2];
  const radius = Math.max(1e-6, Math.hypot(dx, dy, dz));
  const sign = mark.positive ? 1 : -1;
  /*
   * `orbitPose` builds its back vector as [cosEl·sin(az), sin(el), cosEl·cos(az)] — an
   * atan2(x, z) convention, z-forward, NOT the atan2(y, x) most trigonometry writes. The
   * inverse below has to use the same one, and the round trip is what the test pins.
   */
  const target: readonly [number, number, number] =
    mark.axis === "x" ? [sign, 0, 0] : mark.axis === "y" ? [0, sign, 0] : [0, 0, sign];
  const wantElevation = clampOrbitElevation(Math.asin(target[1]));
  const wantAzimuth = Math.atan2(target[0], target[2]);
  const stockAzimuth = Math.atan2(dx, dz);
  const stockElevation = Math.asin(Math.max(-1, Math.min(1, dy / radius)));
  return {
    azimuth: wantAzimuth - stockAzimuth - orbit.azimuth,
    elevation: wantElevation - stockElevation - orbit.elevation,
  };
}

/** The pose a snap would produce — the widget's own prediction, and the test's oracle. */
export function axisSnapPose(
  basis: OrbitCameraBasis,
  orbit: PreviewOrbit,
  mark: Pick<AxisMark, "axis" | "positive">,
): OrbitPose {
  const delta = axisSnapDelta(basis, orbit, mark);
  return orbitPose(basis, {
    ...orbit,
    azimuth: orbit.azimuth + delta.azimuth,
    elevation: orbit.elevation + delta.elevation,
  });
}
