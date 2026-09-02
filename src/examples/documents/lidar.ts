import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E34 — Lidar (T641). THE RAY POP, WORKING FOR ITS LIVING.
 *
 * A night survey: a mast at the origin sweeps a ring of 240 rays over a dark noise
 * terrain. Every ray is AIMED BY AN ATTRIBUTE — `aim1` writes a vec3f `direction` per
 * point (azimuth from the point's index, the ring's tilt breathing on a driven Value
 * slot) — which is the reason Ray is a POP and not a SOP: a grid of downward rays is a
 * heightmap lookup, a cloud of independently-aimed rays is an instrument.
 *
 * ## The central teaching: ONE texture, TWO mappings, made to agree
 *
 * The terrain the camera sees and the field the rays march are THE SAME noise texture,
 * and nothing checks that for you. The bridge (`textureToAttribute`) samples at the
 * point's clip xy with v INVERTED (uv = (x/2+0.5, 0.5−y/2), T512); the Ray field maps
 * world x,z ∈ [−extent, +extent] with NO inversion (uv = (x,z)/(2·extent)+0.5). So
 * `unfold1` parks the sample sheet at (X/extent, −Z/extent) — the minus sign IS the
 * agreement — and `raise1` rebuilds (X, height, Z) from the same indices. Get that sign
 * wrong and the scan line drapes over a terrain the picture mirrors front-to-back:
 * plausible at a glance, wrong everywhere, invisible until a ray "hits" a valley.
 *
 * T672 gave that agreement a THIRD reader: `pool1` parks each return at the same clip
 * (X/extent, −Z/extent) so the light pool lands on the terrain that made it. See the
 * kernel's own comment for why the minus sign survives the composition.
 *
 * ## Reflection, literally (the owner's "raycasting / reflection ala TD POPs")
 *
 * TWO Ray nodes, chained. `ricochet1` reflects each hit's direction about its
 * `hitNormal` and re-origins at the hit (lifted 0.03 along the normal so the second
 * march does not start inside the ground it just found); `rebound1` casts again. A
 * first-leg MISS keeps marching from its end — physically fine — and is masked out of
 * the echo reading by `echo = hit₁` carried across the second cast, because the second
 * Ray writes its own `hit` over the first one's.
 *
 * ## The readings (§V471 — and an honest deviation, T642)
 *
 * One cast, three readings: IMPACTS (hot amber, brightness by 1 − distance/range — the
 * lidar return), OUT-OF-RANGE (the same ray set, `hit = 0`: faint steel points hanging
 * at the ray ends, a cone rim in the air where the beam gave out — `maxDistance` is
 * deliberately SHORTER than the shallow ring's slant, so the ring crosses the range
 * boundary as it breathes and RIDGES come into range before valleys: the relief reads
 * in the hit/miss boundary itself), and ECHOES (cyan, both legs hit). These readings
 * are kernel-written TINT classes plus a parked-position cull (mark2 sends non-echoes
 * to y = −60), and since T642 the SELECTION itself is a group predicate on the lit draw
 * — §V471's idiom, running through the shared camera and depth buffer rather than as a
 * predicate-filtered 2D overlay under its own projection, which cannot sit on a 3D
 * camera's picture. T672 makes this file run BOTH halves of that resolver: `poolmap1` is
 * a genuine `renderPoints` draw, into a texture, feeding the terrain's albedo.
 *
 * ## Why the dots are unlit and the ground is not
 *
 * A lidar return is an EMITTER on the display — `materialUnlit` × per-point tint —
 * while the terrain is a dielectric under the whole T632/T636 stack: a shadowed cool
 * key, an equirect night sky whose Fresnel reflection rims the ridges at grazing and
 * whose diffuse irradiance (1 − F)(1 − metallic) fills the valleys the key never
 * reaches. Kill the environment wire and the valleys go black; that is the diffuse
 * half doing the work `ambientIntensity` used to fake.
 *
 * ## What T658 changed, and why each was a defect rather than a preference
 *
 * CLIPPING (the owner's "prevent clipping with the camera and the mountain on one
 * edge"). It was never a near plane: the orbit clears the terrain box by 1.1 world
 * units against a near of 0.1. It was the PLATE'S RIM. The sheet is a finite square
 * and the camera orbited OUTSIDE its footprint, so at every angle a segment of the
 * near rim fell inside a 46°/74° frustum and drew as a ruler-straight cut with the
 * void behind it. The plate now outgrows the orbit — extent 4.8 against a radius of
 * 3.8 — so the near rim is always behind the camera and only distant rim remains,
 * which reads as a horizon because ridges break it. The grid went to 192² to hold the
 * cell size at 0.05, and the noise period scaled by 3.2/4.8 to hold the world feature
 * size, so growing the ground changed the geometry and not the look.
 *
 * And the trap worth one line: THE ORBIT RADIUS IS NOT IN THE CAMERA. `eye.x` and
 * `eye.z` are driven by `orbx1`/`orbz1`, so the static `eye` vector's x and z are
 * inert (§V465) — editing them to reframe is a no-op that looks like a fix in a diff.
 *
 * SHADOWS (T666/§V617). Not the slope-scaled bias — forcing the old constant 0.002
 * back makes it strictly worse. Not the billboard skip — these markers are instances,
 * which that skip does not reach. Rendering the terrain ALONE settled it: the ground
 * self-shadows almost nowhere, and the black combing was 480 unlit octahedra casting
 * hard, texel-quantised fins down every grazing slope. An unlit surface takes no part
 * in lighting, so it does not block light either; the rule now lives in the compiler.
 *
 * FLICKER AND TRAILS ARE ONE MECHANISM, and that is the interesting part. A ray's
 * verdict is BINARY, so a ray sitting on the range frontier flips it every frame —
 * which means the smoothing had to be TEMPORAL AND ON THE READING, not a blur on the
 * picture. `wake` on both mark kernels is that persistence, and the same state that
 * stops the blinking is what leaves a fade behind a moving return. Measured with the
 * camera frozen, so nothing but the reading can change: the hard-flip rate among
 * bright pixels falls 36.2% → 22.8% and the mean frame-to-frame change 59.4 → 37.8.
 * What is left is the beam's own rotation at 0.22 rad/s, which is the example.
 *
 * ## The sky is the same map (T659)
 *
 * `skyband1` is now DRAWN as well as taken — `showEnvironment` on this render. Until
 * T659 the environment had exactly two readers, the reflection vector and the five
 * irradiance taps, and no pass ever rendered it: the visible night was the `background`
 * colour, so tuning the ramp changed the fill and the rim and never the sky. One map now
 * lights the scene and IS the scene's backdrop, which is the only way the rim light on a
 * ridge can agree with what is behind it. The switch is off by default and this is the
 * only example that opts in.
 *
 * ## What T672 changed: the beams, the pool, and the hold
 *
 * The owner, on the shipped T658 build: "it feels like some weird noise still and
 * missing something that ties it together". THE BEAMS ARE THE THING THAT TIES IT
 * TOGETHER. A lidar without them is a hillside with dots appearing on it, and the owner
 * read it exactly that way; `rays1` draws the causal chain in `beam` mode (T680), which
 * spans each ray's origin to the `hitPosition` `cast1` already carries.
 *
 * THE GROUND IS NOW LIT BY ITS OWN RETURNS, through the albedo map rather than through
 * 240 lights: `pool1` → `poolmap1` → `poolsoft1` → `poolbase1` → `basalt1.albedo`. §V644
 * lives in `poolbase1`'s comment and is the one thing here that fails as a lighting bug.
 *
 * AND THE "FLICKER" WAS SEMANTIC (T681). Camera frozen, the terrain contributes EXACTLY
 * ZERO frame-to-frame energy and the echoes carried 82% of it; colouring each echo by
 * the index of the ray that made it shows the primary ring as a smooth colour wheel and
 * the echoes SCRAMBLED — adjacent rays land metres apart, so the second leg's landing
 * point is a chaotic function of azimuth and a marker that re-reads while lit teleports
 * constantly. Sample-and-hold on `mark2a` is the fix, in one condition.
 *
 * MEASURED — camera frozen (orbx1/orbz1 at frequency 0), 15 frame-pairs over frames
 * 400–415, full 1280×720 (§V627), display-encoded (§V618). Both halves re-measured back
 * to back on ONE tree so the comparison is not an argument (§V641): engine `d8ed47e`,
 * "before" = this entry as shipped at `83e03ff`.
 *
 *     band            BEFORE                      AFTER
 *     total energy    1,386,519                   727,237
 *     green energy      873,292 (63.0%)            53,657 (7.4%)   −93.9%
 *     green hard-flip      39.1% on 9,502 px         6.6% on 3,730 px
 *     amber energy      205,286 (14.8%)           626,612 (86.2%)  ← the beams' own sweep
 *     amber hard-flip       7.7%                      6.0%
 *     halo energy       307,942                    46,968
 *
 * Free-running throughout (§V436): the sweep, the tilt and the orbit read absolute
 * clocks, so a timeline lap never snaps the scan.
 */
const LIDAR_EXTENT = 4.8;

const LIDAR_HEIGHT_SCALE = 2.6;

const LIDAR_HEIGHT_OFFSET_V = -0.6;

const LIDAR_MAST = 3.3;

const LIDAR_HEIGHT_OFFSET = LIDAR_HEIGHT_OFFSET_V;
/* T711 — RANGE AND CONTRACTION ARE ONE NUMBER, and this is the constraint the next
   person tuning this file will hit. The tightest the target circle can be is set by the
   STEEPEST tilt, and the steepest tilt is capped by how far a shot can reach: the mast
   stands at y = 3.3 and the terrain floor is −0.6, so a vertical shot needs 3.9 to touch
   the bottom of the basin. At the shipped 3.4 a vertical shot bottoms out at y = −0.1 —
   measured at tilt span 0.72 the whole middle of the ring falls SHORT, turns
   out-of-range steel, and exactly one beam survives. So "contract the circle further"

   costs REACH, and 3.4 → 3.9 moves with the span below or the ask breaks the picture. */
const LIDAR_RANGE = 3.9;
/* The tilt's shallow end and its SPAN, in radians below horizontal. The shallow end does
   not move (§V639: the echoes exist BECAUSE shallow rays reflect forward off back-slopes,
   and steepening that end deletes the reading). The span is the owner's "a bit smaller
   even than what we have now": 0.50 → 0.62 takes the tightest ring's radius to
   tan(1.10)/tan(1.22) = 0.719 of what it was — 28% smaller, and the ratio is free of the

   local ground height, so it is a fact about the instrument rather than about one frame. */
const LIDAR_TILT_MIN = 0.6;

const LIDAR_TILT_SPAN = 0.62;

/* T658: the terrain GRID, sized so a cell stays 0.05 world units after the plate grew
   — 2·4.8/192 = 0.05, the exact spacing the 3.2/128 sheet had. */
const LIDAR_GRID = 192;

const LIDAR_SHEET_COUNT = LIDAR_GRID * LIDAR_GRID;
/* The camera's orbit radius. It lives HERE and in the two LFO amplitudes, never in the
   camera's `eye`: eye.x and eye.z are DRIVEN, so the static vector's x and z are inert

   and editing them to reframe is a silent no-op (§V465, and it cost an hour to learn).*/
const LIDAR_ORBIT = 3.8;
/* T672: one ray in ten is DRAWN as a beam. Every ray is still CAST — `spoke` costs one
   f32 pair and no marching at all — and the subset is a picture decision measured rather
   than chosen: 240 beams sharing one origin fuse into a solid opaque cone that hides the

   terrain, 24 read as an instrument. */
const LIDAR_SPOKE_EVERY = 10;

/* The light-pool map's resolution. The terrain grid is 192², so this is ~2.7 texels a
   cell — enough that the pool's edge is the blur's and not the map's. */
const LIDAR_POOL_RES = 512;

const LIDAR_SHEET_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
]);

