/**
 * The Gray-Scott reaction step carried by example E2 (T154, T388).
 *
 * This is the `source` parameter of that example's CustomWGSL node. It lives here as a
 * TypeScript constant rather than only inside the `.loom.json` so the example can be
 * REGENERATED (`src/examples/build-examples.ts`) instead of hand-edited as escaped JSON —
 * the shipped file is still the artifact, and `sync.test.ts` fails if the two drift.
 *
 * ## What is LEFT in here, and what moved out to the graph (T388)
 *
 * E2 used to be this kernel, a Feedback and an Output: three nodes, with the entire
 * algorithm inside one blob. That is a shader wearing a graph's clothes, and it showed —
 * the pattern was uniform everywhere, because a single pair of compile-time `FEED`/`KILL`
 * constants is the same chemistry in every pixel, and the same chemistry everywhere is
 * what "dead and uniform" looks like.
 *
 * What actually needed WGSL is the part below: a nine-tap Laplacian and two coupled rate
 * equations, evaluated per pixel against its own neighbourhood. Everything else is a node.
 * The animated fields, their interaction, the shaping of that into a chemistry map, the
 * packing of it into the state texture and the colouring of the result are all in the
 * graph, where they can be seen and changed without touching a shader. Same lesson as
 * E12's advection turning out to be a Displace node.
 *
 * ## The chemistry map — the whole reason this looks alive
 *
 * `state.b` is a 0..1 coordinate the GRAPH supplies per pixel, and it walks a straight line
 * through the interesting corner of Gray-Scott's (feed, kill) plane. Feed and kill are
 * famously sensitive — a thousandth in either direction is a different creature — so the
 * BAND stays here as named constants while WHERE each pixel sits inside it is a texture.
 * Neighbouring regions of the image therefore run different chemistries and grow into each
 * other, which is the cell-structure look; a constant map reduces exactly to the old
 * uniform behaviour, which is what the concept test pins.
 *
 * The endpoints are chosen, not tuned blindly: (0.030, 0.0580) is the chaotic-cell corner
 * where fronts keep breaking up, and (0.058, 0.0635) is the coral band where they keep
 * dividing instead of settling. Both ends stay ALIVE, so no region of the image goes
 * static — a band with a dead end grows a still patch and reads as a bug.
 *
 * ## State packing
 *
 * `r` is U, `g` is V, `b` is the chemistry coordinate the graph writes, and `a` is the
 * INITIALISED FLAG. That flag is what makes a seeded start possible with one texture and
 * no extra node: a ping-pong pair that has just been cleared (project load, reset, resize,
 * format change, device loss — the Feedback node's whole `resetOn` list) reads back as
 * `clearColor`, which this example sets to transparent black. Alpha below 0.5 therefore
 * means "history is gone", and this kernel answers with the seeded initial condition rather
 * than with a step of the simulation. Reset really is re-seed, and it is the same code path
 * on frame 0 as on the frame after a reset.
 *
 * `b` survives because the Reorder node downstream rewrites it every step from the noise
 * chain; this kernel reads it and passes its own output's `b` on unused.
 *
 * ## Determinism (§V45)
 *
 * The seed pattern is an integer hash of the cell coordinate and a constant seed carried in
 * the source itself. No `textureLoad` of noise, no wall clock, no frame counter — the same
 * seed produces the same start on any device, and the simulation from there is a pure
 * function of its own previous frame and the chemistry map handed to it.
 *
 * ## Uniform control flow
 *
 * Every `textureSample` is taken unconditionally at the top level and the branch is a
 * `select` over already-sampled values. WGSL forbids sampling inside non-uniform control
 * flow, and an `if` around the re-seed branch would be exactly that.
 *
 * ## Contract (§I "custom WGSL node contract v1")
 *
 * A CustomWGSL node is wired exactly two bindings — `inputSampler` at 0 and `inputTexture`
 * at 1. It is NOT given a uniform block unless the source declares one, so this kernel
 * declares none and reads its grid spacing from `textureDimensions`.
 */
export const GRAY_SCOTT_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

// The BAND the chemistry map walks. Feed/kill pairs are famously sensitive: these two
// endpoints bracket the region where fronts keep breaking up and dividing rather than
// settling into a fixed pattern, so no part of the image goes static.
const FEED_LOW: f32 = 0.030;
const KILL_LOW: f32 = 0.0580;
const FEED_HIGH: f32 = 0.058;
const KILL_HIGH: f32 = 0.0635;

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

  // THE CHEMISTRY MAP. b is a 0..1 coordinate the graph paints per pixel; the band it
  // walks is the constants above. A constant map is the old uniform behaviour exactly.
  let chemistry = clamp(centre.b, 0.0, 1.0);
  let feed = mix(FEED_LOW, FEED_HIGH, chemistry);
  let kill = mix(KILL_LOW, KILL_HIGH, chemistry);

  let state = centre.rg;
  let laplacian =
    ((west + east + south + north) * 0.2) + ((sw + se + nw + ne) * 0.05) - state;

  let reaction = state.x * state.y * state.y;
  let stepped = clamp(
    vec2f(
      state.x + ((DIFFUSE_U * laplacian.x) - reaction + (feed * (1.0 - state.x))),
      state.y + ((DIFFUSE_V * laplacian.y) + reaction - ((kill + feed) * state.y)),
    ),
    vec2f(0.0),
    vec2f(1.0),
  );

  // alpha < 0.5 == the pair was cleared: re-seed instead of stepping (see the note above).
  let next = select(seededState(uv), stepped, centre.a >= 0.5);
  return vec4f(next, 0.0, 1.0);
}`;
