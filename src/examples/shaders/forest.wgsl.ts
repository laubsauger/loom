import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * E57 Forest — the walking hero-unit raymarcher (T1156).
 *
 * The owner's ask: a misty, creepy, mystical forest where the camera is infinitely slowly
 * but surely walking forward, towards the full moon. Very moody. Nice and adjustable.
 *
 * THE CONSTRAINT THAT SHAPED EVERY DECISION HERE IS THE BUDGET, not the picture. A hero
 * background runs behind somebody's page, so the reference point is E13 Prism — the one
 * example in this catalogue that actually did this job in the wild — and E55 Reactor, the
 * other `customWgsl` raymarcher, is measured beside it as a calibration. The full table and
 * the instrument are in `src/examples/documents/forest.ts`; the shape of it is that E13
 * costs about 3.9 ms a frame at 1920x1080 on this machine, E55 about 24, and this file sits
 * with E13. The three decisions below are the reason it can.
 *
 * ## 1. THE WORLD REPEATS, SO WALKING FOREVER IS FREE
 *
 * One tree per cell of an infinite XZ grid; everything about a tree — whether it is there
 * at all, its height, radius, lean, branch phase, its offset inside its cell — is a hash of
 * the CELL INDEX. The camera translates through it and never turns, so there is no loop
 * point, no seam and no wrap: the forest is different every metre and costs one tree.
 *
 * The camera's world position is rebased onto its own cell every frame (`o` below is the
 * eye's position INSIDE its cell, never its absolute z), so all ray arithmetic happens near
 * the origin in f32 while the hash reads an exact integer cell index. Without that the
 * march loses its epsilon after a few minutes of walking; with it the only thing that
 * degrades is `absTime` itself, at about 8 mm of walk per step after 24 hours.
 *
 * ## 2. THE GEOMETRY IS A DDA, NOT A SPHERE TRACE — AND THAT IS THE WHOLE COST STORY
 *
 * A forest of vertical trunks is the worst case for a sphere trace: the distance to the
 * nearest trunk AXIS is small everywhere, so the marcher crawls through empty air. So the
 * ray instead walks the XZ grid cell by cell (Amanatides-Woo), and in each cell tests ONE
 * quadratic — the tree's bounding cylinder. Only on a bound hit does a short local sphere
 * trace run, over the bound's own span and nothing more.
 *
 * That is exact rather than approximate, and the reason is a constraint enforced in
 * `treeAt`: a tree's bound is clamped to fit inside its own cell, and its jitter is then
 * whatever room is left. A tree can therefore never be hit from a cell other than its own,
 * so the DDA's cell order IS hit order. `branchSpread` saturates against the cell for the
 * same reason — widen `spacing` to grow branches, which is stated on the knob.
 *
 * ## 3. THE FOG IS THE BUDGET, MEASURABLY
 *
 * `REACH` is not a knob. It is solved from the fog: the distance at which transmittance
 * falls to REACH_OPACITY, beyond which a tree cannot change its pixel by a display step
 * through this much haze. Raise `fog` and the DDA runs fewer cells and the frame gets
 * CHEAPER — the fog licenses the culling and then performs it. Trees past
 * `spacing * FAR_CELLS` drop their branches, and past `spacing * NEAR_CELLS` their elbows,
 * because in this much mist a distant tree is a silhouette.
 *
 * The volumetric is the other half of the same trade. Shafts are `SHAFT_STEPS` samples
 * along the view ray, importance-sampled by transmittance, each shadowed by ONE stochastic
 * occupancy probe toward the moon that tests the TRUNK COLUMN only — no branches, no
 * distance field. A soft, sparse result, which is what fog wants anyway (E55's exterior
 * haze was its entire cost, and its lesson was that sparse-and-blurred beats
 * dense-and-aliased). `shafts` at 0 skips the loop outright, so it is the second cost lever
 * and the .md says so.
 *
 * ## WHAT WAS REFUSED, WITH THE PICTURE AS THE JUDGE (§V885, §V912)
 *
 *   - FOLIAGE, three times. A dented ellipsoid crown read as a mushroom cap on a pole; a
 *     capsule cone read as a lollipop, because a capsule's distance carries a hemispherical
 *     foot; a flat-footed cone with tiered branches read as a lampshade. Through this much
 *     mist the crown is the ONLY part of a tree that gets read as a shape, so a crown that
 *     reads as a manufactured object is worse than none — and the branches crowding toward
 *     the top of a bare stem are what a bare crown is. `canopy` was deleted with them
 *     (§V146: a knob that ships a worse picture at every value is not a knob).
 *   - SKIPPING THE SHAFT MARCH where the forward lobe is small. The saving looked free and
 *     was not: the gate's own cone printed a huge circular arc across the DARK quarter of
 *     the frame, where six thousandths of a linear unit is thirty percent of the level. No
 *     still showed it; a static-pixel mask over fourteen seconds of walking did, because a
 *     walking scene cannot have a smooth curve that never moves.
 *   - A SHORT QUIET-ZONE FALLOFF, and a vignette whose smoothstep saturated inside the
 *     frame. Both drew a visible dark ellipse — precisely the rectangle-over-the-top the
 *     quiet zone exists to avoid.
 *   - AN UNCLAMPED CLOUD VEIL. Perlin is signed, so scaling it and adding an offset put part
 *     of the field below zero, and the sky was multiplied by a negative number over a big
 *     smooth blob whose ZERO CROSSING was a hard curved edge.
 *
 * ## THE QUIET ZONE (the hero-unit requirement nobody states until it is wrong)
 *
 * Text goes on top. `quiet` opens a soft mist bank at `quietAt` of `quietSize`, mixing the
 * picture toward the far-field fog colour it was already converging to, so trunks dissolve
 * into haze there rather than being veiled by a rectangle. It is composition, not post: the
 * moon sits upper-right by `moonAzimuth`/`moonHeight` and the zone sits lower-left, and the
 * claims measure the local contrast inside it against the rest of the frame.
 *
 * ## LIVELINESS IS STRUCTURAL, AND THE MOTION BUDGET BELONGS ENTIRELY TO THE WALK
 *
 * E13 says its motion budget belongs entirely to the pointer; this one's belongs entirely
 * to the walk. `absTime * walkSpeed` is a free-running translation with no fixed point by
 * construction — it cannot settle, there is nothing for it to settle INTO — and the sway
 * and bob are position offsets on the same clock. Nothing here is an envelope. Anybody
 * adding a second motion source should know they are fighting the walk, which is why this
 * paragraph is here rather than in a commit message.
 *
 * THE CAMERA NEVER TURNS, and that is load-bearing twice over. The per-pixel sky direction
 * is therefore constant, which makes the screen-space cloud veil read off `inputTexture`
 * exactly correct rather than a cheat; and the moon and the quiet zone hold still, which is
 * what a headline needs.
 *
 * MEASURED (§V913 — the row AND the minute, the look instrument's own arithmetic at
 * 192x108 with its 120-frame gaps): the recorded f60→f180 row reads 0.0210; the whole
 * minute averages 0.0255 over 29 gaps, min 0.0184, max 0.0346, and the LAST gap
 * f3480→f3600 reads 0.0225 — above the row. Per FRAME the pace is 8.577e-4 at f59→60 and
 * 9.155e-4 at f3599→3600, which is 107% of the opening pace after a full minute; with the
 * walk cut the same measure reads 5.010e-7. Nothing decays because nothing here is an
 * envelope. There are NO driven parameters, so §V903 and §V914 have no lane to judge: a
 * hero background has no audio and no pointer, and every value in the file is its own
 * retained value.
 *
 * Deterministic (§V44/§V45): `frameU.absTime` is the only clock, and the march dither is a
 * hash of the pixel, fixed across frames — grain, never flicker (E55's finding).
 */
export const FOREST_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  walkSpeed: f32,     // metres a second the eye travels forward, forever — the whole motion budget
  sway: f32,          // how far the walk wanders side to side, metres
  bob: f32,           // rise and fall of the step, metres
  eyeHeight: f32,     // the eye above the ground, metres
  pitch: f32,         // degrees the view tilts up — raises the horizon's trees over the mist floor
  lens: f32,          // focal length: higher is a longer lens, so the forest stacks up and compresses
  spacing: f32,       // metres between tree cells — also the ceiling on how wide a tree may grow
  density: f32,       // share of cells that carry a tree at all, 0 to 1
  treeHeight: f32,    // mean trunk height, metres
  heightVary: f32,    // how much heights differ tree to tree, 0 is a plantation
  trunkWidth: f32,    // trunk radius at the base, metres
  lean: f32,          // how far a trunk leans off vertical by its top — the crooked, creepy reading
  branches: f32,      // branches per tree, 0 to 6 — this IS the crown; there is no foliage (see the docblock)
  branchSpread: f32,  // branch length as a share of the cell; it SATURATES at the cell (and squeezes out the tree's own jitter first, so a stand goes gridded before it goes wide) — widen spacing to grow them
  branchRise: f32,    // negative droops the branches, positive reaches them up
  gnarl: f32,         // irregularity of branch angle and length — 0 is a diagram, 1 is a thicket
  barkColor: vec4f,   // the wood under the moon
  groundColor: vec4f, // the forest floor under the mist
  fog: f32,           // uniform haze density — the aerial perspective, and the cost lever: more fog is FEWER cells
  mist: f32,          // extra density pooling on the ground, over and above the fog
  fogHeight: f32,     // metres over which that pooling thins with height
  fogColor: vec4f,    // what everything converges to at distance
  shafts: f32,        // strength of the light shafts between the trunks; 0 skips the volumetric march entirely
  skyColor: vec4f,    // the sky at the zenith, above the haze
  cloud: f32,         // how much the cloud veil on the input dims the sky and the moon
  moonSize: f32,      // angular radius of the disc, degrees — a real moon is 0.25, a hero moon is bigger
  moonHeight: f32,    // the moon's elevation above the horizon, degrees
  moonAzimuth: f32,   // degrees right of the walk direction — where the composition puts it
  moonColor: vec4f,   // the moon and everything it lights
  moonGain: f32,      // how hard the moon lights the scene
  ambient: f32,       // sky fill on the bark, so a back-lit trunk is not a silhouette cut out of black
  quiet: f32,         // how far the headline zone dissolves into mist — the hero unit's readable patch
  quietAt: vec2f,     // where that zone sits, in screen fractions from the top left
  quietSize: f32,     // its radius, in screen fractions
  vignette: f32,      // corner falloff
  exposure: f32,      // master gain before the display transform
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

const PI: f32 = 3.14159265;
/* The hard ceiling on the DDA. REACH below is solved from the fog and is normally well
   inside this; the cap is what stops a fog of zero from marching for ever. */
const MAX_CELLS: i32 = 26;
/* Steps of the local sphere trace INSIDE one tree's bound. The bound is at most one cell
   across, so this is a short walk over a span of order a metre, not a march through a
   forest — which is the entire reason the file is affordable. */
const MARCH_STEPS: i32 = 18;
const MAX_BRANCH: i32 = 6;
/* THREE LEVELS OF TREE, and the mist is what pays for the drop. Near, a tree has elbowed
   branches and a crown; past NEAR_CELLS the elbow straightens to one capsule; past
   FAR_CELLS the branches go entirely and a trunk is left, because through this much haze
   that is all a silhouette at that distance can carry (design note 2). Measured: the two
   drops together are worth about a third of the frame. */
const NEAR_CELLS: f32 = 1.1;
const FAR_CELLS: f32 = 3.4;
/* The volumetric: samples along the view ray, one stochastic shadow probe each. Deliberately
   small — sparse and soft is what fog wants, and dense-and-aliased is the
   thing E55 measured and refused. The samples are IMPORTANCE-SAMPLED by transmittance
   (below), which is what lets eight of them be enough where twenty uniform ones were not. */
const SHAFT_STEPS: i32 = 7;
/* Where the reach is cut. NOT 2%: a tree at 2% transmittance changes its pixel by well
   under a display step against this fog, so the honest cut is 7% — ln(0.074) = -2.6 — and
   it is worth a third of the cells. Verified by eye at 1920x1080 before it was trusted
   (§V912): the far field does not clip, it is already mist there. */
const REACH_OPACITY: f32 = 2.05;
/* The scale height of the plain haze, metres. A CONST rather than a knob: it is the
   difference between "standing in weather" and "standing in soup", nobody art-directs it
   in metres, and §V146 says a knob nobody moves should not exist. What it buys is the
   thing the first draft got wrong — without it the uniform term never thins with altitude,
   so the sky is as opaque as the ground and THE MOON CANNOT BE SEEN AT ALL. */
const AIR_HEIGHT: f32 = 26.0;

// ---------------------------------------------------------------- hashing
fn hash21(p: vec2f) -> f32 {
  var q = fract(vec3f(p.xyx) * 0.1031);
  q = q + vec3f(dot(q, q.yzx + 33.33));
  return fract((q.x + q.y) * q.z);
}
fn hash24(p: vec2f) -> vec4f {
  var q = fract(vec4f(p.xyxy) * vec4f(0.1031, 0.1030, 0.0973, 0.1099));
  q = q + vec4f(dot(q, q.wzxy + 33.33));
  return fract((q.xxyz + q.yzzw) * q.zywx);
}
fn vnoise2(x: vec2f) -> f32 {
  let i = floor(x); let f = fract(x);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(hash21(i), hash21(i + vec2f(1.0, 0.0)), u.x),
    mix(hash21(i + vec2f(0.0, 1.0)), hash21(i + vec2f(1.0, 1.0)), u.x),
    u.y,
  );
}

