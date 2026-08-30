import { WGSL_CHANNEL, WGSL_EXTEND } from "./common.wgsl.ts";

/**
 * Fragment shaders for Blur and Displace (T40).
 */

/**
 * Blur — TD's Blur TOP, as ONE AXIS of a separable pass pair (T147, T40).
 *
 * `dir` selects the axis, so the same shader is the horizontal leg (writing the node's
 * scratch target) and the vertical leg (reading it and writing the output). A 2D Gaussian
 * factorises exactly — G2(x,y) = G1(x) * G1(y) — and so does a box, so two 1D passes are
 * not an approximation of the 2D kernel, they ARE it.
 *
 * WHAT THIS REPLACED, and why the replacement is not just "faster". The single-pass
 * version sampled a fixed 9x9 grid whose SPACING grew with the filter size: 81 taps at
 * every size, which meant unit spacing at size 4 and 16-pixel gaps at size 64. Past a few
 * dozen pixels it stopped being a blur and started being a ghosting grid, silently. The
 * tap COUNT here is what scales instead, and the spacing stays at or below one pixel until
 * the cap is hit.
 *
 * TAP BUDGET, stated honestly. `taps` is taps per side, capped at 64 by the node, and
 * `stride` is the pixel distance between them. The node picks a span of 3 sigma for the
 * Gaussian (which is where a Gaussian has effectively ended) and the declared radius for
 * the box, then divides that span by the tap count. So:
 *
 *   - stride <= 1 px, i.e. the kernel is fully sampled, up to filter size 42 (Gaussian)
 *     and size 64 (box);
 *   - above that the stride widens as span/64, and the result is a resampled
 *     approximation — but it degrades linearly from a 129-tap-per-axis baseline rather
 *     than from a 9-tap one.
 *
 * Cost is now proportional to the size rather than fixed: the default size of 8 takes 2 x
 * 25 taps, where the old shader always took 81.
 */
export const BLUR_FRAGMENT_WGSL = `${WGSL_EXTEND}

// dir    (1,0) on the horizontal pass, (0,1) on the vertical one.
// stride pixels between adjacent taps; <= 1 until the node's tap cap is reached.
// taps   taps per side, so the loop runs 2 * taps + 1 times.
struct Params {
  texel: vec2f,
  dir: vec2f,
  size: f32,
  stride: f32,
  taps: f32,
  ftype: f32,
  extend: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let n = i32(params.taps + 0.5);
  // One pixel along this pass's axis, in uv units. The other axis contributes nothing.
  let step = params.dir * params.texel;
  // Same relation the single-pass version used, so an existing project blurs by the same
  // amount. The node's tap budget is derived from the SAME relation on the CPU.
  let sigma = max(max(params.size, 0.0) * 0.5, 1e-4);
  let falloff = -0.5 / (sigma * sigma);

  var acc = vec4f(0.0);
  var total = 0.0;
  for (var i = -n; i <= n; i = i + 1) {
    let offsetPx = f32(i) * params.stride;
    var weight = 1.0;
    if (params.ftype < 0.5) {
      weight = exp((offsetPx * offsetPx) * falloff);
    }
    let tap = sampleExtend(inputTexture, inputSampler, uv + (step * offsetPx), params.extend);
    acc = acc + (tap * weight);
    total = total + weight;
  }
  return acc / max(total, 1e-6);
}`;

/**
 * Displace — TD's Displace TOP.
 *
 * The displacement input is DATA, never colour (§V56): two of its channels are read as
 * signed offsets in uv units after the `offset` midpoint is subtracted. It must not be
 * colour-converted on its way in, which is why the node declares it as such rather than
 * treating both inputs the same.
 */
export const DISPLACE_FRAGMENT_WGSL = `${WGSL_EXTEND}
${WGSL_CHANNEL}

struct Params {
  weight: vec2f,
  offset: vec2f,
  sourcex: f32,
  sourcey: f32,
  extend: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var displaceTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let field = textureSampleLevel(displaceTexture, inputSampler, uv, 0.0);
  let shift = vec2f(
    channelValue(field, params.sourcex) - params.offset.x,
    channelValue(field, params.sourcey) - params.offset.y,
  );
  return sampleExtend(inputTexture, inputSampler, uv + (shift * params.weight), params.extend);
}`;

/**
 * Remap — absolute UV lookup (T279). TD's Remap TOP.
 *
 * The sibling of Displace, and the difference is the whole node: Displace reads the field
 * as an OFFSET added to the pixel's own coordinate, Remap reads it as the COORDINATE. So a
 * constant field collapses the source to a single pixel here, where in Displace it slides
 * the image sideways — that is the operation working, not a bug.
 *
 * WHICH WAY IS V, and why this is not TD's answer. Our fragment coordinate has v running
 * DOWN (v = 0 is the top row), and the UV generator writes exactly that coordinate into
 * green. This shader consumes the field the same way, so `uv -> Remap.map` is the identity
 * and nothing has to be flipped to make the catalogue's own generator work. TD's Remap TOP
 * documents the opposite convention for its input ("green: 0 = bottom row, 1 = top row"),
 * which is right for TD's bottom-up image space and wrong for ours. `flip` is the escape
 * hatch for a field authored under the other convention — a painted or imported map — and
 * costs one subtraction.
 *
 * The map is DATA, never colour (§V56): its values are positions. A gamma curve applied to
 * a coordinate moves the sample somewhere else entirely, which is the §V56 failure in its
 * purest form.
 */
