import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * T1805b: E91 MUSIC FEATURES, one mark per output group of the MusicFeatures component.
 *
 *   notes     five lamps, the bass on the left and the top voice on the right: each lamp's
 *             hue is its pitch class (round the colour wheel, C red), its light its envelope
 *   beats     a bar on the floor that widens and thickens with the kick
 *   harmony   a strip of twelve cells along the top, the root's lit
 *   form      the backdrop, in the root's hue, as bright as the music's energy
 *   tempo     a bead that crosses the bottom line once a beat
 *   levels    the bottom line itself, as bright as the level
 *
 * A generator: the input texture is read for its size only. Every number that moves arrives
 * as a parameter, so the shader knows nothing about music; the wiring is the example.
 * Coordinates: `p` is centred, y down, and 1 is half the height.
 */
export const MUSIC_FEATURES_LAMPS = { spacing: 0.62, y: -0.12, radius: 0.2 } as const;
export const MUSIC_FEATURES_FLOOR_Y = 0.62;
/** The kick bar's half-width: `rest` with no kick, `rest + travel` at a full one. */
export const MUSIC_FEATURES_KICK = { rest: 0.1, travel: 1.6 } as const;
export const MUSIC_FEATURES_STRIP = { left: -1.2, cell: 0.2, y: -0.82 } as const;

export const MUSIC_FEATURES_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  pc0: f32, // @default 0  Voice 0, the bass: pitch class.
  pc1: f32, // @default 0  Voice 1: pitch class.
  pc2: f32, // @default 0  Voice 2: pitch class.
  pc3: f32, // @default 0  Voice 3: pitch class.
  pc4: f32, // @default 0  Voice 4, the top: pitch class.
  env0: f32, // @default 0  Voice 0: envelope.
  env1: f32, // @default 0  Voice 1: envelope.
  env2: f32, // @default 0  Voice 2: envelope.
  env3: f32, // @default 0  Voice 3: envelope.
  env4: f32, // @default 0  Voice 4: envelope.
  kick: f32, // @default 0  The kick pulse.
  root: f32, // @default 0  The harmony's root, as a pitch class.
  energy: f32, // @default 0  Form energy.
  beatPhase: f32, // @default 0  Where in the beat, 0..1.
  level: f32, // @default 0  Loudness.
};
@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

const TAU = 6.28318530718;

/** Round the colour wheel, C red; squared so the twelve stay apart on a dark ground. */
fn hue(h: f32) -> vec3f {
  let soft = 0.5 + 0.5 * cos(TAU * (h + vec3f(0.0, 0.3333, 0.6667)));
  return soft * soft * 1.25;
}

