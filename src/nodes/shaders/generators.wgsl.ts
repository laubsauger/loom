/**
 * Fragment shaders for the source nodes: Ramp, UV, Checker, Circle (T40).
 *
 * Every generator writes into the LINEAR working space (§V56). Colour parameters arrive
 * as raw uniform values and are written unconverted — the same contract the Solid node
 * established: a `space: "display"` parameter declares that the number came from a colour
 * picker, and decoding it is the job of whatever resolves parameters, never of a shader
 * silently applying a curve nobody asked for (§V13).
 *
 * `uv` is the interpolated fragment coordinate in [0,1], y down from the top-left, which
 * is what the runtime's full-screen pass provides.
 */

/**
 * Ramp — an N-stop gradient (T270). TD's Ramp TOP key list.
 *
 * ## Why the stop table is twenty vec4s and not an array
 *
 * `array<vec4f, 16>` is the obvious declaration and it is not reachable: the plan
 * contract carries a uniform value as a FLAT list of numbers (`UniformValue` =
 * `number | boolean | readonly number[]`), and vgpu writes an array element-wise from a
 * NESTED list it therefore cannot be handed. Twenty flat `vec4f` members is what the
 * writer does accept, and the shader assembles them into local arrays exactly as the
 * matrix filter already assembles `params.row0..row2`. A storage buffer or a LUT texture
 * would have avoided this, and both would add a resource per Ramp for a case sixteen
 * stops covers.
 *
 * `count` is authoritative. The unused tail of the table is whatever the last write left
 * there, so nothing may read past `count` — which is also why the compiler refuses a
 * count it cannot pack rather than truncating one (a gradient silently missing its last
 * two colours is a bug with no visible cause).
 *
 * ## Order is the document's, not the sort's
 *
 * The shader walks CONSECUTIVE entries. A list whose positions run backwards produces a
 * hard edge at that segment rather than a re-sorted gradient: the user's list order is
 * the answer, and re-sorting it here would mean the picture disagreed with the editor.
 */
export const RAMP_FRAGMENT_WGSL = `const MAX_STOPS: u32 = 16u;

struct Params {
  c0: vec4f, c1: vec4f, c2: vec4f, c3: vec4f,
  c4: vec4f, c5: vec4f, c6: vec4f, c7: vec4f,
  c8: vec4f, c9: vec4f, c10: vec4f, c11: vec4f,
  c12: vec4f, c13: vec4f, c14: vec4f, c15: vec4f,
  // Sixteen positions, four to a vector.
  p0: vec4f, p1: vec4f, p2: vec4f, p3: vec4f,
  count: f32,
  rtype: f32,
  interp: f32,
  phase: f32,
  period: f32,
};
@group(0) @binding(0) var<uniform> params: Params;

fn rampCoordinate(uv: vec2f) -> f32 {
  switch (u32(params.rtype + 0.5)) {
    case 0u: { return uv.x; }
    case 1u: { return uv.y; }
    case 2u: {
      // Radial: distance from the centre, normalised so the edge midpoint is 1.
      return clamp(length(uv - vec2f(0.5)) * 2.0, 0.0, 1.0);
    }
    default: {
      // Circular: angle around the centre, 0..1 counter-clockwise from +x.
      let d = uv - vec2f(0.5);
      return fract((atan2(d.y, d.x) * 0.15915494309189535) + 1.0);
    }
  }
}

fn blendAt(t: f32) -> f32 {
  let mode = u32(params.interp + 0.5);
  if (mode == 1u) { return smoothstep(0.0, 1.0, t); }
  if (mode == 2u) { return step(0.5, t); }
  return t;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  var colors = array<vec4f, 16>(
    params.c0, params.c1, params.c2, params.c3,
    params.c4, params.c5, params.c6, params.c7,
    params.c8, params.c9, params.c10, params.c11,
    params.c12, params.c13, params.c14, params.c15,
  );
  var positions = array<f32, 16>(
    params.p0.x, params.p0.y, params.p0.z, params.p0.w,
    params.p1.x, params.p1.y, params.p1.z, params.p1.w,
    params.p2.x, params.p2.y, params.p2.z, params.p2.w,
    params.p3.x, params.p3.y, params.p3.z, params.p3.w,
  );

  let n = max(1u, min(MAX_STOPS, u32(params.count + 0.5)));
  /* T556: period MULTIPLIES — "how many times the ramp repeats across its axis", as
     the parameter has always described itself. The old form divided, so period 4 showed
     a quarter of ONE cycle stretched across the axis instead of four cycles — the
     description promised tiling and the shader delivered magnification. Phase is in
     CYCLE units, so 0.5 is half a ramp at any period. */
  let raw = rampCoordinate(uv) * max(abs(params.period), 1e-6) + params.phase;
  let t = fract(raw);

  // Before the first stop and after the last: hold. A gradient that faded to black
  // outside its own range would make every partial ramp look like a bug.
  if (t <= positions[0]) { return colors[0]; }
  if (t >= positions[n - 1u]) { return colors[n - 1u]; }

  var result = colors[n - 1u];
  for (var i = 0u; i + 1u < n; i = i + 1u) {
    let a = positions[i];
    let b = positions[i + 1u];
    if (t >= a && t <= b) {
      result = mix(colors[i], colors[i + 1u], blendAt((t - a) / max(b - a, 1e-6)));
      break;
    }
  }
  return result;
}`;

