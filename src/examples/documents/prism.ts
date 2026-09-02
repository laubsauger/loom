import { settings, node, edge, graph, document, drivenSlot, expressionSlot } from "./builders.ts";
import { SHADER_SOURCE_PARAMETER } from "@domain/commands/apply-patch.ts";
import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { PRISM_TRACE_KERNEL_HEAD, prismTraceKernel } from "../shaders/prism-trace.wgsl.ts";
import { PRISM_EDGE, PRISM_HALF, PRISM_RC, PRISM_RHO } from "../shaders/prism-geometry.ts";

/**
 * E13 — Prism (T710, rebuilt; was T363/T364).
 *
 *   bar1(pointTube) ─► form1(pointKernel) ─► solid1(geometry, surface) ─┐
 *   glass1(materialPhong) ──────────────── by name ────────────────────┘
 *                                                                       ├─► shot1(render)
 *   spectrum1(ramp) ─► optics1.field                                    │
 *   optics1(pointKernel) ─┬─► shaft1(geometry, beam, p.role < 0.5) ─────┤
 *                         └─► fan1  (geometry, beam, p.role > 0.5) ─────┤
 *   sky1(ramp) ─┐                                                       │
 *   band1(circle @ 0.5,0.5) ─┴─► studio1(add) ─► shot1.environment ─────┘
 *   key1(light), eye1(camera) ──── by name ─────────────────────────────┘
 *
 *   shot1 ─► cut1(level) ─► clip1(limit) ─► halo1(blur) ─► glow1(add).in2
 *   shot1 ─────────────────────────────────────────────► glow1(add).in1 ─► out1
 *
 *   mouse1 ─► follow1(valueLag) ┄drives┄► optics1.value1 (y: angle)  the AIM — the
 *                               ┄drives┄► optics1.value3 (x: entry)   pointer's, always (T915b)
 *   fan1.tint ← the `tint` attribute (map mode, T478)
 *
 * THE OWNER'S REFERENCE, and the one technical fact that makes it buildable: A PRISM
 * READS AS GLASS THROUGH ITS EDGES, NOT ITS VOLUME. The body is nearly black; what says
 * "glass" is a thin bright rim on every silhouette and a dim sheen on the faces. We have
 * no refraction and no glass material, and faking either reads worse than an honest
 * edge-lit prism — so the rim is T632's `envFresnel`, used deliberately (§V640).
 *
 * `envFresnel` rises to 1 at GRAZING, and §V640's measured LIMIT — the environment-band
 * rim is a rim only on CURVED geometry and turns into fill on a flat camera-facing
 * surface — is the whole reason this shape is built the way it is. `form1` walks a
 * ROUNDED triangle: three straight runs joined by three 120° arcs, and a quarter-round
 * where each flat cap meets the barrel. Along a straight run the surface renderer's
 * central difference is collinear, so the face normal is EXACTLY constant and the faces
 * stay flat and black. Across an arc the normal sweeps 120°, and somewhere in that sweep
 * it passes through grazing — so a thread of surface at grazing runs all the way round
 * the triangle, from any camera. That thread is the picture.
 *
 * Rounding the corners does not move the faces, which is what lets `optics1` below share
 * the geometry: the straight run of a rounded triangle sits at d·cos(60°) + ρ from the
 * axis, and with d = RC − 2ρ that is exactly RC/2 — a sharp triangle's inradius, for
 * every ρ. One number, two nodes, no drift.
 *
 * Measured at THIS commit, 1280×720, display-encoded from the plan's own space (§V618),
 * environment on vs off, split by a 6px erosion of the prism's own mask — §V640's own
 * instrument: RING mean |Δ| 43.06, INTERIOR 4.21, so the environment lands 10.2× harder
 * on the OUTLINE than in the body. E33's melted goo measured 1.8× and E33's flat emblem
 * measured 0.74×, i.e. fill. On the shipped frame the ring reads 62.7 luma against an
 * interior of 6.3. Two numbers, not one adjective.
 *
 * AMBIENT IS ZERO AND THE KEY IS HARD, and that is E33's lesson (§V632/T636) rather than
 * taste: the physical terms here are tiny — a 4% head-on Fresnel on a specular of 0.86
 * and a diffuse albedo of 0.0009 linear — so any ambient worth the name drowns them and
 * the glass goes to grey slate. `key1` therefore does exactly one job: its direction is
 * the mirror of the view about the upper-left round-over's normal, so its Blinn lobe
 * (shininess 140) lands as a GLINT on that edge and nowhere else. Measured: killing it
 * moves 8,387 pixels by more than 4 luma — it earns its node (§V624).
 *
 * THE DISPERSION IS THE EXAMPLE, and it is solved rather than drawn. `optics1` runs
 * Snell's law twice per band, vectorially, in the prism's own cross-section: refract in
 * at the right face, cross to the left face plane, refract out. n follows CAUCHY
 * (T913, n = A + B/λ², λ 0.7µm → 0.4µm), violet-heavy the way real glass is, and runs
 * 1.500 (red) to 1.530 (violet) — `value2` is the total spread, 0.030, DENSE FLINT's
 * real number (crown is 0.018; the old 0.085 was 3–5× exaggerated, which is why the fan
 * looked split at every angle and the impact angle stopped reading as the cause). The
 * split-or-converge behaviour is Snell's own: at near-normal incidence every wavelength
 * refracts alike and the beam stays a line; obliquely they part. No branch decides it. Sixty-one bands take their colour from `spectrum1` through the kernel's own
 * `field` input (`fieldAt(vec3f(t·2−1, 0, 0))` samples the ramp at u = t, v = 0.5), so
 * hue and refractive index are the SAME parameter and the ramp is the authored spectrum.
 *
 * WHAT THE ANGLE ACTUALLY DOES, measured rather than assumed. The brief for this rebuild
 * said "a more oblique incoming beam spreads more". That is not what the arithmetic says
 * and the file should not claim it. Differentiating δ = θ1 + asin(n·sin(A − θ2)) − A:
 *
 *     dδ/dn = (sin θ3 + cos θ3 · tan θ2) / cos θ4
 *
 * and as θ1 grows, θ2 grows, θ3 = A − θ2 shrinks and θ4 shrinks with it — numerator down,
 * denominator up. Angular dispersion therefore FALLS monotonically as the beam lies down
 * on the entry face, and RISES as the internal ray approaches the critical angle at the
 * EXIT face. Computed over the swing: 5.98° of fan at θ1 = 62°, 10.91° at θ1 = 37°.
 * Measured on the picture at the same two aims — the vertical span of the fan at screen
 * column 240 — 18px and 33px at T913's physical Δn, ratio 1.83, within a hair of the
 * derived 1.82 (the exaggerated 0.085 read 108/46 = 2.35 — §V751). The exit face is where
 * dispersion is made; the entry face only decides how obliquely the ray arrives there.
 *
 * THE SWING stops at 37° and not lower, and the reason USED to be in the same arithmetic:
 * at n = 1.530 (T913's violet) the critical angle is 40.8°, θ3 reaches it at low θ1, and below that
 * the violet end TOTALLY INTERNALLY REFLECTS — which the old optics expressed by returning
 * a zero vector, so a band quietly left the spectrum. T718 removed that reason when it made
 * TIR a drawn PATH (reflect at the exit face, cross to the base, Snell out there), and
 * §V750 says a compensation outlives its cause unless somebody goes and looks. T857
 * widened the POINTER to 84° down to 6°, straight through the TIR onset — the violet end
 * turns before the red end, so between them the spectrum leaves through TWO FACES AT
 * ONCE, a picture only the hand can reach (T915 made the rest state static; and note
 * §T913's physical Δn narrowed that straddle band — real glass makes the two-face split
 * rarer than the old exaggerated spread did, a fidelity/legibility trade the aim owns).
 *
 * ONE SOURCE, TWO READINGS (§V471.1). `optics1` writes 65 points — the shaft, the ghost,
 * the drawn internal segment and its TIR continuation (T718),
 * and 61 bands — and two Geometries read the same pointset through a GROUP PREDICATE,
 * because they need different tapers: `shaft1` takes `p.role < 0.5` at taper 1, a
 * parallel-sided ribbon, and `fan1` takes `p.role > 0.5` at taper 0.06, because 61 beams
 * leaving the same face within 0.03 of each other fuse into an opaque wedge at any taper
 * above about zero (T680). The structure is a selection, not more nodes.
 *
 * THE GHOST IS THE PART THAT SAYS "SURFACE". Not every ray enters: Schlick on the same
 * incidence the refraction uses gives the share the entry face sends back, 4.3% at 37°
 * rising to 8.3% at 62°, and that share IS its tint — so the reflected streak brightens
 * as the fan narrows, from one number, with no second knob.
 *
 * THE BEAMS ARE DRAWN INSIDE THE BODY'S OWN DEPTH (z = 0.10, T758), which is the exact
 * inverse of the reasoning this paragraph carried before. The optics are solved in the
 * cross-section, which does not use the extrusion axis at all, so where along that axis
 * the segments are drawn is free — and while the body was OPAQUE the segments had to sit
 * in front of it so the solid could not swallow their ends. With a transmissive body,
 * swallowing IS the point (§V750): the interior thread is seen THROUGH the front face,
 * absorption-warmed. Gated in both directions: the shaft-group draw must hold a real
 * population inside an 8px erosion of the mask (the internal segment, 743 px measured at
 * the T718 swap) while the FAN keeps its no-burial claim at fewer than 30 px against a
 * red-verified real burial of 209 (§V751).
 *
 * THE POINTER OWNS THE AIM (T915b). T915 removed the LFOs; the owner came back: "Prism
 * example still has auto movement and reset after a time … i wanted exclusive mouse
 * control bro. no resets no auto swing and swivel." The residue was T857's authority
 * blend: `hold1` was a velocity envelope — it rose while the cursor moved and DECAYED
 * when it stopped, handing the aim back to a rest pose. Not an LFO, so the T915 audit
 * passed over it; but it changed when the input didn't, and that is the property that
 * matters. The whole `stir → urge → hold` branch is gone, and with it the blend.
 *
 * Now: `mouse1 → follow1(valueLag 0.18) → value1 (y) and value3 (x)` — position only.
 * y sets the angle across the full 6°–84° band; x walks the entry up the face and past
 * the apex into a real miss. The lag settles AT the pointer and stays there forever.
 * A never-moved cursor reads (0, 0): near-normal incidence at the base of the face —
 * Snell's converged white line, which TIRs at the exit face into the clean white V of
 * the reference's near-perpendicular shot. That IS the card (§V471).
 *
 * THE SWING IS NOT TOUCHED, and that is §T842's lesson rather than caution: the square,
 * the slam, and the two angles it visits are this example's character, so the fix is in how
 * the two terms COMBINE and not in what the auto term is. The widening lives entirely on
 * the pointer's own scale — 84° to 6°, against the swing's 62° to 37° — and the same one
 * knob walks the ENTRY POINT along the face from below the base vertex to past the apex,
 * because a beam you aim does not pivot about a fixed spot on the glass, and pinning the
 * entry point is exactly what made the old aim unable to miss. Past either vertex the ray
 * travels away from the body: the fan collapses to zero length and the shaft carries
 * straight on past the glass. MISSING IS A STATE, not a failure — it is the diagnostic the
 * owner asked for, and the picture stays coherent because the glass is lit by the
 * environment and never by the beam.
 *
 * The camera holds still at eye.x 0.45 (T915 removed its drift with the swing — static
 * aside from interaction). The cost is stated rather than hidden: `envFresnel` reads
 * `dot(N, viewDir)`, so a moving eye is what made the rim travel; at rest the rim sits
 * where the pose puts it, and the motion budget belongs entirely to the pointer.
 *
 * WHAT IS NOT HERE. There is no caustic on the base. The reference has one; we have no
 * refraction, so a caustic would be light we invented and placed, and §V617 means a beam
 * cannot cast one either. The glow under the prism is bloom spilling off the exit face,
 * which is a real thing that happens, and it is all this file claims.
 */
