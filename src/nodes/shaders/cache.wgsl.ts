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

/**
 * The read pass since T425: the ring bound as ONE stable array view, the tap resolved
 * IN the shader from the per-frame head uniforms (T321's machinery, reused verbatim).
 *
 * WHY THE FIXED-TAP BINDING LEFT. `tapView(n)` returns a different layer view every
 * frame, so `set()` on the pass rebuilt its bind group once per frame per cache — an
 * allocation the settled-frame gate refuses, latent until E24 put a cache in an example.
 * The array view is one object for the life of the ring; what changes per frame is a
 * NUMBER, and numbers travel as uniforms (§V5). The layer arithmetic below replicates
 * `Ring.tapView` exactly, §V229 clamp included: before the ring fills, the deepest
 * readable slice stands in for a deeper tap — never a layer nobody has written.
 */
export const CACHE_READ_WGSL = `@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var ringTexture: texture_2d_array<f32>;

struct CacheTap {
  tap: f32,
  ringLatest: f32,
  ringWritten: f32,
  ringFrames: f32,
};
@group(0) @binding(2) var<uniform> cacheTap: CacheTap;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let frames = max(cacheTap.ringFrames, 1.0);
  /* \u00a7V229: while filling, the deepest available layer stands in for a deeper tap. */
  let back = clamp(cacheTap.tap, 1.0, max(cacheTap.ringWritten, 1.0));
  let layer = i32(round(cacheTap.ringLatest - (back - 1.0) + frames * 2.0)) % i32(frames);
  return textureSampleLevel(ringTexture, inputSampler, uv, layer, 0.0);
}`;
