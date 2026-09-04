import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * E55 Reactor — the nested-shell raymarcher (T1141).
 *
 * The owner's ask: an alien disco ball that is lit from INSIDE — a nuclear core whose light
 * gets out through several nested, organic-framed, glass-faced spheres, bending and
 * bouncing on the way. None of that is expressible with the scene pipeline (materialGlass
 * is one screen-space read of what is already drawn; the light node is directional/point
 * with no medium), so it is all ONE fragment shader in E46 Lantern's lane, in 3D.
 *
 * WHAT THE RAY DOES (§I of this file — every effect is a stage of one walk):
 *
 *   1. ANALYTIC SHELLS. Every shell is a sphere, so a crossing is a quadratic, not a march:
 *      the walk hops from crossing to crossing (outer haze bound → shell 0 → … → core → …
 *      → out) and the loop runs at most `MAX_EVENTS` times. No sphere-tracing artefacts on
 *      the glass, ever — the crossing is exact.
 *   2. THE FRAME. On a shell's surface a 3D Worley partition of the DIRECTION (`cellEdge`)
 *      splits it into organic polygonal cells; where the ray meets the surface within
 *      `frameWidth` of a cell border it has hit the frame — an opaque bar, shaded by the
 *      core's light with a rounded profile whose normal is the free by-product of the
 *      Worley search (the direction between the two nearest feature points). Otherwise it
 *      has hit a GLASS FACE.
 *   3. THE GLASS. Each face is a facet: the sphere normal tilted by a per-cell random
 *      vector scaled by `facet`, so neighbouring faces refract and reflect differently —
 *      that per-tile disagreement IS the disco-ball reading. Schlick Fresnel splits the
 *      ray: the reflected share samples the core's glow along the reflected direction
 *      (per channel, offset by `dispersion`), the transmitted share bends by Snell and
 *      keeps walking. Total internal reflection reflects.
 *   4. THE HAZE. Between crossings the ray integrates a thin participating medium lit by
 *      the core: radiance ∝ coreGain / r², SHADOWED by every shell between the sample and
 *      the origin — the same `cellEdge` mask, read as a light gate — so what you see between
 *      and outside the shells is shafts through the faces and dark under the bars. The
 *      `laser` filaments (a coarse radial Worley on direction) ride the same term, so they
 *      cut visible beams through the haze rather than being painted on the core.
 *   5. THE CORE. Inside the innermost shell the ray marches an emissive volume: a churning
 *      fbm density (`turbulence`, on `absTime`) coloured white-hot → coreColor → edgeColor by
 *      radius, plus the filaments. Emission only, with a little absorption for depth.
 *
 * LIVELINESS IS STRUCTURAL (the E54 lesson, T1138): the camera orbits, every shell
 * counter-rotates at its own rate, and the core churns on `frameU.absTime` — none of it is
 * an envelope that can settle, and audio only SCALES gains that are already moving.
 *
 * Deterministic (§V44/§V45): `absTime` is the only clock; the volumetric dither is a hash
 * of the pixel, fixed across frames, so it is grain rather than flicker.
 */
