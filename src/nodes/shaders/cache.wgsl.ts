/**
 * Cache — the blit both of the node's passes use (T237).
 *
 * ONE shader for the write and the read, like the separable blur's two axes: what differs
 * is which texture is bound and which target is written. The write pass binds the node's
 * input and renders into the ring slice this frame owns; the read pass binds a TAP — the
 * slice `index` frames back — and renders into the node's output.
 *
 * Nothing here knows it is sampling a ring, which is the point of resolving taps as
 * ordinary `texture_2d` bindings: no WGSL feature, no array indexing, no capability
 * question. Per-pixel time displacement (T321) is where that stops being enough.
 */
export const CACHE_BLIT_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  return textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
}`;
