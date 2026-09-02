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
const PLANE: f32 = 0.10;
const ENTRY: f32 = -0.28;
const SHAFT_LEN: f32 = 2.10;
const GHOST_LEN: f32 = 0.90;
const FAN_LEN: f32 = 2.25;
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
const HAND_HI: f32 = 84.0;
const HAND_LO: f32 = 6.0;
/* Speed² → authority. A cursor crossing a TWENTIETH of the frame in a second reads
   0.0025 here and clamps to 1: any deliberate move owns the aim outright, and a cursor
   that has never moved reads exactly 0. */
const HAND_GAIN: f32 = 400.0;
/* How far along the face the pointer walks the entry point, tip to tail. The face's
   half-length is RI·√3 = 0.658, so ±0.8 runs PAST both vertices — which is the state
   the owner asked for: the beam misses the glass. */
const REACH: f32 = 1.6;
const ROOT3: f32 = 1.7320508;
/* A missed beam has to still be a beam: it carries straight on past where the glass
   isn't, instead of stopping at a face it never met. */
const MISS_LEN: f32 = 2.60;

/* T920 — THE BEAM'S SAMPLING. SLICES rays across the drawn shaft's full width (2 x its
   0.006 half-width), BANDS wavelengths, three legs each (interior, TIR continuation,
   exit). Odd slice count so a CENTRE slice exists — the exact ray every pre-T920 gate
   measured. Brightness constants are per-beam: the additive draw sums the slices back. */
const SLICES: u32 = 9u;
const BANDS: u32 = 61u;
const APERTURE: f32 = 0.012;
const INTERIOR_GAIN: f32 = 0.55;
const EXIT_GAIN: f32 = 1.35;

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
fn refract2(i: vec2f, n: vec2f, eta: f32) -> vec2f {
  let d = dot(n, i);
  let k = 1.0 - eta * eta * (1.0 - d * d);
  if (k < 0.0) { return vec2f(0.0); }
  return i * eta - n * (eta * d + sqrt(k));
}

fn reflect2(i: vec2f, n: vec2f) -> vec2f {
  return i - n * (2.0 * dot(i, n));
}

/* T920 — THE BOUNDARY IS THE BODY'S OWN CROSS-SECTION, bevel included. The old optics
   traced three analytic PLANES: parallel rays in, parallel rays out, and no number of
   aperture slices could ever produce a caustic (T914's amendment — aperture AND curvature,
   both, or nothing). form1's mesh has always carried a corner round-over; this SDF is that
   same rounded triangle, so the trace finally sees the geometry the picture shows. Exact:
   max-of-half-planes inside, nearest EDGE SEGMENT outside, vertices at -2r*N, then the
   Minkowski round — shrink the sharp triangle by BEVEL and subtract BEVEL. */
const BEVEL: f32 = 0.046;

fn sdSegment2(p: vec2f, a: vec2f, b: vec2f) -> f32 {
  let ab = b - a;
  let h = clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0);
  return length(p - a - ab * h);
}

fn sdSharpTri(p: vec2f, r: f32) -> f32 {
  let inside = max(max(dot(p, NR), dot(p, NL)), dot(p, ND)) - r;
  if (inside <= 0.0) { return inside; }
  let v0 = -2.0 * r * NR;
  let v1 = -2.0 * r * NL;
  let v2 = -2.0 * r * ND;
  return min(min(sdSegment2(p, v0, v1), sdSegment2(p, v1, v2)), sdSegment2(p, v2, v0));
}

fn sdBody(p: vec2f) -> f32 {
  return sdSharpTri(p, RI - BEVEL) - BEVEL;
}

/* The boundary's own normal — a GRADIENT now, which is the whole point: it sweeps
   continuously through the bevel, so a finite-width beam meets a different normal at each
   slice and its straight sub-rays fan into a curved envelope. A caustic, from geometry. */
fn bodyNormal(p: vec2f) -> vec2f {
  let e = vec2f(1.0e-4, 0.0);
  return normalize(vec2f(
    sdBody(p + e.xy) - sdBody(p - e.xy),
    sdBody(p + e.yx) - sdBody(p - e.yx),
  ));
}