const TEMPLATE = `${SHARED_UNIFORMS_WGSL}
struct Params {
  layers: f32,        // how many nested shells around the core, 0 to 4
  divisions: f32,     // cells on the outermost shell — few and large, so adjacent facets differ in angle; inner shells carry more
  frameWidth: f32,    // width of the organic frame bars, as a share of a cell
  blocked: f32,       // share of the INNERMOST shell's faces that are plates at rest; each shell outward has fewer, the outer none — a skeleton you see through
  strutDepth: f32,    // how far the outer shell's struts stand proud of its faces — the relief that makes the skeleton solid
  shieldOuter: f32,   // the outer shell's shielding, 0 open to 1 shut — driven by drops in the music
  shieldInner: f32,   // the inner shells' shielding, on a slower lag, so the shutters cascade inward
  shellGap: f32,      // radial spacing between shells, as a share of the outer radius — driven by the high-mids
  swell: f32,         // the outer shell's radius — driven by the music's level on the slowest lag, so the ball breathes
  ior: f32,           // index of refraction of the faces — 1 is inert, 1.5 is glass
  dispersion: f32,    // chromatic split of the reflected core glow per channel
  facet: f32,         // per-cell tilt of each glass face — the disco glitter
  glassColor: vec4f,  // the glass's own colour: its head-on reflectance, its scatter, and its transmission tint
  coreGain: f32,      // the core's radiance — driven by the music's level
  coreColor: vec4f,   // the core's hot colour
  edgeColor: vec4f,   // the core's cool rim colour
  laserGain: f32,     // brightness of the radial filaments — driven by the kick
  laserCount: f32,    // how many filaments cut through the shells
  haze: f32,          // density of the light-catching medium between and around the shells
  spin: f32,          // shell counter-rotation rate
  morph: f32,         // how far the cells drift and reshape over time — 0 holds the lattice still
  turbulence: f32,    // how hard the core churns
  frameColor: vec4f,  // the frame's own colour under the core's light
  shellHueStep: f32,  // degrees of hue each shell inward sits from the shared angle — colour deepening toward the core
  orbit: f32,         // camera orbit rate
  distance: f32,      // camera distance at the wide station
  stations: f32,      // how far the camera travels: 0 holds the wide shot, 1 dives through the core and out the far side
  travel: f32,        // seconds for one tour of the three stations
  exposure: f32,      // master gain on the whole picture before the bloom
  hueDrift: f32,      // degrees per minute the whole lit palette turns — core, glass and beams together, the sky stays
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

/* Which half of the picture this pass draws (T1150). PASS 0 is the geometry — shells, glass,
   core, the haze BEHIND the ball along the refracted ray — at the project resolution, and it
   reads the front haze from its input. PASS 1 is the FRONT haze alone: the straight ray from
   the camera through the medium to the first thing it hits, run at half resolution because
   a volumetric is low-frequency and the exterior medium was the whole frame's cost; the
   bilinear read in PASS 0 is the softening that also settles the grain. */
const PASS: i32 = __PASS__;
const PI: f32 = 3.14159265;
const OUTER_R: f32 = 1.0;
const HAZE_R: f32 = 1.9;          // the bound of the exterior haze — beams leak this far
const SHELL_HALF: f32 = 0.012;    // half thickness the frame bars stand proud of the face
const MAX_EVENTS: i32 = 12;       // outer bound + 4 shells × 2 crossings + core + exit
const HAZE_PER_UNIT: f32 = 20.0;  // front haze: samples per world unit (PASS 1, quarter the pixels)
const HAZE_PER_UNIT_BACK: f32 = 8.0; // haze behind the ball along the refracted ray (PASS 0)
const HAZE_STEPS_MIN: i32 = 4;
const HAZE_STEPS_MAX: i32 = 40;
const CORE_STEPS: i32 = 20;       // volumetric samples across the core
const MAX_LAYERS: i32 = 4;

// ---------------------------------------------------------------- hashing and noise
fn hash13(p: vec3f) -> f32 {
  var q = fract(p * 0.1031);
  q = q + vec3f(dot(q, q.zyx + 31.32));
  return fract((q.x + q.y) * q.z);
}
fn hash33(p: vec3f) -> vec3f {
  var q = fract(p * vec3f(0.1031, 0.1030, 0.0973));
  q = q + vec3f(dot(q, q.yxz + 33.33));
  return fract((q.xxy + q.yxx) * q.zyx);
}
fn vnoise(x: vec3f) -> f32 {
  let i = floor(x); let f = fract(x);
  let u = f * f * (3.0 - 2.0 * f);
  let a = mix(hash13(i), hash13(i + vec3f(1.0, 0.0, 0.0)), u.x);
  let b = mix(hash13(i + vec3f(0.0, 1.0, 0.0)), hash13(i + vec3f(1.0, 1.0, 0.0)), u.x);
  let c = mix(hash13(i + vec3f(0.0, 0.0, 1.0)), hash13(i + vec3f(1.0, 0.0, 1.0)), u.x);
  let d = mix(hash13(i + vec3f(0.0, 1.0, 1.0)), hash13(i + vec3f(1.0, 1.0, 1.0)), u.x);
  return mix(mix(a, b, u.y), mix(c, d, u.y), u.z);
}
fn fbm3(x: vec3f) -> f32 {
  var v = 0.0; var a = 0.5; var q = x;
  for (var k: i32 = 0; k < 3; k = k + 1) {
    v = v + a * vnoise(q);
    q = q * 2.07 + vec3f(11.1, 3.3, 7.7);
    a = a * 0.5;
  }
  return v;
}

/* Colour evolution (the owner's round three): ONE hue angle, applied to every lit colour,
   so the hot core, the cold glass and the warm beams keep their relationship while the
   scheme turns — a YIQ rotation, free-running on absTime, minutes per revolution. The sky
   and the stars are not lit by the core and do not turn. */
fn hueTurnBy(c: vec3f, extra: f32) -> vec3f {
  let a = frameU.absTime * params.hueDrift * (PI / 180.0) / 60.0 + extra;
  let y = dot(c, vec3f(0.299, 0.587, 0.114));
  let i = dot(c, vec3f(0.596, -0.274, -0.322));
  let q = dot(c, vec3f(0.211, -0.523, 0.312));
  let ca = cos(a); let sa = sin(a);
  let i2 = i * ca - q * sa;
  let q2 = i * sa + q * ca;
  return max(vec3f(y + 0.956 * i2 + 0.621 * q2, y - 0.272 * i2 - 0.647 * q2, y - 1.106 * i2 + 1.703 * q2), vec3f(0.0));
}
fn hueTurn(c: vec3f) -> vec3f { return hueTurnBy(c, 0.0); }
/* The core's colour cools toward the rim colour as the shell shuts: contained light dims red. */
fn coreRGB() -> vec3f { return hueTurn(mix(params.coreColor.rgb, params.edgeColor.rgb * 0.6, 0.55 * clamp(params.shieldOuter, 0.0, 1.0))); }
fn edgeRGB() -> vec3f { return hueTurn(params.edgeColor.rgb); }
fn glassRGB() -> vec3f { return hueTurn(params.glassColor.rgb); }
/* Colour deepens INWARD: each shell's glass and frame sit a fixed step further round the
   hue circle from the shared angle (the owner's "colour distinction going further inside").
   An offset on the ONE rotating angle, never an independent hue, so the shells keep their
   relationship at every moment of the cycle instead of drifting onto each other. */
fn shellHue(k: i32) -> f32 { return f32(k) * params.shellHueStep * (PI / 180.0); }
fn glassRGBk(k: i32) -> vec3f { return hueTurnBy(params.glassColor.rgb, shellHue(k)); }
fn frameRGBk(k: i32) -> vec3f { return hueTurnBy(params.frameColor.rgb, shellHue(k)); }

fn rotY(v: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(v.x * c - v.z * s, v.y, v.x * s + v.z * c);
}
fn rotX(v: vec3f, a: f32) -> vec3f {
  let c = cos(a); let s = sin(a);
  return vec3f(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}

// ---------------------------------------------------------------- the cell partition
struct Cell {
  edge: f32,     // distance-like measure to the nearest cell border (F2 - F1)
  id: vec3f,     // the owning feature point — stable per cell, the facet's random seed
  across: vec3f, // direction from the nearest feature point to the second — the border normal
};

/* 3D Worley over the direction scaled by freq: organic polygonal cells on the sphere with no
   pole, no seam, and a rounded border profile for free (F2 - F1 grows away from the border).
   27 cells; the jitter is unconstrained so F2 is honest. */
fn cellEdge(d0: vec3f, freq: f32, salt: f32) -> Cell {
  // MORPHING: the direction is warped by three slow travelling sines before the lattice
  // is read, so the cells stretch, shear and slide continuously — faces grow and shrink,
  // borders travel — and never snap. A warp of the LOOKUP, not of the feature points: it
  // costs three sines per read instead of a second hash per cell (which doubled the
  // frame's Worley bill, measured 13.8 → 23 ms, and was refused).
  let t = frameU.absTime;
  let d = normalize(d0 + params.morph * 0.22 * vec3f(
    sin(d0.y * 3.1 + t * 0.23 + salt),
    sin(d0.z * 2.7 - t * 0.19 + salt * 2.0),
    sin(d0.x * 3.3 + t * 0.17 + salt * 3.0)));
  let p = d * freq + vec3f(salt * 7.31, salt * 3.17, salt * 5.53);
  let i = floor(p);
  var f1 = 8.0; var f2 = 8.0;
  var p1 = vec3f(0.0); var p2 = vec3f(0.0);
  var g1 = vec3f(0.0);
  for (var z: i32 = -1; z <= 1; z = z + 1) {
    for (var y: i32 = -1; y <= 1; y = y + 1) {
      for (var x: i32 = -1; x <= 1; x = x + 1) {
        let g = i + vec3f(f32(x), f32(y), f32(z));
        let fp = g + hash33(g);
        let dd = dot(fp - p, fp - p);
        if (dd < f1) {
          f2 = f1; p2 = p1;
          f1 = dd; p1 = fp; g1 = g;
        } else if (dd < f2) {
          f2 = dd; p2 = fp;
        }
      }
    }
  }
  var out: Cell;
  out.edge = sqrt(f2) - sqrt(f1);
  // Identity is the GRID cell the owning point lives in, not the point: the point moves
  // when the lattice morphs, and a facet's tilt or a plate's state hashed off a moving
  // number would flicker. The grid cell never moves.
  out.id = g1;
  out.across = normalize(p2 - p1 + vec3f(1.0e-5, 0.0, 0.0));
  return out;
}

// ---------------------------------------------------------------- the shells
fn layerCount() -> i32 {
  return clamp(i32(round(params.layers)), 0, MAX_LAYERS);
}
fn shellRadius(k: i32) -> f32 {
  return OUTER_R * params.swell - f32(k) * params.shellGap * OUTER_R;
}
/* The core's radius: just inside the innermost shell, or a bare core with no shells. */
fn coreRadius() -> f32 {
  let n = layerCount();
  return select(0.72, shellRadius(n - 1) - 0.55 * params.shellGap, n > 0);
}
fn shellFreq(k: i32) -> f32 {
  return max(1.0, params.divisions * (1.0 + 0.45 * f32(k)));
}
/* Each shell turns at its own rate and alternates direction, so the lattices slide over
   each other and the beams they gate never line up twice. */
fn shellDir(p: vec3f, k: i32) -> vec3f {
  let t = frameU.absTime * params.spin;
  let sgn = select(1.0, -1.0, (k % 2) == 1);
  let d = normalize(p);
  return rotX(rotY(d, sgn * t * (0.11 + 0.05 * f32(k))), 0.35 * f32(k) + 0.2 * sgn * t * 0.37);
}
/* The frame bars in this shell's own scale: bar half-width as a share of a cell. */
fn barWidth(k: i32) -> f32 {
  return params.frameWidth * 0.5;
}
/* A strut's width varies by cell — thick members and fine ones in one frame — so the
   lattice reads as grown rather than extruded. */
fn barWidthAt(c: Cell, k: i32) -> f32 {
  return barWidth(k) * (0.55 + 0.9 * hash13(c.id * 0.731 + vec3f(f32(k) * 3.1, 7.7, 1.3)));
}
/* 1 through a face, 0 under a bar, soft over 'soft' of a cell — the light gate. The medium
   reads it wider than the surface does: a shaft's edge blurs with distance from the bar. */
/* A face is a solid plate when its cell's hash falls under this shell's share. The share
   and the hash salt both vary by shell, so every shell blocks a different set of cells and
   throws its own silhouette into the light. */
fn blockedFace(c: Cell, k: i32) -> bool {
  // A filled panel is a flat polygon, and enough of them turn a skeleton into a paper ball
  // (the owner's read, and it is right). At rest the outer shell has NONE; each shell inward
  // carries more, so the core sits in containment you look through the open frame to see.
  // Closing is the shielding event alone — rare, dramatic, temporary.
  let n = max(layerCount() - 1, 1);
  let depth = f32(k) / f32(n);
  let rest = params.blocked * depth * depth;
  let shield = select(params.shieldInner, params.shieldOuter, k == 0);
  // The shutters: the shield raises the threshold every plate's hash is judged against, so
  // plates close in hash order — a cascade across the shell, not a texture change — and at
  // 1 the shell is solid. A uniform, so driving it recompiles nothing (§T1149).
  let share = mix(rest, 1.0, clamp(shield, 0.0, 1.0));
  return hash13(c.id * 1.37 + vec3f(f32(k) * 13.7, 5.1, 2.3)) < share;
}
fn gate(p: vec3f, k: i32, soft: f32) -> f32 {
  let c = cellEdge(shellDir(p, k), shellFreq(k), f32(k));
  let w = barWidthAt(c, k);
  // A shut plate is a hull, not a wall: a twelfth leaks, so a collapsed ball still glows
  // through its seams and skin rather than going out like a switch.
  return select(smoothstep(w, w + soft, c.edge), 0.12, blockedFace(c, k));
}

/* THE COLLAPSE: the core's radiance itself goes down while the outer shell is shut, and
   its colour cools — "the ball collapsing, light going out" is the core dying back under
   its shielding, not merely a lid on a lamp. Opens back to full on the same lag. */
fn coreGain() -> f32 {
  return params.coreGain * mix(1.0, 0.32, clamp(params.shieldOuter, 0.0, 1.0));
}
/* The core's light at x with no shell in the way — the cheap term for surfaces. */
fn coreLightBare(x: vec3f) -> f32 {
  let r = length(x);
  return coreGain() / (r * r + 0.04);
}

/* Light arriving at x from the core, gated by the shells between x and the origin. Outside
   the ball only the two outer shells gate: the third's shadow has already passed two gates
   and is not worth a Worley per sample (the exterior haze is the file's whole cost). */
fn coreLightAt(x: vec3f) -> f32 {
  let r = length(x);
  var vis = 1.0;
  let n = select(layerCount(), min(layerCount(), 2), r > OUTER_R);
  for (var k: i32 = 0; k < MAX_LAYERS; k = k + 1) {
    if (k >= n) { break; }
    let rk = shellRadius(k);
    if (rk < r) { vis = vis * mix(0.03, 1.0, gate(x, k, 0.05 + 0.10 * (r - rk))); }
  }
  return coreGain() * vis / (r * r + 0.04);
}

/* The radial filaments: a coarse Worley on direction; borders become sheets from the core. */
fn laser(d: vec3f) -> f32 {
  let t = frameU.absTime;
  let dd = rotY(rotX(d, 0.31 * t), -0.23 * t);
  let c = cellEdge(dd, max(1.0, params.laserCount), 9.0);
  return params.laserGain * smoothstep(0.09, 0.0, c.edge);
}

/* Colour of the core by normalised radius: white-hot centre, hot body, cool rim. */
fn coreTint(rn: f32) -> vec3f {
  let hot = mix(vec3f(1.0, 0.98, 0.92), coreRGB(), smoothstep(0.05, 0.45, rn));
  return mix(hot, edgeRGB(), smoothstep(0.55, 1.0, rn));
}

/* The core's glow seen along a ray that does NOT enter it — what a facet reflects. */
fn coreGlow(o: vec3f, d: vec3f) -> vec3f {
  let b = dot(-o, d);
  let h2 = dot(o, o) - b * b;
  let ahead = smoothstep(-0.3, 0.3, b);
  let g = coreGain() * ahead / (h2 * 6.0 + 0.15);
  let rn = clamp(sqrt(max(h2, 0.0)) / coreRadius(), 0.0, 1.0);
  return g * 1.4 * coreTint(rn) + laser(normalize(o + d * max(b, 0.0))) * 0.08 * coreRGB();
}

fn fresnel(cosI: f32, eta: f32) -> f32 {
  let r0 = (eta - 1.0) / (eta + 1.0);
  let f0 = r0 * r0;
  return f0 + (1.0 - f0) * pow(1.0 - cosI, 5.0);
}

/* Nearest forward crossing with a sphere of radius r; -1 when there is none. */
fn sphereHit(o: vec3f, d: vec3f, r: f32) -> f32 {
  let b = dot(o, d);
  let c = dot(o, o) - r * r;
  let disc = b * b - c;
  if (disc < 0.0) { return -1.0; }
  let s = sqrt(disc);
  let t0 = -b - s;
  let t1 = -b + s;
  if (t0 > 1.0e-4) { return t0; }
  if (t1 > 1.0e-4) { return t1; }
  return -1.0;
}

// ---------------------------------------------------------------- the background
fn background(d: vec3f) -> vec3f {
  let up = d.y * 0.5 + 0.5;
  var sky = mix(vec3f(0.006, 0.007, 0.014), vec3f(0.012, 0.02, 0.05), up);
  let neb = fbm3(d * 2.2 + vec3f(3.0, 1.0, 0.0));
  sky = sky + vec3f(0.02, 0.012, 0.04) * smoothstep(0.55, 0.8, neb);
  let cell = floor(d * 90.0);
  let star = hash13(cell);
  let near = length(fract(d * 90.0) - 0.5);
  sky = sky + vec3f(0.6, 0.7, 0.9) * smoothstep(0.996, 1.0, star) * smoothstep(0.25, 0.0, near);
  return sky;
}

// ---------------------------------------------------------------- integrators
/* Haze along [o + d·t0, o + d·t1]: core light × density, gated by the shells. */
/* Returns (core-tinted weight, edge-tinted weight): the colour is applied by whoever reads
   it, so the half-res pass carries no palette and the two passes cannot disagree about it. */
fn hazeSegment(o: vec3f, d: vec3f, t0: f32, t1: f32, jitter: f32, perUnit: f32) -> vec2f {
  let len = t1 - t0;
  if (len <= 0.0 || params.haze <= 0.0) { return vec2f(0.0); }
  // Samples per unit length, not per segment: a grazing ray's long walk through the outer
  // medium was aliasing the gate into shards at a fixed count. The half-step jitter turns
  // what is left into fine static grain rather than banding.
  let steps = clamp(i32(len * perUnit), HAZE_STEPS_MIN, HAZE_STEPS_MAX);
  let dt = len / f32(steps);
  var acc = vec2f(0.0);
  for (var s: i32 = 0; s < HAZE_STEPS_MAX; s = s + 1) {
    if (s >= steps) { break; }
    let t = t0 + (f32(s) + 0.25 + 0.5 * jitter) * dt;
    let x = o + d * t;
    let light = coreLightAt(x);
    let r = length(x);
    // Thin inside the ball so the shells read; the medium is for the beams OUTSIDE.
    // Thin between the shells, a bright skirt around the core, dense outside for the beams.
    let dens = params.haze * (mix(0.22, 1.0, smoothstep(0.75, 1.05, r)) + 0.3 * smoothstep(0.7, 0.2, r))
             * smoothstep(HAZE_R, OUTER_R * 0.8, r);
    // Streaks: any function of DIRECTION alone is constant along a radius, so a fine noise on
    // the direction reads as striation running with the beam rather than lumps sitting on it.
    let dir = normalize(x);
    let streak = 0.55 + 0.9 * vnoise(rotY(dir, frameU.absTime * 0.05) * 9.0);
    let beam = (1.0 + laser(dir) * 4.0) * streak;
    let m = smoothstep(0.95, 1.7, r);
    acc = acc + dens * light * beam * dt * vec2f(1.0 - m, m);
  }
  return acc;
}

/* The emissive core from t0 to t1 along the ray. Returns rgb and the surviving throughput. */
fn coreSegment(o: vec3f, d: vec3f, t0: f32, t1: f32, jitter: f32) -> vec4f {
  let len = t1 - t0;
  if (len <= 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
  let dt = len / f32(CORE_STEPS);
  let rc = coreRadius();
  let tm = frameU.absTime;
  var acc = vec3f(0.0);
  var tr = 1.0;
  for (var s: i32 = 0; s < CORE_STEPS; s = s + 1) {
    let t = t0 + (f32(s) + jitter) * dt;
    let x = o + d * t;
    let rn = clamp(length(x) / rc, 0.0, 1.0);
    let shell = 1.0 - rn * rn;
    let churn = fbm3(x * (3.5 / rc) + vec3f(0.0, tm * 0.35, tm * 0.21) + vec3f(0.3 * sin(tm * 0.7)));
    // Contrast in the churn is what keeps the core from reading as a smooth ball through
    // the shells: the fbm is pushed hard around its mean and the floor is low.
    let dens = shell * (0.12 + params.turbulence * (churn - 0.42) * 4.5);
    let fil = laser(normalize(x)) * smoothstep(0.0, 0.25, rn) * (1.0 - rn);
    let emit = coreGain() * (max(dens, 0.0) * 3.2 + fil * 1.6) * coreTint(rn)
             + coreGain() * 5.0 * smoothstep(0.6, 0.0, rn) * mix(vec3f(1.0, 0.97, 0.9), coreRGB(), 0.4);
    acc = acc + tr * emit * dt;
    tr = tr * exp(-max(dens, 0.0) * 0.9 * dt);
  }
  return vec4f(acc, tr);
}

/* The frame under the core's light: dark metal, rim-lit from behind, edges glowing where
   the bar thins toward a face — the light bleeding through the frame rather than around it. */
fn shadeFrame(p: vec3f, n: vec3f, d: vec3f, k: i32, edge01: f32) -> vec3f {
  let toCore = normalize(-p);
  let light = coreLightBare(p) * 0.6;
  let diff = max(dot(n, toCore), 0.0);
  let back = max(dot(-n, toCore), 0.0);
  let rim = pow(1.0 - max(dot(n, -d), 0.0), 3.0);
  let spec = pow(max(dot(reflect(d, n), toCore), 0.0), 24.0);
  let env = background(reflect(d, n)) * 2.0;
  let base = frameRGBk(k);
  let lit = base * (0.04 + 0.9 * diff * light) * coreRGB()
          + base * 0.35 * light * mix(coreRGB(), vec3f(1.0), 0.3)
          + light * 0.09 * mix(coreRGB(), vec3f(1.0), 0.5) * (0.5 + 0.5 * max(dot(n, -d), 0.0))
          + base * 0.25 * back * light * edgeRGB()
          + spec * light * 0.6 * mix(coreRGB(), vec3f(1.0), 0.5)
          + rim * light * 0.35 * edgeRGB()
          + env * (0.15 + 0.5 * rim);
  let bleed = smoothstep(0.55, 1.0, edge01) * light * 0.3 * coreRGB();
  return lit + bleed;
}

// ---------------------------------------------------------------- the walk
fn hazeColour(w: vec2f) -> vec3f { return w.x * coreRGB() + w.y * edgeRGB(); }

/* The outer shell's strut as a SOLID: a tube of radial depth strutDepth lying along every
   cell border. Signed distance = max(distance from the shell band, distance from the border
   band), in world units, so a ray can be marched through it and a strut can stand proud of
   the faces, occlude the face behind it, and break the silhouette — the thing a shaded
   sphere cannot do. Only the outer shell pays for this. */
fn strutSdf(p: vec3f, k: i32) -> vec2f {
  let R = shellRadius(k);
  let c = cellEdge(shellDir(p, k), shellFreq(k), f32(k));
  let w = barWidthAt(c, k);
  let dr = abs(length(p) - R) - params.strutDepth;
  let de = (c.edge - w) * R / shellFreq(k);
  return vec2f(max(dr, de), select(0.0, 1.0, blockedFace(c, k)));
}

/* The first event along the straight ray from o: the nearest of every shell, the core
   boundary and the haze bound. Shared by both passes so they agree where the front ends. */
fn firstEvent(o: vec3f, d: vec3f) -> vec2f {
  let n = layerCount();
  var tNext = sphereHit(o, d, HAZE_R);
  var kind = -1.0;
  for (var k: i32 = 0; k < MAX_LAYERS; k = k + 1) {
    if (k >= n) { break; }
    let tk = sphereHit(o, d, shellRadius(k));
    if (tk > 0.0 && (tNext < 0.0 || tk < tNext)) { tNext = tk; kind = f32(k); }
  }
  let tc = sphereHit(o, d, coreRadius());
  if (tc > 0.0 && (tNext < 0.0 || tc < tNext)) { tNext = tc; kind = 9.0; }
  return vec2f(tNext, kind);
}

fn trace(ro: vec3f, rd: vec3f, jitter: f32, uv: vec2f) -> vec3f {
  var o = ro;
  var d = rd;
  var col = vec3f(0.0);
  var tp = vec3f(1.0);
  let n = layerCount();
  let rc = coreRadius();
  let eta = max(params.ior, 1.0);

  // Before the haze bound there is nothing but background. An eye already inside it (the
  // close and inside stations) starts where it is.
  if (length(o) >= HAZE_R) {
    let tb = sphereHit(o, d, HAZE_R);
    if (tb < 0.0) { return background(d); }
    o = o + d * tb;
  }

  for (var e: i32 = 0; e < MAX_EVENTS; e = e + 1) {
    let r = length(o);
    if (r > HAZE_R + 1.0e-3) { break; }

    let ev = firstEvent(o, d);
    let tNext = ev.x;
    let kind = i32(ev.y);                // -1 exit, 0..3 shell k, 9 core
    if (tNext < 0.0) { break; }

    if (r < rc - 1.0e-4) {
      // Inside the core: march the emissive volume to its far boundary.
      let seg = coreSegment(o, d, 0.0, tNext, jitter);
      col = col + tp * seg.rgb;
      tp = tp * seg.a;
      o = o + d * (tNext + 2.0e-4);
      continue;
    }

    // Haze up to the crossing. The FRONT segment (e == 0, the straight ray from the haze
    // bound to the first thing it meets) was drawn by PASS 1 at half resolution and arrives
    // on the input; every later segment rides a refracted ray only this pass knows.
    if (e == 0) {
      col = col + hazeColour(textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rg);
    } else {
      col = col + tp * hazeColour(hazeSegment(o, d, 0.0, tNext, jitter, HAZE_PER_UNIT_BACK));
    }
    let p = o + d * tNext;

    if (kind < 0) { col = col + tp * background(d); break; }
    if (kind == 9) { o = p + d * 2.0e-4; continue; }

    // A shell surface. Frame bar, or glass face?
    let k = kind;
    var sn = normalize(p);
    var entering = dot(d, sn) < 0.0;

    if (k == 0 && params.strutDepth > 0.001) {
      // RELIEF. Walk the ray through the outer shell's band [R − depth, R + depth] against
      // the strut solid; a hit is a strut with a real normal (sphere-radial on its crown,
      // tangent on its flanks); no hit means the ray reached the face plane.
      let R = shellRadius(0);
      let depth = params.strutDepth;
      let insideBand = length(o) < R + depth && length(o) > R - depth;
      let tIn = select(sphereHit(o, d, R + depth), 0.0, insideBand);
      var tw = max(tIn, 0.0);
      // An eye inside the band itself (the dive passing through the shell) skips the solid:
      // a strut sitting on the lens is a black frame, and the pass takes a few frames.
      var hit = false;
      if (insideBand) { tw = 1.0e9; }
      var ph = p;
      for (var st: i32 = 0; st < 10; st = st + 1) {
        ph = o + d * tw;
        let rr = length(ph);
        if (rr > R + depth + 1.0e-3 && dot(ph, d) > 0.0) { break; }
        if (rr < R - depth - 1.0e-3 && dot(ph, d) < 0.0) { break; }
        let sd = strutSdf(ph, 0).x;
        if (sd < 0.0015) { hit = true; break; }
        tw = tw + max(sd, 0.004);
      }
      if (hit) {
        let rr = length(ph);
        let radial = normalize(ph);
        let c = cellEdge(shellDir(ph, 0), shellFreq(0), 0.0);
        let across = normalize(c.across - radial * dot(c.across, radial) + vec3f(1.0e-5));
        let onCrown = smoothstep(0.0, depth * 0.6, abs(rr - R));
        let ns = normalize(radial * sign(rr - R) * (0.35 + onCrown) + across * (1.0 - onCrown) * 0.9);
        let prof = 1.0 - clamp((c.edge - 0.0) / max(barWidthAt(c, 0), 1.0e-4), 0.0, 1.0);
        col = col + tp * shadeFrame(ph, ns, d, 0, prof);
        tp = vec3f(0.0);
        break;
      }
      // Reached the faces: continue at the sphere crossing as before.
    }

    let cell = cellEdge(shellDir(p, k), shellFreq(k), f32(k));
    let w = barWidthAt(cell, k);
    let nOut = select(-sn, sn, entering);

    // A plate within a hand's width of the lens (the dive passing through a shut shell) is
    // read as glass: a plate ON the lens is a flat wall for the frames it takes to pass.
    // And from INSIDE the ball (the dive) the plates are read as glass: the inside view is
    // the skeleton around the core, not the backs of shutters.
    if (blockedFace(cell, k) && tNext > 0.06 && length(ro) > shellRadius(0)) {
      // A shut plate is RECESSED behind its frame — a shell of flush plates is a smooth
      // sphere, and a smooth sphere is a balloon however it is lit (the owner's read). The
      // ray continues to the inset surface; where it lands under a strut it has met the
      // strut's inner wall, elsewhere the plate: CONTAINED light, not a dead hull — the
      // frame's material across the face, a seam that glows where the plate meets its
      // strut, and a skin thin enough that the core's light shows through as a dull heat.
      let R = shellRadius(k);
      let recess = max(params.strutDepth, 0.02) * 1.3;
      let inset = select(R - recess, R + recess, !entering);
      let t2 = sphereHit(o, d, inset);
      var p2 = p;
      if (t2 > tNext) { p2 = o + d * t2; }
      let c2 = cellEdge(shellDir(p2, k), shellFreq(k), f32(k));
      let w2 = barWidthAt(c2, k);
      let wall = c2.edge < w2 * 1.6;
      let n2 = select(nOut, normalize(c2.across - nOut * dot(c2.across, nOut) + vec3f(1.0e-5)) * -1.0, wall);
      let seam = smoothstep(w2 + 0.3, w2, c2.edge);
      let heat = coreLightBare(p2) * 0.6;
      let plate = shadeFrame(p2, n2, d, k, seam) * select(0.75, 0.35, wall)
                + seam * seam * heat * 1.4 * mix(coreRGB(), vec3f(1.0, 0.9, 0.7), 0.3)
                + select(heat * 0.035 * coreRGB() * max(dot(n2, -d), 0.0), vec3f(0.0), wall);
      col = col + tp * plate;
      tp = vec3f(0.0);
      break;
    }

    if (cell.edge < w) {
      // Rounded bar: the sphere normal tilted toward the border by how close we are to it.
      let across = normalize(cell.across - sn * dot(cell.across, sn) + vec3f(1.0e-5));
      let prof = (1.0 - cell.edge / max(w, 1.0e-4));
      let nb = normalize(nOut + across * prof * prof * 0.9);
      col = col + tp * shadeFrame(p, nb, d, k, prof);
      tp = vec3f(0.0);
      break;
    }

    // Glass face: a per-cell facet, Fresnel-split.
    let tilt = (hash33(cell.id) - 0.5) * 2.0;
    let nf = normalize(nOut + (tilt - nOut * dot(tilt, nOut)) * params.facet * 0.35);
    let cosI = clamp(dot(-d, nf), 0.0, 1.0);
    let etaHere = select(1.0 / eta, eta, entering);
    // Schlick alone is ~3% head-on and only grows at grazing, so a colour that lives in it
    // vanishes the moment a face turns toward you (the owner's first note). The glass gets a
    // floor on its head-on reflectance, tinted its own colour, and a scatter term that
    // carries the same colour through the face under the core's light.
    // The outer shell's glass keeps a head-on floor (its colour must survive facing you);
    // the inner shells' glass is clearer, or each one reads as a balloon behind the frame.
    let F = max(fresnel(cosI, eta), select(0.02, 0.06, k == 0));
    let fTint = mix(vec3f(1.0), glassRGBk(k), 0.8);
    let refl = reflect(d, nf);
    let lightHere = coreLightBare(p) * 0.6;
    col = col + tp * glassRGBk(k) * select(0.008, 0.02, k == 0) * lightHere;
    // The reflected share reads the core's glow, per channel offset by dispersion.
    let dsp = params.dispersion * 0.6;
    let gR = coreGlow(p, normalize(refl + across3(nf) * dsp)).r;
    let gG = coreGlow(p, refl).g;
    let gB = coreGlow(p, normalize(refl - across3(nf) * dsp)).b;
    col = col + tp * F * fTint * (vec3f(gR, gG, gB) + background(refl) * 0.6);
    // The transmitted share bends and walks on; total internal reflection turns it back.
    let k2 = 1.0 - etaHere * etaHere * (1.0 - cosI * cosI);
    var t = refl;
    if (k2 >= 0.0) { t = normalize(etaHere * d + (etaHere * cosI - sqrt(k2)) * nf); }
    tp = tp * (1.0 - F) * mix(vec3f(0.97), glassRGB() * 0.4 + 0.6, select(0.08, 0.18, k == 0));
    d = t;
    o = p + d * 3.0e-4;
    if (max(max(tp.r, tp.g), tp.b) < 0.01) { break; }
  }
  return col;
}

/* A tangent-ish direction to offset the dispersion samples along. */
fn across3(n: vec3f) -> vec3f {
  let a = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(n.x) > 0.9);
  return normalize(cross(n, a));
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = frameU.resolution.x / max(frameU.resolution.y, 1.0);
  let q = (uv - vec2f(0.5)) * vec2f(aspect, -1.0) * 2.0;
  let t = frameU.absTime;

  // The orbit: a circle wide enough that the shells slide across each other (parallax is
  // the depth cue), with a breathing elevation, the ball a touch above centre.
  let a = t * params.orbit * 0.22 + 0.6;
  let el = 0.22 + 0.18 * sin(t * 0.071);
  // Three stations, toured on the free-running clock and EASED between (a cut throws the
  // parallax away): wide, close on the shell surface with struts passing the lens, and
  // between the outer shells looking in at the core through the inner lattices. stations
  // scales how far from the wide shot the tour goes; 0 is the wide shot held.
  // THE DIVE. One signed distance along the orbit's radial, in five legs: wide → close on
  // the surface → THROUGH the centre → out the far side (a negative distance is the
  // antipode) → wide again, looking back. Eased; struts sweep past the lens at the surface
  // and the core fills the frame at the centre — the parallax a shell cannot fake.
  let wideD = max(params.distance, 1.2);
  let u = fract(t / max(params.travel, 1.0)) * 4.0;
  let seg = floor(u);
  let fu = fract(u);
  // Legs 0 and 2 dwell at their ends; leg 1 — the dive — is ONE continuous motion through
  // the centre with no dwell there: the core is passed at speed, never parked in.
  let fDwell = smoothstep(0.2, 0.8, fu);
  let fThrough = fu * fu * (3.0 - 2.0 * fu);
  var dA = wideD; var dB = wideD; var f = fDwell;
  if (seg == 0.0) { dA = wideD; dB = wideD * 0.55; }
  else if (seg == 1.0) { dA = wideD * 0.55; dB = -wideD * 0.55; f = fThrough; }
  else if (seg == 2.0) { dA = -wideD * 0.55; dB = -wideD; }
  else { dA = -wideD; dB = -wideD; }
  let stations = clamp(params.stations, 0.0, 1.0);
  let dist = mix(wideD, mix(dA, dB, f), stations);
  // The last leg swings half a turn around the ball at wide distance, which brings the
  // antipode back to the near side for the next tour.
  let swing = select(0.0, fDwell * PI, seg == 3.0) * stations;
  let a2 = a + swing;
  let radial = vec3f(cos(a2) * cos(el), sin(el), sin(a2) * cos(el));
  let eye = radial * dist;
  // Looking at the core from outside; through the dive the gaze holds its travel direction
  // (a look-at through the centre would snap as the eye passes it), then eases back.
  // Ahead only while INSIDE the ball; once out the far side the gaze turns back to the core
  // over the next half unit of travel — "back out and around" is looking back at it.
  let diving = smoothstep(1.25, 0.7, abs(dist));
  let aimCentre = vec3f(0.0, -0.08, 0.0) * clamp(abs(dist) - 1.0, 0.0, 1.0);
  let aimAhead = eye - radial * 2.0;
  let aim = mix(aimCentre, aimAhead, diving);
  let fwd = normalize(aim - eye + vec3f(0.0, 1.0e-4, 0.0));
  let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let upv = cross(right, fwd);
  let focal = 1.9;
  let rd = normalize(fwd * focal + right * q.x + upv * q.y);

  // Fixed per-pixel dither for the volume integrals: grain, never flicker.
  // White-noise hash, fixed per pixel. Interleaved gradient noise was tried for its evenness
  // and refused: its lattice reads as a dot screen in a still, worse than grain.
  let px = floor(uv * frameU.resolution);
  let jitter = hash13(vec3f(px, 1.7));

  if (PASS == 1) {
    // The front haze only, as two weights; the input (a dark bed) is read to keep the
    // binding live and contributes nothing.
    let bed = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).r * 0.0;
    var o = eye;
    if (length(eye) < coreRadius()) { return vec4f(bed, 0.0, 0.0, 1.0); }
    if (length(eye) >= HAZE_R) {
      let tb = sphereHit(eye, rd, HAZE_R);
      if (tb < 0.0) { return vec4f(0.0, 0.0, 0.0, 1.0); }
      o = eye + rd * tb;
    }
    let ev = firstEvent(o, rd);
    let w = hazeSegment(o, rd, 0.0, max(ev.x, 0.0), jitter, HAZE_PER_UNIT);
    return vec4f(w.x + bed, w.y, 0.0, 1.0);
  }

  // Exposure follows the station: the eye near the core sees the same radiance the wide
  // shot integrates over a whole disc, so the close and inside stations stop down.
  let stop = mix(0.07, 1.0, smoothstep(0.15, wideD, abs(dist)));
  var col = trace(eye, rd, jitter, uv) * params.exposure * stop;
  // A gentle vignette keeps the eye on the ball.
  let vig = smoothstep(1.9, 0.4, length(q * vec2f(0.8, 1.0)));
  col = col * mix(0.55, 1.0, vig);
  return vec4f(col, 1.0);
}
`;

/** The geometry pass at the project resolution — the node whose page holds every knob. */
export const REACTOR_WGSL = TEMPLATE.replace("__PASS__", "0");
/** The front-haze pass, run at half resolution by the node's resolution override (T1150). */
export const REACTOR_HAZE_WGSL = TEMPLATE.replace("__PASS__", "1");
