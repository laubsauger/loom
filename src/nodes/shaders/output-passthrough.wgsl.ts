/**
 * Output's fragment shader (T15). A sink presents its input unchanged — any actual
 * transform (levels, colour management, letterboxing, ...) is a visible upstream node,
 * never something the sink does implicitly (§V13's spirit applied to the viewer stage).
 */
export const OUTPUT_PASSTHROUGH_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSample(inputTexture, inputSampler, uv);
}`;
