/**
 * SlitScan — per-pixel time displacement (T321).
 *
 * The write half is Cache's blit, unchanged: sample the input, render into the ring's
 * write target. THIS shader is the read half that fixed taps cannot express: the whole
 * history binds as `texture_2d_array<f32>` and every fragment picks its OWN layer from
 * the displacement map — the classic slit-scan when the map is a gradient, arbitrary
 * temporal warps when it is anything else.
 *
 * `ringLatest` / `ringWritten` / `ringFrames` arrive as per-frame uniform VALUES merged
 * by the backend (§V5 — the array view is one stable binding; where "now" lives is a
 * number). §V229 holds per pixel: a displacement reaching deeper than the ring has
 * written clamps to the oldest recorded frame, never to an unwritten layer.
 *
 * `textureLoad`, no sampler: layer selection is exact-texel by nature — filtering
 * across LAYERS would blend two moments of time, which is a different effect (and a
 * later parameter), and unfiltered reads keep every renderable format legal (§V57).
 */
export const SLIT_SCAN_WGSL = `struct ScanParams {
  depth: f32,
  ringLatest: u32,
  ringWritten: u32,
  ringFrames: u32,
};

@group(0) @binding(0) var<uniform> params: ScanParams;
@group(0) @binding(1) var history: texture_2d_array<f32>;
@group(0) @binding(2) var displaceMap: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let dims = vec2f(textureDimensions(history));
  let texel = vec2i(clamp(uv * dims, vec2f(0.0), dims - vec2f(1.0)));
  let mapDims = vec2f(textureDimensions(displaceMap));
  let mapTexel = vec2i(clamp(uv * mapDims, vec2f(0.0), mapDims - vec2f(1.0)));

  let displacement = clamp(textureLoad(displaceMap, mapTexel, 0).r, 0.0, 1.0);
  let usable = max(min(params.ringWritten, params.ringFrames), 1u);
  /* 0 = the most recent recorded frame; usable-1 = the oldest one actually written. */
  let back = min(u32(displacement * params.depth * f32(params.ringFrames - 1u) + 0.5), usable - 1u);
  let layer = (params.ringLatest + params.ringFrames - back) % params.ringFrames;
  return textureLoad(history, texel, i32(layer), 0);
}`;
