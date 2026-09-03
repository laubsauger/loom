import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";
import { WGSL_HASH } from "./common.wgsl.ts";

/**
 * The Noise fragment shader (T70).
 *
 * ONE shader for every noise type, selected by the `ntype` uniform rather than by
 * generating a different source per type. A uniform switch keeps a type change to a
 * uniform write (§V5) — regenerating the source would rebuild the pipeline every time
 * someone auditions a type from the menu, which is precisely the interaction this node
 * is used through.
 *
 * TIME (§V44, §V436, T497): the fourth noise dimension is `t4d + frameU.absTime * speed`,
 * where `frameU` is the shared uniform block the runtime fills from `FrameEvaluationInput`.
 * There is no other clock reachable from here — that is what makes a timeline, a fixed-step
 * offline render and a headless parity test all produce the same frames.
 *
 * FREE-RUNNING, and it is a decision rather than a default. Scrolling noise is the thing
 * people reach for when they want "always going": the same call the LFO got in B98. On
 * `frameU.time` — the TIMELINE clock, which wraps at the out point once a piece is bounded
 * (T455) — the whole field snapped back to its frame-zero slice at every lap, so any noise
 * with `speed != 0` had a visible seam with the period of the loop. Seven shipped examples
 * were on the wrong side of that. `absTime` keeps counting through a lap (T461), so the
 * field scrolls through the loop boundary as if it were not there.
 *
 * Still deterministic (§V44/§V47): `absTime` is a frame COUNT at the timeline rate, never a
 * wall reading, and a RENDER zeroes it first (T467) — so a take reproduces frame for frame.
 * A noise node that wants to wrap with the piece sets `speed` to 0 and drives `t4d` from an
 * expression on `time`, which is the timeline-anchored reading spelled out loud.
 *
 * SEED (§V45): `params.seed` is a uint32 folded on the CPU from the node's `seed`
 * parameter with the domain's own `hashSeed`, and it is XORed here with the project seed
 * carried in the shared block. Nothing samples a hardware RNG; every value is an integer
 * hash of (lattice cell, seed), so frame 900 is reproducible without evaluating frame 899
 * and two machines agree bit-for-bit.
 */

/** Noise types, in the order `baseNoise()` switches on. The manifest reuses this list. */
export const NOISE_TYPE_OPTIONS = [
  { value: "perlin2d", label: "Perlin 2D" },
  { value: "perlin3d", label: "Perlin 3D" },
  { value: "perlin4d", label: "Perlin 4D" },
  { value: "simplex2d", label: "Simplex 2D" },
  { value: "simplex3d", label: "Simplex 3D" },
  { value: "alligator", label: "Alligator" },
  { value: "random", label: "Random" },
] as const;

const GRADIENTS = `fn grad2(cell: vec2i, seed: u32) -> vec2f {
  let a = unitFloat(hash2i(cell, seed)) * 6.28318530718;
  return vec2f(cos(a), sin(a));
}

fn grad3(cell: vec3i, seed: u32) -> vec3f {
  let h = hash3i(cell, seed);
  let a = unitFloat(h) * 6.28318530718;
  let z = (unitFloat(hashU32(h ^ 0x9e3779b9u)) * 2.0) - 1.0;
  let r = sqrt(max(0.0, 1.0 - (z * z)));
  return vec3f(r * cos(a), r * sin(a), z);
}

fn grad4(cell: vec4i, seed: u32) -> vec4f {
  let h0 = hash4i(cell, seed);
  let h1 = hashU32(h0 ^ 0x9e3779b9u);
  let h2 = hashU32(h1 ^ 0x85ebca6bu);
  let h3 = hashU32(h2 ^ 0xc2b2ae35u);
  let v = vec4f(
    (unitFloat(h0) * 2.0) - 1.0,
    (unitFloat(h1) * 2.0) - 1.0,
    (unitFloat(h2) * 2.0) - 1.0,
    (unitFloat(h3) * 2.0) - 1.0,
  );
  return v / max(length(v), 1e-4);
}`;

