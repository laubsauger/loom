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

/**
 * Flip — exact axis reversal (T242). TD's Flip TOP.
 *
 * Transform can already flip with a negative scale, so this exists for two reasons that
 * are not "convenience". It is EXACT: reversing a coordinate lands on texel centres, where
 * a -1 scale runs the image through the sampler's filter and softens it very slightly every
 * time. And it is what someone looks for — nobody reaches for "scale x to -1" when they
 * want a mirror image, so a Transform-only answer is a discoverability failure rather than
 * a feature.
 *
 * NO TRANSPOSE HERE, deliberately. A first version had a `swap` that exchanged x and y,
 * which looks like a free 90 degree rotation and is not: transposing a 1920x1080 image into
 * a 1920x1080 target squashes it, silently and only for non-square inputs — the common case.
 * TD does not put one on Flip either; its Flop CHANGES THE RESOLUTION ("the X resolution
 * becomes the Y resolution") and the resolution-preserving transpose lives on Tile. Both
 * want machinery we do not have yet (a resolution policy that swaps its axes), so neither is
 * pretended at here.
 */
export const FLIP_FRAGMENT_WGSL = `struct Params {
  flip: vec2f,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let source = select(uv, vec2f(1.0) - uv, params.flip > vec2f(0.5));
  return textureSampleLevel(inputTexture, inputSampler, source, 0.0);
}`;

/**
 * Mirror — fold the image about a pivot, so one half replaces the other (T242).
 *
 * Distinct from Tile's mirror flags, which mirror alternate REPEATS to make a tiling
 * seamless. This folds the image itself, at a pivot you choose, on either axis — the
 * operation behind kaleidoscopes, symmetric masks, and making a hand-drawn shape symmetric
 * without drawing both sides.
 *
 * `pivot - abs(u - pivot)` maps both sides of the pivot onto the LOW side; adding instead
 * of subtracting keeps the high side. That is the whole operation, and the reason it reads
 * as one line is that a fold IS an absolute value about a point.
 *
 * `rotate` turns the fold line off-axis, and it is what separates a mirror from a novelty:
 * folding across an arbitrary diagonal is the kaleidoscope operation, where folding across
 * x or y is only ever symmetry. TD's Mirror carries the same three controls for the same
 * reason. The rotation is applied around the pivot and undone afterwards, so the pivot stays
 * the point the image folds about rather than drifting as the angle changes.
 *
 * Folded coordinates leave [0,1] whenever the pivot is off centre — at pivot 0.2 the far
 * edge maps to -0.6 — so this samples through the shared extend helper rather than
 * pretending the range is safe.
 */
export const MIRROR_FRAGMENT_WGSL = `${WGSL_EXTEND}

${WGSL_TRANSFORM2D}

struct Params {
  pivot: vec2f,
  axis: vec2f,
  keepHigh: f32,
  rotate: f32,
  extend: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputSampler: sampler;
@group(0) @binding(2) var inputTexture: texture_2d<f32>;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  // Fold in the ROTATED frame, then rotate back: the fold line is the rotated axis, and
  // the pivot stays put because the rotation happens around it.
  let local = invRotate2(uv - params.pivot, params.rotate);
  // T749 (the B39 shape, found the moment an example first compiled this on Dawn):
  // vec2f(bool) is not a WGSL constructor - the select mask must be vec2<bool>. The
  // mirror node had NEVER compiled on a real device; no example carried it, so no
  // gate ever fed it to a compiler.
  let folded = select(-abs(local), abs(local), vec2<bool>(params.keepHigh > 0.5));
  let mixed = select(local, folded, params.axis > vec2f(0.5));
  let source = params.pivot + invRotate2(mixed, -params.rotate);
  return sampleExtend(inputTexture, inputSampler, source, params.extend);
}`;
