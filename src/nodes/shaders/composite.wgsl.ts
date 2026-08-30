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
 * The Porter-Duff family, as ONE function and a pair of coverage weights (T282).
 *
 * Every compositing operator in the algebra is the same weighted sum of premultiplied
 * colour — `Ap*fa + Bp*fb` — and differs only in what `fa` and `fb` are. Writing six
 * shaders would be writing the same three lines six times and inviting exactly the drift
 * §V140 exists to prevent; writing the weights down instead makes the whole family a table.
 *
 *   over     fa = 1        fb = 1 - a.a     the default: A on top of B
 *   under    fa = 1 - b.a  fb = 1           B on top of A (Porter-Duff "dst-over")
 *   inside   fa = b.a      fb = 0           A, clipped to where B is opaque ("src-in")
 *   outside  fa = 1 - b.a  fb = 0           A, only where B is NOT ("src-out")
 *   atop     fa = b.a      fb = 1 - a.a     A over B but confined to B's shape
 *   xor      fa = 1 - b.a  fb = 1 - a.a     each where the other is not
 *
 * The division at the end is what STRAIGHT alpha costs: the sum is premultiplied, so it
 * has to be divided back out. Guarded against a fully transparent result, where the colour
 * is arbitrary anyway.
 */
const PORTER_DUFF_WGSL = `fn porterDuff(front: vec4f, back: vec4f, fa: f32, fb: f32) -> vec4f {
  let outAlpha = (front.a * fa) + (back.a * fb);
  let rgb = ((front.rgb * front.a) * fa) + ((back.rgb * back.a) * fb);
  return vec4f(rgb / max(outAlpha, 1e-6), outAlpha);
}`;

/** Builds one Porter-Duff operator from its coverage weights. */
function porterDuffFragmentWgsl(fa: string, fb: string): string {
  return `${PORTER_DUFF_WGSL}

${blendFragmentWgsl(`porterDuff(front, back, ${fa}, ${fb})`)}`;
}

export const OVER_FRAGMENT_WGSL = porterDuffFragmentWgsl("1.0", "1.0 - front.a");
export const UNDER_FRAGMENT_WGSL = porterDuffFragmentWgsl("1.0 - back.a", "1.0");
export const INSIDE_FRAGMENT_WGSL = porterDuffFragmentWgsl("back.a", "0.0");
export const OUTSIDE_FRAGMENT_WGSL = porterDuffFragmentWgsl("1.0 - back.a", "0.0");
export const ATOP_FRAGMENT_WGSL = porterDuffFragmentWgsl("back.a", "1.0 - front.a");
export const XOR_FRAGMENT_WGSL = porterDuffFragmentWgsl("1.0 - back.a", "1.0 - front.a");

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
 * Cross — dissolve between two inputs by a factor (T234). TD's Cross TOP.
 *
 * Deliberately NOT one of the Composite operations. Every entry in that menu is a fixed
 * function of two pixels; Cross is a function of two pixels AND a parameter, and that
 * parameter is the entire point — it is the thing you animate to dissolve between two
 * chains. Putting it in the menu would give it a control the other operations do not have
 * and hide the one thing it is for.
 *
 * `cross` is 0 at input 1 and 1 at input 2, matching TD. A straight `mix` across RGBA is
 * right here even though the arithmetic operators are per-channel by convention: a
 * dissolve interpolates coverage as well as colour, so a transparent image crossing into
 * an opaque one becomes progressively more opaque.
 */
export const CROSS_FRAGMENT_WGSL = `struct Params {
  cross: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var frontTexture: texture_2d<f32>;
@group(0) @binding(3) var backTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let a = textureSampleLevel(frontTexture, inputSampler, uv, 0.0);
  let b = textureSampleLevel(backTexture, inputSampler, uv, 0.0);
  return mix(a, b, clamp(params.cross, 0.0, 1.0));
}`;

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