const PRISM_COLS = 240;

const PRISM_ROWS = 45;

/* T937: the geometry constants live in prism-geometry.ts — the one description the mesh
   and the traced SDF both render (§V818). Faces sit at PRISM_RC/2. */

/* T937 — THE ONE TILT. Cursor tilt (T928) plus LFO drift (T934), authored once and
   handed BY NAME to both form1 (which rotates the mesh) and optics1 (which traces in
   body space): the glass and the light cannot disagree about where the body points. */
const TILT_YAW_EXPR = "clamp(op('follow1').chan.x, 0, 1) * 0.44 - 0.10 + clamp(op('driftyaw1').chan.value, -1, 1) * 0.05";
const TILT_NOD_EXPR = "clamp(op('follow1').chan.y, 0, 1) * 0.22 - 0.05 + clamp(op('driftnod1').chan.value, -1, 1) * 0.03";

/** The band the glass is drawn WITH: 61 refracted rays plus the shaft and its ghost. */
const PRISM_BANDS = 61;

/**
 * The prism's SURFACE. A tube is a grid with its u seam closed, which is exactly the
 * topology a prism's lateral loop needs (T296/T301) — `bar1` is here for its `cols`,
 * `rows` and wrapU and nothing else, because every position below is replaced.
 *
 * THE ROUNDED TRIANGLE IS THE MECHANISM, not a styling choice. §V640: the environment
 * band is a rim only where the surface CURVES AWAY, and it degrades into fill on a flat
 * camera-facing face. So the cross-section is walked by ARC LENGTH — three straight runs
 * joined by three 120° arcs — and the profile puts a quarter-round where each flat cap
 * meets the barrel. Along a straight run the surface renderer's central difference is
 * collinear, so the face normal is EXACTLY constant and the faces stay flat and black;
 * across an arc the normal sweeps 120° and passes through grazing, so a thread of
 * surface at grazing runs the whole way round the triangle from any camera.
 *
 * Rounding the corners does not move the faces: a straight run sits at d·cos(60°) + ρ
 * from the axis, and with d = RC − 2ρ that is RC/2 for EVERY ρ — a sharp triangle's
 * inradius. That identity is why `optics1` can share this geometry from one constant.
 */
