/**
 * WGSL fragments shared by the core node catalogue (T40, T70).
 *
 * Each export is a self-contained block of WGSL declarations, composed into a shader by
 * template interpolation. They live here rather than being duplicated per node so that
 * "what luminance means" or "what mirror-extend means" has exactly one definition to be
 * right or wrong about.
 *
 * Two rules every fragment here obeys:
 *  - Sampling is always `textureSampleLevel(..., 0.0)`, never `textureSample`. Our targets
 *    are single-mip, so the implicit-derivative form buys nothing, and several nodes sample
 *    inside loops or after a branch where WGSL's uniformity analysis rejects the implicit
 *    form outright.
 *  - Bitwise operands are always fully parenthesised. WGSL's grammar does not let a bitwise
 *    operator sit next to an arithmetic one without parentheses, unlike C.
 */

/**
 * Rec.709 luminance.
 *
 * These weights are only correct for LINEAR light, which is exactly the working space
 * (§V56) — applying them to sRGB-encoded values, as most shader snippets on the internet
 * silently do, gives a noticeably wrong answer for saturated colours. Every node that
 * reduces a colour to one number (Threshold, Displace, Mask, Lookup) goes through here.
 */
export const WGSL_LUMA = `fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}`;

/**
 * Channel selection shared by every node with a "which channel drives this?" parameter.
 * Index order is fixed by `CHANNEL_OPTIONS` in `parameter-readers.ts`; the two must agree.
 */
export const WGSL_CHANNEL = `${WGSL_LUMA}
fn channelValue(c: vec4f, which: f32) -> f32 {
  switch (u32(which + 0.5)) {
    case 0u: { return luma(c.rgb); }
    case 1u: { return c.r; }
    case 2u: { return c.g; }
    case 3u: { return c.b; }
    default: { return c.a; }
  }
}`;

/**
 * Extend (wrap) modes, applied in the shader rather than on the sampler.
 *
 * The compiler emits ONE shared sampler for the whole plan (`clamp-to-edge`), so a node
 * that needs repeat or mirror cannot ask for a different sampler without changing the
 * resource model. Doing the wrap arithmetic on the coordinate is equivalent for our
 * single-mip targets and costs a few ALU ops.
 *
 * Index order is fixed by `EXTEND_OPTIONS` in `parameter-readers.ts`.
 */
export const WGSL_EXTEND = `fn extendCoord(uv: vec2f, mode: f32) -> vec2f {
  let m = u32(mode + 0.5);
  if (m == 1u) {
    return fract(uv);
  }
  if (m == 2u) {
    return vec2f(1.0) - abs((fract(uv * 0.5) * 2.0) - vec2f(1.0));
  }
  return clamp(uv, vec2f(0.0), vec2f(1.0));
}

fn sampleExtend(tex: texture_2d<f32>, smp: sampler, uv: vec2f, mode: f32) -> vec4f {
  let c = extendCoord(uv, mode);
  let value = textureSampleLevel(tex, smp, c, 0.0);
  let inside = all(uv >= vec2f(0.0)) && all(uv <= vec2f(1.0));
  let blanked = select(vec4f(0.0), value, inside);
  return select(value, blanked, u32(mode + 0.5) == 3u);
}`;

/**
 * RGB <-> HSV.
 *
 * Deliberately NOT preceded by an sRGB decode/encode: the input is already linear working
 * space (§V56), and a round trip through an encoding curve inside a colour node would be
 * exactly the silent conversion §V13 forbids. It does mean a hue rotation here is not
 * numerically identical to the same rotation in TouchDesigner when TD's project is set to
 * an 8-bit sRGB working format — the HSV node's doc comment states that explicitly.
 */
export const WGSL_HSV = `fn rgb2hsv(c: vec3f) -> vec3f {
  let maxc = max(c.r, max(c.g, c.b));
  let minc = min(c.r, min(c.g, c.b));
  let d = maxc - minc;
  var h = 0.0;
  if (d > 1e-8) {
    if (maxc == c.r) {
      h = (c.g - c.b) / d;
      if (h < 0.0) { h = h + 6.0; }
    } else if (maxc == c.g) {
      h = ((c.b - c.r) / d) + 2.0;
    } else {
      h = ((c.r - c.g) / d) + 4.0;
    }
    h = h / 6.0;
  }
  let s = select(0.0, d / maxc, maxc > 1e-8);
  return vec3f(h, s, maxc);
}

fn hsv2rgb(c: vec3f) -> vec3f {
  let h = fract(c.x) * 6.0;
  let i = floor(h);
  let f = h - i;
  let p = c.z * (1.0 - c.y);
  let q = c.z * (1.0 - (c.y * f));
  let t = c.z * (1.0 - (c.y * (1.0 - f)));
  switch (u32(i)) {
    case 0u: { return vec3f(c.z, t, p); }
    case 1u: { return vec3f(q, c.z, p); }
    case 2u: { return vec3f(p, c.z, t); }
    case 3u: { return vec3f(p, q, c.z); }
    case 4u: { return vec3f(t, p, c.z); }
    default: { return vec3f(c.z, p, q); }
  }
}`;

