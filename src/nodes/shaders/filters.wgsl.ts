import { WGSL_CHANNEL, WGSL_EXTEND } from "./common.wgsl.ts";

/**
 * Fragment shaders for Blur and Displace (T40).
 */

/**
 * Blur — TD's Blur TOP, as a SINGLE pass.
 *
 * A separable Gaussian is two passes with an intermediate target between them, and a node
 * definition cannot allocate one: the compiler assigns exactly one resource per declared,
 * materialized output port (§V8, §V29 of the resource model), and a scratch target is not
 * expressible in the plan IR today. So this samples a fixed 9x9 grid whose SPACING scales
 * with the filter size, rather than a fixed-radius kernel.
 *
 * What that costs: 81 taps regardless of size (a separable pair would be 2 * (2r+1)), and
 * visible under-sampling once the size grows past a few dozen pixels, because the grid
 * stays 9x9 while the spacing grows. What it buys: a blur that exists, is correct at the
 * sizes people actually use for a preview, and needs nothing from another track.
 *
 * The fix when it matters is a scratch-target kind in the plan IR, at which point this
 * becomes two passes and the shader keeps its structure.
 */
export const BLUR_FRAGMENT_WGSL = `${WGSL_EXTEND}

struct Params {
  texel: vec2f,
  size: f32,
  ftype: f32,
  extend: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let radius = max(params.size, 0.0);
  let spacing = radius / 4.0;
  let sigma = max(radius * 0.5, 1e-4);
  let falloff = -0.5 / (sigma * sigma);

  var acc = vec4f(0.0);
  var total = 0.0;
  for (var j = -4; j <= 4; j = j + 1) {
    for (var i = -4; i <= 4; i = i + 1) {
      let offsetPx = vec2f(f32(i), f32(j)) * spacing;
      var weight = 1.0;
      if (params.ftype < 0.5) {
        weight = exp(dot(offsetPx, offsetPx) * falloff);
      }
      let tap = sampleExtend(inputTexture, inputSampler, uv + (offsetPx * params.texel), params.extend);
      acc = acc + (tap * weight);
      total = total + weight;
    }
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