/* `sample` is declared to be READ — it binds the bridge's own pair upstream (T401),
   exactly E20's dance. */
const LIDAR_RAISE_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "sample", type: "vec4f", default: [0, 0, 0, 0] },
]);

/* The sample sheet: place each grid point where the BRIDGE will read the texel the RAY
   will march at (X, Z). Clip (X/extent, −Z/extent) — the minus is the v-inversion

   agreement argued in the header. */
const LIDAR_UNFOLD_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let u = f32(ctx.dim.i) / f32(ctx.dim.cols - 1u);
  let v = f32(ctx.dim.j) / f32(ctx.dim.rows - 1u);
  let worldX = (u * 2.0 - 1.0) * ${LIDAR_EXTENT};
  let worldZ = (v * 2.0 - 1.0) * ${LIDAR_EXTENT};
  q.position = vec3f(worldX / ${LIDAR_EXTENT}, -worldZ / ${LIDAR_EXTENT}, 0.0);
  return q;
}`;

/* Rebuild (X, height, Z) from the SAME indices — the bridge's sample is the r channel
   the Ray node reads, through the same y = r × scale + offset the Ray applies. */
const LIDAR_RAISE_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let u = f32(ctx.dim.i) / f32(ctx.dim.cols - 1u);
  let v = f32(ctx.dim.j) / f32(ctx.dim.rows - 1u);
  let worldX = (u * 2.0 - 1.0) * ${LIDAR_EXTENT};
  let worldZ = (v * 2.0 - 1.0) * ${LIDAR_EXTENT};
  q.position = vec3f(worldX, p.sample.r * ${LIDAR_HEIGHT_SCALE} + (${LIDAR_HEIGHT_OFFSET}), worldZ);
  return q;
}`;

