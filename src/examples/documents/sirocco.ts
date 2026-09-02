import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E37 — Sirocco (T727). The canonical TouchDesigner particle look, and the first example
 * in the set to draw `geometry` in `points` mode at all.
 *
 *   drift1(pointKernel · THE WIND) ─► streak1(pointKernel · THE READING) ─┬─► body1(geometry · BEAM)
 *      curl of a vector potential        trail = position − velocity·t     ├─► fast1(geometry · BEAM)
 *      + containment + inertia           size  = f(speed)                  └─► heads1(geometry · POINTS)
 *                                                                               ▲ haze1(materialUnlit)
 *   orbx1/orbz1(lfo) ─► eye1(camera) ─► shot1(render)
 *   shot1 ─┬──────────────────────────────► burn1(add) ─► hue1(hsv ┄ drift2) ─► out1
 *          └─► halo1(blur) ─► halolvl1(level) ─┘
 *
 * ## The streak is FREE, and that is T680's own claim collected
 *
 * `beam` mode takes a per-point FAR END, and its author named the generalisation when it
 * shipped: "velocity-scaled streaks for E16-Murmuration, spark trails for E9-Ember, a
 * previous-position trail anywhere." This is that, cashed: `streak1` writes
 * `trail = position − velocity × TRAIL`, so the ribbon IS the distance the mote covers in
 * a third of a second, and a fast mote draws a long one BY CONSTRUCTION. One attribute,
 * no history buffer, no second pass.
 *
 * Derived from VELOCITY rather than from the PREVIOUS POSITION deliberately: a
 * previous-position trail draws a false streak across the frame the instant anything moves
 * a point discontinuously, and a velocity trail cannot, because velocity does not jump
 * when position does.
 *
 * ## Three capabilities that had no witness (§V624's spirit, at the catalogue's scale)
 *
 * `geometry` mode `points` was drawn by NO shipped example — every scene used `surface`,
 * `instances` or `beam` — which is how §B132 (points-mode `scale` silently inert; every
 * authored size rendering as 0.05, live since T647) survived to be found by measurement
 * rather than by looking. `heads1` is that mode's first witness, and dropping it from the
 * render changes 9.0% of the frame. T721's mapped `scale` had none either; all three draws
 * take it off the `size` attribute, so the number on the node stays the object's size and
 * the attribute is a factor.
 *
 * ## FIVE channels where one kernel may declare FOUR (§V588)
 *
 * The ceiling is PER KERNEL, and a chain is how you spend more than one kernel's worth.
 * `drift1` owns position, velocity and tint; `streak1` declares position, velocity, trail
 * and size — exactly four, AT the ceiling — and does not declare `tint`, so the colour
 * travels past it by reference (§V197). Same split E16 makes between flock and part, and
 * E34 between cast and sight: the simulation in one kernel, the reading in another.
 *
 * ## Why the colour is authored in the KERNEL and there is no palette lookup
 *
 * E31 grades a luminance lookup because its three point layers are flat-coloured. Here the
 * kernel writes a per-point tint (§V471.2) and the draws WEAR it, so a lookup keyed on
 * luminance would discard the one thing the kernel is saying. The heat term is SQUARED,
 * measured: the median mote sits at heat ≈ 0.46, so squaring puts the body of the cloud in
 * deep blue and spends the amber on the genuinely fast few — a linear ramp washed every
 * streak to the same cream, which is what the first build looked like.
 *
 * ## §V681, which this example is a standing test of
 *
 * A streak field's whole claim is a CORRESPONDENCE — that each ribbon belongs to the mote
 * it is drawn from. `sirocco.gpu.test.ts` asserts it structurally because nothing else can:
 * flipping the trail's sign gives every ribbon the right length and the wrong owner, and
 * the look instrument moves by 0.1% of range (0.4129 → 0.4125) — straight through §V678's
 * 10% band. Freezing the simulation entirely still reads 0.026 motion, because the camera
 * and the hue drift are still running. Only a claim that names the correspondence sees it.
 */
/** Motes. Three draws of six vertices each ride this number. */
const SIROCCO_POINTS = 18000;

/** Camera orbit radius; the two LFO amplitudes are this number. */
const SIROCCO_ORBIT = 4.20;

const SIROCCO_DRIFT_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", qualifier: "direction", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0.2, 0.3, 0.6, 1] },
]);

const SIROCCO_STREAK_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "velocity", type: "vec3f", qualifier: "direction", default: [0, 0, 0] },
  { name: "trail", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "size", type: "f32", semantic: "size", default: [1] },
]);

