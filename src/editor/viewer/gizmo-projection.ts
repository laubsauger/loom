import { viewProjection } from "@domain/geometry/camera.ts";
import { transformPoint } from "@domain/geometry/camera.ts";
import type { Mat4 } from "@domain/geometry/camera.ts";
import { DEFAULT_PREVIEW_ORBIT, orbitPose } from "@runtime/previews/index.ts";
import type { OrbitCameraBasis, OrbitPose, PreviewOrbit } from "@runtime/previews/index.ts";

/**
 * T935 — WHERE A WORLD POINT IS ON A TILE, and where a pointer on that tile is in the
 * world. The two halves of a draggable gizmo, and neither of them stores anything.
 *
 * ## The placement is DERIVED, never tracked
 *
 * A handle has no position of its own. It has a world value (a document parameter) and a
 * camera (the one the tile was drawn with), and its screen point is those two multiplied
 * together — recomputed every time either moves. That is the whole reason a handle cannot
 * drift out of agreement with the picture it sits on: there is no second copy of the
 * truth to fall behind.
 *
 * The camera is not an approximation of the tile's camera, it IS the tile's camera.
 * `orbitPose` is the function `runtime/previews/system.ts` pushes into the uniform block
 * (via `orbitUniforms`), fed from the same compiler-published basis and the same live
 * inspection deltas, so `handleScreenPoint` projects through the matrix the GPU actually
 * drew with rather than through a plausible reconstruction of it.
 *
 * ## §T935(c) — the depth constraint, stated once
 *
 * A pointer names two numbers and a world point needs three, so SOMETHING has to supply
 * the third and every choice is a guess about intent. This one picks the guess that can
 * never surprise: the drag is confined to the plane through the parameter's CURRENT value
 * facing the camera. The consequences are the point of it —
 *
 *  - the handle stays exactly under the pointer, at every zoom and every distance, because
 *    the constraint is precisely what makes the inverse exact rather than fitted;
 *  - a drag never changes how far away the value is, so nothing moves in a direction the
 *    screen cannot show;
 *  - orbiting between drags picks a new plane, so the third axis is reachable by moving
 *    the CAMERA — a two-gesture operation whose halves are each predictable, instead of
 *    one gesture that quietly invents depth from pointer speed or a modifier key.
 *
 * Axis-locked handles (drag confined to world x, y or z) are the documented next step and
 * they compose with this rather than replacing it. A free 3D drag is not a next step: it
 * is the thing that makes gizmos feel worse than typing numbers, which is what this row
 * exists to fix.
 *
 * ## Two derivations, deliberately independent
 *
 * `handleScreenPoint` goes through the MATRIX (`transformPoint`, perspective divide) and
 * `pointerToPlane` goes through the POSE (camera basis, similar triangles). They are not
 * the same code path inverted — one could be wrong while the other is right, which is
 * exactly why `gizmo-projection.test.ts` pins their round trip. A shared helper here would
 * make that gate agree with itself and prove nothing.
 */

/** The rectangle the picture actually occupies on screen — letterboxed, not the slot. */
export interface PictureRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** The camera one tile was drawn through: the pose, its matrix, and its optics. */
export interface TileCamera {
  readonly pose: OrbitPose;
  readonly matrix: Mat4;
  readonly fovY: number;
  readonly aspect: number;
}

/** `viewProjection`'s own defaults, named here because the inverse needs the same ones. */
const DEFAULT_FOV_Y = Math.PI / 3;
const DEFAULT_ASPECT = 1;
/** Nearer than this to the eye plane there is no honest answer; the drag holds instead. */
const MIN_VIEW_DEPTH = 1e-4;