/** A voice as (pitch class, envelope). */
fn voice(index: i32) -> vec2f {
  switch index {
    case 0 { return vec2f(params.pc0, params.env0); }
    case 1 { return vec2f(params.pc1, params.env1); }
    case 2 { return vec2f(params.pc2, params.env2); }
    case 3 { return vec2f(params.pc3, params.env3); }
    default { return vec2f(params.pc4, params.env4); }
  }
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let size = vec2f(textureDimensions(inputTexture));
  let p = (uv - 0.5) * vec2f(size.x / size.y, 1.0) * 2.0;
  let floorY = ${String(MUSIC_FEATURES_FLOOR_Y)};

  // Form: the backdrop. The root's hue, gathered toward the floor, as bright as the energy.
  let rootHue = hue(params.root / 12.0);
  let toFloor = exp(-pow((p.y - floorY) * 1.3, 2.0));
  let vignette = 1.0 - smoothstep(0.6, 2.2, length(p));
  var lit = rootHue * (0.006 + 0.13 * params.energy) * (0.12 + 0.88 * toFloor) * vignette;

  // Notes: five lamps. Unlit, a lamp is its outline and a trace of its hue.
  for (var index = 0; index < 5; index++) {
    let sounding = voice(index);
    let centre = vec2f((f32(index) - 2.0) * ${String(MUSIC_FEATURES_LAMPS.spacing)}, ${String(MUSIC_FEATURES_LAMPS.y)});
    let distance = length(p - centre);
    let colour = hue(sounding.x / 12.0);
    let light = pow(sounding.y, 1.5);
    let disc = 1.0 - smoothstep(${String(MUSIC_FEATURES_LAMPS.radius)}, ${String(MUSIC_FEATURES_LAMPS.radius + 0.012)}, distance);
    let outline = smoothstep(${String(MUSIC_FEATURES_LAMPS.radius)}, ${String(MUSIC_FEATURES_LAMPS.radius + 0.008)}, distance) * (1.0 - smoothstep(${String(MUSIC_FEATURES_LAMPS.radius + 0.016)}, ${String(MUSIC_FEATURES_LAMPS.radius + 0.026)}, distance));
    let halo = exp(-max(distance - ${String(MUSIC_FEATURES_LAMPS.radius)}, 0.0) * 9.0) * (1.0 - disc);
    // A lamp is brightest at its middle, like a bulb behind glass.
    let glass = 0.55 + 0.45 * (1.0 - smoothstep(0.0, ${String(MUSIC_FEATURES_LAMPS.radius)}, distance));
    lit += colour * (0.02 + 1.7 * light) * disc * glass;
    lit += colour * 0.35 * light * halo;
    lit += (vec3f(0.05) + colour * 0.12) * outline;
  }

  // Beats: the kick, a bar on the floor that widens and thickens, and its glow. Squared,
  // so the bar falls back between two kicks though the pulse's tail has not.
  let punch = params.kick * params.kick;
  let reach = ${String(MUSIC_FEATURES_KICK.rest)} + ${String(MUSIC_FEATURES_KICK.travel)} * punch;
  let thick = 0.006 + 0.034 * punch;
  let along = 1.0 - smoothstep(reach, reach + 0.02, abs(p.x));
  let bar = along * (1.0 - smoothstep(thick, thick + 0.008, abs(p.y - floorY)));
  lit += vec3f(1.0, 0.93, 0.82) * bar * (0.2 + 0.8 * punch);
  // The glow ends 0.4 from the floor, short of the lamps: each mark's light is one wire's.
  let nearFloor = exp(-abs(p.y - floorY) * 9.0) * (1.0 - smoothstep(0.2, 0.4, abs(p.y - floorY)));
  lit += vec3f(1.0, 0.75, 0.5) * nearFloor * (1.0 - smoothstep(reach, reach + 0.5, abs(p.x))) * punch * 0.35;

  // Harmony: twelve cells along the top, C on the left; the root's is lit.
  let cells = (p.x - (${String(MUSIC_FEATURES_STRIP.left)})) / ${String(MUSIC_FEATURES_STRIP.cell)};
  let cell = floor(cells);
  let inside = fract(cells);
  let inStrip = step(0.0, cells) * step(cells, 12.0)
    * smoothstep(0.0, 0.08, inside) * (1.0 - smoothstep(0.92, 1.0, inside))
    * (1.0 - smoothstep(0.03, 0.04, abs(p.y - (${String(MUSIC_FEATURES_STRIP.y)}))));
  let isRoot = 1.0 - step(0.5, abs(cell - params.root));
  lit += hue(cell / 12.0) * (0.07 + 0.93 * isRoot) * inStrip;

  // Levels and tempo: the bottom line, and the bead that crosses it once a beat.
  let lineY = 0.84;
  let onLine = (1.0 - smoothstep(0.004, 0.008, abs(p.y - lineY))) * (1.0 - smoothstep(1.2, 1.21, abs(p.x)));
  lit += vec3f(0.6, 0.7, 0.8) * onLine * (0.06 + 0.5 * params.level);
  let bead = vec2f(-1.2 + 2.4 * params.beatPhase, lineY);
  lit += vec3f(1.0) * (1.0 - smoothstep(0.022, 0.032, length(p - bead)));

  return vec4f(lit, 1.0);
}`;
