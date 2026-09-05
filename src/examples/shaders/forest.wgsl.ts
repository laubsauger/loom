import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * E57 Forest — the walking hero-unit raymarcher (T1156, deepened T1170).
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
 * T1170: HOW MANY of them there are is a low-frequency FIELD over that same index rather
 * than a constant probability (see 'standAt' and 'stemAt'), which is what stops a repeat
 * reading as a lattice. That field is also the ground the trunk feet and the eye stand on.
 * It is still a pure function of the cell index and the gate on it is still BINARY, and
 * both of those are load-bearing rather than tidy: a smooth field multiplied into a tree's
 * size, or a field read off the eye-relative position, is a tree that GROWS while you walk
 * toward it — which is what the first draft of the second storey looked like, for a
 * different reason, and what the owner saw.
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
 * along the view ray, importance-sampled by transmittance, each shadowed by a SHORT WALK
 * along the moon's own fixed direction that tests the TRUNK COLUMN only — no branches, no
 * distance field. `shafts` at 0 skips the loop outright, so it is the second cost lever and
 * the .md says so.
 *
 * ⚑ T1170b REBUILT THAT SHADOW AND THE MEASUREMENT IS WHY. The shafts were never missing —
 * turning `shafts` off moves the frame's mean luma from 0.288 to 0.041, so the term is the
 * whole illumination — but the OCCLUSION inside it, the only part that makes a shaft a
 * shaft, was worth a mean of 1.5 to 3.1 of 255. One stochastic point probe per sample is a
 * Bernoulli draw: shallow in expectation, maximal in variance. It is now an analytic walk
 * (see 'moonVisible'), which is both deeper and quiet, and the picture is the alternation
 * of lit and unlit slabs the eye reads as a god ray rather than a wash.
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
 *   - (T1170) SAPLINGS as the second storey. A mature tree at a quarter scale is exactly the
 *     picture of a tree that has not finished growing, and the owner read the frame and said
 *     so. Replaced by BROKEN stems, which differ in form rather than in size — see 'stemAt'.
 *   - (T1170) HEADING DRIFT, and any camera rotation at all. The gait and the ground swell
 *     are both TRANSLATIONS and that is the only reason either was affordable here: the sky
 *     direction has to stay constant per pixel for the veil, and the moon and the quiet zone
 *     have to hold still for a headline.
 *   - (T1170) A ROLLING GROUND PLANE. A height field needs a march where a plane needs one
 *     divide, and the floor of every frame in this file is haze — see the fragment's note.
 *   - (T1170) A FAR-FIELD BLUR in the defocus pass: the fog already does that, and two cues
 *     for the same thing argue. 'FOREST_DOF_WGSL' is one-sided by construction.
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
 * construction — it cannot settle, there is nothing for it to settle INTO — and the wander,
 * the gait and the ground swell are position offsets on the same clock. Nothing here is an
 * envelope. Anybody adding a second motion source should know they are fighting the walk,
 * which is why this paragraph is here rather than in a commit message — and why T1170's
 * gait is DERIVED from `walkSpeed` rather than run at a rate of its own.
 *
 * THE CAMERA NEVER TURNS, and that is load-bearing twice over. The per-pixel sky direction
 * is therefore constant, which makes the screen-space cloud veil read off `inputTexture`
 * exactly correct rather than a cheat; and the moon and the quiet zone hold still, which is
 * what a headline needs.
 *
 * MEASURED (§V913). Per FRAME, averaged over four pairs across the first sixteen seconds
 * and four across the last fifteen: 7.977e-4 opening, 7.855e-4 closing — 98% of the opening
 * pace after a full minute; with the walk cut the closing figure is 6.130e-7. The averaging
 * is not a nicety: T1170's gait and clumping between them make a SINGLE pair read anywhere
 * from 2.9e-4 to 1.35e-3 on phase and stand alone, and the one-pair version of this claim
 * failed at 0.54 — correctly, because it was measuring one draw rather than the pace.
 * Nothing decays because nothing here is an envelope.
 *
 * ⚑ T1170b PUT AUDIO ON IT, AND THE OWNER'S CONSTRAINT WAS THE DESIGN: 'audio reactive in a
 * way where it is not becoming flickery and weird'. So nothing drives a per-frame
 * brightness. Two slow lanes — 'mist', the density of the air, and 'moonGain', the one gain
 * everything else in this shader is measured against — both ranked through their own recent
 * distribution so neither can pin or idle. The document's docblock carries the numbers. The
 * walk is untouched: the drive moves the AIR and the KEY, never the camera.
 *
 * Deterministic (§V44/§V45): `frameU.absTime` is the only clock, and the march dither is a
 * hash of the pixel, fixed across frames — grain, never flicker (E55's finding).
 */
export const FOREST_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  walkSpeed: f32,     // @default 0.85  metres a second the eye travels forward, forever — the whole motion budget
  sway: f32,          // @default 0.5  how far the walk wanders side to side, metres
  bob: f32,           // @default 0.045  rise and fall of the step, metres
  eyeHeight: f32,     // @default 1.7  the eye above the ground, metres
  pitch: f32,         // @default 7  degrees the view tilts up — raises the horizon's trees over the mist floor
  lens: f32,          // @default 1.45  focal length: higher is a longer lens, so the forest stacks up and compresses
  spacing: f32,       // @default 5.2  metres between tree cells — also the ceiling on how wide a tree may grow
  density: f32,       // @default 1  share of cells that carry a tree at all, 0 to 1
  clumping: f32,      // @default 0.85  how far that share varies from place to place — 0 is an even field, 1 is thickets and clearings
  relief: f32,        // @default 1.4  metres the ground rolls under the wood — trunk feet and the eye ride the same slow swell
  snags: f32,         // @default 0.28  share of the stems that are BROKEN: a blunt, branchless column a fifth to a half the height
  treeHeight: f32,    // @default 14  mean trunk height, metres
  heightVary: f32,    // @default 0.55  how much heights differ tree to tree, 0 is a plantation
  trunkWidth: f32,    // @default 0.26  trunk radius at the base, metres
  lean: f32,          // @default 0.8  how far a trunk leans off vertical by its top — the crooked, creepy reading
  branches: f32,      // @default 5  branches per tree, 0 to 6 — this IS the crown; there is no foliage (see the docblock)
  branchSpread: f32,  // @default 0.4  branch length as a share of the cell; it SATURATES at the cell (and squeezes out the tree's own jitter first, so a stand goes gridded before it goes wide) — widen spacing to grow them
  branchRise: f32,    // @default 0.15  negative droops the branches, positive reaches them up
  gnarl: f32,         // @default 0.65  irregularity of branch angle and length — 0 is a diagram, 1 is a thicket
  barkColor: vec4f,   // @default [0.13, 0.125, 0.12, 1]  the wood under the moon
  groundColor: vec4f, // @default [0.11, 0.12, 0.11, 1]  the forest floor under the mist
  fog: f32,           // @default 0.03  uniform haze density — the aerial perspective, and the cost lever: more fog is FEWER cells
  mist: f32,          // @default 0.17  extra density pooling on the ground, over and above the fog
  fogHeight: f32,     // @default 3.4  metres over which that pooling thins with height
  fogColor: vec4f,    // @default [0.038, 0.048, 0.068, 1]  what everything converges to at distance
  shafts: f32,        // @default 0.85  strength of the light shafts between the trunks; 0 skips the volumetric march entirely
  skyColor: vec4f,    // @default [0.01, 0.016, 0.032, 1]  the sky at the zenith, above the haze
  cloud: f32,         // @default 0.55  how much the cloud veil on the input dims the sky and the moon
  moonSize: f32,      // @default 3.2  angular radius of the disc, degrees — a real moon is 0.25, a hero moon is bigger
  moonHeight: f32,    // @default 24  the moon's elevation above the horizon, degrees
  moonAzimuth: f32,   // @default 14  degrees right of the walk direction — where the composition puts it
  moonColor: vec4f,   // @default [0.74, 0.82, 0.98, 1]  the moon and everything it lights
  moonGain: f32,      // @default 1  how hard the moon lights the scene
  ambient: f32,       // @default 0.5  sky fill on the bark, so a back-lit trunk is not a silhouette cut out of black
  quiet: f32,         // @default 0.7  how far the headline zone dissolves into mist — the hero unit's readable patch
  quietAt: vec2f,     // @default [0.3, 0.58]  where that zone sits, in screen fractions from the top left
  quietSize: f32,     // @default 0.4  its radius, in screen fractions
  vignette: f32,      // @default 0.55  corner falloff
  exposure: f32,      // @default 0.85  master gain before the display transform
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
/* The volumetric: samples along the view ray, each carrying one short shadow walk toward
   the moon. Deliberately small, and IMPORTANCE-SAMPLED by transmittance (below), which is
   what lets seven of them be enough where twenty uniform ones were not.
   ⚠ THIS IS NOW THE FILE'S EXPENSIVE NUMBER, because each step pays a walk rather than a
   point test, and T1170b tried to cut it and could not: at five steps the grain in a flat
   patch of fog goes from 0.0191 to 0.0303 — nearly triple the shipped file's 0.0109 — and
   the frame only comes down from +23.5% to +21%. Two and a half points of frame time for
   sixty percent more grain is the wrong side of the trade, and the number is here so the
   next person does not re-run it. */
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

/* THE STAND FIELD. One low-frequency value noise over the grid, read at three places and
   therefore written once: it decides how many cells in a neighbourhood carry a stem, and it
   is also the GROUND — the eye and every trunk foot ride the same swell (see 'relief').
   Sampled at an integer cell index for a tree and at a continuous position for the eye,
   which is the same field either way, so a tree and the eye standing beside it agree.
   'smoothstep' rather than the raw noise: bilinear value noise bunches around 0.5, and what
   is wanted is places that are OPEN and places that are THICK, not a permanent middle. */
fn standAt(cellish: vec2f) -> f32 {
  return smoothstep(0.32, 0.70, vnoise2(cellish * 0.40 + vec2f(21.3, 7.9)));
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
  snag: f32,      // 1 when this stem is broken: no branches, and a blunt top rather than a point
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
  /* THE DENSITY IS A FIELD, NOT A NUMBER — and that is the answer to "the wood reads
     repetitive", which per-tree variation could not give. Every tree here already differs
     in height, radius, lean, branch phase and offset, and it did not help: at a CONSTANT
     probability of one tree per cell the stand is a regular lattice however varied the
     individuals are, and through this much fog the trunks reduce to an evenly spaced
     rhythm of verticals — a picket fence. Real woods clump. So the share of cells that
     carry a stem is a low-frequency value noise over the cell index: thickets you cannot
     see into and clearings you can see across, and it is the DIFFERENCE between them that
     the eye reads as depth.
     It also pays for itself. A clearing walks the same cells with nothing in them, so the
     bound tests still happen and every march inside a bound does not — measured against a
     same-run control in the .md, and it comes out slightly CHEAPER than the even field it
     replaced even after the four extra hashes.
     BOTH ENDS OF THIS WERE FOUND BY LOOKING (§V912) AND BOTH WERE WRONG FIRST. At a scale
     of 0.28 per cell the clump period is eighteen metres against a reach of about
     twenty-six, and the camera walks INTO a clearing and stays there: frame 900 of the
     first attempt was an empty grey wash with two trunks at the edge, which is worse than
     the lattice it replaced. 0.40 — inside 'standAt' — is a clump every thirteen metres, so
     two of them are always in shot and the picture is the contrast between them. And a
     clearing must be THIN, not BARE: the floor is 0.42 of the density and the draft that
     used 0.12 is the one that produced that empty frame, because a hole with nothing at all
     in it stops reading as a wood and starts reading as the end of the geometry. The top
     saturates against 1.0 on purpose — a thicket is every cell full — and the contrast
     between the two ends is the only event this loop has.
     ⚑ AND THE GATE IS BINARY AND A PURE FUNCTION OF THE CELL INDEX, which is not a detail:
     a cell has a stem or it does not. Multiplying a smooth field into a tree's HEIGHT or
     RADIUS instead would make a marginal cell's tree rise out of the ground as the field
     shifted, and reading the field off the eye-relative position rather than 'cellAbs'
     would make it change every time the camera crossed a cell wall. Either one is a tree
     that grows while you watch, and neither is recoverable by tuning. */
  let stand = standAt(cellAbs);
  let share = clamp(params.density, 0.0, 1.0)
            * mix(1.0, 0.42 + 1.15 * stand, clamp(params.clumping, 0.0, 1.0));
  t.present = select(0.0, 1.0, s.x < share);
  let half = params.spacing * 0.5;
  /* A SECOND STOREY, because every stem in the first draft was a mature tree ten to
     eighteen metres tall — so every vertical in the frame ran off the top of it and the
     picture had exactly one scale in it. A share of the cells instead carry a BROKEN stem.
     ⚑ AND IT IS BROKEN RATHER THAN YOUNG BECAUSE THE OWNER READ THE FIRST VERSION AND SAID
     THE TREES WERE "GROWING". They were: a sapling here was a mature tree at a quarter
     scale — same proportions, same branch pattern from 30% up the stem, same silhouette —
     and a quarter-size copy of the tree next to it is exactly the picture of a tree that
     has not finished growing. Nothing was animating; the FORM was wrong, and no amount of
     hashing fixes a form that is a scale copy.
     A snapped stem is a different object rather than a smaller one. It keeps the full trunk
     radius of the tree it was — that is the whole point, a snag is the BOTTOM of a big tree
     — it carries no branches at all, and it ends BLUNT where it broke instead of tapering
     to a point. Three differences, none of them scale, and it suits a dead wood better than
     a nursery did.
     It is also the cheapest stem in the file: no branch table is ever built for it, its
     bound is the stem bound, and the 'tall' test culls every ray passing over it.
     The draw is a DECORRELATED scalar, not one of the four randoms the cell already
     spends: 's.w' sets the lean direction and half the jitter, so drawing off it would
     have made every snag in the wood lean the same way. */
  t.snag = select(0.0, 1.0, fract(s.y * 31.71 + s.w * 13.13 + 0.37) < clamp(params.snags, 0.0, 1.0));
  // Old thick trees and thin ones in the same wood: the radius spread is wide on
  // purpose, because a stand of identical poles is the thing that reads as procedural.
  t.r = max(params.trunkWidth, 0.01) * (0.5 + 1.15 * s.y * s.y);
  t.h = max(params.treeHeight, 0.5) * (1.0 - 0.5 * params.heightVary + params.heightVary * s.z)
      * mix(1.0, 0.16 + 0.34 * s.z, t.snag);
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
  // A snag has no branches: they went with the top of it.
  t.reach = min(max(params.branchSpread, 0.0) * half * 1.35 * (1.0 - t.snag),
                max(budget - t.leanLen, 0.0));
  t.bound = t.leanLen + t.reach + t.r * 1.3;
  t.stem = t.leanLen + t.r * 1.35;
  // The lowest point any branch can reach: they attach from 0.3 of the stem and the
  // droopiest one falls about 0.06 of the tree below its shoulder, so 0.2 leaves margin.
  // Too high a limb line and a drooping branch is sliced off by the stem bound.
  t.limb = t.h * 0.2;
  // Whatever room is left after the bound is where the tree may sit inside its cell.
  let room = max(half - t.bound, 0.0);
  let jitter = (s.zw - 0.5) * 2.0 * room;
  /* THE GROUND ROLLS, and this one line is worth more to "I am walking through this" than
     any number of extra trees. Everything stood on one flat plane, so every trunk met the
     mist at the same altitude and the eye read a dead horizontal floor line across the
     frame however varied the trees above it were.
     The swell is the STAND FIELD ITSELF — free, because the cell has already paid for it —
     and it is signed DOWNWARD only, into [-relief, 0]. Downward matters: a foot below the
     ground plane is buried, which the mist swallows, whereas a foot above it would be a
     tree visibly hovering over its own floor. So a thick stand sits in a hollow and a
     clearing stands on the rise, which is also the more interesting way round to walk
     through: you come up out of the trees and can see. */
  t.base = vec3f(
    (cellLocal.x + 0.5) * params.spacing + jitter.x,
    -max(params.relief, 0.0) * stand,
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
    // A whole tree tapers to a point; a SNAG ends where it snapped, so its top radius is
    // more than half its base. That blunt end is most of what says "broken" rather than
    // "small" from a distance, and it costs one mix.
    let tip = mix(0.09, 0.62, t.snag);
    let taper = t.r * mix(1.0, tip, f * (0.45 + 0.55 * f)) * (1.0 + 0.15 * sin(f * 9.0 + t.seed.z * 21.0));
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
      // Both lines are relative to THIS tree's own foot, because the ground rolls: a tree
      // in a hollow has its lowest branch and its crown a metre lower than one on the rise,
      // and comparing either against an absolute altitude would cull the wrong ray.
      let low = max(ro.y + rd.y * tEnter, ro.y + rd.y * tExit) < tree.base.y + tree.limb;
      let tall = min(ro.y + rd.y * tEnter, ro.y + rd.y * tExit) < tree.base.y + tree.h;
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

/* HOW MUCH OF THE MOON REACHES x — and this is the term that turns a glow into a god ray.
 *
 * ⚑ T1170b MEASURED WHAT WAS HERE BEFORE ANYTHING WAS ADDED, and the reading redirected the
 * whole pass. The shafts were never missing: switching 'shafts' from its shipped value to 0
 * moves the frame's mean luma from 0.288 to 0.041, so THIS BLOCK IS ESSENTIALLY THE ENTIRE
 * ILLUMINATION OF THE PICTURE. What was missing was the only part of it that makes a shaft
 * a shaft: THE OCCLUSION. Replacing this function's return with a constant 1.0 changed the
 * frame by a mean of 1.5 to 3.1 of 255 and a MAXIMUM of 24 to 37 — about one percent of a
 * frame the term supplies a hundred percent of. Amplified fourteen times the difference had
 * the right SHAPE (vertical slabs radiating from the moon) buried in per-pixel noise of the
 * same size. So the fix was never "add shafts"; it was to make the shadow deep, and then to
 * make it QUIET enough to be seen.
 *
 * ## THE OLD SHAPE, AND WHY IT COULD NOT GET THERE
 *
 * One STOCHASTIC point probe per volumetric sample, testing whether that point sat inside a
 * trunk column. A point test is a Bernoulli draw: its expectation is the shadowed FRACTION,
 * which is small, and its variance is the largest a bounded estimator can have. Seven of
 * them per pixel with a per-pixel hash therefore delivered a shallow average wrapped in
 * salt-and-pepper grain — and every way of deepening the shadow (more taps, wider columns,
 * full extinction) deepened the grain in exact proportion. Measured on the way through: at
 * four stratified taps and a wide column the structure was unmistakable and the grain in a
 * flat patch of fog had TRIPLED, from 0.0109 to 0.0326.
 *
 * ## WHAT IS HERE INSTEAD: NO SAMPLING ALONG THE LIGHT PATH AT ALL
 *
 * The moon direction is FIXED, so the shadow of a trunk is a fixed cylinder and the question
 * "is x in shadow" is a question about the DISTANCE FROM THE LIGHT RAY TO A TRUNK AXIS — an
 * analytic quantity, not one to be sampled. So this walks the grid along the moon's own XZ
 * direction (the same Amanatides-Woo the view ray uses, and the setup is cheap because the
 * direction is constant) and for each cell it enters computes the PERPENDICULAR distance
 * from the light ray to that cell's trunk, with the ray's own height where it passes.
 *
 * That is smooth in x. There is no dither in it, no 'u', and therefore NO NOISE OF ITS OWN:
 * measured in that same flat patch of fog, the sampled four-tap version read 0.0326 against
 * the shipped file's 0.0109 and this reads 0.0191 — and what is left is not the shadow, it
 * is the SEVEN-SAMPLE VIEW-RAY estimator finally being asked a question with structure in
 * it. That residual is bought down by the dither the fragment picks for this loop and by
 * nothing else here; see 'dither' at the call site.
 *
 * ⚠ THE FADE IS LOAD-BEARING, NOT A FLOURISH. A walk of a fixed number of CELLS reaches a
 * distance that depends on where in its first cell the point started, so the far end of the
 * walk enters and leaves as the camera moves — and a trunk arriving there at full strength
 * would pop a shadow into existence. 'fade' takes the occlusion to zero before the shortest
 * walk the cell count can produce (SHADOW_CELLS - 1 cells over the worst diagonal), so a
 * cell can only ever join the walk contributing nothing. It is also the right picture: a
 * shadow cast from far away through this much haze has no edge left.
 *
 * The column is still far wider than the trunk (SHADOW_WIDE/SHADOW_CORE), and for the same
 * reason as before — a fog lit through wide occluders is a DARKER fog, and that darkness is
 * most of the mood. What changed is that it can now be FULL extinction at the core without
 * buying noise, so the picture is the alternation of lit and unlit slabs rather than a wash.
 */
const SHADOW_CELLS: i32 = 5;
/* The column, in trunk radii: full extinction inside SHADOW_CORE, nothing past SHADOW_WIDE.
   Deliberately much wider than the trunk — see the note above. */
const SHADOW_CORE: f32 = 2.5;
const SHADOW_WIDE: f32 = 7.0;
/* Where the shadow has faded out, in cells. A DDA of SHADOW_CELLS steps is guaranteed to
   reach (SHADOW_CELLS - 1) * spacing / sqrt(2) even on the worst diagonal, which is 2.12
   cells at four; ending the fade inside that is what makes the walk's own far end
   invisible. */
const SHADOW_REACH: f32 = 2.6;
fn moonVisible(x: vec3f, dxz: vec2f, slope: f32, base: vec2f, canopy: f32) -> f32 {
  // Above the tallest stem the wood can grow there is nothing left to cast, and the taps
  // only climb from here — so the whole walk is skipped for every sample over the canopy,
  // which near the moon is most of them.
  if (x.y > canopy) { return 1.0; }
  let s = params.spacing;
  var cell = floor(x.xz / s);
  let stepDir = sign(dxz);
  let inv = 1.0 / max(abs(dxz), vec2f(1.0e-5));
  var tMax = ((cell + max(stepDir, vec2f(0.0))) * s - x.xz) * vec2f(
    select(-inv.x, inv.x, dxz.x >= 0.0),
    select(-inv.y, inv.y, dxz.y >= 0.0),
  );
  // sign(0) is 0, which would freeze the walk on an axis-aligned moon; push that axis out
  // of reach so the other one carries it (the view ray's DDA does the same).
  if (stepDir.x == 0.0) { tMax.x = 1.0e9; }
  if (stepDir.y == 0.0) { tMax.y = 1.0e9; }
  let tDelta = vec2f(s, s) * inv;
  let far = s * SHADOW_REACH;
  var vis = 1.0;
  var tEnter = 0.0;
  for (var i: i32 = 0; i < SHADOW_CELLS; i = i + 1) {
    /* Three ways out, and every one of them is exact rather than a tolerance. Past 'far'
       the fade below is already zero; above the canopy nothing can cast and the ray only
       climbs; and once the light is gone it cannot be taken away again. Near the moon —
       where the shafts are and where this loop would otherwise cost the most — the second
       one retires the walk on the first step. */
    if (tEnter > far || x.y + slope * tEnter > canopy || vis < 0.004) { break; }
    let tree = stemAt(cell, cell + base);
    if (tree.present > 0.5) {
      let m = tree.base.xz - x.xz;
      let along = dot(m, dxz);
      /* The light ray's height where it passes this trunk. A trunk the ray clears overhead
         casts nothing — which is why the shafts open out above the wood — but the test on
         it may NOT be the obvious inequality: a binary one printed a hard HORIZONTAL edge
         straight across the upper right of the frame, found by looking (§V912), because a
         boolean over a continuous quantity is a step. The stem tapers, so the shadow tapers
         with it: over the top third of a tree the column thins to nothing, which is both
         smooth and the truth about the object. */
      let taper = clamp((tree.base.y + tree.h - (x.y + slope * along)) / max(tree.h * 0.35, 0.5), 0.0, 1.0);
      if (along > 0.0 && taper > 0.0) {
        let perp = length(m - dxz * along);
        let w = max(tree.r, 0.02);
        let fade = 1.0 - smoothstep(far * 0.6, far, along);
        vis = vis * (1.0 - fade * taper * smoothstep(w * SHADOW_WIDE, w * SHADOW_CORE, perp));
      }
    }
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
  return vis;
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
  // budget, and the wander and the gait are offsets on the same clock, never envelopes.
  let walk = t * params.walkSpeed;
  /* THE GAIT, and it is DERIVED FROM THE WALK rather than added beside it — which is the
     only reason it is not the second motion source this file's docblock warns about. A
     step is about 0.72 m, so the stride rate is the walk's own speed over that: 2*pi/0.72
     is 8.727. The body rises twice a stride, once per foot, and rolls sideways once, onto
     the left foot and then the right — and that 2:1 relationship IS the cue. The first
     draft bobbed at a fixed 1.6 rad/s, four cycles a minute, which is breathing; a
     sinusoid at a rate the walk does not know about reads as floating, however small.
     Neither term turns the camera. Both are TRANSLATIONS of the eye, so the moon, the
     quiet zone and the per-pixel sky direction hold exactly as still as they did before —
     which is what the screen-space veil and the headline each need, and it is why gait was
     affordable here when heading drift was not (see the docblock's refusals). */
  let stride = t * max(params.walkSpeed, 0.0) * 8.727;
  let eyeX = params.sway * (sin(t * 0.083) * 0.7 + sin(t * 0.031) * 0.3)
           + params.bob * 0.7 * sin(stride * 0.5);
  let eyeY = params.eyeHeight + params.bob * sin(stride);
  // Rebased onto the eye's own cell so every ray runs near the origin in f32 while the
  // hash still reads an exact integer cell index (see the docblock).
  let s = max(params.spacing, 0.4);
  let base = floor(vec2f(eyeX, walk) / s);
  /* AND THE EYE RIDES THE SAME SWELL — at a QUARTER of the amplitude, centred, and against
     a floor. Sinking the trunk feet alone would be a wood of trees at different heights
     beside a camera that glides; walking is the eye going down with them and coming up on
     the rise, and the horizon drifting as it does. It is the SAME field, read at the eye's
     continuous position rather than at a cell index, so the eye and the tree beside it
     agree about which way the ground goes. One value noise a pixel, all pixels agreeing —
     it is a function of the eye, not of the ray.
     ⚑ WHY A QUARTER, CENTRED, AND CLAMPED, all three found the hard way at 'relief' 1.8:
     the eye took the full one-sided swell, dropped to a tenth of a metre and then BELOW the
     ground plane, and the plane — which is at y = 0 and stays flat, see below — printed a
     hard horizontal edge straight across the lower third of the frame. That is precisely
     the dead floor line this term exists to remove, drawn much darker. Centred, a quarter
     of it, and floored at a fifth of a metre, the eye can never reach the plane at any
     value of the knob.
     ⚑ AND THE GROUND PLANE ITSELF DOES NOT ROLL, which is a refusal rather than an
     omission. Intersecting a height field needs a march where a plane needs one divide, and
     the ground is NEVER SEEN: 'mist' pools over 'fogHeight' metres and the floor of every
     frame in this file is haze. Marching a surface to render something invisible is the
     exact trade the rest of the file exists to refuse. What the swell buys is what is
     actually visible — trunk feet meeting the mist at different heights, a stand dipping
     together rather than each tree differing on its own, and the eye's own rise and fall. */
  let swell = -max(params.relief, 0.0) * (standAt(vec2f(eyeX, walk) / s) - 0.5) * 0.5;
  let o = vec3f(eyeX - base.x * s, max(eyeY + swell, 0.2), walk - base.y * s);

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
  let pxf = floor(uv * frameU.resolution) + 0.5;
  let jitter = hash21(pxf);
  /* THE VOLUMETRIC'S OWN DITHER, AND IT IS NOT THE MARCH'S (T1170b). Both are fixed per
     pixel — grain, never flicker — but they want different distributions. The march wants
     an uncorrelated hash: it dithers a silhouette by a hundredth of a metre and any
     structure in it prints on an edge. The shaft loop wants the opposite: it offsets ONE
     stratified sequence per pixel, so a white-noise offset makes neighbouring pixels
     disagree at random and the residual is salt-and-pepper. Interleaved gradient noise
     spreads the seven offsets EVENLY over a small neighbourhood, so the residual is a fine
     even weave instead of speckle. Measured in a flat patch of fog, second differences:
     0.0326 with a hash against 0.0191 with this, for the same picture. */
  let dither = fract(52.9829189 * fract(0.06711056 * pxf.x + 0.00583715 * pxf.y));

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
     lever in the file.
     ⚑ AND THE COEFFICIENT ON THE SHADOWED TERM IS 1.95 RATHER THAN T1170's 0.95, WHICH IS
     NOT A BRIGHTNESS DECISION. A shadow that actually blocks removes light, and the deep
     analytic occlusion below takes the frame's mean from 0.30 to about 0.18 on its own. The
     gain puts the LIT fog back where it was, so what the change buys is contrast between
     lit and unlit slabs rather than a darker picture — the same trade 'clumping' made
     between thickets and clearings, one term further in. Measured across five frames spread
     over forty seconds, the frame mean now swings 0.214 to 0.406 where the T1170 file swung
     0.286 to 0.306: a fivefold wider swing about nearly the same average, which IS the
     light coming and going as you walk. */
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
      /* The shadow ray, set up ONCE: the moon never moves, so its XZ direction, the height
         it gains per metre of ground covered, and the ceiling above which nothing can cast
         are all frame constants rather than per-sample work. The floor on the horizontal
         length is what a moon at the zenith needs — the slope then goes huge, every trunk
         is passed overhead, and the wood casts nothing, which is correct rather than a
         guard. */
      let lxz = max(length(l.xz), 1.0e-3);
      let shadowDir = l.xz / lxz;
      let shadowSlope = l.y / lxz;
      let canopy = max(params.treeHeight, 0.5) * (1.0 + 0.5 * max(params.heightVary, 0.0));
      var sum = 0.0;
      for (var i: i32 = 0; i < SHAFT_STEPS; i = i + 1) {
        let u = (f32(i) + dither) / f32(SHAFT_STEPS);
        let ts = -log(max(1.0 - u * (1.0 - tFar), 1.0e-6)) / sigma;
        let ea = ea0 * exp(-rd.y * ts / ha);
        let em = em0 * exp(-rd.y * ts / hm);
        let dens = kf * ea + km * em;
        let od = select(kf * ha * (ea0 - ea) / rd.y + km * hm * (em0 - em) / rd.y,
                        (kf * ea0 + km * em0) * ts, flat);
        // The estimator's weight: the true transmittance over the sampling density's,
        // which is near 1 by construction and carries only the altitude structure the
        // constant sigma does not know about.
        sum = sum + dens * moonVisible(o + rd * ts, shadowDir, shadowSlope, base, canopy) * exp(-od + sigma * ts);
      }
      acc = sum * norm / f32(SHAFT_STEPS);
    }
    col = col + params.moonColor.rgb * params.moonGain * shaftGain
              * (0.022 * (1.0 - tr) + 1.95 * phase * acc);
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
  /* THE ALPHA CHANNEL CARRIES DEPTH IN METRES, for the defocus pass downstream. A
     customWgsl node's contract is one texture in and one texture out — there is no second
     render target to write — so the channel this picture does not use is where the
     geometry the next pass needs has to travel. It is the distance the view ray ran, or
     'reach' where it met nothing, and the target is rgba16float, which resolves a metre at
     fifty to about a sixteenth of one: far finer than a circle of confusion needs.
     'dof1' writes an opaque 1.0 back, so nothing outside this pair ever sees it — but a
     preview tapped off THIS node rather than the output will show a non-opaque alpha, and
     that is a real consequence of the trick rather than a bug to go hunting. */
  return vec4f(col * params.exposure * vig, min(tHit, reach));
}
`;

/**
 * E57's DEFOCUS PASS (T1170) — the near field, and only the near field.
 *
 * ## Why this exists and why it is not a far-field blur
 *
 * The ask was depth of field. Half of depth of field is already in the forest pass and
 * always was: `fog` attenuates everything with distance, and a far-field blur would
 * duplicate what the fog does and then compete with it for the same pixels — two different
 * "this is far away" cues arguing. What fog CANNOT do is soften something that is too
 * CLOSE, and that is the half worth buying, because a trunk sliding past at arm's length
 * out of focus is the difference between walking through a forest and looking at one. So
 * the circle of confusion here is one-sided: zero at `focus` and beyond, opening as the
 * surface comes toward the eye. There is no far knob and that is a decision (§V146 — a
 * knob whose every value ships a worse picture is not a knob).
 *
 * ## It is a separate pass, not lens sampling in the march
 *
 * Sampling a lens aperture inside the raymarch means N rays a pixel and N times the DDA;
 * the entire budget argument in `documents/forest.ts` dies at N = 2. A gather over the
 * finished frame is nine texture reads within about twenty pixels of each other, which is
 * cache-resident. The cost is in the .md, measured against a same-run control.
 *
 * ## SCATTER, WRITTEN AS A GATHER, which is the part that is easy to get wrong
 *
 * The naive version reads the CENTRE pixel's depth, picks a radius from it and averages.
 * That blurs the inside of a near trunk and leaves its silhouette razor sharp, because the
 * background pixels just outside the edge are far away and choose radius zero — so the
 * defocused object still has a hard outline, which is the one thing defocus is supposed to
 * remove. Here every tap is instead weighted by ITS OWN circle of confusion against ITS OWN
 * distance from the centre: a tap contributes here only if its own blur circle is wide
 * enough to reach here. Near geometry therefore spreads OUTWARD over the background, which
 * is what a real lens does and what the eye is looking for.
 *
 * The disc is eight taps on the golden angle at sqrt-spaced radii — equal area per tap —
 * rotated by a hash of the pixel that is FIXED across frames, so the sampling is grain and
 * never flicker (E55's finding, and the forest pass's own dither is the same trick).
 */
export const FOREST_DOF_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  focus: f32,   // @default 8.5  metres: at this distance and beyond the picture is sharp; nearer than it softens
  blur: f32,    // @default 0.016  the widest circle of confusion, as a fraction of the frame width; 0 passes the frame straight through
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

const TAPS: i32 = 12;
const GOLDEN: f32 = 2.39996;

fn hash21(p: vec2f) -> f32 {
  var q = fract(vec3f(p.xyx) * 0.1031);
  q = q + vec3f(dot(q, q.yzx + 33.33));
  return fract((q.x + q.y) * q.z);
}

/* One-sided: 1 at the eye, 0 at 'focus' and past it. SQUARED, and the square is what sets
   where the effect actually lives: a linear ramp spreads a little blur over the whole
   mid-ground, where the fog is already doing that job and doing it better, so the two
   cues argue. Squared, the curve is flat for most of the range and only bites in the last
   third — at 'focus' 8.5 that is a circle of 0.74 at two metres, 0.51 at three and under
   0.01 at seven, which is "the trunk you are about to walk past" and nothing else.
   The first draft had 'focus' at 4.2 with the same square and the effect was INVISIBLE on
   every frame but the one that happened to have a trunk inside a metre — the square had
   pushed the whole ramp inside the near cell wall. Read the curve, do not assume it. */
fn coc(depth: f32) -> f32 {
  let x = 1.0 - smoothstep(0.0, max(params.focus, 0.05), depth);
  return x * x;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let centre = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let r = max(params.blur, 0.0);
  // The alpha the forest pass wrote is DEPTH; what leaves here is an opaque frame.
  if (r < 1.0e-5) { return vec4f(centre.rgb, 1.0); }
  let aspect = frameU.resolution.x / max(frameU.resolution.y, 1.0);
  // A fixed per-pixel rotation, so eight taps do not print an eight-pointed star on every
  // out-of-focus edge in the frame. Hashed off the pixel, not the frame: grain, not flicker.
  let rot = hash21(floor(uv * frameU.resolution) + 0.5) * 6.2831853;
  let cr = cos(rot);
  let sr = sin(rot);
  var acc = centre.rgb;
  var wsum = 1.0;
  for (var i: i32 = 0; i < TAPS; i = i + 1) {
    let a = f32(i) * GOLDEN;
    let ca = cos(a);
    let sa = sin(a);
    // sqrt-spaced radii put equal area behind each tap instead of crowding the centre.
    let k = sqrt((f32(i) + 0.5) / f32(TAPS));
    let d = vec2f(ca * cr - sa * sr, sa * cr + ca * sr) * k;
    let s = textureSampleLevel(inputTexture, inputSampler, uv + d * r * vec2f(1.0, aspect), 0.0);
    // THE SCATTER, AS A GATHER: this tap reaches this pixel only if its own circle of
    // confusion is at least as wide as the distance between them.
    /* The band around that threshold is wide, and it is PROPORTIONAL to k rather than
       added to it. Wide because a narrow one makes the weight very nearly binary and
       twelve taps voting 0 or 1 print visible speckle on any partly defocused edge —
       grain that reads as dirt on the lens rather than as defocus.
       ⚠ PROPORTIONAL BECAUSE AN ADDITIVE BAND LEAKS. The first draft used k ± 0.34, whose
       lower edge is NEGATIVE for the inner taps, so a tap with a circle of confusion of
       exactly zero still landed with weight 0.10 — a permanent low-grade blur over the
       whole frame, the far field included, which is precisely the "argues with the fog"
       failure this pass was designed to avoid. It was invisible on every still and the
       arithmetic found it: with 'focus' at 0, where nothing at all may be defocused,
       twenty-seven thousand pixels of fifty-seven still differed from the pass switched
       off. Scaled by k the lower edge cannot go below zero, so a zero circle contributes
       exactly nothing and 'focus' at 0 is a byte-exact passthrough. */
    let w = smoothstep(k * 0.55, k * 1.5, coc(s.a));
    acc = acc + s.rgb * w;
    wsum = wsum + w;
  }
  return vec4f(acc / wsum, 1.0);
}
`;