/* THREE attributes, six bindings — still inside §V588's baseline eight. `spoke` is the
   whole cost of drawing the beams: a per-ray f32 the aim kernel writes and the beam
   geometry's group predicate reads, riding the Ray node's pass-through to the draw. No

   extra march, no extra pass. */
const LIDAR_AIM_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "direction", type: "vec3f", default: [0, -1, 0] },
  { name: "spoke", type: "f32", default: [0] },
]);

/* The instrument. Azimuth from the INDEX (240 rays around the full circle), the ring's
   tilt on the driven value slot (T479): tiltwave1 breathes it steep↔shallow, and the
   whole ring turns on the absolute clock. maxDistance is chosen against these angles —

   see the ray node's comment. */
const LIDAR_AIM_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let azimuth = (f32(ctx.index) / f32(ctx.count)) * 6.28318530718 + ctx.absTime * 0.22;
  /* 0.60..1.22 rad (34°..70° below horizontal): the steep end lands well inside range,
     the shallow end's slant exceeds it and the outer ring goes dark — and shallow
     strikes reflect FORWARD off back-slopes, which is where the echoes come from.
     The steep end is capped by LIDAR_RANGE, not by taste — see that constant. */
  let tilt = ${LIDAR_TILT_MIN} + ctx.value1 * ${LIDAR_TILT_SPAN};
  q.position = vec3f(0.0, ${LIDAR_MAST}, 0.0);
  q.direction = normalize(vec3f(
    sin(azimuth) * cos(tilt),
    -sin(tilt),
    cos(azimuth) * cos(tilt),
  ));
  /* T672: every ray is CAST, every tenth is DRAWN. See LIDAR_SPOKE_EVERY. */
  q.spoke = select(0.0, 1.0, (ctx.index % ${LIDAR_SPOKE_EVERY}u) == 0u);
  return q;
}`;

/* T711 — THE BEAM'S OWN COLOUR, one slot per attribute and four of them (§V588 again).
   `spoke` is declared because the draw's predicate reads it and this kernel sits between

   `cast1` and the draw; `hitPosition` because the beam's far end is written here. */
const LIDAR_SIGHT_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "spoke", type: "f32", default: [0] },
  { name: "hitPosition", type: "vec3f", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
]);

/* T711 — A RAY AND THE MARK IT MAKES SHARE A COLOUR, which is the whole reason this
   kernel exists. `haze1` used to be a FLAT [0.36, 0.21, 0.08] — one colour for every
   beam, unrelated to the box it lands on — and the mechanism nobody had named is that
   0.36 sits just BELOW `cut1`'s 0.42 bloom knee, so 24 lit ribbons read as matte orange
   sticks while the ring they end on glowed. The expression here is `mark1`'s own return
   colour at a lower gain, so the beam is the same yellow as its impact and lands ABOVE
   the knee: the eye traces cause to effect because the two are literally one colour.

   And the second half: A RAY WITH NO RETURN IS NOT DRAWN. Both ends on the same point
   is a ZERO-AREA beam, which is the honest reading of a shot that never landed, and it
   needs no flag — the Ray node's contract is that a miss ends exactly `maxDistance` from
   its origin, so the same `slant` that colours the beam also classifies it.

   The two alternatives were built and measured, and both lose (§V668). RECOLOURING the
   misses takes the green band's hard-flip rate from 0.4% to 11.3%, because the CLASS
   BOUNDARY is what oscillates — a recoloured miss class blinks worse than the hit class
   it replaces. FADING the beam out at max range paints a BLACK RIBBON across the lit
   terrain: a beam is opaque scene geometry, so dimming it toward zero does not hide it,
   it darkens whatever is behind it. Dropping costs nothing on the metric — the amber
   hard-flip rate is unchanged at 0.4% with the drop alone, and the 0.4% → 1.9% this

   rework does spend is attributable entirely to the BRIGHTNESS, measured separately. */
const LIDAR_SIGHT_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let slant = length(p.hitPosition - p.position);
  let near = clamp(1.0 - slant / ${LIDAR_RANGE}, 0.0, 1.0);
  q.tint = vec4f(1.0, 0.62 + 0.30 * near, 0.18, 1.0) * (0.35 + 0.90 * near);
  q.hitPosition = select(p.position, p.hitPosition, slant < ${LIDAR_RANGE} - 0.01);
  return q;
}`;

/* FOUR attributes, and the count is load-bearing: each declared attribute costs a
   read-and-write pair, and the WebGPU BASELINE grants 8 storage buffers per stage —
   five attrs is ten bindings and a refused pipeline on any device that reports no
   better (§V588). Two things are therefore DERIVED rather than carried:
   `hitDistance`, because a ray's own origin arrives as `position` from upstream and
   `length(hitPosition − position)` is the distance; and `hit`, because the Ray node's
   contract is that a MISS ends exactly `maxDistance` from the origin, so the same
   length says which happened. The slot that buys pays for `wake`.

   T658 — `wake` is the persistence, and it is why this reading stops blinking. A
   ray's verdict is BINARY and a ray sitting on the range frontier flips it every
   frame, which is a property of the instrument and not of the picture: smoothing
   belongs on the READING, temporally, not on the frame as a blur. `wake.xyz` is the
   lagged position (a miss's marker no longer TELEPORTS between the ground and the
   ray's end in the air — it slides) and `wake.w` is the lagged verdict, so the amber
   return fades to steel through a continuous mix instead of snapping. One vec4f, so

   both fit in the one slot the derivations freed. */
const LIDAR_MARK_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "hitPosition", type: "vec3f", default: [0, 0, 0] },
  { name: "wake", type: "vec4f", default: [0, 0, 0, 0] },
]);

