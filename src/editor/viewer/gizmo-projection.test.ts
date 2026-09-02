import { describe, expect, it } from "vitest";
import { DEFAULT_PREVIEW_ORBIT } from "@runtime/previews/index.ts";
import type { OrbitCameraBasis } from "@runtime/previews/index.ts";
import { handleScreenPoint, pointerToPlane, tileCamera } from "./gizmo-projection.ts";
import type { PictureRect } from "./gizmo-projection.ts";

/**
 * T935 — the placement is DERIVED, and the drag is its exact inverse ON ONE PLANE.
 *
 * ## What this file has to be able to fail
 *
 * The expensive failure here is not "the handle is in the wrong place" — that is visible.
 * It is a handle that is placed by one derivation and dragged by another, so it tracks the
 * pointer while it is moving and lands somewhere else when the frame catches up. That is
 * unfalsifiable by eye at 60 Hz and it is exactly what makes a gizmo feel untrustworthy.
 *
 * So the load-bearing test is the ROUND TRIP, and it is only worth anything because the two
 * halves are independently derived: `handleScreenPoint` multiplies the tile's matrix and
 * divides by w, while `pointerToPlane` never touches the matrix at all — it rebuilds the
 * camera basis from the pose and uses similar triangles. Inverting one function to write
 * the other would make this suite agree with itself and prove nothing.
 *
 * The other assertions are stated as ARITHMETIC, never as recorded numbers: the expected
 * NDC is computed here from `1 / tan(fovY / 2)` and the frame's own aspect, so a change to
 * the projection convention (§V198's published order, the [0,1] depth range) fails here
 * rather than being re-baked into a fixture.
 */

/** The stock ball rig every scene-payload preview shares (`compiler/preview-orbit.ts`). */
const BASIS: OrbitCameraBasis = {
  eye: [0, 0, 2.6],
  lookAt: [0, 0, 0],
  fovY: Math.PI / 4,
  near: 0.1,
  far: 10,
  aspect: 1,
};

/** Neither square-at-the-origin nor centred on it, so a dropped term cannot pass. */
const RECT: PictureRect = { x: 100, y: 50, width: 200, height: 200 };

const camera = tileCamera(BASIS, undefined);

/** Half the frame's height at unit depth — the one constant both halves are built on. */
const halfAtUnitDepth = Math.tan((BASIS.fovY ?? 0) / 2);

/** The expected screen point, from the perspective relation and nothing else. */
function expected(world: readonly [number, number, number]): { x: number; y: number } {
  const depth = BASIS.eye[2] - world[2];
  const ndcX = world[0] / (depth * halfAtUnitDepth * (BASIS.aspect ?? 1));
  const ndcY = world[1] / (depth * halfAtUnitDepth);
  return {
    x: RECT.x + (ndcX * 0.5 + 0.5) * RECT.width,
    y: RECT.y + (0.5 - ndcY * 0.5) * RECT.height,
  };
}

describe("T935 — a handle is projected through the tile's OWN camera", () => {
  it("puts the look-at point in the middle of the picture", () => {
    const point = handleScreenPoint(camera, [0, 0, 0], RECT);
    expect(point.visible).toBe(true);
    expect(point.x).toBeCloseTo(200, 5);
    expect(point.y).toBeCloseTo(150, 5);
  });

  it("places an off-centre point where the perspective relation says, with y DOWN", () => {
    // Deliberately three different components, and a positive world y: screen y grows
    // downward, so a sign slip in the NDC flip cannot survive this.
    const world: readonly [number, number, number] = [0.4, 0.25, -0.6];
    const point = handleScreenPoint(camera, world, RECT);
    const want = expected(world);
    expect(point.x).toBeCloseTo(want.x, 4);
    expect(point.y).toBeCloseTo(want.y, 4);
    expect(point.y).toBeLessThan(150);
    expect(point.x).toBeGreaterThan(200);
  });

  it("scales with DISTANCE — the same offset is smaller further from the eye", () => {
    const near = handleScreenPoint(camera, [0.3, 0, 1], RECT);
    const far = handleScreenPoint(camera, [0.3, 0, -3], RECT);
    expect(near.x - 200).toBeGreaterThan(far.x - 200);
  });

  it("reports NOT VISIBLE behind the eye and outside the frame", () => {
    // Behind: w <= 0, where the divide would fold the point back onto the picture.
    expect(handleScreenPoint(camera, [0, 0, 4], RECT).visible).toBe(false);
    // Off the side: in front, projectable, and nowhere on this rectangle.
    const off = handleScreenPoint(camera, [8, 0, 0], RECT);
    expect(off.visible).toBe(false);
    expect(Number.isFinite(off.x)).toBe(true);
  });

  it("MOVES WITH THE CAMERA — an orbit is the only input that changed", () => {
    const orbited = tileCamera(BASIS, { ...DEFAULT_PREVIEW_ORBIT, azimuth: 0.6 });
    // OFF the orbit axis on purpose: a point on it would be unmoved by azimuth and the
    // assertion would be measuring nothing. The world value is byte-identical in both
    // calls, so only the camera can have moved the pixel — which is what a handle that
    // tracked a stored screen position instead of deriving one would fail to do.
    const world: readonly [number, number, number] = [0.6, 0.2, 0];
    const still = handleScreenPoint(camera, world, RECT);
    const moved = handleScreenPoint(orbited, world, RECT);
    expect(moved.x).not.toBeCloseTo(still.x, 2);
    expect(still.visible).toBe(true);
    expect(moved.visible).toBe(true);
  });
});

