import { describe, expect, it } from "vitest";

import { viewProjection } from "../../domain/geometry/camera.ts";
import { DEFAULT_PREVIEW_ORBIT, isDefaultOrbit, orbitEye, orbitUniforms, orbitViewProjection } from "./orbit.ts";

/**
 * T561 — the inspection camera's arithmetic, pinned where it can be exact.
 *
 * The contract that matters most is the FIRST one: identity deltas reproduce the
 * compiler's baked framing float for float, because "an untouched preview and a reset
 * one are the same picture" is what lets the orbit be a pushed VALUE with no second
 * copy of the default camera anywhere.
 */

const POINTS = { eye: [1.7, 1.2, 2.4] as const, lookAt: [0, 0, 0] as const };
const BALL = { eye: [0, 0, 2.6] as const, lookAt: [0, 0, 0] as const, fovY: Math.PI / 4, near: 0.1, far: 10 };

describe("the inspection orbit (T561)", () => {
  it("identity deltas reproduce the baked framing, float for float", () => {
    expect(isDefaultOrbit(DEFAULT_PREVIEW_ORBIT)).toBe(true);
    expect(orbitEye(POINTS, DEFAULT_PREVIEW_ORBIT)).toEqual(POINTS.eye);
    // The exact matrix the compiler bakes as POINTS_PREVIEW_CAMERA.
    expect(orbitViewProjection(POINTS, DEFAULT_PREVIEW_ORBIT)).toEqual(
      Array.from(viewProjection([1.7, 1.2, 2.4], [0, 0, 0], { aspect: 1 })),
    );
    // And the ball rig's OWN projection — fovY π/4, far 10 — not the default one.
    expect(orbitViewProjection(BALL, DEFAULT_PREVIEW_ORBIT)).toEqual(
      Array.from(viewProjection([0, 0, 2.6], [0, 0, 0], { aspect: 1, fovY: Math.PI / 4, near: 0.1, far: 10 })),
    );
  });

  it("a half-turn azimuth mirrors the eye through the up axis, radius intact", () => {
    const eye = orbitEye(BALL, { azimuth: Math.PI, elevation: 0, distance: 1 });
    expect(eye[0]).toBeCloseTo(0, 10);
    expect(eye[1]).toBeCloseTo(0, 10);
    expect(eye[2]).toBeCloseTo(-2.6, 10);
  });

  it("elevation clamps short of the poles and distance clamps to its range", () => {
    const overhead = orbitEye(POINTS, { azimuth: 0, elevation: 10, distance: 1 });
    const radius = Math.hypot(...POINTS.eye);
    // Clamped below the pole: some horizontal component always survives.
    expect(Math.hypot(overhead[0], overhead[2])).toBeGreaterThan(radius * 0.05);
    expect(overhead[1]).toBeLessThan(radius);

    const near = orbitEye(POINTS, { azimuth: 0, elevation: 0, distance: 0 });
    expect(Math.hypot(...near)).toBeCloseTo(radius * 0.2, 6);
    const far = orbitEye(POINTS, { azimuth: 0, elevation: 0, distance: 100 });
    expect(Math.hypot(...far)).toBeCloseTo(radius * 5, 6);
  });

  it("the push carries the moved eye beside the matrix, for view-dependent shading", () => {
    const orbit = { azimuth: 1, elevation: 0.3, distance: 1.5 };
    const pushed = orbitUniforms(BALL, orbit);
    const eye = orbitEye(BALL, orbit);
    expect(pushed.eye).toEqual([eye[0], eye[1], eye[2], 0]);
    expect(pushed.viewProjection).toEqual(orbitViewProjection(BALL, orbit));
  });
});
