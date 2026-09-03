import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * TimeGrid's two fragments — the delay map and the per-cell glitch.
 *
 * ## Why a map and not a node
 *
 * The wall is `tile` → `slitScan`, both stock. `tile` repeats the picture into a grid;
 * `slitScan` then reads a DIFFERENT MOMENT PER PIXEL out of its own ring, steered by a
 * displacement map ("Red channel → frames back, 0 (now) to 1 (deepest)"). Order matters
 * and only one order works: tile FIRST, so the ring records the already-tiled frame and
 * every cell region can be given its own layer. Scan first and the grid repeats one
 * warped picture — every cell identical.
 *
 * So the only thing missing is a map that is FLAT WITHIN A CELL and different between
 * cells. That is the first shader, and it is why no node definition was written: a cell
 * partition plus five distributions is a fragment.
 *
 * The second shader is the VJ half — the tear that makes a cell read as its own broken
 * monitor. It exists here rather than as a general glitch node because its whole subject
 * is the CELL: which cell am I, is this cell armed this tick, and stay inside my own
 * cell while sampling. `TIME_GRID_CELL_WGSL` is the partition both of them share, once
 * (§V349): two copies would be two answers to "where does cell 5 start", and a wall
 * whose delay seams and glitch seams disagreed by one texel is a bug nobody would find.
 *
 * ## Why the grid is ONE vec2 uniform, and that is the whole live-on-the-fly claim
 *
 * `grid` here and `tile.repeat` beside it are per-frame uniform VALUES (§V5) — not
 * `compileTime`. Changing the wall therefore writes uniforms and rebuilds nothing: the
 * ring keeps its layers, its contents and its address. That is what lets a performer take
 * a 3x3 wall to 6x6 mid-show without a reallocation, and it is the property most likely
 * to regress silently, so `time-grid-claims.gpu.test.ts` asserts the ring's descriptor is
 * unchanged across the change.
 *
 * It is a vec2 rather than two scalars because a component may only publish a knob onto a
 * WHOLE parameter — `internalParameterOf` looks target keys up in the node's schema, where
 * `repeat` exists and `repeat.y` does not. Tile's grid is one vec2, so the published knob
 * is one vec2, and its two fields ARE Columns and Rows.
 *
 * ## §V44: no clock, and no unseeded randomness
 *
 * Everything that moves reads `frameU.absTime` — the shared frame block the runtime fills
 * from `FrameEvaluationInput`. Every "random" decision is an integer hash of a cell index,
 * a seed and a tick, so the same seed is the same wall on every device and every replay.
 */

/**
 * THE PARTITION, shared by both shaders.
 *
 * `cellAt` answers everything either of them needs about where a fragment is: which cell,
 * how many there are, where the cell starts and how big it is, and the fragment's own
 * position INSIDE it. The local coordinate is what lets the glitch displace a sample and
 * still land in its own cell — a wall whose tear bled across a seam would look like a
 * broken tiling rather than sixteen broken monitors.
 */
export const TIME_GRID_CELL_WGSL = `struct Cell {
  index: f32,
  count: f32,
  last: f32,
  local: vec2f,
  origin: vec2f,
  size: vec2f,
};

/* The SAME partition Tile uses: floor(uv * repeat), offset zero. Both round the count the
   same way (Tile's \`repeat\` is a "floor"-ranged vector), so a cell here is exactly a cell
   there and no delay or tear ever straddles a seam. */
fn cellAt(uv: vec2f, grid: vec2f) -> Cell {
  let cols = max(1.0, floor(grid.x + 0.5));
  let rows = max(1.0, floor(grid.y + 0.5));
  let ij = clamp(floor(uv * vec2f(cols, rows)), vec2f(0.0), vec2f(cols - 1.0, rows - 1.0));
  var cell: Cell;
  cell.index = (ij.y * cols) + ij.x;
  cell.count = cols * rows;
  /* One cell is a legal wall, and it must not divide by zero on its way to "now". */
  cell.last = max(1.0, cell.count - 1.0);
  cell.size = vec2f(1.0 / cols, 1.0 / rows);
  cell.origin = ij * cell.size;
  cell.local = clamp((uv - cell.origin) / cell.size, vec2f(0.0), vec2f(1.0));
  return cell;
}

/*
 * Integer avalanche (the "lowbias32" family), and INTEGER on purpose: a float hash built
 * on fract(sin(x)) is a different number on every driver, and §V44's sibling promise — a
 * seeded look replays identically — would be a per-machine accident. u32 shifts and
 * multiplies are exact everywhere WGSL runs.
 */
fn hashU(value: u32) -> f32 {
  var x = value;
  x = x ^ (x >> 16u);
  x = x * 0x7feb352du;
  x = x ^ (x >> 15u);
  x = x * 0x846ca68bu;
  x = x ^ (x >> 16u);
  return f32(x & 0x00ffffffu) / 16777216.0;
}

/* Sample this cell, displaced along x and WRAPPED INSIDE IT — the one rule every
   degradation obeys, because a tear or a fringe that crossed a seam would read as a
   broken TILING rather than as a broken monitor. The +4.0 is there because fract() of a
   negative is not the wrap we want and every shove is signed. */
fn tap(cell: Cell, dx: f32) -> vec4f {
  let local = vec2f(fract(cell.local.x + dx + 4.0), cell.local.y);
  return textureSampleLevel(inputTexture, inputSampler, cell.origin + (local * cell.size), 0.0);
}`;

