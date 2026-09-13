import { describe, expect, it } from "vitest";
import { DEFAULT_PREVIEW_ORBIT, orbitPose } from "@runtime/previews/index.ts";
import type { OrbitCameraBasis, PreviewOrbit } from "@runtime/previews/index.ts";
import { axisGizmoMarks, axisSnapDelta, axisSnapPose } from "./axis-gizmo.ts";
import type { AxisMark, GizmoAxis } from "./axis-gizmo.ts";

/**
 * §T1311b(c) — the corner gizmo's two jobs, each asserted against something that is NOT
 * this module's own arithmetic.
 *
 * The display half is checked against a hand-derived orientation (a camera on +Z looking at
 * the origin sees +X to the right and +Y up — no code required to know that). The control
 * half is checked against the pose `orbitPose` actually produces, by the independent
 * definition of the thing the user asked for: after clicking "+X", the unit vector from the
 * target to the eye IS +X. A test that re-derived the expected azimuth with this module's
 * own inverse would agree with itself and prove nothing, and `orbitPose`'s atan2(x, z)
 * convention is precisely where a sign error would hide.
 */

/** A camera on +Z looking at the origin: the textbook orientation, and the test's ruler. */
const FRONT: OrbitCameraBasis = { eye: [0, 0, 5], lookAt: [0, 0, 0] };
/**
 * A deliberately awkward one — off every axis, off the origin, and at a different radius.
 * Every claim that holds for FRONT must hold here, because the compiler's published framing
 * for a real piece is never axis-aligned (E68's hall is not).
 */
const OBLIQUE: OrbitCameraBasis = { eye: [3.5, 2.25, -4.75], lookAt: [-1, 1.6, 0.5] };

const markOf = (marks: readonly AxisMark[], key: AxisMark["key"]): AxisMark => {
  const found = marks.find((mark) => mark.key === key);
  if (found === undefined) throw new Error(`no ${key} mark`);
  return found;
};

/** The unit vector from the target toward the eye — where the camera is STANDING. */
function heading(pose: { eye: readonly number[]; lookAt: readonly number[] }): readonly number[] {
  const d = [
    pose.eye[0]! - pose.lookAt[0]!,
    pose.eye[1]! - pose.lookAt[1]!,
    pose.eye[2]! - pose.lookAt[2]!,
  ];
  const length = Math.hypot(d[0]!, d[1]!, d[2]!);
  return d.map((v) => v / length);
}

describe("the corner gizmo shows which way the camera is facing", () => {
  it("puts +X right, +Y up and +Z at the viewer for a camera standing on +Z", () => {
    const marks = axisGizmoMarks(orbitPose(FRONT, DEFAULT_PREVIEW_ORBIT));
    // Right-positive, up-positive, viewer-positive. If any of the three were flipped the
    // widget would be a mirror of the picture, which is worse than no widget.
    expect(markOf(marks, "+x").x).toBeCloseTo(1, 6);
    expect(markOf(marks, "+x").y).toBeCloseTo(0, 6);
    expect(markOf(marks, "+y").y).toBeCloseTo(1, 6);
    expect(markOf(marks, "+z").depth).toBeCloseTo(1, 6);
    // And the far side is the far side: -Z points away, so it is drawn under +Z.
    expect(markOf(marks, "-z").depth).toBeCloseTo(-1, 6);
  });

  it("orders the balls FARTHEST FIRST so the near one paints over the far one", () => {
    const marks = axisGizmoMarks(orbitPose(OBLIQUE, DEFAULT_PREVIEW_ORBIT));
    expect(marks).toHaveLength(6);
    const depths = marks.map((mark) => mark.depth);
    expect(depths).toEqual([...depths].sort((a, b) => a - b));
    // Opposite axes are exact opposites — a cheap check that the six are one basis and
    // not six independent guesses.
    for (const axis of ["x", "y", "z"] as const) {
      const plus = markOf(marks, `+${axis}`);
      const minus = markOf(marks, `-${axis}`);
      expect(minus.x).toBeCloseTo(-plus.x, 6);
      expect(minus.y).toBeCloseTo(-plus.y, 6);
      expect(minus.depth).toBeCloseTo(-plus.depth, 6);
    }
  });

  it("⚑ FOLLOWS THE FLY, which is the gesture a stale widget would fail on", () => {
    /*
     * A flight translates the whole rig without turning it, so the ORIENTATION is
     * unchanged and the widget must not move. Asserted because the obvious wrong
     * implementation — project the world axes from the ORIGIN through the view matrix —
     * would swing every ball as the camera walked past the origin, and the user would
     * read that as "the world turned" while the picture said otherwise.
     */
    const still = axisGizmoMarks(orbitPose(OBLIQUE, DEFAULT_PREVIEW_ORBIT));
    const flown = axisGizmoMarks(
      orbitPose(OBLIQUE, { ...DEFAULT_PREVIEW_ORBIT, fly: [4, -1.5, 6] }),
    );
    for (const mark of still) {
      const same = markOf(flown, mark.key);
      expect(same.x).toBeCloseTo(mark.x, 6);
      expect(same.y).toBeCloseTo(mark.y, 6);
      expect(same.depth).toBeCloseTo(mark.depth, 6);
    }
    // But an ORBIT does move it — otherwise the claim above would also pass on a widget
    // that is simply frozen (§V968: validate the detector against a known positive).
    const orbited = axisGizmoMarks(
      orbitPose(OBLIQUE, { ...DEFAULT_PREVIEW_ORBIT, azimuth: 1.1 }),
    );
    const swing = still.reduce((total, mark) => {
      const moved = markOf(orbited, mark.key);
      return total + Math.hypot(moved.x - mark.x, moved.y - mark.y, moved.depth - mark.depth);
    }, 0);
    expect(swing).toBeGreaterThan(1);
  });
});