/* Reading one and two, from one cast: a hit is a RETURN (hot, brighter the nearer —
   1 − d/range is the lidar intensity model at its crudest and reads instantly), a miss
   is OUT OF RANGE (the ray's end hangs in the air, faint steel — the node's own
   contract: "a miss carries the ray's end and the full distance").

   `p.position` is the ray's ORIGIN, read from upstream (T401: an attribute this schema
   shares with the incoming set reads the upstream pair, not this node's last frame),
   so the mast needs no constant here and `slant` is the true ray length. Everything
   else on `p` that is NOT upstream — `wake` — is this kernel's own previous frame,
   which is the entire persistence mechanism.

   The two rates are different on purpose. POSITION leads (0.22, a ~4-frame time
   constant): a marker crossing the frontier has to travel metres, and a slow slide
   reads as lag rather than as smoothing. The VERDICT trails (0.10, ~10 frames), and
   the colour mixes on `level²` rather than `level` so the transit passes through the

   dark end instead of through khaki — a fade-out, not a hue rotation. */
const LIDAR_MARK_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let slant = length(p.hitPosition - p.position);
  let landed = select(0.0, 1.0, slant < ${LIDAR_RANGE} - 0.01);
  let near = clamp(1.0 - slant / ${LIDAR_RANGE}, 0.0, 1.0);
  let pos = mix(p.wake.xyz, p.hitPosition, 0.22);
  let level = mix(p.wake.w, landed, 0.10);
  q.wake = vec4f(pos, level);
  q.position = pos;
  let ret = vec4f(1.0, 0.60 + 0.30 * near, 0.16, 1.0) * (0.5 + 1.6 * near);
  let lost = vec4f(0.16, 0.30, 0.52, 1.0) * 0.32;
  q.tint = mix(lost, ret, level * level);
  return q;
}`;

/* FOUR again (see mark1's comment). Even the first leg's `hit` flag goes: a miss
   carries the ray's FULL-RANGE end, so length(hitPosition − mast) says which leg this
   was without a flag — the verdict travels as geometry. A first-leg miss is PARKED at
   y = −80; its second cast from the parking depth hits instantly below the field, and

   mark2 recognises the park by the hit's own y. Two selects instead of two buffers. */
const LIDAR_RICOCHET_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "direction", type: "vec3f", default: [0, -1, 0] },
  { name: "hitPosition", type: "vec3f", default: [0, 0, 0] },
  { name: "hitNormal", type: "vec3f", default: [0, 1, 0] },
]);

/* The bounce: re-origin at the hit, lifted along the normal so the second march does
   not begin inside the ground it just found; reflect the aim about the surface. A

   first-leg miss parks (see the attribute comment above). */
const LIDAR_RICOCHET_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let slant = length(p.hitPosition - vec3f(0.0, ${LIDAR_MAST}, 0.0));
  let landed = slant < ${LIDAR_RANGE} - 0.01;
  q.position = select(vec3f(0.0, -80.0, 0.0), p.hitPosition + p.hitNormal * 0.03, landed);
  q.direction = normalize(reflect(p.direction, p.hitNormal) + vec3f(0.0, 0.0001, 0.0));
  return q;
}`;

const LIDAR_MARK2_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
  { name: "hitPosition", type: "vec3f", default: [0, 0, 0] },
  { name: "wake", type: "vec4f", default: [0, 0, 0, 0] },
]);

/* Reading three: an echo counts only when BOTH legs landed — and since T642 the
   SELECTION lives on the DRAW, not in this kernel. This kernel only places, colours,
   and (T658) REMEMBERS.

   The trail and the smoothing turned out to be ONE mechanism, which is why there is
   no second one. An echo's qualification is binary and intermittent, so the group
   predicate used to pop the marker in and out of existence entirely — no colour ramp
   can soften a point that is not drawn. `wake` holds the LAST QUALIFYING POSITION and
   a level that rises instantly and decays 0.94 per frame, the predicate now reads
   that level, and the same state therefore delivers both asks: nothing blinks, and a
   sweep leaves a fading wake of where it just found something. Instant rise is
   deliberate — §V509's lesson that a one-pole smoother sized for an envelope
   annihilates the transient it is fed, so the transient gets its own path.

   T672 — and the state was right while the RE-READING was wrong. Round two adopted a
   new hit on every qualifying frame, so a marker whose ray re-qualified metres away
   TELEPORTED WHILE LIT — and the second leg's landing point is a chaotic function of
   azimuth, so it re-qualifies metres away constantly (§V638). The gate `p.wake.w <
   0.06` moves the relocation to where no eye can see it: the marker lights at a place,
   HOLDS still, fades, and only then re-arms. A display's phosphor. Green-band
   frame-to-frame energy 873,292 → 53,657 for that one condition; every tail remedy was
   measured first and every one failed (position lag made it WORSE at 2,386,000, a
   lagged rise moved 4.5%, decay 0.90 → 0.98 moved the hard-flip rate 39.1% → 34.7%),
   because the churn was BIRTHS and not the tail.

   `hit` is derived rather than carried, buying the slot (see mark1's note): the Ray
   node's contract is that a MISS ends exactly `maxDistance` from its origin, and this
   ray's origin arrives as `position` from upstream. A parked first-leg miss re-casts

   from y = −80 and hits instantly below the field, so its hit y still betrays it. */
