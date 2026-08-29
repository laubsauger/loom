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