// ---------------------------------------------------------------- one tree
struct Tree {
  present: f32,   // 1 when this cell carries a tree
  base: vec3f,    // trunk foot, in the camera's LOCAL cell frame, y = 0
  h: f32,         // trunk height
  r: f32,         // trunk radius at the foot
  lean: vec2f,    // xz displacement of the top away from the foot
  leanLen: f32,   // its length — known without the trig the direction needs
  bound: f32,     // radius of the bounding cylinder — guaranteed to fit inside the cell
  stem: f32,      // radius of the TRUNK's own, much tighter bound (see marchForest)
  limb: f32,      // height of the lowest branch: below this a ray needs the stem bound only
  reach: f32,     // longest branch, already clamped to the cell
  seed: vec4f,    // the cell's four randoms
};

/*
 * The tree in 'cellLocal', hashed off 'cellAbs'.
 *
 * THE BOUND IS COMPUTED BEFORE THE POSITION, and that order is what makes the DDA exact:
 * the branches are clamped so the whole tree fits inside a cell, and the jitter is then
 * only whatever room the bound left over. A tree therefore never crosses a cell wall, so
 * a ray can only ever hit the tree of the cell it is currently in — which is what lets
 * the walk stop at the first bound it actually intersects.
 */
fn stemAt(cellLocal: vec2f, cellAbs: vec2f) -> Tree {
  var t: Tree;
  let s = hash24(cellAbs);
  t.seed = s;
  t.present = select(0.0, 1.0, s.x < clamp(params.density, 0.0, 1.0));
  let half = params.spacing * 0.5;
  // Old thick trees and thin saplings in the same wood: the radius spread is wide on
  // purpose, because a stand of identical poles is the thing that reads as procedural.
  t.r = max(params.trunkWidth, 0.01) * (0.5 + 1.15 * s.y * s.y);
  t.h = max(params.treeHeight, 0.5) * (1.0 - 0.5 * params.heightVary + params.heightVary * s.z);
  /* THE CELL IS A BUDGET, AND EVERYTHING THAT STICKS OUT SIDEWAYS SPENDS IT.
     The lean carries the upper trunk off the axis and the branches reach from wherever the
     lean has put them, so the tree's true half-width is leanLen + reach + trunk, and THAT
     is what has to fit. The first draft bounded max(reach, leanLen) instead of the sum, and
     the answer was visible on the picture the moment anything wide went in: trees sliced
     off by a dead straight vertical, because the march clips its own span to the bound and
     the geometry was outside it. Everything below saturates against the budget rather than
     escaping it, which is why 'branchSpread' and 'lean' both stop climbing at some point —
     the knob that grows a tree past that is 'spacing'. */
  let budget = max(half * 0.96 - t.r * 1.3, 0.0);
  t.leanLen = min(params.lean * t.h * 0.048, budget * 0.4);
  t.reach = min(max(params.branchSpread, 0.0) * half * 1.35, max(budget - t.leanLen, 0.0));
  t.bound = t.leanLen + t.reach + t.r * 1.3;
  t.stem = t.leanLen + t.r * 1.35;
  // The lowest point any branch can reach: they attach from 0.3 of the stem and the
  // droopiest one falls about 0.06 of the tree below its shoulder, so 0.2 leaves margin.
  // Too high a limb line and a drooping branch is sliced off by the stem bound.
  t.limb = t.h * 0.2;
  // Whatever room is left after the bound is where the tree may sit inside its cell.
  let room = max(half - t.bound, 0.0);
  let jitter = (s.zw - 0.5) * 2.0 * room;
  t.base = vec3f(
    (cellLocal.x + 0.5) * params.spacing + jitter.x,
    0.0,
    (cellLocal.y + 0.5) * params.spacing + jitter.y,
  );
  t.lean = vec2f(0.0);
  return t;
}