const SIROCCO_DRIFT_KERNEL = `const TAU: f32 = 6.28318530717958647692;

/* The radius the warm start fills, and the radius the containment starts pushing back
   at. Seeding INSIDE the containment means frame zero opens on a settled cloud rather
   than on a shell collapsing inward. */
const SEED_RADIUS: f32 = 1.05;
const BOUND: f32 = 1.05;

/* How hard the wind blows, and how fast a mote gives in to it. FLOW scales the curl to
   clip units per second; DRAG is the reciprocal of the time a mote takes to adopt the
   wind, so a small number is a heavy mote that keeps its own line through a gust. */
const FLOW: f32 = 0.20;
const DRAG: f32 = 1.35;

/* The reference speed the colour normalises against — the SAME number the streak
   kernel sizes against, so "fast" means one thing in this document (§V349). */
const SPEED_REFERENCE: f32 = 0.85;

/* The exposure, in ONE place. The draws are OPAQUE and depth-tested (a scene draw is
   not an additive splat), so brightness here is not accumulation — it is how light the
   cloud's own surface is, and the whole picture rides on it. */
const TINT_GAIN: f32 = 0.66;

/**
 * THE VECTOR POTENTIAL. What a mote feels is its CURL, below, and the curl of any field
 * is divergence-free BY CONSTRUCTION: this wind can stretch the cloud, fold it and shed
 * sheets off it, and it can never squeeze it into a knot or drain it into a point. That
 * property is the whole reason a flow field is authored as a potential and differentiated
 * rather than written down as three noises directly — three independent noises have
 * sources and sinks, and a cloud in one of them collects into blobs within seconds.
 *
 * Three terms at three scales, all moving. The broad term sets the sheets, the middle one
 * folds them, and the fine one is what stops the volume reading as a single slow swirl.
 */
fn potential(pos: vec3f, t: f32) -> vec3f {
  let broad = vec3f(
    sin(pos.y * 2.30 + t * 0.51) * cos(pos.z * 1.90 - t * 0.37),
    sin(pos.z * 2.10 - t * 0.44) * cos(pos.x * 2.60 + t * 0.29),
    sin(pos.x * 1.70 + t * 0.33) * cos(pos.y * 2.40 - t * 0.41)
  );
  let fold = vec3f(
    sin((pos.z + pos.x) * 4.30 - t * 0.83),
    sin((pos.x + pos.y) * 4.70 + t * 0.71),
    sin((pos.y + pos.z) * 3.90 - t * 0.62)
  ) * 0.34;
  let fine = vec3f(
    cos(pos.x * 8.10 - t * 1.13),
    cos(pos.y * 7.30 + t * 0.97),
    cos(pos.z * 8.90 - t * 1.07)
  ) * 0.11;
  return broad + fold + fine;
}

/* curl(P) = (dPz/dy - dPy/dz, dPx/dz - dPz/dx, dPy/dx - dPx/dy), central differences.
   Six potential evaluations per mote per frame, which is the price of the property
   above and is paid once here rather than approximated. */
fn curl3(pos: vec3f, t: f32) -> vec3f {
  let e = 0.045;
  let dx = (potential(pos + vec3f(e, 0.0, 0.0), t) - potential(pos - vec3f(e, 0.0, 0.0), t)) / (2.0 * e);
  let dy = (potential(pos + vec3f(0.0, e, 0.0), t) - potential(pos - vec3f(0.0, e, 0.0), t)) / (2.0 * e);
  let dz = (potential(pos + vec3f(0.0, 0.0, e), t) - potential(pos - vec3f(0.0, 0.0, e), t)) / (2.0 * e);
  return vec3f(dy.z - dz.y, dz.x - dx.z, dx.y - dy.x);
}

/* How long the warm start runs before frame zero is shown, and at what step. FOUR
   SECONDS: the cloud needs about that long to fold, and a gallery thumbnail is frame 0
   (T535) — seeded cold, this file's card is a fuzzy ball that the piece never shows
   again. Measured: 22.3% of the frame lit and a uniform sphere at frame 0 without it. */
const PREROLL_STEPS: i32 = 120;
const PREROLL_DT: f32 = 1.0 / 30.0;

/* A ball filled BY VOLUME, not by radius: the cube root on the radial draw is what
   keeps the centre from being dense and the shell from being empty. */
fn seedBall(id: u32) -> vec3f {
  let u = pointRand(id, 11u);
  let v = pointRand(id, 23u);
  let w = pointRand(id, 37u);
  let cosT = 1.0 - 2.0 * v;
  let sinT = sqrt(max(0.0, 1.0 - cosT * cosT));
  let phi = TAU * w;
  let r = SEED_RADIUS * pow(max(u, 1.0e-6), 1.0 / 3.0);
  return vec3f(r * sinT * cos(phi), r * sinT * sin(phi), r * cosT);
}

struct State {
  pos: vec3f,
  vel: vec3f,
};

/**
 * ONE STEP OF THE WIND — and it is one function because it is integrated in TWO places:
 * once per frame below, and PREROLL_STEPS times as the warm start. E9 states the rule and
 * this file obeys it: a warm start computed by different arithmetic from the simulation is
 * a warm start that opens on a picture the piece never shows.
 */
fn step(s: State, t: f32, dt: f32) -> State {
  let flow = curl3(s.pos, t) * FLOW;

  /* CONTAINMENT: zero inside the ball and rising outside it, so the cloud has an EDGE
     without a wall. Motes are turned back over about half a unit; nothing is clamped and
     nothing is teleported — a clamp parks a population on the boundary sphere and reads as
     a hard shell, and a teleport is a jump the streak cannot represent. */
  let d = length(s.pos);
  let outward = s.pos / max(d, 1.0e-5);
  let contain = -outward * smoothstep(BOUND, BOUND + 0.55, d) * 2.20;

  /* Motes are ACCELERATED toward the wind against their own inertia, never carried along
     it: the picture is the field INTEGRATED, which is the whole of §V427 — noise is smooth
     at every scale and a simulation is not. Turn DRAG up far enough and this degenerates
     into exactly the plain noise lookup it exists not to be. */
  let vel = s.vel + ((flow - s.vel) * DRAG + contain) * dt;
  return State(s.pos + vel * dt, vel);
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* §V73 says a SLOT is not an identity, and here is why ctx.index is nonetheless the
     right identity to hash on: this is the BASIC kernel — no spawn, no kill, no
     compaction — so no slot ever moves for the life of the buffer. E9 carries a real id
     attribute because the ADVANCED kernel mints and compacts, which is exactly when the
     slot stops being stable. Spending an attribute here to restate a constant would cost
     a quarter of the four-attribute budget (§V588) for nothing. */
  let id = ctx.index;

  /* FREE-RUNNING (§V436): ctx.absTime, never ctx.time. The wind does not restart when the
     piece does — ctx.time wraps at the out point (T455) and would put every phase of the
     potential back where it was at frame zero, snapping the whole cloud at each lap.
     ctx.delta is untouched: a step is continuous across a lap by construction (T464). */
  let t = ctx.absTime;

  var s = State(p.position, p.velocity);

  /* THE SEEDING SIGNAL — ctx.firstRun, which means "my storage was just created or
     cleared" and NOTHING else (T510/§V495). frameIndex == 0 also means "the timeline
     lapped", and a lap KEEPS its buffers, so a simulation must survive it while a seek
     and a document load must rebuild it.

     The seed takes its velocity FROM THE FIELD rather than from zero, and that is a warm
     start rather than a nicety: a gallery thumbnail is frame 0 (T535), the streak length
     is the velocity, and a cloud seeded at rest opens on a frame with no streaks in it at
     all — the one picture this example exists to show. */
  if (ctx.firstRun == 1u) {
    /* THE WARM START. Seeded at rest and then RUN — four seconds of the same step the
       frame below takes, ending exactly at this frame's clock, so what frame zero shows is
       a cloud that has already folded rather than the sphere it started as. */
    s = State(seedBall(id), vec3f(0.0));
    for (var k: i32 = 0; k < PREROLL_STEPS; k = k + 1) {
      s = step(s, t - f32(PREROLL_STEPS - k) * PREROLL_DT, PREROLL_DT);
    }
  }

  s = step(s, t, ctx.delta);

  let pos = s.pos;
  let vel = s.vel;
  q.position = pos;
  q.velocity = vel;

  /* THE COLOUR IS DATA THE KERNEL WRITES (§V471.2), and the draws below select on it and
     wear it — there is no palette lookup downstream to discard it. Two ideas, not one: how
     fast this mote is going, and WHERE IT IS in a band travelling slowly through the
     volume. Speed alone reads as a speedometer; the band is what makes the cloud look lit
     from somewhere. LINEAR values, because attributes are data and nothing display-decodes
     a per-point colour (§V56). */
  let heat = clamp(length(vel) / SPEED_REFERENCE, 0.0, 1.0);
  let band = 0.5 + 0.5 * sin(pos.y * 2.20 - t * 0.23 + heat * 2.10);
  /* SQUARED heat, and that is what makes the picture read as a wind rather than as a
     gradient: the median mote sits at heat ~0.46, so heat*heat puts the whole BODY of the
     cloud in deep blue and spends the amber only on the genuinely fast few. A linear ramp
     here washes every streak to the same cream — measured, and it is the difference
     between the first render and this one. */
  let hue = mix(vec3f(0.020, 0.070, 0.340), vec3f(0.920, 0.400, 0.100), heat * heat);
  /* The band's own contribution is a SHIFT, not a second ramp: it tips the cold end
     toward teal and the hot end toward rose, so two motes at the same speed in different
     parts of the volume are not the same colour. */
  let shift = mix(vec3f(-0.010, 0.060, -0.070), vec3f(0.060, -0.050, 0.130), band);
  q.tint = vec4f(TINT_GAIN * max(vec3f(0.0), hue + shift), 1.0);
  return q;
}`;

