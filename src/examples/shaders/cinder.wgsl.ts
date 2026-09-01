/**
 * T741 — E41 CINDER: particles FROM video. A moving subject sheds motes; a still one
 * sheds none. The owner's ask, verbatim: "we create particles from a video".
 *
 * ## Why this is ONE plain kernel and not the T322 lifecycle machinery
 *
 * The proposal wanted `pointKernelAdvanced` spawning at motion sites — and the budget
 * check ordered before building surfaced a harder wall than the binding budget:
 * **the advanced kernel has NO inputs at all** (`inputs: []`) — no field port, no
 * upstream pointset. A spawn decision cannot read a texture there, full stop. That is
 * a capability gap worth its own task (a `field` input on the advanced kernel is a
 * texture binding, not a storage buffer, so §V588 does not block it); this example
 * does not get to be the place an engine feature lands by side effect.
 *
 * So the population RECYCLES instead (E38's kernel-side pattern): capacity is fixed,
 * every point is either a LIVE mote (age < TTL, riding velocity.z — E9's own idiom of
 * a scalar in z) or DORMANT (age ≥ TTL). Each frame a dormant point rolls a
 * deterministic gate; the winners probe a fresh site (pointRand salted by the absolute
 * frame — a seek reproduces, §V44/§V45), and where the packed field's motion alpha
 * clears the threshold they are REBORN there. A still frame has no site above
 * threshold, so a still subject sheds NOTHING and the live population decays to zero
 * within one TTL — the owner's sentence as a number, asserted on the attribute buffer
 * cross-frame (§V681/§V717).
 *
 * ## The packed field
 *
 * One field input per kernel, so the graph packs two readings into one texture with a
 * Reorder: rgb = the source's colour, a = the frame-difference MOTION. The probe reads
 * "is anything moving here" and the live mote reads "what colour is the picture under
 * me" from the same fieldAt.
 *
 * ## Budget (§V588)
 *
 * Three attributes — position, velocity (z = age), tint — is 2n + 2 = 8 storage
 * bindings, exactly the baseline; the field is a texture and prices separately. The
 * draw's group predicate (`p.velocity.z < TTL`) hides the dormant pool structurally.
 */

/** Display-space x = field-space x × aspect: fieldAt maps clip xy → uv, the DRAW shows
 *  a 16:9 frame through an ortho camera, and the two must land the same pixel. */
export const CINDER_ASPECT = 16 / 9;

export const CINDER_CAPACITY = 4096;
/** Seconds a mote lives. The claims derive their decay window from this. */
export const CINDER_TTL = 1.6;
/** Motion alpha above this births a mote. Sized against the packed difference field,
 *  measured (§V696): the understudy's orb wake reads 0.1–0.9 where it moves after the
 *  gain, ≤ 0.01 where it does not. */
export const CINDER_THRESHOLD = 0.06;
/** Share of the dormant pool that probes per frame. Sets the birth rate: capacity ×
 *  gate × hit-area × fps ≈ the steady population over one TTL. */
export const CINDER_GATE = 0.05;

export const CINDER_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  /* z carries AGE. Default 99: every point starts DORMANT, so frame 0 is an empty
     stage and everything ever visible was born from measured motion. */
  { name: "velocity", type: "vec3f", default: [0, 0, 99] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [0, 0, 0, 0] },
]);

export const CINDER_KERNEL = `const ASPECT: f32 = ${CINDER_ASPECT};
const TTL: f32 = ${CINDER_TTL};
const THRESHOLD: f32 = ${CINDER_THRESHOLD};
const GATE: f32 = ${CINDER_GATE};

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
  let age = p.velocity.z;

  if (age >= TTL) {
    /* DORMANT. Roll the gate; winners probe one fresh deterministic site. The salt
       folds the absolute frame in, so the probe pattern is dense over time AND a seek
       reproduces it exactly. */
    q.tint = vec4f(0.0);
    let salt = ctx.index * 977u + ctx.absFrame;
    if (pointRand(salt, 9u) > GATE) { return q; }
    let sx = pointRand(salt, 1u) * 2.0 - 1.0;
    let sy = pointRand(salt, 2u) * 2.0 - 1.0;
    let sample = fieldAt(vec3f(sx, sy, 0.0));
    if (sample.a <= THRESHOLD) { return q; }
    /* BORN — at the motion site, display space, with an upward kick and jitter. */
    let jx = pointRand(salt, 21u) - 0.5;
    q.position = vec3f(sx * ASPECT + jx * 0.03, sy + (pointRand(salt, 22u) - 0.5) * 0.03, 0.0);
    q.velocity = vec3f(jx * 0.4, 0.12 + pointRand(salt, 23u) * 0.3, 0.0);
    q.tint = vec4f(sample.rgb, sample.a);
    return q;
  }

  /* A LIVE MOTE: buoyancy plus the draught's curl, through drag — the field is
     INTEGRATED, never teleported along (§V427). */
  var v = p.velocity.xy;
  let force = curl(p.position.xy, ctx.absTime) * 0.5 + vec2f(0.0, 0.55) - v * 2.2;
  v = v + force * ctx.delta;
  q.position = vec3f(p.position.xy + v * ctx.delta, 0.0);
  q.velocity = vec3f(v, age + ctx.delta);

  /* The video's LIVE colour under the mote (field space is /ASPECT), faded by age so
     it shrinks and dims out instead of popping. A small floor keeps a mote over a
     black region reading as an ember — additive light, not albedo (§V644's spirit).
     tint.a is the SIZE channel (T721 maps it): presence plus the local motion. */
  let sample = fieldAt(vec3f(q.position.x / ASPECT, q.position.y, 0.0));
  let fade = 1.0 - smoothstep(TTL * 0.45, TTL, q.velocity.z);
  let glow = sample.rgb * 0.85 + vec3f(0.10, 0.07, 0.05);
  q.tint = vec4f(glow * fade, clamp(0.55 + sample.a * 2.4, 0.55, 2.2) * fade);
  return q;
}`;
