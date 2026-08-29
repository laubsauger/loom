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
 * Ramp — TD's Ramp TOP, with two colour keys instead of an editable key list.
 *
 * A key LIST needs a parameter type that can hold colour stops; the manifest's `curve`
 * type holds scalar {x,y} points and nothing holds colour stops yet. Two keys plus phase,
 * period and an interpolation mode covers the overwhelming majority of real uses (and
 * feeds Lookup, which is where a richer palette actually belongs).
 */
export const RAMP_FRAGMENT_WGSL = `struct Params {
  color1: vec4f,
  color2: vec4f,
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

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let raw = (rampCoordinate(uv) + params.phase) / max(abs(params.period), 1e-6);
  let t = fract(raw);
  var blend = t;
  let mode = u32(params.interp + 0.5);
  if (mode == 1u) {
    blend = smoothstep(0.0, 1.0, t);
  } else if (mode == 2u) {
    blend = step(0.5, t);
  }
  return mix(params.color1, params.color2, blend);
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
 * the port description both say so, and once `texture2d.space` lands (T83) this is the
 * first node in the catalogue whose declared space depends on a parameter.
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
