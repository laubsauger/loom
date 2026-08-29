/**
 * The Gray-Scott reaction-diffusion kernel carried by example E2 (T154).
 *
 * This is the `source` parameter of that example's CustomWGSL node. It lives here as a
 * TypeScript constant rather than only inside the `.loom.json` so the example can be
 * REGENERATED (`src/examples/build-examples.ts`) instead of hand-edited as escaped JSON —
 * the shipped file is still the artifact, and `sync.test.ts` fails if the two drift.
 *
 * CONTRACT (§I "custom WGSL node contract v1"): a CustomWGSL node is wired exactly two
 * bindings — `inputSampler` at 0 and `inputTexture` at 1. It is NOT given a uniform block
 * (the node's `compile()` sets no `uniformBinding`), so this kernel declares none and
 * reads its grid spacing from `textureDimensions` instead. Declaring a `params` block the
 * plan never fills would bind nothing at all on a real device.
 *
 * STATE PACKING: `r` is U, `g` is V, `b` is unused, `a` is the INITIALISED FLAG. That flag
 * is what makes a seeded start possible with one texture and no extra node: a ping-pong
 * pair that has just been cleared (project load, reset, resize, format change, device
 * loss — the Feedback node's whole `resetOn` list) reads back as `clearColor`, which this
 * example sets to transparent black. Alpha below 0.5 therefore means "history is gone",
 * and this kernel answers with the seeded initial condition rather than with a step of the
 * simulation. Reset really is re-seed, and it is the same code path on frame 0 as on the
 * frame after a reset.
 *
 * DETERMINISM (§V45): the seed pattern is an integer hash of the cell coordinate and a
 * constant seed carried in the source itself. No `textureLoad` of noise, no wall clock, no
 * frame counter — the same seed produces the same start on any device, and the simulation
 * from there is a pure function of its own previous frame.
 *
 * UNIFORM CONTROL FLOW: every `textureSample` is taken unconditionally at the top level
 * and the branch is a `select` over already-sampled values. WGSL forbids sampling inside
 * non-uniform control flow, and an `if` around the re-seed branch would be exactly that.
 */
export const GRAY_SCOTT_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

// Coral-growth parameters. Feed/kill pairs are famously sensitive: these two sit in the
// mitosis band, which keeps dividing rather than settling into a fixed pattern.
const FEED: f32 = 0.0545;
const KILL: f32 = 0.062;
const DIFFUSE_U: f32 = 0.2097;
const DIFFUSE_V: f32 = 0.105;

// Seeded initial condition (§V45). Constant, so the start is reproducible.
const SEED: u32 = 20260829u;
const SEED_CELLS: f32 = 28.0;
const SEED_DENSITY: f32 = 0.10;

fn hashU32(value: u32) -> u32 {
  var x = value;
  x = x ^ (x >> 16u);
  x = x * 0x7feb352du;
  x = x ^ (x >> 15u);
  x = x * 0x846ca68bu;
  x = x ^ (x >> 16u);
  return x;
}

fn unitFloat(h: u32) -> f32 {
  return f32(h & 0x00ffffffu) / f32(0x01000000u);
}

/** U saturated, V sprinkled in whole cells: the classic Gray-Scott starting plate. */
fn seededState(uv: vec2f) -> vec2f {
  let cell = vec2u(floor(uv * SEED_CELLS));
  let h = hashU32((cell.x * 73856093u) ^ hashU32((cell.y * 19349663u) ^ SEED));
  let v = select(0.0, 1.0, unitFloat(h) < SEED_DENSITY);
  return vec2f(1.0, v);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let texel = 1.0 / vec2f(textureDimensions(inputTexture));

  let centre = textureSample(inputTexture, inputSampler, uv);
  let west = textureSample(inputTexture, inputSampler, uv + vec2f(-texel.x, 0.0)).rg;
  let east = textureSample(inputTexture, inputSampler, uv + vec2f(texel.x, 0.0)).rg;
  let south = textureSample(inputTexture, inputSampler, uv + vec2f(0.0, -texel.y)).rg;
  let north = textureSample(inputTexture, inputSampler, uv + vec2f(0.0, texel.y)).rg;
  let sw = textureSample(inputTexture, inputSampler, uv + vec2f(-texel.x, -texel.y)).rg;
  let se = textureSample(inputTexture, inputSampler, uv + vec2f(texel.x, -texel.y)).rg;
  let nw = textureSample(inputTexture, inputSampler, uv + vec2f(-texel.x, texel.y)).rg;
  let ne = textureSample(inputTexture, inputSampler, uv + vec2f(texel.x, texel.y)).rg;

  let state = centre.rg;
  let laplacian =
    ((west + east + south + north) * 0.2) + ((sw + se + nw + ne) * 0.05) - state;

  let reaction = state.x * state.y * state.y;
  let stepped = clamp(
    vec2f(
      state.x + ((DIFFUSE_U * laplacian.x) - reaction + (FEED * (1.0 - state.x))),
      state.y + ((DIFFUSE_V * laplacian.y) + reaction - ((KILL + FEED) * state.y)),
    ),
    vec2f(0.0),
    vec2f(1.0),
  );

  // alpha < 0.5 == the pair was cleared: re-seed instead of stepping (see the note above).
  let next = select(seededState(uv), stepped, centre.a >= 0.5);
  return vec4f(next, 0.0, 1.0);
}`;
