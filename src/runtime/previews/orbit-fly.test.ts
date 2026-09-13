import { describe, expect, it } from "vitest";
import {
  DEFAULT_PREVIEW_ORBIT,
  clampOrbitFly,
  isDefaultOrbit,
  orbitFrame,
  orbitPose,
} from "./orbit.ts";
import type { OrbitCameraBasis, PreviewOrbit } from "./orbit.ts";
import { FLY_BOOST, FLY_RADII_PER_SECOND, flyDeltaFor, flyStepFor } from "@editor/viewer/orbit-gestures.ts";

/**
 * §T1311b(b) — **ORBIT IS NOT FLY**, asserted rather than asserted-in-a-comment.
 *
 * The viewer has orbited, zoomed, homed and framed content since §T379, and this row was
 * mis-scoped three times by people who looked at that working orbit and marked "proper
 * controls like blender" done. So the load-bearing test in this file is not "fly moves the
 * camera" — it is the one that shows WHAT ORBIT CANNOT DO, because that is the whole reason
 * a second interaction exists (§V997: assert what must be TRUE, not that something is
 * absent). If someone later re-implements fly as a bigger pan or an unclamped dolly, the
 * geometry test below fails on its own signature and the rest of the file still passes.
 */

/** A camera 6 units back from the origin, looking down +z at it — E68's shape, simplified. */
const BASIS: OrbitCameraBasis = {
  eye: [0, 1.6, -6],
  lookAt: [0, 1.6, 0],
  fovY: 1.06,
  aspect: 16 / 9,
};

/** Home radius, so a "radii" figure below reads as the distance it actually is. */
const RADIUS = 6;

