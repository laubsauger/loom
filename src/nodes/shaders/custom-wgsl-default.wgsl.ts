import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * The default `source` a new CustomWGSL node ships with, and what the shader editor (T20)
 * shows on first open (T15, T166).
 *
 * WHAT CHANGED AND WHY (B7). This used to be SPEC §I's contract block copied verbatim,
 * which declared `struct Params { time: f32, amount: f32 }` at `@binding(2)` — and
 * `customWgsl.compile()` emitted neither `uniformBinding` nor `sharedBinding`, so nothing
 * was ever written to it. The first person to type `params.amount` into the body got a
 * zero, with no diagnostic and nothing to blame. A default that lies is worse than a
 * default that is minimal, so the choice was between deleting the block and WIRING it.
 *
 * It is wired, because deleting it would have removed the only place the ABI is written
 * down: `inputSampler`, `inputTexture`, `frameU` and `params` are binding NAMES the
 * runtime matches on, and none of them is guessable from an empty passthrough. Both
 * blocks below are bound for real by `custom-wgsl.ts`, and the body READS both, so a
 * value that arrives here can be seen arriving.
 *
 * `Params.time` is gone, and its absence is the point. A per-pass uniform block is
 * written at compile time and on parameter change (§V5, §V21) — it structurally cannot
 * carry a per-frame clock. Time has exactly one home, the shared frame block the runtime
 * fills from `FrameEvaluationInput` (§V44), and that is `frameU.time` here. Leaving a
 * `time` field in `Params` would have re-created the same trap one struct over.
 *
 * The body is a PASSTHROUGH by arithmetic, not by omission: `amount` defaults to 1 and
 * `PULSE_DEPTH` is 0, so a freshly-created node shows its input unchanged while both
 * uniforms are genuinely read. Raising `PULSE_DEPTH` is the intended first edit, and it is
 * also the cheapest possible check that time is arriving.
 *
 * Both blocks are READ, not merely declared, on purpose: the runtime binds by NAME, and a
 * binding a shader declares but never uses can be optimised out of the pipeline layout.
 * Keeping the reads makes the default's promise true at every layer.
 */
export const CUSTOM_WGSL_DEFAULT_SOURCE = `${SHARED_UNIFORMS_WGSL}
struct Params {
  amount: f32,
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
// Filled by the runtime from FrameEvaluationInput every frame: time, deltaTime,
// frameIndex, randomSeed, wallTime, wallDelta, absTime, absFrame, resolution, pointer.
// time laps with the timeline; absTime keeps growing (T461/T468). No other clock here.
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
// This node's own parameters, updated when you change them on the node.
@group(0) @binding(3) var<uniform> params: Params;

/** Raise this above 0 to see the shared frame block actually arriving. */
const PULSE_DEPTH: f32 = 0.0;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let color = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  let pulse = 1.0 + (PULSE_DEPTH * sin(frameU.time));
  return vec4f(color.rgb * params.amount * pulse, color.a);
}`;

/**
 * The binding names the node wires up. Exported so `custom-wgsl.ts` and its tests agree
 * about the ABI without either of them re-typing a string literal that has to match WGSL.
 */
export const CUSTOM_WGSL_SHARED_BINDING = "frameU";
export const CUSTOM_WGSL_UNIFORM_BINDING = "params";
export const CUSTOM_WGSL_TEXTURE_BINDING = "inputTexture";
export const CUSTOM_WGSL_SAMPLER_BINDING = "inputSampler";
