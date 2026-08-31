import { describe, expect, it } from "vitest";

import { viewProjection } from "../../domain/geometry/camera.ts";
import {
  DEFAULT_PREVIEW_ORBIT,
  isDefaultOrbit,
  orbitEye,
  orbitPose,
  orbitUniforms,
  orbitViewProjection,
} from "./orbit.ts";

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
    const eye = orbitEye(BALL, { azimuth: Math.PI, elevation: 0, distance: 1, panX: 0, panY: 0 });
    expect(eye[0]).toBeCloseTo(0, 10);
    expect(eye[1]).toBeCloseTo(0, 10);
    expect(eye[2]).toBeCloseTo(-2.6, 10);
  });

  it("elevation clamps short of the poles and distance clamps to its range", () => {
    const overhead = orbitEye(POINTS, { azimuth: 0, elevation: 10, distance: 1, panX: 0, panY: 0 });
    const radius = Math.hypot(...POINTS.eye);
    // Clamped below the pole: some horizontal component always survives.
    expect(Math.hypot(overhead[0], overhead[2])).toBeGreaterThan(radius * 0.05);
    expect(overhead[1]).toBeLessThan(radius);

    const near = orbitEye(POINTS, { azimuth: 0, elevation: 0, distance: 0, panX: 0, panY: 0 });
    expect(Math.hypot(...near)).toBeCloseTo(radius * 0.2, 6);
    const far = orbitEye(POINTS, { azimuth: 0, elevation: 0, distance: 100, panX: 0, panY: 0 });
    expect(Math.hypot(...far)).toBeCloseTo(radius * 5, 6);
  });

  it("the push carries the moved eye beside the matrix, for view-dependent shading", () => {
    const orbit = { azimuth: 1, elevation: 0.3, distance: 1.5, panX: 0, panY: 0 };
    const pushed = orbitUniforms(BALL, orbit);
    const eye = orbitEye(BALL, orbit);
    expect(pushed.eye).toEqual([eye[0], eye[1], eye[2], 0]);
    expect(pushed.viewProjection).toEqual(orbitViewProjection(BALL, orbit));
  });
});

describe("the inspection PAN (T656)", () => {
  /**
   * A pan is not a second orbit, and this is the property that says so: the eye and the
   * look-at move by the SAME vector, so the view direction is bit-identical and the
   * object slides across the frame instead of turning. If pan were ever implemented by
   * moving only the eye — the easy mistake — the direction would change and this fails.
   */
  it("moves the eye and the look-at by one vector, leaving the view direction alone", () => {
    const panned = orbitPose(BALL, { ...DEFAULT_PREVIEW_ORBIT, panX: 0.5, panY: -0.25 });
    const stock = orbitPose(BALL, DEFAULT_PREVIEW_ORBIT);
    const shift = [0, 1, 2].map((axis) => panned.eye[axis]! - stock.eye[axis]!);
    for (const axis of [0, 1, 2] as const) {
      expect(panned.lookAt[axis]! - stock.lookAt[axis]!).toBeCloseTo(shift[axis]!, 12);
    }
    // The ball rig looks down -z from (0,0,2.6), so screen right is +x and screen up is
    // +y: panX walks the camera to its own right, panY down when negative.
    expect(shift[0]).toBeCloseTo(0.5 * 2.6, 10);
    expect(shift[1]).toBeCloseTo(-0.25 * 2.6, 10);
    expect(shift[2]).toBeCloseTo(0, 10);
  });

  it("pans along the camera's OWN axes after an orbit, not the world's", () => {
    // A quarter turn puts the ball rig on +x looking back at the origin; its screen-right
    // is then -z. A pan that used world axes would still push +x and this would fail.
    const turned = { ...DEFAULT_PREVIEW_ORBIT, azimuth: Math.PI / 2, panX: 0.5 };
    const pose = orbitPose(BALL, turned);
    const unpanned = orbitPose(BALL, { ...DEFAULT_PREVIEW_ORBIT, azimuth: Math.PI / 2 });
    expect(pose.lookAt[0]! - unpanned.lookAt[0]!).toBeCloseTo(0, 10);
    expect(pose.lookAt[2]! - unpanned.lookAt[2]!).toBeCloseTo(-0.5 * 2.6, 10);
  });

  it("a pan-only delta is NOT the default, so §V528's short-circuit cannot swallow it", () => {
    // The identity check gates the "float for float" short-circuit, so a pan it does not
    // know about would be silently dropped — the picture would never move.
    expect(isDefaultOrbit({ ...DEFAULT_PREVIEW_ORBIT, panX: 0.1 })).toBe(false);
    expect(isDefaultOrbit({ ...DEFAULT_PREVIEW_ORBIT, panY: 0.1 })).toBe(false);
    expect(orbitEye(POINTS, { ...DEFAULT_PREVIEW_ORBIT, panX: 0.1 })).not.toEqual(POINTS.eye);
  });

  it("builds the projection at the TARGET's aspect, so an orbit is not stretched (T663)", () => {
    /**
     * The coupling T663 names. The synthesized target is the project's shape now, and a
     * projection built at aspect 1 into a wide target renders stretched — silently,
     * because it still looks like a picture. §V461: the fixture is WIDE, so "used the
     * basis" and "assumed square" give different numbers.
     */
    const wide = { ...POINTS, aspect: 16 / 9 };
    expect(orbitViewProjection(wide, DEFAULT_PREVIEW_ORBIT)).toEqual(
      Array.from(viewProjection([1.7, 1.2, 2.4], [0, 0, 0], { aspect: 16 / 9 })),
    );
    expect(orbitViewProjection(wide, DEFAULT_PREVIEW_ORBIT)).not.toEqual(
      orbitViewProjection(POINTS, DEFAULT_PREVIEW_ORBIT),
    );
    // And it survives a real gesture: zoom and pan go through the same projection.
    const moved = { ...DEFAULT_PREVIEW_ORBIT, azimuth: 0.4, distance: 0.7, panX: 0.2 };
    expect(orbitViewProjection(wide, moved)).not.toEqual(orbitViewProjection(POINTS, moved));
  });

  it("pan clamps, so the object cannot be pushed off frame and lost", () => {
    const far = orbitPose(BALL, { ...DEFAULT_PREVIEW_ORBIT, panX: 50 });
    expect(far.lookAt[0]).toBeCloseTo(2 * 2.6, 10);
  });
});
