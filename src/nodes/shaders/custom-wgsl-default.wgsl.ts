/**
 * The v1 custom-WGSL node contract, reproduced VERBATIM from SPEC.md §I as the default
 * value of the CustomWGSL node's `source` parameter (T15).
 *
 * Do not "improve" or reformat this text — it is exactly what a new CustomWGSL node
 * ships with and what the shader editor (T20) shows on first open. If the contract
 * itself changes, that change belongs in SPEC.md first, and this constant follows it.
 */
export const CUSTOM_WGSL_DEFAULT_SOURCE = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
struct Params { time: f32, amount: f32, };
@group(0) @binding(2) var<uniform> params: Params;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv);
}`;