/* The stem plus the direction it leans in. Split from 'stemAt' because the SHADOW PROBES —
   two per volumetric sample, so twenty a pixel — need the trunk's position and nothing
   else, and paying two transcendentals apiece for a lean they never read was one of the
   larger lines in the frame. */
fn treeAt(cellLocal: vec2f, cellAbs: vec2f) -> Tree {
  var t = stemAt(cellLocal, cellAbs);
  let ang = t.seed.w * 6.2831853;
  t.lean = vec2f(cos(ang), sin(ang)) * t.leanLen;
  return t;
}

/* A tapered capsule, returning BOTH the distance and the point on its axis that is nearest
   to p — xyz the axis point, w the distance.
   Carrying the axis point is what makes the normal free. A capsule's gradient is exactly
   the direction from that point to p, so the shading normal is one normalize of something
   the distance query already computed. The first draft took the usual four-tap tetrahedron
   instead, which on a thirteen-capsule tree is FIFTY-TWO extra capsule distances at every
   hit — the single most expensive line in the file, paid to approximate a quantity that
   was already exact and already in hand.
   The cheap taper form over-reports distance on a steep cone, which a sphere trace answers
   by not taking the whole step — STEP_SCALE is that answer — and it tilts the normal by
   the taper angle, which at these tapers is under two degrees. */
