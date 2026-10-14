import { SRGB_TRANSFER_WGSL } from "../../../domain/color/display.ts";
import { ALPHA_DISPLAY_WGSL } from "../alpha-display.wgsl.ts";
import { wgsl } from "../wgsl.ts";

const BINDINGS = wgsl`@group(0) @binding(0) var blitSampler: sampler;
@group(0) @binding(1) var blitSource: texture_2d<f32>;`;

/** Raw payload copy: perform surfaces, export transports, and already-opaque preview tiles. */
export const BLIT_WGSL = wgsl`${BINDINGS}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(blitSource, blitSampler, uv);
}`;

/**
 * VNB25: the Output node's display encode, for a surface with no Output node in front of it.
 *
 * A native SDR output (Syphon, NDI, Spout) hands its 8-bit frame to a receiver that shows
 * the bytes as display values. Its source is whatever texture the Syphon Out is wired to,
 * which in a working-space graph holds LINEAR light, so the raw copy above published mids
 * at ~gamma 2.2 too dark (linear 0.5 -> byte 128 where the Output node shows 188). The
 * caller decides from the source's published space (`nativeOutputEncodes`); this shader is
 * only the arithmetic, and it is the Output node's own arithmetic: the same
 * `encodeDisplay` text, and alpha bounded as `OUTPUT_DISPLAY_ENCODE_WGSL` bounds it. No tone
 * map: a native output has no tone-map parameter, so this is Output's `toneMap: "none"`.
 */
export const ENCODE_BLIT_WGSL = wgsl`${BINDINGS}
${SRGB_TRANSFER_WGSL}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let raw = textureSample(blitSource, blitSampler, uv);
  return vec4f(encodeDisplay(raw.rgb), clamp(raw.a, 0.0, 1.0));
}`;

/** Viewer inspection of display-encoded RGB with straight alpha; never an output transform. */
export const RGBA_BLIT_WGSL = wgsl`${BINDINGS}
${SRGB_TRANSFER_WGSL}
${ALPHA_DISPLAY_WGSL}
@fragment
fn fs(@builtin(position) fragment: vec4f, @location(0) uv: vec2f) -> @location(0) vec4f {
  let raw = textureSampleLevel(blitSource, blitSampler, uv, 0.0);
  // Preserve opaque and arithmetic-alpha RGB exactly: no decode/encode round trip.
  if (!(raw.a >= 0.0 && raw.a < 1.0)) { return vec4f(raw.rgb, 1.0); }
  let over = compositeCoverageLinear(decodeDisplay(raw.rgb), raw.a, fragment.xy, 8.0);
  return vec4f(encodeDisplay(over), 1.0);
}`;