const SIROCCO_STREAK_KERNEL = `/* The streak's length in SECONDS OF THIS MOTE'S OWN TRAVEL. It lives HERE and nowhere
   else (§V349): the structural gate reads this very declaration out of the shipped kernel
   rather than keeping a second copy that could drift away from it. */
const TRAIL: f32 = 0.34;
const SPEED_REFERENCE: f32 = 0.85;

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* T401: position and velocity arrive from the DRIFT kernel's pairs, fresh this frame,
     and ride through unchanged in the copy above. This node is the one the draws bind, so
     it owns the edge they read (§V197) — and tint is NOT in this schema, so it travels
     past this node BY REFERENCE. That is the whole reason five channels reach the draws
     when one kernel may declare only FOUR attributes (§V588): the ceiling is per kernel,
     and a chain is how you spend more than one kernel's worth.

     Nothing here integrates. This kernel is the READING, not the simulation — the split is
     E16's flock/part and E34's cast/sight, and it is what keeps the wind in one file's
     worth of arithmetic and the geometry in another. */

  /* THE STREAK, and T680 in one line. A beam takes a per-point FAR END, so a velocity-
     scaled trail costs ONE attribute and NO HISTORY: backwards along this mote's own
     velocity by TRAIL seconds. The ribbon therefore IS the distance the mote covers in
     that time, and a fast mote draws a long one BY CONSTRUCTION rather than by a rule
     somebody wrote.

     Derived from VELOCITY and not from the previous POSITION on purpose, and the
     difference is visible: a previous-position trail draws a false streak across the frame
     the instant anything moves a point discontinuously, and a velocity trail cannot, because
     velocity does not jump when position does. */
  q.trail = p.position - p.velocity * TRAIL;

  /* SIZE, normalised against the SAME reference speed the colour uses so the two readings
     agree about what "fast" means (§V349). T721's scale map MULTIPLIES the geometry's own
     Scale by this, so the number on the node stays the object's size and this stays a
     factor. The floor is 0.35 rather than 0: a mote at rest is small, never absent. */
  q.size = 0.35 + 1.65 * clamp(length(p.velocity) / SPEED_REFERENCE, 0.0, 1.0);
  return q;
}`;

