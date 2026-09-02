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
 * ## The slots (capacity = bands + 4)
 *
 *   index 0 — incoming shaft            (role 0: parallel ribbon)
 *   index 1 — the ghost: the entry face's Fresnel share, reflected (role 0)
 *   index 2 — internal segment at the CENTRAL wavelength (role 0). One segment, not
 *             61: dispersion at the entry face is small (the whole point of the
 *             exit-face finding), and 61 near-collinear ribbons fuse into a wedge
 *             (T680's taper note).
 *   index 3 — the central wavelength's TIR continuation to the base — zero-length
 *             (zero area, T680) whenever the central ray exits normally.
 *   index 4+ — one exit ray per wavelength band (role 1: the fan).
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

/* Ray vs the face plane dot(p, n) = RI, from inside: the positive travel distance. */
fn faceHit(origin: vec2f, direction: vec2f, n: vec2f, ri: f32) -> f32 {
  let den = dot(direction, n);
  if (den < 1.0e-5) { return 1.0e6; }
  return (ri - dot(origin, n)) / den;
}

struct Traced {
  /* Where the ray leaves the glass, and along what direction. */
  exitPoint: vec2f,
  exitDirection: vec2f,
  /* The internal path: entry -> firstHit, and (TIR only) firstHit -> exitPoint. */
  firstHit: vec2f,
  /* 1.0 when the ray left through the BASE after TIR at the exit face. */
  tir: f32,
  /* |cos| of the INTERNAL incidence at the face the ray actually left through — what the
     exit face's Fresnel share is computed from (T913). 1 when degenerate, so a collapsed
     ray costs no brightness by accident. */
  exitCos: f32,
};

/* The whole path of ONE wavelength: entry Snell, internal segment to the nearest
   face, exit Snell — and on TIR, the reflected leg to the base and the exit there.
   A second TIR (possible only at extreme settings) collapses the exit ray to zero
   length rather than inventing a direction. */
fn tracePrism(pe: vec2f, dIn: vec2f, n: f32, ri: f32) -> Traced {
  var out: Traced;
  out.tir = 0.0;
  out.exitCos = 1.0;
  let d2 = refract2(dIn, NR, 1.0 / n);
  /* Entry at grazing beyond range: keep the geometry degenerate-safe. */
  if (dot(d2, d2) < 1.0e-9) {
    out.exitPoint = pe;
    out.exitDirection = vec2f(0.0);
    out.firstHit = pe;
    return out;
  }
  /* The internal ray can only leave through the exit face or the base. */
  let sL = faceHit(pe, d2, NL, ri);
  let sD = faceHit(pe, d2, ND, ri);
  let exitLeft = sL <= sD;
  let s1 = min(sL, sD);
  let n1 = select(ND, NL, exitLeft);
  let p1 = pe + d2 * s1;
  out.firstHit = p1;
  let d3 = refract2(d2, -n1, n);
  if (dot(d3, d3) > 1.0e-9) {
    out.exitPoint = p1;
    out.exitDirection = d3;
    out.exitCos = abs(dot(d2, n1));
    return out;
  }
  /* TOTAL INTERNAL REFLECTION: the face is a mirror; the ray crosses to the other
     of the two remaining faces and refracts THERE. */
  out.tir = 1.0;
  let dr = reflect2(d2, n1);
  let n2 = select(NL, ND, exitLeft);
  let s2 = faceHit(p1, dr, n2, ri);
  let p2 = p1 + dr * s2;
  out.exitPoint = p2;
  let d4 = refract2(dr, -n2, n);
  /* Twice-trapped: draw nothing rather than something invented. */
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
  /* TWO SCALES ON ONE ANGLE. The swing keeps its own narrow band (value1: 0 → 62°,
     1 → 37°) so every measurement that pins it still means what it meant; the pointer
     reads the WIDE one and passes through both of the swing's aims on the way. */
  let theta = mix(mix(THETA_HI, THETA_LO, clamp(ctx.value1, 0.0, 1.0)),
                  mix(HAND_HI, HAND_LO, px), hand) * PI / 180.0;
  let inward = -NR;
  let cs = cos(-theta);
  let sn = sin(-theta);
  let dIn = vec2f(inward.x * cs - inward.y * sn, inward.x * sn + inward.y * cs);
  /* WHERE ON THE FACE, from the same one knob. A real aimed beam does not pivot about
     a fixed spot on the glass, and pinning the entry point is precisely what made the
     old aim unable to miss: 'tau' is the entry's position along the face tangent, and
     the pointer sweeps it from below the base vertex to past the apex. The swing never
     moves it — at hand = 0 this is ENTRY exactly, E13's shipped low entry.
     The pairing is not arbitrary: the apex end of the sweep carries the GRAZING angle
     and the base end the near-normal one, so a ray that overshoots either vertex is
     travelling AWAY from the body and the miss is a real miss rather than a ray that
     sneaks in through another face. */
  let tau = mix(ENTRY, REACH * (0.5 - px), hand);
  let pe = NR * RI + vec2f(-NR.y, NR.x) * tau;
  /* THE REFRACTING FACE IS A SEGMENT, NOT A PLANE, and this is the line that lets the
     beam miss. An equilateral cross-section's half side is its inradius times √3, so
     the bound is the SAME RI the mesh and the optics already share (T710's identity)
     rather than a fourth number to keep in step. */
  let onFace = abs(tau) < RI * ROOT3;

  /* The CENTRAL wavelength's path — the visible interior, shared by slots 2 and 3. */
  let nMid = cauchyN(0.5, ctx.value2);
  let mid = tracePrism(pe, dIn, nMid, RI);

  if (ctx.index == 0u) {
    q.position = vec3f(pe - dIn * SHAFT_LEN, PLANE);
    /* A HIT stops at the face and hands over to the internal segment; a MISS carries
       straight on past the glass, so the picture shows a beam going by rather than a
       beam that stopped in mid-air at nothing. */
    q.tip = vec3f(select(pe + dIn * MISS_LEN, pe, onFace), PLANE);
    q.tint = vec4f(1.0, 1.0, 1.0, 1.0);
    q.role = 0.0;
    return q;
  }
  if (ctx.index == 1u) {
    /* The GHOST: the share the face sent back, by Schlick on the same incidence the
       refraction uses. Nothing reflects off a face the ray never reached, so a miss
       collapses this to zero length (zero area, T680). */
    let r = reflect2(dIn, NR);
    let c = abs(dot(dIn, NR));
    let fr = 0.043 + 0.957 * pow(1.0 - c, 5.0);
    q.position = vec3f(pe, PLANE);
    q.tip = vec3f(select(pe, pe + r * GHOST_LEN, onFace), PLANE);
    q.tint = vec4f(vec3f(fr), 1.0);
    q.role = 0.0;
    return q;
  }
  if (ctx.index == 2u) {
    /* THE INTERNAL SEGMENT — the piece the previous optics computed and never drew.
       Its brightness is the share the entry face let THROUGH (1 − the ghost's
       Schlick), dimmed a step so the film of glass reads over it. */
    let c = abs(dot(dIn, NR));
    let fr = 0.043 + 0.957 * pow(1.0 - c, 5.0);
    q.position = vec3f(pe, PLANE);
    q.tip = vec3f(select(pe, mid.firstHit, onFace), PLANE);
    q.tint = vec4f(vec3f((1.0 - fr) * 0.62), 1.0);
    q.role = 0.0;
    return q;
  }
  if (ctx.index == 3u) {
    /* The TIR continuation: firstHit -> base. Zero-length (zero area, T680) whenever
       the central ray exits at the first face — or never entered at all. */
    let c = abs(dot(dIn, NR));
    let fr = 0.043 + 0.957 * pow(1.0 - c, 5.0);
    let seat = select(pe, mid.firstHit, onFace);
    q.position = vec3f(seat, PLANE);
    q.tip = vec3f(select(seat, select(mid.firstHit, mid.exitPoint, mid.tir > 0.5), onFace), PLANE);
    q.tint = vec4f(vec3f((1.0 - fr) * 0.55), 1.0);
    q.role = 0.0;
    return q;
  }

  /* One exit ray per wavelength: t is BOTH the refractive index and the hue. Each
     band's fan segment starts at ITS OWN exit point — on the exit face normally, on
     the BASE after TIR — so the fan opens at the face and a band near the critical
     angle visibly walks off the end of it. */
  let t = f32(ctx.index - 4u) / f32(ctx.count - 5u);
  let n = cauchyN(t, ctx.value2);
  let band = tracePrism(pe, dIn, n, RI);
  /* A ray that missed the glass disperses nothing: the whole fan collapses to zero
     length at the entry point, and the shaft above is the only thing drawn. */
  let root = select(pe, band.exitPoint, onFace);
  q.position = vec3f(root, PLANE);
  q.tip = vec3f(select(root, band.exitPoint + band.exitDirection * FAN_LEN, onFace), PLANE);
  /* FRESNEL AT BOTH FACES (T913): the band's brightness is what the entry face let
     through times what its OWN exit face let through — so a band nearing the critical
     angle dims toward zero BEFORE it TIRs (the transmitted share goes to the reflected
     leg), and at grazing entry the whole fan dims while the ghost brightens. Same Snell,
     same Schlick, no branch deciding anything. */
  let tEntry = 1.0 - schlick(abs(dot(dIn, NR)), n);
  let tExit = 1.0 - schlick(band.exitCos, n);
  q.tint = vec4f(fieldAt(vec3f(t * 2.0 - 1.0, 0.0, 0.0)).rgb * tEntry * tExit, 1.0);
  q.role = 1.0;
  return q;
}`;
}