fn nearTaper(p: vec3f, a: vec3f, b: vec3f, ra: f32, rb: f32) -> vec4f {
  let pa = p - a;
  let ba = b - a;
  let h = clamp(dot(pa, ba) / max(dot(ba, ba), 1.0e-6), 0.0, 1.0);
  let cp = a + ba * h;
  return vec4f(cp, length(p - cp) - mix(ra, rb, h));
}
fn nearer(cur: vec4f, cand: vec4f) -> vec4f { return select(cur, cand, cand.w < cur.w); }
/* Unradiused distance to a segment — the branch envelope below, and nothing else. */
fn segDist(p: vec3f, a: vec3f, b: vec3f) -> f32 {
  let pa = p - a;
  let ba = b - a;
  return length(pa - ba * clamp(dot(pa, ba) / max(dot(ba, ba), 1.0e-6), 0.0, 1.0));
}
const STEP_SCALE: f32 = 0.72;

/* THE TREE, TABULATED ONCE PER BOUND THE RAY ENTERS — trunk in slots 0..3, then three
   slots a branch: shoulder, elbow and tip, each with its radius.
   The trunk is in here for a reason found by measuring rather than by reading: its radius
   carries a sine of swelling up the stem (the thing that stops every trunk being a ruled
   cone), 'treeNear' asks for six radii and four points, and it is called at EVERY MARCH
   STEP — so that one line of character was buying six transcendentals a step, more than a
   hundred per bound. None of it depends on the sample point. Hoisted here it is paid once.
   A straight spoke reads as a diagram, so every branch bends once, upward and off its own
   azimuth; the twisted azimuth comes off the shoulder's own cosine and sine by angle
   addition rather than a second pair of trig calls. */
fn buildTree(t: Tree, tbl: ptr<function, array<vec4f, 22>>) -> i32 {
  /* The stem, as four knots: the lean grows as a cubic-ish so the foot stands straight and
     the top does the wandering, and the radius tapers with one sine of swelling over it. */
  let fs = vec4f(0.0, 0.35, 0.7, 1.0);
  for (var j: i32 = 0; j < 4; j = j + 1) {
    let f = fs[j];
    let w = f * f * (0.35 + 0.65 * f);
    let taper = t.r * mix(1.0, 0.09, f * (0.45 + 0.55 * f)) * (1.0 + 0.15 * sin(f * 9.0 + t.seed.z * 21.0));
    (*tbl)[j] = vec4f(t.base + vec3f(t.lean.x * w, t.h * f, t.lean.y * w), taper);
  }
  let n = i32(clamp(round(params.branches), 0.0, f32(MAX_BRANCH)));
  if (n <= 0 || t.reach <= 0.0) { return 0; }
  let g = clamp(params.gnarl, 0.0, 1.5);
  for (var k: i32 = 0; k < MAX_BRANCH; k = k + 1) {
    if (k >= n) { break; }
    let fk32 = f32(k);
    let rnd = fract(t.seed * (7.13 + fk32 * 3.77) + vec4f(0.31, 0.71, 0.13, 0.57) * fk32);
    // Biased UP the stem: the top of a bare tree is where the branches crowd, and with no
    // foliage in this file that crowding IS the crown.
    let u = (fk32 + 0.5 + g * (rnd.x - 0.5)) / f32(n);
    let f = clamp(0.3 + 0.68 * u * (0.55 + 0.45 * u), 0.05, 0.99);
    // The golden angle, so successive branches never stack in one plane.
    let ang = 2.39996 * fk32 + t.seed.w * 6.2831853 + g * (rnd.y - 0.5) * 3.6;
    // Lower branches droop and reach further; upper ones shorten and claw upward.
    let rise = params.branchRise + 1.05 * (f - 0.5) + g * (rnd.z - 0.5) * 1.15;
    let len = t.reach * (0.55 + 0.55 * (1.0 - f)) * (0.7 + 0.6 * rnd.w);
    let w = f * f * (0.35 + 0.65 * f);
    let a = t.base + vec3f(t.lean.x * w, t.h * f, t.lean.y * w);
    let ca = cos(ang);
    let sa = sin(ang);
    let dir = normalize(vec3f(ca, rise, sa));
    const COS19: f32 = -0.32329;
    const SIN19: f32 = 0.94630;
    let bend = normalize(dir + vec3f(0.0, 0.5 + 0.55 * g * (rnd.x - 0.3), 0.0)
                       + vec3f(ca * COS19 - sa * SIN19, 0.0, sa * COS19 + ca * SIN19) * (0.35 + 0.5 * g));
    let ra = t.r * mix(1.0, 0.09, f * (0.45 + 0.55 * f)) * 0.7;
    let m = a + dir * len * 0.52;
    (*tbl)[4 + k * 3] = vec4f(a, ra);
    (*tbl)[5 + k * 3] = vec4f(m, ra * 0.42);
    (*tbl)[6 + k * 3] = vec4f(m + bend * len * 0.6, ra * 0.11);
  }
  return n;
}