/**
 * T918 — THE WALL: an in-scene backdrop plane, the reference pipeline's own structure
 * ("Backdrop render pass" before the glass draws). materialGlass is SCREEN-SPACE
 * transmission — it refracts what the render already drew behind the surface — so a glass
 * body against a void refracts nothing and reads as an outline however correct the
 * material is. A dim structured wall IN the scene gives the transmission something to
 * carry, gives the eye the body's silhouette as a dark shape against light, and leaves
 * the environment equirect exactly what §V640 measured it as: the rim instrument.
 */
const WALL_COLS = 48;
const WALL_ROWS = 27;
const WALL_PLACE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* A plane behind the prism, wide enough for the 26-degree lens at z = -2.2. XY stays the
     clip square the texture bridge reads back (§V801) — x runs past ±1 and the sample
     CLAMPS, which a horizontally-constant gradient never shows. */
  let u = f32(ctx.dim.i) / f32(ctx.dim.cols - 1u);
  let v = f32(ctx.dim.j) / f32(ctx.dim.rows - 1u);
  q.position = vec3f((u * 2.0 - 1.0) * 3.9, (v * 2.0 - 1.0) * 2.2, -2.2);
  return q;
}`;

const PRISM_FORM_KERNEL = `const PI: f32 = 3.14159265358979323846;
const TAU: f32 = 6.28318530717958647692;
/* T937 — the numbers come from prism-geometry.ts, the ONE description this mesh and the
   optics' marched SDF both render (§V818). prism-geometry.test.ts holds every vertex of
   this walk to |sd3| < 1e-6; change a constant here without the shared module and that
   gate refuses. */
const RC: f32 = ${PRISM_RC};
const RHO: f32 = ${PRISM_RHO};
const HALF: f32 = ${PRISM_HALF};
const EDGE: f32 = ${PRISM_EDGE};

/* T928 — the FACETED inset contour: the level set of the diamond-cut cross-section at
   -pull. Six planes inset together; while pull < RHO the corner chamfer still bites and
   the contour is a hexagon, past it the corner collapses onto the sharp vertex (the
   faces inset 2:1 faster than the cut). Mirrored float64 in prism-geometry.ts; the
   |sd3| < 1e-6 gate holds the two together. */
fn contourNormal(k: u32) -> vec2f {
  if (k == 0u) { return vec2f(0.86602540, 0.5); }
  if (k == 1u) { return vec2f(-0.86602540, 0.5); }
  return vec2f(0.0, -1.0);
}

fn meet2(n1: vec2f, o1: f32, n2: vec2f, o2: f32) -> vec2f {
  let det = n1.x * n2.y - n1.y * n2.x;
  return vec2f(o1 * n2.y - o2 * n1.y, n1.x * o2 - n2.x * o1) / det;
}

fn insetContour(u: f32, pull: f32) -> vec2f {
  let face = RC * 0.5 - pull;
  let cut = RC - RHO - pull;
  var verts: array<vec2f, 6>;
  for (var k = 0u; k < 3u; k = k + 1u) {
    let nA = contourNormal(k);
    let nB = contourNormal((k + 1u) % 3u);
    let nC = -contourNormal((k + 2u) % 3u);
    let sharp = meet2(nA, face, nB, face);
    if (dot(sharp, nC) > cut) {
      verts[k * 2u] = meet2(nA, face, nC, cut);
      verts[k * 2u + 1u] = meet2(nC, cut, nB, face);
    } else {
      verts[k * 2u] = sharp;
      verts[k * 2u + 1u] = sharp;
    }
  }
  var lengths: array<f32, 6>;
  var total = 0.0;
  for (var i = 0u; i < 6u; i = i + 1u) {
    lengths[i] = distance(verts[i], verts[(i + 1u) % 6u]);
    total = total + lengths[i];
  }
  var s = fract(u) * total;
  for (var i = 0u; i < 6u; i = i + 1u) {
    if (s <= lengths[i] || i == 5u) {
      let f = select(0.0, min(s / lengths[i], 1.0), lengths[i] > 0.0);
      return mix(verts[i], verts[(i + 1u) % 6u], f);
    }
    s = s - lengths[i];
  }
  return verts[0];
}

/* Flat cap disc, ONE straight 45-degree chamfer band (the diamond cut), straight
   barrel, and back. The cap collapses to the axis at a = 0 and a = 1. */