/** How many distinct moments SHOTS cuts between. Four reads as "several camera angles". */
const SHOT_ANGLES = "4.0";

export const TIME_GRID_MAP_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  grid: vec2f,
  mode: f32,
  rate: f32,
  seed: f32,
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

${TIME_GRID_CELL_WGSL}

const SHOT_ANGLES: f32 = ${SHOT_ANGLES};

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let cell = cellAt(uv, params.grid);
  let index = cell.index;
  let seed = u32(clamp(params.seed, 0.0, 65535.0));
  let mode = i32(params.mode + 0.5);

  var delay = 0.0;
  if (mode == 1) {
    /* ORDERED — the cascade. Reading order, oldest at the bottom right. */
    delay = index / cell.last;
  } else if (mode == 2) {
    /* RANDOM — every cell its own moment, held. Seeded, so it is a LOOK, not noise. */
    delay = hashU((u32(index) * 1973u) + (seed * 9277u));
  } else if (mode == 3) {
    /*
     * SWEEP — the owner's "freeze that wanders through".
     *
     * Each cell's delay RAMPS, so it looks one frame further back every frame: at
     * Rate 1.0 (with Spread 1) that is exactly one ring-frame per rendered frame, and
     * the cell holds STILL while the world moves on. The phase offset per cell means
     * they wrap at different times, so the wall refreshes as a rolling wave rather than
     * all at once. Below 1.0 the held frame plays in slow motion; above it, backwards.
     */
    delay = fract((index / cell.count) + (frameU.absTime * params.rate));
  } else if (mode == 4) {
    /*
     * SHOTS — several angles of one scene, cut on a clock.
     *
     * Cells are dealt to SHOT_ANGLES groups by the seeded hash and every group holds one
     * rung of the delay ladder; the ladder rotates one rung per tick, so the whole wall
     * re-cuts at once and then holds. Distinct from RANDOM, which never re-cuts, and from
     * SWEEP, which never holds a whole group together.
     */
    let angle = floor(hashU((u32(index) * 6151u) + (seed * 1543u)) * SHOT_ANGLES);
    let turn = floor(frameU.absTime * max(0.0, params.rate));
    delay = ((angle + turn) % SHOT_ANGLES) / (SHOT_ANGLES - 1.0);
  }
  /* mode 0 — UNIFORM — falls through at 0.0: every cell reads the newest recorded frame,
     so the wall is the plain tiling and the scan is a no-op you can see (§V147's shape). */

  return vec4f(delay, delay, delay, 1.0);
}`;

/**
 * ═══════════════════════════════════════════════════════════════════════════════════
 * BREAK — a VOCABULARY of degradations, not one effect with a rate knob.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * The previous build shipped ONE event — a band tear — dealt sparsely and held for a
 * tick. Sparse and deterministic was right; the verdict on it was "the glitch is a little
 * boring and all the same all the time", and that is a fair reading of a wall where every
 * broken cell breaks the same way. Rarity is not variety.
 *
 * So there are three events, and the three things that make them read as a vocabulary:
 *
 *  1. THREE DIFFERENT KINDS OF DAMAGE. A TEAR displaces bands sideways with an RGB
 *     fringe; SNOW replaces the cell with monochrome static over a crushed silhouette;
 *     DROPOUT multiplies the cell by its own matte, so the background falls away and the
 *     subject is left floating on black. A tear rearranges the picture, snow destroys it,
 *     a dropout shows a DIFFERENT picture — which is what makes the third one worth its
 *     cost rather than a fourth flavour of noise.
 *
 *  2. SIX INDEPENDENT BURST TRAINS, AND THEY ARE SHORT. Every event is a pulse on its own
 *     co-prime frame period — three trains for tears (17, 23, 31 frames), two for snow
 *     (13, 19) and one for dropouts (47) — with a per-cell phase hashed from the cell
 *     index, so the wall never pulses in unison and the trains effectively never realign.
 *     A tear lives 2-3 FRAMES and its bands re-deal every one of them.
 *
 *     THIS IS WHAT PASS 3 CHANGED. Pass 2 held one event for a whole tick, which was
 *     defensible for determinism and wrong for the eye: the owner's verdict was that the
 *     glitch "feels like it has very few frames… we are a little bit too simplified", and
 *     that a glitch reads as a glitch because it is fast and broken-looking. Determinism
 *     is untouched — same integer hashes, same seed, no wall clock (§V44). Only the
 *     ENVELOPE moved: shorter lifetimes, more trains, overlapping phases.
 *
 *  3. AT MOST ONE PER CELL PER FRAME. The selection is an if / else-if chain, so a cell
 *     shows exactly one degradation or none. This is a picture decision and it is the
 *     opposite of "additive": at 6x6 a cell is a couple of thousand pixels, and a tear
 *     under snow is mud. The variety comes from WHICH cells and WHICH kind, and it is
 *     asserted — `time-grid-claims.gpu.test.ts` classifies every broken cell and requires
 *     each one to fall in exactly one bucket.
 *
 * ## THE AUDIO GATE, and why it is not an audio channel
 *
 * A cell's own BRIGHTNESS scales its chance of being dealt in, on all three events. That
 * is the audio hook, and it is deliberately indirect: a component's published parameters
 * cannot be animated at all today (§T1017 — `flatten.ts` resolves an instance's page with
 * no frame and no node reader, and `flattenComponents` is memoized on the document
 * revision), so a channel expression on `Glitch` would silently read zero. Reading the
 * PICTURE instead needs nothing from the parent but a source that already responds to the
 * music — and on this instrument it is the better mapping anyway: every cell holds a
 * DIFFERENT MOMENT, so one kick arrives in each cell at a different time and the damage
 * chases it across the wall.
 *
 * One texel at the cell's centre, not an average: a reduction per fragment would be a
 * whole extra pass, and the centre of a cell is where a wall's subject is.
 *
 * ## WHY SNOW IS HASHED HERE AND NOT A `noise` NODE
 *
 * `noise` does have a `random` type, so the field itself was available. What was not
 * available is a cheap way to show it in SOME cells: a second full-frame generator plus a
 * per-cell gate texture plus a composite is three passes and two nodes to deliver the
 * pixels this shader already has a hash for. The integer hash is per-texel white noise —
 * which is what snow is, and what a lattice noise deliberately is not — and it replays
 * from the same `seed` as every other decision here.
 *
 * ## `amount = 0` IS THE FRAGMENT'S OWN TEXEL (§V147, E43's bar for user WGSL)
 *
 * The early return is a `textureLoad` at the fragment's own integer coordinate, taken
 * BEFORE the seed has been looked at — so Glitch has a true identity end and Seed is inert
 * byte-for-byte at it. Alpha is normalised to 1 on every path, because alpha is carrying
 * the MATTE through the ring (see the component's `pack`) and is not coverage any more
 * once the dropout has had its chance to use it.
 */
export const TIME_GRID_BREAK_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  grid: vec2f,
  amount: f32,
  rate: f32,
  seed: f32,
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

${TIME_GRID_CELL_WGSL}

/*
 * A BURST SLOT — the envelope, and the whole of what changed in pass 3.
 *
 * Each slot is an independent, deterministic pulse train on ONE cell: a period in frames,
 * a lifetime of a few frames, and a per-cycle roll that decides whether this cycle fires
 * at all. A cell's phase inside its own slot is hashed from its index, so thirty-six cells
 * on the same slot are thirty-six unsynchronised trains rather than one flashbulb.
 *
 * Returns the burst's AGE in frames, or -1 when the slot is quiet.
 *
 * The periods are co-prime frame counts, so two slots on one cell realign only every
 * few hundred frames and three of them effectively never. That is what "multiple random
 * glitches" needs and a single tick cannot give: several short events in flight at
 * different phases.
 */
fn slot(index: u32, seed: u32, salt: u32, period: f32, life: f32, chance: f32, frame: f32) -> f32 {
  /* Per-cell phase, so the wall does not pulse in unison. */
  let shifted = frame + (hashU((index * 7919u) ^ salt) * period);
  let cycle = floor(shifted / period);
  let age = shifted - (cycle * period);
  if (age >= life) { return -1.0; }
  if (hashU((index * 1013u) + (seed * 6151u) + salt + (u32(cycle) * 3571u)) >= chance) { return -1.0; }
  return age;
}

/* Co-prime frame periods. Nothing here shares a factor with anything else here. */
const TEAR_A: f32 = 17.0;
const TEAR_B: f32 = 23.0;
const TEAR_C: f32 = 31.0;
const SNOW_A: f32 = 13.0;
const SNOW_B: f32 = 19.0;
const DROP_P: f32 = 47.0;

/*
 * LIFETIMES, in frames, and they are the owner's note made numeric. A tear that lasts two
 * or three frames at 60 fps is 33-50 ms — a flicker you catch rather than a state you
 * watch. Snow is shorter still. A DROPOUT is the exception and holds for a fifth of a
 * second, because it is not damage: it is the cell briefly becoming a different picture,
 * and a two-frame version of that reads as a dropped frame rather than as an idea.
 */
const TEAR_LIFE: f32 = 3.0;
const SNOW_LIFE: f32 = 2.0;
const DROP_LIFE: f32 = 12.0;

/* Relative rarity. A tear is the wall's ordinary weather; snow is an interruption; a
   dropout is an EVENT, because it changes what the cell is a picture OF. */
/*
 * How deep the grain modulates what is already there. Bounded above by construction (see
 * the SNOW branch), so this is a texture depth and not a clipping risk.
 *
 * 0.45 rather than something heavier, and the reason is the RECOLORIZER downstream: a
 * Lookup turns luminance into a palette position, so a deep luminance grain walks the
 * whole palette between neighbouring texels and monochrome noise arrives on screen as
 * multicoloured confetti. Half a stop of luminance wobble is grain; a full swing is
 * garbage. Measured against the owner's own frame.
 */
const SNOW_DEPTH: f32 = 0.45;

const TEAR_SHARE: f32 = 0.55;
const SNOW_SHARE: f32 = 0.35;
const DROP_SHARE: f32 = 0.30;

fn luma(rgb: vec3f) -> f32 {
  return dot(rgb, vec3f(0.2126, 0.7152, 0.0722));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(inputTexture));
  let texel = vec2i(clamp(uv * dims, vec2f(0.0), dims - vec2f(1.0)));
  let here = textureLoad(inputTexture, texel, 0);
  if (params.amount <= 0.0) { return vec4f(here.rgb, 1.0); }

  let cell = cellAt(uv, params.grid);
  let index = u32(cell.index);
  let seed = u32(clamp(params.seed, 0.0, 65535.0));
  /* FRAMES, not seconds: an event two frames long has to be counted in the unit it is two
     of. absFrame is the deterministic frame count the transport supplies (§V44) — never a
     wall clock. Rate stretches or compresses every period together, so the whole wall
     speeds up as one instrument. max(0.25) keeps the trains turning at Rate 0. */
  let frame = frameU.absFrame * max(0.25, params.rate);
  let tick = u32(frame);

  /* THE AUDIO GATE: this cell's own centre texel. Bright cells are dealt in first, so a
     source that responds to the music makes the damage chase the beat across the wall. */
  let middle = vec2i(clamp((cell.origin + (0.5 * cell.size)) * dims, vec2f(0.0), dims - vec2f(1.0)));
  let lit = clamp(luma(textureLoad(inputTexture, middle, 0).rgb), 0.0, 1.0);
  let base = clamp(params.amount * (0.2 + (1.8 * lit)), 0.0, 1.0);

  /* THREE TEAR TRAINS, TWO SNOW TRAINS, ONE DROPOUT — all independent, all per cell. */
  let tearAge = max(
    slot(index, seed, 101u, TEAR_A, TEAR_LIFE, base * TEAR_SHARE, frame),
    max(
      slot(index, seed, 211u, TEAR_B, TEAR_LIFE - 1.0, base * TEAR_SHARE, frame),
      slot(index, seed, 307u, TEAR_C, TEAR_LIFE, base * TEAR_SHARE, frame)));
  let snowAge = max(
    slot(index, seed, 409u, SNOW_A, SNOW_LIFE, base * SNOW_SHARE, frame),
    slot(index, seed, 521u, SNOW_B, SNOW_LIFE - 1.0, base * SNOW_SHARE, frame));
  let dropAge = slot(index, seed, 631u, DROP_P, DROP_LIFE, base * DROP_SHARE, frame);

  /* EXCLUSIVE, rarest first. One thing per cell per frame, on purpose: at 6x6 a cell is a
     couple of thousand pixels and a tear under snow is mud. The variety is in WHICH cells
     and WHICH kind, and it is asserted. */
  if (dropAge >= 0.0) {
    /* DROPOUT — the background falls away. Alpha arrived here as the MATTE, packed into
       the picture before the ring (see the component's pack node), so it has been delayed
       by exactly the same number of frames as the colour it belongs to: a cell holding a
       moment from a second ago drops the background of THAT moment, not of now. */
    return vec4f(here.rgb * clamp(here.a, 0.0, 1.0), 1.0);
  }

  if (snowAge >= 0.0) {
    /*
     * SNOW — and this branch has been rebuilt twice, both times at the cause.
     *
     * WHAT IT LOOKED LIKE WHEN IT WAS WRONG: the owner photographed a two-cell block of
     * full-intensity multicoloured confetti with none of the picture left in it. Three
     * separate faults, none of them a level:
     *
     *  1. IT REPLACED THE PICTURE. mix(silhouette, grain, 0.65) writes a value that owes
     *     almost nothing to what was there, so a cell stopped being a picture. Static has
     *     to RIDE the image — that is the difference between static and a dropout, and
     *     this component already has a dropout.
     *  2. IT CAME OUT CHROMATIC, and not because the grain was. The grain is monochrome
     *     here and always was; the CONFETTI is made downstream, by the recolorizer. A
     *     Lookup maps luminance to a palette position, so a full-swing luminance grain
     *     walks the whole palette between adjacent texels and monochrome noise arrives on
     *     screen as per-pixel colour garbage. The fix is at this end: keep the luminance
     *     excursion small enough that the palette index barely moves, and the same noise
     *     reads as grain instead.
     *  3. IT WAS TOO BIG AND TOO SOLID. A whole cell of it is a rectangle, and a rectangle
     *     is a graphic, not a fault. It is banded now — a few scanline bands per burst —
     *     so it reads as a monitor breaking up rather than as a filled shape.
     *
     * MULTIPLICATIVE, AND HIGHLIGHT-PROTECTED (§V833/§V838). The output is bounded by
     * crushed * (1 + SNOW_DEPTH), and the weight is already ~0 wherever the pixel is
     * bright — so it cannot reach the clip BY CONSTRUCTION, not by tuning. The owner's
     * "it oversteers, overflows" was literal: it was clipping to flat white, and a lower
     * amount would only have made a dimmer wrong picture. The gate asserts the property
     * rather than the number: zero pixels at 1.0 anywhere in a snowing wall.
     *
     * Still monochrome, and that is load-bearing twice: it is what real static is, and it
     * is what lets the gate tell snow from a tear — a tear's RGB fringe leaves r != b and
     * this leaves r == g == b.
     */
    let grain = hashU((u32(texel.x) * 73856093u) ^ (u32(texel.y) * 19349663u) ^ (tick * 83492791u) ^ seed);
    /* SCANLINE BANDS, not the whole cell: only some of them break up on a given burst. */
    let bandCount = 5.0 + floor(hashU((index * 5501u) + (tick * 79u) + seed) * 7.0);
    let bandIndex = u32(floor(cell.local.y * bandCount));
    let banded = select(0.35, 1.0, hashU((bandIndex * 2237u) + (index * 91u) + (tick * 397u) + seed) < 0.45);
    /* A HINT of the hard silhouette — the owner's "thresholding, to crush it" — never the
       whole of it, because a full step() is a two-value image with nothing left to texture. */
    let base = luma(here.rgb);
    let crushed = mix(base, step(0.35, base), 0.25);
    let weight = (1.0 - smoothstep(0.30, 0.92, crushed)) * banded;
    let value = crushed * (1.0 + (SNOW_DEPTH * weight * ((grain * 2.0) - 1.0)));
    return vec4f(value, value, value, 1.0);
  }

  if (tearAge >= 0.0) {
    /*
     * TEAR — bands shove sideways with an RGB fringe riding the same displacement.
     *
     * PASS 3 CHANGED THE ENVELOPE, not the mechanism. Every one of these numbers now
     * re-deals on the FRAME rather than being held for a whole tick: a burst is two or
     * three frames long and the bands jump within it, which is what a glitch looks like.
     * Held for a tick — the pass-2 design — it was one clean state sitting there for half
     * a second, and the owner's verdict was that it read as slow and simplified.
     */
    let strength = params.amount * (0.35 + (0.65 * hashU((index * 337u) + (tick * 61u) + seed)));
    let bands = 4.0 + floor(hashU((index * 977u) + (tick * 131u) + seed) * 12.0);
    let band = u32(floor(cell.local.y * bands));
    let shove = (hashU((band * 1471u) + (index * 29u) + (tick * 523u) + seed) - 0.5) * 0.7 * strength;
    let split = 0.06 * strength;
    let mid = tap(cell, shove);
    let red = tap(cell, shove + split);
    let blue = tap(cell, shove - split);
    return vec4f(red.r, mid.g, blue.b, 1.0);
  }

  return vec4f(here.rgb, 1.0);
}`;