/* The tree's distance field at one of three levels of detail (see NEAR_CELLS/FAR_CELLS),
   returned as (nearest axis point, distance). lod 0 is the trunk alone, lod 1 straightens
   each branch into one capsule, lod 2 keeps the elbow. Every point and radius it reads was
   tabulated once by 'buildTree'; this function is pure arithmetic on the sample point. */
fn treeNear(p: vec3f, tbl: ptr<function, array<vec4f, 22>>, nb: i32, lod: i32) -> vec4f {
  let k0 = (*tbl)[0];
  let k1 = (*tbl)[1];
  let k2 = (*tbl)[2];
  let k3 = (*tbl)[3];
  var d = nearTaper(p, k0.xyz, k1.xyz, k0.w, k1.w);
  d = nearer(d, nearTaper(p, k1.xyz, k2.xyz, k1.w, k2.w));
  d = nearer(d, nearTaper(p, k2.xyz, k3.xyz, k2.w, k3.w));
  if (lod <= 0 || nb <= 0) { return d; }
  /* THE BRANCH ENVELOPE. Every branch lies inside one fat capsule around the upper stem,
     so if the distance to THAT is already further than the trunk's, no branch can be the
     nearest thing and all of their distances are skipped. Conservative, therefore exact:
     the value returned is unchanged, only the work is not done. It pays because of where
     the march spends its steps — walking up to a trunk through the empty air below the
     crown, step after step, with the envelope metres away. */
  let envA = mix(k0.xyz, k1.xyz, 0.7);
  let envR = params.branchSpread * params.spacing * 0.7 + k0.w;
  if (segDist(p, envA, k3.xyz) - envR >= d.w) { return d; }
  for (var k: i32 = 0; k < MAX_BRANCH; k = k + 1) {
    if (k >= nb) { break; }
    let a = (*tbl)[4 + k * 3];
    let m = (*tbl)[5 + k * 3];
    let b = (*tbl)[6 + k * 3];
    if (lod >= 2) {
      d = nearer(d, nearTaper(p, a.xyz, m.xyz, a.w, m.w));
      d = nearer(d, nearTaper(p, m.xyz, b.xyz, m.w, b.w));
    } else {
      // One straight capsule shoulder to tip: the same reach and the same taper, without
      // the bend. At more than NEAR_CELLS away the difference is inside a pixel of mist.
      d = nearer(d, nearTaper(p, a.xyz, b.xyz, a.w, b.w));
    }
  }
  return d;
}

// ---------------------------------------------------------------- the walk through the grid
struct Hit {
  t: f32,
  n: vec3f,
  hit: f32,
};

/* Nearest forward crossing of an infinite vertical cylinder, as (enter, exit); x > y when
   there is none. Two dots and a sqrt — this is the test every cell pays and almost every
   cell fails, so it is deliberately the cheapest thing in the file. */
fn cylinderSpan(o: vec2f, d: vec2f, c: vec2f, r: f32) -> vec2f {
  let m = o - c;
  let a = dot(d, d);
  let b = dot(m, d);
  let cc = dot(m, m) - r * r;
  let disc = b * b - a * cc;
  if (disc < 0.0) { return vec2f(1.0, -1.0); }
  let s = sqrt(disc);
  return vec2f((-b - s) / a, (-b + s) / a);
}

fn marchForest(ro: vec3f, rd: vec3f, base: vec2f, reach: f32, jitter: f32) -> Hit {
  var out: Hit;
  out.t = reach;
  out.n = vec3f(0.0, 1.0, 0.0);
  out.hit = 0.0;
  let s = params.spacing;
  // Amanatides-Woo over the XZ grid, in the eye's own cell frame.
  var cell = floor(ro.xz / s);
  let stepDir = sign(rd.xz);
  let inv = 1.0 / max(abs(rd.xz), vec2f(1.0e-5));
  var tMax = ((cell + max(stepDir, vec2f(0.0))) * s - ro.xz) * vec2f(
    select(-inv.x, inv.x, rd.x >= 0.0),
    select(-inv.y, inv.y, rd.z >= 0.0),
  );
  // sign(0) is 0, which would freeze the walk on an axis-aligned ray; push those cells out
  // of reach so the other axis carries the march.
  if (stepDir.x == 0.0) { tMax.x = reach + s; }
  if (stepDir.y == 0.0) { tMax.y = reach + s; }
  let tDelta = vec2f(s, s) * inv;
  var tEnter = 0.0;
  var tbl: array<vec4f, 22>;

  for (var i: i32 = 0; i < MAX_CELLS; i = i + 1) {
    let tExit = min(min(tMax.x, tMax.y), reach);
    if (tEnter >= reach) { break; }
    let tree = treeAt(cell, cell + base);
    if (tree.present > 0.5) {
      /* TWO BOUNDS, AND THE SECOND ONE IS WHERE THE FRAME TIME WENT.
         The full bound has to contain the branches, so it fills most of a cell — which
         means a near-horizontal ray hits it in four cells out of five and the DDA culls
         almost nothing on its own. That was measured, not guessed: the first draft ran at
         eleven milliseconds and a bare grid with NO trees in it ran at twelve, which is
         the shape of a cull that is not culling.
         What actually separates cheap rays from dear ones is HEIGHT. Branches start at
         'limb', a third of the way up; the eye is at 1.7 m and the walk is level, so
         through the whole lower half of the frame the ray is under every branch in the
         wood and only the trunk can be hit. That ray takes the STEM bound — a fifth of the
         width — and a trunk-only field, and never builds a branch table at all. */
      let low = max(ro.y + rd.y * tEnter, ro.y + rd.y * tExit) < tree.limb;
      let tall = min(ro.y + rd.y * tEnter, ro.y + rd.y * tExit) < tree.h;
      let span = cylinderSpan(ro.xz, rd.xz, tree.base.xz, select(tree.bound, tree.stem, low));
      let tA = max(max(span.x, tEnter), 0.0);
      let tB = min(span.y, tExit);
      if (tA < tB && tall) {
        let lod = select(select(2, 1, tEnter > s * NEAR_CELLS), 0, tEnter > s * FAR_CELLS || low);
        let nb = buildTree(tree, &tbl);
        // Dither the entry so the step lattice does not print itself on the silhouettes.
        var t = tA + jitter * 0.01 * tA;
        for (var k: i32 = 0; k < MARCH_STEPS; k = k + 1) {
          if (t > tB) { break; }
          let p = ro + rd * t;
          let near = treeNear(p, &tbl, nb, lod);
          // The epsilon opens with distance: a far trunk is resolved to a pixel, not to a
          // millimetre, and the mist is where the difference goes.
          let eps = 0.0015 + 0.0024 * t;
          if (near.w < eps) {
            out.t = t;
            out.hit = 1.0;
            // The normal, for free: the query already knows which point on which capsule
            // axis was nearest, and a capsule's gradient is the direction away from it.
            out.n = normalize(p - near.xyz);
            return out;
          }
          // The floor on the step is RELATIVE, so a grazing ray that stalls against a
          // trunk still leaves the bound inside the step budget instead of burning all
          // its steps inside a millimetre.
          t = t + max(near.w * STEP_SCALE, eps * 1.5);
        }
      }
    }
    // Next cell.
    if (tMax.x < tMax.y) {
      tEnter = tMax.x;
      tMax.x = tMax.x + tDelta.x;
      cell.x = cell.x + stepDir.x;
    } else {
      tEnter = tMax.y;
      tMax.y = tMax.y + tDelta.y;
      cell.y = cell.y + stepDir.y;
    }
  }
  return out;
}

