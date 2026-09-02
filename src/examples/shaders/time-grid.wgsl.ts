import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * TimeGrid's delay map — the one piece of WGSL the whole video wall needs.
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
 * cells. That is this shader, and it is why no new node definition was written: a cell
 * partition plus five distributions is a fragment, not a node.
 *
 * ## Why the grid is ONE vec2 uniform, and that is the whole live-on-the-fly claim
 *
 * `grid` here and `tile.repeat` beside it are per-frame uniform VALUES (§V5) — not
 * `compileTime`. Changing the wall therefore writes two uniforms and rebuilds nothing:
 * the ring keeps its layers, its contents and its address. That is what lets a performer
 * take a 3x3 wall to 6x6 mid-show without a reallocation, and it is the property most
 * likely to regress silently, so `time-grid-claims.gpu.test.ts` asserts the ring's
 * descriptor is unchanged across the change.
 *
 * It is a vec2 rather than two scalars because a component may only publish a knob onto a
 * WHOLE parameter — `internalParameterOf` looks target keys up in the node's schema, where
 * `repeat` exists and `repeat.y` does not. Tile's grid is one vec2, so the published knob
 * is one vec2, and its two fields ARE Columns and Rows. Splitting them would mean
 * publishing onto compound components, which the component model does not do today.
 *
 * ## §V44: no clock
 *
 * Modes 3 and 4 move, and their time is `frameU.absTime` — the shared frame block the
 * runtime fills from `FrameEvaluationInput`. `seed` is a parameter and the hash is
 * integer arithmetic, so "random" is reproducible on every device and every replay.
 */
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

/* How many distinct moments SHOTS cuts between. Four reads as "several camera angles";
   more and the cut stops being a cut and becomes the RANDOM mode with extra steps. */
const SHOT_ANGLES: f32 = 4.0;

/*
 * Integer avalanche (Bret Mulvey's / "lowbias32" family), and INTEGER on purpose:
 * a float hash built on fract(sin(x)) is a different number on every driver, and §V44's
 * sibling promise — a seeded look replays identically — would be a per-machine accident.
 * u32 shifts and multiplies are exact everywhere WGSL runs.
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

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  /* The SAME partition Tile uses: floor(uv * repeat), offset zero. Both round the count
     the same way (Tile's \`repeat\` is a "floor"-ranged vector), so a cell here is exactly
     a cell there and no delay ever straddles a seam. */
  let cols = max(1.0, floor(params.grid.x + 0.5));
  let rows = max(1.0, floor(params.grid.y + 0.5));
  let cell = clamp(floor(uv * vec2f(cols, rows)), vec2f(0.0), vec2f(cols - 1.0, rows - 1.0));
  let index = cell.y * cols + cell.x;
  let count = cols * rows;
  /* One cell is a legal wall, and it must not divide by zero on its way to "now". */
  let last = max(1.0, count - 1.0);
  let seed = u32(clamp(params.seed, 0.0, 65535.0));
  let mode = i32(params.mode + 0.5);

  var delay = 0.0;
  if (mode == 1) {
    /* ORDERED — the cascade. Reading order, oldest at the bottom right. */
    delay = index / last;
  } else if (mode == 2) {
    /* RANDOM — every cell its own moment, held. Seeded, so it is a LOOK, not noise. */
    delay = hashU(u32(index) * 1973u + seed * 9277u);
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
    delay = fract(index / count + frameU.absTime * params.rate);
  } else if (mode == 4) {
    /*
     * SHOTS — several angles of one scene, cut on a clock.
     *
     * Cells are dealt to SHOT_ANGLES groups by the seeded hash and every group holds one
     * rung of the delay ladder; the ladder rotates one rung per tick, so the whole wall
     * re-cuts at once and then holds. Distinct from RANDOM, which never re-cuts, and from
     * SWEEP, which never holds a whole group together.
     */
    let angle = floor(hashU(u32(index) * 6151u + seed * 1543u) * SHOT_ANGLES);
    let turn = floor(frameU.absTime * max(0.0, params.rate));
    delay = ((angle + turn) % SHOT_ANGLES) / (SHOT_ANGLES - 1.0);
  }
  /* mode 0 — UNIFORM — falls through at 0.0: every cell reads the newest frame, so the
     wall is the plain tiling and the scan is a no-op you can see (§V147's shape). */

  return vec4f(delay, delay, delay, 1.0);
}`;
