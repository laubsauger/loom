/**
 * T741 — E42 CURRENT: the video as an ORIENTED FIELD, and T723's first witness.
 *
 * A fixed grid of instanced tiles covers the frame. Each tile reads the packed field's
 * MOTION alpha at four taps around its own site, builds the local gradient, and:
 *
 *  - TURNS about +Z so its edges align with the flow direction (atan2 of the gradient),
 *  - LEANS about the in-plane axis perpendicular to the flow, by an angle that grows
 *    with the magnitude — so a raking key light shades a swept region differently from
 *    a calm one, and the orientation is visible as SHADING, not only silhouette. This
 *    is what makes a QUATERNION worth witnessing over a flat sprite angle: the two
 *    turns COMPOSE (q = spin ⊗ lean), which Euler angles cannot do and a bare
 *    direction cannot carry (T723's own reasoning, exercised).
 *
 * Where nothing moves, the gradient is below epsilon and the tile holds the IDENTITY
 * quaternion exactly — a calm mosaic of the picture — which is what current-claims
 * asserts against the buffer, alongside the §V683 comparison of the written
 * quaternions with the gradient computed in float64 from the same field, and §V712's
 * mutation made deliberate: flip the gradient's sign and every tile turns half around
 * while a look baseline reads the same.
 *
 * The convention is the draw's, quoted from its own doc (§V683: pin the domain fact,
 * never re-derive): xyzw with w last, right-handed and ACTIVE — (0, 0, sin45, cos45)
 * is a +90° turn about +Z and carries +X to +Y.
 */

export const CURRENT_ASPECT = 16 / 9;
export const CURRENT_COLS = 48;
export const CURRENT_ROWS = 27;
/** Gradient tap half-step, in clip units — one tile pitch, so the reading is local. */
export const CURRENT_TAP = 0.04;
/** |gradient| below this is CALM: identity orientation, exactly (the claims pin it). */
export const CURRENT_EPSILON = 0.07;
/** Radians of lean at full magnitude — visibly shaded under the raking key, still a tile. */
export const CURRENT_LEAN = 0.9;

export const CURRENT_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "orient", type: "vec4f", qualifier: "quaternion", default: [0, 0, 0, 1] },
]);

export const CURRENT_KERNEL = `const ASPECT: f32 = ${CURRENT_ASPECT};
const TAP: f32 = ${CURRENT_TAP};
const EPSILON: f32 = ${CURRENT_EPSILON};
const LEAN: f32 = ${CURRENT_LEAN};

fn axisAngle(axis: vec3f, angle: f32) -> vec4f {
  return vec4f(axis * sin(angle * 0.5), cos(angle * 0.5));
}

/* Hamilton product, (a ⊗ b): apply b first, then a — matching the draw's ACTIVE
   right-handed qrot. */
fn qmul(a: vec4f, b: vec4f) -> vec4f {
  return vec4f(
    a.w * b.xyz + b.w * a.xyz + cross(a.xyz, b.xyz),
    a.w * b.w - dot(a.xyz, b.xyz),
  );
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* The grid hands in clip-space xy each frame; the tile SITE is fixed. */
  let sx = p.position.x;
  let sy = p.position.y;

  let gx = fieldAt(vec3f(sx + TAP, sy, 0.0)).a - fieldAt(vec3f(sx - TAP, sy, 0.0)).a;
  let gy = fieldAt(vec3f(sx, sy + TAP, 0.0)).a - fieldAt(vec3f(sx, sy - TAP, 0.0)).a;
  let magnitude = length(vec2f(gx, gy));
  let here = fieldAt(vec3f(sx, sy, 0.0));

  /* Display space for the draw: field x stretches by the frame's aspect. */
  q.position = vec3f(sx * ASPECT, sy, 0.0);
  /* The picture itself rides the tiles; w is the size channel (T721): calm tiles are
     small facets of the image, swept tiles swell with the motion under them. */
  q.tint = vec4f(here.rgb * 0.9 + vec3f(0.05), clamp(0.85 + magnitude * 2.6, 0.85, 2.4));

  if (magnitude < EPSILON) {
    /* CALM: the identity, EXACTLY — asserted by the claims, and the difference
       between "still means still" and a floor of jitter nobody chose. */
    q.orient = vec4f(0.0, 0.0, 0.0, 1.0);
    return q;
  }

  /* SPIN the tile's edges into the flow, then LEAN it about the in-plane axis
     perpendicular to the flow so its normal tips ALONG the motion — the raking key
     reads that lean as shading. Composition order: lean first, spin second. */
  let angle = atan2(gy, gx);
  let spin = axisAngle(vec3f(0.0, 0.0, 1.0), angle);
  let lean = axisAngle(vec3f(0.0, 1.0, 0.0), clamp(magnitude * 3.0, 0.0, 1.0) * LEAN);
  q.orient = qmul(spin, lean);
  return q;
}`;
