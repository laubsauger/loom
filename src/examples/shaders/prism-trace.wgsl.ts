/**
 * T718 — THE PRISM AS A TRACED RAY, not a picture of one.
 *
 * The owner's verdict on the previous optics, side by side with the reference: the
 * white shaft stopped at the entry face and the spectrum started at the exit face with
 * NOTHING between — entry and exit were connected by arithmetic but by no visible
 * geometry, and total internal reflection simply deleted a band. This kernel emits the
 * full three-segment path:
 *
 *   1. the incoming shaft, meeting the ENTRY face;
 *   2. the INTERNAL segment — visible, crossing the body at the refracted angle, which
 *      is neither the incoming nor the outgoing one;
 *   3. the exit fan — Snell again per wavelength, where dispersion is LARGE (T710
 *      measured dδ/dn rising at the exit face), opening AT the exit face.
 *
 * And the TIR branch is a PATH, not a deletion: a band whose exit-face incidence
 * exceeds the critical angle reflects off that face, crosses to the BASE, and leaves
 * there — which is what glass actually does, and why the acceptance criterion is
 * "move the beam and everything downstream follows" (§V683: the gate sweeps entry
 * angle and position against the analytic Snell prediction, never against this text).
 *
 * Everything is derived: entry point, entry angle, internal path, which face each
 * wavelength exits, exit angle, fan width. The only authored numbers are the prism
 * itself and the sweep range.
 *
 * ## The channels (T857 re-cut value3 and value4 — they no longer ADD)
 *
 *   value1 — the SWING's aim (0..1): entry angle sweeps THETA_HI → THETA_LO degrees.
 *            Unchanged since T710, and the numbers on every claim that pins it still
 *            mean what they meant: 0 is 62°, 1 is 37°.
 *   value2 — dispersive power: n runs N_RED → N_RED + value2 across the band.
 *   value3 — the POINTER's aim, on its own WIDER scale: 0 is HAND_HI, 1 is HAND_LO, and
 *            the same number walks the entry point along the face — past both ends of it.
 *   value4 — the pointer's AUTHORITY, before the gain: E13 feeds it the cursor's
 *            speed SQUARED, and `HAND_GAIN · value4` clamped to 0..1 is the blend
 *            weight. 0 (a cursor that has never moved) is the swing's own picture,
 *            exactly; 1 is the pointer's, outright. Nothing here is a sum.
 *
 * ## The aim, and why it is a BLEND rather than an addition (T857)
 *
 * It used to be `clamp(value1 + 0.55·value3, 0, 1)`, and the owner's complaint reads
 * straight off that line: a SQUARE lfo drives value1, so the auto term visits two aims
 * and SLAMS between them, and the pointer was a small delta riding on that jump — the
 * hand never had the aim, it only nudged one. And a sum of two 0..1 terms is bounded, so
 * no cursor position could reach the extremes, let alone aim the beam off the glass.
 *
 * So the two terms are mixed by the pointer's own activity instead. The swing is not
 * touched — the square, the slam and the two angles it visits are the example's
 * character (§T842: judge each term against ITS OWN intent) — it simply yields while a
 * hand is on the pointer and takes the aim back a couple of seconds after the hand
 * stops. The widening lives entirely in the POINTER's scale, which is where the
 * complaint was.
 *
 * ## The slots (T920: capacity = 2 + SLICES x BANDS x 3)
 *
 *   index 0 — incoming shaft (role 0: parallel ribbon, the centre ray's landing)
 *   index 1 — the ghost: the entry's Fresnel share off the MARCHED normal (role 0)
 *   index 2+ — the BEAM: k = index-2 decomposes as slice = k/(BANDS*3),
 *              band = (k%(BANDS*3))/3, leg = k%3. Leg 0 the interior (entry→first wall,
 *              the in-glass spread), leg 1 the TIR continuation (zero-length without
 *              TIR), leg 2 the exit ray. All role 1: soft additive light (T917), each
 *              1/SLICES bright so the sum is one beam.
 */