// ---------------------------------------------------------------- the air
/* Optical depth from the eye to t: a uniform term plus a term that pools near the ground.
   Both integrals are ANALYTIC along a straight ray, so the fog costs two exponentials
   rather than a march — which is what leaves a budget for the shafts. */
fn layerDepth(oy: f32, dy: f32, t: f32, k: f32, h: f32) -> f32 {
  if (k <= 0.0) { return 0.0; }
  if (abs(dy) < 1.0e-3) { return k * exp(-oy / h) * t; }
  return k * h * (exp(-oy / h) - exp(-(oy + dy * t) / h)) / dy;
}
/* BOTH layers thin with height, and that is what makes the moon visible at all: a haze
   with no altitude profile is as thick straight up as it is along the ground, so the first
   draft's sky was solid fog and the moon simply was not in the picture. */
fn opticalDepth(o: vec3f, d: vec3f, t: f32) -> f32 {
  return layerDepth(o.y, d.y, t, max(params.fog, 0.0), AIR_HEIGHT)
       + layerDepth(o.y, d.y, t, max(params.mist, 0.0), max(params.fogHeight, 0.15));
}
fn density(y: f32) -> f32 {
  return max(params.fog, 0.0) * exp(-y / AIR_HEIGHT)
       + max(params.mist, 0.0) * exp(-y / max(params.fogHeight, 0.15));
}

/* How much of the moon reaches x: ONE probe along the moon direction, at a distance that
   is different for every sample on the view ray. A fixed pair of probe distances costs
   twice as much and sees a fixed pair of slices of the light path; one STOCHASTIC probe,
   integrated over the seven samples the shaft loop already takes, sees the whole path for
   half the price. It tests the trunk COLUMN of whatever cell it lands in — no branches, no
   distance field, no march — and the column is deliberately far wider and softer than the
   trunk: a trunk-width shadow at this sample count is invisible structure, and a wide one
   is both the shaft and most of the brightness control, because fog lit through wide
   occluders is DARKER fog. */
fn moonVisible(x: vec3f, l: vec3f, base: vec2f, u: f32) -> f32 {
  let s = params.spacing;
  let y = x + l * (s * (0.45 + 2.4 * u));
  let cell = floor(y.xz / s);
  let tree = stemAt(cell, cell + base);
  if (tree.present < 0.5 || y.y > tree.h) { return 1.0; }
  let dxz = length(y.xz - tree.base.xz);
  let w = max(tree.r, 0.02);
  return 1.0 - 0.92 * smoothstep(w * 7.0, w * 1.1, dxz);
}

// ---------------------------------------------------------------- sky and moon
fn skyColour(d: vec3f, l: vec3f, veil: f32) -> vec3f {
  let up = clamp(d.y, 0.0, 1.0);
  let horizon = params.fogColor.rgb;
  var sky = mix(horizon, params.skyColor.rgb, pow(up, 0.62));
  let ang = acos(clamp(dot(d, l), -1.0, 1.0));
  // The aureole: a tight ring on the disc and a broad wash across the whole sky. This is
  // the mist scattering the moon, so it is written here and NOT as a bloom — an analytic
  // halo costs two exponentials and a post blur costs a pass.
  let halo = exp(-ang * 7.5) * 0.55 + exp(-ang * 1.35) * 0.16;
  sky = sky + params.moonColor.rgb * params.moonGain * halo * veil;
  // The disc, limb-darkened, with two noise samples of mare across it. Only inside the
  // disc, so the noise is paid for by a few hundred pixels.
  let rr = max(params.moonSize, 0.02) * PI / 180.0;
  let disc = smoothstep(rr * 1.03, rr * 0.93, ang);
  if (disc > 0.001) {
    let lb = sqrt(max(1.0 - (ang / rr) * (ang / rr), 0.0));
    let uvm = (d - l * dot(d, l)) / rr;
    // Faint maria. Kept low-frequency and shallow on purpose: at the first draft's depth
    // and frequency the noise lattice cut a visibly FLAT edge across the top of the disc,
    // which on a full moon is the one artefact everybody notices.
    let mare = 0.9 + 0.12 * vnoise2(uvm.xy * 1.6 + 11.0) + 0.06 * vnoise2(uvm.xz * 3.1);
    sky = sky + params.moonColor.rgb * params.moonGain * disc * mix(0.55, 1.0, pow(lb, 0.45)) * mare * 2.6 * veil;
  }
  return sky;
}

