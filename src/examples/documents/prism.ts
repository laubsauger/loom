import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";
import { prismTraceKernel } from "../shaders/prism-trace.wgsl.ts";

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
 *   swing1(lfo, square) ─► ease1(valueLag) ┄drives┄► optics1.value1   the AIM
 *   mouse1 ─► follow1(valueLag) ┄drives┄► optics1.value3              the AIM, +pointer
 *   drift1(lfo, sine) ┄drives┄► eye1.eye.x
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
 * at the right face, cross to the left face plane, refract out. n runs 1.500 (red) to
 * 1.585 (violet) — real crown glass disperses about a sixth of that, and the
 * exaggeration is `value2`, a number this file owns rather than a constant hidden in the
 * kernel. Sixty-one bands take their colour from `spectrum1` through the kernel's own
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
 * column 240 — 46px and 108px, a ratio of 2.35. The exit face is where dispersion is
 * made; the entry face only decides how obliquely the ray arrives there.
 *
 * θ1 stops at 37° and not lower for a reason that is in the same arithmetic: at n = 1.585
 * the critical angle is 39.1°, and θ3 reaches it at θ1 ≈ 33.7°. Below that the violet end
 * TOTALLY INTERNALLY REFLECTS. `refract2` returns a zero vector there and the beam
 * collapses to zero length — which the beam shader already draws as zero AREA — so the
 * failure is a band quietly leaving the spectrum rather than a wrong picture. 37° keeps
 * 3.3° of margin at the violet end.
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
 * THE BEAMS ARE DRAWN IN A PLANE 0.05 IN FRONT OF THE FRONT FACE, and that is the one
 * cheat in the file, stated. The optics are solved in the cross-section, which does not
 * use the extrusion axis at all; drawing the segments at z = 0.60 instead of inside the
 * body is a shift along exactly that unused axis, and it is what stops the prism's own
 * solid from swallowing the ends of the shaft and the fan. Gated: the shaft's tip lands
 * 1px from the prism's mask and NO beam pixel reaches an 8px erosion of it, so "the beam
 * arrives where the glass is" is a measurement, not a hope.
 *
 * TWO WAYS TO MOVE THE AIM, and they are added in the KERNEL rather than merged on a
 * wire. `swing1(lfo, square) → ease1(valueLag) → value1` is the canonical chain and the
 * square is deliberate: a square through a one-pole smoother IS an ease, so delete
 * `ease1` and the beam snaps between two angles like a shutter instead of swinging.
 * `mouse1 → follow1(valueLag) → value3` is the pointer, and the kernel computes
 * `clamp(value1 + 0.55·value3, 0, 1)` — a value graph merges channel BAGS, and an LFO's
 * channel and a pointer's `x` do not have a name in common, so the addition belongs where
 * both numbers already are. The pointer only ever ADDS: a pointer that has never moved
 * reads 0, so every gate and every fresh session sees the LFO's picture exactly, and
 * dragging right lays the beam down and opens the spectrum.
 *
 * `drift1` sways the camera 0.22 either side of 0.45 over 22 seconds, and that is not
 * decoration: `envFresnel` reads `dot(N, viewDir)`, so moving the eye moves WHICH thread
 * of the round-over is at grazing. The rim travels. A static camera over this material is
 * the one thing that would make an edge-lit prism look painted.
 *
 * WHAT IS NOT HERE. There is no caustic on the base. The reference has one; we have no
 * refraction, so a caustic would be light we invented and placed, and §V617 means a beam
 * cannot cast one either. The glow under the prism is bloom spilling off the exit face,
 * which is a real thing that happens, and it is all this file claims.
 */
const PRISM_COLS = 240;

const PRISM_ROWS = 45;

