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
 * The advanced kernel's arithmetic (2·(n−1)+2 with flags) allows THREE user
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

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* ctx.firstRun and nothing else (T510/T579, §V495): a lap keeps this population, a
     seek or a load rebuilds it. Frame 0 is an EMPTY stage bar the invisible scouts —
     everything ever visible will have been born from measured motion. */
  if (ctx.firstRun == 1u) {
    q.id = ctx.index;
    q.spawnCount = 0u;
    if (ctx.index >= SCOUTS) {
      q.alive = 0u;
      return q;
    }
    q.alive = 1u;
    q.position = vec3f(0.0);
    q.tint = vec4f(0.0);
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
  let kick = vec2f(pointRand(q.id, 21u) - 0.5, 0.0) * 0.4;
  let v = kick + curl(q.position.xy, ctx.absTime) * 0.5 + vec2f(0.0, 0.55 - age * 0.18);
  let xy = q.position.xy + v * ctx.delta;
  q.position = vec3f(xy, -age * AGE_Z);

  /* The video's LIVE colour under the mote (field space is /ASPECT), faded by age so
     it dims and shrinks out instead of popping. A small floor keeps a mote over a
     black region reading as an ember — additive light, not albedo (§V644's spirit).
     tint.w is the SIZE channel (T721 maps it): presence plus the local motion. */
  let sample = fieldAt(vec3f(xy.x / ASPECT, xy.y, 0.0));
  let fade = 1.0 - smoothstep(TTL * 0.45, TTL, age);
  let glow = sample.rgb * 0.85 + vec3f(0.10, 0.07, 0.05);
  q.tint = vec4f(glow * fade, clamp(0.55 + sample.a * 2.4, 0.55, 2.2) * fade);
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
