/**
 * T741/T745 — E41 CINDER: particles FROM video, on the REAL lifecycle machinery.
 *
 * A moving subject sheds motes; a still one sheds none. The owner's ask, verbatim:
 * "we create particles from a video".
 *
 * ## The machinery, and the gap that had to close first (§T744)
 *
 * The first landing recycled a fixed population in a plain kernel, because
 * `pointKernelAdvanced` took no inputs at all — a spawn decision could not read a
 * texture. T744 gave the advanced kernel the plain kernel's own `field` input (one
 * route, one fieldAt, one refusal), and this file now runs the real thing: SCOUTS
 * spawn, children are BORN, die, and are compacted, and the GPU live count is
 * therefore a METER of how much the picture is moving — which upgrades the example's
 * lead claim from "zero mote PIXELS" to "zero LIVE POINTS" (a mote that is merely
 * dark or off-screen satisfies the first and fails the second).
 *
 * ## The budget, and where age lives (§V588)
 *
 * The advanced kernel's arithmetic (2·(n−1)+2 with flags, before T1076 packed them) allowed THREE user
 * attributes. Spawning requires `id` (identity is minted at birth, §V73); the picture
 * requires `tint` (colour + the T721 size channel in w). That spends the schema —
 * so AGE rides `position.z`, scaled by −0.25: the draw is an ortho camera down −z, so
 * the encoding doubles as depth ordering (older, dimmer motes sit FARTHER and never
 * occlude fresh ones), and velocity is PROCEDURAL — kick from the point's own id,
 * buoyancy, and the draught's curl, recomputed per frame. E9 stored velocity because
 * its look needs inertia; an ember cloud reads honestly without it, and the honest
 * budget note beats a fourth attribute that cannot exist.
 *
 * ## The packed field, twice per life
 *
 * rgb = the source's colour, a = the frame-difference motion (one Reorder, one field
 * input). A SCOUT reads the alpha to decide a birth; a CHILD reads the rgb under its
 * own position every frame, so its colour is the video LIVE — drift across a boundary
 * in the footage and the ember changes colour mid-flight. The spawn hook reads no
 * field, by T744's own rule: it only scatters the newborn a breath from its parent.
 */

/** Display-space x = field-space x × aspect: fieldAt maps clip xy → uv, the DRAW shows
 *  a 16:9 frame through an ortho camera, and the two must land the same pixel. */
export const CINDER_ASPECT = 16 / 9;

export const CINDER_SCOUTS = 96;
export const CINDER_CAPACITY = 4096;
/** Seconds a mote lives. The claims derive their decay window from this. */
export const CINDER_TTL = 1.6;
/** Motion alpha above this spawns. Sized against the packed difference field, measured
 *  (§V696): the understudy's orb wake reads 0.1–0.9 where it moves after the gain,
 *  ≤ 0.01 where it does not. */
export const CINDER_THRESHOLD = 0.06;
/** Age's home: age = −position.z / CINDER_AGE_Z. Negative so OLDER sits FARTHER from
 *  the ortho camera and a dying mote never occludes a fresh one. */
export const CINDER_AGE_Z = 0.25;
/**
 * T793 — THE WARM START'S SIZE, measured rather than chosen: the moving cloud settles at
 * 480–500 live points on Dawn (frames 132 and 300), of which 96 are the invisible scouts,
 * so a seeded generation of 400 opens on the population the piece actually runs at.
 */
export const CINDER_SEEDED = 400;
/** How many sites each seeded mote considers. See the warm start's note in the kernel. */
export const CINDER_SEED_PROBES = 48;

export const CINDER_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 0] },
  { name: "id", type: "u32", semantic: "id", default: [0] },
]);

