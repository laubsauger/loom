import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * T1757b — E90 CHORD WHEEL: twelve pitch classes as a ring of twelve lamps.
 *
 * One wedge per pitch class, C at the top and rising clockwise, each in its own hue (the
 * class over twelve, round the colour wheel) and as bright as that class sounds. The wedge
 * of the chord's ROOT carries a white rim; the hub takes the root's hue, warm for a major
 * chord and cool for a minor one; the lead note is a white bead riding the outer edge at its
 * pitch class.
 *
 * A generator: the input texture is read for its size only. Every number that moves arrives
 * as a parameter, so the shader knows nothing about music — the wiring is the example.
 */
export const CHORD_WHEEL_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  c0: f32, // @default 0  Pitch class C.
  c1: f32, // @default 0  C sharp.
  c2: f32, // @default 0  D.
  c3: f32, // @default 0  D sharp.
  c4: f32, // @default 0  E.
  c5: f32, // @default 0  F.
  c6: f32, // @default 0  F sharp.
  c7: f32, // @default 0  G.
  c8: f32, // @default 0  G sharp.
  c9: f32, // @default 0  A.
  c10: f32, // @default 0  A sharp.
  c11: f32, // @default 0  B.
  root: f32, // @default 0  The chord's root, as a pitch class.
  quality: f32, // @default 0  0 none, 1 major, 2 minor.
  lead: f32, // @default 0  The lead note's pitch class.
  leadOn: f32, // @default 0  How surely there is a lead note.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

const TAU = 6.28318530718;

fn hue(h: f32) -> vec3f {
  return 0.5 + 0.5 * cos(TAU * (h + vec3f(0.0, 0.3333, 0.6667)));
}

fn level(index: i32) -> f32 {
  switch index {
    case 0 { return params.c0; }
    case 1 { return params.c1; }
    case 2 { return params.c2; }
    case 3 { return params.c3; }
    case 4 { return params.c4; }
    case 5 { return params.c5; }
    case 6 { return params.c6; }
    case 7 { return params.c7; }
    case 8 { return params.c8; }
    case 9 { return params.c9; }
    case 10 { return params.c10; }
    default { return params.c11; }
  }
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  let p = (uv - 0.5) * vec2f(size.x / size.y, 1.0) * 2.0;
  let radius = length(p);
  // C at the top, rising clockwise.
  let turn = fract(atan2(p.x, -p.y) / TAU + 0.5 / 12.0);
  let index = i32(floor(turn * 12.0));
  let within = fract(turn * 12.0);
  let sounding = level(index);
  let colour = hue(f32(index) / 12.0);

  // The ring: a wedge with a dark seam either side, bright by how much its class sounds.
  let ring = smoothstep(0.34, 0.37, radius) * (1.0 - smoothstep(0.80, 0.83, radius));
  let seam = smoothstep(0.0, 0.06, within) * (1.0 - smoothstep(0.94, 1.0, within));
  var lit = colour * (0.035 + 0.965 * sounding * sounding) * ring * seam;

  // The root's wedge wears a white rim, while a chord is claimed.
  let claimed = step(0.5, params.quality);
  let isRoot = claimed * (1.0 - step(0.5, abs(f32(index) - params.root)));
  let rim = smoothstep(0.83, 0.85, radius) * (1.0 - smoothstep(0.87, 0.89, radius)) * seam;
  lit += vec3f(0.9) * rim * isRoot;

  // The hub: the root's hue, warmer for major and cooler for minor.
  let hub = 1.0 - smoothstep(0.26, 0.29, radius);
  let warmth = select(vec3f(0.75, 0.85, 1.15), vec3f(1.15, 0.95, 0.75), params.quality < 1.5);
  lit += hue(params.root / 12.0) * warmth * hub * claimed * 0.55;

  // The lead note: a bead on the outer edge at its pitch class.
  let angle = (params.lead / 12.0) * TAU;
  let bead = vec2f(sin(angle), -cos(angle)) * 0.94;
  lit += vec3f(1.0) * (1.0 - smoothstep(0.035, 0.05, length(p - bead))) * params.leadOn;

  return vec4f(lit, 1.0);
}`;