import { PRISM_EDGE, PRISM_HALF } from "./prism-geometry.ts";

export const PRISM_TRACE_KERNEL_HEAD = `const PI: f32 = 3.14159265358979323846;
/* The three faces of the cross-section, as outward normals sharing one inradius. */
const NR: vec2f = vec2f(0.86602540, 0.5);
const NL: vec2f = vec2f(-0.86602540, 0.5);
const ND: vec2f = vec2f(0.0, -1.0);
/* T758: the beams live INSIDE the body now (the cross-section's z spans ±0.55), so
   the transmissive front face draws OVER the interior segment and the thread is seen
   THROUGH the glass — absorption-tinted, edge-refracted. Before materialGlass this sat
   at 0.60, in front, so the opaque solid could not swallow the beams; a glass body
   inverts that reasoning: swallowing is the point. */
const ENTRY: f32 = -0.28;
/* T929: every open end runs OFF-FRAME (frustum half-extents 2.71 x 1.52 at z = 0). */
const SHAFT_LEN: f32 = 2.10;
const GHOST_LEN: f32 = 6.0;
const FAN_LEN: f32 = 6.5;
const N_RED: f32 = 1.50;
/* The SWING's band, unchanged since T710: two aims, 25 degrees apart, comfortably
   inside the glass and comfortably clear of the violet end's critical angle. */
const THETA_LO: f32 = 37.0;
const THETA_HI: f32 = 62.0;
/* T857 — THE POINTER'S OWN BAND, and it is wide on purpose. 84° is grazing on the
   entry face; 6° is near normal, deep inside the regime where the internal ray meets
   the exit face past its critical angle and leaves through the BASE instead. That used
   to be a reason to stop at 37 degrees - refract2 returned zero and the band vanished - and
   T718 removed the reason when it made TIR a drawn PATH rather than a deletion (§V750:
   a compensation for an absent capability is an artifact once the capability exists).
   The hand crosses the violet end's onset at 34.5° and the red end's at 27.9°, so
   between them the spectrum SPLITS across two faces, which no aim could reach before. */
/* T929 — THE LAMP. The cursor's x carries the light around the prism on a 240-degree
   arc (all faces, all incidences reachable by walking around, like holding the torch);
   its y slides the aim ACROSS the body — 0 aims at the INCENTER, which meets every face
   at its exact middle (the rest strike the owner asked for, by construction), and the
   far end carries the beam clear off the glass: the miss is the top of the y travel. */
const LAMP_R: f32 = 3.3;
/* Rest (0,0) is phi 185: the lamp level-left, a hair below the axis, striking the left
   face's centre at ~35 degrees — the classic left-in, spectrum-out-right card.
   T929b (owner: "reach all across and even next to / off the prism horizontally
   vertically"): the arc is a FULL TURN and the offset doubled — a one-sided offset from
   a 360-degree orbit reaches EVERY line in the plane, so any face, any incidence, and a
   genuine miss on any side are all under the cursor. The incenter rest is unchanged. */
const ARC_A: f32 = 185.0;
const ARC_B: f32 = -175.0;
const OFF_MAX: f32 = 1.9;
/* Speed² → authority. A cursor crossing a TWENTIETH of the frame in a second reads
   0.0025 here and clamps to 1: any deliberate move owns the aim outright, and a cursor
   that has never moved reads exactly 0. */
const HAND_GAIN: f32 = 400.0;
/* How far along the face the pointer walks the entry point, tip to tail. The face's
   half-length is RI·√3 = 0.658, so ±0.8 runs PAST both vertices — which is the state
   the owner asked for: the beam misses the glass. */

const ROOT3: f32 = 1.7320508;
/* T937 — from prism-geometry.ts, the ONE description (§V818). */
const HALF: f32 = ${PRISM_HALF};
const EDGE: f32 = ${PRISM_EDGE};
/* A missed beam has to still be a beam: it carries straight on past where the glass
   isn't, instead of stopping at a face it never met. */
const MISS_LEN: f32 = 7.0;

/* T920 — THE BEAM'S SAMPLING. SLICES rays across the drawn shaft's full width (2 x its
   0.006 half-width), BANDS wavelengths, three legs each (interior, TIR continuation,
   exit). Odd slice count so a CENTRE slice exists — the exact ray every pre-T920 gate
   measured. Brightness constants are per-beam: the additive draw sums the slices back. */
const SLICES: u32 = 9u;
const BANDS: u32 = 61u;
const APERTURE: f32 = 0.012;
const INTERIOR_GAIN: f32 = 0.55;
/* T941: the wedge is a partition of unity — the old 61 overlapping ribbons summed to
   roughly 3x the energy at every pixel, and the gain absorbs that factor now. */
const EXIT_GAIN: f32 = 4.5;

/* CAUCHY DISPERSION (T913): n(λ) = A + B/λ², the real curve, replacing linear-in-t.
   λ runs 0.7µm (red, t = 0) → 0.4µm (violet, t = 1). B is derived from the SPREAD the
   document asks for (value2 stays "total Δn across the band", so every measurement keeps
   its meaning) — and the curve is violet-heavy, which is the end of the spectrum the eye
   reads first and exactly what linear-in-t flattened. */
const LAMBDA_RED: f32 = 0.7;
const LAMBDA_VIOLET: f32 = 0.4;
fn cauchyN(t: f32, spread: f32) -> f32 {
  let lam = mix(LAMBDA_RED, LAMBDA_VIOLET, t);
  let invRed = 1.0 / (LAMBDA_RED * LAMBDA_RED);
  let k = 1.0 / (LAMBDA_VIOLET * LAMBDA_VIOLET) - invRed;
  return N_RED + (spread / k) * (1.0 / (lam * lam) - invRed);
}

/* Schlick with the band's OWN normal-incidence reflectance — R0 = ((n−1)/(n+1))². */
fn schlick(cosI: f32, n: f32) -> f32 {
  let r0root = (n - 1.0) / (n + 1.0);
  let r0 = r0root * r0root;
  return r0 + (1.0 - r0) * pow(1.0 - cosI, 5.0);
}

/* WGSL's own refract, in 2D. A zero return IS total internal reflection — and unlike
   the previous optics, TIR here selects the reflected path instead of deleting it. */
fn refract3(i: vec3f, n: vec3f, eta: f32) -> vec3f {
  let d = dot(n, i);
  let k = 1.0 - eta * eta * (1.0 - d * d);
  if (k < 0.0) { return vec3f(0.0); }
  return i * eta - n * (eta * d + sqrt(k));
}

fn reflect3(i: vec3f, n: vec3f) -> vec3f {
  return i - n * (2.0 * dot(i, n));
}

/* T920 — THE BOUNDARY IS THE BODY'S OWN CROSS-SECTION, bevel included; T937 lifts it to
   the full solid. sdBody2 is the rounded-triangle cross-section the T920 gates march;
   sdBody3 is form1's swept shape EXACTLY — the rounded extrusion whose edge radius is
   the mesh's cap round — one description (prism-geometry.ts, §V818), gated by
   prism-geometry.test.ts to 1e-6 at every mesh vertex. */
const BEVEL: f32 = 0.046;

/* T928 — DIAMOND CUT (prism-geometry.ts, the one description): the cross-section is a
   hexagon — three faces, three flat corner chamfers (depth BEVEL along the vertex) —
   and the cap edge is a single 45-degree chamfer of depth EDGE. Max-of-planes: inside
   exact, outside a safe underestimate near vertices (the T920 march precedent), and
   the gradient normals are FLAT per facet with sharp creases — each facet catches the
   environment's lamp spot (T945a) as a glint instead of a smear, which is the point. */
fn sdBody2(p: vec2f) -> f32 {
  let cut = 2.0 * RI - BEVEL;
  var d = max(max(dot(p, NR), dot(p, NL)), dot(p, ND)) - RI;
  d = max(d, max(max(-dot(p, NR), -dot(p, NL)), -dot(p, ND)) - cut);
  return d;
}

fn sdBody(p: vec3f) -> f32 {
  let flat = sdBody2(p.xy);
  let cap = abs(p.z) - HALF;
  let chamfer = (flat + abs(p.z) - HALF + EDGE) * 0.70710678;
  return max(max(flat, cap), chamfer);
}

/* The boundary's own normal — a GRADIENT: it sweeps continuously through the corner
   bevel AND the cap rounds, so a finite-width beam meets a different normal at each
   slice and its straight sub-rays fan into a curved envelope. A caustic, from geometry. */
fn bodyNormal(p: vec3f) -> vec3f {
  let e = vec2f(1.0e-4, 0.0);
  return normalize(vec3f(
    sdBody(p + e.xyy) - sdBody(p - e.xyy),
    sdBody(p + e.yxy) - sdBody(p - e.yxy),
    sdBody(p + e.yyx) - sdBody(p - e.yyx),
  ));
}

struct Hit {
  point: vec3f,
  normal: vec3f,
  ok: f32,
};

/* Sphere-march the SDF. inward = +1 marches OUTSIDE geometry toward the surface (entry),
   -1 marches INSIDE it (the internal legs). */
fn marchBody(origin: vec3f, dir: vec3f, inward: f32, maxT: f32) -> Hit {
  var out: Hit;
  out.ok = 0.0;
  var t = 0.0;
  for (var i = 0; i < 160; i = i + 1) {
    let p = origin + dir * t;
    let d = sdBody(p) * inward;
    if (d < 2.0e-4) {
      out.point = p;
      out.normal = bodyNormal(p) * inward;
      out.ok = 1.0;
      return out;
    }
    t = t + max(d, 3.0e-4);
    if (t > maxT) { break; }
  }
  out.point = origin + dir * maxT;
  out.normal = vec3f(0.0, 1.0, 0.0);
  return out;
}

struct Traced {
  /* Entry on the body, the first internal hit, and (TIR only) the second. */
  entry: vec3f,
  firstHit: vec3f,
  exitPoint: vec3f,
  exitDirection: vec3f,
  tir: f32,
  /* |cos| of incidence at entry and at the face the ray actually left through — the two
     Fresnel shares (T913). 1 when degenerate so a collapsed ray costs no brightness. */
  entryCos: f32,
  exitCos: f32,
  ok: f32,
};

/* The whole path of ONE ray of ONE wavelength, against the BEVELED solid (T937: in
   BODY space — the caller rotates the ray in and the result out, so a swiveled body
   refracts AS a swiveled body): march to entry, Snell in at the LOCAL normal, march the
   interior, Snell out — and on TIR, the reflected leg and the exit there. A second TIR
   collapses the exit ray rather than inventing one. */
fn tracePrism(origin: vec3f, dIn: vec3f, n: f32, ri: f32) -> Traced {
  var out: Traced;
  out.ok = 0.0;
  out.tir = 0.0;
  out.entryCos = 1.0;
  out.exitCos = 1.0;
  let enter = marchBody(origin, dIn, 1.0, 4.5);
  out.entry = enter.point;
  out.firstHit = enter.point;
  out.exitPoint = enter.point;
  out.exitDirection = vec3f(0.0);
  if (enter.ok < 0.5) { return out; }
  out.ok = 1.0;
  out.entryCos = abs(dot(dIn, enter.normal));
  let d2 = refract3(dIn, enter.normal, 1.0 / n);
  if (dot(d2, d2) < 1.0e-9) { return out; }
  /* Step INSIDE past the surface before marching for the far wall. */
  let inside1 = marchBody(enter.point + d2 * 2.0e-3, d2, -1.0, 4.5);
  out.firstHit = inside1.point;
  out.exitPoint = inside1.point;
  if (inside1.ok < 0.5) { return out; }
  let n1 = -inside1.normal;
  /* refract3 wants the normal on the INCIDENT side — inside the glass, that is the
     inward one (the raw marched normal). */
  let d3 = refract3(d2, inside1.normal, n);
  if (dot(d3, d3) > 1.0e-9) {
    out.exitDirection = d3;
    out.exitCos = abs(dot(d2, n1));
    return out;
  }
  out.tir = 1.0;
  let dr = reflect3(d2, n1);
  let inside2 = marchBody(inside1.point + dr * 2.0e-3, dr, -1.0, 4.5);
  out.exitPoint = inside2.point;
  if (inside2.ok < 0.5) { return out; }
  let n2 = -inside2.normal;
  let d4 = refract3(dr, inside2.normal, n);
  out.exitDirection = select(d4, vec3f(0.0), dot(d4, d4) < 1.0e-9);
  out.exitCos = abs(dot(dr, n2));
  return out;
}

/* T937 — the body's pose. form1 applies rotY(yaw) then rotX(nod); the trace applies the
   inverse to bring a WORLD ray into body space and the forward pose to carry traced
   points back out. */
fn rotY(v: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}
fn rotX(v: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}
fn toBody(v: vec3f, yaw: f32, nod: f32) -> vec3f { return rotY(rotX(v, -nod), -yaw); }
fn toWorld(v: vec3f, yaw: f32, nod: f32) -> vec3f { return rotX(rotY(v, yaw), nod); }
`;

