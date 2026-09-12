import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * E68 — SANCTUM: a buried alien temple, raymarched (T1283, direction C).
 *
 * The owner's brief was "triple AAA alien technology / temple visuals, with proper pbr
 * materials, reflections, specular, structured textures, lights, and camera moves, details
 * in scene driven by audio", and they chose the RAYMARCHED direction over the two rasterised
 * ones with the cost in front of them: the feasibility read priced this at 25–35 ms @720
 * against E13's 3.6 ms datum, and they accepted it as a second deliberate outlier beside
 * E67. The design target is 1280×720, set explicitly on the document rather than inherited,
 * so the piece and its claims agree about what it was built for.
 *
 * ## Why a marcher rather than the scene nodes
 *
 * The rasterised path would have given MSAA free, real shadow maps with PCF, and the GGX
 * material landed tonight (T1284/T1289). It cannot give VOLUMETRICS or a reflection that
 * sees geometry the camera cannot, and those are what "buried temple with powered inlay"
 * is made of. That trade is the row's, made once and stated here so nobody re-opens it by
 * accident: no MSAA (FXAA instead, T1276's component), no `materialPbr` (this shader owns
 * its shading), and a frame cost an order above the datum.
 *
 * ## The vocabulary is the picture (T1304c)
 *
 * The version before this one was floor, one repeated column, a flat vault and a far wall,
 * and the owner's reading of it was exact: *"the shapes too simple... a bunch of the
 * vertical stuff is also somewhat lame"*, and the floor *"feels like mud"*. Every one of
 * those is the same fact from a different side — FOUR SHAPES CANNOT DESCRIBE A BUILDING.
 * A hall is not a nave because it is long; it is a nave because it has plinths, courses,
 * capitals, spans, ribs, steps, and a ruin's worth of what used to be there.
 *
 * ⚑ AND THE ANSWER IS KINDS, NOT COUNT, which is the one finding this file is actually
 * built on. The colonnade is domain repetition, so thirty columns evaluate one distance
 * function: adding a THIRTY-FIRST column is free and adding a CAPITAL is one box. Every
 * shape below is a handful of instructions against a march that already pays for the ray.
 * The cost of the whole architectural vocabulary is smaller than the cost of the erosion
 * noise that weathers it.
 *
 * ## The erosion follows the structure, because that is the difference between age and dirt
 *
 * Banding the damage in height (below) stopped the stone reading as wax. It did not make it
 * read as STONE, and the reason is that a noise skin has no idea what it is sitting on. Real
 * decay follows what the mason did: it opens the BEDDING JOINTS between courses first, it
 * takes the corners of a plinth before it takes the middle of a face, and it leaves the
 * hard courses standing. So the courses are cut as real grooves at a real pitch, and the
 * noise rides on top of them rather than instead of them.
 *
 * ## Deterministic, and every "random" figure is an integer hash
 *
 * §V44/§V45: `frameU.absTime` is the only clock and every "random" figure is an integer
 * hash of a lattice cell, so the same seed is the same ruin on every device and every
 * replay. The hashes arrive through `// @use hash` (T1286) rather than being re-written
 * here — this is that row's first use outside its own test, and the reason it exists: the
 * lattice hashes were already in `common.wgsl.ts` and every new shader was copying them.
 */
