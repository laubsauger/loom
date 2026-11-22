import { wgsl } from "../../runtime/backend/wgsl.ts";
import { WGSL_TRANSFORM2D } from "./common.wgsl.ts";

/**
 * Fragment shader for Fit and Resolution (T1824b, T1825b): place the input into this pass's
 * target, whose size the compiler resolved (the node's policy or its Common override, §V50).
 *
 * ONE shader for both nodes. Resolution is Fit at Fill with no uncovered area, so a
 * second shader would be a second copy of the same resampler to keep right.
 *
 * Every read is a `textureLoad` and the filter is arithmetic here, not the sampler's:
 *  - the plan has ONE shared sampler (linear, clamp-to-edge), so nearest would need a
 *    second sampler resource, and an area average is not something a sampler does;
 *  - the binding is then `unfiltered`, so an r32float data map resizes on a device
 *    without float32-filterable (§V57), which the shared sampler cannot do;
 *  - the weights are exact f32 arithmetic, so a Dawn test can assert values exactly
 *    (§V147) instead of against a GPU's fixed-point bilinear weights.
 *
 * COLOUR (§V56): values are filtered as they are read, in whatever space the input
 * carries, and written unchanged in kind. That is what the sampler does for every other
 * geometry filter (an sRGB-format input is decoded on load, as it is on a sample).
 *
 * Coordinates: `position.xy` is the output pixel centre (x + 0.5, y + 0.5), top-down.
 * `q` is the matching point in INPUT pixels, top-down. Texel i covers [i, i + 1).
 *
 * T1826b — FIT'S TRANSFORM PAGE (TD's Fit TOP: Translate, Rotate, Scale, Pivot, Transform
 * Order). It moves the PLACED image, in OUTPUT pixels, before the crop and the extend: the
 * output point is first carried back through the inverse transform, then into the input.
 * That order is the point of having it on Fit — a Transform after a Fit Outside cannot
 * bring back what the crop removed, a transform here can. Output pixels are square, so a
 * rotation never shears; Translate and Pivot are fractions of the output, about its centre,
 * which is exactly Loom's Transform node with Aspect Correct on (same names, same signs,
 * same `invTransform2`). The identity transform takes no arithmetic at all, so an
 * untransformed Fit is the same picture to the bit.
 */