/**
 * Integer hashing for every procedural generator (§V45).
 *
 * A PCG-style finaliser rather than the ubiquitous `fract(sin(dot(...)) * 43758.5)`: the
 * sine trick is transcendental-precision dependent, so it produces DIFFERENT pixels on
 * different GPUs. §V45 requires the same seed and frame to give the same output on any
 * device, and browser/headless parity (§V47) is only testable if that holds. Integer
 * arithmetic is exact everywhere.
 *
 * `bitcast<u32>` rather than `u32(...)` for the lattice coordinates: converting a negative
 * i32 with a value conversion is a different (and less useful) operation than
 * reinterpreting its bits, and lattice coordinates go negative constantly.
 */
export const WGSL_HASH = `fn hashU32(x: u32) -> u32 {
  var s: u32 = (x * 747796405u) + 2891336453u;
  let r: u32 = (s >> 28u) + 4u;
  let t: u32 = (s >> r) ^ s;
  s = t * 277803737u;
  return (s >> 22u) ^ s;
}

fn hash2i(p: vec2i, seed: u32) -> u32 {
  let a = bitcast<u32>(p.x) * 73856093u;
  let b = bitcast<u32>(p.y) * 19349663u;
  return hashU32((a ^ b) ^ seed);
}

fn hash3i(p: vec3i, seed: u32) -> u32 {
  let a = bitcast<u32>(p.x) * 73856093u;
  let b = bitcast<u32>(p.y) * 19349663u;
  let c = bitcast<u32>(p.z) * 83492791u;
  return hashU32(((a ^ b) ^ c) ^ seed);
}

fn hash4i(p: vec4i, seed: u32) -> u32 {
  let a = bitcast<u32>(p.x) * 73856093u;
  let b = bitcast<u32>(p.y) * 19349663u;
  let c = bitcast<u32>(p.z) * 83492791u;
  let d = bitcast<u32>(p.w) * 50331653u;
  return hashU32((((a ^ b) ^ c) ^ d) ^ seed);
}

/** uint32 -> [0,1). Exact for the top 24 bits, which is all a gradient angle needs. */
fn unitFloat(h: u32) -> f32 {
  return f32(h) * (1.0 / 4294967296.0);
}`;

/**
 * 2D inverse TRS about a pivot, ordered by TD's Transform Order menu (`xord`).
 *
 * Image operators transform the IMAGE, but a fragment shader transforms the SAMPLE
 * COORDINATE, so what is applied here is the inverse of the parameter values in the
 * reverse of the declared order. Getting that backwards is the classic "my translate goes
 * the wrong way" bug, so it is written out per order rather than derived.
 *
 * Index order is fixed by `TRANSFORM_ORDER_OPTIONS` in `parameter-readers.ts`.
 */
export const WGSL_TRANSFORM2D = `fn invScale2(q: vec2f, s: vec2f) -> vec2f {
  let safe = select(s, vec2f(1e-6), abs(s) < vec2f(1e-6));
  return q / safe;
}

fn invRotate2(q: vec2f, radians: f32) -> vec2f {
  let c = cos(-radians);
  let s = sin(-radians);
  return vec2f((q.x * c) - (q.y * s), (q.x * s) + (q.y * c));
}

/** Maps a point in output space back to the point in input space it samples from. */
fn invTransform2(point: vec2f, t: vec2f, radians: f32, s: vec2f, pivot: vec2f, xord: f32) -> vec2f {
  var q = point - pivot;
  switch (u32(xord + 0.5)) {
    case 0u: { q = q - t; q = invRotate2(q, radians); q = invScale2(q, s); }
    case 1u: { q = invRotate2(q, radians); q = q - t; q = invScale2(q, s); }
    case 2u: { q = q - t; q = invScale2(q, s); q = invRotate2(q, radians); }
    case 3u: { q = invScale2(q, s); q = q - t; q = invRotate2(q, radians); }
    case 4u: { q = invRotate2(q, radians); q = invScale2(q, s); q = q - t; }
    default: { q = invScale2(q, s); q = invRotate2(q, radians); q = q - t; }
  }
  return q + pivot;
}`;
