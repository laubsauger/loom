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
 * DELTAS, not an absolute pose: `{azimuth: 0, elevation: 0, distance: 1}` reproduces the
 * compiler's baked framing exactly, so an untouched preview and a reset one are the same
 * picture by arithmetic rather than by a second copy of the default camera.
 */
export interface PreviewOrbit {
  /** Radians around the up axis, added to the stock framing's azimuth. */
  readonly azimuth: number;
  /** Radians of elevation, added and then clamped short of the poles. */
  readonly elevation: number;
  /** Multiplier on the stock framing's distance to the look-at point. */
  readonly distance: number;
}

export const DEFAULT_PREVIEW_ORBIT: PreviewOrbit = Object.freeze({
  azimuth: 0,
  elevation: 0,
  distance: 1,
});

export function isDefaultOrbit(orbit: PreviewOrbit): boolean {
  return orbit.azimuth === 0 && orbit.elevation === 0 && orbit.distance === 1;
}

/** The camera basis a synthesis descriptor publishes for its orbitable passes. */
export interface OrbitCameraBasis {
  readonly eye: readonly [number, number, number];
  readonly lookAt: readonly [number, number, number];
  /** The stock framing's own projection — the ball rig is fovY π/4, far 10. */
  readonly fovY?: number;
  readonly near?: number;
  readonly far?: number;
}

/** Just short of the poles: `lookAt`'s up is +y, and gimbal flip reads as a glitch. */
const MAX_ELEVATION = Math.PI / 2 - 0.08;
const MIN_DISTANCE = 0.2;
const MAX_DISTANCE = 5;

/** The stock eye, orbited by the deltas — identity deltas return the stock eye. */
export function orbitEye(
  basis: OrbitCameraBasis,
  orbit: PreviewOrbit,
): readonly [number, number, number] {
  // Identity SHORT-CIRCUITS to the stock eye itself: the spherical round-trip is exact
  // only in real arithmetic, and "untouched equals baked, float for float" is the claim.
  if (isDefaultOrbit(orbit)) return basis.eye;
  const dx = basis.eye[0] - basis.lookAt[0];
  const dy = basis.eye[1] - basis.lookAt[1];
  const dz = basis.eye[2] - basis.lookAt[2];
  const radius = Math.max(1e-6, Math.hypot(dx, dy, dz));
  const azimuth = Math.atan2(dx, dz) + orbit.azimuth;
  const elevation = Math.min(
    MAX_ELEVATION,
    Math.max(-MAX_ELEVATION, Math.asin(dy / radius) + orbit.elevation),
  );
  const distance =
    radius * Math.min(MAX_DISTANCE, Math.max(MIN_DISTANCE, orbit.distance));
  const cosEl = Math.cos(elevation);
  return [
    basis.lookAt[0] + distance * cosEl * Math.sin(azimuth),
    basis.lookAt[1] + distance * Math.sin(elevation),
    basis.lookAt[2] + distance * cosEl * Math.cos(azimuth),
  ];
}

/**
 * The matrix the push delivers — the SAME projection the compiler bakes (square aspect,
 * default fov/near/far), differing only in the orbited eye, so identity deltas produce
 * the baked matrix float for float.
 */
export function orbitViewProjection(basis: OrbitCameraBasis, orbit: PreviewOrbit): number[] {
  return Array.from(
    viewProjection(orbitEye(basis, orbit), basis.lookAt, {
      aspect: 1,
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