fn shell(u: f32, a: f32) -> vec3f {
  if (a <= 0.10) {
    let t = a / 0.10;
    return vec3f(insetContour(u, EDGE) * t, HALF);
  }
  if (a <= 0.36) {
    let s = (a - 0.10) / 0.26;
    return vec3f(insetContour(u, EDGE * (1.0 - s)), HALF - EDGE * s);
  }
  if (a <= 0.64) {
    let t = (a - 0.36) / 0.28;
    return vec3f(insetContour(u, 0.0), mix(HALF - EDGE, -(HALF - EDGE), t));
  }
  if (a <= 0.90) {
    let s = (0.90 - a) / 0.26;
    return vec3f(insetContour(u, EDGE * (1.0 - s)), -(HALF - EDGE * s));
  }
  let t = (1.0 - a) / 0.10;
  return vec3f(insetContour(u, EDGE) * t, -HALF);
}

struct Params {
  tiltYaw: f32,
  tiltNod: f32,
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* wrapU: the u parametrization is EXCLUSIVE, so i/cols closes the seam exactly. */
  let u = f32(ctx.dim.i) / f32(ctx.dim.cols);
  let a = f32(ctx.dim.j) / f32(ctx.dim.rows - 1u);
  var pos = shell(u, a);
  /* T928/T934/T937 — ONE tilt, computed once in the document's expressions (cursor tilt
     plus LFO drift) and handed to BOTH this mesh and the optics kernel by name, so the
     body and the light can never disagree about where the glass is pointing. */
  let cy = cos(ctx.params.tiltYaw); let sy = sin(ctx.params.tiltYaw);
  pos = vec3f(pos.x * cy + pos.z * sy, pos.y, -pos.x * sy + pos.z * cy);
  let cx = cos(ctx.params.tiltNod); let sx = sin(ctx.params.tiltNod);
  pos = vec3f(pos.x, pos.y * cx - pos.z * sx, pos.y * sx + pos.z * cx);
  q.position = pos;
  return q;
}`;

/**
 * T945a — THE BEAM IN THE GLASS'S EYES. materialGlass's reflection samples ONLY the
 * environment equirect, so the beams could never sparkle in the body no matter how the
 * edges were cut. Rather than a new shading path, the environment itself carries the
 * lamp: this shader adds a bright angular spot AT the lamp's direction into the studio
 * equirect. Painted by DIRECTION distance, not uv distance — the lamp lives in the
 * z = 0 plane where equirect azimuth is degenerate, and a uv-space spot would tear as
 * the lamp crosses x = 0; an angular gaussian is continuous everywhere. `lampPhi` rides
 * the same follow1 expression family as everything else the hand steers.
 */
const BEAM_ENV_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  lampPhi: f32,
  gain: f32,
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  /* Inverse of the renderer's sampleEnvironment mapping (scene-render.wgsl.ts):
     u = atan2(x, -z)/2pi + 0.5, v = acos(y)/pi. */
  let azimuth = (uv.x - 0.5) * 6.2831853;
  let polar = uv.y * 3.14159265;
  let d = vec3f(sin(polar) * sin(azimuth), cos(polar), -sin(polar) * cos(azimuth));
  let lamp = vec3f(cos(params.lampPhi), sin(params.lampPhi), 0.0);
  let angle = acos(clamp(dot(d, lamp), -1.0, 1.0));
  /* A hot core and a soft halo — what a bare beam source looks like to a glossy face. */
  let spot = exp(-(angle * angle) / (0.06 * 0.06)) + 0.25 * exp(-(angle * angle) / (0.30 * 0.30));
  return vec4f(color.rgb + vec3f(1.0, 0.98, 0.94) * spot * params.gain, color.a);
}`;

/** `tip` is the beam's far end (T680 binds it by name); `role` is what splits ONE
 *  pointset into two draws with different tapers; `tint` is `color`-qualified (§V313). */
const PRISM_OPTICS_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tip", type: "vec3f", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "role", type: "f32", default: [1] },
]);

/**
 * T940 — THE DUST. "a basically black background and then just some of these animated
 * dust particles in the path that catch the light" — and the physics reason it is
 * structural, not decorative: a beam in air is visible ONLY by particulate scatter, so
 * the scatter the owner missed IS this cloud. Each mote drifts deterministically and is
 * lit by its distance to the beam's own traced path — the same trace head, the same aim
 * expressions, the same tilt params as optics1, so the light the dust catches cannot
 * disagree with the beam the fan draws.
 */