describe("T935(c) — the drag is confined to the camera-facing plane through the value", () => {
  const current: readonly [number, number, number] = [0.2, -0.1, 0.3];

  it("ROUND TRIPS: unprojecting a pixel and reprojecting it returns that pixel", () => {
    // The gate. Two independent derivations — matrix multiply vs camera basis — have to
    // land on the same point, at several places in the frame including its corners.
    for (const pointer of [
      { x: 200, y: 150 },
      { x: 120, y: 60 },
      { x: 290, y: 240 },
      { x: 101, y: 249 },
    ]) {
      const world = pointerToPlane(camera, current, RECT, pointer);
      const back = handleScreenPoint(camera, world, RECT);
      expect(back.x).toBeCloseTo(pointer.x, 3);
      expect(back.y).toBeCloseTo(pointer.y, 3);
    }
  });

  it("ROUND TRIPS THROUGH AN ORBITED CAMERA TOO — the basis is not hard-coded", () => {
    // With elevation as well as azimuth, so the `up` vector is genuinely rebuilt rather
    // than accidentally still being world up.
    const orbited = tileCamera(BASIS, {
      ...DEFAULT_PREVIEW_ORBIT,
      azimuth: 0.9,
      elevation: -0.4,
      distance: 1.3,
    });
    const pointer = { x: 155, y: 195 };
    const world = pointerToPlane(orbited, current, RECT, pointer);
    const back = handleScreenPoint(orbited, world, RECT);
    expect(back.x).toBeCloseTo(pointer.x, 3);
    expect(back.y).toBeCloseTo(pointer.y, 3);
  });

  it("KEEPS THE DEPTH the value already had — that is the whole constraint", () => {
    /*
     * §T935(c): a 2D pointer cannot determine a 3D point, so the third number comes from
     * the value being dragged and not from the pointer. Measured as the view depth — the
     * distance along the camera's forward axis — which is the quantity the plane fixes.
     * A free 3D drag would let this wander, and the wander is what makes such a gizmo
     * feel worse than a slider.
     */
    const forward = [
      BASIS.lookAt[0] - BASIS.eye[0],
      BASIS.lookAt[1] - BASIS.eye[1],
      BASIS.lookAt[2] - BASIS.eye[2],
    ];
    const length = Math.hypot(forward[0] ?? 0, forward[1] ?? 0, forward[2] ?? 0);
    const depthOf = (p: readonly [number, number, number]): number =>
      ((p[0] - BASIS.eye[0]) * (forward[0] ?? 0) +
        (p[1] - BASIS.eye[1]) * (forward[1] ?? 0) +
        (p[2] - BASIS.eye[2]) * (forward[2] ?? 0)) /
      length;

    const before = depthOf(current);
    for (const pointer of [
      { x: 110, y: 60 },
      { x: 280, y: 230 },
    ]) {
      const world = pointerToPlane(camera, current, RECT, pointer);
      expect(depthOf(world)).toBeCloseTo(before, 6);
      // And it genuinely moved in the other two: a constraint that pinned everything
      // would also pass the assertion above.
      expect(world[0]).not.toBeCloseTo(current[0], 3);
      expect(world[1]).not.toBeCloseTo(current[1], 3);
    }
  });

  it("HOLDS STILL rather than exploding where the plane is not addressable", () => {
    // A value on the eye plane has no finite scale, and a rect with no area has no
    // mapping. Both return the value unchanged — the drag stops, nothing leaps.
    expect(pointerToPlane(camera, [0, 0, 2.6], RECT, { x: 120, y: 90 })).toEqual([0, 0, 2.6]);
    expect(
      pointerToPlane(camera, current, { ...RECT, width: 0 }, { x: 120, y: 90 }),
    ).toEqual(current);
  });
});