type Vec3 = readonly [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

/**
 * The tile's camera, from the compiler's basis and this pane's live inspection deltas.
 *
 * `orbitPose` is called, never reimplemented: it carries the identity short-circuit
 * (§V528 — an untouched preview reproduces the baked framing float for float), T379's
 * content frame, and the pole clamp that keeps the basis below from degenerating.
 */
export function tileCamera(basis: OrbitCameraBasis, orbit: PreviewOrbit | undefined): TileCamera {
  const pose = orbitPose(basis, orbit ?? DEFAULT_PREVIEW_ORBIT);
  const fovY = basis.fovY ?? DEFAULT_FOV_Y;
  const aspect = basis.aspect ?? DEFAULT_ASPECT;
  return {
    pose,
    fovY,
    aspect,
    // The same call `orbitViewProjection` makes, with the same defaults, so the handle is
    // placed by the matrix the pass was drawn with rather than by one that resembles it.
    matrix: viewProjection(pose.eye, pose.lookAt, {
      aspect,
      fovY,
      ...(basis.near === undefined ? {} : { near: basis.near }),
      ...(basis.far === undefined ? {} : { far: basis.far }),
    }),
  };
}

/** A handle's placement on the pane, and whether the camera can see it at all. */
export interface HandlePoint {
  readonly x: number;
  readonly y: number;
  /** False when the point is behind the eye, or outside the picture's own rectangle. */
  readonly visible: boolean;
}

/**
 * World → pane pixels, through the tile's own matrix.
 *
 * `visible` folds two different absences together on purpose: a point behind the camera
 * and a point off the side of the frame are both "there is nowhere on this picture to
 * draw it", and the caller's response to each is the same — draw nothing. The tile orbits
 * and dollies, so an off-frame value is reachable in one wheel turn; a clamped-to-the-edge
 * ghost would claim a position the parameter does not have.
 */
export function handleScreenPoint(camera: TileCamera, world: Vec3, rect: PictureRect): HandlePoint {
  const clip = transformPoint(camera.matrix, world);
  const w = clip[3];
  if (!(w > MIN_VIEW_DEPTH)) return { x: 0, y: 0, visible: false };
  const ndcX = clip[0] / w;
  const ndcY = clip[1] / w;
  const x = rect.x + (ndcX * 0.5 + 0.5) * rect.width;
  const y = rect.y + (0.5 - ndcY * 0.5) * rect.height;
  return { x, y, visible: Math.abs(ndcX) <= 1 && Math.abs(ndcY) <= 1 };
}

/**
 * Pane pixels → world, on the camera-facing plane through `current` (§T935(c)).
 *
 * Derived from the POSE rather than by inverting the matrix: the camera basis is the same
 * one `lookAt` builds (back = eye − centre, right = up × back, up' = back × right), the
 * plane is `dot(p − eye, forward) = d` for the current value's own `d`, and the offsets
 * within it come from similar triangles — `tan(fovY / 2)` is half the frame's height at
 * unit depth, so a pixel is worth `2·d·tan(fovY/2) / height` world units and the same
 * number horizontally once the aspect has taken the width into account.
 *
 * Returns `current` unchanged when the value sits on or behind the eye plane, where the
 * plane is not a plane the pointer can address. A drag that held still is the honest
 * answer there; the alternative is a value that leaps by however large a number the
 * division produced.
 */
export function pointerToPlane(
  camera: TileCamera,
  current: Vec3,
  rect: PictureRect,
  pointer: { readonly x: number; readonly y: number },
): Vec3 {
  if (!(rect.width > 0) || !(rect.height > 0)) return current;
  const eye = camera.pose.eye as Vec3;
  const back = normalize(sub(eye, camera.pose.lookAt as Vec3));
  const right = normalize(cross([0, 1, 0], back));
  const up = cross(back, right);
  const forward: Vec3 = [-back[0], -back[1], -back[2]];

  const depth = dot(sub(current, eye), forward);
  if (!(depth > MIN_VIEW_DEPTH)) return current;

  const ndcX = (2 * (pointer.x - rect.x)) / rect.width - 1;
  const ndcY = 1 - (2 * (pointer.y - rect.y)) / rect.height;
  const halfHeight = depth * Math.tan(camera.fovY / 2);
  const offsetRight = ndcX * halfHeight * camera.aspect;
  const offsetUp = ndcY * halfHeight;

  return [
    eye[0] + forward[0] * depth + right[0] * offsetRight + up[0] * offsetUp,
    eye[1] + forward[1] * depth + right[1] * offsetRight + up[1] * offsetUp,
    eye[2] + forward[2] * depth + right[2] * offsetRight + up[2] * offsetUp,
  ];
}