/** The predicate splitting the one cloud into its two beam readings (§V471.1). */
const SIROCCO_FAST_GROUP = "p.size > 1.35";

const SIROCCO_BODY_GROUP = "p.size <= 1.35";

export const siroccoDocument = document(
  "e37-sirocco",
  "E37 Sirocco",
  settings({ randomSeed: 37 }),
  graph(
    [
      // ---- the wind, and the reading taken off it ----------------------------------
      node("drift", "pointKernel", [-1500, 0], {
        capacity: SIROCCO_POINTS, seed: 37, group: "",
        attributes: SIROCCO_DRIFT_ATTRIBUTES, kernel: SIROCCO_DRIFT_KERNEL,
        value1: 0, value2: 0, value3: 0, value4: 0,
      }, { label: "drift1" }),
      node("streak", "pointKernel", [-1180, 0], {
        capacity: SIROCCO_POINTS, seed: 37, group: "",
        attributes: SIROCCO_STREAK_ATTRIBUTES, kernel: SIROCCO_STREAK_KERNEL,
        value1: 0, value2: 0, value3: 0, value4: 0,
      }, { label: "streak1" }),

      // ---- one material: the identity element, so the TINT is the colour ------------
      node("haze", "materialUnlit", [-1180, -420], { color: [1, 1, 1, 1] }, { label: "haze1" }),

      // ---- ONE cloud, THREE readings (§V471.1) --------------------------------------
      node("body", "geometry", [-860, 220], {
        mode: "beam", endpoint: "trail", taper: 0.35, scale: 0.0013,
        material: "haze1", group: SIROCCO_BODY_GROUP,
      }, {
        label: "body1",
        parameters: {
          tint: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: [1, 1, 1, 1] },
              map: { kind: "map", attribute: "tint" },
            },
          },
          scale: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: 0.0013 },
              map: { kind: "map", attribute: "size" },
            },
          },
        },
      }),
      node("fast", "geometry", [-860, 0], {
        mode: "beam", endpoint: "trail", taper: 0.12, scale: 0.0020,
        material: "haze1", group: SIROCCO_FAST_GROUP,
      }, {
        label: "fast1",
        parameters: {
          tint: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: [1, 1, 1, 1] },
              map: { kind: "map", attribute: "tint" },
            },
          },
          scale: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: 0.0020 },
              map: { kind: "map", attribute: "size" },
            },
          },
        },
      }),
      node("heads", "geometry", [-860, -220], {
        mode: "points", scale: 0.0034, material: "haze1", group: "",
      }, {
        label: "heads1",
        parameters: {
          tint: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: [1, 1, 1, 1] },
              map: { kind: "map", attribute: "tint" },
            },
          },
          scale: {
            mode: "map",
            bindings: {
              static: { kind: "static", value: 0.0034 },
              map: { kind: "map", attribute: "size" },
            },
          },
        },
      }),

      // ---- the shot -----------------------------------------------------------------
      node("orbx", "lfo", [-1500, 520], { shape: "sine", frequency: 0.021, amplitude: SIROCCO_ORBIT, offset: 0, phase: 0.25 }, { label: "orbx1" }),
      node("orbz", "lfo", [-1500, 700], { shape: "sine", frequency: 0.021, amplitude: SIROCCO_ORBIT, offset: 0, phase: 0 }, { label: "orbz1" }),
      node("eye", "camera", [-540, 0], {
        eye: [SIROCCO_ORBIT, 0.90, 0], lookAt: [0, 0, 0], fov: 42, near: 0.1, far: 24, ortho: false,
      }, {
        label: "eye1",
        parameters: { "eye.x": drivenSlot("orbx1", SIROCCO_ORBIT), "eye.z": drivenSlot("orbz1", 0) },
      }),
      node("shot", "render", [-220, 0], {
        scenes: "body1 fast1 heads1",
        camera: "eye1",
        lights: "",
        ambientColor: [1, 1, 1, 1],
        ambientIntensity: 1,
        background: [0.004, 0.006, 0.014, 1],
        environmentIntensity: 1,
        showEnvironment: false,
        ambientOcclusion: false,
      }, { label: "shot1" }),

      // ---- the post, one job per stage (§V471.4) ------------------------------------
      node("halo", "blur", [100, 220], { size: 24, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("haloLvl", "level", [420, 220], {
        blacklevel: 0.04, whitelevel: 1, contrast: 1, gamma1: 1, invert: 0, opacity: 1, brightness: 0.55,
      }, { label: "halolvl1" }),
      node("burn", "add", [740, 0], {}, { label: "burn1" }),
      node("drift2", "lfo", [740, 320], { shape: "sine", frequency: 0.035, amplitude: 15, offset: 0, phase: 0 }, { label: "drift2" }),
      node("hue", "hsv", [1060, 0], { saturation: 1.05, value: 1 }, {
        label: "hue1",
        parameters: { hueoffset: drivenSlot("drift2", 0) },
      }),
      node("out", "output", [1380, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-drift-streak", ["drift", "out"], ["streak", "in"]),
      edge("e-streak-body", ["streak", "out"], ["body", "points"]),
      edge("e-streak-fast", ["streak", "out"], ["fast", "points"]),
      edge("e-streak-heads", ["streak", "out"], ["heads", "points"]),
      edge("e-shot-halo", ["shot", "out"], ["halo", "input"]),
      edge("e-halo-halolvl", ["halo", "out"], ["haloLvl", "input"]),
      edge("e-shot-burn", ["shot", "out"], ["burn", "in1"]),
      edge("e-halolvl-burn", ["haloLvl", "out"], ["burn", "in2"], 0),
      edge("e-burn-hue", ["burn", "out"], ["hue", "input"]),
      edge("e-hue-out", ["hue", "out"], ["out", "input"]),
    ],
  ),
);
