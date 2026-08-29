import { WGSL_CHANNEL } from "./common.wgsl.ts";

/**
 * Fragment shaders for the compositing family: Over, Add, Multiply, Screen, Difference,
 * and Mask (T40).
 *
 * ALPHA CONVENTION, decided once for the whole catalogue: STRAIGHT (non-premultiplied)
 * alpha. Colour channels carry colour, alpha carries coverage, and the two are combined
 * only when compositing. TouchDesigner makes the same choice — it has an explicit
 * Premultiply TOP, which only makes sense if the default is not premultiplied. Every node
 * in this catalogue that writes alpha writes it straight.
 *
 * COLOUR (§V56): all six operate on LINEAR working-space values. Adding or multiplying
 * encoded values would give a different (and wrong) picture, which is the practical reason
 * the working space is linear in the first place.
 */

/**
 * Builds one blend node's shader from the expression that combines the two inputs.
 *
 * A factory rather than five hand-written copies: the five differ by one line, and the
 * parts they share — binding layout, opacity handling, the alpha rule — are exactly the
 * parts that must not drift between them. The generated text still differs per node, so
 * each keeps its own pass signature and nothing is branched at runtime.
 *
 * `expr` is a WGSL expression over `front` and `back` (both `vec4f`, straight alpha, with
 * `front` already scaled by `opacity`) producing the result `vec4f`.
 */
export function blendFragmentWgsl(expr: string): string {
  return `struct Params {
  opacity: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var frontTexture: texture_2d<f32>;
@group(0) @binding(3) var backTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let front = textureSampleLevel(frontTexture, inputSampler, uv, 0.0) * clamp(params.opacity, 0.0, 1.0);
  let back = textureSampleLevel(backTexture, inputSampler, uv, 0.0);
  return ${expr};
}`;
}

/**
 * Source-over with straight alpha.
 *
 * The division is what "straight" costs: the weighted sum is premultiplied, so it has to
 * be divided back out by the resulting alpha. Guarded against a fully transparent result,
 * where the colour is arbitrary anyway.
 */
export const OVER_BLEND_EXPR = `compositeOver(front, back)`;

export const OVER_FRAGMENT_WGSL = `fn compositeOver(front: vec4f, back: vec4f) -> vec4f {
  let outAlpha = front.a + (back.a * (1.0 - front.a));
  let rgb = (front.rgb * front.a) + ((back.rgb * back.a) * (1.0 - front.a));
  return vec4f(rgb / max(outAlpha, 1e-6), outAlpha);
}

${blendFragmentWgsl(OVER_BLEND_EXPR)}`;

/**
 * The arithmetic operators work per channel across RGBA, as TD's Composite TOP does —
 * adding two images adds their alpha too. Only Over does coverage-aware compositing.
 */
export const ADD_FRAGMENT_WGSL = blendFragmentWgsl(`front + back`);
export const MULTIPLY_FRAGMENT_WGSL = blendFragmentWgsl(`front * back`);
export const SCREEN_FRAGMENT_WGSL = blendFragmentWgsl(
  `vec4f(1.0) - ((vec4f(1.0) - front) * (vec4f(1.0) - back))`,
);
export const DIFFERENCE_FRAGMENT_WGSL = blendFragmentWgsl(`abs(front - back)`);

/**
 * Mask — multiply an image's coverage by a mask channel.
 *
 * The mask input is DATA: a coverage value, not light. It is read from one channel and
 * multiplies alpha only, leaving colour alone — with straight alpha that is exactly what
 * "mask" means, and it keeps the colour valid where coverage is partial.
 */
export const MASK_FRAGMENT_WGSL = `${WGSL_CHANNEL}

struct Params {
  channel: f32,
  invert: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var maskTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let field = textureSampleLevel(maskTexture, inputSampler, uv, 0.0);
  let raw = clamp(channelValue(field, params.channel), 0.0, 1.0);
  let coverage = mix(raw, 1.0 - raw, clamp(params.invert, 0.0, 1.0));
  return vec4f(source.rgb, source.a * coverage);
}`;