const PERLIN = `fn quintic(f: vec4f) -> vec4f {
  return f * f * f * ((f * ((f * 6.0) - 15.0)) + 10.0);
}

fn perlin2(p: vec2f, seed: u32) -> f32 {
  let base = floor(p);
  let cell = vec2i(base);
  let f = p - base;
  let u = quintic(vec4f(f, 0.0, 0.0)).xy;
  let g00 = dot(grad2(cell + vec2i(0, 0), seed), f - vec2f(0.0, 0.0));
  let g10 = dot(grad2(cell + vec2i(1, 0), seed), f - vec2f(1.0, 0.0));
  let g01 = dot(grad2(cell + vec2i(0, 1), seed), f - vec2f(0.0, 1.0));
  let g11 = dot(grad2(cell + vec2i(1, 1), seed), f - vec2f(1.0, 1.0));
  return mix(mix(g00, g10, u.x), mix(g01, g11, u.x), u.y) * 1.4142;
}

fn perlin3(p: vec3f, seed: u32) -> f32 {
  let base = floor(p);
  let cell = vec3i(base);
  let f = p - base;
  let u = quintic(vec4f(f, 0.0)).xyz;
  var acc = 0.0;
  for (var k = 0u; k < 8u; k = k + 1u) {
    let o = vec3f(f32(k & 1u), f32((k >> 1u) & 1u), f32((k >> 2u) & 1u));
    let w = mix(vec3f(1.0) - u, u, o);
    acc = acc + ((w.x * w.y * w.z) * dot(grad3(cell + vec3i(o), seed), f - o));
  }
  return acc * 1.1547;
}

fn perlin4(p: vec4f, seed: u32) -> f32 {
  let base = floor(p);
  let cell = vec4i(base);
  let f = p - base;
  let u = quintic(f);
  var acc = 0.0;
  for (var k = 0u; k < 16u; k = k + 1u) {
    let o = vec4f(
      f32(k & 1u),
      f32((k >> 1u) & 1u),
      f32((k >> 2u) & 1u),
      f32((k >> 3u) & 1u),
    );
    let w = mix(vec4f(1.0) - u, u, o);
    acc = acc + (((w.x * w.y) * (w.z * w.w)) * dot(grad4(cell + vec4i(o), seed), f - o));
  }
  return acc * 1.2;
}`;

/**
 * Simplex noise, in the Perlin/Gustavson formulation: skew into a simplex lattice, sum a
 * radially-windowed gradient contribution per corner. Falloff radii (0.5 in 2D, 0.6 in 3D)
 * and the output scales (130, 42) are the standard pairings for unit-length gradients —
 * they are what make the result land in roughly [-1, 1], and changing one without the
 * other produces a washed-out or clipped field.
 */
