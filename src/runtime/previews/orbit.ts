import { viewProjection } from "../../domain/geometry/camera.ts";

/**
 * The INSPECTION camera for a synthesized preview (T561).
 *
 * The owner's framing, which is the contract: "3d stuff needs 3d inspection without
 * screwing with its data". An orbit is VIEW STATE — session-scoped, per pane, never a
 * document revision, never in a `.loom.json`, never touching a scene's own camera node.
 * It reaches the picture as a uniform VALUE pushed on the per-frame preview command
 * (B118's seam), because the splat and stock-scene passes carry `viewProjection` as a
 * value by construction (§V5, §V330) — so a drag re-renders a tile and rebuilds nothing.
 *
 * DELTAS, not an absolute pose: the identity orbit reproduces the compiler's baked
 * framing exactly, so an untouched preview and a reset one are the same picture by
 * arithmetic rather than by a second copy of the default camera.
 *
 * T656 adds PAN to the same record. Zoom needed nothing new — the wheel writes
 * `distance`, which T561 already clamped and plumbed, so there is exactly one distance
 * path from the gesture to the matrix.
 */
export interface PreviewOrbit {
  /** Radians around the up axis, added to the stock framing's azimuth. */
  readonly azimuth: number;
  /** Radians of elevation, added and then clamped short of the poles. */
  readonly elevation: number;
  /** Multiplier on the stock framing's distance to the look-at point. */
  readonly distance: number;
  /**
   * T656: the look-at offset along the camera's OWN right axis, in units of the stock
   * framing's radius — scale-free like `distance`, so one gesture constant works for the
   * points rig and the ball rig alike.
   */
  readonly panX: number;
  /** T656: the same, along the camera's own up axis. */
  readonly panY: number;
  /**
   * T379 — a CONTENT FRAME under the deltas: re-centre the basis on what the points
   * actually are, instead of the compiler's baked constants. The stock framings are
   * tuned on unit-scale scenes, and a magic default strands the user off-screen on
   * every other one — which turns "home" into the button that loses the picture. The
   * frame carries measured bounds (centre + bounding radius); the pose keeps the STOCK
   * viewing direction and refits the distance to the radius, and every delta applies
   * on top exactly as it does over the baked basis. View state like everything here:
   * absent means the baked framing, byte for byte.
   */
  readonly frame?: {
    readonly lookAt: readonly [number, number, number];
    readonly radius: number;
  };
}

export const DEFAULT_PREVIEW_ORBIT: PreviewOrbit = Object.freeze({
  azimuth: 0,
  elevation: 0,
  distance: 1,
  panX: 0,
  panY: 0,
});

export function isDefaultOrbit(orbit: PreviewOrbit): boolean {
  return (
    orbit.azimuth === 0 &&
    orbit.elevation === 0 &&
    orbit.distance === 1 &&
    orbit.panX === 0 &&
    orbit.panY === 0 &&
    // T379: a content frame is not the identity — the whole point is that it moves
    // the camera off the baked constants.
    orbit.frame === undefined
  );
}

/**
 * T379 — the basis, re-centred on measured content. Direction is the STOCK one (the
 * kind's designed viewpoint survives), distance refits to the bounding radius with
 * margin: at FIT = 2.4 a unit-radius cloud fills roughly the frame the stock rigs were
 * tuned to. Zero radius (a single point, an empty buffer) keeps the stock distance —
 * a zoom to nothing helps nobody.
 */
const FRAME_FIT = 2.4;
export function framedBasis(
  basis: OrbitCameraBasis,
  frame: { readonly lookAt: readonly [number, number, number]; readonly radius: number },
): OrbitCameraBasis {
  const dx = basis.eye[0] - basis.lookAt[0];
  const dy = basis.eye[1] - basis.lookAt[1];
  const dz = basis.eye[2] - basis.lookAt[2];
  const stock = Math.max(1e-6, Math.hypot(dx, dy, dz));
  const distance = frame.radius > 1e-6 ? frame.radius * FRAME_FIT : stock;
  const k = distance / stock;
  return {
    ...basis,
    lookAt: [frame.lookAt[0], frame.lookAt[1], frame.lookAt[2]],
    eye: [frame.lookAt[0] + dx * k, frame.lookAt[1] + dy * k, frame.lookAt[2] + dz * k],
  };
}

/** The camera basis a synthesis descriptor publishes for its orbitable passes. */
export interface OrbitCameraBasis {
  readonly eye: readonly [number, number, number];
  readonly lookAt: readonly [number, number, number];
  /** The stock framing's own projection — the ball rig is fovY π/4, far 10. */
  readonly fovY?: number;
  readonly near?: number;
  readonly far?: number;
  /**
   * T663: the SYNTHESIZED TARGET's aspect, which is the project's — never 1, unless the
   * project is square. The compiler bakes its stock matrix at exactly this number, so
   * identity deltas still reproduce it float for float; getting it wrong here does not
   * fail loudly, it renders the orbited picture STRETCHED against an unstretched stock
   * one, which is why the compiler passes it rather than each caller assuming.
   */
  readonly aspect?: number;
}

/** Just short of the poles: `lookAt`'s up is +y, and gimbal flip reads as a glitch. */
const MAX_ELEVATION = Math.PI / 2 - 0.08;
const MIN_DISTANCE = 0.2;
const MAX_DISTANCE = 5;
/** Two stock radii of travel in each direction — enough to put a corner centre-frame. */
const MAX_PAN = 2;

