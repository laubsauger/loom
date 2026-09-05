/**
 * Cache — the blit both of the node's passes use (T237).
 *
 * TWO shaders, not one, and the split is the whole story of T425. The WRITE pass below is
 * the plain blit it always was: bind the node's input, render into the ring slice this
 * frame owns. The READ pass is `CACHE_READ_WGSL`, and it binds the ring as an ARRAY and
 * resolves the tap from a uniform — this file's header claimed the opposite ("the read
 * pass binds a TAP … no array indexing") for four months after T425 changed it, which is
 * how §T1149 lost a session and §T1153 got a row. T1204 corrected both ends.
 *
 * That the tap is a uniform is what makes it DRIVABLE (T1204): a delay of n(t) frames, not
 * merely of n — see `cache.ts` for why an async source's own reported lag is the thing you
 * point it at. Per-PIXEL time displacement (slit-scan, T321) is a different shader still.
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
@group(0) @binding(3) var liveTexture: texture_2d<f32>;

struct CacheTap {
  tap: f32,
  ringLatest: f32,
  ringWritten: f32,
  ringFrames: f32,
};
@group(0) @binding(2) var<uniform> cacheTap: CacheTap;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  /* B160 \u2014 \u00a7V229's "never black" was FALSE on frame 0: with nothing archived yet,
     the clamp below still indexed a never-written layer. An empty cache now reads the
     ring's WRITE TARGET \u2014 the frame this node's own write pass just composed \u2014 so
     frame 0 (and the first frame after a reset) is a zero-delay passthrough. E40, E41
     and E27 each carried a private workaround for this; the node owns it now. */
  if (cacheTap.ringWritten < 0.5) {
    return textureSampleLevel(liveTexture, inputSampler, uv, 0.0);
  }
  let frames = max(cacheTap.ringFrames, 1.0);
  /* \u00a7V229: while filling, the deepest available layer stands in for a deeper tap. */
  let back = clamp(cacheTap.tap, 1.0, max(cacheTap.ringWritten, 1.0));
  let layer = i32(round(cacheTap.ringLatest - (back - 1.0) + frames * 2.0)) % i32(frames);
  return textureSampleLevel(ringTexture, inputSampler, uv, layer, 0.0);
}`;
