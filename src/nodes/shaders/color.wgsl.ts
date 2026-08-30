import { WGSL_CHANNEL, WGSL_HSV, WGSL_LUMA } from "./common.wgsl.ts";

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

/**
 * Limit — bound a value, or step it (T283). TD's Limit TOP.
 *
 * Four ways to deal with a value outside a range, and the difference between them is what
 * happens to the EXCESS. Clamp throws it away, loop wraps it, zigzag reflects it, and
 * quantize keeps the value in range but coarsens it. TD ships the same four for the same
 * reason: "out of range" has no single right answer, and the choices produce visibly
 * different pictures rather than being variations on a theme.
 *
 * Quantize is the one people arrive for without knowing its name: stepping a colour channel
 * IS posterisation. The step count is expressed as STEPS rather than as a step size because
 * "8 levels" is what someone means, and dividing 1.0 by it here rather than in the inspector
 * keeps the parameter honest at any range.
 *
 * Alpha is left alone. Limiting coverage is a different intent from limiting colour, and
 * quantizing alpha turns a soft edge into a stair — which is never what someone posterising
 * an image was asking for.
 */
export const LIMIT_FRAGMENT_WGSL = `struct Params {
  mode: f32,
  low: f32,
  high: f32,
  steps: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

fn limitChannel(value: f32, mode: u32, lo: f32, hi: f32, steps: f32) -> f32 {
  let span = max(hi - lo, 1e-6);
  if (mode == 1u) {
    // Loop: the value wraps, so a ramp becomes a sawtooth.
    return lo + (fract((value - lo) / span) * span);
  }
  if (mode == 2u) {
    // Zigzag: reflect on every other period, so the result is continuous where loop jumps.
    let t = abs(fract((value - lo) / (span * 2.0)) * 2.0 - 1.0);
    return lo + ((1.0 - t) * span);
  }
  if (mode == 3u) {
    // Quantize: floor to the nearest step, then rescale. Dividing by steps - 1 puts the
    // top step exactly at the maximum; dividing by steps would leave the brightest level
    // permanently unreachable, which reads as a washed-out posterise.
    let levels = max(floor(steps), 2.0);
    let t = clamp((value - lo) / span, 0.0, 1.0);
    return lo + (floor(t * (levels - 1.0) + 0.5) / (levels - 1.0)) * span;
  }
  return clamp(value, lo, hi);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let mode = u32(params.mode + 0.5);
  let rgb = vec3f(
    limitChannel(source.r, mode, params.low, params.high, params.steps),
    limitChannel(source.g, mode, params.low, params.high, params.steps),
    limitChannel(source.b, mode, params.low, params.high, params.steps),
  );
  return vec4f(rgb, source.a);
}`;

/**
 * Reorder — a two-input channel shuffle (T280). TD's Reorder TOP.
 *
 * The catalogue had NO way to move a value between channels: Level and HSV adjust a
 * channel in place, Mask reads one and writes alpha, and nothing could put a mask into
 * red, drop a broken alpha, or build an RGB image out of three separate masks. That is a
 * capability gap rather than a convenience, and it is what makes Slope's normal mode
 * expressible downstream (T284).
 *
 * ONE MENU PER OUTPUT CHANNEL, listing both inputs' channels plus one, zero and each
 * input's luminance. TD splits the same choice across two menus — Output Red picks the
 * input, Output Red Channel picks the channel, with the constants living in the first —
 * which is four extra menus for the same information. Folding them into one list makes a
 * channel move one click, and makes "one" and "zero" ordinary entries rather than special
 * cases hiding in an input menu. The index order is what the switch below reads, so
 * `REORDER_SOURCE_OPTIONS` and this function have to be edited together.
 *
 * Luminance is per-input (Input 1 Luminance, Input 2 Luminance) because with two images
 * wired in, "luminance" alone does not name an image.
 *
 * COLOUR (§V56): this moves NUMBERS. It applies no curve and no matrix, so it cannot
 * change the space its inputs are in — but it can change what the values MEAN, and that
 * is the user's intent: alpha routed into rgb is coverage being looked at, not light.
 */
export const REORDER_FRAGMENT_WGSL = `${WGSL_LUMA}

struct Params {
  outr: f32,
  outg: f32,
  outb: f32,
  outa: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;
@group(0) @binding(3) var input2Texture: texture_2d<f32>;

/** Index order is fixed by REORDER_SOURCE_OPTIONS in color.ts. */
fn reorderPick(a: vec4f, b: vec4f, which: f32) -> f32 {
  switch (u32(which + 0.5)) {
    case 0u: { return a.r; }
    case 1u: { return a.g; }
    case 2u: { return a.b; }
    case 3u: { return a.a; }
    case 4u: { return luma(a.rgb); }
    case 5u: { return b.r; }
    case 6u: { return b.g; }
    case 7u: { return b.b; }
    case 8u: { return b.a; }
    case 9u: { return luma(b.rgb); }
    case 10u: { return 1.0; }
    default: { return 0.0; }
  }
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let a = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let b = textureSampleLevel(input2Texture, inputSampler, uv, 0.0);
  return vec4f(
    reorderPick(a, b, params.outr),
    reorderPick(a, b, params.outg),
    reorderPick(a, b, params.outb),
    reorderPick(a, b, params.outa),
  );
}`;

/**
 * Premultiply / Unpremultiply (T281).
 *
 * WHAT IT IS FOR. The catalogue's alpha is STRAIGHT everywhere (§V56): colour channels
 * carry colour at full strength, alpha carries coverage, and the two meet only in a
 * composite. That convention keeps colour valid where coverage is partial — but every
 * neighbourhood filter breaks on it. A Blur over a cutout averages the colour of pixels
 * that are not there, so a white shape on a transparent field grows a halo of whatever
 * garbage the transparent pixels happened to hold. Premultiplying first makes the
 * uncovered pixels contribute nothing, and unpremultiplying afterwards puts the colour
 * back on the straight-alpha footing the rest of the catalogue expects.
 *
 * ZERO COVERAGE RETURNS ZERO on the way back. `rgb / a` has no answer where a is 0 — there
 * was no colour there to recover — and dividing by a small epsilon instead would turn a
 * stray value into a number in the millions, invisible until it is composited and blows
 * out the frame. Returning black is the one answer that stays finite and composites to
 * nothing, which is what "not covered" means.
 *
 * ALPHA IS NEVER TOUCHED, by either mode, and neither is clamped. Coverage is not what is
 * being converted here — the convention for COLOUR is — and leaving alpha exactly as it
 * arrived is what makes the pair an exact inverse wherever alpha is non-zero. That matters
 * because the intended use is a sandwich: premultiply, blur, unpremultiply. If the round
 * trip were not the identity, the sandwich would change the picture in the very case it
 * exists to fix.
 */
export const PREMULTIPLY_FRAGMENT_WGSL = `struct Params {
  mode: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  if (params.mode > 0.5) {
    // Unpremultiply. Where coverage is zero there is no colour to recover, so the answer
    // is zero rather than an epsilon-divided number in the millions.
    let recovered = source.rgb / max(source.a, 1e-6);
    return vec4f(select(vec3f(0.0), recovered, source.a > 1e-6), source.a);
  }
  return vec4f(source.rgb * source.a, source.a);
}`;