/**
 * THE SWEEP — chromatic aberration that GOES THROUGH.
 *
 * The owner's word for it was "goes through", and that is the whole specification: not a
 * constant fringe sitting on the picture but a band that travels across the wall and
 * passes. It is a separate node from BREAK for two reasons. It is GLOBAL where every
 * degradation above is per-cell, so it is the one thing on the wall that ties the cells
 * together rather than separating them. And it gets its own published knob (`Chroma`), so
 * a performer can run a colour sweep across a clean wall or a broken one — and so each of
 * the two can be tested with the other switched off, which is the only way either claim
 * means anything.
 *
 * It still obeys the cell rule: the band's POSITION is global, the displacement it applies
 * is CELL-LOCAL. A fringe that crossed a seam would smear neighbouring moments into each
 * other, which is the one thing this whole component exists to keep apart.
 *
 * The band wraps at the frame edge (`min(d, 1 - d)`), so it leaves one side and arrives at
 * the other instead of stopping — "goes through", continuously, forever.
 */
export const TIME_GRID_SWEEP_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  grid: vec2f,
  amount: f32,
  rate: f32,
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

${TIME_GRID_CELL_WGSL}

/* Slow against everything else on the wall: one pass every ~7.7 s at Rate 1. The whole
   point of a sweep is that you wait for it. */