export const SANCTUM_WGSL = `// @use hash
${SHARED_UNIFORMS_WGSL}
struct Params {
  dollySpeed: f32,    // @default 0.55  metres a second the eye travels down the nave, forever — the whole camera move
  eyeHeight: f32,     // @default 1.62  the eye above the floor, metres
  pitch: f32,         // @default -7  degrees the view tilts: negative looks slightly down the floor
  lens: f32,          // @default 1.7  focal length — long, so the colonnade stacks and compresses
  bay: f32,           // @default 4.4  metres between column centres down the nave
  aisle: f32,         // @default 3.6  metres from the nave's axis to a column's centre
  columnRadius: f32,  // @default 0.62  column radius at the base, metres
  columnFlare: f32,   // @default 0.22  how much wider the column grows toward the ceiling
  ceiling: f32,       // @default 7.2  metres to the vault
  plinthHeight: f32,  // @default 0.46  the square block a column stands on — the single shape that stops a column reading as a pipe pushed through the floor
  capitalDrop: f32,   // @default 0.95  metres below the vault where the capital starts
  spanDepth: f32,     // @default 0.3  half-height of the architrave that runs the length of each colonnade
  ribThickness: f32,  // @default 0.17  half-thickness of the vault ribs
  ribWidth: f32,      // @default 0.34  half-width of a rib along the nave
  ruin: f32,          // @default 0.22  share of bays that have FALLEN — column, capital and the span above it go together, because a ruin is a ruin all the way up
  breach: f32,        // @default 0.3  share of bays whose VAULT is broken open — the hole the daylight comes through, and the only light in the piece that arrives from above
  breachLight: f32,   // @default 1.7  how hard the daylight drives through a breach
  dayColor: vec4f,    // @default [1, 0.86, 0.62, 1]  the day outside: WARM, because it is the one light here that is not the building's own and the frame needs a temperature to be measured against
  courseHeight: f32,  // @default 0.54  metres between bedding joints: the mason's courses, and the thing erosion opens first
  courseDepth: f32,   // @default 0.03  how far a weathered bedding joint is eaten back, metres
  courseLay: f32,     // @default 0.018  how far courses sit proud of or recessed from each other, metres — the mason's own error, and the thing that makes a column's silhouette a stack of blocks rather than a line
  courseBlocks: f32,  // @default 7  blocks around a shaft's circumference, staggered half a block per course
  slabSize: f32,      // @default 1.7  floor slabs, metres across
  slabJoint: f32,     // @default 0.055  width of the joint between slabs, in slab fractions
  slabDepth: f32,     // @default 0.026  how deep the joints are cut, metres
  slabSettle: f32,    // @default 0.022  how far slabs have settled unevenly, metres — a floor that is perfectly flat is a floor nobody walked on
  erosion: f32,       // @default 0.115  how deeply time has eaten the stone, metres of displacement
  erosionScale: f32,  // @default 4.6  size of the bites — higher is finer damage
  erosionBands: f32,  // @default 0.62  how much the damage varies in HEIGHT bands rather than eating evenly: 0 is uniform decay, 1 is courses eaten and courses intact
  inlayRows: f32,     // @default 1.15  metres between the rings that cross the veins
  inlayVeins: f32,    // @default 9  conduits spaced around a column's circumference
  inlayRings: f32,    // @default 0.34  share of ring heights that carry a member
  inlayDepth: f32,    // @default 0.035  how deep the channels are cut, metres
  inlayWidth: f32,    // @default 0.16  the lit share of a vein's spacing, BEFORE the run-length variation below widens and narrows it
  inlayRun: f32,      // @default 0.8  how often a conduit changes along its run, cycles a metre — a conduit that never changes is tape
  inlayVary: f32,     // @default 0.3  how far a conduit's brightness DIPS along its run, 0 is the uniform strip this used to be
  inlayBreak: f32,    // @default 0.3  share of a conduit's run that is dark: interruptions, so a line reads as a thing that can fail
  inlayNode: f32,     // @default 0.9  extra light POOLED where a conduit crosses a ring — junctions are where a network shows it is a network
  inlayColor: vec4f,  // @default [0.16, 1, 0.82, 1]  the powered inlay — NOT on the blackbody curve, because anything that burns is human
  inlayEmission: f32, // @default 0.85  how hard the channels burn
  inlaySpill: f32,    // @default 4.2  how hard the channels light the stone around them — this is the hall's PRIMARY light, not a decoration on it
  inlayDensity: f32,  // @default 0.4  share of veins that are live — a dead conduit is still a channel in the stone
  stoneColor: vec4f,  // @default [0.29, 0.27, 0.25, 1]  the stone under the key
  keyColor: vec4f,    // @default [0.52, 0.62, 0.78, 1]  the cold light from the doorway
  keyIntensity: f32,  // @default 1.35  how hard that light drives
  doorWidth: f32,     // @default 1.15  half-width of the doorway — and its head is an ARCH, not the flat rectangle that read as the least interesting thing in frame
  ambient: f32,       // @default 0.16  fill, so a wall facing away is not a silhouette — warmed toward the inlay, because in a buried hall the only thing bouncing IS the inlay
  fog: f32,           // @default 0.055  depth haze — the aerial perspective, and the cost lever
  fogColor: vec4f,    // @default [0.045, 0.05, 0.062, 1]  what distance converges to
  warmColor: vec4f,   // @default [1, 0.46, 0.2, 1]  the counter-light: the ONE warm thing, so the frame has two temperatures rather than one
  warmIntensity: f32, // @default 0.42  how hard the counter-light drives
  lift: f32,          // @default 0.012  raises the floor of the tone curve — the shipped frame had 81% of its pixels in the bottom fifth
  contrast: f32,      // @default 0.82  below 1 OPENS the shadows about the pivot, which is what a crushed frame needs — above 1 would crush it further
  hueTurn: f32,       // @default 42  SECONDS for the conduits to travel one lap of their hue arc — a period a viewer inside one sitting actually sees
  hueArc: f32,        // @default 0.17  how far round the wheel they travel, 0..1 — an arc, not a rainbow
  warmArc: f32,       // @default 0.24  how far the COUNTER-light travels, and it travels the OTHER WAY: two hues in opposition rather than one family drifting
  keyBreath: f32,     // @default 0.34  how much the far light varies, 0 is the constant it used to be
  keyPeriod: f32,     // @default 15  SECONDS of the far light's slowest swell — slow on purpose, see the docblock
  saturation: f32,    // @default 1.35  its own knob, because a tone curve that moves chroma is a tone curve with a bug
  pivot: f32,         // @default 0.22  the tone the contrast rotates around, in linear light
  exposure: f32,      // @default 1.35  master gain before the display transform
  dust: f32,          // @default 0.032  how much dust hangs in the hall — this is what makes the light VISIBLE rather than only its landing place
  dustSteps: f32,     // @default 22  volumetric samples along the ray, and the stage's whole cost
  dustFloor: f32,     // @default 2.6  metres over which the dust thins with height: it settles
  shaft: f32,         // @default 0.55  strength of the beam through the doorway, the one light that comes from outside
  polish: f32,        // @default 0.55  how much of the floor is still polished enough to reflect — 0 turns the second march off entirely
  reflectSteps: f32,  // @default 34  march iterations for the REFLECTED ray: a fraction of the primary's, because a reflection may be approximate and a silhouette may not
  reflectFade: f32,   // @default 12  metres over which the reflection fades with distance — near the eye it is a mirror, far away it is a sheen
  steps: f32,         // @default 96  march iterations — the frame budget, stated as a number
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

const MAX_DISTANCE: f32 = 70.0;
const SURFACE: f32 = 0.0025;
/* The far wall's plane. The doorway is cut out of it and the light comes through. */
const WALL_Z: f32 = 46.0;
/* One seed for the stone, so the same erosion replays everywhere (§V45). */
const STONE_SEED: u32 = 68u;
/* A second seed, so re-cutting the glyphs cannot move the stone under them. */
const GLYPH_SEED: u32 = 690u;
/* A third seed for the volumetric dither, so re-jittering cannot move the glyphs. */
const DUST_SEED: u32 = 6802u;
/* A fourth for the ruin, so changing WHICH bays fell cannot move the erosion on the ones
   still standing. A shared seed makes two unrelated decisions one decision. */
const RUIN_SEED: u32 = 6841u;

/* Value noise on the integer lattice — the hashes come from the shared 'hash' module, so
   this shader declares none of its own (T1286). */
fn valueNoise(p: vec3f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  let c = vec3i(i);
  let n000 = unitFloat(hash3i(c + vec3i(0, 0, 0), STONE_SEED));
  let n100 = unitFloat(hash3i(c + vec3i(1, 0, 0), STONE_SEED));
  let n010 = unitFloat(hash3i(c + vec3i(0, 1, 0), STONE_SEED));
  let n110 = unitFloat(hash3i(c + vec3i(1, 1, 0), STONE_SEED));
  let n001 = unitFloat(hash3i(c + vec3i(0, 0, 1), STONE_SEED));
  let n101 = unitFloat(hash3i(c + vec3i(1, 0, 1), STONE_SEED));
  let n011 = unitFloat(hash3i(c + vec3i(0, 1, 1), STONE_SEED));
  let n111 = unitFloat(hash3i(c + vec3i(1, 1, 1), STONE_SEED));
  let x00 = mix(n000, n100, u.x);
  let x10 = mix(n010, n110, u.x);
  let x01 = mix(n001, n101, u.x);
  let x11 = mix(n011, n111, u.x);
  return mix(mix(x00, x10, u.y), mix(x01, x11, u.y), u.z) * 2.0 - 1.0;
}

/**
 * A ONE-DIMENSIONAL value noise along a run, keyed on which conduit and which bay.
 *
 * TWO HASHES, where 'valueNoise' is eight. That difference is the whole reason this exists:
 * it runs inside 'inlayAt', 'inlayAt' runs inside the distance function, and the distance
 * function runs at every step of every ray and six more times per normal. A conduit varies
 * along ONE axis, so paying for a three-dimensional lattice to vary it is paying for two
 * dimensions nobody sees.
 */
fn runNoise(key: vec2i, y: f32, scale: f32) -> f32 {
  let s = y * max(scale, 0.01);
  let i = i32(floor(s));
  let f = fract(s);
  let u = f * f * (3.0 - 2.0 * f);
  let a = unitFloat(hash3i(vec3i(key.x, key.y, i), GLYPH_SEED));
  let b = unitFloat(hash3i(vec3i(key.x, key.y, i + 1), GLYPH_SEED));
  return mix(a, b, u);
}

/* Two octaves, not five: the erosion is a PROFILE on a surface the march has to find, and
   every octave is paid at every step of every ray. The fine damage comes from the second
   octave's scale rather than from a third one. */
fn erosionAt(p: vec3f) -> f32 {
  let s = params.erosionScale;
  /* ⚑ THE FINE OCTAVE IS A THIRD OF WHAT IT WAS (T1304d), and the owner's reading of the
     old weight is the reason: the stone looked "noisy and strange" rather than worn. The
     failure is a scale mismatch. At the shipped erosionScale the second octave's features
     were a few centimetres across — SMALLER THAN THE CHISEL MARKS A MASON LEAVES and
     smaller than the pixel footprint at any distance, so it did not read as damage at all.
     It read as CRUST: a per-pixel crawl over the surface that the normal picks up as
     high-frequency shading noise, which is the visual signature of dirt rather than age.
     Weathering works at the scale of the BLOCK — a corner spalls, a face hollows, a course
     crumbles — and the shapes that carry that are the low octave and the bedding joints.
     The fine octave's job is only to stop the low one looking poured, so it needs to be
     present and not prominent. */
  let bite = (valueNoise(p * s) * 0.68) + (valueNoise(p * s * 2.7) * 0.11);
  /* ⚑ THE DAMAGE IS BANDED IN HEIGHT, and that is what separates stone from wax. An even
     displacement subtracted from a cylinder reads as something POURED — the eye recognises
     a melted candle — because real decay does not attack a column uniformly: it eats the
     soft courses and leaves the hard ones, so a weathered pillar is chewed in bands with
     intact stone between them. One extra noise on 'p.y' alone buys that, and it costs one
     lookup rather than an octave. */
  let course = valueNoise(vec3f(0.0, p.y * 1.7, 0.0)) * 0.5 + 0.5;
  let band = mix(1.0, smoothstep(0.18, 0.72, course), clamp(params.erosionBands, 0.0, 1.0));
  return bite * band;
}

/**
 * THE BEDDING JOINTS — and this is the difference between AGE and DIRT.
 *
 * The noise above weathers the stone and the banding varies the weathering, and after both
 * of them the columns still read as smooth cylinders wearing a bumpy skin. The reason is
 * that noise does not know what it is sitting on. Real decay is not applied TO a structure,
 * it FOLLOWS one: water sits in the horizontal joint between two courses, and that joint is
 * the first thing to open. A weathered wall is a stack of blocks with the lines between them
 * eaten back, and the eye reads that as centuries in a way that no amount of bump does.
 *
 * One 'fract' at the mason's course pitch, cut as a real groove in the distance function so
 * it breaks the silhouette. It is the cheapest shape in this file and it is doing more for
 * "eroded stone" than the two octaves of noise above it.
 */
fn beddingAt(p: vec3f) -> f32 {
  let h = max(params.courseHeight, 0.08);
  let courseIndex = floor(p.y / h);
  let line = abs(fract(p.y / h) - 0.5) * 2.0;
  let bed = smoothstep(0.80, 1.0, line) * params.courseDepth;

  /* ⚑ AND THE COURSES ARE LAID BY HAND (T1304d). Cutting the joint alone leaves a smooth
     cylinder with rings scored into it; what makes stone read as STONE is that each course
     is a separate block and no two sit flush. One hash per course, a millimetre or two
     proud or recessed, and the silhouette of a column stops being a line.
     This is the correction to a real mistake: the version before this leaned on a fine
     noise octave for the same job, and the owner read it as "noisy and strange" rather
     than as worn — because noise at that scale is a per-pixel crawl, and a mason's error
     is at the scale of a BLOCK. Same budget, structure instead of grain. */
  let proud = (unitFloat(hash2i(vec2i(i32(courseIndex), 5), STONE_SEED)) - 0.5) * params.courseLay;

  /* THE PERPEND JOINTS — the vertical ones, and they are STAGGERED half a block from one
     course to the next, because a wall whose vertical joints line up is a wall that falls
     down and every mason since the bronze age has known it. Taken on the column's own
     angular coordinate, so the blocks wrap the shaft rather than being projected onto it. */
  let q = columnLocal(p);
  let around = (atan2(q.z, q.x) / 6.2831853) + 0.5;
  let blocks = max(params.courseBlocks, 1.0);
  let stagger = fract(courseIndex * 0.5) * 0.5;
  let perp = abs(fract((around * blocks) + stagger) - 0.5) * 2.0;
  // Only on the shaft: the mouldings are each cut from one stone.
  let onShaft = (1.0 - smoothstep(params.columnRadius * 1.1, params.columnRadius * 2.0, length(vec2f(q.x, q.z))))
    * step(params.plinthHeight + 0.4, p.y);
  let perpend = smoothstep(0.86, 1.0, perp) * params.courseDepth * 0.8 * onShaft;

  return bed + perpend + proud;
}

/**
 * THE FLOOR IS A SURFACE, and before this it was not one.
 *
 * The owner's reading: *"sanctum floor feels like mud... the reflection is doing all the
 * work and the substrate none"*, and that was literally true — the floor was the plane
 * y = 0 with a reflection on it and nothing else. A mirror with no material under it is not
 * a polished floor, it is a puddle, which is exactly what it read as.
 *
 * Three facts make it stone: SLABS at a size a person could lift, JOINTS between them cut
 * deep enough to catch light, and SETTLEMENT — each slab sits at a slightly different
 * height, because a floor that is perfectly flat is a floor nobody has walked on for a
 * thousand years.
 *
 * ⚑ THE RESULT IS SCALED BY 0.7 AND THAT IS NOT A FUDGE. A height field added to a plane's
 * distance is no longer a distance: its gradient exceeds one wherever the field is steep,
 * and a marcher that trusts an overestimate steps THROUGH the surface and puts holes in the
 * floor at grazing angles — which is precisely where this floor is seen. Scaling by a
 * Lipschitz bound turns an overestimate into an underestimate, and an underestimate only
 * ever costs steps.
 */
fn floorHeightAt(p: vec3f) -> f32 {
  let slab = max(params.slabSize, 0.2);
  let cell = vec2i(floor(vec2f(p.x, p.z) / slab));
  let f = fract(vec2f(p.x, p.z) / slab);
  let edge = min(min(f.x, 1.0 - f.x), min(f.y, 1.0 - f.y));
  let joint = (1.0 - smoothstep(0.0, max(params.slabJoint, 0.001), edge)) * params.slabDepth;
  let settle = unitFloat(hash2i(cell, STONE_SEED)) * params.slabSettle;
  return joint + settle;
}

/**
 * THE INLAY — and the FIRST version of it was the reason this hall read as a flooded crypt
 * rather than as alien technology.
 *
 * That version laid rows of hashed marks at regular heights: rectangular, warm, evenly
 * spaced, human-scaled. Every one of those properties says WINDOW, and a hall of lit
 * windows in eroded stone is a ruin with people in it. The brief asked for alien
 * technology, and the stone alone cannot say that — eroded rock is "old", never "made by
 * something else".
 *
 * Two changes carried it: the channels FOLLOW the geometry instead of sitting on it, and
 * the light is NOT ON THE BLACKBODY CURVE (amber at that temperature is fire, and fire is
 * human — a torch, a forge, a lamp; a cyan-green with no red in it cannot be produced by
 * anything burning, and the eye knows that without being told).
 *
 * ⚑ AND THEN CONTINUOUS BECAME UNIFORM, WHICH IS THE DEFECT T1304c IS FIXING.
 *
 * The rule that produced the version before this one was "a mark that stops and starts in
 * blocks is a glyph; a line that runs the length of a structure is a conduit". Taken
 * literally it produces a strip of even width and even brightness running the full height
 * of every column — which is NEON TAPE APPLIED TO A COLUMN, not something that is part of
 * one. Continuous was right. Uniform is what "lame" was naming.
 *
 * A conduit wants variation ALONG its run while staying continuous, and it wants four
 * separate kinds of it:
 *
 *  - WIDTH swells and narrows, because a channel cut by hand or grown by something is not
 *    a extrusion die;
 *  - BRIGHTNESS dips, because a line carrying power is not equally bright everywhere along
 *    it;
 *  - INTERRUPTIONS, because a network that can fail is a network, and one that has never
 *    failed anywhere in a ruined hall is decoration;
 *  - POOLING AT JUNCTIONS, because that is where a network shows it is a network rather
 *    than a set of parallel lines that happen to cross some rings.
 *
 * All four come from 'runNoise', which is two hashes — so the whole fix costs six hashes
 * against the eight that one call to the three-dimensional noise would have cost.
 *
 * ⚑ PROCEDURAL, NOT THE 'text' NODE. §V403: the text node renders BLACK headless, so marks
 * made of it would be invisible in every thumbnail, every claim and every headless render.
 */
fn columnLocal(p: vec3f) -> vec3f {
  let zLocal = (fract(p.z / max(params.bay, 0.1) + 0.5) - 0.5) * max(params.bay, 0.1);
  let xLocal = abs(p.x) - params.aisle;
  return vec3f(xLocal, p.y, zLocal);
}

/**
 * WHICH BAY, and it is the SAME arithmetic the colonnade is folded with.
 *
 * ⚑ A REAL BUG, FOUND WHILE ADDING THE RUIN. The inlay used to index bays as
 * 'floor(p.z / bay)' while the columns are folded with 'fract(p.z / bay + 0.5)', so the
 * column centres sit at z = k·bay — exactly where the inlay's bay index CHANGES. Every
 * column in the hall was therefore split down its middle, carrying one circuit on its near
 * half and a different one on its far half. It was invisible because both halves are
 * plausible circuits and the seam runs straight down a shadowed axis. One expression, in
 * one place, used by everything that asks the question.
 */
fn bayOf(z: f32) -> f32 {
  return floor(z / max(params.bay, 0.1) + 0.5);
}

/**
 * Returns TWO numbers, and the second one is the piece's second colour.
 *
 *   .x  how lit this point is, which is what the distance function cuts with
 *   .y  how much of that light is a JUNCTION rather than a run
 *
 * ⚑ THE JUNCTIONS BURN A DIFFERENT COLOUR FROM THE RUNS, and that is a better answer to
 * "it needs a second hue in genuine opposition" than the one before it. The first attempt
 * put the opposing hue on a DIRECTIONAL FILL — a warm lambert from the other side — and
 * the render said exactly what is wrong with that: every surface facing one way acquired a
 * flat red wash, so the second colour read as PAINT rather than as light. A wash cannot be
 * a second light source because it has no source in the picture.
 *
 * Putting it on the junctions instead gives it somewhere to come FROM. The nodes are small,
 * they are scattered through the frame at every depth, they are already the brightest
 * points on a column, and they are the one place the network shows itself — so the two
 * temperatures are interleaved through the whole hall at the scale of a detail rather than
 * split across it at the scale of a wall.
 */
fn inlayAt(p: vec3f) -> vec2f {
  let q = columnLocal(p);
  let radial = length(vec2f(q.x, q.z));
  // Only on the column's own skin: a conduit is fixed to something.
  let onColumn = 1.0 - smoothstep(params.columnRadius * 1.05, params.columnRadius * 1.9, radial);
  if (onColumn <= 0.0) { return vec2f(0.0); }
  if (p.y < params.plinthHeight) { return vec2f(0.0); }

  let bayIndex = bayOf(p.z);
  let side = select(0.0, 1.0, p.x >= 0.0);

  // VEINS: continuous lines up the column, spaced around it.
  let turns = max(params.inlayVeins, 1.0);
  let angle = (atan2(q.z, q.x) / 6.2831853) + 0.5;
  let veinIndex = floor(angle * turns);
  let live = unitFloat(hash3i(vec3i(i32(veinIndex), i32(bayIndex), i32(side)), GLYPH_SEED));
  let veinLit = step(live, clamp(params.inlayDensity, 0.0, 1.0));
  let acrossVein = abs(fract(angle * turns) - 0.5) * 2.0;

  /* The three variations along the run. The keys are deliberately far apart so width,
     brightness and the interruptions are three independent decisions rather than one
     decision read three times — correlated variation reads as a single wobble. */
  let key = vec2i((i32(veinIndex) * 31) + i32(side), i32(bayIndex));
  let swell = runNoise(key, p.y, params.inlayRun);
  let width = clamp(params.inlayWidth, 0.02, 0.9) * mix(0.4, 1.7, swell);
  let glow = mix(1.0 - clamp(params.inlayVary, 0.0, 0.95), 1.0, runNoise(key + vec2i(101, 0), p.y, params.inlayRun * 0.61));
  let alive = runNoise(key + vec2i(0, 233), p.y, params.inlayRun * 0.37);
  // A soft edge on the interruption: a conduit GUTTERS out and comes back, it does not
  // switch. A hard step here is the "blinky" complaint spelled in space instead of time.
  let unbroken = smoothstep(clamp(params.inlayBreak, 0.0, 0.8), clamp(params.inlayBreak, 0.0, 0.8) + 0.16, alive);
  let vein = (1.0 - smoothstep(0.0, width, acrossVein)) * veinLit * glow * unbroken;

  // RINGS: the horizontal members that make it read as a circuit rather than as fluting,
  // and they are ARCS rather than full circles — a member that always closes is a hoop.
  let pitch = max(params.inlayRows, 0.05);
  let rowIndex = i32(floor(p.y / pitch));
  let acrossRing = abs(fract(p.y / pitch) - 0.5) * 2.0;
  let ringLive = unitFloat(hash3i(vec3i(rowIndex, i32(bayIndex), 7), GLYPH_SEED));
  let ringArc = unitFloat(hash3i(vec3i(rowIndex, i32(veinIndex), 11), GLYPH_SEED));
  let ring = (1.0 - smoothstep(0.0, 0.12, acrossRing)) * step(ringLive, params.inlayRings) * step(ringArc, 0.74);

  /* THE JUNCTION POOLS. Where a live conduit crosses a live member there is more light than
     either carries alone — which is the one place a viewer can see that these lines are
     connected to each other rather than merely parallel. */
  let node = vein * ring * params.inlayNode;
  let total = min(max(vein, ring) + node, 1.8) * onColumn;
  return vec2f(total, select(0.0, clamp(node / max(total, 1.0e-4), 0.0, 1.0), total > 0.0));
}

/**
 * THE SPILL — the light that LEAVES the channel, and it took two wrong versions to get here.
 *
 * ⚑ VERSION ONE sampled the inlay field at 'p + n * 0.06', along the SURFACE NORMAL. That
 * moves off the surface into the air, where the field is whatever it was directly
 * underneath — so a lit point read lit, a dark point read dark, and the "spill" was the
 * channel's own value again.
 *
 * ⚑ VERSION TWO sampled four offsets in the TANGENT PLANE, which is the right direction to
 * move but the wrong thing to sample. The glyph hash is keyed on cells about 0.2 m across,
 * so a 0.12 m tap usually lands in the SAME cell and returns the same value: a blur whose
 * radius is smaller than its subject is not a blur. The stone around a glyph stayed black
 * in both versions and the inlay read as painted on.
 *
 * What works is not a blur of the channel at all — it is a SEPARATE, WIDER FIELD that shares
 * the channel's structure but not its detail. It answers "is there writing near here", which
 * is what a glow is, and it costs one hash pair rather than four field evaluations.
 *
 * It reads the same interruption field the channel does, at the same key, so a conduit that
 * has guttered out is dark in the stone around it too. Without that the hall glows in places
 * where nothing is lit, and a glow with no source is the tell that this is all painted.
 */
fn inlaySpillAt(p: vec3f) -> f32 {
  let q = columnLocal(p);
  let radial = length(vec2f(q.x, q.z));
  if (p.y < params.plinthHeight) { return 0.0; }
  // A pool around the column's skin rather than a copy of the channel: the glow is "there
  // is a conduit near here", which is a coarser question than "am I on one".
  let near = 1.0 - smoothstep(params.columnRadius * 1.0, params.columnRadius * 2.9, radial);
  let bayIndex = bayOf(p.z);
  let side = select(0.0, 1.0, p.x >= 0.0);
  let turns = max(params.inlayVeins, 1.0);
  let angle = (atan2(q.z, q.x) / 6.2831853) + 0.5;
  let veinIndex = floor(angle * turns);
  let live = unitFloat(hash3i(vec3i(i32(veinIndex), i32(bayIndex), i32(side)), GLYPH_SEED));
  let veinLit = step(live, clamp(params.inlayDensity, 0.0, 1.0));
  let acrossVein = abs(fract(angle * turns) - 0.5) * 2.0;
  let key = vec2i((i32(veinIndex) * 31) + i32(side), i32(bayIndex));
  let alive = runNoise(key + vec2i(0, 233), p.y, params.inlayRun * 0.37);
  let unbroken = smoothstep(clamp(params.inlayBreak, 0.0, 0.8), clamp(params.inlayBreak, 0.0, 0.8) + 0.16, alive);
  return near * veinLit * unbroken * (1.0 - smoothstep(0.0, 1.0, acrossVein));
}

fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

/* A box in two dimensions: the profile of a prism that runs forever along the third. The
   architrave is one of these, which is why a beam spanning the whole colonnade costs the
   same as a beam spanning one bay. */
fn sdBox2(p: vec2f, b: vec2f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0);
}

/**
 * THE HALL, and the shapes in it are the answer to "the shapes are too simple".
 *
 * Everything here is folded: 'p.z' into one bay and 'p.x' mirrored about the nave's axis,
 * so the eye sees thirty columns and the marcher evaluates one. The consequence is the
 * finding this whole rework rests on — ADDING A KIND IS NEARLY FREE WHERE ADDING A COUNT IS
 * NOT. Every shape below is a box or a circle:
 *
 *   PLINTH     the square block a column stands on. The single most valuable shape in the
 *              list: a cylinder that meets the floor with no base reads as a PIPE PUSHED
 *              THROUGH IT, and a plinth is what says somebody built this.
 *   TORUS      the fillet course above the plinth, where a shaft meets its base.
 *   SHAFT      the column proper, flaring the opposite way from a classical one.
 *   CAPITAL    echinus and abacus — two boxes, and they are what give the top of a column
 *              somewhere to END. Without them a column runs into the ceiling like scaffolding.
 *   ARCHITRAVE the beam the capitals carry, running the full length of each colonnade. It is
 *              an infinite prism, so its cost does not depend on how long the hall is.
 *   RIBS       arches across the nave at every bay, springing from the colonnades. This is
 *              what turns a flat ceiling into a vault.
 *   STEPS      three of them and a dais at the far end, under the doorway. They give the
 *              key light something to rake across, which is the only reason a step reads.
 *   RUIN       a hashed share of bays have FALLEN: the column snapped at a hashed height,
 *              its capital gone with it, the span above it broken out, and a block of it on
 *              the floor. One hash decides all four, because a ruin is a ruin all the way up
 *              and a bay whose column is gone but whose architrave still floats is a bug.
 */
fn sceneAt(p: vec3f) -> f32 {
  let bayF = max(params.bay, 0.1);
  let zLocal = (fract(p.z / bayF + 0.5) - 0.5) * bayF;
  let bayIndex = i32(bayOf(p.z));
  let xLocal = abs(p.x) - params.aisle;
  let r = max(params.columnRadius, 0.05);
  let side = select(0, 1, p.x >= 0.0);

  /* WHICH BAYS FELL. One roll, used by the column, the capital, the span and the rubble,
     so the four agree. A separate seed from the stone's, so changing which bays are ruined
     cannot move the erosion on the ones still standing. */
  let roll = unitFloat(hash3i(vec3i(bayIndex, side, 3), RUIN_SEED));
  let fallen = step(roll, clamp(params.ruin, 0.0, 0.9));
  let breakHeight = mix(1.0, 3.6, unitFloat(hash3i(vec3i(bayIndex, side, 9), RUIN_SEED)));

  // THE COLUMN, in courses rather than as one cylinder.
  let flare = 1.0 + params.columnFlare * clamp(p.y / max(params.ceiling, 0.001), 0.0, 1.0);
  let shaftD = max(length(vec2f(xLocal, zLocal)) - (r * flare), params.plinthHeight - p.y);
  /* ⚑ THE BASE IS A MOULDING, NOT A CRATE (T1304d). The first cut put a plain square box
     under each shaft and the owner's reading was "boxy, squary" — exactly right, and the
     reason is that a sharp-cornered prism is the one shape a mason never leaves. Stone is
     cut with a chisel and weathered by water, and neither produces a 90° arris: every real
     base is a stack of ROUNDED mouldings, and the corner radius is most of what says
     "carved" rather than "modelled".
     Three changes, all of them one number: the plinth is a ROUNDED box (a box inset by the
     radius, then grown back by it — exact, and the standard trick); a round TORUS moulding
     sits between the square plinth and the round shaft, which is what that transition is
     for in every order ever built; and the capital's two members are rounded on the same
     rule so the top of the column matches the bottom. */
  let plinthRound = r * 0.16;
  let plinthD = sdBox(
    vec3f(xLocal, p.y - (params.plinthHeight * 0.5), zLocal),
    vec3f(r * 1.62 - plinthRound, params.plinthHeight * 0.5 - plinthRound * 0.5, r * 1.62 - plinthRound),
  ) - plinthRound;
  /* THE TORUS. A square plinth carrying a round shaft needs something round in between or
     the eye sees two unrelated solids stacked. Swept about the column's axis, so it is a
     circle of a circle and costs one more length(). */
  let toreRadius = r * 1.16;
  let toreY = params.plinthHeight + (r * 0.19);
  let toreD = length(vec2f(length(vec2f(xLocal, zLocal)) - toreRadius, p.y - toreY)) - (r * 0.21);
  let capRound = r * 0.13;
  let echinusD = sdBox(
    vec3f(xLocal, p.y - (params.ceiling - params.capitalDrop), zLocal),
    vec3f(r * 1.34 - capRound, 0.2 - capRound * 0.5, r * 1.34 - capRound),
  ) - capRound;
  let abacusD = sdBox(
    vec3f(xLocal, p.y - (params.ceiling - params.capitalDrop + 0.33), zLocal),
    vec3f(r * 1.8 - capRound, 0.15 - capRound * 0.5, r * 1.8 - capRound),
  ) - capRound;
  var columnD = min(min(shaftD, plinthD), min(toreD, min(echinusD, abacusD)));
  /* The break. 'mix' against a large negative leaves an intact bay untouched: max(d, -1000)
     is d. A branch here would be a branch the wavefront cannot take together. */
  columnD = max(columnD, mix(-1000.0, p.y - breakHeight, fallen));

  // THE ARCHITRAVE: an infinite prism along the nave, broken out over a fallen bay.
  var spanD = sdBox2(vec2f(xLocal, p.y - (params.ceiling - params.spanDepth)), vec2f(r * 1.55, params.spanDepth));
  spanD = max(spanD, mix(-1000.0, (bayF * 0.5) - abs(zLocal), fallen));

  /* THE RIBS. A circle of radius 'aisle' centred at (0, ceiling − aisle) has its apex
     exactly at the vault and its springing exactly at the colonnades, so the arch lands on
     the columns rather than near them. That is arithmetic, not tuning — and it is why the
     rib parameters are a thickness and a width and not a position.
     ⚑ AND IT IS CLIPPED AT THE SPRINGING, which the first cut was not. The full circle
     continues BELOW the impost, curving inward across the nave at head height — so the
     first render had a two-metre stone hoop passing through the camera and filling half
     the frame. An arch is the top half of that circle; the bottom half is the columns'
     job. The clip is one 'max' and it drops just below the springing so the rib and the
     capital actually meet. */
  let springY = params.ceiling - params.aisle;
  let ringD = abs(length(vec2f(p.x, p.y - springY)) - params.aisle) - params.ribThickness;
  var ribD = max(ringD, abs(zLocal) - params.ribWidth);
  ribD = max(ribD, (springY - 0.35) - p.y);

  // THE STEPS at the far end, under the doorway.
  let stepsD = min(
    sdBox(p - vec3f(0.0, 0.09, WALL_Z - 3.6), vec3f(5.4, 0.09, 1.5)),
    min(
      sdBox(p - vec3f(0.0, 0.27, WALL_Z - 2.4), vec3f(4.6, 0.27, 1.2)),
      sdBox(p - vec3f(0.0, 0.45, WALL_Z - 1.4), vec3f(3.8, 0.45, 1.0)),
    ),
  );

  /* THE RUBBLE: one block of what fell, offset by its own hash so it is not in the same
     place in every ruined bay. It exists because a column that snapped and left a clean
     floor did not snap, it was never finished. */
  let dropX = mix(-1.1, 1.1, unitFloat(hash3i(vec3i(bayIndex, side, 17), RUIN_SEED)));
  let dropZ = mix(-1.5, 1.5, unitFloat(hash3i(vec3i(bayIndex, side, 23), RUIN_SEED)));
  /* Rounded on the same rule as the base: a block that has fallen off a weathered column
     and lain on a floor for a thousand years has no sharp arrises left at all. */
  let rubbleRound = r * 0.22;
  var rubbleD = sdBox(
    vec3f(xLocal - dropX, p.y - 0.26, zLocal - dropZ),
    vec3f(r * 0.78 - rubbleRound, 0.26 - rubbleRound * 0.5, r * 0.6 - rubbleRound),
  ) - rubbleRound;
  rubbleD = mix(1000.0, rubbleD, fallen);

  /* THE FAR WALL, and the doorway is an ARCH. The owner's reading of the flat rectangle was
     that it was the brightest and least interesting thing in frame, and half of that is
     shape: a rectangle of light has no silhouette to read. A round head over square jambs
     is the oldest door in architecture and it costs one circle. */
  let wallD = sdBox(p - vec3f(0.0, params.ceiling * 0.5, WALL_Z), vec3f(14.0, params.ceiling * 0.5, 0.6));
  let jambD = sdBox(p - vec3f(0.0, 1.55, WALL_Z), vec3f(params.doorWidth, 1.55, 2.0));
  let headD = max(length(vec2f(p.x, p.y - 3.1)) - params.doorWidth, abs(p.z - WALL_Z) - 2.0);
  let wall = max(wallD, -min(jambD, headD));

  let built = min(min(columnD, spanD), min(ribD, min(stepsD, min(rubbleD, wall))));
  /* Time, taken out of the stone rather than added to it: the displacement only ever
     REMOVES material, so an eroded edge is bitten and never inflated. The bedding joints
     are removed on the same side of the ledger, and for the same reason. */
  let eaten = built - (params.erosion * max(erosionAt(p), 0.0)) + beddingAt(p);
  /* The channels are CUT, not painted: the same field that lights them also removes stone,
     so a channel breaks the silhouette of a column seen edge-on. A decal would not. */
  let carved = eaten + (params.inlayDepth * inlayAt(p).x);

  /* The vault gets the erosion but neither the bedding nor the inlay: a course line is a
     function of height alone, and a horizontal ceiling sitting on one would disappear
     entirely rather than acquire a groove. */
  var vaultD = (params.ceiling - p.y) - (params.erosion * max(erosionAt(p), 0.0) * 0.6);
  /* ⚑ AND IN SOME BAYS IT IS BROKEN OPEN, which is the single most dramatic thing in the
     piece and it is one hole and one hash.
     The owner's reading was "not dramatic enough" and "a bunch of the vertical stuff is
     also somewhat lame", and both are the same shortage: every light in this hall came
     from inside it, at the same temperature, along the same axis. A hall that has been
     buried has been CRUSHED, and a crushed vault lets the day in — so a share of the bays
     have a hole in the roof with a shaft of daylight standing in it. That gives the frame
     a light from ABOVE (the one direction nothing was coming from), a second temperature
     with a SOURCE IN SHOT rather than a wash, and a vertical to answer the columns with.
     The hole is a circle in plan, offset by its own hash, so no two breaches line up. */
  let breachRoll = unitFloat(hash3i(vec3i(bayIndex, 0, 41), RUIN_SEED));
  let breached = step(breachRoll, clamp(params.breach, 0.0, 0.9));
  let breachX = mix(-2.6, 2.6, unitFloat(hash3i(vec3i(bayIndex, 0, 47), RUIN_SEED)));
  let breachR = mix(0.9, 1.8, unitFloat(hash3i(vec3i(bayIndex, 0, 53), RUIN_SEED)));
  /* Unbounded upward: a hole that stops a metre above the vault is a hole a ray cannot get
     out of, and the stone above the ceiling is solid all the way up. */
  let holeD = max(length(vec2f(p.x - breachX, zLocal)) - breachR, (params.ceiling - 1.4) - p.y);
  vaultD = max(vaultD, mix(-1000.0, -holeD, breached));

  // The floor is its own height field, and its own Lipschitz bound. See 'floorHeightAt'.
  let floorD = (p.y + floorHeightAt(p)) * 0.7;

  return min(min(carved, vaultD), floorD);
}

fn normalAt(p: vec3f) -> vec3f {
  let e = vec2f(0.0016, 0.0);
  return normalize(vec3f(
    sceneAt(p + e.xyy) - sceneAt(p - e.xyy),
    sceneAt(p + e.yxy) - sceneAt(p - e.yxy),
    sceneAt(p + e.yyx) - sceneAt(p - e.yyx),
  ));
}

/* Rotate a colour about the luma axis. Cheap, and it keeps the value the author chose
   while moving only where it sits on the wheel. */
fn rotateHue(base: vec3f, turn: f32) -> vec3f {
  let k = vec3f(0.57735);
  let c = cos(turn * 6.2831853);
  let s = sin(turn * 6.2831853);
  return (base * c) + (cross(k, base) * s) + (k * dot(k, base) * (1.0 - c));
}

/**
 * THE TWO COLOURS TRAVEL IN OPPOSITION (T1304b, corrected in T1304c).
 *
 * The owner asked for "slowly morphing through colors", and the first answer moved the
 * conduits along an arc of a sixth of the wheel. It worked and it was not enough, and the
 * reading of why is exact: *"the morph landed but reads as one state; it needs a second hue
 * in genuine opposition, not a drift inside one family"*. A single hue drifting cyan to
 * teal has nothing to be measured against, so nothing in the frame CHANGES — it is one
 * colour, slightly different.
 *
 * So the counter-light travels the OTHER WAY on a wider arc. The two lights in this hall
 * pull apart and come back together, and the frame has a relationship in it rather than a
 * setting. That costs one more rotation of one more vector, once per fragment.
 *
 * The lap is FORTY-TWO SECONDS, which a viewer sits through — §T1271's finding, which is
 * that a turn slow enough to be subtle is a turn nobody ever sees. Free-running on
 * 'frameU.absTime' (§V436), so a timeline lap cannot snap it.
 */
fn inlayHue() -> vec3f {
  let phase = (frameU.absTime / max(params.hueTurn, 1.0)) * 6.2831853;
  return rotateHue(params.inlayColor.rgb, (sin(phase) * 0.5) * params.hueArc);
}

fn warmHue() -> vec3f {
  let phase = (frameU.absTime / max(params.hueTurn, 1.0)) * 6.2831853;
  // The opposite sign, and a wider arc: the warm light is the one with somewhere to go.
  return rotateHue(params.warmColor.rgb, (sin(phase) * -0.5) * params.warmArc);
}

/**
 * THE FAR LIGHT LIVES (T1304b), and the way it lives is the whole point.
 *
 * The owner: the light at the end should not "always be on and the same brightness". The
 * trap is the one §T1301 is open about — E57's primary light dipping on every kick read as
 * *blinking*, and that complaint is still unresolved. **A light that VARIES is not a light
 * that STROBES.** So this is not on a beat, not on a hit count, and not on audio at all: it
 * is two free-running sines a fifth apart, so the swell never repeats exactly inside a
 * viewing, over a fifteen-second slowest period. Something is behind that doorway and it is
 * not steady; it is not flickering either.
 */
fn keyDrive() -> f32 {
  let t = frameU.absTime;
  let slow = sin((t / max(params.keyPeriod, 0.5)) * 6.2831853);
  let slower = sin((t / (max(params.keyPeriod, 0.5) * 2.7)) * 6.2831853 + 1.3);
  return 1.0 + (params.keyBreath * ((slow * 0.6) + (slower * 0.4)));
}

/**
 * WHAT IS BEYOND THE DOORWAY, because a hole is not a light source.
 *
 * The doorway used to be the brightest thing in the frame and the least interesting: the
 * ray passed through the aperture, hit nothing, and came back as flat fog with the dust
 * shaft piled on top. Flat, because there was nothing out there — a bright rectangle with
 * no gradient, no horizon, no temperature and no falloff.
 *
 * What a doorway shows is SOMEWHERE ELSE, and somewhere else has a horizon. A ray that
 * misses everything is intersected with the wall's plane, and if it passes through the
 * aperture it gets a graded field: warm low where the ground outside would be, cold high
 * where the sky is, and a soft core that is the thing actually making the light. That is
 * three mixes and one exponential, and it turns the flattest object in the picture into the
 * one with the most shape in it.
 */
fn beyondDoor(eye: vec3f, dir: vec3f, key: f32) -> vec3f {
  /* UP IS THE SKY, and a ray only gets to look up by going through a breach in the vault —
     the stone above the ceiling is solid, so nothing else can escape that way. That makes
     this test both cheap and correct: no cone, no aperture arithmetic, just the fact that
     the geometry already refused every other upward ray. */
  if (dir.y > 0.12) {
    let high = smoothstep(0.12, 0.55, dir.y);
    return mix(params.fogColor.rgb, params.dayColor.rgb * params.breachLight, high);
  }
  if (dir.z <= 0.01) { return params.fogColor.rgb; }
  let travel = (WALL_Z - eye.z) / dir.z;
  if (travel <= 0.0) { return params.fogColor.rgb; }
  let b = eye + dir * travel;
  let acrossJamb = 1.0 - smoothstep(params.doorWidth * 0.7, params.doorWidth * 1.02, abs(b.x));
  let underHead = 1.0 - smoothstep(3.0, 4.3, b.y);
  let inside = acrossJamb * underHead * step(0.0, b.y);
  if (inside <= 0.0) { return params.fogColor.rgb; }
  // The horizon: warm ground below, cold sky above, and the transition is where the eye
  // reads a distance rather than a wall.
  let height = clamp((b.y - 0.1) / 3.8, 0.0, 1.0);
  let field = mix(params.warmColor.rgb * 0.55, params.keyColor.rgb * 1.5, smoothstep(0.1, 0.72, height));
  let core = exp(-abs(b.y - 1.4) * 0.6) * exp(-abs(b.x) * 0.85);
  let beyond = (field + (params.keyColor.rgb * core * 0.9)) * params.keyIntensity * key;
  return mix(params.fogColor.rgb, beyond, inside);
}

/**
 * THE DUST — and it is the stage that makes the inlay read as a LIGHT rather than as a set
 * of bright marks.
 *
 * Everything before this only showed light where it LANDED. A buried hall has air in it,
 * and air is what lets you see a beam rather than infer one: the glow pools around the
 * channels become volumes, and the doorway stops being a bright rectangle and becomes a
 * shaft lying across the nave.
 *
 * DENSITY SETTLES. Dust is heavier than air, so it thins with height over 'dustFloor'
 * metres — that is what puts the shaft's edge where the eye expects it and keeps the vault
 * from fogging over.
 *
 * ⚑ THE SHAFT IS STRIPED BY THE COLONNADE, which is new in T1304c and is the difference
 * between a beam and a gradient. Light from a doorway at the end of a hall passes the ribs
 * on its way down the nave, and what reaches the air between them is therefore banded at
 * the bay pitch. Modelled rather than traced: one 'fract' at the same pitch the ribs use, so
 * the bands land where the ribs are and the beam reads as light that came from a PLACE.
 * Tracing this would be a second volumetric march; the band costs a cosine.
 *
 * ⚑ THE START OFFSET IS DITHERED BY A HASH OF THE PIXEL, FIXED ACROSS FRAMES. A fixed step
 * count through a volume bands; jittering removes the bands and a jitter that changes every
 * frame turns them into boiling noise instead. E55 learned that one: the dither is GRAIN,
 * never flicker (§V44 — this reads the pixel, not the clock).
 */
fn dustAlong(eye: vec3f, dir: vec3f, far: f32, pixel: vec2f, hue: vec3f, key: f32) -> vec3f {
  let count = i32(clamp(params.dustSteps, 2.0, 64.0));
  let span = min(far, MAX_DISTANCE);
  let stride = span / f32(count);
  let jitter = unitFloat(hash2i(vec2i(pixel), DUST_SEED));
  let bayF = max(params.bay, 0.1);
  var accumulated = vec3f(0.0);
  var dayAir = vec3f(0.0);
  for (var i = 0; i < count; i = i + 1) {
    let travel = (f32(i) + jitter) * stride;
    let p = eye + dir * travel;
    // Dust settles: thinner the higher you look.
    let settle = exp(-max(p.y, 0.0) / max(params.dustFloor, 0.05));
    /* ⚑ THE VOLUME READS A SMOOTH FIELD, NOT THE SURFACE ONE. The first version sampled
       the same spill field the stone uses, and the result was salt-and-pepper: that field
       is hash-GATED, so it is nearly binary, and 22 sparse samples through a binary volume
       is a speckle generator rather than a fog. What the air wants is "roughly how much
       light is near here", so the glyph hash goes and the row window stays — smooth in
       every direction, and cheaper for losing a hash. */
    let pitch = max(params.inlayRows, 0.05);
    let row = floor(p.y / pitch);
    let bayIndex = bayOf(p.z);
    /* Gated by the SAME row-and-bay test the channels use, so the air glows where there is
       writing and not in bays without any. Without this the row window is a function of
       height alone and paints continuous horizontal bands the full width of the hall —
       which is what the first smooth version did, and it read as a striped fog rather than
       as light near a wall. The fine glyph and stroke hashes stay out: those are what made
       the volume speckle. */
    let live = unitFloat(hash3i(vec3i(i32(row), i32(bayIndex), 0), GLYPH_SEED));
    /* ⚑ A SMOOTHSTEP, NOT A STEP, and the difference is visible as GRAIN. A hard gate makes
       the volume binary again in one more axis, and a binary volume sampled sparsely is the
       speckle generator this file already learned about once — the per-pixel dither decides
       how many samples land inside the lit cell, so neighbouring pixels disagree and the
       dark stone beyond the colonnade fills with noise. Softening the gate costs nothing
       and turns the disagreement into a gradient. */
    let density = clamp(params.inlayDensity, 0.0, 1.0);
    let lit = smoothstep(density + 0.1, density - 0.1, live);
    let withinRow = abs(fract(p.y / pitch) - 0.5) * 2.0;
    let rowPool = (1.0 - smoothstep(0.0, 1.0, withinRow)) * step(0.4, p.y) * lit;
    /* Near the columns, where the channels actually are — and NEAR ONE IN BOTH AXES.
       ⚑ THE X TEST ALONE PAINTS A BAND ACROSS THE WHOLE FRAME. A ray heading sideways
       still crosses the plane |x| = aisle, and it crosses it at whatever z it happens to
       be at — including the gaps between bays, where there is no column at all. The
       result was a flat horizontal band of glow spanning the frame at row height, which
       is the same failure as the very first smooth version and for the same reason: a
       gate that is a function of fewer axes than the thing it is gating. */
    let nearColumn = 1.0 - smoothstep(0.45, 1.7, abs(abs(p.x) - params.aisle));
    let nearBay = 1.0 - smoothstep(0.5, 1.6, abs((fract(p.z / bayF + 0.5) - 0.5) * bayF));
    let glow = rowPool * nearColumn * nearBay * hue;
    /* The shaft: a slab of light down the nave's axis from the doorway, banded by the ribs
       it passed on the way. The band never closes fully — a rib casts a shadow, it does not
       switch the light off. */
    let axis = 1.0 - smoothstep(0.0, 2.2, abs(p.x));
    let ribBand = mix(0.45, 1.0, smoothstep(0.25, 0.85, abs(fract(p.z / bayF + 0.5) - 0.5) * 2.0));
    /* The beam exists between the doorway and the part of the nave the doorway can see
       into, and it is strongest near the wall. Measured in metres from the wall rather
       than in absolute z, because the eye dollies forever and an absolute window would
       leave the beam behind. */
    let fromWall = clamp(WALL_Z - p.z, 0.0, 60.0);
    let reach = (1.0 - smoothstep(4.0, 34.0, fromWall)) * step(0.0, WALL_Z - p.z);
    let beam = axis * ribBand * params.shaft * key * params.keyColor.rgb * reach;

    /* THE DAYLIGHT STANDING IN THE BREACHES — and this is the light the piece was missing.
       Everything else here comes from inside the building, at one temperature, along one
       axis. A shaft falling THROUGH the vault gives the frame a vertical to answer the
       columns with, a warm against the cyan, and a light whose source is visible in shot
       rather than implied. It is the same arithmetic as the hole in 'sceneAt', read in the
       air instead of in the stone, so the beam and the hole cannot drift apart.
       It strengthens with height because it is coming DOWN and the dust eats it on the way,
       which is the opposite of the settle term and is why the two are multiplied rather
       than shared. */
    let bIndex = bayOf(p.z);
    let bRoll = unitFloat(hash3i(vec3i(i32(bIndex), 0, 41), RUIN_SEED));
    let bOpen = smoothstep(clamp(params.breach, 0.0, 0.9) + 0.06, clamp(params.breach, 0.0, 0.9) - 0.06, bRoll);
    let bX = mix(-2.6, 2.6, unitFloat(hash3i(vec3i(i32(bIndex), 0, 47), RUIN_SEED)));
    let bR = mix(0.9, 1.8, unitFloat(hash3i(vec3i(i32(bIndex), 0, 53), RUIN_SEED)));
    let inShaft = 1.0 - smoothstep(bR * 0.3, bR * 0.85, length(vec2f(p.x - bX, (fract(p.z / bayF + 0.5) - 0.5) * bayF)));
    let descend = smoothstep(0.0, params.ceiling, p.y);
    dayAir = dayAir + (bOpen * inShaft * descend * params.dayColor.rgb);

    accumulated = accumulated + ((glow + beam) * settle);
  }
  /* ⚑ THE SHAFT IS NOT SCALED BY 'dust', and the first version was. Everything else in this
     function is light scattered by the dust that hangs in the hall, so 'dust' is the right
     gain for it — but a shaft through a hole in the roof is the one beam whose strength is
     set by what is OUTSIDE, and multiplying it by a 0.032 density made it invisible in the
     air while it was still bright on the floor. A beam you can see land but not see travel
     is a fog decal, and the eye catches that immediately. */
  return (accumulated * (params.dust * stride)) + (dayAir * (params.breachLight * stride * 0.05));
}

/**
 * THE FLOOR REFLECTION — the only idea in this piece that is a SECOND MARCH rather than a
 * lookup, and the one the original 25–35 ms estimate was really pricing.
 *
 * It gets a deliberately smaller budget than the primary ray: a third of the steps, a
 * shorter reach, and a distance fade. That is not a corner cut, it is what a reflection
 * can afford to be — the eye checks a silhouette against the thing above it and forgives
 * everything else, so precision spent past the first few metres buys nothing anybody sees.
 *
 * It only runs where the floor is still polished, and 'polish' at 0 removes the march
 * entirely rather than multiplying its result by zero: a branch the whole wavefront takes
 * together on a flat floor, and the difference between "this idea is off" and "this idea is
 * free".
 */
fn reflectionAt(hitPoint: vec3f, n: vec3f, viewDir: vec3f, hue: vec3f, warmth: vec3f) -> vec3f {
  let dir = reflect(viewDir, n);
  // Upward only: the floor reflects the hall, never the floor.
  if (dir.y <= 0.02) { return vec3f(0.0); }
  let count = i32(clamp(params.reflectSteps, 4.0, 96.0));
  let reach = max(params.reflectFade, 0.5) * 2.0;
  var travelled = 0.08;
  var found = false;
  for (var i = 0; i < count; i = i + 1) {
    let p = hitPoint + dir * travelled;
    let d = sceneAt(p);
    if (d < SURFACE * 2.0) { found = true; break; }
    travelled = travelled + d * 0.9;
    if (travelled > reach) { break; }
  }
  /* A MISS IS NOT BLACK. A ray that leaves the colonnade without hitting anything is
     looking at the lit end of the hall, and a wet floor shows exactly that — the doorway
     and the haze above it. Returning zero here is what made the first version invisible:
     most floor pixels reflect a gap between columns, so "nothing hit" is the common case
     rather than the edge one. */
  if (!found) {
    let toward = smoothstep(0.0, 0.5, dir.z);
    return (params.fogColor.rgb * 0.8) + (params.keyColor.rgb * params.shaft * 0.5 * toward);
  }
  let p = hitPoint + dir * travelled;
  /* The reflected hit is shaded by the INLAY ALONE — its own emission and its spill. The
     key is a directional light from a doorway the reflected ray cannot see past, and the
     ambient term would only wash the reflection toward the stone's own grey. What a wet
     floor shows is the bright things, which here means the writing. */
  let channel = inlayAt(p);
  let spill = inlaySpillAt(p) * params.inlaySpill * 0.4;
  // The junctions carry their own colour into the reflection too, or the wet floor would
  // be the one place in the hall where the second hue does not exist.
  let colour = (mix(hue, warmth, channel.y) * params.inlayEmission * channel.x)
    + (params.stoneColor.rgb * hue * spill);
  // Near the eye it is a mirror, far away a sheen.
  return colour * (1.0 - smoothstep(0.0, max(params.reflectFade, 0.5), travelled));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = 16.0 / 9.0;
  let ndc = vec2f((uv.x - 0.5) * 2.0 * aspect, (0.5 - uv.y) * 2.0);

  /* THE CAMERA MOVE: a slow dolly down the nave, free-running on the absolute clock so a
     timeline lap cannot snap it (§V436). No audio reaches this — T1279's refusal, learned
     on E57: modulating the move makes it a limp rather than a groove. */
  let t = frameU.absTime;
  /* ⚑ HOISTED, and the measurement is why. The hue is a function of the CLOCK alone — the
     same value for every pixel and every step — and it was first written where it read
     naturally, inside the shading and inside the DUST LOOP. That put a pair of trig calls
     and a cross product on 22 volumetric samples per pixel. Computing it once per fragment
     is the same picture for a fraction of the cost, and the general form is worth more than
     the fix: a value that varies per FRAME must never be evaluated per SAMPLE. */
  let hue = inlayHue();
  let warmth = warmHue();
  // Same rule as the hue: a per-frame value, evaluated once per fragment.
  let key = keyDrive();
  let eye = vec3f(0.0, params.eyeHeight, t * params.dollySpeed);
  let tilt = radians(params.pitch);
  let forward = normalize(vec3f(0.0, sin(tilt), cos(tilt)));
  let right = vec3f(1.0, 0.0, 0.0);
  /* ⚑ cross(forward, right), NOT cross(right, forward). The other order gives a vector
     pointing DOWN, which flips the image vertically — and a symmetric dark hall hides that
     almost perfectly: every still through stage 3 was upside down and read fine, because a
     vault and a floor of the same eroded stone look alike in the dark. What exposed it was
     the floor REFLECTION appearing along the top edge of the frame. */
  let up = cross(forward, right);
  let dir = normalize((right * ndc.x) + (up * ndc.y) + (forward * params.lens));

  var travelled = 0.0;
  var hit = false;
  let steps = i32(clamp(params.steps, 8.0, 256.0));
  for (var i = 0; i < steps; i = i + 1) {
    let p = eye + dir * travelled;
    let d = sceneAt(p);
    if (d < SURFACE) { hit = true; break; }
    travelled = travelled + d * 0.85;
    if (travelled > MAX_DISTANCE) { break; }
  }

  // A ray that found no stone is looking through the doorway, or at the dark past it.
  var colour = beyondDoor(eye, dir, key);
  if (hit) {
    let p = eye + dir * travelled;
    let n = normalAt(p);
    /* One key, from the doorway at the end of the nave: a direction rather than a point,
       because the doorway is far enough that its rays are parallel by the time they reach
       anything the camera can see. */
    let toKey = normalize(vec3f(0.0, 0.22, -1.0));
    /* ⚑ AND IT FALLS OFF, which is the single change that stopped this reading as a flat
       render of a corridor. A directional light with no reach lights EVERY surface facing
       the camera equally, all the way down the hall — so every column in the nave arrived
       at the same pale blue-grey however far away it was, which is the frontal
       flat-lighting that makes a picture look like a viewer rather than a place. It is
       also false: the key comes through a doorway forty metres away, and light from a
       doorway does not reach the far end of a building undiminished.
       With the reach in, the piece has DEPTH AS COLOUR — near the eye the only light is
       the inlay's own, so the near hall is lit by what is in it; far down the nave the
       cold key takes over. Two zones the eye can read the distance from, out of one
       'smoothstep'. */
    let fromWall = clamp(WALL_Z - p.z, 0.0, 90.0);
    let keyReach = 1.0 - smoothstep(2.0, 62.0, fromWall);
    let lambert = max(dot(n, toKey), 0.0) * keyReach;
    /* THE INLAY IS THE PRIMARY SOURCE, which is what makes the temple read as powered
       rather than as lit-from-off-screen. Three terms and they are different things:
       the channel's own emission (it burns), the spill onto the stone immediately around
       it (light leaves the channel), and the cold key from the doorway (the only thing in
       the picture that is not the building). */
    let channel = inlayAt(p);
    /* ⚑ THE EMISSION CARRIES BOTH COLOURS. A run burns the conduit's hue; a junction burns
       the counter-hue. That is where the frame's second temperature actually lives — see
       'inlayAt', and the render that proved a directional warm fill reads as red paint. */
    let emission = mix(hue, warmth, channel.y) * params.inlayEmission * channel.x;
    let spill = inlaySpillAt(p) * params.inlaySpill;
    let bounced = hue * spill;
    let fill = mix(vec3f(1.0), hue, 0.65) * params.ambient;
    /* THE COUNTER-LIGHT, and what is left of it after the junctions took its job. The
       shipped frame measured saturation 0.55 — not grey in the desaturated sense at all —
       but every source in it was COOL, so the average of the picture was one hue and read
       as slate. This term is now a LOW RAKE rather than the second light: it falls off with
       height, so it warms the floor, the plinths and the rubble and leaves the columns to
       the inlay. A full-strength directional warm was measured and rejected — it painted
       every surface facing one way a flat crimson, because a wash with no source in frame
       cannot read as light. */
    let toWarm = normalize(vec3f(0.82, 0.18, 0.55));
    let warmLambert = max(dot(n, toWarm), 0.0);
    let lowRake = exp(-max(p.y, 0.0) * 0.55);
    /* ⚑ THE RAKE DOES NOT MORPH, and the reason is measured rather than aesthetic. Rotating
       an orange about the luminance axis moves it toward MAGENTA — measured on the rubble
       at (70, 42, 57), which is blue-over-green and reads as a mauve slab of painted stone
       rather than as warm light. The morph belongs on the junctions, where it is a small
       bright detail whose colour is the point; the rake is the stone's own warmth and it
       stays where the author put it. Two uses of one colour do not have to move together. */
    let warm = params.warmColor.rgb * params.warmIntensity * warmLambert * lowRake;
    /* THE DAYLIGHT LANDS. A shaft you can see in the air but that puts no light on the
       floor under it is a fog effect, not a light — and the eye checks exactly that. Same
       hash, same hole, read at the surface: straight down, so it rakes the horizontal
       stone (floor, plinth tops, rubble, the steps) and leaves the vertical faces to the
       inlay. That separation is doing as much for the picture as the shaft itself. */
    let dayBay = bayOf(p.z);
    let dayRoll = unitFloat(hash3i(vec3i(i32(dayBay), 0, 41), RUIN_SEED));
    let dayOpen = smoothstep(clamp(params.breach, 0.0, 0.9) + 0.06, clamp(params.breach, 0.0, 0.9) - 0.06, dayRoll);
    let dayX = mix(-2.6, 2.6, unitFloat(hash3i(vec3i(i32(dayBay), 0, 47), RUIN_SEED)));
    let dayR = mix(0.9, 1.8, unitFloat(hash3i(vec3i(i32(dayBay), 0, 53), RUIN_SEED)));
    let dayLocalZ = (fract(p.z / max(params.bay, 0.1) + 0.5) - 0.5) * max(params.bay, 0.1);
    let dayPool = 1.0 - smoothstep(dayR * 0.28, dayR * 0.95, length(vec2f(p.x - dayX, dayLocalZ)));
    let daylight = params.dayColor.rgb * params.breachLight * 0.55 * dayOpen * dayPool * max(n.y, 0.0);
    let lit = (params.stoneColor.rgb * ((params.keyColor.rgb * params.keyIntensity * key * lambert) + fill + bounced + warm + daylight)) + emission;
    var reflected = vec3f(0.0);
    /* The FLOOR, and the test is position as well as orientation. A normal pointing up is
       not enough: the eroded vault has pockets whose local normals point any way at all, so
       an orientation-only test put reflected glyphs on the CEILING. The hall stands on
       exactly one surface and it is at y = 0.
       ⚑ THE HEIGHT WINDOW SURVIVED THE SLABS BY ARITHMETIC, not by luck: a settled slab
       sits at most 'slabSettle' below zero and the joints are shallower still, so 0.6 m
       clears the whole floor and still excludes the first step of the dais. */
    if (params.polish > 0.001 && n.y > 0.75 && p.y < 0.6) {
      let fresnel = pow(1.0 - max(dot(n, -dir), 0.0), 4.0);
      let weight = params.polish * mix(0.12, 1.0, fresnel);
      reflected = reflectionAt(p, n, dir, hue, warmth) * weight;
    }
    // Aerial perspective: exponential in depth, which is also what lets the march stop
    // early without a visible wall of nothing.
    let haze = 1.0 - exp(-travelled * params.fog);
    colour = mix(lit + reflected, params.fogColor.rgb, haze);
  }
  /* The dust is ADDED over whatever the ray found, surface or nothing: light in the air is
     in front of the thing behind it, not mixed with it. */
  colour = colour + dustAlong(eye, dir, select(MAX_DISTANCE, travelled, hit), uv * vec2f(1280.0, 720.0), hue, key);

  /* ⚑ THE GRADE, AND THE FIRST VERSION OF IT MADE THINGS WORSE IN A MEASURABLE WAY.
     Measured on the shipped frame: saturation mean 0.55 — healthy — but luma p50 = 29 of
     255, 81% of every frame in the bottom fifth, under 5% above the midpoint. The picture
     was never desaturated. It was CRUSHED: a narrow dark band, a thin bright tail, and no
     midtones between them, which reads as grey however saturated the few lit pixels are.

     My first fix added a flat LIFT to all three channels and pushed a contrast curve on
     the result. It moved the tone exactly as intended — p50 29 → 88 — and took saturation
     from 0.55 to 0.155, because adding a constant to r, g and b shrinks the RATIOS between
     them, and saturation is a ratio. It also put 68% of the frame in one bin: a flat
     histogram made flatter. A grade that moves tone must not move chroma, and the way to
     guarantee that is to compute the curve on LUMINANCE and scale the colour by what the
     curve did, so every hue arrives with its ratios intact. */
  let level = max(dot(colour, vec3f(0.2126, 0.7152, 0.0722)), 1.0e-5);
  let curved = (pow(level / max(params.pivot, 1.0e-3), params.contrast) * params.pivot * params.exposure)
    + params.lift;
  let scaled = colour * (curved / level);
  // And saturation is now its own knob rather than a side effect of the tone curve.
  let grey = dot(scaled, vec3f(0.2126, 0.7152, 0.0722));
  let saturated = mix(vec3f(grey), scaled, params.saturation);
  return vec4f(saturated, 1.0);
}
`;
