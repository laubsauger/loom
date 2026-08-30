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
 * So this module is the seam. `sinkDisplayTransform` is asked by the Output node (to pick
 * its shader) and `sinkTargetSpace` by the compiler (to publish the sink target's `space`),
 * and both read the same policy through the same predicates, so the declaration and the
 * pixels cannot disagree. Every consumer downstream reads the declared space instead of
 * deciding.
 *
 * ## The TONE MAP half (T474)
 *
 * §V56 has always said "encode + tonemap ONLY @ output|display node". Only the encode half
 * was ever built: the working format defaults to `rgba16float`, `encodeDisplay` CLAMPS, and
 * an invariant named a feature that did not exist (§V186b: a claim nobody checked).
 *
 * MEASURED, because the obvious motivating example turns out not to be one. E4 Bloom's
 * middle chain carries `rgba16float` overrides precisely so over-range values survive the
 * threshold and the blur — but its Add brings them back down, and the composite reaches the
 * Output node at **0.9692** linear with ZERO pixels over 1.0 across 262144. So E4 never
 * clipped. What clipped is any graph whose FINAL value exceeds 1, and until now the app
 * offered no way to look at one.
 *
 * The curve lands HERE rather than beside the encode, because the two questions are not the
 * same question and answering them apart is how B47 happened:
 *
 *  - an `rgba8unorm-srgb` target must NOT be encoded in the shader (the hardware does it)
 *    and MUST still be tone mapped, because the hardware does the transfer function and
 *    nothing else;
 *  - a `data` target does neither (§V56);
 *  - `displayTransform: "none"` means raw values out, for measurement and data dumps, and a
 *    tone map is a display transform by §V56's own sentence — so it is off there too, and
 *    the Output node SAYS so rather than silently ignoring the parameter (§V288).
 *
 * `sinkTargetSpace` is deliberately unchanged: a tone map compresses RANGE, not SPACE.
 * Tone-mapped linear light is still linear, so the declaration a consumer reads is exactly
 * what it was before.
 */

/** Formats whose bytes are display-encoded by the HARDWARE on write and decoded on sample. */
export function isSrgbFormat(format: TextureFormat): boolean {
  return format === "rgba8unorm-srgb";
}

export function colorPolicyOf(settings: { colorPolicy?: ColorPolicy }): ColorPolicy {
  return settings.colorPolicy ?? DEFAULT_COLOR_POLICY;
}

/**
 * The tone-mapping operators the Output node offers (T474).
 *
 * WHAT EACH ONE IS, and what it is not (§V328 — state the capability, never promise the
 * hardware; the render pipeline shipped PBR-through-Blinn-Phong with exactly this honesty):
 *
 *  - `none` — no curve. `encodeDisplay` clamps, so anything above 1 is white. This is the
 *    default, and it is the default because changing it would move the pixels of every
 *    project that already exists.
 *  - `reinhard` — `x / (1 + x)`, per channel. The simplest thing that cannot clip: it is
 *    monotonic, it maps 0→0 and ∞→1, and it has no shoulder or toe, so it protects
 *    highlights at the cost of overall contrast. Per-channel means a saturated over-range
 *    colour desaturates as it compresses; that is inherent to the operator, not a bug.
 *  - `filmic` — Krzysztof Narkowicz's 2015 curve fit to the ACES RRT+ODT. It is NOT the
 *    ACES pipeline: there is no transform into or out of AP1, no reference rendering
 *    transform, no output device transform for a specific display. It is a rational
 *    approximation applied directly to the working primaries, which is what almost every
 *    real-time renderer that says "ACES" actually ships. It gives a toe and a shoulder and
 *    more contrast than Reinhard, and it clamps at 1 after the curve.
 *
 * Neither operator is a grade. Exposure is DELIBERATELY absent: the Output node's own rule
 * is that "any actual transform is a visible upstream node, never something the sink does
 * implicitly", with the display transform as the single exception §V56 carves out. A gain
 * is a Level node — E4 Bloom already uses one for exactly that — and putting a second gain
 * on the sink would give every project two places to look for its brightness.
 */
export type ToneMapOperator = "none" | "reinhard" | "filmic";

export const TONE_MAP_OPTIONS: ReadonlyArray<{ value: ToneMapOperator; label: string }> = [
  { value: "none", label: "None" },
  { value: "reinhard", label: "Reinhard" },
  { value: "filmic", label: "Filmic (ACES-derived)" },
];

export function isToneMapOperator(value: unknown): value is ToneMapOperator {
  return value === "none" || value === "reinhard" || value === "filmic";
}

/** What the Output node does to its input, and therefore what its target holds. */
export interface SinkDisplayTransform {
  /** The curve that runs BEFORE the encode. `none` means the values are untouched. */
  readonly toneMap: ToneMapOperator;
  /** Apply the sRGB OETF in the fragment shader. The target then declares `encoded`. */
  readonly encode: boolean;
}

/**
 * THE display-transform decision. One call, both halves, so they cannot be answered apart.
 *
 * `data` never converts (§V56), and `displayTransform: "none"` means raw values out — both
 * turn the whole transform off. An `-srgb` target is NOT encoded in the shader because the
 * hardware already encodes on write (doing both would store the transform twice), but it IS
 * still tone mapped: the hardware applies a transfer function, which is not a curve and does
 * nothing about values above 1. That asymmetry is the reason this returns a pair rather than
 * two functions somebody could call in only one of the two places.
 *
 * See `sinkTargetSpace` for why an `-srgb` sink is reported rather than trusted.
 */
export function sinkDisplayTransform(
  policy: ColorPolicy,
  format: TextureFormat,
  derivedSpace: ColorSpace,
  requested: ToneMapOperator,
): SinkDisplayTransform {
  if (policy.displayTransform !== "srgb") return { toneMap: "none", encode: false };
  if (derivedSpace === "data") return { toneMap: "none", encode: false };
  return { toneMap: requested, encode: !isSrgbFormat(format) };
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

/**
 * The tone curves, as WGSL, once (T474).
 *
 * `tonemapFilmic` was written for the PREVIEW lens (`debug-effects.wgsl.ts`) and lived
 * there alone while the Output node had no tone map at all. It moved here the moment the
 * Output node needed one, for the reason the sRGB pair above already gives: a transfer
 * function copied into two shaders is §V206's hazard with more digits, and this particular
 * duplicate would have shown the user's HDR lens and the user's OUTPUT two different
 * pictures of the same highlight — B47's exact shape, on the curve instead of the encode.
 *
 * The function NAME `tonemapFilmic` is kept so the preview call sites read unchanged.
 */
export const TONE_MAP_WGSL = `/** ACES-derived filmic curve (Narkowicz 2015). Applied AFTER exposure, never before. */
fn tonemapFilmic(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  let numerator = x * ((x * 2.51) + vec3f(0.03));
  let denominator = (x * ((x * 2.43) + vec3f(0.59))) + vec3f(0.14);
  return clamp(numerator / denominator, vec3f(0.0), vec3f(1.0));
}

/** Reinhard: x / (1 + x), per channel. Monotonic, 0 -> 0, cannot reach 1 from a finite x. */
fn tonemapReinhard(c: vec3f) -> vec3f {
  let x = max(c, vec3f(0.0));
  return x / (x + vec3f(1.0));
}`;