/** Circumradius of the triangular cross-section. Its faces sit at PRISM_RC/2 (see below). */
const PRISM_RC = 0.76;

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
const PRISM_FORM_KERNEL = `const PI: f32 = 3.14159265358979323846;
const TAU: f32 = 6.28318530717958647692;
const RC: f32 = ${PRISM_RC};
/** Corner radius. Small — the corners are where the normal sweeps FASTEST. */
const RHO: f32 = 0.046;
const HALF: f32 = 0.55;
/** The quarter-round at the cap edge, radially and axially. This is the rim's WIDTH. */
const ER: f32 = 0.120;
const EZ: f32 = 0.120;

fn contour(u: f32) -> vec2f {
  let d = RC - 2.0 * RHO;
  let seg = sqrt(3.0) * d;
  let arc = RHO * TAU / 3.0;
  let unit = seg + arc;
  let s = u * 3.0 * unit;
  let k = floor(s / unit);
  let local = s - k * unit;
  let phi = PI * 0.5 + k * TAU / 3.0;
  let c = vec2f(cos(phi), sin(phi)) * d;
  if (local < arc) {
    let psi = phi - PI / 3.0 + local / RHO;
    return c + vec2f(cos(psi), sin(psi)) * RHO;
  }
  let outward = vec2f(cos(phi + PI / 3.0), sin(phi + PI / 3.0));
  let a = c + outward * RHO;
  let b = vec2f(cos(phi + TAU / 3.0), sin(phi + TAU / 3.0)) * d + outward * RHO;
  return mix(a, b, (local - arc) / seg);
}

/* Radius scale and z, along the axis: flat cap, quarter-round, barrel, and back again.
   The cap collapses to the axis at a = 0 and a = 1, which closes the solid — a quad with
   two coincident corners is a triangle, so the last ring is a fan. */
fn profile(a: f32) -> vec2f {
  if (a <= 0.10) { return vec2f((1.0 - ER) * (a / 0.10), HALF); }
  if (a <= 0.36) {
    let th = (a - 0.10) / 0.26 * (PI * 0.5);
    return vec2f(1.0 - ER * (1.0 - sin(th)), HALF - EZ * (1.0 - cos(th)));
  }
  if (a <= 0.64) { return vec2f(1.0, mix(HALF - EZ, -(HALF - EZ), (a - 0.36) / 0.28)); }
  if (a <= 0.90) {
    let th = (0.90 - a) / 0.26 * (PI * 0.5);
    return vec2f(1.0 - ER * (1.0 - sin(th)), -(HALF - EZ * (1.0 - cos(th))));
  }
  return vec2f((1.0 - ER) * ((1.0 - a) / 0.10), -HALF);
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* wrapU: the u parametrization is EXCLUSIVE, so i/cols closes the seam exactly. */
  let u = f32(ctx.dim.i) / f32(ctx.dim.cols);
  let a = f32(ctx.dim.j) / f32(ctx.dim.rows - 1u);
  let pr = profile(a);
  q.position = vec3f(contour(u) * pr.x, pr.y);
  return q;
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
  settings({ randomSeed: 23 }),
  graph(
    [
      // ---- the aim: two chains, added in the kernel -------------------------------
      // A SQUARE, deliberately: a square through a one-pole smoother IS an ease, so
      // `ease1` is visible rather than theoretical — delete it and the beam snaps
      // between two angles like a shutter instead of swinging.
      node("swing", "lfo", [-1880, 640], { shape: "square", frequency: 0.18, amplitude: 0.5, offset: 0.5, phase: 0 }, { label: "swing1" }),
      node("ease", "valueLag", [-1560, 640], { lag: 0.6 }, { label: "ease1" }),
      node("mouse", "mouse", [-1880, 840], {}, { label: "mouse1" }),
      node("follow", "valueLag", [-1560, 840], { lag: 0.18 }, { label: "follow1" }),
      // `envFresnel` reads dot(N, viewDir), so moving the eye moves WHICH thread of the
      // round-over is at grazing: the rim TRAVELS. A static camera is the one thing that
      // would make an edge-lit prism look painted.
      node("drift", "lfo", [-1880, 1040], { shape: "sine", frequency: 0.045, amplitude: 0.22, offset: 0.45, phase: 0 }, { label: "drift1" }),

      // ---- the glass -------------------------------------------------------------
      node("bar", "pointTube", [-1880, -420], { count: PRISM_COLS * PRISM_ROWS, cols: PRISM_COLS, rows: PRISM_ROWS }, { label: "bar1" }),
      node("form", "pointKernel", [-1560, -420], {
        capacity: PRISM_COLS * PRISM_ROWS,
        attributes: JSON.stringify([{ name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] }]),
        kernel: PRISM_FORM_KERNEL,
      }, { label: "form1" }),
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
        ior: 1.5, roughness: 0.04, thickness: 0.8, absorption: [0.06, 0.05, 0.02, 1], dispersion: 0.06,
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
        capacity: PRISM_BANDS + 4,
        attributes: PRISM_OPTICS_ATTRIBUTES,
        kernel: prismTraceKernel((PRISM_RC / 2).toFixed(3)),
        // The glass's DISPERSIVE POWER, and the one number the whole effect rests on:
        // n runs 1.500 (red) to 1.585 (violet). Set it to 0 and the fan collapses to a
        // single ray, which is what the gate asserts.
        value2: 0.085,
      }, {
        label: "optics1",
        parameters: { value1: drivenSlot("ease1", 0.5), value3: drivenSlot("follow1:x", 0) },
      }),
      // UNLIT, and white: a beam is scattered light in the air, not a surface, and it
      // takes no part in shadowing either (§V617). The colour is the attribute's.
      node("flare", "materialUnlit", [-1560, -140], { color: [1, 1, 1, 1] }, { label: "flare1" }),
      // §V471.1 — ONE SOURCE, TWO READINGS, split by a group predicate rather than by
      // more nodes. The split is not cosmetic: a single shaft wants a parallel-sided
      // ribbon, and 61 beams leaving the same face within 0.03 of each other fuse into
      // an opaque wedge at any taper above about zero (T680).
      node("shaft", "geometry", [-1240, -140], {
        mode: "beam", endpoint: "tip", scale: 0.006, taper: 1, material: "flare1", group: "p.role < 0.5",
      }, { label: "shaft1", parameters: { tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } } } }),
      node("fan", "geometry", [-1240, 100], {
        mode: "beam", endpoint: "tip", scale: 0.0075, taper: 0.06, material: "flare1", group: "p.role > 0.5",
      }, { label: "fan1", parameters: { tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } } } }),

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

      // ---- the shot --------------------------------------------------------------
      // ONE job: the direction is the mirror of the view about the upper-left
      // round-over's normal, so the Blinn lobe lands as a GLINT on that edge and nowhere
      // else. Measured: kill it and 8,387 pixels move by more than 4 luma.
      node("key", "light", [-1240, -900], {
        kind: "directional", direction: [0.73, -0.60, 0.31], color: [0.80, 0.88, 1, 1], intensity: 2.6, shadows: false,
      }, { label: "key1" }),
      node("eye", "camera", [-1240, -680], {
        // 26 degrees is a long lens on purpose: this is a poster, and a wide one would
        // bend the spectrum's straight rays. The eye sits barely off the prism's own
        // axis, which is what keeps the lateral faces to a sliver instead of a slab.
        eye: [0.45, -0.36, 6.6], lookAt: [-0.05, -0.53, 0], fov: 26, near: 0.1, far: 40, ortho: false,
      }, { label: "eye1", parameters: { "eye.x": drivenSlot("drift1", 0.45) } }),
      node("shot", "render", [-920, -420], {
        scenes: "solid1 fan1 shaft1", camera: "eye1", lights: "key1",
        // AMBIENT ZERO, and it is E33's lesson rather than taste (§V632/T636): the
        // physical terms here are a 4% head-on Fresnel and a 0.0009 albedo, so any
        // ambient worth the name drowns them and the glass goes to grey slate.
        ambientColor: [0, 0, 0, 1], ambientIntensity: 0,
        background: [0, 0, 0, 1], environmentIntensity: 3.2, showEnvironment: false,
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
      edge("e-swing-ease", ["swing", "out"], ["ease", "in"]),
      edge("e-mouse-follow", ["mouse", "out"], ["follow", "in"]),

      edge("e-bar-form", ["bar", "out"], ["form", "in"]),
      edge("e-form-solid", ["form", "out"], ["solid", "points"]),

      edge("e-spectrum-optics", ["spectrum", "out"], ["optics", "field"]),
      edge("e-optics-shaft", ["optics", "out"], ["shaft", "points"]),
      edge("e-optics-fan", ["optics", "out"], ["fan", "points"]),

      edge("e-sky-studio", ["sky", "out"], ["studio", "in1"]),
      edge("e-band-studio", ["band", "out"], ["studio", "in2"], 0),
      edge("e-studio-shot", ["studio", "out"], ["shot", "environment"]),

      edge("e-shot-cut", ["shot", "out"], ["cut", "input"]),
      edge("e-cut-clip", ["cut", "out"], ["clip", "input"]),
      edge("e-clip-halo", ["clip", "out"], ["halo", "input"]),
      edge("e-shot-glow", ["shot", "out"], ["glow", "in1"]),
      edge("e-halo-glow", ["halo", "out"], ["glow", "in2"], 0),
      edge("e-glow-out", ["glow", "out"], ["out", "input"]),
    ],
  ),
);