const LIDAR_MARK2_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let leg2 = length(p.hitPosition - p.position);
  let landed = leg2 < ${LIDAR_RANGE} - 0.02 && p.hitPosition.y > -10.0;
  /* T672 — SAMPLE AND HOLD. The gate is \`p.wake.w < 0.06\`, and it is the whole fix: a
     marker takes a new reading only while it is already DARK. Delete it and the echoes
     scintillate again while every STILL frame still looks right (§V638). */
  let take = landed && p.wake.w < 0.06;
  let pos = select(p.wake.xyz, p.hitPosition, take);
  let level = select(p.wake.w * 0.94, 1.0, take);
  q.wake = vec4f(pos, level);
  q.position = pos;
  /* T711 — the BOUNCE LEG's far end, and the only place it can live. \`p.position\` here
     is the FIRST hit, the primary ray's landing, and this kernel's own \`hitPosition\`
     slot is a LEAF: nothing downstream reads it, because the only consumer of mark2a is
     the draw. Four attributes is the whole budget (§V588), so the segment gets published
     through a slot that already exists rather than through a fifth pair. The far end is
     LIVE while the near end is HELD, which is the right way round: the first hit is a
     SMOOTH function of azimuth (T681 measured the primary ring as a clean colour wheel),
     so the beam's base creeps while its tip stays put, and nothing pops. */
  q.hitPosition = p.position;
  /* round-trip attenuation, crudely: mast → surface → echo, against 1.8× range. The
     floor is LOW (0.15) so the far scatter stays a scatter and the near returns are
     the ones that read — depth, rather than confetti at one brightness. */
  let near = clamp(1.0 - length(pos - vec3f(0.0, ${LIDAR_MAST}, 0.0)) / (${LIDAR_RANGE} * 1.8), 0.0, 1.0);
  q.tint = vec4f(0.30, 0.95, 0.85, 1.0) * (0.15 + 1.35 * near) * level;
  return q;
}`;

const LIDAR_POOL_ATTRIBUTES = JSON.stringify([
  { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
  { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
]);

/* T672 — THE SAME AGREEMENT, STATED A SECOND TIME. `unfold1` parks the sample sheet at
   clip (X/extent, −Z/extent); this parks each RETURN at exactly the same place, and that
   is not a coincidence to be maintained by luck. The terrain surface samples its albedo
   map by GRID uv, grid v runs along world Z, and `renderPoints` draws at clip xy where
   +1 is the TOP of the picture and therefore texel row 0 and therefore v = 0. Compose
   those three and the minus sign comes back out — the same minus, for the same reason.
   Get it wrong and the pool lights the terrain's mirror image, which is plausible at a

   glance and wrong everywhere. */
const LIDAR_POOL_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  q.position = vec3f(p.position.x / ${LIDAR_EXTENT}, -p.position.z / ${LIDAR_EXTENT}, 0.0);
  return q;
}`;

