import type { SinkDisplayTransform } from "../../domain/color/display.ts";
import { SRGB_TRANSFER_WGSL, TONE_MAP_WGSL } from "../../domain/color/display.ts";

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
 * Which one runs is `sinkDisplayTransform`'s answer, and the compiler asks the same module
 * when it publishes the target's `space`. The shader and the declaration cannot drift
 * because they are one decision read twice.
 *
 * T474 added the tone map, which §V56 named and nobody built. The two constants below are
 * UNCHANGED and still exported: `toneMap: "none"` returns the same string it always
 * returned, so every project that exists today produces byte-identical pixels by
 * construction rather than by an arithmetic identity somebody has to trust.
 */

const SAMPLE = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;`;

/**
 * ALPHA AT A DISPLAY SINK, written once (T678, §V140).
 *
 * The catalogue's arithmetic blends operate per channel across RGBA by decided convention
 * (`composite.wgsl.ts`) — Add adds alpha, Screen screens it — so a sink alpha outside [0,1]
 * is ordinary, not exceptional. B129: E9-Ember's Screen-through-Feedback loop drove it to
 * ±65504 (f16 max), and a NEGATIVE alpha is what the viewer turned into a black frame.
 *
 * This is the SECOND of two independent defences and both are load-bearing — do not delete
 * either as redundant:
 *
 *   1. `vgpu-backend.ts` configures the presentation surface `alphaMode: "opaque"`, so the
 *      viewer IGNORES alpha however wrong it is. That protects the pane.
 *   2. This clamp stops a meaningless alpha reaching the target at all. That protects every
 *      OTHER reader of the sink — export, savePng, the cook oracle, an agent screenshot —
 *      none of which go through a canvas and none of which (1) helps.
 *
 * `clamp`, not "force to 1": in-range coverage is a real value at a sink that something
 * downstream may composite, and overwriting it would be the lossy choice. NOTE therefore
 * that this does NOT rescue B130's E8-Slit-Scan frame 0, whose alpha is 0.55 — in range,
 * left alone, and dim only under a premultiplied canvas that defence (1) removed.
 */
const CLAMPED_ALPHA = `clamp(source.a, 0.0, 1.0)`;

/** `displayTransform: "none"` or a `data` target: raw values out, ALPHA INCLUDED (§V56). */
export const OUTPUT_PASSTHROUGH_WGSL = `${SAMPLE}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv);
}`;

/**
 * An `-srgb` target the HARDWARE encodes, with no tone map: colour passes through untouched
 * and only alpha is bounded. Split out from `OUTPUT_PASSTHROUGH_WGSL` by T678 — the two
 * were one string, which is what made a display sink indistinguishable from a data dump.
 */
export const OUTPUT_ALPHA_CLAMP_WGSL = `${SAMPLE}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSample(inputTexture, inputSampler, uv);
  return vec4f(source.rgb, ${CLAMPED_ALPHA});
}`;

/** `displayTransform: "srgb"`. Alpha is never encoded, in any sRGB variant. */
export const OUTPUT_DISPLAY_ENCODE_WGSL = `${SAMPLE}

${SRGB_TRANSFER_WGSL}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSample(inputTexture, inputSampler, uv);
  return vec4f(encodeDisplay(source.rgb), ${CLAMPED_ALPHA});
}`;


/**
 * The shader for one display transform (T474).
 *
 * A generator rather than a table of four strings: tone map and encode are decided
 * SEPARATELY by `sinkDisplayTransform` — an `-srgb` target is tone mapped and not encoded,
 * because the hardware applies a transfer function and not a curve — so the combinations
 * are a product, and a hand-written table is where a missing cell hides.
 *
 * ORDER IS THE WHOLE POINT and is not negotiable: the curve runs on LINEAR light, then the
 * encode. Tone mapping display-encoded values would be arithmetic on the wrong numbers, in
 * exactly the way `previewCommonWgsl` already refuses to do it for the preview lens.
 */
export function outputDisplayShader(transform: SinkDisplayTransform): string {
  if (transform.toneMap === "none") {
    if (transform.encode) return OUTPUT_DISPLAY_ENCODE_WGSL;
    // T678: `encode: false` is returned by THREE different decisions and only one of them
    // is a display sink, so the alpha clamp is read from the decision rather than inferred
    // from the shape of it (§V619).
    return transform.clampAlpha ? OUTPUT_ALPHA_CLAMP_WGSL : OUTPUT_PASSTHROUGH_WGSL;
  }
  const curve = transform.toneMap === "filmic" ? "tonemapFilmic" : "tonemapReinhard";
  const graded = `${curve}(source.rgb)`;
  const shown = transform.encode ? `encodeDisplay(${graded})` : graded;
  return `${SAMPLE}

${TONE_MAP_WGSL}
${transform.encode ? `\n${SRGB_TRANSFER_WGSL}\n` : ""}
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = textureSample(inputTexture, inputSampler, uv);
  return vec4f(${shown}, ${transform.clampAlpha ? CLAMPED_ALPHA : "source.a"});
}`;
}