export const PRISM_DUST_KERNEL = `${PRISM_TRACE_KERNEL_HEAD}
const RI: f32 = ${PRISM_RC} / 2.0;

struct Params {
  tiltYaw: f32,
  tiltNod: f32,
  /* T940c — the owner's knob: ONE number scales every mote's drift. 1 is the shipped
     pace (a mote crosses the frame in ~20 minutes); 10 is a draught; 0 freezes the air. */
  driftSpeed: f32,
}

fn scatterTo(p: vec3f, a: vec3f, b: vec3f, sigma: f32) -> f32 {
  let ab = b - a;
  let h = clamp(dot(p - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  let d = length(p - a - ab * h);
  return exp(-(d * d) / (sigma * sigma));
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* A drifting mote: seeded box position plus a VERY slow deterministic wander (the
     owner: "very very subtle" — a mote crosses the frame in minutes, not seconds), with
     a faint sinusoidal float so nothing moves in straight lines. Deterministic: a
     clock, not an RNG (§V74). */
  let r1 = pointRand(ctx.index, 11u);
  let r2 = pointRand(ctx.index, 23u);
  let r3 = pointRand(ctx.index, 37u);
  let r4 = pointRand(ctx.index, 51u);
  let r5 = pointRand(ctx.index, 67u);
  /* MIRRORED wrap (a triangle wave), not fract: a fract wrap TELEPORTS a mote across
     the box, and 650 motes wrapping at mixed speeds read as a blizzard's shuffle —
     the owner's exact report. A mirrored path just drifts back. And slower still:
     a mote crosses the frame in ~20 minutes; the room is ALMOST undisturbed. */
  let pace = ctx.params.driftSpeed;
  let wander = ctx.absTime * pace * (0.0004 + 0.0007 * r4);
  let bob = sin(ctx.absTime * pace * (0.03 + 0.06 * r5) + r1 * 6.2832) * 0.015;
  let mote = vec3f(
    (abs(fract(r1 + wander * 0.7) * 2.0 - 1.0) * 2.0 - 1.0) * 2.6,
    (abs(fract(r2 + wander) * 2.0 - 1.0) * 2.0 - 1.0) * 1.4 + bob,
    (abs(fract(r3 + wander * 0.4) * 2.0 - 1.0) * 2.0 - 1.0) * 1.3,
  );
  q.position = mote;
  /* Size: real spread — most motes tiny, a few larger (r5 squared skews small).
     The BASE is tiny (the owner, twice): dust specks, not orbs. */
  q.size = 0.25 + 0.9 * r5 * r5;

  /* The SAME beam the optics trace: lamp, aim, tilt — one set of expressions. */
  let px = clamp(ctx.value3, 0.0, 1.0);
  let py = clamp(ctx.value1, 0.0, 1.0);
  let phi = mix(ARC_A, ARC_B, px) * PI / 180.0;
  let S2 = vec2f(cos(phi), sin(phi)) * LAMP_R;
  let ahead = normalize(-S2);
  let aside = vec2f(-ahead.y, ahead.x);
  let dIn2 = normalize(-S2 + aside * (py * OFF_MAX));
  let yaw = ctx.params.tiltYaw;
  let nod = ctx.params.tiltNod;
  let S = toBody(vec3f(S2, 0.0), yaw, nod);
  let dIn = normalize(toBody(vec3f(dIn2, 0.0), yaw, nod));
  let nMid = cauchyN(0.5, ctx.value2);
  let mid = tracePrism(S, dIn, nMid, RI);
  let hit = mid.ok > 0.5;

  let sW = toWorld(S, yaw, nod);
  let entryW = toWorld(select(S + dIn * MISS_LEN, mid.entry, hit), yaw, nod);
  /* Shaft scatter: a bright CORE plus a wide soft skirt — the owner: motes should catch
     the beam "within a reasonable area around" it, with falloff, not only inside it. */
  /* Wider core: a slower fade in/out as the beam's sweep crosses a mote. */
  var glow = 1.2 * scatterTo(mote, sW, entryW, 0.09)
           + 0.3 * scatterTo(mote, sW, entryW, 0.32);
  /* Exit scatter: the central band's ray, when it leaves. */
  let gone = hit && dot(mid.exitDirection, mid.exitDirection) > 1.0e-9;
  if (gone) {
    let rootW = toWorld(mid.exitPoint, yaw, nod);
    let tipW = toWorld(mid.exitPoint + mid.exitDirection * FAN_LEN, yaw, nod);
    glow = glow + 0.9 * scatterTo(mote, rootW, tipW, 0.11)
                + 0.25 * scatterTo(mote, rootW, tipW, 0.38);
  }
  /* Barely-there ambient dust, so the room reads as air rather than void — and varied
     per mote, because uniform dust reads as a starfield (measured on the card). The
     tint attribute is colour-qualified, so these are LINEAR numbers (§V313). */
  /* The floor drops: an unlit mote is BARELY there — light is what reveals dust. */
  let b = (glow + 0.0012) * (0.35 + 0.65 * r4);
  /* T940b: the ALPHA carries the azimuth light ARRIVES from — the direction from the
     beam's nearest point to this mote — so the spherical splat shades a lit and an
     unlit side that genuinely face the ray. */
  let ab = mote - sW;
  let axis = entryW - sW;
  let h = clamp(dot(ab, axis) / max(dot(axis, axis), 1e-6), 0.0, 1.0);
  let fromBeam = mote - (sW + axis * h);
  /* Normalized to [0,1] — the colour qualifier's range — and rescaled in the shader. */
  let litFrom = (atan2(fromBeam.y, fromBeam.x) + PI) / 6.28318530717958647692;
  q.tint = vec4f(vec3f(b) * vec3f(0.95, 0.97, 1.05), litFrom);
  return q;
}`;

/**
 * THE OPTICS — T718: a TRACED ray, not a picture of one. The kernel lives in
 * `shaders/prism-trace.wgsl.ts` (imported like GRAY_SCOTT_WGSL) and emits the full
 * three-segment path: the shaft meets the entry face; a DRAWN internal segment crosses
 * the body at the refracted angle — the piece the previous optics computed and never
 * drew, and the owner's exact words for what was missing ("the ray visible in the
 * interior"); and the fan opens at each band's OWN exit point on the exit face. Total
 * internal reflection is a PATH now, not a deletion: past the critical angle a band
 * reflects at the exit face, crosses to the base and Snells there. Nothing is an
 * authored angle, and the §V683 gates (prism-trace.gpu.test.ts) hold every segment
 * against scalar Snell computed from the domain, including the TIR and apex cases.
 * RI is the same PRISM_RC/2 identity the mesh shares; the extra two slots are the
 * internal segment and its TIR continuation (zero-length when the ray exits cleanly).
 */
