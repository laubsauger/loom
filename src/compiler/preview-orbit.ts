import type { ScenePayloadKind } from "../domain/types/scene.ts";

/**
 * T675 — THE ONE PLACE THAT DECIDES WHETHER A SYNTHESIZED PREVIEW CAN BE ORBITED.
 *
 * The owner's report was "cant use orbit or any camera controls here in this geometry
 * node… did we miss some of the point/geo/3d nodes in our pass to add that? imo this
 * should be something they inherit from a common thing or something right?".
 *
 * The first half of that was a false alarm — geometry HAS carried an orbit since T561 —
 * but the second half is the real finding and it is a structural one. Orbit capability
 * was decided in TWO hand-written branches in `compile.ts`: the pointset splat built one
 * unconditionally, and the scene preview built one behind a `payload.kind` ternary whose
 * fall-through arm was "everything else gets the ball rig". Two branches that must agree,
 * neither of which mentions the other, is the exact shape that produced T532's bug — a
 * fourth payload kind shipped with no preview at all and every suite stayed green,
 * because absence is not failure (§V437).
 *
 * So the decision is a TABLE, and the table is `satisfies Record<PreviewPayloadKind, …>`.
 * A fifth `ScenePayload` kind is then a TYPECHECK FAILURE here until someone states what
 * its preview's camera does — it cannot inherit a default by falling off the end of a
 * ternary, and it cannot be forgotten. `null` is the way a kind says "decided: no orbit",
 * which is why the camera's exclusion is written down rather than implied by a missing
 * branch. That is the difference between fixing this coverage hole and closing the class
 * of them, which is what the owner was actually asking for.
 */

/**
 * Everything a preview can synthesize a picture of. `pointset` is not a `ScenePayload` —
 * it is a point OUTPUT with its own splat pass — but it is previewed by the same
 * mechanism and it is orbited by the same store, so it belongs in the same table. Both
 * halves of the union are load-bearing: the scene half is proved exhaustive by
 * `SCENE_PAYLOAD_KINDS`, and the `pointset` member is what stops this table quietly
 * becoming scene-only again.
 */
export type PreviewPayloadKind = ScenePayloadKind | "pointset";

/** A stock framing, as the numbers `viewProjection` takes. Absent optics = the default. */
export interface PreviewOrbitRig {
  readonly eye: readonly [number, number, number];
  readonly fovY?: number;
  readonly near?: number;
  readonly far?: number;
}

/** The eye every pointset and geometry preview looks from (T373). */
export const POINTS_PREVIEW_EYE = [1.7, 1.2, 2.4] as const;

/**
 * T462: the stock rig every scene-payload preview shares. The camera looks straight
 * down -z, so the LIGHT stock's ball presents its centre texel to the viewer exactly —
 * which is what makes the §V147 pins arithmetic instead of screenshots.
 */
export const SCENE_PREVIEW_BALL_RIG = {
  eye: [0, 0, 2.6] as const,
  fovY: Math.PI / 4,
  near: 0.1,
  far: 10,
};

/**
 * The decision, one row per kind. Read `null` as "decided: this kind is not orbited",
 * never as "not implemented yet".
 *
 * §V632 — WHAT EACH ROW MEANT IN THE BRANCH IT CAME FROM, since collapsing branches can
 * silently promote an omission into a decision:
 *
 *  - `camera` was an EXPLICIT refusal in the scene branch and is carried over as one; the
 *    reasoning is on its row and predates this table (T561/T614).
 *  - `pointset` came from the OTHER branch, which had no refusal case at all — every
 *    pointset preview got an orbit unconditionally. That is unchanged, now stated.
 *  - `geometry` was an explicit special case, for its framing rather than its capability.
 *  - `light` and `material` were NOT decided. They reached the ball rig by falling off the
 *    end of a ternary, along with every kind that did not exist yet. Their rig is the same
 *    rig they have always had — the VALUES are unchanged — but the fall-through that
 *    handed it to them is deleted, which is the whole point: the next kind gets a
 *    typecheck error where these two got a camera nobody chose for them.
 */
export const PREVIEW_ORBIT_RIGS = {
  /*
   * T561/T614/§T639(a) — a CAMERA payload is deliberately NOT orbitable. Its tile draws
   * through the payload's OWN matrix, so an inspection camera would override the one
   * thing the tile exists to show: the affordance would lie about what it is showing,
   * which is the same failure §T639(a) removed from the dive-in affordance.
   */
  camera: null,
  /* T704: same reasoning as the camera, one row down — a projector tile draws the stock
     scene through its OWN throw, and an inspection override would falsify the aim,
     shift and keystone it exists to show. (A document-writing gizmo, T692's shape, is
     the legitimate future control here, not an orbit.) */
  projector: null,
  /* The pointset splat and the geometry rig are the SAME framing, and that is not a
     coincidence to be maintained in two places: a geometry preview is the pointset
     framing with surfaces in it. One row, read by both call sites. */
  pointset: { eye: POINTS_PREVIEW_EYE },
  geometry: { eye: POINTS_PREVIEW_EYE },
  /* The stock ball/torus rigs carry their own fovY and far plane, so the orbit has to
     reproduce those and not the default projection — T663's lesson one level down: an
     orbit through a projection the target does not share renders stretched. */
  light: SCENE_PREVIEW_BALL_RIG,
  material: SCENE_PREVIEW_BALL_RIG,
} as const satisfies Record<PreviewPayloadKind, PreviewOrbitRig | null>;

/** The camera basis a synthesis descriptor publishes, or undefined for a refused kind. */
export interface PreviewOrbitBasis {
  readonly eye: readonly [number, number, number];
  readonly lookAt: readonly [number, number, number];
  readonly fovY?: number;
  readonly near?: number;
  readonly far?: number;
  readonly aspect?: number;
  readonly passIds: ReadonlyArray<string>;
}

/**
 * The single site. Both synthesized-preview call sites in `compile.ts` route through
 * here, so "which kinds can be orbited" is one lookup and not a pair of branches.
 *
 * `aspect` is the synthesized TARGET's, always — the stock matrix in the passes is baked
 * at exactly this, so an identity orbit reproduces it float for float (T663).
 */
export function previewOrbitBasis(
  kind: PreviewPayloadKind,
  options: { aspect: number; passIds: ReadonlyArray<string> },
): PreviewOrbitBasis | undefined {
  const rig: PreviewOrbitRig | null = PREVIEW_ORBIT_RIGS[kind];
  if (rig === null) return undefined;
  return {
    eye: [...rig.eye],
    lookAt: [0, 0, 0],
    ...(rig.fovY === undefined ? {} : { fovY: rig.fovY }),
    ...(rig.near === undefined ? {} : { near: rig.near }),
    ...(rig.far === undefined ? {} : { far: rig.far }),
    aspect: options.aspect,
    passIds: options.passIds,
  };
}