struct Hit {
  point: vec2f,
  normal: vec2f,
  ok: f32,
};

/* Sphere-march the SDF. inward = +1 marches OUTSIDE geometry toward the surface (entry),
   -1 marches INSIDE it (the internal legs). Max-of-planes underestimates outside a corner,
   which only shortens steps: marching stays safe. */
fn marchBody(origin: vec2f, dir: vec2f, inward: f32, maxT: f32) -> Hit {
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
  out.normal = vec2f(0.0, 1.0);
  return out;
}

struct Traced {
  /* Entry on the body, the first internal hit, and (TIR only) the second. */
  entry: vec2f,
  firstHit: vec2f,
  exitPoint: vec2f,
  exitDirection: vec2f,
  tir: f32,
  /* |cos| of incidence at entry and at the face the ray actually left through — the two
     Fresnel shares (T913). 1 when degenerate so a collapsed ray costs no brightness. */
  entryCos: f32,
  exitCos: f32,
  ok: f32,
};

/* The whole path of ONE ray of ONE wavelength, against the BEVELED body: march to entry,
   Snell in at the LOCAL normal, march the interior, Snell out — and on TIR, the reflected
   leg and the exit there. A second TIR collapses the exit ray rather than inventing one. */
fn tracePrism(origin: vec2f, dIn: vec2f, n: f32, ri: f32) -> Traced {
  var out: Traced;
  out.ok = 0.0;
  out.tir = 0.0;
  out.entryCos = 1.0;
  out.exitCos = 1.0;
  let enter = marchBody(origin, dIn, 1.0, 4.0);
  out.entry = enter.point;
  out.firstHit = enter.point;
  out.exitPoint = enter.point;
  out.exitDirection = vec2f(0.0);
  if (enter.ok < 0.5) { return out; }
  out.ok = 1.0;
  out.entryCos = abs(dot(dIn, enter.normal));
  let d2 = refract2(dIn, enter.normal, 1.0 / n);
  if (dot(d2, d2) < 1.0e-9) { return out; }
  /* Step INSIDE past the surface before marching for the far wall. */
  let inside1 = marchBody(enter.point + d2 * 2.0e-3, d2, -1.0, 4.0);
  out.firstHit = inside1.point;
  out.exitPoint = inside1.point;
  if (inside1.ok < 0.5) { return out; }
  /* inside1.normal points INWARD (inward = -1 flips the gradient); Snell out wants the
     OUTWARD one. */
  let n1 = -inside1.normal;
  /* refract2 wants the normal on the INCIDENT side — inside the glass, that is the
     inward one (the raw marched normal). */
  let d3 = refract2(d2, inside1.normal, n);
  if (dot(d3, d3) > 1.0e-9) {
    out.exitDirection = d3;
    out.exitCos = abs(dot(d2, n1));
    return out;
  }
  out.tir = 1.0;
  let dr = reflect2(d2, n1);
  let inside2 = marchBody(inside1.point + dr * 2.0e-3, dr, -1.0, 4.0);
  out.exitPoint = inside2.point;
  if (inside2.ok < 0.5) { return out; }
  let n2 = -inside2.normal;
  let d4 = refract2(dr, inside2.normal, n);
  out.exitDirection = select(d4, vec2f(0.0), dot(d4, d4) < 1.0e-9);
  out.exitCos = abs(dot(dr, n2));
  return out;
}
`;

/**
 * The `process` body, split from the head so a gate can reuse the trace functions
 * with its own emission if it ever needs to. `RI` arrives via string interpolation at
 * the use site (E13 derives it from its own PRISM_RC; the gate pins the same number).
 */
export function prismTraceKernel(ri: string): string {
  return `${PRISM_TRACE_KERNEL_HEAD}