export const FIT_FRAGMENT_WGSL = wgsl`${WGSL_TRANSFORM2D}

struct Params {
  background: vec4f,
  targetSize: vec2f,
  justify: vec2f,
  t: vec2f,
  s: vec2f,
  piv: vec2f,
  fit: f32,
  smoothing: f32,
  extend: f32,
  rot: f32,
  xord: f32,
};
@group(0) @binding(0) var<uniform> params: Params;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;

// Beyond this many input texels per output texel on an axis, Average Pixels takes this many
// evenly spaced texels instead of every one (the environment prefilter's bound, T1427b).
const MAX_TAPS: i32 = 16;

// One axis of an index, after the extend mode: 1 repeat, 2 mirror, anything else holds the
// edge. Background (3) holds too, so a filter tap past the image's edge reads the image's own
// edge texel and the background never bleeds into the picture.
fn extendIndex(i: i32, n: i32, mode: u32) -> i32 {
  if (mode == 1u) {
    return ((i % n) + n) % n;
  }
  if (mode == 2u) {
    let period = 2 * n;
    let m = ((i % period) + period) % period;
    return select(m, period - 1 - m, m >= n);
  }
  return clamp(i, 0, n - 1);
}

// The taps on one axis: x is the first texel, y how many. Nearest: the texel under c. Linear
// (and Average where the axis is not shrinking): the two texels whose centres bracket c.
// Average: every texel the output texel's footprint [c - w/2, c + w/2) touches.
fn axisSpan(c: f32, w: f32, mode: u32) -> vec2i {
  if (mode == 0u) {
    return vec2i(i32(floor(c)), 1);
  }
  if (mode == 2u && w > 1.0) {
    let first = i32(floor(c - (w * 0.5)));
    let last = i32(ceil(c + (w * 0.5))) - 1;
    return vec2i(first, min(last - first + 1, MAX_TAPS));
  }
  return vec2i(i32(floor(c - 0.5)), 2);
}

// Tap k on one axis: x is the texel index (as a float), y its weight.
fn axisTap(k: i32, c: f32, w: f32, mode: u32, span: vec2i) -> vec2f {
  if (mode == 0u) {
    return vec2f(f32(span.x), 1.0);
  }
  if (mode == 2u && w > 1.0) {
    let lo = c - (w * 0.5);
    let hi = c + (w * 0.5);
    let full = i32(ceil(hi)) - i32(floor(lo));
    if (full > MAX_TAPS) {
      // Strided: equal weights over evenly spaced texels across the footprint.
      return vec2f(floor(lo + ((f32(k) + 0.5) * (w / f32(MAX_TAPS)))), 1.0);
    }
    let i = f32(span.x + k);
    return vec2f(i, min(hi, i + 1.0) - max(lo, i));
  }
  // Tent: the texel whose centre is d away from c weighs 1 - d.
  let i = f32(span.x + k);
  return vec2f(i, 1.0 - abs((i + 0.5) - c));
}

@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let size = vec2i(textureDimensions(inputTexture));
  let source = vec2f(size);
  // Output pixels per input pixel, per axis, for each Fit mode.
  let ratio = params.targetSize / source;
  let mode = u32(params.fit + 0.5);
  var scale = ratio;
  if (mode == 1u) {
    scale = vec2f(ratio.x);
  } else if (mode == 2u) {
    scale = vec2f(ratio.y);
  } else if (mode == 3u) {
    scale = vec2f(min(ratio.x, ratio.y));
  } else if (mode == 4u) {
    scale = vec2f(max(ratio.x, ratio.y));
  } else if (mode == 5u) {
    scale = vec2f(1.0);
  }
  let placed = source * scale;
  var origin = (params.targetSize - placed) * params.justify;
  if (mode == 5u) {
    // Native Resolution lands on whole pixels, so its pixels are the input's, 1:1.
    origin = floor(origin);
  }
  // T1826b: back through Fit's own transform first, in output pixels about the centre.
  let transformed = any(params.t != vec2f(0.0)) || params.rot != 0.0 || any(params.s != vec2f(1.0));
  var at = position.xy;
  if (transformed) {
    let centre = params.targetSize * 0.5;
    at = invTransform2(
      position.xy - centre,
      params.t * params.targetSize,
      params.rot,
      params.s,
      params.piv * params.targetSize,
      params.xord,
    ) + centre;
  }
  let q = (at - origin) / scale;
  let extend = u32(params.extend + 0.5);
  let inside = all(q >= vec2f(0.0)) && all(q <= source);
  if (extend == 3u && !inside) {
    return params.background;
  }

  let smoothing = u32(params.smoothing + 0.5);
  // Input texels one output texel spans, per axis — the transform's scale included, by axis
  // (a rotated, unevenly scaled footprint is approximated by its unrotated axes).
  let transformScale = select(vec2f(1.0), max(abs(params.s), vec2f(1e-6)), transformed);
  let footprint = vec2f(1.0) / (scale * transformScale);
  let spanX = axisSpan(q.x, footprint.x, smoothing);
  let spanY = axisSpan(q.y, footprint.y, smoothing);
  var total = vec4f(0.0);
  var weights = 0.0;
  for (var ky = 0; ky < spanY.y; ky = ky + 1) {
    let ty = axisTap(ky, q.y, footprint.y, smoothing, spanY);
    for (var kx = 0; kx < spanX.y; kx = kx + 1) {
      let tx = axisTap(kx, q.x, footprint.x, smoothing, spanX);
      let weight = tx.y * ty.y;
      let texel = vec2i(extendIndex(i32(tx.x), size.x, extend), extendIndex(i32(ty.x), size.y, extend));
      total = total + (textureLoad(inputTexture, texel, 0) * weight);
      weights = weights + weight;
    }
  }
  return total / max(weights, 1e-12);
}`;
