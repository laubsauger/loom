import { WGSL_CHANNEL, WGSL_HSV } from "./common.wgsl.ts";

/**
 * Fragment shaders for the colour operators: Level, HSV, Threshold, Lookup (T40).
 *
 * COLOUR SPACE (§V56/§V57), stated once for all four: the working space is LINEAR, and
 * every operation below is applied to linear values. Nothing here decodes or encodes.
 * That is a real behavioural statement, not a formality — a "brightness" or a "gamma"
 * applied to linear light does not produce the same picture as the same control applied to
 * sRGB-encoded values, which is what a compositor with an 8-bit working format gives you.
 * The difference is visible in the midtones, so each node says which one it does.
 */

/**
 * Level — TD's Level TOP.
 *
 * Operation order, fixed and documented because it is the whole behaviour of the node:
 * black/white level remap, invert, gamma, contrast around mid-grey, brightness multiply,
 * then opacity on alpha. Alpha is otherwise untouched: brightening an image should not
 * change what it covers.
 */
export const LEVEL_FRAGMENT_WGSL = `struct Params {
  blacklevel: f32,
  whitelevel: f32,
  brightness: f32,
  gamma1: f32,
  contrast: f32,
  opacity: f32,
  invert: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

/** pow() is undefined for negative bases; linear HDR values go negative, so mirror it. */
fn signedPow(v: vec3f, e: f32) -> vec3f {
  return sign(v) * pow(abs(v), vec3f(e));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let span = params.whitelevel - params.blacklevel;
  var c = (source.rgb - vec3f(params.blacklevel)) / vec3f(select(span, 1e-6, abs(span) < 1e-6));
  c = mix(c, vec3f(1.0) - c, clamp(params.invert, 0.0, 1.0));
  c = signedPow(c, 1.0 / max(params.gamma1, 1e-3));
  c = ((c - vec3f(0.5)) * params.contrast) + vec3f(0.5);
  c = c * params.brightness;
  return vec4f(c, source.a * params.opacity);
}`;

/**
 * HSV — TD's HSV Adjust TOP.
 *
 * The conversion is LINEAR RGB <-> HSV, with no sRGB round trip (§V56). A hue rotation
 * here is therefore not numerically identical to the same rotation in a compositor working
 * in an encoded 8-bit space; it is the one consistent with every other node in this
 * catalogue, and a round trip through an encoding curve inside a colour node would be the
 * silent conversion §V13 forbids.
 */
export const HSV_FRAGMENT_WGSL = `${WGSL_HSV}

struct Params {
  hueoffset: f32,
  saturation: f32,
  value: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  var hsv = rgb2hsv(max(source.rgb, vec3f(0.0)));
  hsv.x = fract(hsv.x + params.hueoffset);
  hsv.y = clamp(hsv.y * params.saturation, 0.0, 1.0);
  hsv.z = hsv.z * params.value;
  return vec4f(hsv2rgb(hsv), source.a);
}`;

/**
 * Threshold — TD's Threshold TOP.
 *
 * The result is a MASK: the same value in rgb and in alpha, so it can drive Mask or be
 * composited as a matte without a channel-shuffling node in between. That makes the output
 * DATA in the §V56 sense even though it is shaped like a colour — noted on the port.
 */
export const THRESHOLD_FRAGMENT_WGSL = `${WGSL_CHANNEL}

struct Params {
  threshold: f32,
  softness: f32,
  channel: f32,
  compare: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let value = channelValue(source, params.channel);
  let edgeHalf = max(params.softness, 1e-5) * 0.5;
  let above = smoothstep(params.threshold - edgeHalf, params.threshold + edgeHalf, value);
  let mask = select(above, 1.0 - above, params.compare > 0.5);
  return vec4f(vec3f(mask), mask);
}`;

/**
 * Lookup — TD's Lookup TOP: remap one channel of the source through a lookup image.
 *
 * The two inputs mean DIFFERENT things and that shows up in the policies on the node:
 * `source` is read as DATA (a position along the ramp — its colour space is irrelevant and
 * must not be converted), while `lookup` is COLOUR, and the output carries the lookup's
 * colour, not the source's. Resolution therefore comes from `source` and format from
 * `lookup`, which is unusual enough to be stated in both places.
 */
export const LOOKUP_FRAGMENT_WGSL = `${WGSL_CHANNEL}

struct Params {
  channel: f32,
  row: f32,
  offset: f32,
  scale: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var lookupTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let index = (channelValue(source, params.channel) * params.scale) + params.offset;
  let coord = vec2f(clamp(index, 0.0, 1.0), clamp(params.row, 0.0, 1.0));
  return textureSampleLevel(lookupTexture, inputSampler, coord, 0.0);
}`;
