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
 * THE TEAR — per-cell glitch, and the thing that makes the wall a VJ instrument rather
 * than a contact sheet.
 *
 * ## It is SPARSE and EVENT-LIKE, and that is a design constraint rather than a taste
 *
 * A glitch that fires on every cell every frame is mush at grid scale — at 6x6 it reads
 * as static, and static carries no information about the music or the picture. So a cell
 * is DEALT: on each tick of `rate`, an integer hash of (cell, seed, tick) decides whether
 * that cell tears at all. `amount` is the share of cells dealt in AND how hard they tear,
 * one knob with a large legible range, which is what a performer can reach for without a
 * steady hand.
 *
 * ## THE AUDIO GATE, and why it is not an audio channel
 *
 * A cell's own BRIGHTNESS scales its chance of being dealt in. That is the audio hook,
 * and it is deliberately indirect: a component's published parameters cannot be animated
 * at all today (`flatten.ts` resolves an instance's page with no frame and no node reader,
 * and `flattenComponents` is memoized on the document revision), so a channel expression
 * on `Glitch` would silently read zero. Reading the PICTURE instead needs nothing from the
 * parent but a source that already responds to the music — and on this instrument it is
 * the better mapping anyway: every cell holds a DIFFERENT MOMENT, so one kick arrives in
 * each cell at a different time, and the tears chase it across the wall.
 *
 * One texel at the cell's centre, not an average: a reduction per fragment would be a
 * whole extra pass, and the centre of a cell is exactly where a wall's subject is.
 *
 * ## `amount = 0` IS BYTE-IDENTICAL PASSTHROUGH (§V147, E43's bar for user WGSL)
 *
 * The early return is a `textureLoad` at the fragment's own integer coordinate, so the
 * knob has a true identity end rather than a nearly-invisible one — and so does an armed
 * cell's neighbour, which takes the same return.
 */
export const TIME_GRID_GLITCH_WGSL = `${SHARED_UNIFORMS_WGSL}
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

/* Sample this cell, displaced along x and WRAPPED INSIDE IT. The +4.0 is there because
   fract() of a negative number is not the wrap we want and the shove is signed. */
fn tap(cell: Cell, dx: f32) -> vec4f {
  let local = vec2f(fract(cell.local.x + dx + 4.0), cell.local.y);
  return textureSampleLevel(inputTexture, inputSampler, cell.origin + (local * cell.size), 0.0);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(inputTexture));
  let texel = vec2i(clamp(uv * dims, vec2f(0.0), dims - vec2f(1.0)));
  let here = textureLoad(inputTexture, texel, 0);
  if (params.amount <= 0.0) { return here; }

  let cell = cellAt(uv, params.grid);
  let index = u32(cell.index);
  let seed = u32(clamp(params.seed, 0.0, 65535.0));
  /* max(0.25) so the deal still turns at Rate 0 — a knob at its floor must not freeze a
     second knob's behaviour, which is how a control stops being reachable mid-show. */
  let tick = u32(floor(frameU.absTime * max(0.25, params.rate)));

  /* THE AUDIO GATE: this cell's own centre texel. Bright cells are dealt in first. */
  let middle = vec2i(clamp((cell.origin + (0.5 * cell.size)) * dims, vec2f(0.0), dims - vec2f(1.0)));
  let lit = clamp(dot(textureLoad(inputTexture, middle, 0).rgb, vec3f(0.2126, 0.7152, 0.0722)), 0.0, 1.0);

  let deal = hashU((index * 2654u) + (seed * 40503u) + (tick * 7919u));
  let armed = clamp(params.amount * (0.2 + (1.8 * lit)), 0.0, 1.0);
  if (deal >= armed) { return here; }

  /* Dealt in. How hard, how many bands, and which way each band shoves — all from the
     same (cell, tick, seed) triple, so a tear HOLDS for a whole tick instead of boiling. */
  let strength = params.amount * (0.35 + (0.65 * hashU((index * 337u) + (tick * 61u) + seed)));
  let bands = 4.0 + floor(hashU((index * 977u) + (tick * 131u) + seed) * 12.0);
  let band = u32(floor(cell.local.y * bands));
  let shove = (hashU((band * 1471u) + (index * 29u) + (tick * 523u) + seed) - 0.5) * 0.7 * strength;
  let split = 0.06 * strength;

  /* The RGB split rides the same shove, so the fringe is part of the tear rather than a
     separate effect layered on top of it. */
  let mid = tap(cell, shove);
  let red = tap(cell, shove + split);
  let blue = tap(cell, shove - split);
  return vec4f(red.r, mid.g, blue.b, here.a);
}`;