const RI: f32 = ${ri};

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* T857 — E13's aim idiom, and it is a BLEND: the pointer TAKES the aim while it is
     moving and hands it back when it stops. 'hand' is the pointer's own activity, and
     it is exactly 0 for a cursor that has never moved. */
  let hand = clamp(ctx.value4 * HAND_GAIN, 0.0, 1.0);
  let px = clamp(ctx.value3, 0.0, 1.0);
  let theta = mix(mix(THETA_HI, THETA_LO, clamp(ctx.value1, 0.0, 1.0)),
                  mix(HAND_HI, HAND_LO, px), hand) * PI / 180.0;
  let inward = -NR;
  let cs = cos(-theta);
  let sn = sin(-theta);
  let dIn = vec2f(inward.x * cs - inward.y * sn, inward.x * sn + inward.y * cs);
  let tau = mix(ENTRY, REACH * (0.5 - px), hand);
  let pe = NR * RI + vec2f(-NR.y, NR.x) * tau;
  let onFace = abs(tau) < RI * ROOT3;
  /* T920: the trace marches from OUTSIDE the body along the beam, so the entry point —
     and its NORMAL — come from the boundary itself, bevel included. */
  let castFrom = pe - dIn * 0.9;
  let perp = vec2f(-dIn.y, dIn.x);

  /* The CENTRAL wavelength's path — the shaft's landing and the ghost's seat. */
  let nMid = cauchyN(0.5, ctx.value2);
  let mid = tracePrism(castFrom, dIn, nMid, RI);
  let hit = onFace && mid.ok > 0.5;

  if (ctx.index == 0u) {
    q.position = vec3f(pe - dIn * SHAFT_LEN, PLANE);
    /* A HIT stops at the marched entry; a MISS carries straight on past the glass. */
    q.tip = vec3f(select(pe + dIn * MISS_LEN, mid.entry, hit), PLANE);
    q.tint = vec4f(1.0, 1.0, 1.0, 1.0);
    q.role = 0.0;
    return q;
  }
  if (ctx.index == 1u) {
    /* The GHOST — the entry face's Fresnel share, reflected off the MARCHED normal, with
       R0 from the central index (T913). Zero length on a miss. */
    let ne = bodyNormal(mid.entry);
    let r = reflect2(dIn, ne);
    let fr = schlick(mid.entryCos, nMid);
    q.position = vec3f(select(pe, mid.entry, hit), PLANE);
    q.tip = vec3f(select(pe, mid.entry + r * GHOST_LEN, hit), PLANE);
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
  let live = onFace && band.ok > 0.5;
  let colour = fieldAt(vec3f(t * 2.0 - 1.0, 0.0, 0.0)).rgb;
  let frIn = schlick(band.entryCos, n);
  let seat = select(pe, band.entry, live);

  if (leg == 0u) {
    /* Interior 1: the in-glass spread, drawn per band per slice — dim, additive. */
    q.position = vec3f(seat, PLANE);
    q.tip = vec3f(select(seat, band.firstHit, live), PLANE);
    q.tint = vec4f(colour * ((1.0 - frIn) * INTERIOR_GAIN / f32(SLICES)), 1.0);
    /* Role 0: the interiors ride the SHAFT draw — the in-glass path, exactly where the
       old slot-2 segment lived — so the shaft/fan split keeps meaning path/exits. */
    q.role = 0.0;
    return q;
  }
  if (leg == 1u) {
    /* Interior 2: the TIR continuation. Zero length (zero area, T680) without TIR. */
    let seat2 = select(seat, band.firstHit, live);
    let alive = live && band.tir > 0.5;
    q.position = vec3f(seat2, PLANE);
    q.tip = vec3f(select(seat2, band.exitPoint, alive), PLANE);
    q.tint = vec4f(colour * ((1.0 - frIn) * INTERIOR_GAIN / f32(SLICES)), 1.0);
    q.role = 0.0;
    return q;
  }
  /* The exit ray: from ITS OWN exit point along ITS OWN direction, Fresnel-weighted at
     both faces (T913), energy split across the slices. */
  let frOut = schlick(band.exitCos, n);
  let gone = live && dot(band.exitDirection, band.exitDirection) > 1.0e-9;
  let root = select(pe, band.exitPoint, live);
  q.position = vec3f(root, PLANE);
  q.tip = vec3f(select(root, band.exitPoint + band.exitDirection * FAN_LEN, gone), PLANE);
  q.tint = vec4f(colour * ((1.0 - frIn) * (1.0 - frOut) * EXIT_GAIN / f32(SLICES)), 1.0);
  q.role = 1.0;
  return q;
}`;
}