/**
 * T656: the distance clamp, EXPORTED, because the wheel accumulates into `distance` and
 * an unclamped accumulator produces a dead zone — twenty scrolls out then one scroll in
 * would move nothing for nineteen of them. The store clamps on write with THIS function
 * and `orbitPose` clamps on read with it too, so there is one range and one spelling.
 */
export function clampOrbitDistance(distance: number): number {
  return Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, distance));
}

/** The same, for a pan offset — basis-independent because it is in radius units. */
export function clampOrbitPan(offset: number): number {
  return Math.min(MAX_PAN, Math.max(-MAX_PAN, offset));
}

/** Where the inspection camera sits and what it looks at, after the deltas. */
export interface OrbitPose {
  readonly eye: readonly [number, number, number];
  readonly lookAt: readonly [number, number, number];
}

/**
 * The stock pose, moved by the deltas — identity deltas return the stock pose itself.
 *
 * Pan moves the eye AND the look-at together along the camera's own screen axes, which
 * is what makes it a pan rather than a second orbit: the view direction is untouched, so
 * the object slides across the frame instead of turning.
 */
export function orbitPose(rawBasis: OrbitCameraBasis, orbit: PreviewOrbit): OrbitPose {
  // Identity SHORT-CIRCUITS to the stock pose itself: the spherical round-trip is exact
  // only in real arithmetic, and "untouched equals baked, float for float" is the claim.
  if (isDefaultOrbit(orbit)) return { eye: rawBasis.eye, lookAt: rawBasis.lookAt };
  // T379: a content frame re-centres the basis BEFORE the deltas, so orbiting after a
  // frame-content orbits around the content.
  const basis = orbit.frame === undefined ? rawBasis : framedBasis(rawBasis, orbit.frame);
  const dx = basis.eye[0] - basis.lookAt[0];
  const dy = basis.eye[1] - basis.lookAt[1];
  const dz = basis.eye[2] - basis.lookAt[2];
  const radius = Math.max(1e-6, Math.hypot(dx, dy, dz));
  const azimuth = Math.atan2(dx, dz) + orbit.azimuth;
  const elevation = Math.min(
    MAX_ELEVATION,
    Math.max(-MAX_ELEVATION, Math.asin(dy / radius) + orbit.elevation),
  );
  const distance = radius * clampOrbitDistance(orbit.distance);
  const cosEl = Math.cos(elevation);
  // Unit vector from the look-at toward the eye — `lookAt`'s own +z basis vector.
  const back: [number, number, number] = [
    cosEl * Math.sin(azimuth),
    Math.sin(elevation),
    cosEl * Math.cos(azimuth),
  ];
  // The camera's screen axes, exactly as `lookAt` derives them: right = up × back,
  // up' = back × right. Elevation is clamped short of the poles, so `back` is never
  // parallel to +y and the cross product never degenerates.
  const rightLength = Math.max(1e-6, Math.hypot(back[2], 0, -back[0]));
  const right: [number, number, number] = [back[2] / rightLength, 0, -back[0] / rightLength];
  const up: [number, number, number] = [
    back[1] * right[2] - back[2] * right[1],
    back[2] * right[0] - back[0] * right[2],
    back[0] * right[1] - back[1] * right[0],
  ];
  const panRight = clampOrbitPan(orbit.panX) * radius;
  const panUp = clampOrbitPan(orbit.panY) * radius;
  const shift = (axis: 0 | 1 | 2): number => right[axis] * panRight + up[axis] * panUp;
  const lookAt: [number, number, number] = [
    basis.lookAt[0] + shift(0),
    basis.lookAt[1] + shift(1),
    basis.lookAt[2] + shift(2),
  ];
  return {
    eye: [
      lookAt[0] + distance * back[0],
      lookAt[1] + distance * back[1],
      lookAt[2] + distance * back[2],
    ],
    lookAt,
  };
}

/** The stock eye, orbited by the deltas — identity deltas return the stock eye. */
export function orbitEye(
  basis: OrbitCameraBasis,
  orbit: PreviewOrbit,
): readonly [number, number, number] {
  return orbitPose(basis, orbit).eye;
}

/**
 * The matrix the push delivers — the SAME projection the compiler bakes (square aspect,
 * default fov/near/far), differing only in the moved pose, so identity deltas produce
 * the baked matrix float for float.
 */
export function orbitViewProjection(basis: OrbitCameraBasis, orbit: PreviewOrbit): number[] {
  const pose = orbitPose(basis, orbit);
  return Array.from(
    viewProjection(pose.eye, pose.lookAt, {
      // T663: the target's aspect, defaulting to square for a basis that names none.
      aspect: basis.aspect ?? 1,
      ...(basis.fovY === undefined ? {} : { fovY: basis.fovY }),
      ...(basis.near === undefined ? {} : { near: basis.near }),
      ...(basis.far === undefined ? {} : { far: basis.far }),
    }),
  );
}

/**
 * Everything the push writes for one orbited pass. `eye` rides along because the ball
 * shaders compute view-dependent specular from it — a camera that moved while the eye
 * uniform stood still would show the old viewpoint's highlight (vec4: the blocks pad).
 */
export function orbitUniforms(
  basis: OrbitCameraBasis,
  orbit: PreviewOrbit,
): { viewProjection: number[]; eye: number[] } {
  const eye = orbitEye(basis, orbit);
  return { viewProjection: orbitViewProjection(basis, orbit), eye: [eye[0], eye[1], eye[2], 0] };
}
