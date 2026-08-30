import { WGSL_CHANNEL } from "./common.wgsl.ts";

/**
 * Fragment shaders for the compositing family: Over, Add, Multiply, Screen, Difference,
 * and Mask (T40).
 *
 * ALPHA CONVENTION, decided once for the whole catalogue: STRAIGHT (non-premultiplied)
 * alpha. Colour channels carry colour, alpha carries coverage, and the two are combined
 * only when compositing. TouchDesigner makes the same choice, and offers the conversion
 * as an operation on its Math TOP ("Multiply RGB by Alpha" / "Divide RGB by Alpha") rather
 * than as the default. (An earlier version of this note cited a "Premultiply TOP", which
 * a survey of all 149 TOPs found does not exist — §V186. Our equivalent is the Premultiply
 * node, T281.) Every node in this catalogue that writes alpha writes it straight.
 *
 * COLOUR (§V56): all six operate on LINEAR working-space values. Adding or multiplying
 * encoded values would give a different (and wrong) picture, which is the practical reason
 * the working space is linear in the first place.
 */

/**
 * Builds one blend node's shader from the expression that combines two pixels (T226).
 *
 * A factory rather than hand-written copies: the operators differ by one line, and the
 * parts they share — binding layout, opacity handling, the alpha rule, the FOLD — are
 * exactly the parts that must not drift between them. The generated text still differs per
 * operator and per layer count, so each keeps its own pass signature and nothing branches
 * at runtime.
 *
 * `expr` is a WGSL expression over `front` and `back` (both `vec4f`, straight alpha)
 * producing the result `vec4f`. It becomes the body of `blendPixel`, which the fold calls
 * once per layer — so there is still ONE definition of what "multiply" means (§V140) no
 * matter how many inputs are wired.
 *
 * THE FOLD IS LEFT TO RIGHT WITH THE FIRST INPUT IN FRONT:
 *
 *     acc = front                    (input 1, scaled by opacity)
 *     acc = blendPixel(acc, layer0)  (input 2)
 *     acc = blendPixel(acc, layer1)  (input 3)
 *
 * so `over` reads "input 1 over input 2 over input 3", the first input nearest the viewer.
 * That is not a coin flip between two equally good readings: it is the only direction under
 * which every existing two-input graph keeps rendering exactly what it rendered before,
 * because it degenerates to `blendPixel(front, back)` at one layer. It also matters for
 * more than Over — `difference` is not associative, so a fold that ran right to left would
 * produce a different picture from the same wiring.
 *
 * `opacity` scales the FRONT and nothing else, unchanged from the two-input version: it is
 * the layer you are placing, not the stack you are placing it on.
 */
export function blendFragmentWgsl(expr: string, layers = 1): string {
  const count = Math.max(1, Math.floor(layers));
  const declarations = Array.from(
    { length: count },
    (_, index) => `@group(0) @binding(${index + 3}) var backTexture${index}: texture_2d<f32>;`,
  ).join("\n");
  const fold = Array.from(
    { length: count },
    (_, index) =>
      `  acc = blendPixel(acc, textureSampleLevel(backTexture${index}, inputSampler, uv, 0.0));`,
  ).join("\n");

  return `fn blendPixel(front: vec4f, back: vec4f) -> vec4f {
  return ${expr};
}

struct Params {
  opacity: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var frontTexture: texture_2d<f32>;
${declarations}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var acc = textureSampleLevel(frontTexture, inputSampler, uv, 0.0) * clamp(params.opacity, 0.0, 1.0);
${fold}
  return acc;
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
function porterDuffFragmentWgsl(fa: string, fb: string, layers: number): string {
  return `${PORTER_DUFF_WGSL}

${blendFragmentWgsl(`porterDuff(front, back, ${fa}, ${fb})`, layers)}`;
}

/**
 * Every blend the family ships, as a builder over the layer count (T226, §V140).
 *
 * A table of builders rather than a table of strings: the shader text now depends on how
 * many inputs are wired, and the alternative — building all ten at every count up front —
 * would generate text nobody asks for. The KEYS are the operation names saved in
 * documents, so this map is also the list of what `operation` may legally say.
 */
const BLEND_BUILDERS = {
  over: (layers: number) => porterDuffFragmentWgsl("1.0", "1.0 - front.a", layers),
  under: (layers: number) => porterDuffFragmentWgsl("1.0 - back.a", "1.0", layers),
  inside: (layers: number) => porterDuffFragmentWgsl("back.a", "0.0", layers),
  outside: (layers: number) => porterDuffFragmentWgsl("1.0 - back.a", "0.0", layers),
  atop: (layers: number) => porterDuffFragmentWgsl("back.a", "1.0 - front.a", layers),
  xor: (layers: number) => porterDuffFragmentWgsl("1.0 - back.a", "1.0 - front.a", layers),
  // The arithmetic operators work per channel across RGBA, as TD's Composite TOP does —
  // adding two images adds their alpha too. Only the Porter-Duff set is coverage-aware.
  add: (layers: number) => blendFragmentWgsl(`front + back`, layers),
  multiply: (layers: number) => blendFragmentWgsl(`front * back`, layers),
  screen: (layers: number) =>
    blendFragmentWgsl(`vec4f(1.0) - ((vec4f(1.0) - front) * (vec4f(1.0) - back))`, layers),
  difference: (layers: number) => blendFragmentWgsl(`abs(front - back)`, layers),
} as const;

export type BlendType = keyof typeof BLEND_BUILDERS;

export function isBlendType(value: unknown): value is BlendType {
  return typeof value === "string" && value in BLEND_BUILDERS;
}

/** The shader for one operation folding `layers` inputs behind the front one. */
export function blendShaderFor(blend: BlendType, layers: number): string {
  return BLEND_BUILDERS[blend](layers);
}

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