/**
 * UV — the identity coordinate field.
 *
 * Its output is DATA, not colour (§V56): red carries u, green carries v, and running it
 * through a colour transform would be meaningless. It exists to feed Displace and Lookup,
 * and to make "what is this node doing to my coordinates?" visible at a glance.
 */
export const UV_FRAGMENT_WGSL = `struct Params {
  flipv: f32,
};
@group(0) @binding(0) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let v = select(uv.y, 1.0 - uv.y, params.flipv > 0.5);
  return vec4f(uv.x, v, 0.0, 1.0);
}`;

/** Checker — TD's Checker TOP: two colours in an n-by-m grid, with a phase offset. */
export const CHECKER_FRAGMENT_WGSL = `struct Params {
  color1: vec4f,
  color2: vec4f,
  size: vec2f,
  offset: vec2f,
};
@group(0) @binding(0) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let cell = floor((uv * params.size) + params.offset);
  let parity = fract((cell.x + cell.y) * 0.5);
  return select(params.color1, params.color2, parity > 0.25);
}`;

/**
 * Circle — TD's Circle TOP, plus a signed-distance mode.
 *
 * The distance mode is what makes this useful as a building block rather than a shape:
 * a signed distance field drives Displace, Threshold and Mask directly. It also changes
 * what the output MEANS — in `fill` mode the output is linear colour, in `distance` mode
 * it is DATA in the red channel, in uv units, negative inside. The node's doc comment and
 * the port description both say so. T768 did NOT move this port to `space: "data"`: the
 * declaration is per-port and this one's meaning depends on a PARAMETER, and under §V57c
 * the data consumers (displace.disp, mask.mask) accept a linear source anyway — so the
 * dual-mode port stays linear and both of its uses keep working, the same dissolution
 * Threshold's note got.
 */
export const CIRCLE_FRAGMENT_WGSL = `struct Params {
  fillcolor: vec4f,
  bgcolor: vec4f,
  center: vec2f,
  radius: vec2f,
  softness: f32,
  aspect: f32,
  mode: f32,
};
@group(0) @binding(0) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let radius = max(abs(params.radius), vec2f(1e-6));
  let d = ((uv - params.center) * vec2f(params.aspect, 1.0)) / radius;
  // Ellipse SDF, scaled back into uv units so the value stays meaningful as a distance.
  let len = length(d);
  let dist = (len - 1.0) * min(radius.x / max(params.aspect, 1e-6), radius.y);

  if (params.mode > 0.5) {
    return vec4f(dist, 0.0, 0.0, 1.0);
  }

  let edge = max(params.softness, 1e-5);
  let inside = 1.0 - smoothstep(-edge * 0.5, edge * 0.5, dist);
  return mix(params.bgcolor, params.fillcolor, inside);
}`;

/**
 * Rectangle — anti-aliased box with rounded corners, or its signed distance field (T242).
 * TD's Rectangle TOP.
 *
 * Circle's sibling: same parameter vocabulary, same two modes, same aspect handling, so the
 * two read as one family rather than two people's ideas of a shape node.
 *
 * The box SDF is exact, unlike the "distance to the nearest edge" approximation people
 * usually reach for. `length(max(q, 0))` handles the region diagonally outside a corner —
 * where the nearest point on the box IS the corner — and `min(max(q.x, q.y), 0)` handles the
 * interior, where the distance is to the nearest face. The approximation is wrong exactly in
 * the corners, which is where a rounded rectangle spends all of its interesting geometry.
 *
 * `roundness` is subtracted from the distance, which is the standard trick and is why it
 * costs nothing: offsetting a distance field inflates the shape by that amount in every
 * direction, and an inflated box is a rounded box. It is clamped to half the smaller extent
 * because beyond that the corners would overlap and the field would fold inside out — at
 * exactly that value a square becomes a circle, which is the correct limit.
 */
export const RECTANGLE_FRAGMENT_WGSL = `struct Params {
  fillcolor: vec4f,
  bgcolor: vec4f,
  center: vec2f,
  size: vec2f,
  roundness: f32,
  softness: f32,
  aspect: f32,
  mode: f32,
};
@group(0) @binding(0) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = max(abs(params.size), vec2f(1e-6));
  // Aspect is applied to the coordinate, not the size, so a square stays square on a
  // non-square output — the same convention Circle uses.
  let p = (uv - params.center) * vec2f(params.aspect, 1.0);
  // Beyond half the smaller extent the corners would overlap and the field would fold; at
  // exactly that value a square becomes a circle, which is the right limit.
  let round = clamp(params.roundness, 0.0, min(size.x, size.y));
  let q = abs(p) - (size - vec2f(round));
  let dist = (length(max(q, vec2f(0.0))) + min(max(q.x, q.y), 0.0)) - round;

  if (params.mode > 0.5) {
    return vec4f(dist, 0.0, 0.0, 1.0);
  }

  let edge = max(params.softness, 1e-5);
  let inside = 1.0 - smoothstep(-edge * 0.5, edge * 0.5, dist);
  return mix(params.bgcolor, params.fillcolor, inside);
}`;
