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
 * ## Stage 1 of four, and the stages are a COST DISCIPLINE rather than a plan
 *
 * The piece is built in measured stages — bare march, then the inlay and its light, then
 * the dust, then the floor reflection — each measured as GPU extent before the next goes
 * in. ⚑ THE OWNER WITHDREW THE CEILING — "make it look right" — so there is no threshold
 * that removes an idea automatically. The stages survive anyway, and the reason is not
 * budget: a number nobody can attribute to a stage is the thing §T1284's split was filed to
 * prevent, and the owner can only say "that idea is not worth 8 ms" after seeing the piece
 * IF each idea carries its own number.
 *
 * THIS FILE IS STAGE 1: the stone, its erosion, and one key light. No inlay, no dust, no
 * reflection. It is deliberately a plain picture; what it exists to establish is the march
 * budget everything else is spent against.
 *
 * ## The hall costs about what one pillar costs
 *
 * The colonnade is DOMAIN REPETITION — `p.x` and `p.z` folded into one cell before the
 * column is evaluated — so the marcher answers "how far to the nearest column" once no
 * matter how many the eye can see. That is the single structural decision that makes a
 * temple affordable at all, and it is why the composition is a nave rather than a courtyard.
 *
 * ## Deterministic, and the erosion is integer-hashed
 *
 * §V44/§V45: `frameU.absTime` is the only clock and every "random" figure is an integer
 * hash of a lattice cell, so the same seed is the same stone on every device and every
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
  erosion: f32,       // @default 0.115  how deeply time has eaten the stone, metres of displacement
  erosionScale: f32,  // @default 4.6  size of the bites — higher is finer damage
  erosionBands: f32,  // @default 0.62  how much the damage varies in HEIGHT bands rather than eating evenly: 0 is uniform decay, 1 is courses eaten and courses intact
  inlayRows: f32,     // @default 0.46  metres between glyph rows on a column
  inlayDepth: f32,    // @default 0.035  how deep the channels are cut, metres
  inlayWidth: f32,    // @default 0.1  the lit share of a row's pitch
  inlayColor: vec4f,  // @default [1, 0.62, 0.22, 1]  the powered inlay, warm against the cold key
  inlayEmission: f32, // @default 1.5  how hard the channels burn
  inlaySpill: f32,    // @default 4.2  how hard the channels light the stone around them — this is the hall's PRIMARY light, not a decoration on it
  inlayDensity: f32,  // @default 0.1  share of rows that carry writing at all — most of a wall is blank stone
  stoneColor: vec4f,  // @default [0.29, 0.27, 0.25, 1]  the stone under the key
  keyColor: vec4f,    // @default [0.52, 0.62, 0.78, 1]  the cold light from the doorway
  keyIntensity: f32,  // @default 1.35  how hard that light drives
  ambient: f32,       // @default 0.16  fill, so a wall facing away is not a silhouette — warmed toward the inlay, because in a buried hall the only thing bouncing IS the inlay
  fog: f32,           // @default 0.055  depth haze — the aerial perspective, and the cost lever
  fogColor: vec4f,    // @default [0.045, 0.05, 0.062, 1]  what distance converges to
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
/* One seed for the stone, so the same erosion replays everywhere (§V45). */
const STONE_SEED: u32 = 68u;
/* A second seed, so re-cutting the glyphs cannot move the stone under them. */
const GLYPH_SEED: u32 = 690u;
/* A third seed for the volumetric dither, so re-jittering cannot move the glyphs. */
const DUST_SEED: u32 = 6802u;

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

/* Two octaves, not five: the erosion is a PROFILE on a surface the march has to find, and
   every octave is paid at every step of every ray. The fine damage comes from the second
   octave's scale rather than from a third one. */