export const prismDocument = document(
  "e13-prism",
  "E13 Prism",
  settings({
    randomSeed: 23,
    // T914: the owner asked for 1080p — 720p was part of the pixelation they reported.
    // Within limits.maxResolution (4096); the look baseline and card move with it, both
    // re-measured in this commit (§V642).
    outputResolution: { width: 1920, height: 1080 },
  }),
  graph(
    [
      // ---- the aim: the pointer over a STATIC default (T915) -----------------------
      // The swing LFO is GONE — the owner: "it should be static aside from user
      // interaction". The default aim is value1's static payload below; the pointer takes
      // the aim while it moves (T857) and the lag chain hands it back to the static.
      node("mouse", "mouse", [-1880, 840], {}, { label: "mouse1" }),
      node("follow", "valueLag", [-1560, 840], { lag: 0.18 }, { label: "follow1" }),
      /* T934 — PASSIVE BODY DRIFT, on the OBJECT and never the aim. The owner: "slight
         rotate, pivot, swivel … driven by lfos … different frequencies resp slight
         offsets for the different axis". Two sines at mutually incommensurate
         frequencies (0.041 Hz and 0.067 Hz — 24.4s against 14.9s, ratio 1.63…) with
         different phases: the pair never visibly repeats, yet every frame reproduces
         (§V74 — a clock, not an RNG). They feed form1's spare slots only; the pointer
         still owns the ray, and the T915b gate now proves the SEPARATION. */
      /* T940d: these two ALSO set how fast the beam sweeps the dust — the lit subset of
         motes churns at the body's drift rate, which read as dust "movement" no matter
         what the motes themselves did. Slowed 3x; both frequencies are ordinary node
         params, tune them in the inspector. */
      node("driftyaw", "lfo", [-1560, 1020], { shape: "sine", frequency: 0.013, phase: 0.13 }, { label: "driftyaw1" }),
      node("driftnod", "lfo", [-1560, 1280], { shape: "sine", frequency: 0.021, phase: 0.71 }, { label: "driftnod1" }),
      // itself, which is the only absolute value the CHOP set has and is also the right
      // 0.6s to fall, so the hand keeps the aim for a second or two after it stops and
      // then gives it back. A cursor that has never moved reads EXACTLY zero through all
      // three, which is what keeps every other gate in the suite on the swing's picture.

      // ---- the wall (T918) --------------------------------------------------------
      node("wallramp", "ramp", [-2200, -420], {
        type: "vertical", interp: "smooth", phase: 0, period: 1,
        /* T919 (§V56 traced): these are DISPLAY numbers (ramp stops decode once, correctly
           — measured: the warm band renders at exactly its authored value plus bloom), so
           what you type here is the screen grey you get. Authored for a backdrop that
           reads as a lit wall behind the glass, not a void. */
        /* T928: muted — the owner: "a bit more muted". The warm band drops 0.52 -> 0.30
           and cools toward neutral; the cool band settles with it. Still a wall, no
           longer a sunset. */
        /* T940: near-black — the owner: "basically black background". The dust replaces
           the wall as the transmission's content; what remains here is only enough
           gradient that the frame has depth rather than a void. */
        stops: [
          { position: 0.00, color: [0.010, 0.012, 0.020, 1] },
          { position: 0.42, color: [0.030, 0.034, 0.046, 1] },
          { position: 0.62, color: [0.055, 0.050, 0.046, 1] },
          { position: 0.80, color: [0.025, 0.025, 0.027, 1] },
          { position: 1.00, color: [0.008, 0.008, 0.012, 1] },
        ],
      }, { label: "wallramp1", definitionVersion: 2, resolution: { mode: "fixed", width: 64, height: 256 } }),
      node("wallgrid", "pointGrid", [-2200, -200], { count: WALL_COLS * WALL_ROWS, cols: WALL_COLS, rows: WALL_ROWS }, { label: "wallgrid1" }),
      node("wallplace", "pointKernel", [-1880, -200], {
        capacity: WALL_COLS * WALL_ROWS, seed: 3,
        attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
        kernel: WALL_PLACE_KERNEL,
      }, { label: "wallplace1" }),
      node("wallskin", "textureToAttribute", [-1560, -200], { count: WALL_COLS * WALL_ROWS }, { label: "wallskin1" }),
      node("wall", "geometry", [-920, -160], {
        mode: "surface", material: "flare1", tint: [1, 1, 1, 1],
      }, { label: "wall1", parameters: { tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "sample" } } } } }),

      // ---- the glass -------------------------------------------------------------
      node("bar", "pointTube", [-1880, -420], { count: PRISM_COLS * PRISM_ROWS, cols: PRISM_COLS, rows: PRISM_ROWS }, { label: "bar1" }),
      node("form", "pointKernel", [-1560, -420], {
        capacity: PRISM_COLS * PRISM_ROWS,
        attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
        kernel: PRISM_FORM_KERNEL,
      }, {
        label: "form1",
        // T937: the kernel's own struct Params (T900 reflection) — named, not numbered.
        parameters: {
          tiltYaw: expressionSlot(TILT_YAW_EXPR, -0.1),
          tiltNod: expressionSlot(TILT_NOD_EXPR, -0.05),
        },
      }),
      // The environment term compiles for PHONG only, and nothing warns you otherwise: a
      // lambert or unlit prism has no Fresnel and therefore no rim at all. Diffuse is
      // 0.0009 linear — the body is meant to be black — and the whole read is `specular`
      // times `envFresnel`, which is 0.04 head-on and 1.0 at grazing.
      /* T758 — the REAL glass (T725), on the example the owner complained about. The
         body is transmissive now: it samples the frame behind it through the blur
         pyramid, so the T718 interior segment — which lives inside the body since this
         change — is seen THROUGH the front face, absorption-warmed, with dispersion
         fringes where the rounded edges refract the fan. The rim survives by the same
         physics under a different name: the glass model's Schlick fresnel against the
         wired environment peaks at grazing exactly as the phong envFresnel did. */
      node("glass", "materialGlass", [-1560, -640], {
        // T918: ONE dispersion model. The optics kernel owns the spectrum (value2 = 0.03,
        // §T913's dense flint); the body's screen-space fringing follows the SAME number, so
        // the material cannot paint a second, stronger rainbow over the traced one — the
        // 0.06 here was the lead suspect for "the ray is rainbow before it reaches the glass".
        ior: 1.5, roughness: 0.04, thickness: 1.1, absorption: [0.06, 0.05, 0.02, 1], dispersion: 0.03,
      }, { label: "glass1" }),
      node("solid", "geometry", [-1240, -420], { mode: "surface", material: "glass1", tint: [1, 1, 1, 1] }, { label: "solid1" }),

      // ---- the light, taken apart ------------------------------------------------
      // A ramp that GOES somewhere (§V471.6), and it is not decoration: this is the
      // curve n(t) is read against, so retuning it retunes the spectrum's colour without
      // touching a line of WGSL.
      node("spectrum", "ramp", [-1880, 100], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0.00, color: [1, 0.10, 0.06, 1] },
          { position: 0.17, color: [1, 0.42, 0.05, 1] },
          { position: 0.33, color: [1, 0.86, 0.10, 1] },
          { position: 0.50, color: [0.28, 1, 0.24, 1] },
          { position: 0.66, color: [0.10, 0.82, 1, 1] },
          { position: 0.83, color: [0.16, 0.30, 1, 1] },
          { position: 1.00, color: [0.55, 0.14, 1, 1] },
        ],
      }, { label: "spectrum1", definitionVersion: 2, resolution: { mode: "fixed", width: 256, height: 8 } }),
      node("optics", "pointKernel", [-1560, 100], {
        /* T920: the beam — 2 fixed slots + SLICES(9) x BANDS(61) x 3 legs. */
        capacity: 2 + 9 * PRISM_BANDS * 3,
        attributes: PRISM_OPTICS_ATTRIBUTES,
        kernel: prismTraceKernel((PRISM_RC / 2).toFixed(3)),
        // The glass's DISPERSIVE POWER, and the one number the whole effect rests on:
        // n runs 1.500 (red) to 1.530 (violet), Cauchy (T913). Set it to 0 and the fan collapses to a
        // single ray, which is what the gate asserts.
        value2: 0.03,
      }, {
        label: "optics1",
        // T915b — the pointer OWNS the aim, both axes, exclusively: y is the angle
        // (6°–84°), x walks the entry up the face and off past the apex. Nothing
        // decays, nothing blends against a rest pose — a parked cursor is a parked
        // beam. The only motion filter is follow1's positional lag, which settles AT
        // the pointer, never back toward anything.
        parameters: {
          /* T915: the STATIC default aim — the rest state IS the shipped image now, so it is
             chosen, not inherited from where the swing's midpoint fell (§V471). 1 is the
             band's steep end (θ1 = 37°), the aim the picture gate measures the WIDEST fan
             at — the frame that shows §T913's dispersion rather than a white line. */
          value1: drivenSlot("follow1:y", 0),
          value3: drivenSlot("follow1:x", 0),
          // T937: the SAME tilt the mesh wears — the trace runs in body space.
          tiltYaw: expressionSlot(TILT_YAW_EXPR, -0.1),
          tiltNod: expressionSlot(TILT_NOD_EXPR, -0.05),
        },
      }),
      // UNLIT, and white: a beam is scattered light in the air, not a surface, and it
      // takes no part in shadowing either (§V617). The colour is the attribute's.
      node("flare", "materialUnlit", [-2520, -140], { color: [1, 1, 1, 1] }, { label: "flare1" }),
      // §V471.1 — ONE SOURCE, TWO READINGS, split by a group predicate rather than by
      // more nodes. The split is not cosmetic: a single shaft wants a parallel-sided
      // ribbon, and 61 beams leaving the same face within 0.03 of each other fuse into
      // an opaque wedge at any taper above about zero (T680).
      node("shaft", "geometry", [-1240, -84], {
        /* T917: SOFT + ADDITIVE — the beams are light now, not ribbons of paint. The soft
           profile falls off across the width; additive lets the ghost, interior and shaft
           sum where they cross instead of z-fighting. */
        mode: "beam", endpoint: "tip", scale: 0.006, taper: 1, soft: 0.85, blend: "additive", material: "flare1", group: "p.role < 0.5",
      }, { label: "shaft1", parameters: { tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } } } }),
      node("fan", "geometry", [-1240, 100], {
        /* T917: the CONTINUUM — 61 soft bands overlapping ADDITIVELY blend into one
           spectrum, no new primitive: exactly the reference's 128-wavelength additive
           accumulation, at our band count. The width comes up slightly so neighbours
           genuinely overlap; the soft edge is what keeps that from reading as a slab. */
        /* T941: the WEDGE — the kernel writes each segment's true width into `size`
           and the draw maps scale from it; taper pinches the near end at the exit
           face. soft 1 + full-width overlap = the partition-of-unity crossfade. */
        mode: "beam", endpoint: "tip", scale: 4, taper: 0.02, soft: 1, blend: "additive", material: "flare1", group: "p.role > 0.5",
      }, { label: "fan1", parameters: {
        tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        /* T941: width = 4 (node scale) x tint.a (the kernel's segment width / 4). */
        scale: { mode: "map", bindings: { static: { kind: "static", value: 4 }, map: { kind: "map", attribute: "tint", channel: "w" } } },
      } }),
      // T941b — the IN-GLASS fan: interior wedge segments (role 0.5), width-mapped
      // like the exit fan, pinched at the shared entry point by the taper.
      node("core", "geometry", [-920, 100], {
        mode: "beam", endpoint: "tip", scale: 4, taper: 0.05, soft: 1, blend: "additive", material: "flare1",
        group: "p.role > 0.25 && p.role < 0.75", tint: [1, 1, 1, 1],
      }, { label: "core1", parameters: {
        tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        scale: { mode: "map", bindings: { static: { kind: "static", value: 4 }, map: { kind: "map", attribute: "tint", channel: "w" } } },
      } }),
      // T940 — the dust cloud (see PRISM_DUST_KERNEL above).
      node("dust", "pointKernel", [-1560, 340], {
        capacity: 650, seed: 7,
        attributes: JSON.stringify([
          { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
          { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
          { name: "size", type: "f32", default: [1] },
        ]),
        kernel: PRISM_DUST_KERNEL,
        value2: 0.03,
      }, {
        label: "dust1",
        parameters: {
          value1: drivenSlot("follow1:y", 0),
          value3: drivenSlot("follow1:x", 0),
          tiltYaw: expressionSlot(TILT_YAW_EXPR, -0.1),
          tiltNod: expressionSlot(TILT_NOD_EXPR, -0.05),
          driftSpeed: 1,
        },
      }),
      node("motes", "geometry", [-920, 300], {
        /* T940b: spherical soft splats, per-mote sizes — dust, not confetti. */
        mode: "points", scale: 0.004, soft: 1, spherical: true, blend: "additive", material: "flare1", tint: [1, 1, 1, 1],
      }, { label: "motes1", parameters: {
        tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        scale: { mode: "map", bindings: { static: { kind: "static", value: 0.004 }, map: { kind: "map", attribute: "size" } } },
      } }),

      // ---- the studio: an equirect whose horizon IS the rim -----------------------

      // v = acos(R.y)/pi, so 0.5 is the horizon; u = atan2(R.x, -R.z)/2pi + 0.5. A normal
      // lying in the cross-section plane reflects to (0,0,-1) and lands at (0.5, 0.5)
      // EXACTLY — §V640's band, at the address §V640 gives for it. The cap's normal
      // lands at u ~ 0.01 instead, well outside the band, which is why the body stays
      // black while the outline lights: one texture, two addresses.
      node("sky", "ramp", [-1880, -900], {
        type: "vertical", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0.00, color: [0, 0, 0, 1] },
          { position: 0.40, color: [0.004, 0.005, 0.009, 1] },
          { position: 1.00, color: [0, 0, 0, 1] },
        ],
      }, { label: "sky1", definitionVersion: 2, resolution: { mode: "fixed", width: 512, height: 256 } }),
      // `aspectcorrect` FALSE, always, on an equirect: the map is not a picture of a
      // square. Softness 0.16 and not more — the band's tail is what greys the body.
      node("band", "circle", [-1880, -680], {
        mode: "fill", center: [0.5, 0.5], radius: [0.26, 0.075], softness: 0.16,
        fillcolor: [0.74, 0.84, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: false,
      }, { label: "band1" }),
      node("studio", "add", [-1560, -900], {}, { label: "studio1", resolution: { mode: "fixed", width: 512, height: 256 } }),
      // T945a: the lamp painted INTO the environment — see BEAM_ENV_WGSL.
      node("beamglow", "customWgsl", [-920, -1080], {
        [SHADER_SOURCE_PARAMETER]: BEAM_ENV_WGSL,
        gain: 2.2,
      }, {
        label: "beamglow1",
        parameters: {
          // The lamp's azimuth in radians: phi = (185 - 360x) degrees, the same arc the
          // trace walks (T929) — one hand, one number, a third reader.
          lampPhi: expressionSlot("3.2289 - 6.2832 * clamp(op('follow1').chan.x, 0, 1)", 3.2289),
        },
      }),

      // ---- the shot --------------------------------------------------------------
      // ONE job: the direction is the mirror of the view about the upper-left
      // round-over's normal, so the Blinn lobe lands as a GLINT on that edge and nowhere
      // else. Measured: kill it and 8,387 pixels move by more than 4 luma.
      node("key", "light", [-1240, -900], {
        /* T940: a directional key is by definition light that is not the beam — down to a
           whisper that only keeps the wall's texture from reading as a hole. */
        kind: "directional", direction: [0.73, -0.60, 0.31], color: [0.80, 0.88, 1, 1], intensity: 0.3, shadows: false,
      }, { label: "key1" }),
      node("eye", "camera", [-1240, -680], {
        // 26 degrees is a long lens on purpose: this is a poster, and a wide one would
        // bend the spectrum's straight rays. The eye sits barely off the prism's own
        // axis, which is what keeps the lateral faces to a sliver instead of a slab.
        // T928/T930: centered — MEASURED, not nudged: at eye y -0.12 the body's screen
        // bbox centre sat 128px high (frame 960x540 centre, bbox x-centre 959.5 exact);
        // 128px is 0.36 world at z = 0 under this lens, so the pair shifts up by exactly
        // that. Horizontal was already exact, so x stays 0.
        eye: [0, 0.24, 6.6], lookAt: [0, 0.18, 0], fov: 26, near: 0.1, far: 40, ortho: false,
      }, { label: "eye1" }),
      node("shot", "render", [-920, -420], {
        scenes: "wall1 solid1 core1 fan1 shaft1 motes1", camera: "eye1", lights: "key1",
        // AMBIENT ZERO, and it is E33's lesson rather than taste (§V632/T636): the
        // physical terms here are a 4% head-on Fresnel and a 0.0009 albedo, so any
        // ambient worth the name drowns them and the glass goes to grey slate.
        ambientColor: [0, 0, 0, 1], ambientIntensity: 0,
        /* T940/T930: the room is DARK — the reference's glass reads from what the light
           DOES (the traced interior, the dust's scatter, the fan), not from being lit.
           env 3.2 -> 0.7 keeps just enough rim to draw the silhouette; the key drops to
           a whisper. Asked three times; done with the dust in the same change so it
           reads as a dark ROOM, not a dead one. */
        background: [0, 0, 0, 1], environmentIntensity: 0.7, showEnvironment: false,
        /* T939: SSAA over MSAA here deliberately — the fan is shader-thin additive
           ribbons, and supersampling SHADES its four samples where MSAA only covers. */
        antialias: "ssaa",
      }, { label: "shot1" }),

      // ---- the bloom, and the clamp that is load-bearing --------------------------
      // Level is a SIGNED pipeline: below `blacklevel` it emits negatives, the blur
      // spreads them over the whole frame and `add` then SUBTRACTS a halo from the
      // picture. On a document this black almost every pixel is below the threshold, so
      // without `clip1` the frame goes out entirely (E33's and E34's lesson, twice).
      node("cut", "level", [-600, -140], { blacklevel: 0.32, whitelevel: 1, gamma1: 1, contrast: 1, brightness: 1, opacity: 1 }, { label: "cut1" }),
      node("clip", "limit", [-280, -140], { mode: "clamp", low: 0, high: 6, steps: 4 }, { label: "clip1" }),
      node("halo", "blur", [40, -140], { size: 22, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("glow", "add", [360, -420], {}, { label: "glow1" }),
      node("out", "output", [680, -420], {}, { label: "out1" }),
    ],
    [
      edge("e-wallgrid-place", ["wallgrid", "out"], ["wallplace", "in"]),
      edge("e-place-skin", ["wallplace", "out"], ["wallskin", "points"]),
      edge("e-wallramp-skin", ["wallramp", "out"], ["wallskin", "texture"]),
      edge("e-skin-wall", ["wallskin", "out"], ["wall", "points"]),
      edge("e-mouse-follow", ["mouse", "out"], ["follow", "in"]),

      edge("e-bar-form", ["bar", "out"], ["form", "in"]),
      edge("e-dust-motes", ["dust", "out"], ["motes", "points"]),
      edge("e-form-solid", ["form", "out"], ["solid", "points"]),

      edge("e-spectrum-optics", ["spectrum", "out"], ["optics", "field"]),
      edge("e-optics-shaft", ["optics", "out"], ["shaft", "points"]),
      edge("e-optics-fan", ["optics", "out"], ["fan", "points"]),
      edge("e-optics-core", ["optics", "out"], ["core", "points"]),

      edge("e-sky-studio", ["sky", "out"], ["studio", "in1"]),
      edge("e-band-studio", ["band", "out"], ["studio", "in2"], 0),
      edge("e-studio-beamglow", ["studio", "out"], ["beamglow", "input"]),
      edge("e-beamglow-shot", ["beamglow", "out"], ["shot", "environment"]),

      edge("e-shot-cut", ["shot", "out"], ["cut", "input"]),
      edge("e-cut-clip", ["cut", "out"], ["clip", "input"]),
      edge("e-clip-halo", ["clip", "out"], ["halo", "input"]),
      edge("e-shot-glow", ["shot", "out"], ["glow", "in1"]),
      edge("e-halo-glow", ["halo", "out"], ["glow", "in2"], 0),
      edge("e-glow-out", ["glow", "out"], ["out", "input"]),
    ],
  ),
);
