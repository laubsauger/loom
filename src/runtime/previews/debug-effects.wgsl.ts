/**
 * Debug preview effects (T35, doc §12.4).
 *
 * WGSL lives in `.ts` modules exporting template strings, like `src/nodes/shaders/**`.
 *
 * COLOUR SPACE. The working space is linear (§V56) and §V56 puts the display encode at the
 * output or display node — a preview IS a display, so every effect below ends with an explicit
 * sRGB encode into an `rgba8unorm` tile. Rendering linear values straight into an 8-bit target
 * and letting the compositor show them is the classic "everything looks too dark" bug, and it
 * would make the preview disagree with the main output about what the same texture looks like.
 *
 * COLOURS IN THIS FILE. The `vec3f` constants below are GPU-side data encodings — a
 * checkerboard, a NaN marker, a diverging ramp — not UI chrome. §V17 is about the app's theme
 * coming from CSS tokens; a shader cannot read a CSS custom property, and a NaN marker whose
 * hue is themeable is a worse debug tool, not a better one. The chrome AROUND the preview
 * (borders, labels, badges) is tokenised as normal in `src/editor/viewer/**`.
 *
 * Sampling is `textureSampleLevel(..., 0.0)` throughout: targets are single-mip and the
 * implicit-derivative form buys nothing while tripping WGSL's uniformity analysis after a
 * branch.
 */

/**
 * Uniform block, identical across every mode.
 *
 * One shape for all modes on purpose: the pass's structural key includes uniform NAMES but
 * never values (§V5), so switching exposure, channel or checker size can never reach the
 * pipeline-rebuild path. Switching MODE changes the shader text, and that is meant to be a
 * rebuild — it is a different program.
 *
 * `mask` leads so the `vec4f` sits at offset 0 and the block needs no explicit padding.
 */
export const PREVIEW_PARAMS_WGSL = `struct PreviewParams {
  mask: vec4f,
  exposure: f32,
  channel: f32,
  checkerSize: f32,
  tonemap: f32,
  signedScale: f32,
};
@group(0) @binding(0) var<uniform> params: PreviewParams;
@group(0) @binding(1) var previewSampler: sampler;
@group(0) @binding(2) var previewTexture: texture_2d<f32>;`;

/** Helpers every mode shares. Kept in one place so "what exposure means" has one definition. */
export const PREVIEW_COMMON_WGSL = `fn exposed(c: vec3f) -> vec3f {
  return c * params.exposure;
}

/** ACES-derived filmic curve. Applied AFTER exposure, never before. */
fn tonemapFilmic(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  let numerator = x * ((x * 2.51) + vec3f(0.03));
  let denominator = (x * ((x * 2.43) + vec3f(0.59))) + vec3f(0.14);
  return clamp(numerator / denominator, vec3f(0.0), vec3f(1.0));
}

fn maybeTonemap(c: vec3f) -> vec3f {
  return select(c, tonemapFilmic(c), params.tonemap > 0.5);
}

/** Linear -> sRGB piecewise encode, for display only (§V56). */
fn encodeDisplay(c: vec3f) -> vec3f {
  let v = clamp(c, vec3f(0.0), vec3f(1.0));
  let low = v * 12.92;
  let high = (pow(v, vec3f(1.0 / 2.4)) * 1.055) - vec3f(0.055);
  return select(high, low, v <= vec3f(0.0031308));
}

/** Index order r,g,b,a — fixed by PREVIEW_CHANNELS in types.ts; the two must agree. */
fn pickChannel(c: vec4f, which: f32) -> f32 {
  switch (u32(which + 0.5)) {
    case 0u: { return c.r; }
    case 1u: { return c.g; }
    case 2u: { return c.b; }
    default: { return c.a; }
  }
}

/** Checkerboard in TILE pixels, so the squares stay a constant size on screen. */
fn checkerValue(position: vec2f, size: f32) -> f32 {
  let cell = floor(position / max(size, 1.0));
  let odd = (u32(abs(cell.x)) + u32(abs(cell.y))) % 2u;
  return select(0.18, 0.32, odd == 1u);
}

/** Diagonal hatch, for marking out-of-range pixels without hiding them. */
fn stripe(position: vec2f, period: f32) -> f32 {
  let d = fract((position.x + position.y) / max(period, 1.0));
  return select(0.0, 1.0, d < 0.5);
}`;

const PRELUDE = `${PREVIEW_PARAMS_WGSL}

${PREVIEW_COMMON_WGSL}`;

/** Normal colour. Channel mask, exposure, optional tonemap, display encode. */
export const PREVIEW_COLOR_WGSL = `${PRELUDE}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(previewTexture, previewSampler, uv, 0.0) * params.mask;
  return vec4f(encodeDisplay(maybeTonemap(exposed(source.rgb))), 1.0);
}`;

/**
 * Single channel as grayscale.
 *
 * Grayscale rather than "the channel in its own hue": a green channel shown green is
 * unreadable next to a green image, and every compositor that offers channel isolation shows
 * luminance for the same reason.
 */