fn erosionAt(p: vec3f) -> f32 {
  let s = params.erosionScale;
  let bite = (valueNoise(p * s) * 0.62) + (valueNoise(p * s * 2.7) * 0.31);
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
 * THE INLAY — channels cut into the stone, and still powered.
 *
 * Rows of glyph channels around the columns and along the walls, spaced by 'inlayRows'.
 * Which rows are lit is an integer hash of the row index and the bay, so a column is not a
 * repeating decal: the same pillar geometry carries a different sentence in every bay, and
 * it is the same figure on every device and every replay (§V45).
 *
 * ⚑ PROCEDURAL, NOT THE 'text' NODE. §V403: the text node renders BLACK headless, so a
 * glyph row made of it would be invisible in every thumbnail, every claim and every
 * headless render — which is to say in every picture anybody automated ever sees.
 *
 * Returns 0..1 where 1 is the middle of a lit channel.
 */
fn inlayAt(p: vec3f) -> f32 {
  let pitch = max(params.inlayRows, 0.05);
  let row = floor(p.y / pitch);
  let bayIndex = floor(p.z / max(params.bay, 0.1));
  /* ⚑ MOST OF THE STONE IS BLANK, and that is the whole difference between writing and a
     circuit board. The first cut lit two thirds of the rows and the hall read as a lava
     temple: an inlay is remarkable because the surface around it is not. */
  let live = unitFloat(hash3i(vec3i(i32(row), i32(bayIndex), 0), GLYPH_SEED));
  if (live > clamp(params.inlayDensity, 0.0, 1.0)) { return 0.0; }
  /* ⚑ AND NOT ON THE FLOOR. The rows are spaced in HEIGHT, so a flat floor sits in row
     zero everywhere and the glyph hash tiles it like a grid — which is exactly what the
     first cut did. The channels belong to what stands up. */
  if (p.y < 0.35) { return 0.0; }
  let withinRow = abs(fract(p.y / pitch) - 0.5) * 2.0;
  let lit = 1.0 - smoothstep(1.0 - clamp(params.inlayWidth, 0.02, 0.9), 1.0, 1.0 - withinRow);
  // And the row is BROKEN along its length — glyphs, not a neon tube.
  let glyph = unitFloat(hash3i(vec3i(i32(floor(p.z * 5.0)), i32(row), i32(floor(p.x * 5.0))), GLYPH_SEED));
  /* A second, finer division INSIDE each mark, so a glyph is a figure with parts rather
     than a lit rectangle. The first cut had only the coarse hash and every mark read as a
     window; this is the difference between writing and lighting. */
  let stroke = unitFloat(hash3i(vec3i(i32(floor(p.z * 17.0)), i32(floor(p.y * 23.0)), i32(floor(p.x * 17.0))), GLYPH_SEED));
  return lit * step(0.66, glyph) * step(0.3, stroke);
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
 * the channel's structure but not its detail: the same row test, the same coarse mark, and
 * a soft window several times the channel's own width, with the stroke hash dropped
 * entirely. It answers "is there writing near here", which is what a glow is. One hash pair
 * rather than four field evaluations, so it is also the cheaper of the two wrong versions.
 */
fn inlaySpillAt(p: vec3f) -> f32 {
  if (p.y < 0.2) { return 0.0; }
  let pitch = max(params.inlayRows, 0.05);
  let row = floor(p.y / pitch);
  let bayIndex = floor(p.z / max(params.bay, 0.1));
  let live = unitFloat(hash3i(vec3i(i32(row), i32(bayIndex), 0), GLYPH_SEED));
  if (live > clamp(params.inlayDensity, 0.0, 1.0)) { return 0.0; }
  // A window several times the channel's width, falling off smoothly: the pool of light.
  let withinRow = abs(fract(p.y / pitch) - 0.5) * 2.0;
  let pool = 1.0 - smoothstep(0.0, 0.85, withinRow);
  // The coarse mark only — a glow does not carry the strokes of the glyph making it.
  let glyph = unitFloat(hash3i(vec3i(i32(floor(p.z * 5.0)), i32(row), i32(floor(p.x * 5.0))), GLYPH_SEED));
  return pool * smoothstep(0.35, 0.72, glyph);
}

fn sdBox(p: vec3f, b: vec3f) -> f32 {
  let q = abs(p) - b;
  return length(max(q, vec3f(0.0))) + min(max(q.x, max(q.y, q.z)), 0.0);
}

/**
 * THE HALL. Floor, vault, two colonnades and the wall at the far end.
 *
 * The columns are DOMAIN-REPEATED: 'p.z' is folded into one bay and 'p.x' mirrored about
 * the nave's axis, so the whole colonnade is one cylinder's distance function. The eye can
 * see thirty columns and the marcher evaluates one.
 */
fn sceneAt(p: vec3f) -> f32 {
  let floorD = p.y;
  let vaultD = params.ceiling - p.y;

  let zLocal = (fract(p.z / params.bay + 0.5) - 0.5) * params.bay;
  let xLocal = abs(p.x) - params.aisle;
  // The column tapers the other way from a classical one — wider at the vault, so the
  // hall reads as carried rather than as propped.
  let flare = 1.0 + params.columnFlare * clamp(p.y / max(params.ceiling, 0.001), 0.0, 1.0);
  let radial = length(vec2f(xLocal, zLocal)) - (params.columnRadius * flare);
  let columnD = max(radial, -p.y);

  // The far wall, with the doorway the key comes through cut out of it.
  let wallD = sdBox(p - vec3f(0.0, params.ceiling * 0.5, 46.0), vec3f(14.0, params.ceiling * 0.5, 0.6));
  let doorD = sdBox(p - vec3f(0.0, 1.9, 46.0), vec3f(1.15, 1.9, 2.0));
  let wall = max(wallD, -doorD);

  let stone = min(min(floorD, vaultD), min(columnD, wall));
  // Time, taken out of the stone rather than added to it: the displacement only ever
  // REMOVES material, so an eroded edge is bitten and never inflated.
  let eaten = stone - (params.erosion * max(erosionAt(p), 0.0));
  /* The channels are CUT, not painted: the same field that lights them also removes stone,
     so a channel breaks the silhouette of a column seen edge-on. A decal would not. */
  return eaten + (params.inlayDepth * inlayAt(p));
}

fn normalAt(p: vec3f) -> vec3f {
  let e = vec2f(0.0016, 0.0);
  return normalize(vec3f(
    sceneAt(p + e.xyy) - sceneAt(p - e.xyy),
    sceneAt(p + e.yxy) - sceneAt(p - e.yxy),
    sceneAt(p + e.yyx) - sceneAt(p - e.yyx),
  ));
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
 * Two sources, sampled along the primary ray between the eye and whatever it hit:
 *
 *  - THE INLAY, through the same wide field the surface spill uses. It is a function of
 *    position rather than of any surface, so it works in the air unchanged — which is the
 *    second time that field has paid for itself.
 *  - THE SHAFT from the doorway, which is the only light in the picture that comes from
 *    outside the building. Modelled as a slab rather than traced: full strength near the
 *    nave's axis and falling off with distance from it, which is what a doorway makes.
 *
 * DENSITY SETTLES. Dust is heavier than air, so it thins with height over 'dustFloor'
 * metres — that is what puts the shaft's edge where the eye expects it and keeps the vault
 * from fogging over.
 *
 * ⚑ THE START OFFSET IS DITHERED BY A HASH OF THE PIXEL, FIXED ACROSS FRAMES. A fixed step
 * count through a volume bands; jittering removes the bands and a jitter that changes every
 * frame turns them into boiling noise instead. E55 learned that one: the dither is GRAIN,
 * never flicker (§V44 — this reads the pixel, not the clock).
 */
fn dustAlong(eye: vec3f, dir: vec3f, far: f32, pixel: vec2f) -> vec3f {
  let count = i32(clamp(params.dustSteps, 2.0, 64.0));
  let span = min(far, MAX_DISTANCE);
  let stride = span / f32(count);
  let jitter = unitFloat(hash2i(vec2i(pixel), DUST_SEED));
  var accumulated = vec3f(0.0);
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
    let bayIndex = floor(p.z / max(params.bay, 0.1));
    /* Gated by the SAME row-and-bay test the channels use, so the air glows where there is
       writing and not in bays without any. Without this the row window is a function of
       height alone and paints continuous horizontal bands the full width of the hall —
       which is what the first smooth version did, and it read as a striped fog rather than
       as light near a wall. The fine glyph and stroke hashes stay out: those are what made
       the volume speckle. */
    let live = unitFloat(hash3i(vec3i(i32(row), i32(bayIndex), 0), GLYPH_SEED));
    let lit = step(live, clamp(params.inlayDensity, 0.0, 1.0));
    let withinRow = abs(fract(p.y / pitch) - 0.5) * 2.0;
    let rowPool = (1.0 - smoothstep(0.0, 1.0, withinRow)) * step(0.4, p.y) * lit;
    // Near the columns, where the channels actually are — not out in the middle of the nave.
    let nearColumn = 1.0 - smoothstep(0.45, 1.7, abs(abs(p.x) - params.aisle));
    let glow = rowPool * nearColumn * params.inlayColor.rgb;
    // The shaft: a slab of light down the nave's axis from the doorway, and it only exists
    // deep in the hall where the doorway can see.
    let axis = 1.0 - smoothstep(0.0, 2.0, abs(p.x));
    let beam = axis * params.shaft * params.keyColor.rgb * smoothstep(6.0, 26.0, p.z);
    accumulated = accumulated + ((glow + beam) * settle);
  }
  return accumulated * (params.dust * stride);
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
fn reflectionAt(hitPoint: vec3f, n: vec3f, viewDir: vec3f) -> vec3f {
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
  let colour = (params.inlayColor.rgb * params.inlayEmission * channel)
    + (params.stoneColor.rgb * params.inlayColor.rgb * spill);
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

  var colour = params.fogColor.rgb;
  if (hit) {
    let p = eye + dir * travelled;
    let n = normalAt(p);
    /* One key, from the doorway at the end of the nave: a direction rather than a point,
       because the doorway is far enough that its rays are parallel by the time they reach
       anything the camera can see. */
    let toKey = normalize(vec3f(0.0, 0.22, -1.0));
    let lambert = max(dot(n, toKey), 0.0);
    /* THE INLAY IS THE PRIMARY SOURCE, which is what makes the temple read as powered
       rather than as lit-from-off-screen. Three terms and they are different things:
       the channel's own emission (it burns), the spill onto the stone immediately around
       it (light leaves the channel), and the cold key from the doorway (the only thing in
       the picture that is not the building). */
    let channel = inlayAt(p);
    let emission = params.inlayColor.rgb * params.inlayEmission * channel;
    /* Two radii: a tight one for the hot edge immediately beside a channel, a wide one for
       the wash further out. One radius gives a hard ring; two give a falloff. */
    let spill = inlaySpillAt(p) * params.inlaySpill;
    let bounced = params.inlayColor.rgb * spill;
    let fill = mix(vec3f(1.0), params.inlayColor.rgb, 0.65) * params.ambient;
    let lit = (params.stoneColor.rgb * ((params.keyColor.rgb * params.keyIntensity * lambert) + fill + bounced)) + emission;
    // Aerial perspective: exponential in depth, which is also what lets the march stop
    // early without a visible wall of nothing.
    /* The floor, and only the floor: a surface whose normal points up is the one the hall
       is standing on. A Fresnel weight on top, so the reflection arrives at a grazing view
       the way it does on wet stone and not head-on like a mirror. */
    var reflected = vec3f(0.0);
    /* The FLOOR, and the test is position as well as orientation. A normal pointing up is
       not enough: the eroded vault has pockets whose local normals point any way at all, so
       an orientation-only test put reflected glyphs on the CEILING. The hall stands on
       exactly one surface and it is at y = 0. */
    if (params.polish > 0.001 && n.y > 0.75 && p.y < 0.6) {
      let fresnel = pow(1.0 - max(dot(n, -dir), 0.0), 4.0);
      let weight = params.polish * mix(0.12, 1.0, fresnel);
      reflected = reflectionAt(p, n, dir) * weight;
    }
    let haze = 1.0 - exp(-travelled * params.fog);
    colour = mix(lit + reflected, params.fogColor.rgb, haze);
  }
  /* The dust is ADDED over whatever the ray found, surface or nothing: light in the air is
     in front of the thing behind it, not mixed with it. */
  colour = colour + dustAlong(eye, dir, select(MAX_DISTANCE, travelled, hit), uv * vec2f(1280.0, 720.0));

  return vec4f(colour * params.exposure, 1.0);
}
`;