// ---------------------------------------------------------------- the frame
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = frameU.resolution.x / max(frameU.resolution.y, 1.0);
  let q = (uv - vec2f(0.5)) * vec2f(aspect, -1.0) * 2.0;
  let t = frameU.absTime;

  // THE WALK. A free-running translation with no fixed point: this is the whole motion
  // budget, and the sway and bob are offsets on the same clock, never envelopes.
  let walk = t * params.walkSpeed;
  let eyeX = params.sway * (sin(t * 0.083) * 0.7 + sin(t * 0.031) * 0.3);
  let eyeY = params.eyeHeight + params.bob * sin(t * 1.6);
  // Rebased onto the eye's own cell so every ray runs near the origin in f32 while the
  // hash still reads an exact integer cell index (see the docblock).
  let s = max(params.spacing, 0.4);
  let base = floor(vec2f(eyeX, walk) / s);
  let o = vec3f(eyeX - base.x * s, eyeY, walk - base.y * s);

  // The camera never turns. Fixed basis, pitched up so the horizon sits below centre and
  // the trees tower — and so the sky's per-pixel direction is constant, which is what
  // makes the screen-space cloud veil correct rather than a cheat.
  let pit = params.pitch * PI / 180.0;
  let fwd = vec3f(0.0, sin(pit), cos(pit));
  let right = vec3f(1.0, 0.0, 0.0);
  let upv = vec3f(0.0, cos(pit), -sin(pit));
  let rd = normalize(fwd * max(params.lens, 0.3) + right * q.x + upv * q.y);

  let az = params.moonAzimuth * PI / 180.0;
  let el = params.moonHeight * PI / 180.0;
  let l = normalize(vec3f(sin(az) * cos(el), sin(el), cos(az) * cos(el)));

  // Fixed per-pixel dither: grain, never flicker (E55's finding, kept).
  let jitter = hash21(floor(uv * frameU.resolution) + 0.5);

  // THE REACH IS SOLVED FROM THE FOG, not authored: past REACH_OPACITY nothing can reach
  // the picture, so raising 'fog' marches fewer cells and the frame gets CHEAPER. The mist
  // counts at half weight because a trunk stands out of it — the eye-height density alone
  // would cut the reach in front of trees that are still visible over the pooling.
  let sigma = max(params.fog * exp(-o.y / AIR_HEIGHT) + 0.5 * params.mist * exp(-o.y / max(params.fogHeight, 0.15)), 0.004);
  let reach = clamp(REACH_OPACITY / sigma, s * 2.0, f32(MAX_CELLS) * s);

  // The ground plane, analytic; the forest, by DDA. Nearest wins.
  var tHit = reach;
  var normal = vec3f(0.0, 1.0, 0.0);
  var hit = 0.0;
  var isGround = false;
  if (rd.y < -1.0e-4) {
    let tg = -o.y / rd.y;
    if (tg > 0.0 && tg < tHit) { tHit = tg; hit = 1.0; isGround = true; }
  }
  let forest = marchForest(o, rd, base, tHit, jitter);
  if (forest.hit > 0.5) {
    tHit = forest.t;
    normal = forest.n;
    hit = 1.0;
    isGround = false;
  }

  // THE SURFACE. The moon is ahead, so a trunk is BACK-LIT: its camera-facing side is dark
  // and the light is a rim where the surface turns toward the moon. That is the mystical
  // reading and it is free — no shadow ray is cast at a surface anywhere in this file.
  var surface = vec3f(0.0);
  if (hit > 0.5) {
    let p = o + rd * tHit;
    let moonDot = max(dot(normal, l), 0.0);
    let sky = mix(params.fogColor.rgb, params.skyColor.rgb, clamp(normal.y * 0.5 + 0.5, 0.0, 1.0));
    if (isGround) {
      // A little litter variation, then mostly mist. The floor is a value, not a subject.
      let litter = 0.72 + 0.45 * vnoise2(p.xz * 0.75) * 0.5 + 0.25 * vnoise2(p.xz * 3.1);
      surface = params.groundColor.rgb * litter
              * (params.ambient * sky + params.moonColor.rgb * params.moonGain * moonDot * 0.55);
    } else {
      let rim = pow(1.0 - abs(dot(normal, rd)), 3.0);
      surface = params.barkColor.rgb
              * (params.ambient * sky
                 + params.moonColor.rgb * params.moonGain * (moonDot * 0.9 + rim * moonDot * 1.4))
              + params.moonColor.rgb * params.moonGain * rim * 0.06;
    }
  } else {
    /* THE CLOUD VEIL, CLAMPED — and the clamp is the whole of a defect that took three
       renders to attribute. Perlin is SIGNED, so scaling the raw sample and adding an
       offset put part of the field below zero; the sky was then multiplied by a negative
       number over a big smooth blob, and its ZERO CROSSING drew a hard curved edge across
       the left of the frame. It sat in exactly the same screen position at frame 60 and
       frame 600, which is what finally identified it: a tree moves, a veil does not. */
    let veil = clamp(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).r, 0.0, 1.0);
    surface = skyColour(rd, l, mix(1.0, 0.4 + 1.05 * veil, clamp(params.cloud, 0.0, 1.0)));
  }

  // THE AIR, AS ONE IN-SCATTER SPLIT IN TWO — and the split is the whole design.
  //
  // The SKY-LIT half is unshadowed and low-frequency, so it is the analytic
  // (1 - transmittance) term and costs two exponentials. The MOON'S half is the one that
  // carries structure — a shaft exists only because a trunk is in the way — so it is the
  // only thing marched. Adding the moon to BOTH would double-count it, which is the first
  // draft's mistake and the reason that frame read as daylight.
  let tr = exp(-opticalDepth(o, rd, tHit));
  let phase = pow(max(dot(rd, l), 0.0), 6.0);
  // The fog's own colour is what it gets from the SKY, so it falls off downward — the
  // ground takes skylight away. It is deliberately a small number: almost all of the
  // brightness in this picture is supposed to arrive through the shaft term below, because
  // that is the term that knows where the moon is. A fog that is bright on its own is the
  // daylight-overcast reading, which is what the first draft looked like.
  let ambientFog = params.fogColor.rgb * (0.30 + 0.95 * clamp(rd.y * 1.7 + 0.42, 0.0, 1.0));
  var col = surface * tr + ambientFog * (1.0 - tr);

  /* THE SHAFTS, AND THE HALF OF THEM THAT IS NOT MARCHED AT ALL.
     The moon's in-scatter splits again: an UNSHADOWED part, whose integral over the whole
     ray is exactly (1 - transmittance) because the density and the extinction are the same
     function — so it is free, and it is the ambient wash toward the moon — and a SHADOWED
     part, which is the only thing a shaft actually is. Only the second is marched, and it
     is weighted by the forward-scattering lobe.
     ⚠ SKIPPING THE MARCH WHERE THAT LOBE IS SMALL WAS TRIED AND REFUSED. The saving looked
     free — the term dropped is multiplied by the lobe that decided to drop it — and it was
     not: at the threshold the dropped term is still six thousandths of a linear unit, which
     is thirty percent of the level in the DARK quarter of the frame, so the gate's own cone
     printed a huge circular arc across the lower left. It was invisible in every still
     until a static-pixel mask over fourteen seconds of walking showed a smooth curve where
     a walking scene can have none. A discontinuity that is small in absolute terms is not
     small where the picture is dark.
     The samples are IMPORTANCE-SAMPLED BY TRANSMITTANCE — drawn from exp(-sigma t) over
     [0, far] — so they crowd where light survives instead of spreading evenly over a range
     whose far half contributes nothing. That is what makes nine enough; uniform spacing at
     this count was visible speckle.
     Every exponential in the loop is SHARED between the density and the optical depth,
     because they are built from the same two altitude terms. Written the obvious way this
     loop read five transcendentals a sample and it is the third-largest thing in the frame;
     written this way it reads three. 'shafts' at 0 skips all of it and is the second cost
     lever in the file. */
  let shaftGain = max(params.shafts, 0.0);
  if (shaftGain > 0.001) {
    var acc = 0.0;
    {
      let far = min(tHit, reach);
      let tFar = exp(-sigma * far);
      let norm = (1.0 - tFar) / sigma;
      let ha = AIR_HEIGHT;
      let hm = max(params.fogHeight, 0.15);
      let ea0 = exp(-o.y / ha);
      let em0 = exp(-o.y / hm);
      let kf = max(params.fog, 0.0);
      let km = max(params.mist, 0.0);
      let flat = abs(rd.y) < 1.0e-3;
      var sum = 0.0;
      for (var i: i32 = 0; i < SHAFT_STEPS; i = i + 1) {
        let u = (f32(i) + jitter) / f32(SHAFT_STEPS);
        let ts = -log(max(1.0 - u * (1.0 - tFar), 1.0e-6)) / sigma;
        let ea = ea0 * exp(-rd.y * ts / ha);
        let em = em0 * exp(-rd.y * ts / hm);
        let dens = kf * ea + km * em;
        let od = select(kf * ha * (ea0 - ea) / rd.y + km * hm * (em0 - em) / rd.y,
                        (kf * ea0 + km * em0) * ts, flat);
        // The estimator's weight: the true transmittance over the sampling density's,
        // which is near 1 by construction and carries only the altitude structure the
        // constant sigma does not know about.
        sum = sum + dens * moonVisible(o + rd * ts, l, base, fract(jitter * 1.618 + u)) * exp(-od + sigma * ts);
      }
      acc = sum * norm / f32(SHAFT_STEPS);
    }
    col = col + params.moonColor.rgb * params.moonGain * shaftGain
              * (0.022 * (1.0 - tr) + 0.95 * phase * acc);
  }

  // THE QUIET ZONE. Text goes on top, so this dissolves a patch of the picture into the
  // mist it was already converging to — composition, not a rectangle laid over the top.
  let qz = clamp(params.quiet, 0.0, 1.0);
  if (qz > 0.001) {
    let dq = (uv - params.quietAt) * vec2f(aspect, 1.0) / max(params.quietSize, 0.02);
    // A LONG falloff, and it is not a detail: at smoothstep(1, 0.15) the zone's own edge
    // was a visible arc across the picture — a dark ellipse, which is precisely the
    // rectangle-over-the-top this term exists to avoid. A mist bank has no edge.
    let w = qz * smoothstep(1.7, 0.0, length(dq));
    col = mix(col, ambientFog, w);
  }

  // The vignette RANGE deliberately overshoots the frame: at smoothstep(1.85, 0.35) it
  // bottomed out inside the picture, and a smoothstep that saturates leaves a visible arc
  // where its slope goes to zero — a dark ellipse drawn across an otherwise smooth sky,
  // found by looking rather than by arithmetic (§V912). Ending past the corner keeps the
  // falloff monotone everywhere the viewer can see.
  let vig = mix(1.0, smoothstep(2.4, 0.2, length(q * vec2f(0.62, 1.0))), clamp(params.vignette, 0.0, 1.0));
  return vec4f(col * params.exposure * vig, 1.0);
}
`;