export const PREVIEW_CHANNEL_WGSL = `${PRELUDE}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(previewTexture, previewSampler, uv, 0.0);
  let value = pickChannel(source, params.channel);
  return vec4f(encodeDisplay(maybeTonemap(exposed(vec3f(value)))), 1.0);
}`;

/**
 * Luminance.
 *
 * Rec.709 luma weights — the same ones the NaN mode dims with, deliberately, so "how bright is
 * this" has one definition in this file. Applied to the MASKED colour after exposure, so
 * luminance answers the question about the picture actually on screen rather than about a
 * different one. This is the mode a compositor reaches for to judge contrast without hue
 * pulling the eye around, and it is why channel isolation elsewhere renders grayscale too.
 */
export const PREVIEW_LUMINANCE_WGSL = `${PRELUDE}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(previewTexture, previewSampler, uv, 0.0) * params.mask;
  let graded = maybeTonemap(exposed(source.rgb));
  let luma = dot(graded, vec3f(0.2126, 0.7152, 0.0722));
  return vec4f(encodeDisplay(vec3f(luma)), 1.0);
}`;

/**
 * Alpha over a checkerboard.
 *
 * Straight (non-premultiplied) alpha, matching the compositor's own Over. A premultiplied
 * source would read as too dark here, which is a real signal rather than a bug: it means the
 * upstream node and this preview disagree about the convention.
 */
export const PREVIEW_ALPHA_WGSL = `${PRELUDE}

@fragment
fn fs(@builtin(position) fragment: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(previewTexture, previewSampler, uv, 0.0);
  let ground = vec3f(checkerValue(fragment.xy, params.checkerSize));
  let colour = maybeTonemap(exposed(source.rgb));
  let over = mix(ground, colour, clamp(source.a, 0.0, 1.0));
  return vec4f(encodeDisplay(over), 1.0);
}`;

/**
 * HDR exposure.
 *
 * Exposure and the filmic curve, plus range markers: a pixel that is still above 1.0 after
 * exposure is hatched warm, one below 0.0 is hatched cool. Without the markers, tonemapping
 * quietly hides exactly the clipping the user opened this mode to find.
 */
export const PREVIEW_EXPOSURE_WGSL = `${PRELUDE}

@fragment
fn fs(@builtin(position) fragment: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(previewTexture, previewSampler, uv, 0.0) * params.mask;
  let scaled = exposed(source.rgb);
  let shown = encodeDisplay(tonemapFilmic(scaled));
  let hatch = stripe(fragment.xy, 8.0);
  let over = any(scaled > vec3f(1.0));
  let under = any(scaled < vec3f(0.0));
  // \`out\` is a WGSL reserved word — this is \`result\` for that reason, not for style.
  var result = shown;
  result = select(result, mix(result, vec3f(1.0, 0.45, 0.0), hatch), over);
  result = select(result, mix(result, vec3f(0.0, 0.5, 1.0), hatch), under && !over);
  return vec4f(result, 1.0);
}`;

/**
 * NaN and infinity highlighting.
 *
 * `v != v` is the only NaN test WGSL gives us, and the spec permits an implementation to
 * assume no NaNs — so a driver with relaxed float semantics may fold this away. It is
 * nonetheless correct on every desktop backend we target (§C baseline: Chrome/Edge >= 128), and
 * an infinity test by magnitude works regardless. The base image is dimmed to a desaturated
 * grey so the markers read at a glance without losing the context of where they are.
 */
export const PREVIEW_NAN_WGSL = `${PRELUDE}

const F32_MAX: f32 = 3.4028234e38;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(previewTexture, previewSampler, uv, 0.0);
  let isNan = source != source;
  let isPosInf = source > vec4f(F32_MAX);
  let isNegInf = source < vec4f(-F32_MAX);

  let grey = dot(clamp(source.rgb, vec3f(0.0), vec3f(1.0)), vec3f(0.2126, 0.7152, 0.0722));
  var result = vec3f(grey * 0.35);
  if (any(isNegInf)) { result = vec3f(1.0, 0.85, 0.0); }
  if (any(isPosInf)) { result = vec3f(0.0, 1.0, 1.0); }
  if (any(isNan)) { result = vec3f(1.0, 0.0, 1.0); }
  return vec4f(encodeDisplay(result), 1.0);
}`;

/**
 * Signed-value visualisation.
 *
 * Zero is black, positive runs warm, negative runs cool, magnitude is `|v| / signedScale`.
 * Diverging rather than a single ramp because the question this mode answers is "where does
 * this flip sign", and a single ramp puts zero in the middle of a gradient where nobody can
 * find it. Applied to the selected channel, since the textures that carry signed data
 * (displacement, velocity, SDF) are read one channel at a time.
 */
export const PREVIEW_SIGNED_WGSL = `${PRELUDE}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSampleLevel(previewTexture, previewSampler, uv, 0.0);
  let value = pickChannel(source, params.channel);
  let t = clamp(value / max(params.signedScale, 1e-6), -1.0, 1.0);
  let positive = max(t, 0.0);
  let negative = max(-t, 0.0);
  let warm = vec3f(1.0, 0.55, 0.1) * positive;
  let cool = vec3f(0.1, 0.5, 1.0) * negative;
  return vec4f(encodeDisplay(warm + cool), 1.0);
}`;
