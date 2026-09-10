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
 * BAND is a pair of endpoints in `Params` (constants until T1237) while WHERE each pixel
 * sits inside it is a texture.
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
 * A CustomWGSL node is wired `inputSampler` at 0 and `inputTexture` at 1, and is handed a
 * `params` block only because the source declares one (T880). This kernel takes no
 * `frameU`: it has no clock, and must not — the simulation is a pure function of its own
 * previous frame (§V45). Grid spacing comes from `textureDimensions`.
 *
 * ## The knobs (T1237) — two PHYSICAL axes, not a post-effect (§V427)
 *
 * The band endpoints and the stencil used to be compile-time constants, which fixed the
 * pattern CLASS and the pattern's symmetry for every document carrying this kernel. They
 * are `struct Params` now, and every `@default` is the constant it replaced (§T1184), so a
 * document that sets nothing — E2 — computes exactly what it computed before: the stencil
 * arithmetic below is written so that at `shape = 0`, `anisotropy = 0` it is the original
 * expression term for term, and E2's claims pin its pixels.
 *
 * `morph` is THE BAND axis: it slides the band's LOW endpoint along a straight path from
 * where the default puts it toward the HOLES regime at F 0.039, k 0.058 — negative spots
 * in a foam, the Voronoi look. The HIGH endpoint does not move: it is the corner E24 pins
 * its empty field to (chemistry 1 outside the dish decays to nothing), and a morph that
 * carried it would either wake the dead corner or, going the other way, park the low end
 * in the uniform-V fixed point two thousandths below the holes regime. The path was
 * MEASURED, not inherited (§V554): the claim that the field is alive along all of it and
 * dead at the high corner at every morph is in `reaction-diffusion-claims.gpu.test.ts`.
 *
 * `shape` is THE STENCIL axis. The 9-tap Laplacian's cross/diagonal split decides which
 * directions a front finds cheapest: cross-heavy (0.25 / 0) is the 5-point stencil, whose
 * discretisation error is lattice-aligned and squares the blobs; isotropic (0.2 / 0.05) is
 * round; diagonal-heavy (0.05 / 0.2) rotates the square by 45°. `anisotropy` makes
 * D_x ≠ D_y: cross weight moves from one pair of the cross to the other, so the MEAN
 * diffusion (and the pattern scale) does not change, only its elongation — along x for
 * positive values, along y for negative. It is a SIGN, not an angle: see the note at the
 * term for the three angle formulations that were measured and rejected. The stretch is
 * clamped inside the kernel to keep the explicit step stable, and past ±0.5 the stripes
 * are stable where spots are not, so the high end of the band no longer dies (measured:
 * at ±1 chemistry 1 keeps 12 % cover after 600 frames; at ±0.5 it is empty from 0.9 up).
 */
export const GRAY_SCOTT_WGSL = `struct Params {
  feedLow: f32,    // @default 0.028  feed at chemistry 0 — the labyrinth end of the band
  killLow: f32,    // @default 0.0545  kill at chemistry 0
  feedHigh: f32,   // @default 0.042  feed at chemistry 1 — the spot end of the band
  killHigh: f32,   // @default 0.068  kill at chemistry 1
  morph: f32,      // @default 0  0..1 slides the band's LOW end toward the holes regime (F 0.039, k 0.058): the foam / Voronoi look. Drive it SLOWLY.
  shape: f32,      // @default 0  -1 lattice-aligned stencil (squarish blobs) · 0 isotropic (round) · 1 diagonal stencil (rotated square)
  anisotropy: f32, // @default 0  -1..1 how much faster diffusion runs along x (positive) or y (negative) than across — elongated, stripey. Past ±0.5 the stripes outlive the spot end of the band.
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

// Where \`morph = 1\` puts the band's LOW endpoint. Only the low end travels: the high end
// is the corner E24 pins its empty field to (chemistry 1 outside the dish decays to
// nothing), and it has to stay dead at every morph. Measured along the path (T1237):
// the holes regime is narrow, and 0.002 lower in feed is the uniform-V fixed point.
const HOLES_FEED: f32 = 0.039;
const HOLES_KILL: f32 = 0.058;

// The most \`anisotropy\` may move between the cross pairs: at 0.6 the slow pair keeps a
// positive weight at every \`shape\` (cross · 0.4), and the explicit step stays inside its
// stability margin at DIFFUSE_U with \`shape\` at either extreme (measured, T1237).
const ANISOTROPY_LIMIT: f32 = 0.6;

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

  // THE BAND (T1237). \`morph\` carries the band's LOW endpoint toward the holes regime and
  // leaves the high one where it is; at morph 0 each mix returns its first argument
  // exactly, which is the default band.
  let morph = clamp(params.morph, 0.0, 1.0);
  let feedLow = mix(params.feedLow, HOLES_FEED, morph);
  let killLow = mix(params.killLow, HOLES_KILL, morph);

  // THE CHEMISTRY MAP. b is a 0..1 coordinate the graph paints per pixel; the band it
  // walks is the pair of endpoints above. A constant map is uniform chemistry exactly.
  let chemistry = clamp(centre.b, 0.0, 1.0);
  let feed = mix(feedLow, params.feedHigh, chemistry);
  let kill = mix(killLow, params.killHigh, chemistry);

  let state = centre.rg;

  // THE STENCIL (T1237). Cross and diagonal weights always sum to 1 (four of each), so the
  // operator still annihilates a constant field; at shape 0 the two products are 0.2 and
  // 0.05 exactly and the expression is the isotropic 9-tap it replaced, term for term.
  let shape = clamp(params.shape, -1.0, 1.0);
  let swing = select(0.15, 0.05, shape < 0.0);
  let cross = 0.2 - (swing * shape);
  let diagonal = 0.05 + (swing * shape);
  let isotropic =
    ((west + east + south + north) * cross) + ((sw + se + nw + ne) * diagonal) - state;

  // THE ANISOTROPY (T1237): cross weight moved from one pair of the cross to the other, so
  // diffusion runs faster along x (positive) or y (negative) than across it while the
  // total weight — the mean diffusion, and with it the pattern scale — stays what the
  // isotropic split put there. At anisotropy 0 the term is zero and the sum above is
  // untouched. Only the two lattice directions are offered: an axis ANGLE was built three
  // ways (a traceless tensor on these taps, the whole stencil turned through linearly
  // filtered taps, turned taps for this term alone at 1, 2 and 3 texels' reach) and in
  // every one the stripes snapped to the lattice at 30° and 60° and went round at 45° —
  // at the ~5 px scale of these fronts the lattice decides the direction, and a knob that
  // answers only 0° and 90° is honest as a sign, not as an angle.
  let stretch = clamp(params.anisotropy, -1.0, 1.0) * ANISOTROPY_LIMIT;
  let laplacian = isotropic + ((cross * stretch) * ((west + east) - (south + north)));

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

/**
 * The knobs at their `@default`s — the constants they replaced (T1237). A shipped document
 * STORES these rather than inheriting them (§V920, `declared-defaults.test.ts`), and this
 * is the one place the numbers are spelled outside the struct; E2's concept test holds
 * them to the source's own `@default`s.
 */
export const GRAY_SCOTT_DEFAULTS = {
  feedLow: 0.028,
  killLow: 0.0545,
  feedHigh: 0.042,
  killHigh: 0.068,
  morph: 0,
  shape: 0,
  anisotropy: 0,
} as const;
