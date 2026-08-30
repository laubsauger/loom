import { SRGB_TRANSFER_WGSL } from "../../domain/color/display.ts";

/**
 * Output's fragment shaders (T15, T375).
 *
 * A sink presents its input unchanged — any actual transform (levels, letterboxing, ...) is
 * a visible upstream node, never something the sink does implicitly (§V13's spirit applied
 * to the viewer stage). The ONE exception is the display transform, and it is an exception
 * §V56 and §V70a both wrote down before this file existed: "encode + tonemap ONLY @
 * output|display node", "display transform belongs to the Output node ∈ graph". B47 is what
 * it cost to have that written down and not executed — the viewer showed raw linear light
 * (measured 55 for a display-0.5 grey) while every other surface showed 127.
 *
 * Which of the two runs is `sinkDisplayEncode`'s answer, and the compiler asks the same
 * function when it publishes the target's `space`. The shader and the declaration cannot
 * drift because they are one decision read twice.
 */

const SAMPLE = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;`;

/** `displayTransform: "none"`, a `data` target, or an `-srgb` target the hardware encodes. */
export const OUTPUT_PASSTHROUGH_WGSL = `${SAMPLE}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv);
}`;

/** `displayTransform: "srgb"`. Alpha is never encoded, in any sRGB variant. */
export const OUTPUT_DISPLAY_ENCODE_WGSL = `${SAMPLE}

${SRGB_TRANSFER_WGSL}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSample(inputTexture, inputSampler, uv);
  return vec4f(encodeDisplay(source.rgb), source.a);
}`;