const SWEEP_HZ: f32 = 0.13;
/* Half-width, in frame widths. 0.22 puts the band across about two cells of a 6-wide wall
   — wide enough to read as a front travelling, narrow enough to leave somewhere clean. */
const SWEEP_HALF_WIDTH: f32 = 0.22;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(inputTexture));
  let texel = vec2i(clamp(uv * dims, vec2f(0.0), dims - vec2f(1.0)));
  let here = textureLoad(inputTexture, texel, 0);
  if (params.amount <= 0.0) { return here; }

  let centre = fract(frameU.absTime * SWEEP_HZ * max(0.05, params.rate));
  let distance = abs(uv.x - centre);
  /* Wrapped, so the band leaves the right edge and arrives at the left. */
  let wrapped = min(distance, 1.0 - distance);
  let band = 1.0 - smoothstep(0.0, SWEEP_HALF_WIDTH, wrapped);
  if (band <= 0.0) { return here; }

  let cell = cellAt(uv, params.grid);
  /* 0.12 of a CELL width at full Chroma, measured against the picture rather than
     chosen: at 0.05 the fringe was under two texels on a 6-wide wall and did not read. */
  let shift = 0.12 * params.amount * band;
  let red = tap(cell, shift);
  let blue = tap(cell, -shift);
  return vec4f(red.r, here.g, blue.b, here.a);
}`;