function sub(a: readonly number[], b: readonly number[]): [number, number, number] {
  return [a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!];
}
function dot(a: readonly number[], b: readonly number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

describe("the fly offset in the inspection orbit", () => {
  it("is absent by default, and an untouched camera is still the baked pose float for float", () => {
    expect(DEFAULT_PREVIEW_ORBIT.fly).toBeUndefined();
    expect(isDefaultOrbit(DEFAULT_PREVIEW_ORBIT)).toBe(true);
    const pose = orbitPose(BASIS, DEFAULT_PREVIEW_ORBIT);
    // §V528's identity short-circuit: the SAME numbers, not merely close ones.
    expect(pose.eye).toEqual(BASIS.eye);
    expect(pose.lookAt).toEqual(BASIS.lookAt);
  });

  it("is not the identity once it exists, even at zero — absence is the only untouched state", () => {
    // A zero triple would take the long path through the spherical round-trip and lose the
    // float-exact baked pose above for nothing. `undefined` is the one spelling of "home".
    expect(isDefaultOrbit({ ...DEFAULT_PREVIEW_ORBIT, fly: [0, 0, 0] })).toBe(false);
  });

  it("translates the eye AND the look-at by the same vector — the heading survives", () => {
    /*
     * This is what makes it a FLY and not a pan-plus-dolly: the rig moves as one body, so
     * the direction the camera points and its distance to its own target are untouched. If
     * only the eye moved, forward motion would converge on the author's target and stop
     * being flight the moment you reached it.
     */
    const flown = orbitPose(BASIS, { ...DEFAULT_PREVIEW_ORBIT, fly: [0.5, -0.25, 1] });
    const eyeMoved = sub(flown.eye, BASIS.eye);
    const lookAtMoved = sub(flown.lookAt, BASIS.lookAt);
    for (const axis of [0, 1, 2] as const) {
      expect(eyeMoved[axis]).toBeCloseTo(lookAtMoved[axis], 12);
    }
    // In world units: one radius of fly is one stock radius travelled.
    expect(lookAtMoved[0]).toBeCloseTo(0.5 * RADIUS, 12);
    expect(lookAtMoved[1]).toBeCloseTo(-0.25 * RADIUS, 12);
    expect(lookAtMoved[2]).toBeCloseTo(1 * RADIUS, 12);
  });

  it("⚑ LEAVES THE AUTHOR'S NEIGHBOURHOOD — the thing no orbit value can do", () => {
    /*
     * THE ROW'S ENTIRE POINT, AS A NUMBER, and the first draft of this test got it wrong in
     * an instructive way: "fly reaches the far side of the target" is FALSE as a
     * distinguisher, because `azimuth = π` reaches the far side too. An orbit can look at
     * the author's subject from anywhere; what it cannot do is look at something ELSE.
     *
     * Every fence in `orbitPose` is measured from the author's own look-at: pan clamps at
     * ±2 radii, `distance` at [0.2, 5]×, elevation short of the poles. So an orbit — all of
     * it, every combination — is confined to a bounded neighbourhood of the one point the
     * compiler framed, and the LOOK-AT specifically cannot leave a ball of 2√2 radii around
     * it. That is exactly the owner's "stuck": correct for inspecting an object, useless for
     * exploring a room, and the reason fly is a second interaction rather than a bigger one.
     *
     * Asserted as the WORST CASE over a sweep of the extremes, so it is a property of the
     * fences rather than of five lucky samples.
     */
    const homeLookAt = BASIS.lookAt;
    const distanceFromHome = (point: readonly number[]): number =>
      Math.hypot(...sub(point, homeLookAt));

    let farthestLookAt = 0;
    let farthestEye = 0;
    for (const distance of [0.2, 0.5, 1, 2, 5]) {
      for (const panX of [-2, 0, 2]) {
        for (const panY of [-2, 0, 2]) {
          for (const azimuth of [0, 0.7, Math.PI / 2, Math.PI, -1.9]) {
            for (const elevation of [-1.49, -0.4, 0, 0.4, 1.49]) {
              const pose = orbitPose(BASIS, { azimuth, elevation, distance, panX, panY });
              farthestLookAt = Math.max(farthestLookAt, distanceFromHome(pose.lookAt));
              farthestEye = Math.max(farthestEye, distanceFromHome(pose.eye));
            }
          }
        }
      }
    }
    // MAX_PAN (2) radii on each of two screen axes, and no more, however you drag.
    expect(farthestLookAt).toBeLessThanOrEqual(2 * Math.SQRT2 * RADIUS + 1e-9);
    // MAX_DISTANCE (5) radii on top of that, and no more, however you scroll.
    expect(farthestEye).toBeLessThanOrEqual((5 + 2 * Math.SQRT2) * RADIUS + 1e-9);

    // The flight walks straight out of both bounds, which is the whole feature. Twenty
    // radii forward is 120 units down a hall whose author framed six.
    const flown = orbitPose(BASIS, { ...DEFAULT_PREVIEW_ORBIT, fly: [0, 0, 20] });
    expect(distanceFromHome(flown.lookAt)).toBeCloseTo(20 * RADIUS, 9);
    // Looking at somewhere no drag could ever have pointed...
    expect(distanceFromHome(flown.lookAt)).toBeGreaterThan(farthestLookAt * 5);
    // ...and standing somewhere no drag-and-scroll could ever have stood.
    expect(distanceFromHome(flown.eye)).toBeGreaterThan(farthestEye * 3);
    // And it is genuinely PAST what the author aimed at, looking further on — the same
    // heading, six times the author's whole framing beyond their subject.
    const forward = sub(BASIS.lookAt, BASIS.eye); // +z here
    expect(dot(sub(flown.eye, homeLookAt), forward)).toBeGreaterThan(0);
    expect(flown.eye[2]).toBeCloseTo(114, 9);
  });

  it("composes with the orbit: a drag after a flight turns around where you flew to", () => {
    /*
     * The gesture a user actually makes — fly over there, then look around from there. If
     * the flight were applied BEFORE the orbit deltas (or re-resolved against the author's
     * basis), the drag would swing the camera back around the author's target and the
     * flight would read as a rubber band.
     */
    const flown: PreviewOrbit = { ...DEFAULT_PREVIEW_ORBIT, fly: [0, 0, 2] };
    const flownThenTurned: PreviewOrbit = { ...flown, azimuth: 0.9 };
    const turned = orbitPose(BASIS, flownThenTurned);
    const still = orbitPose(BASIS, flown);
    // The look-at did not move: an orbit turns about its target, and the flight put that
    // target six units past the origin.
    expect(turned.lookAt[0]).toBeCloseTo(still.lookAt[0], 9);
    expect(turned.lookAt[2]).toBeCloseTo(still.lookAt[2], 9);
    expect(still.lookAt[2]).toBeCloseTo(12, 9);
    // ...and the eye went round it at the unchanged radius, rather than back to the author's.
    const radius = Math.hypot(...sub(turned.eye, turned.lookAt));
    expect(radius).toBeCloseTo(RADIUS, 9);
    expect(turned.eye[0]).not.toBeCloseTo(still.eye[0], 3);
  });

  it("refuses a non-finite offset by returning absent, never a substituted zero", () => {
    // §V986. A NaN eye is a black frame nobody can home out of; a dropped delta is a camera
    // that simply did not move, which the user can see and correct.
    expect(clampOrbitFly([Number.NaN, 0, 0])).toBeUndefined();
    expect(clampOrbitFly([0, Infinity, 0])).toBeUndefined();
    expect(clampOrbitFly([1, 2, 3])).toEqual([1, 2, 3]);
    // A runaway guard, not a fence: far past anywhere anybody explores.
    expect(clampOrbitFly([1e9, -1e9, 0])).toEqual([1000, -1000, 0]);
  });
});

describe("the fly gesture's arithmetic", () => {
  const frame = orbitFrame({ eye: BASIS.eye, lookAt: BASIS.lookAt });

  it("points W down the view direction and not away from it", () => {
    /*
     * The sign bug that is invisible to a call-site audit: every key "works", the camera
     * moves, and W simply walks you backwards out of the room. `back` is eye − lookAt, so
     * forward is its negative — here, +z.
     */
    expect(frame.back[2]).toBeCloseTo(-1, 12);
    const forward = flyDeltaFor(["forward"], 1, frame);
    expect(forward).not.toBeNull();
    expect(forward![2]).toBeCloseTo(FLY_RADII_PER_SECOND, 12);
    const backward = flyDeltaFor(["back"], 1, frame);
    expect(backward![2]).toBeCloseTo(-FLY_RADII_PER_SECOND, 12);
    // Right is the camera's own right: looking down +z with +y up, that is −x.
    const right = flyDeltaFor(["right"], 1, frame);
    expect(right![0]).toBeCloseTo(-FLY_RADII_PER_SECOND, 12);
    const up = flyDeltaFor(["up"], 1, frame);
    expect(up![1]).toBeCloseTo(FLY_RADII_PER_SECOND, 12);
  });

  it("holds a diagonal at cruise speed — two keys are a heading, not a bonus", () => {
    const straight = flyDeltaFor(["forward"], 1, frame)!;
    const diagonal = flyDeltaFor(["forward", "right"], 1, frame)!;
    const speed = (v: readonly number[]): number => Math.hypot(v[0]!, v[1]!, v[2]!);
    expect(speed(diagonal)).toBeCloseTo(speed(straight), 12);
    // And it really is diagonal, not silently one of the two.
    expect(Math.abs(diagonal[0]!)).toBeGreaterThan(0.1);
    expect(Math.abs(diagonal[2]!)).toBeGreaterThan(0.1);
  });

  it("returns absent for held keys that cancel, rather than writing a zero flight", () => {
    expect(flyDeltaFor(["forward", "back"], 1, frame)).toBeNull();
    expect(flyDeltaFor([], 1, frame)).toBeNull();
    expect(flyDeltaFor(["forward"], 0, frame)).toBeNull();
  });

  it("scales with elapsed time and with the shift throttle", () => {
    const tenth = flyDeltaFor(["forward"], 0.1, frame)!;
    const second = flyDeltaFor(["forward"], 1, frame)!;
    expect(tenth[2]! * 10).toBeCloseTo(second[2]!, 12);
    const boosted = flyDeltaFor(["forward"], 0.1, frame, { boost: true })!;
    expect(boosted[2]!).toBeCloseTo(tenth[2]! * FLY_BOOST, 12);
  });

  it("gives a discrete step the same arithmetic a held key integrates", () => {
    // One invocation is one short press, not a second formula that could drift from it.
    const step = flyStepFor("forward", frame)!;
    const held = flyDeltaFor(["forward"], 0.18 / FLY_RADII_PER_SECOND, frame)!;
    expect(step).toEqual(held);
    expect(step[2]).toBeCloseTo(0.18, 12);
  });
});