/**
 * The `process` body, split from the head so a gate can reuse the trace functions
 * with its own emission if it ever needs to. `RI` arrives via string interpolation at
 * the use site (E13 derives it from its own PRISM_RC; the gate pins the same number).
 */
export function prismTraceKernel(ri: string): string {
  return `${PRISM_TRACE_KERNEL_HEAD}
const RI: f32 = ${ri};

struct Params {
  tiltYaw: f32,
  tiltNod: f32,
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* T929 — the cursor is a TORCH: x orbits the lamp around the prism, y slides the aim
     across the body (0 aims at the incenter: every face at its middle). A parked cursor
     is a parked beam, forever (T915b). */
  let px = clamp(ctx.value3, 0.0, 1.0);
  let py = clamp(ctx.value1, 0.0, 1.0);
  let phi = mix(ARC_A, ARC_B, px) * PI / 180.0;
  let S2 = vec2f(cos(phi), sin(phi)) * LAMP_R;
  let ahead = normalize(-S2);
  let aside = vec2f(-ahead.y, ahead.x);
  let dIn2 = normalize(-S2 + aside * (py * OFF_MAX));
  /* T937 — the trace happens in BODY space: the same yaw/nod the mesh applies (one
     expression pair, prism.ts) rotates the WORLD ray in and every traced point back
     out. A swiveled body refracts AS a swiveled body — no per-view compensation, and
     the camera can orbit without the beam detaching from the glass. */
  let yaw = ctx.params.tiltYaw;
  let nod = ctx.params.tiltNod;
  let S = toBody(vec3f(S2, 0.0), yaw, nod);
  let dIn = normalize(toBody(vec3f(dIn2, 0.0), yaw, nod));
  let castFrom = S;
  let perp = normalize(cross(dIn, vec3f(0.0, 0.0, 1.0)));

  /* The CENTRAL wavelength's path — the shaft's landing and the ghost's seat. */
  let nMid = cauchyN(0.5, ctx.value2);
  let mid = tracePrism(castFrom, dIn, nMid, RI);
  let hit = mid.ok > 0.5;

  if (ctx.index == 0u) {
    /* The shaft rides the whole cast: from the lamp (off-frame by LAMP_R's own size) to
       the marched entry; a MISS carries straight through and leaves the far side.
       T937: traced in body space, DRAWN in world. */
    q.position = toWorld(S, yaw, nod);
    q.tip = toWorld(select(S + dIn * MISS_LEN, mid.entry, hit), yaw, nod);
    q.tint = vec4f(1.0, 1.0, 1.0, 1.0);
    q.role = 0.0;
    return q;
  }
  if (ctx.index == 1u) {
    /* The GHOST — the entry face's Fresnel share, reflected off the MARCHED normal, with
       R0 from the central index (T913). Zero length on a miss. */
    let ne = bodyNormal(mid.entry);
    let r = reflect3(dIn, ne);
    let fr = schlick(mid.entryCos, nMid);
    q.position = toWorld(select(S, mid.entry, hit), yaw, nod);
    q.tip = toWorld(select(S, mid.entry + r * GHOST_LEN, hit), yaw, nod);
    q.tint = vec4f(vec3f(fr), 1.0);
    q.role = 0.0;
    return q;
  }

  /* T920 — THE BEAM. Aperture slices across the width x wavelength bands x three legs:
     interior (entry -> first wall), the TIR continuation (zero-length without TIR), and
     the exit ray. Each slice casts from its own offset, meets its own normal — through
     the bevel that is a DIFFERENT normal — so the envelope of exits curves, the width
     modulates along the path, and violet peels from the bundle INSIDE the glass (the
     reference's in-body dispersion), all from Snell against real geometry. Brightness is
     divided by the slice count: the additive draw (T917) sums it back to one beam. */
  let k = ctx.index - 2u;
  let s = k / (BANDS * 3u);
  let r2 = k % (BANDS * 3u);
  let b = r2 / 3u;
  let leg = r2 % 3u;
  let t = f32(b) / f32(BANDS - 1u);
  let off = (f32(s) / f32(SLICES - 1u) - 0.5) * APERTURE;
  let n = cauchyN(t, ctx.value2);
  let band = tracePrism(castFrom + perp * off, dIn, n, RI);
  let live = band.ok > 0.5;
  let colour = fieldAt(vec3f(t * 2.0 - 1.0, 0.0, 0.0)).rgb;
  let frIn = schlick(band.entryCos, n);
  let seat = select(S, band.entry, live);

  /* T941b — the NEIGHBOUR band, shared by the interior segment (leg 0) and the exit
     segment (leg 2). The last band has no partner; its segment slots collapse. */
  let hasNext = b + 1u < BANDS;
  let t2 = f32(min(b + 1u, BANDS - 1u)) / f32(BANDS - 1u);
  let n2 = cauchyN(t2, ctx.value2);
  let band2 = tracePrism(castFrom + perp * off, dIn, n2, RI);
  let colourM = fieldAt(vec3f((t + t2) - 1.0, 0.0, 0.0)).rgb;
  let frIn2 = schlick(band2.entryCos, n2);

  if (leg == 0u) {
    /* T941b — the interior WEDGE SEGMENT (the owner: "doesnt sem possible to get a
       rainbow spread inside"): the in-glass fan is one continuous gradient too, tiled
       between adjacent bands exactly as the exit fan is. Entry is shared (one geometric
       ray refracts at one point), so the segment naturally pinches there and opens to
       the two bands' far-wall spacing. Role 0.5: its own draw (core1) — the shaft keeps
       meaning "the beam outside", the fan "the exits". */
    let ok2i = band2.ok > 0.5;
    let alive0 = hasNext && live && ok2i;
    let tipI = (band.firstHit + band2.firstHit) * 0.5;
    /* Floored at the beam's own APERTURE: the segment tiling narrows to the physical
       beam, never to a hairline — the in-glass core stays a lit beam at rest. */
    let widthI = clamp(max(distance(band.firstHit, band2.firstHit), APERTURE), 2.0e-4, 4.0) * 0.25;
    q.position = toWorld(select(S, band.entry, alive0), yaw, nod);
    q.tip = toWorld(select(S, tipI, alive0), yaw, nod);
    q.tint = vec4f(colourM * (((1.0 - frIn) + (1.0 - frIn2)) * 0.5 * INTERIOR_GAIN / f32(SLICES)), widthI);
    q.role = 0.5;
    return q;
  }
  if (leg == 1u) {
    /* Interior 2: the TIR continuation. Zero length (zero area, T680) without TIR. */
    let seat2 = select(seat, band.firstHit, live);
    let alive = live && band.tir > 0.5;
    q.position = toWorld(seat2, yaw, nod);
    q.tip = toWorld(select(seat2, band.exitPoint, alive), yaw, nod);
    q.tint = vec4f(colour * ((1.0 - frIn) * INTERIOR_GAIN / f32(SLICES)), 1.0);
    q.role = 0.0;
    return q;
  }
  /* T941 — THE WEDGE SEGMENT. The reference draws ONE continuous fan; N constant-width
     ribbons can never do that at arbitrary spread (a sampled fan shows its samples the
     moment spacing exceeds width). So leg 2 is the SEGMENT between band b and b+1: its
     edges ARE the two bands' physical rays, so adjacent segments share an edge exactly —
     the fan tiles seamlessly at ANY spread. Where exit directions bunch (the bevel's
     caustic, violet's Cauchy compression) segments narrow while carrying the same
     energy: RAY DENSITY becomes brightness, from geometry, no analytic term needed.
     A segment whose two bands leave through DIFFERENT faces (the TIR split) collapses:
     the spectrum's split is a stated boundary, not a smeared band. */
  if (!hasNext) {
    q.position = toWorld(S, yaw, nod);
    q.tip = q.position;
    q.tint = vec4f(0.0);
    q.role = 1.0;
    return q;
  }
  let gone1 = live && dot(band.exitDirection, band.exitDirection) > 1.0e-9;
  let gone2 = band2.ok > 0.5 && dot(band2.exitDirection, band2.exitDirection) > 1.0e-9;
  /* T941b — the owner's finding, verbatim: "where there is a legit separating into
     multiple beams where a part is reflected differently... there may nothing be
     inbetween them to connect those." Exit-point distance was the wrong discriminator:
     near a corner, a face-exit and a TIR base-exit leave from almost the SAME spot with
     directions ~90 degrees apart, and the bridge between them was the giant sail in
     their shot. A segment lives only when its two edge rays took the SAME PATH (tir
     flags match) and left in nearly the SAME DIRECTION (within ~9 degrees — adjacent
     bands differ by ~0.2 degrees except across a discontinuity, and the sliver of
     spectrum lost at the cut carries vanishing transmission anyway). */
  let samePath = abs(band.tir - band2.tir) < 0.5;
  let dirClose = dot(normalize(band.exitDirection + vec3f(1.0e-9)), normalize(band2.exitDirection + vec3f(1.0e-9))) > 0.988;
  let alive = gone1 && gone2 && samePath && dirClose;
  let tipA = band.exitPoint + band.exitDirection * FAN_LEN;
  let tipB = band2.exitPoint + band2.exitDirection * FAN_LEN;
  let root = (band.exitPoint + band2.exitPoint) * 0.5;
  let tipM = (tipA + tipB) * 0.5;
  /* The segment's width rides the TINT ALPHA (a fifth attribute would blow §V588's
     binding budget): the FULL edge-to-edge distance, divided by 4 to live inside the
     colour range, and the fan's scale map multiplies it back (node scale = 4). Each
     segment overlaps its neighbours to their midlines, and the soft profile's triangle
     falloff makes the overlapping set a PARTITION OF UNITY — linear crossfade between
     adjacent bands, constant total energy, no seams and no strands at any spread. */
  let segWidth = clamp(max(distance(tipA, tipB), APERTURE), 2.0e-4, 4.0) * 0.25;
  let frOut = schlick(band.exitCos, n);
  let frOut2 = schlick(band2.exitCos, n2);
  let weight = ((1.0 - frIn) * (1.0 - frOut) + (1.0 - frIn2) * (1.0 - frOut2)) * 0.5;
  q.position = toWorld(select(S, root, alive), yaw, nod);
  q.tip = toWorld(select(S, tipM, alive), yaw, nod);
  q.tint = vec4f(colourM * (weight * EXIT_GAIN / f32(SLICES)), segWidth);
  q.role = 1.0;
  return q;
}`;
}
