import type { ColorPolicy } from "../types/graph.ts";
import { DEFAULT_COLOR_POLICY } from "../types/graph.ts";
import type { TextureFormat } from "../types/node-definition.ts";
import type { ColorSpace } from "../types/ports.ts";

/**
 * THE display-transform decision, in one place (T375, B47, §V56, §V57, §V70a).
 *
 * B47 was three surfaces showing three different pictures of the same texture, and the
 * cause was that each one answered "does this still need a display encode?" for itself:
 * the preview shader always encoded, the export derived an answer from the pixel FORMAT,
 * and the present blit never encoded at all. Measured on Dawn for a Solid at display 0.5
 * grey through an Output node, working format `rgba16float`: preview surface 127, viewer
 * surface **55**, exported PNG 127. Three consumers, two answers, and a third
 * (`rgba8unorm` working format: 128 / 55 / 55) one project setting away.
 *
 * §V56 and §V70a already say where the answer belongs — the OUTPUT NODE applies the
 * display transform, the present blit is a raw copy — and §V57 already says how it
 * travels: the texture DECLARES its space. `colorPolicy` (T84) recorded the choice on the
 * project and nothing ever read it, which is §V220's shape exactly.
 *
 * So this module is the seam. `sinkDisplayEncode` is asked once by the compiler (to
 * publish the sink target's `space`) and once by the Output node (to pick its shader), and
 * those are the same call, so the declaration and the pixels cannot disagree. Every
 * consumer downstream reads the declared space instead of deciding.
 */

/** Formats whose bytes are display-encoded by the HARDWARE on write and decoded on sample. */
export function isSrgbFormat(format: TextureFormat): boolean {
  return format === "rgba8unorm-srgb";
}

export function colorPolicyOf(settings: { colorPolicy?: ColorPolicy }): ColorPolicy {
  return settings.colorPolicy ?? DEFAULT_COLOR_POLICY;
}

/**
 * What the Output node does to its input, and therefore what its target holds.
 *
 *  - `"encode"` — apply the sRGB OETF in the fragment shader. The target then holds
 *    display values and declares `space: "encoded"`.
 *  - `"none"` — pass through. The target keeps whatever space it derived.
 *
 * `data` never converts (§V56). An `-srgb` target is NOT encoded in the shader because the
 * hardware already encodes on write — doing both would store the transform twice. See
 * `sinkTargetSpace` for why an `-srgb` sink is reported rather than trusted.
 */
export function sinkDisplayEncode(
  policy: ColorPolicy,
  format: TextureFormat,
  derivedSpace: ColorSpace,
): "encode" | "none" {
  if (policy.displayTransform !== "srgb") return "none";
  if (derivedSpace === "data") return "none";
  if (isSrgbFormat(format)) return "none";
  return "encode";
}

/**
 * The space a declared sink's target ends up in — the declaration every consumer reads.
 *
 * `space` is a claim about WHAT A CONSUMER GETS, and for an `-srgb` format that is linear:
 * the hardware encodes on write and DECODES on every sample, so a shader reading one is
 * handed light, not display values. Only the readback BYTES of such a texture are encoded,
 * and `src/runtime/export/image.ts` decides that from the format directly — the two facts
 * are genuinely different and were measured apart (a preview of an `-srgb` sink declared
 * `encoded` decoded twice and came out at 54).
 *
 * So an `-srgb` sink keeps the space it derived and the display transform is a NO-OP there,
 * which is exactly what `presentDecodesSrgbSource` makes the compiler say out loud.
 */
export function sinkTargetSpace(
  policy: ColorPolicy,
  format: TextureFormat,
  derivedSpace: ColorSpace,
): ColorSpace {
  if (derivedSpace === "data") return "data";
  if (policy.displayTransform !== "srgb") return derivedSpace;
  if (isSrgbFormat(format)) return "linear";
  return "encoded";
}

/**
 * True when presenting this sink target would show the wrong picture no matter what the
 * Output node does — the case the compiler reports rather than papering over (§V288).
 *
 * `rgba8unorm-srgb` stores encoded bytes and DECODES them on every sample. The present
 * blit is a raw copy by §V70a, so it samples (decode), writes to a canvas whose format is
 * never `-srgb` (`getPreferredCanvasFormat` returns `bgra8unorm` or `rgba8unorm`, never an
 * srgb variant), and the compositor shows linear light as if it were display values.
 * Measured on Dawn: 54 where 127 is right. Fixing it needs a non-decoding VIEW of the
 * source in the blit, which vgpu does not expose — so the compiler names the format and
 * the fix instead of shipping a fourth answer.
 */
export function presentDecodesSrgbSource(policy: ColorPolicy, format: TextureFormat): boolean {
  return policy.displayTransform === "srgb" && isSrgbFormat(format);
}

/**
 * The sRGB transfer pair, as WGSL, once.
 *
 * §V206 is about numbers in the spec being claims; a transfer function copied into three
 * shaders is the same hazard with more digits. The preview effects and the Output node
 * both include this text, so "what sRGB means here" has one definition and a correction
 * lands everywhere at once. The TypeScript twins live in `src/runtime/export/pixel-format.ts`
 * (readback bytes) and `src/ui/controls/color.ts` (colour pickers); they cannot share this
 * string, but they can share this comment pointing at each other.
 */
export const SRGB_TRANSFER_WGSL = `/** Linear -> sRGB piecewise encode, for display only (§V56). */
fn encodeDisplay(c: vec3f) -> vec3f {
  let v = clamp(c, vec3f(0.0), vec3f(1.0));
  let low = v * 12.92;
  let high = (pow(v, vec3f(1.0 / 2.4)) * 1.055) - vec3f(0.055);
  return select(high, low, v <= vec3f(0.0031308));
}

/** sRGB -> linear piecewise decode. The exact inverse of encodeDisplay. */
fn decodeDisplay(c: vec3f) -> vec3f {
  let v = clamp(c, vec3f(0.0), vec3f(1.0));
  let low = v / 12.92;
  let high = pow((v + vec3f(0.055)) / 1.055, vec3f(2.4));
  return select(high, low, v <= vec3f(0.04045));
}`;