export const lidarDocument = document(
  "e34-lidar",
  "E34 Lidar",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 34 }),
  graph(
    [
      /* ---- the terrain, once: one texture, two readers ------------------------ */
      node("relief", "noise", [-2880, -440], {
        type: "perlin4d", seed: 11, period: 0.40 * 3.2 / LIDAR_EXTENT, harmon: 4, spread: 2, gain: 0.58,
        rough: 0.5, exp: 1, amp: 1, offset: 0, mono: true, aspectcorrect: false,
        t4d: 0.37, s4d: 1, speed: 0, /* static ground; T535's slice, off the lattice plane */
      }, { label: "relief1", resolution: { mode: "fixed", width: 512, height: 512 } }),
      /* E27's lesson, reapplied: four perlin harmonics sum to a SLIVER (measured here:
         r in 0.63..0.80), and a terrain built on a sliver is a plain with a rumor of
         hills. The stretch to full range happens ONCE, on the texture BOTH readers
         share — the mesh and the rays march the same carved field by construction. */
      node("carve", "level", [-2560, -880], {
        /* the window is LINEAR (the ray and the mesh both read this target raw): the
           harmonic sum lands in ~0.36..0.61 linear, measured — an early read of these
           numbers through the OUTPUT node was display-encoded and off by a transfer
           curve, which is exactly the trap §V56 keeps warning about. */
        blacklevel: 0.36, whitelevel: 0.62, contrast: 1, brightness: 1, gamma1: 1, opacity: 1,
      }, { label: "carve1", resolution: { mode: "fixed", width: 512, height: 512 } }),

      /* ---- the terrain MESH: unfold → sample → raise -------------------------- */
      node("sheet", "pointGrid", [-2560, -440], { cols: LIDAR_GRID, rows: LIDAR_GRID, count: LIDAR_SHEET_COUNT }, { label: "sheet1" }),
      node("unfold", "pointKernel", [-2240, -440], {
        capacity: LIDAR_SHEET_COUNT, attributes: LIDAR_SHEET_ATTRIBUTES, kernel: LIDAR_UNFOLD_KERNEL,
      }, { label: "unfold1" }),
      node("probe", "textureToAttribute", [-1920, -440], {}, { label: "probe1" }),
      node("raise", "pointKernel", [-1600, -440], {
        capacity: LIDAR_SHEET_COUNT, attributes: LIDAR_RAISE_ATTRIBUTES, kernel: LIDAR_RAISE_KERNEL,
      }, { label: "raise1" }),
      node("basalt", "materialPhong", [-1600, -920], {
        color: [0.14, 0.15, 0.18, 1], specular: [0.30, 0.33, 0.40, 1], shininess: 26, roughness: 0.82,
      }, { label: "basalt1" }),
      node("ground", "geometry", [-1280, -440], {
        mode: "surface", material: "basalt1", tint: [1, 1, 1, 1],
      }, { label: "ground1" }),

      /* ---- the instrument: aim → cast → readings ------------------------------ */
      node("tiltwave", "lfo", [-2880, 40], {
        shape: "sine", frequency: 0.045, amplitude: 0.5, offset: 0.5, phase: 0,
      }, { label: "tiltwave1" }),
      node("fan", "pointLine", [-2560, 40], { count: 240 }, { label: "fan1" }),
      node("aim", "pointKernel", [-2240, 40], {
        capacity: 240, attributes: LIDAR_AIM_ATTRIBUTES, kernel: LIDAR_AIM_KERNEL,
      }, { label: "aim1", parameters: { value1: drivenSlot("tiltwave1", 0.5) } }),
      /* RANGE 3.4 against a 2.7 m mast and 41°..73° tilts: the steep ring's slant
         (~2.8) is inside range, the shallow ring's (~4.1) is not — the breathing ring
         CROSSES the range boundary, and ridges (shorter slant) come into range before
         valleys, so the relief reads in the hit/miss frontier itself. */
      node("cast", "pointRay", [-1920, 40], {
        steps: 64, maxDistance: LIDAR_RANGE, direction: [0, -1, 0],
        extent: LIDAR_EXTENT, heightScale: LIDAR_HEIGHT_SCALE, heightOffset: LIDAR_HEIGHT_OFFSET,
      }, { label: "cast1" }),
      node("mark", "pointKernel", [-1600, 40], {
        capacity: 240, attributes: LIDAR_MARK_ATTRIBUTES, kernel: LIDAR_MARK_KERNEL,
      }, { label: "mark1" }),
      node("spark", "materialUnlit", [-1600, 520], { color: [1, 1, 1, 1] }, { label: "spark1" }),
      node("impacts", "geometry", [-1280, 40], {
        mode: "instances", shape: "octahedron", scale: 0.052, material: "spark1",
      }, {
        label: "impacts1",
        /* T478: the kernel's per-point verdict IS the colour — tint in MAP mode. */
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),

      /* ---- the beams: the cause, drawn (T672/T680), coloured by it (T711) ------- */
      node("sight", "pointKernel", [-1920, 900], {
        capacity: 240, attributes: LIDAR_SIGHT_ATTRIBUTES, kernel: LIDAR_SIGHT_KERNEL,
      }, { label: "sight1" }),
      /* WHITE, and UNLIT on purpose: a beam is scattered light in the air, not a surface —
         and an unlit primitive takes no part in shadowing either (§V617). T711 moved the
         colour off this material and onto the POINT, because one flat colour for every
         beam is exactly what stopped the beams reading as the cause of the marks; the
         material is now the identity element so the tint IS the colour. */
      node("haze", "materialUnlit", [-1600, 900], { color: [1, 1, 1, 1] }, { label: "haze1" }),
      node("rays", "geometry", [-1280, 900], {
        /* `beam` spans each ray's `position` — the mast — to its `hitPosition`, which
           `cast1` ALREADY carries, so 24 beams cost 24 instances of six vertices and NOT
           ONE extra ray march. The sampled-billboard fake was built and measured first:
           983,000 texture reads a frame against this file's 15,400, for a serrated ribbon
           that cannot taper (T680). */
        /* T711: the far end is now `sight1`'s, not `cast1`'s — same attribute, one kernel
           later, so a ray with no return arrives with both ends on the same point and
           collapses to zero area instead of drawing a hit that did not happen. */
        mode: "beam", endpoint: "hitPosition", scale: 0.013,
        /* TAPER 0, and it is load-bearing, not tidiness: every beam here shares ONE
           origin, so at any taper above ~0 they fuse into a solid wedge at the mast
           whatever their number. Pinching the near end to a point is both the cure and
           what a divergent beam actually does. */
        taper: 0,
        material: "haze1",
        /* §V471's idiom, on the DRAW: every ray is cast, every tenth is drawn. Empty this
           predicate and 240 beams fuse into an opaque cone that hides the terrain — which
           is why the subset is measured rather than chosen. */
        group: "p.spoke > 0.5",
      }, {
        label: "rays1",
        /* T478 again, on a BEAM this time: the kernel's per-ray colour IS the beam's. */
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),

      /* ---- the ground, LIT BY ITS OWN RETURNS (T672, §V644) -------------------- */
      node("pool", "pointKernel", [-1280, 300], {
        capacity: 240, attributes: LIDAR_POOL_ATTRIBUTES, kernel: LIDAR_POOL_KERNEL,
      }, { label: "pool1" }),
      node("poolmap", "renderPoints", [-960, 300], {
        count: 240, sizePixels: 22, blend: "additive", accumulate: false,
        /* only RETURNS light the ground — the steel out-of-range markers hang in the air
           and have nothing under them to light. */
        group: "p.tint.r > 0.3",
      }, {
        label: "poolmap1",
        resolution: { mode: "fixed", width: LIDAR_POOL_RES, height: LIDAR_POOL_RES },
        parameters: {
          color: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),
      node("poolsoft", "blur", [-640, 300], {
        size: 26, filter: "gaussian", extend: "hold",
      }, { label: "poolsoft1", resolution: { mode: "fixed", width: LIDAR_POOL_RES, height: LIDAR_POOL_RES } }),
      /* §V644 — THE IDENTITY ELEMENT, and the one thing in this chain that looks like a
         lighting bug when it is missing. An albedo map MULTIPLIES, so an additive
         contribution through it must read 1.0 where nothing is lit. Black point −0.1 with
         white at 0 is how a Level says ADD ONE: out = 10·in + 1. Drop the offset and the
         naive map (unlit texels = 0) multiplies the ground to BLACK everywhere the pool
         is not — which reads as "the light broke the terrain" and is really the identity
         element going missing. */
      node("poolbase", "level", [-320, 300], {
        blacklevel: -0.1, whitelevel: 0, contrast: 1, brightness: 1, gamma1: 1, opacity: 1,
      }, { label: "poolbase1", resolution: { mode: "fixed", width: LIDAR_POOL_RES, height: LIDAR_POOL_RES } }),

      /* ---- the bounce: reflection, literally ---------------------------------- */
      node("ricochet", "pointKernel", [-1920, 520], {
        capacity: 240, attributes: LIDAR_RICOCHET_ATTRIBUTES, kernel: LIDAR_RICOCHET_KERNEL,
      }, { label: "ricochet1" }),
      node("rebound", "pointRay", [-1280, 520], {
        steps: 48, maxDistance: LIDAR_RANGE, direction: [0, -1, 0],
        extent: LIDAR_EXTENT, heightScale: LIDAR_HEIGHT_SCALE, heightOffset: LIDAR_HEIGHT_OFFSET,
      }, { label: "rebound1" }),
      node("mark2", "pointKernel", [-960, 520], {
        capacity: 240, attributes: LIDAR_MARK2_ATTRIBUTES, kernel: LIDAR_MARK2_KERNEL,
      }, { label: "mark2a" }),
      node("echoes", "geometry", [-640, 520], {
        mode: "instances", shape: "octahedron", scale: 0.030, material: "spark1",
        /* T642: the reading IS a selection — §V471's idiom, in the lit path. T658: and
           it selects on the PERSISTENT level rather than on the raw verdict, so an echo
           leaves a fading wake instead of vanishing between one frame and the next. */
        group: "p.wake.w > 0.03",
      }, {
        label: "echoes1",
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),

      /* ---- the bounce leg, DRAWN (T711) --------------------------------------- */
      /* THIS WAS REJECTED ONCE, BY MEASUREMENT, AND THE REJECTION WAS RIGHT FOR ITS TREE.
         T681 drew this segment off `rebound1`'s RAW verdict and it cost green energy
         873k → 1,399k, "because the segments pop in and out with the raw verdict and
         have no persistence to inherit". §V638's sample-and-hold then landed — and a
         beam hung on mark2a inherits exactly the persistence the rejected version
         lacked. Re-measured on THIS tree, same ten rays, same width, same colour, camera
         frozen, 15 frame-pairs, the ONLY variable being where the segment reads from:

             no bounce beam        green    663,533 on   171,680 px   hard-flip 0.4%
             bounce, HELD          green  4,961,526 on   393,877 px   hard-flip 2.2%
             bounce, RAW verdict   green 32,123,665 on 1,490,859 px   hard-flip 7.1%

         The hold is worth 6.5× the green energy and 3.2× the churn, and 2.2% sits under
         the amber band T681 itself judged against. A conclusion measured on one tree is
         not evidence about another one. */
      node("mist", "materialUnlit", [-960, 900], { color: [0.85, 0.85, 0.85, 1] }, { label: "mist1" }),
      node("bounce", "geometry", [-640, 900], {
        /* `position` is the HELD echo point and `hitPosition` the first hit mark2a
           publishes, so the segment is the echo's own cause. Taper 1: unlike the
           primaries these share no origin, so there is no apex to pinch. */
        mode: "beam", endpoint: "hitPosition", scale: 0.006, taper: 1, material: "mist1",
        /* Both halves matter. `wake.w` is echoes1's OWN predicate, so a bounce beam
           lights, holds, fades and re-arms with the box it belongs to — that is where the
           persistence comes from. `spoke` is the same every-tenth subset the primaries
           use, and it reaches this draw for free: an attribute a pointKernel does not
           DECLARE still flows through the pointset, so mark2a never had to spend a slot
           on it. Drop it and all 240 legs draw: the basin becomes green spaghetti, green
           energy ×6.5 again, and it is T681's picture exactly. */
        group: "p.wake.w > 0.03 && p.spoke > 0.5",
      }, {
        label: "bounce1",
        /* mark2a's tint, unchanged — so the leg and the echo it ends on are ONE colour,
           the same agreement the primaries and their boxes now keep. */
        parameters: {
          tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
        },
      }),

      /* ---- night: key, sky, camera -------------------------------------------- */
      node("moon", "light", [-960, -920], {
        kind: "directional", direction: [0.35, -0.70, -0.42], color: [0.72, 0.80, 1, 1],
        /* 7.0, not 4.5: §V426 says nothing knows your scene's bounds, and the plate
           grew. A volume that no longer spans the terrain leaves its corners
           UNSHADOWED — "outside the volume means the light simply shines" — which is a
           discontinuity across the frame that reads as a rendering fault. */
        intensity: 0.50, shadows: true, shadowExtent: 7.0,
      }, { label: "moon1" }),
      /* T658, the owner's "more interesting lights": the instrument LIGHTS ITS OWN
         GROUND. A point light at the mast, warm against the moon's cool key, with the
         1/(1+d²) falloff putting a pool of amber under the emitter and nothing at the
         range boundary — so the picture says where the thing doing the measuring is,
         which the scene never did before. It does not cast: a point caster needs six
         faces and the render refuses it by name, which is the right refusal. */
      node("lamp", "light", [-960, -1160], {
        kind: "point", position: [0, LIDAR_MAST, 0], color: [1.0, 0.70, 0.42, 1],
        /* 0.8, and desaturated. At 2.0 the pool became a flat orange blob whose edge
           was really the moon's shadow boundary — a second light is meant to say where
           the instrument is, not to relight the scene. */
        intensity: 0.8, shadows: false,
      }, { label: "lamp1" }),
      node("skyband", "ramp", [-960, -1400], {
        /* T659 retune, now that this map is DRAWN and not only taken. v = acos(y)/π,
           so position 0 is the zenith and 1 the nadir; the camera's 46° frustum, tilted
           34° down, sees v ≈ 0.56 … 0.81 and NOTHING above the horizon. Every stop that
           matters therefore sits in that band: the glow at 0.66 is the light behind the
           ridges, and the warm smudge at 0.78 is the horizon the returns answer to.
           The old ramp put its brightest stop at 0.78 by luck; this one puts it there
           on purpose, and the two stops outside the band still shape the irradiance. */
        type: "vertical", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0.0, color: [0.008, 0.010, 0.028, 1] },
          { position: 0.52, color: [0.026, 0.040, 0.098, 1] },
          { position: 0.66, color: [0.070, 0.112, 0.215, 1] },
          { position: 0.78, color: [0.150, 0.130, 0.150, 1] },
          { position: 1.0, color: [0.020, 0.018, 0.030, 1] },
        ],
      }, { label: "skyband1", definitionVersion: 2, resolution: { mode: "fixed", width: 256, height: 128 } }),
      /* THE ORBIT RADIUS IS HERE, in the two amplitudes — see LIDAR_ORBIT. */
      node("orbx", "lfo", [-2880, 520], {
        shape: "sine", frequency: 0.019, amplitude: LIDAR_ORBIT, offset: 0, phase: 0.25,
      }, { label: "orbx1" }),
      node("orbz", "lfo", [-2880, 1000], {
        shape: "sine", frequency: 0.019, amplitude: LIDAR_ORBIT, offset: 0, phase: 0,
      }, { label: "orbz1" }),
      node("eye", "camera", [-640, -440], {
        /* T672 — `lookAt` IS live, unlike eye.x and eye.z, and 1.60 rather than 0.55 is
           what puts the beams' convergence at the mast just above the frame instead of
           off the top of it. Raising it tilts the camera UP, which is exactly the move
           that could re-expose the plate rim T658 spent its pass removing, so it was
           checked at all eight of the orbit's worst angles — edges at frames 0/790/1579/
           2369, corners at 395/1184/1974/2763 — and the near rim stays behind the camera. */
        eye: [LIDAR_ORBIT, 3.1, 0], lookAt: [0, 1.60, 0], fov: 46, near: 0.1, far: 40, ortho: false,
      }, {
        label: "eye1",
        parameters: {
          "eye.x": drivenSlot("orbx1", LIDAR_ORBIT),
          "eye.z": drivenSlot("orbz1", 0),
        },
      }),
      node("shot", "render", [-320, -140], {
        scenes: "ground1 impacts1 echoes1 rays1 bounce1",
        camera: "eye1",
        lights: "moon1 lamp1",
        ambientColor: [0.50, 0.60, 0.92, 1],
        /* 0.11, down from 0.16: the sky is now a real diffuse source AND a visible
           backdrop, so the flat ambient floor that used to stand in for it can step
           back — the fill arrives from a direction now, not from everywhere. */
        ambientIntensity: 0.11,
        background: [0.006, 0.008, 0.016, 1],
        /* The owner's "colour reflection a bit increased" — a BIT: 1.15, not the 1.8
           the first pass tried, which lifted the terrain 2.3× and turned a night into
           an overcast dusk. */
        environmentIntensity: 1.15,
        /* T659: and the sky band is now DRAWN as well as taken. It was already the only
           thing filling the valleys; the frame behind the ridges was the `background`
           colour and nothing else, which is why the night read as flat black however the
           ramp was tuned. This is the opt-in — the switch is off everywhere else. */
        showEnvironment: true,
      }, { label: "shot1" }),

      /* ---- the returns glow --------------------------------------------------- */
      /* The glow's window. 0.95 rather than 1.15 for the white point — the owner's
         "the glow can be a bit increased", applied where the glow is actually made
         rather than by turning something up downstream. */
      node("cut", "level", [0, -140], {
        blacklevel: 0.42, whitelevel: 0.95, gamma1: 1, contrast: 1, brightness: 1, opacity: 1,
      }, { label: "cut1" }),
      /* The clamp is LOAD-BEARING, not tidiness (E33's lesson, relearned the hard way):
         Level is a SIGNED pipeline — below blacklevel it emits NEGATIVES, the blur
         spreads them across the whole frame, and add then SUBTRACTS the halo from the
         picture. On this night scene almost everything sits below the threshold, so the
         un-clamped chain blacked out the entire film. */
      node("clip", "limit", [320, -140], { mode: "clamp", low: 0, high: 6, steps: 4 }, { label: "clip1" }),
      node("halo", "blur", [640, -140], { size: 28, filter: "gaussian", extend: "hold" }, { label: "halo1" }),

      /* ---- the trail: a LUMINANCE-thresholded feedback (T711) ------------------ */
      /* THE TUNING QUESTION IS WHERE THIS SITS RELATIVE TO THE POOL-LIT GROUND, and it
         is answered with a number rather than an eye. Rendered with the marks, beams and
         echoes taken out of the Scenes list, the terrain — moonlit AND lit by its own
         impact pool — tops out at linear luma 0.102. Threshold 0.16 with softness 0.10 is
         a smoothstep across 0.11 … 0.21, so the transition's FOOT is above the brightest
         ground there is: the ground contributes EXACTLY NOTHING and everything the eye
         reads as a glow trails. Lower it under 0.10 and the whole lit hillside smears;
         raise it past 0.40 and only the 0.7% of the frame that is core survives. */
      node("hot", "threshold", [0, 340], {
        threshold: 0.16, softness: 0.10, channel: "luminance", compare: "greater",
      }, { label: "hot1" }),
      /* Threshold emits a MASK in rgb and alpha alike, so the colour has to be put back:
         multiply keeps what passed and discards what did not. `opacity` scales the FRONT
         layer, which makes it the loop's INJECTION GAIN and the only place it lives. */
      node("stain", "multiply", [320, 340], { opacity: 0.05 }, { label: "stain1" }),
      node("smear", "add", [640, 340], {}, { label: "smear1" }),
      /* §V631 — BOUNDED BY ARITHMETIC, not by hope: steady state is injection ÷ (1 −
         persistence), so 0.90 settles at 10× the injection and 0.05 × 10 = 0.5 of the
         source at a mark that holds still. Positive gain below 1: convergent, and no sign
         alternation (§V630's oscillator needs a NEGATIVE gain, which needs a Screen this
         path does not have). Measured rather than assumed, and not over a short window:
         `smear1`'s own alpha reads [0, 0.47] at frame 60 and [0, 0.50] at frame 800, and
         the sink's stays inside [0, 1]. What it buys, camera frozen: the amber band's
         hard-flip rate 2.9% → 0.5% at the steep end and 4.5% → 1.0% at the shallow one,
         with TOTAL energy down 1.6% — trails add frame-to-frame correlation, which is
         the point, and here they paid for themselves in energy as well. */
      node("trail", "feedback", [640, 560], {
        source: "smear1", persistence: 0.90, clearColor: [0, 0, 0, 0],
      }, { label: "trail1" }),
      node("glow", "add", [960, -140], {}, { label: "glow1" }),
      node("out", "output", [1280, -140], {}, { label: "out1" }),
    ],
    [
      edge("e-sheet-unfold", ["sheet", "out"], ["unfold", "in"]),
      edge("e-unfold-probe", ["unfold", "out"], ["probe", "points"]),
      edge("e-relief-carve", ["relief", "out"], ["carve", "input"]),
      edge("e-carve-probe", ["carve", "out"], ["probe", "texture"]),
      edge("e-probe-raise", ["probe", "out"], ["raise", "in"]),
      edge("e-raise-ground", ["raise", "out"], ["ground", "points"]),

      edge("e-fan-aim", ["fan", "out"], ["aim", "in"]),
      edge("e-aim-cast", ["aim", "out"], ["cast", "points"]),
      edge("e-carve-cast", ["carve", "out"], ["cast", "field"]),
      edge("e-cast-mark", ["cast", "out"], ["mark", "in"]),
      edge("e-mark-impacts", ["mark", "out"], ["impacts", "points"]),
      edge("e-cast-sight", ["cast", "out"], ["sight", "in"]),
      edge("e-sight-rays", ["sight", "out"], ["rays", "points"]),

      edge("e-mark-pool", ["mark", "out"], ["pool", "in"]),
      edge("e-pool-poolmap", ["pool", "out"], ["poolmap", "points"]),
      edge("e-poolmap-poolsoft", ["poolmap", "out"], ["poolsoft", "input"]),
      edge("e-poolsoft-poolbase", ["poolsoft", "out"], ["poolbase", "input"]),
      edge("e-poolbase-basalt", ["poolbase", "out"], ["basalt", "albedo"]),

      edge("e-cast-ricochet", ["cast", "out"], ["ricochet", "in"]),
      edge("e-ricochet-rebound", ["ricochet", "out"], ["rebound", "points"]),
      edge("e-carve-rebound", ["carve", "out"], ["rebound", "field"]),
      edge("e-rebound-mark2", ["rebound", "out"], ["mark2", "in"]),
      edge("e-mark2-echoes", ["mark2", "out"], ["echoes", "points"]),
      edge("e-mark2-bounce", ["mark2", "out"], ["bounce", "points"]),

      edge("e-skyband-shot", ["skyband", "out"], ["shot", "environment"]),
      edge("e-shot-cut", ["shot", "out"], ["cut", "input"]),
      edge("e-cut-clip", ["cut", "out"], ["clip", "input"]),
      edge("e-clip-halo", ["clip", "out"], ["halo", "input"]),
      edge("e-shot-hot", ["shot", "out"], ["hot", "input"]),
      edge("e-shot-stain", ["shot", "out"], ["stain", "in1"]),
      edge("e-hot-stain", ["hot", "out"], ["stain", "in2"], 0),
      edge("e-stain-smear", ["stain", "out"], ["smear", "in1"]),
      edge("e-trail-smear", ["trail", "out"], ["smear", "in2"], 0),
      edge("e-shot-glow", ["shot", "out"], ["glow", "in1"]),
      edge("e-halo-glow", ["halo", "out"], ["glow", "in2"], 0),
      edge("e-smear-glow", ["smear", "out"], ["glow", "in2"], 1),
      edge("e-glow-out", ["glow", "out"], ["out", "input"]),
    ],
  ),
);
