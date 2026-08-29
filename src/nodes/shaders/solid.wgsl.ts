/**
 * Solid's fragment shader (T15). Fills its output with a uniform colour value.
 *
 * The colour lives in the per-pass `Params` uniform, never baked into the shader text —
 * a colour change updates this uniform in place and never forces a recompile (§V5).
 */
export const SOLID_FRAGMENT_WGSL = `struct Params {
  color: vec4f,
};
@group(0) @binding(0) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return params.color;
}`;