export const CINDER_KERNEL = `const SCOUTS: u32 = ${CINDER_SCOUTS}u;
const ASPECT: f32 = ${CINDER_ASPECT};
const TTL: f32 = ${CINDER_TTL};
const THRESHOLD: f32 = ${CINDER_THRESHOLD};
const AGE_Z: f32 = ${CINDER_AGE_Z};
const SEEDED: u32 = ${CINDER_SEEDED}u;
const SEED_PROBES: u32 = ${CINDER_SEED_PROBES}u;

/* The DRAUGHT the motes rise through — a small stream function whose CURL steers
   them, so the cloud shears and eddies and can never bunch into a knot (E9's shape,
   scaled for a screen-plane cloud). */
fn draught(pos: vec2f, t: f32) -> f32 {
  let broad = sin(pos.x * 2.6 + t * 0.5) * cos(pos.y * 3.1 - t * 0.37);
  let fine = cos(pos.x * 7.9 - t * 0.9) * sin(pos.y * 6.3 + t * 0.7) * 0.35;
  return broad + fine;
}

fn curl(pos: vec2f, t: f32) -> vec2f {
  let e = 0.05;
  let dx = draught(pos + vec2f(e, 0.0), t) - draught(pos - vec2f(e, 0.0), t);
  let dy = draught(pos + vec2f(0.0, e), t) - draught(pos - vec2f(0.0, e), t);
  return vec2f(dy, -dx) / (2.0 * e);
}

/* Everything a mote's velocity is, as ONE function, because it is integrated in two
   places: once per frame below, and forward by its own age in the warm start. E9 states
   the rule and this file obeys it — a warm start computed by different arithmetic from
   the simulation is a warm start that opens on a picture the piece never shows. */
fn moteVel(id: u32, xy: vec2f, age: f32, t: f32) -> vec2f {
  let kick = vec2f(pointRand(id, 21u) - 0.5, 0.0) * 0.4;
  return kick + curl(xy, t) * 0.5 + vec2f(0.0, 0.55 - age * 0.18);
}

/* And the same for what a mote LOOKS like at a given age over a given field sample, for
   the same reason: the seeded generation must be graded by the code that grades a born
   one. tint.w is the SIZE channel (T721 maps it): presence plus the local motion. */
fn moteTint(sample: vec4f, age: f32) -> vec4f {
  let fade = 1.0 - smoothstep(TTL * 0.45, TTL, age);
  let glow = sample.rgb * 0.85 + vec3f(0.10, 0.07, 0.05);
  return vec4f(glow * fade, clamp(0.55 + sample.a * 2.4, 0.55, 2.2) * fade);
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* ctx.firstRun and nothing else (T510/T579, §V495): a lap keeps this population, a
     seek or a load rebuilds it. */
  if (ctx.firstRun == 1u) {
    q.id = ctx.index;
    q.spawnCount = 0u;
    if (ctx.index < SCOUTS) {
      q.alive = 1u;
      q.position = vec3f(0.0);
      q.tint = vec4f(0.0);
      return q;
    }
    if (ctx.index >= SCOUTS + SEEDED) {
      q.alive = 0u; /* headroom for births */
      return q;
    }

    /* T793 — THE WARM START, and it is E9 Ember's, generalised by §V774: a causal claim
       is a claim about the STEADY STATE, not about frame 0. This file's sentence is
       "a moving subject sheds motes and a still one sheds none", and its own gate asserts
       that at frame 132 — more than a TTL past the last seeded mote's death — so a warm
       start is admissible BY THE GATE'S OWN REASONING. Before it, frame 0 and frame 1
       were a featureless plate (out maxLuma 0.279 against 0.999 from frame 2 on) and the
       gallery card was that plate (§V769).

       WHERE. A born mote's site is where the picture MOVES, and on the first frame there
       is no motion measurement to read: the cache is empty, so the difference is the
       whole picture and the packed alpha floods (measured — mean 1.02 and 100% of the
       frame over threshold at frame 0, against 3–5% from frame 1 on). So the seed ranks
       SEED_PROBES deterministic sites by the field's own LUMINANCE and takes the best,
       which is the one thing a first frame can honestly say: for this understudy the
       warm orb is by some way the brightest thing in it. That is the single
       approximation in the seed and it is stated rather than buried — with real footage
       on branch 1 the opening generation lands on the brightest region rather than the
       moving one, for the one lifetime it exists.

       WHEN. The age is a uniform fraction of the mote's OWN lifetime, which is the age
       distribution a constant birth rate actually produces — so the generation is not
       merely plausible, it is correctly proportioned, and it dies off on exactly the
       schedule a born one does. Nothing seeded here is alive after TTL (1.6 s, 96
       frames at 60 fps), and every claim this file makes is measured well past that. */
    var site = vec2f(0.0);
    var bestLuma = -1.0;
    for (var k = 0u; k < SEED_PROBES; k = k + 1u) {
      let salt = q.id * 977u + k * 7919u;
      let sx = pointRand(salt, 5u) * 2.0 - 1.0;
      let sy = pointRand(salt, 6u) * 2.0 - 1.0;
      let seen = fieldAt(vec3f(sx, sy, 0.0));
      let bright = dot(seen.rgb, vec3f(0.2126, 0.7152, 0.0722));
      if (bright > bestLuma) {
        bestLuma = bright;
        site = vec2f(sx, sy);
      }
    }
    /* The SPAWN HOOK'S OWN BIRTH — same jitter, same constants — and then the same
       integration run forward by the mote's age. */
    let age = pointRand(q.id, 11u) * TTL;
    var xy = vec2f(site.x * ASPECT, site.y)
      + vec2f(pointRand(q.id, 31u) - 0.5, pointRand(q.id, 32u) - 0.5) * 0.04;
    /* Bounded: a full-lifetime mote costs 96 steps, one per frame it would have lived. */
    let steps = min(u32(age * 60.0) + 1u, 96u);
    let sdt = age / f32(steps);
    for (var step = 0u; step < steps; step = step + 1u) {
      xy = xy + moteVel(q.id, xy, sdt * f32(step), ctx.absTime) * sdt;
    }
    q.position = vec3f(xy, -age * AGE_Z);
    /* Graded by the SAME function a born mote is, over the live picture under it — but
       with the motion channel ZEROED, because on this frame there is no motion
       measurement to spend: a seeded mote gets the size floor (presence) and none of
       the motion bonus, which is what the majority of a steady cloud carries anyway. */
    let under = fieldAt(vec3f(xy.x / ASPECT, xy.y, 0.0));
    q.tint = moteTint(vec4f(under.rgb, 0.0), age);
    q.alive = 1u;
    return q;
  }

  if (q.id < SCOUTS) {
    /* A SCOUT: immortal, invisible (tint 0 — the draw's group hides it), jumping to a
       fresh deterministic site every frame. The salt folds the absolute frame in, so
       the probe pattern is dense over time AND a seek reproduces it (§V44/§V45). */
    let salt = q.id * 977u + ctx.absFrame;
    let sx = pointRand(salt, 1u) * 2.0 - 1.0;
    let sy = pointRand(salt, 2u) * 2.0 - 1.0;
    let sample = fieldAt(vec3f(sx, sy, 0.0));
    q.position = vec3f(sx * ASPECT, sy, 0.0);
    q.tint = vec4f(0.0);
    q.spawnCount = select(0u, 1u, sample.a > THRESHOLD);
    q.alive = 1u;
    return q;
  }

  /* A MOTE. Age rides position.z (see the header: the schema is spent on id and tint,
     and the encoding doubles as depth ordering). */
  var age = -q.position.z / AGE_Z + ctx.delta;
  if (age > TTL) {
    q.alive = 0u;
    return q;
  }

  /* PROCEDURAL velocity: a per-ember kick from its own minted id, buoyancy, and the
     draught's curl. No inertia — no attribute left to store it in, and the header
     says so rather than hiding it. */
  let xy = q.position.xy + moteVel(q.id, q.position.xy, age, ctx.absTime) * ctx.delta;
  q.position = vec3f(xy, -age * AGE_Z);

  /* The video's LIVE colour under the mote (field space is /ASPECT), faded by age so
     it dims and shrinks out instead of popping. A small floor keeps a mote over a
     black region reading as an ember — additive light, not albedo (§V644's spirit). */
  q.tint = moteTint(fieldAt(vec3f(xy.x / ASPECT, xy.y, 0.0)), age);
  q.alive = 1u;
  return q;
}`;

/** The birth: the child ARRIVES as its scout-parent's copy — already AT the motion
 *  site (display space), tint 0 until its first frame samples the field. The hook
 *  only scatters it a breath sideways so a burst is a puff rather than a stack; per
 *  T744 it reads no field — the kernel that decided the birth is the sampling site. */
export const CINDER_SPAWN = `fn spawn(child: Point, ctx: PointCtx) -> Point {
  var c = child;
  let jx = pointRand(c.id, 31u) - 0.5;
  let jy = pointRand(c.id, 32u) - 0.5;
  c.position = vec3f(c.position.xy + vec2f(jx, jy) * 0.04, 0.0);
  c.tint = vec4f(0.0);
  return c;
}`;
