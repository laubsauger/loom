import { WGSL_EXTEND, WGSL_TRANSFORM2D } from "./common.wgsl.ts";

/**
 * Fragment shaders for the geometry filters: Transform, Crop, Tile (T40).
 *
 * All three move pixels and never touch their values, so they are colour-space neutral:
 * whatever space the input carries, the output carries the same one, and no node here
 * applies a curve, a matrix or a channel swizzle (§V56).
 *
 * They sample with `textureSampleLevel(..., 0.0)` and do their own wrap arithmetic because
 * the compiler emits ONE shared sampler for the whole plan (clamp-to-edge); asking for a
 * repeat sampler would mean changing the plan's resource model, and the coordinate maths
 * is equivalent on our single-mip targets.
 */

export const TRANSFORM_FRAGMENT_WGSL = `${WGSL_EXTEND}
${WGSL_TRANSFORM2D}

struct Params {
  t: vec2f,
  s: vec2f,
  piv: vec2f,
  rot: f32,
  xord: f32,
  extend: f32,
  aspect: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Rotation has to happen in a square space, or a rotate on a 16:9 image shears it.
  let stretch = vec2f(params.aspect, 1.0);
  let square = (uv - vec2f(0.5)) * stretch;
  let moved = invTransform2(square, params.t * stretch, params.rot, params.s, params.piv * stretch, params.xord);
  let source = (moved / stretch) + vec2f(0.5);
  return sampleExtend(inputTexture, inputSampler, source, params.extend);
}`;

/**
 * Crop — TD's Crop TOP, with one deliberate difference.
 *
 * TD's Crop CHANGES the output resolution to the cropped region. `ResolutionPolicy` has no
 * kind that derives a size from a parameter value (§I: inherit | fixed | scale | project |
 * custom), so this node keeps the input resolution and blanks everything outside the crop
 * region instead. That is the honest version of the operation available today; the
 * alternative — silently scaling the region up to fill the frame — would look like a crop
 * and behave like a zoom.
 *
 * Bounds are fractions with y UP (bottom = 0), matching TD, while `uv.y` runs down.
 */
export const CROP_FRAGMENT_WGSL = `struct Params {
  bounds: vec4f,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let point = vec2f(uv.x, 1.0 - uv.y);
  let lo = vec2f(min(params.bounds.x, params.bounds.y), min(params.bounds.z, params.bounds.w));
  let hi = vec2f(max(params.bounds.x, params.bounds.y), max(params.bounds.z, params.bounds.w));
  let inside = all(point >= lo) && all(point <= hi);
  let value = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  return select(vec4f(0.0), value, inside);
}`;

/** Tile — TD's Tile TOP: repeat the image n by m, optionally mirroring alternate tiles. */
export const TILE_FRAGMENT_WGSL = `struct Params {
  repeat: vec2f,
  offset: vec2f,
  mirror: vec2f,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let scaled = (uv * params.repeat) + params.offset;
  let tile = fract(scaled);
  // Mirroring alternate tiles is what makes a tiled image seamless without authoring it
  // that way: the odd tiles read backwards, so every tile boundary matches its neighbour.
  let odd = fract(floor(scaled) * 0.5) > vec2f(0.25);
  let mirrored = select(tile, 1.0 - tile, odd);
  let source = select(tile, mirrored, params.mirror > vec2f(0.5));
  return textureSampleLevel(inputTexture, inputSampler, source, 0.0);
}`;
