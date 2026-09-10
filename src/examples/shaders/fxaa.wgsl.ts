/**
 * FXAA as a CustomWGSL pass (T1275). The classic luma-edge form: find the local edge
 * direction from the four diagonal neighbours' luma, blur along it, and keep the wider blur
 * only while its luma stays inside the neighbourhood's range. One pass, nine taps, and it
 * reads nothing but its input, so it costs a fraction of a millisecond where tracing more
 * rays cost E67 1.69x and supersampling 3.95x (measured, T1275).
 *
 * Luma is read through x/(1+x) because it sits after a grade that hands it HDR values (E67's
 * ceiling is 3) and FXAA's thresholds assume a 0..1 signal. The colour it blends is the raw
 * input, so it changes WHERE it blurs, never the range of what it outputs.
 *
 * `amount` mixes the input and the smoothed result, so 0 is the input exactly (a mix with
 * weight 0 returns its first argument) and the pass can be turned off without rewiring.
 */
export const FXAA_WGSL = `struct Params {
  amount: f32, // @default 1  0 is the input exactly, 1 is full FXAA.
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> params: Params;

const SPAN_MAX: f32 = 8.0;
const REDUCE_MUL: f32 = 0.125;
const REDUCE_MIN: f32 = 0.0078125;

fn tap(uv: vec2f) -> vec3f {
  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
}

fn luma(c: vec3f) -> f32 {
  let t = max(c, vec3f(0.0)) / (vec3f(1.0) + max(c, vec3f(0.0)));
  return dot(t, vec3f(0.299, 0.587, 0.114));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let px = 1.0 / vec2f(textureDimensions(inputTexture));
  let m = tap(uv);
  let lM = luma(m);
  let lNW = luma(tap(uv + vec2f(-1.0, -1.0) * px));
  let lNE = luma(tap(uv + vec2f(1.0, -1.0) * px));
  let lSW = luma(tap(uv + vec2f(-1.0, 1.0) * px));
  let lSE = luma(tap(uv + vec2f(1.0, 1.0) * px));
  let lMin = min(lM, min(min(lNW, lNE), min(lSW, lSE)));
  let lMax = max(lM, max(max(lNW, lNE), max(lSW, lSE)));

  var dir = vec2f(-((lNW + lNE) - (lSW + lSE)), (lNW + lSW) - (lNE + lSE));
  let reduce = max((lNW + lNE + lSW + lSE) * 0.25 * REDUCE_MUL, REDUCE_MIN);
  let rcpMin = 1.0 / (min(abs(dir.x), abs(dir.y)) + reduce);
  dir = clamp(dir * rcpMin, vec2f(-SPAN_MAX), vec2f(SPAN_MAX)) * px;

  let a = 0.5 * (tap(uv + dir * (1.0 / 3.0 - 0.5)) + tap(uv + dir * (2.0 / 3.0 - 0.5)));
  let b = a * 0.5 + 0.25 * (tap(uv - dir * 0.5) + tap(uv + dir * 0.5));
  let lB = luma(b);
  let smoothed = select(b, a, (lB < lMin) || (lB > lMax));
  return vec4f(mix(m, smoothed, params.amount), 1.0);
}`;