describe("clicking a ball stands the camera on that world axis", () => {
  const expected: Readonly<Record<AxisMark["key"], readonly number[]>> = {
    "+x": [1, 0, 0],
    "-x": [-1, 0, 0],
    "+y": [0, 1, 0],
    "-y": [0, -1, 0],
    "+z": [0, 0, 1],
    "-z": [0, 0, -1],
  };

  for (const basisName of ["FRONT", "OBLIQUE"] as const) {
    const basis = basisName === "FRONT" ? FRONT : OBLIQUE;
    for (const axis of ["x", "z"] as const) {
      for (const positive of [true, false]) {
        const key: AxisMark["key"] = `${positive ? "+" : "-"}${axis}`;
        it(`${basisName}: ${key} puts the eye on ${key}`, () => {
          const pose = axisSnapPose(basis, DEFAULT_PREVIEW_ORBIT, { axis, positive });
          const want = expected[key];
          heading(pose).forEach((component, index) => {
            expect(component).toBeCloseTo(want[index]!, 6);
          });
        });
      }
    }
  }

  it("⚑ SAYS SO AFTERWARDS: the clicked ball comes to face the viewer", () => {
    /*
     * The round trip between this module's two halves, and the only claim that can catch
     * them disagreeing — a snap that is right and a projection that is mirrored would each
     * pass their own test above. After clicking +X the widget must show +X pointing at the
     * eye, or the instrument contradicts the picture it labels (§V964's class).
     */
    for (const axis of ["x", "y", "z"] as const) {
      for (const positive of [true, false]) {
        const pose = axisSnapPose(OBLIQUE, DEFAULT_PREVIEW_ORBIT, { axis, positive });
        const marks = axisGizmoMarks(pose);
        const clicked = markOf(marks, `${positive ? "+" : "-"}${axis}` as AxisMark["key"]);
        // ±Y is the clamped pair (below), so a pole click lands 0.08 rad short — cos(0.08)
        // = 0.9968. Every other click is exact.
        expect(clicked.depth).toBeGreaterThan(axis === "y" ? 0.996 : 0.999999);
        // ...and it is the NEAREST ball, which is what "facing the viewer" means for a
        // painter's-algorithm widget: it is drawn last.
        expect(marks[marks.length - 1]?.key).toBe(clicked.key);
      }
    }
  });

  it("keeps the dolly and the flight — a snap sets the DIRECTION, not the position", () => {
    const explored: PreviewOrbit = {
      ...DEFAULT_PREVIEW_ORBIT,
      distance: 2.5,
      fly: [1.5, 0, -3],
      azimuth: 0.7,
      elevation: -0.3,
    };
    const before = orbitPose(OBLIQUE, explored);
    const after = axisSnapPose(OBLIQUE, explored, { axis: "x", positive: true });
    const span = (pose: { eye: readonly number[]; lookAt: readonly number[] }): number =>
      Math.hypot(
        pose.eye[0]! - pose.lookAt[0]!,
        pose.eye[1]! - pose.lookAt[1]!,
        pose.eye[2]! - pose.lookAt[2]!,
      );
    // Same distance from the same pivot: the user's 2.5× dolly and their flight down the
    // hall both survive. A snap that reset them would throw away the exploring this row
    // exists to enable.
    expect(span(after)).toBeCloseTo(span(before), 6);
    expect(after.lookAt).toEqual(before.lookAt);
    heading(after).forEach((component, index) => {
      expect(component).toBeCloseTo([1, 0, 0][index]!, 6);
    });
  });

  it("⚑ clicking the POLE lands ON the fence, not past it — no dead zone on the way back", () => {
    /*
     * `orbitPose` clamps elevation short of the poles on READ. If the snap computed its
     * delta against an unclamped π/2 the ACCUMULATOR would sit 0.08 rad beyond the fence,
     * and the first 0.08 rad of the next downward drag would move nothing — §T656's dead
     * zone, which is why `clampOrbitDistance` was exported in the first place.
     */
    const delta = axisSnapDelta(FRONT, DEFAULT_PREVIEW_ORBIT, { axis: "y", positive: true });
    const snapped: PreviewOrbit = { ...DEFAULT_PREVIEW_ORBIT, elevation: delta.elevation };
    const top = orbitPose(FRONT, snapped);
    // Looking down from just short of the pole: nearly all +Y, and NOT a gimbal flip.
    expect(heading(top)[1]).toBeCloseTo(Math.sin(Math.PI / 2 - 0.08), 6);
    // One nudge down moves immediately — the accumulator is on the fence, not past it.
    const nudged = orbitPose(FRONT, { ...snapped, elevation: snapped.elevation - 0.01 });
    expect(heading(nudged)[1]).toBeLessThan(heading(top)[1]! - 1e-4);
  });

  it("is a DELTA against whatever the user already did, not an absolute state", () => {
    // Two snaps to different axes from two different starting orbits must both land, which
    // is the property `apply`'s accumulate-only interface makes easy to get wrong.
    let orbit: PreviewOrbit = { ...DEFAULT_PREVIEW_ORBIT, azimuth: 2.2, elevation: 0.4 };
    for (const axis of ["z", "x", "z"] as const satisfies readonly GizmoAxis[]) {
      const delta = axisSnapDelta(OBLIQUE, orbit, { axis, positive: false });
      orbit = {
        ...orbit,
        azimuth: orbit.azimuth + delta.azimuth,
        elevation: orbit.elevation + delta.elevation,
      };
      const want = axis === "x" ? [-1, 0, 0] : [0, 0, -1];
      heading(orbitPose(OBLIQUE, orbit)).forEach((component, index) => {
        expect(component).toBeCloseTo(want[index]!, 6);
      });
    }
  });
});
