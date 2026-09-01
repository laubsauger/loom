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
 * ## The channels
 *
 *   value1 — the aim (0..1): entry angle sweeps THETA_HI → THETA_LO degrees.
 *   value2 — dispersive power: n runs N_RED → N_RED + value2 across the band.
 *   value3 — the pointer's additive aim share (E13's idiom; 0 until a pointer moves).
 *   value4 — entry-point offset along the face tangent (0 keeps E13's low entry; the
 *            gate drives it toward the apex, where the faces converge and the internal
 *            segment shortens — the apex-region case in the acceptance criterion).
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
const THETA_LO: f32 = 37.0;
const THETA_HI: f32 = 62.0;
const AIM_POINTER: f32 = 0.55;

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
};

/* The whole path of ONE wavelength: entry Snell, internal segment to the nearest
   face, exit Snell — and on TIR, the reflected leg to the base and the exit there.
   A second TIR (possible only at extreme settings) collapses the exit ray to zero
   length rather than inventing a direction. */
fn tracePrism(pe: vec2f, dIn: vec2f, n: f32, ri: f32) -> Traced {
  var out: Traced;
  out.tir = 0.0;
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
  /* E13's aim idiom: LFO plus pointer share, added where both numbers already are. */
  let aim = clamp(ctx.value1 + AIM_POINTER * ctx.value3, 0.0, 1.0);
  let theta = mix(THETA_HI, THETA_LO, aim) * PI / 180.0;
  let inward = -NR;
  let cs = cos(-theta);
  let sn = sin(-theta);
  let dIn = vec2f(inward.x * cs - inward.y * sn, inward.x * sn + inward.y * cs);
  /* value4 slides the entry point along the face tangent — toward the apex when
     positive. 0 is E13's shipped entry, low on the face. */
  let pe = NR * RI + vec2f(-NR.y, NR.x) * (ENTRY + ctx.value4);

  /* The CENTRAL wavelength's path — the visible interior, shared by slots 2 and 3. */
  let nMid = N_RED + ctx.value2 * 0.5;
  let mid = tracePrism(pe, dIn, nMid, RI);

  if (ctx.index == 0u) {
    q.position = vec3f(pe - dIn * SHAFT_LEN, PLANE);
    q.tip = vec3f(pe, PLANE);
    q.tint = vec4f(1.0, 1.0, 1.0, 1.0);
    q.role = 0.0;
    return q;
  }
  if (ctx.index == 1u) {
    /* The GHOST: the share the face sent back, by Schlick on the same incidence the
       refraction uses. */
    let r = reflect2(dIn, NR);
    let c = abs(dot(dIn, NR));
    let fr = 0.043 + 0.957 * pow(1.0 - c, 5.0);
    q.position = vec3f(pe, PLANE);
    q.tip = vec3f(pe + r * GHOST_LEN, PLANE);
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
    q.tip = vec3f(mid.firstHit, PLANE);
    q.tint = vec4f(vec3f((1.0 - fr) * 0.62), 1.0);
    q.role = 0.0;
    return q;
  }
  if (ctx.index == 3u) {
    /* The TIR continuation: firstHit -> base. Zero-length (zero area, T680) whenever
       the central ray exits at the first face. */
    let c = abs(dot(dIn, NR));
    let fr = 0.043 + 0.957 * pow(1.0 - c, 5.0);
    q.position = vec3f(mid.firstHit, PLANE);
    q.tip = vec3f(select(mid.firstHit, mid.exitPoint, mid.tir > 0.5), PLANE);
    q.tint = vec4f(vec3f((1.0 - fr) * 0.55), 1.0);
    q.role = 0.0;
    return q;
  }

  /* One exit ray per wavelength: t is BOTH the refractive index and the hue. Each
     band's fan segment starts at ITS OWN exit point — on the exit face normally, on
     the BASE after TIR — so the fan opens at the face and a band near the critical
     angle visibly walks off the end of it. */
  let t = f32(ctx.index - 4u) / f32(ctx.count - 5u);
  let n = N_RED + ctx.value2 * t;
  let band = tracePrism(pe, dIn, n, RI);
  q.position = vec3f(band.exitPoint, PLANE);
  q.tip = vec3f(band.exitPoint + band.exitDirection * FAN_LEN, PLANE);
  q.tint = vec4f(fieldAt(vec3f(t * 2.0 - 1.0, 0.0, 0.0)).rgb, 1.0);
  q.role = 1.0;
  return q;
}`;
}