const SIMPLEX = `fn corner2(x: vec2f, cell: vec2i, seed: u32) -> f32 {
  let t = 0.5 - dot(x, x);
  if (t < 0.0) { return 0.0; }
  let t2 = t * t;
  return (t2 * t2) * dot(grad2(cell, seed), x);
}

fn simplex2(p: vec2f, seed: u32) -> f32 {
  let f2 = 0.3660254037844386;
  let g2 = 0.21132486540518713;
  let skew = (p.x + p.y) * f2;
  let base = floor(p + vec2f(skew));
  let unskew = (base.x + base.y) * g2;
  let x0 = (p - base) + vec2f(unskew);
  var o = vec2f(1.0, 0.0);
  if (x0.y > x0.x) { o = vec2f(0.0, 1.0); }
  let x1 = (x0 - o) + vec2f(g2);
  let x2 = (x0 - vec2f(1.0)) + vec2f(2.0 * g2);
  let cell = vec2i(base);
  var n = corner2(x0, cell, seed);
  n = n + corner2(x1, cell + vec2i(o), seed);
  n = n + corner2(x2, cell + vec2i(1, 1), seed);
  return n * 130.0;
}

fn corner3(x: vec3f, cell: vec3i, seed: u32) -> f32 {
  let t = 0.6 - dot(x, x);
  if (t < 0.0) { return 0.0; }
  let t2 = t * t;
  return (t2 * t2) * dot(grad3(cell, seed), x);
}

fn simplex3(p: vec3f, seed: u32) -> f32 {
  let f3 = 0.3333333333333333;
  let g3 = 0.16666666666666666;
  let skew = (p.x + p.y + p.z) * f3;
  let base = floor(p + vec3f(skew));
  let unskew = (base.x + base.y + base.z) * g3;
  let x0 = (p - base) + vec3f(unskew);

  var o1 = vec3f(0.0);
  var o2 = vec3f(0.0);
  if (x0.x >= x0.y) {
    if (x0.y >= x0.z) {
      o1 = vec3f(1.0, 0.0, 0.0); o2 = vec3f(1.0, 1.0, 0.0);
    } else if (x0.x >= x0.z) {
      o1 = vec3f(1.0, 0.0, 0.0); o2 = vec3f(1.0, 0.0, 1.0);
    } else {
      o1 = vec3f(0.0, 0.0, 1.0); o2 = vec3f(1.0, 0.0, 1.0);
    }
  } else {
    if (x0.y < x0.z) {
      o1 = vec3f(0.0, 0.0, 1.0); o2 = vec3f(0.0, 1.0, 1.0);
    } else if (x0.x < x0.z) {
      o1 = vec3f(0.0, 1.0, 0.0); o2 = vec3f(0.0, 1.0, 1.0);
    } else {
      o1 = vec3f(0.0, 1.0, 0.0); o2 = vec3f(1.0, 1.0, 0.0);
    }
  }

  let x1 = (x0 - o1) + vec3f(g3);
  let x2 = (x0 - o2) + vec3f(2.0 * g3);
  let x3 = (x0 - vec3f(1.0)) + vec3f(3.0 * g3);
  let cell = vec3i(base);
  var n = corner3(x0, cell, seed);
  n = n + corner3(x1, cell + vec3i(o1), seed);
  n = n + corner3(x2, cell + vec3i(o2), seed);
  n = n + corner3(x3, cell + vec3i(1, 1, 1), seed);
  return n * 42.0;
}`;

/**
 * Worley (cellular) F1 distance, our stand-in for TD's Alligator noise: one feature point
 * per lattice cell, distance to the nearest one over the 3x3 neighbourhood. Inverted so
 * cell centres are bright, which is what Alligator looks like.
 */
const WORLEY = `fn worley2(p: vec2f, seed: u32) -> f32 {
  let base = floor(p);
  let cell = vec2i(base);
  let f = p - base;
  var best = 8.0;
  for (var j = -1; j <= 1; j = j + 1) {
    for (var i = -1; i <= 1; i = i + 1) {
      let neighbour = cell + vec2i(i, j);
      let h = hash2i(neighbour, seed);
      let feature = vec2f(unitFloat(h), unitFloat(hashU32(h ^ 0x68bc21ebu)));
      let d = (vec2f(f32(i), f32(j)) + feature) - f;
      best = min(best, dot(d, d));
    }
  }
  return sqrt(best);
}`;