export const REMAP_FRAGMENT_WGSL = `${WGSL_EXTEND}
${WGSL_CHANNEL}

struct Params {
  flip: vec2f,
  sourcex: f32,
  sourcey: f32,
  extend: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var mapTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let field = textureSampleLevel(mapTexture, inputSampler, uv, 0.0);
  let raw = vec2f(
    channelValue(field, params.sourcex),
    channelValue(field, params.sourcey),
  );
  // Absolute, not relative: the field IS the coordinate. Nothing adds uv here.
  let coord = select(raw, vec2f(1.0) - raw, params.flip > vec2f(0.5));
  return sampleExtend(inputTexture, inputSampler, coord, params.extend);
}`;

/**
 * Edge — Sobel gradient magnitude (T241). TD's Edge TOP.
 *
 * Per channel rather than on luminance, which is what TD does and what makes the node
 * useful for more than outlines: run it on a mask and you get that mask's boundary; run it
 * on a normal-ish texture and each channel's gradient is independently meaningful. A
 * luminance-only version throws that away and cannot be recovered downstream.
 *
 * Alpha is PASSED THROUGH, not differentiated. Under the straight-alpha convention (§V56)
 * alpha is coverage, and the edges of coverage are a different question from the edges of
 * colour — a fully opaque image would otherwise come back with zero alpha everywhere, which
 * is both surprising and useless.
 *
 * The magnitude is `sqrt(gx^2 + gy^2)`, the honest gradient length. Some implementations
 * use `|gx| + |gy|` because it is cheaper; that is anisotropic — it reports diagonal edges
 * up to 41% stronger than axis-aligned ones — and the saving is irrelevant on a GPU.
 */
export const EDGE_FRAGMENT_WGSL = `${WGSL_EXTEND}

struct Params {
  texel: vec2f,
  strength: f32,
  extend: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var gx = vec3f(0.0);
  var gy = vec3f(0.0);
  // Sobel: the 1-2-1 weighting is a smoothing kernel along the edge direction, which is
  // what makes it less noise-sensitive than a bare difference.
  let kx = array<f32, 9>(-1.0, 0.0, 1.0, -2.0, 0.0, 2.0, -1.0, 0.0, 1.0);
  let ky = array<f32, 9>(-1.0, -2.0, -1.0, 0.0, 0.0, 0.0, 1.0, 2.0, 1.0);
  for (var j = 0; j < 3; j = j + 1) {
    for (var i = 0; i < 3; i = i + 1) {
      let offset = vec2f(f32(i - 1), f32(j - 1)) * params.texel;
      let texel = sampleExtend(inputTexture, inputSampler, uv + offset, params.extend).rgb;
      let index = (j * 3) + i;
      gx = gx + (texel * kx[index]);
      gy = gy + (texel * ky[index]);
    }
  }
  let magnitude = sqrt((gx * gx) + (gy * gy)) * max(params.strength, 0.0);
  let source = sampleExtend(inputTexture, inputSampler, uv, params.extend);
  return vec4f(magnitude, source.a);
}`;

/**
 * Convolve — an arbitrary 3x3 kernel (T241). TD's Convolve TOP.
 *
 * The kernel arrives as three vec3 rows rather than nine scalars so that the inspector
 * shows it as a 3x3 grid, which is the only layout in which a kernel is readable. Nine
 * separately-named scalars would be technically identical and practically unusable.
 *
 * `normalize` divides by the kernel sum, which is what keeps a blur-shaped kernel from
 * changing the image's brightness. It is guarded against a zero sum because the useful
 * edge-detection kernels sum to exactly zero — and for those, normalising is meaningless
 * rather than an error, so the guard passes the raw result through instead of producing
 * infinities.
 *
 * `bias` is added after, which is how a zero-sum kernel's negative results are made
 * visible: an emboss kernel without a 0.5 bias is half black.
 */
export const CONVOLVE_FRAGMENT_WGSL = `${WGSL_EXTEND}

struct Params {
  texel: vec2f,
  row0: vec3f,
  row1: vec3f,
  row2: vec3f,
  normalize: f32,
  bias: f32,
  extend: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let rows = array<vec3f, 3>(params.row0, params.row1, params.row2);
  var sum = vec3f(0.0);
  var weight = 0.0;
  for (var j = 0; j < 3; j = j + 1) {
    let row = rows[j];
    for (var i = 0; i < 3; i = i + 1) {
      let k = row[i];
      let offset = vec2f(f32(i - 1), f32(j - 1)) * params.texel;
      sum = sum + (sampleExtend(inputTexture, inputSampler, uv + offset, params.extend).rgb * k);
      weight = weight + k;
    }
  }
  // A zero-sum kernel is the normal case for edge detection, not a mistake, so normalising
  // one passes the raw result through rather than dividing by nothing.
  let divisor = select(1.0, weight, (params.normalize > 0.5) && (abs(weight) > 1e-6));
  let source = sampleExtend(inputTexture, inputSampler, uv, params.extend);
  return vec4f((sum / divisor) + vec3f(params.bias), source.a);
}`;