export const NOISE_FRAGMENT_WGSL = `${SHARED_UNIFORMS_WGSL}
${WGSL_HASH}
${GRADIENTS}
${PERLIN}
${SIMPLEX}
${WORLEY}

struct Params {
  seed: u32,
  ntype: f32,
  period: f32,
  harmon: f32,
  spread: f32,
  gain: f32,
  rough: f32,
  expo: f32,
  amp: f32,
  offset: f32,
  mono: f32,
  aspect: f32,
  rot: f32,
  xord: f32,
  speed: f32,
  t4d: f32,
  s4d: f32,
  t: vec3f,
  s: vec3f,
  piv: vec3f,
};

@group(0) @binding(0) var<uniform> frameU: SharedFrame;
@group(0) @binding(1) var<uniform> params: Params;

fn invScale3(q: vec3f) -> vec3f {
  let safe = select(params.s, vec3f(1e-6), abs(params.s) < vec3f(1e-6));
  return q / safe;
}

/** Only the uv plane rotates: the field has a single rotation axis, so no rotate order. */
fn invRotate3(q: vec3f) -> vec3f {
  let c = cos(-params.rot);
  let s = sin(-params.rot);
  return vec3f((q.x * c) - (q.y * s), (q.x * s) + (q.y * c), q.z);
}

fn invTranslate3(q: vec3f) -> vec3f {
  return q - params.t;
}

/** Inverse of the parameter transform, in the reverse of TD's Transform Order (xord). */
fn invTransform3(point: vec3f) -> vec3f {
  var q = point - params.piv;
  switch (u32(params.xord + 0.5)) {
    case 0u: { q = invTranslate3(q); q = invRotate3(q); q = invScale3(q); }
    case 1u: { q = invRotate3(q); q = invTranslate3(q); q = invScale3(q); }
    case 2u: { q = invTranslate3(q); q = invScale3(q); q = invRotate3(q); }
    case 3u: { q = invScale3(q); q = invTranslate3(q); q = invRotate3(q); }
    case 4u: { q = invRotate3(q); q = invScale3(q); q = invTranslate3(q); }
    default: { q = invScale3(q); q = invRotate3(q); q = invTranslate3(q); }
  }
  return q + params.piv;
}

fn baseNoise(q: vec4f, seed: u32) -> f32 {
  switch (u32(params.ntype + 0.5)) {
    case 0u: { return perlin2(q.xy, seed); }
    case 1u: { return perlin3(q.xyz, seed); }
    case 2u: { return perlin4(q, seed); }
    case 3u: { return simplex2(q.xy, seed); }
    case 4u: { return simplex3(q.xyz, seed); }
    case 5u: { return 1.0 - (2.0 * clamp(worley2(q.xy, seed), 0.0, 1.0)); }
    default: { return (unitFloat(hash4i(vec4i(floor(q)), seed)) * 2.0) - 1.0; }
  }
}

/**
 * Fractal summation. 'spread' is the frequency multiplier per harmonic (lacunarity) and
 * 'gain' the amplitude multiplier (persistence); 'rough' adds a spectral-slope term, so
 * rough = 0 is pure gain decay and rough = 1 adds a further 1/f falloff.
 */
fn field(q: vec4f, seed: u32) -> f32 {
  let spread = max(params.spread, 1e-3);
  let octaves = u32(clamp(params.harmon, 0.0, 8.0) + 0.5);
  let decay = params.gain * pow(spread, -params.rough);
  var sum = 0.0;
  var norm = 0.0;
  var freq = 1.0;
  var ampl = 1.0;
  for (var i = 0u; i <= octaves; i = i + 1u) {
    sum = sum + (ampl * clamp(baseNoise(q * freq, seed + (i * 1013u)), -1.0, 1.0));
    norm = norm + abs(ampl);
    freq = freq * spread;
    ampl = ampl * decay;
  }
  return sum / max(norm, 1e-6);
}

/** Exponent, amplitude and offset, in TD's order. Centred so the default fills 0..1. */
fn shade(q: vec4f, seed: u32) -> f32 {
  let n = field(q, seed);
  let shaped = sign(n) * pow(abs(n), max(params.expo, 1e-3));
  return (0.5 + ((0.5 * shaped) * params.amp)) + params.offset;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Centred coordinates so rotation and scale pivot on the middle of the image, and the
  // x axis widened by the target's aspect so features stay square on a non-square output.
  let centred = (uv - vec2f(0.5)) * vec2f(params.aspect, 1.0);
  let placed = invTransform3(vec3f(centred, 0.0));
  // FREE-RUNNING (§V436, T497): absTime, not time. The timeline clock wraps at the out
  // point, and a scrolling field that snaps back there is the seam B98 found in the LFO.
  let w = (params.t4d + (frameU.absTime * params.speed)) / max(abs(params.s4d), 1e-6);
  let q = vec4f(placed, w) / max(abs(params.period), 1e-6);

  // The project seed rides in the shared block, so re-seeding a project re-seeds every
  // generator in it without touching a single node parameter (§V45).
  let seed = params.seed ^ u32(abs(frameU.randomSeed));

  if (params.mono > 0.5) {
    return vec4f(vec3f(shade(q, seed)), 1.0);
  }
  return vec4f(
    shade(q, seed),
    shade(q, seed ^ 0x51ed270bu),
    shade(q, seed ^ 0x1b56c4e9u),
    1.0,
  );
}`;
