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
export const REACTOR_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  layers: f32,        // how many nested shells around the core, 0 to 4
  divisions: f32,     // cells per shell on the outermost sphere; inner shells carry fewer
  frameWidth: f32,    // width of the organic frame bars, as a share of a cell
  shellGap: f32,      // radial spacing between shells, as a share of the outer radius
  ior: f32,           // index of refraction of the faces — 1 is inert, 1.5 is glass
  dispersion: f32,    // chromatic split of the reflected core glow per channel
  facet: f32,         // per-cell tilt of each glass face — the disco glitter
  coreGain: f32,      // the core's radiance — driven by the music's level
  coreColor: vec4f,   // the core's hot colour
  edgeColor: vec4f,   // the core's cool rim colour
  laserGain: f32,     // brightness of the radial filaments — driven by the kick
  laserCount: f32,    // how many filaments cut through the shells
  haze: f32,          // density of the light-catching medium between and around the shells
  spin: f32,          // shell counter-rotation rate
  turbulence: f32,    // how hard the core churns
  frameColor: vec4f,  // the frame's own colour under the core's light
  orbit: f32,         // camera orbit rate
  distance: f32,      // camera distance from the core
  exposure: f32,      // master gain on the whole picture before the bloom
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

const PI: f32 = 3.14159265;
const OUTER_R: f32 = 1.0;
const HAZE_R: f32 = 1.9;          // the bound of the exterior haze — beams leak this far
const SHELL_HALF: f32 = 0.012;    // half thickness the frame bars stand proud of the face
const MAX_EVENTS: i32 = 12;       // outer bound + 4 shells × 2 crossings + core + exit
const HAZE_PER_UNIT: f32 = 10.0;  // haze samples per world unit of segment
const HAZE_STEPS_MIN: i32 = 4;
const HAZE_STEPS_MAX: i32 = 18;
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
fn cellEdge(d: vec3f, freq: f32, salt: f32) -> Cell {
  let p = d * freq + vec3f(salt * 7.31, salt * 3.17, salt * 5.53);
  let i = floor(p);
  var f1 = 8.0; var f2 = 8.0;
  var p1 = vec3f(0.0); var p2 = vec3f(0.0);
  for (var z: i32 = -1; z <= 1; z = z + 1) {
    for (var y: i32 = -1; y <= 1; y = y + 1) {
      for (var x: i32 = -1; x <= 1; x = x + 1) {
        let g = i + vec3f(f32(x), f32(y), f32(z));
        let fp = g + hash33(g);
        let dd = dot(fp - p, fp - p);
        if (dd < f1) {
          f2 = f1; p2 = p1;
          f1 = dd; p1 = fp;
        } else if (dd < f2) {
          f2 = dd; p2 = fp;
        }
      }
    }
  }
  var out: Cell;
  out.edge = sqrt(f2) - sqrt(f1);
  out.id = p1;
  out.across = normalize(p2 - p1 + vec3f(1.0e-5, 0.0, 0.0));
  return out;
}

// ---------------------------------------------------------------- the shells
fn layerCount() -> i32 {
  return clamp(i32(round(params.layers)), 0, MAX_LAYERS);
}
fn shellRadius(k: i32) -> f32 {
  return OUTER_R - f32(k) * params.shellGap * OUTER_R;
}
/* The core's radius: just inside the innermost shell, or a bare core with no shells. */
fn coreRadius() -> f32 {
  let n = layerCount();
  return select(0.72, shellRadius(n - 1) - 0.55 * params.shellGap, n > 0);
}
fn shellFreq(k: i32) -> f32 {
  return max(1.0, params.divisions * (1.0 - 0.22 * f32(k)));
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
/* 1 through a face, 0 under a bar, soft over 'soft' of a cell — the light gate. The medium
   reads it wider than the surface does: a shaft's edge blurs with distance from the bar. */
fn gate(p: vec3f, k: i32, soft: f32) -> f32 {
  let c = cellEdge(shellDir(p, k), shellFreq(k), f32(k));
  let w = barWidth(k);
  return smoothstep(w, w + soft, c.edge);
}

/* Light arriving at x from the core, gated by every shell between x and the origin. */
fn coreLightAt(x: vec3f) -> f32 {
  let r = length(x);
  var vis = 1.0;
  let n = layerCount();
  for (var k: i32 = 0; k < MAX_LAYERS; k = k + 1) {
    if (k >= n) { break; }
    let rk = shellRadius(k);
    if (rk < r) { vis = vis * mix(0.03, 1.0, gate(x, k, 0.06 + 0.22 * (r - rk))); }
  }
  return params.coreGain * vis / (r * r + 0.04);
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
  let hot = mix(vec3f(1.0, 0.98, 0.92), params.coreColor.rgb, smoothstep(0.05, 0.45, rn));
  return mix(hot, params.edgeColor.rgb, smoothstep(0.55, 1.0, rn));
}

/* The core's glow seen along a ray that does NOT enter it — what a facet reflects. */
fn coreGlow(o: vec3f, d: vec3f) -> vec3f {
  let b = dot(-o, d);
  let h2 = dot(o, o) - b * b;
  let ahead = smoothstep(-0.3, 0.3, b);
  let g = params.coreGain * ahead / (h2 * 6.0 + 0.15);
  let rn = clamp(sqrt(max(h2, 0.0)) / coreRadius(), 0.0, 1.0);
  return g * 0.9 * coreTint(rn) + laser(normalize(o + d * max(b, 0.0))) * 0.08 * params.coreColor.rgb;
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
fn hazeSegment(o: vec3f, d: vec3f, t0: f32, t1: f32, jitter: f32) -> vec3f {
  let len = t1 - t0;
  if (len <= 0.0) { return vec3f(0.0); }
  // Samples per unit length, not per segment: a grazing ray's long walk through the outer
  // medium was aliasing the gate into shards at a fixed count. The half-step jitter turns
  // what is left into fine static grain rather than banding.
  let steps = clamp(i32(len * HAZE_PER_UNIT), HAZE_STEPS_MIN, HAZE_STEPS_MAX);
  let dt = len / f32(steps);
  var acc = vec3f(0.0);
  for (var s: i32 = 0; s < HAZE_STEPS_MAX; s = s + 1) {
    if (s >= steps) { break; }
    let t = t0 + (f32(s) + 0.25 + 0.5 * jitter) * dt;
    let x = o + d * t;
    let light = coreLightAt(x);
    let r = length(x);
    // Thin inside the ball so the shells read; the medium is for the beams OUTSIDE.
    let dens = params.haze * mix(0.22, 1.0, smoothstep(0.75, 1.05, r)) * smoothstep(HAZE_R, OUTER_R * 0.8, r);
    let beam = 1.0 + laser(normalize(x)) * 4.0;
    let tint = mix(params.coreColor.rgb, params.edgeColor.rgb, smoothstep(0.9, 1.9, r));
    acc = acc + dens * light * beam * tint * dt;
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
    let dens = shell * (0.35 + params.turbulence * (churn - 0.3) * 2.2);
    let fil = laser(normalize(x)) * smoothstep(0.0, 0.25, rn) * (1.0 - rn);
    let emit = params.coreGain * (max(dens, 0.0) * 2.4 + fil * 1.6) * coreTint(rn)
             + params.coreGain * 6.0 * smoothstep(0.55, 0.0, rn) * vec3f(1.0, 0.97, 0.9);
    acc = acc + tr * emit * dt;
    tr = tr * exp(-max(dens, 0.0) * 0.9 * dt);
  }
  return vec4f(acc, tr);
}

/* The frame under the core's light: dark metal, rim-lit from behind, edges glowing where
   the bar thins toward a face — the light bleeding through the frame rather than around it. */
fn shadeFrame(p: vec3f, n: vec3f, d: vec3f, k: i32, edge01: f32) -> vec3f {
  let toCore = normalize(-p);
  let light = coreLightAt(p * 1.02);
  let diff = max(dot(n, toCore), 0.0);
  let back = max(dot(-n, toCore), 0.0);
  let rim = pow(1.0 - max(dot(n, -d), 0.0), 3.0);
  let spec = pow(max(dot(reflect(d, n), toCore), 0.0), 24.0);
  let env = background(reflect(d, n)) * 2.0;
  let base = params.frameColor.rgb;
  let lit = base * (0.04 + 0.9 * diff * light) * params.coreColor.rgb
          + base * 0.25 * back * light * params.edgeColor.rgb
          + spec * light * 0.6 * mix(params.coreColor.rgb, vec3f(1.0), 0.5)
          + rim * light * 0.35 * params.edgeColor.rgb
          + env * (0.15 + 0.5 * rim);
  let bleed = smoothstep(0.55, 1.0, edge01) * light * 0.5 * params.coreColor.rgb;
  return lit + bleed;
}

// ---------------------------------------------------------------- the walk
fn trace(ro: vec3f, rd: vec3f, jitter: f32) -> vec3f {
  var o = ro;
  var d = rd;
  var col = vec3f(0.0);
  var tp = vec3f(1.0);
  let n = layerCount();
  let rc = coreRadius();
  let eta = max(params.ior, 1.0);

  // Before the haze bound there is nothing but background.
  let tb = sphereHit(o, d, HAZE_R);
  if (tb < 0.0) { return background(d); }
  o = o + d * tb;

  for (var e: i32 = 0; e < MAX_EVENTS; e = e + 1) {
    let r = length(o);
    if (r > HAZE_R + 1.0e-3) { break; }

    // The next crossing: the nearest of every shell, the core boundary and the haze bound.
    var tNext = sphereHit(o, d, HAZE_R);
    var kind = -1;                       // -1 exit, 0..3 shell k, 9 core
    for (var k: i32 = 0; k < MAX_LAYERS; k = k + 1) {
      if (k >= n) { break; }
      let tk = sphereHit(o, d, shellRadius(k));
      if (tk > 0.0 && (tNext < 0.0 || tk < tNext)) { tNext = tk; kind = k; }
    }
    let tc = sphereHit(o, d, rc);
    if (tc > 0.0 && (tNext < 0.0 || tc < tNext)) { tNext = tc; kind = 9; }
    if (tNext < 0.0) { break; }

    if (r < rc - 1.0e-4) {
      // Inside the core: march the emissive volume to its far boundary.
      let seg = coreSegment(o, d, 0.0, tNext, jitter);
      col = col + tp * seg.rgb;
      tp = tp * seg.a;
      o = o + d * (tNext + 2.0e-4);
      continue;
    }

    // Haze up to the crossing.
    col = col + tp * hazeSegment(o, d, 0.0, tNext, jitter);
    let p = o + d * tNext;

    if (kind < 0) { col = col + tp * background(d); break; }
    if (kind == 9) { o = p + d * 2.0e-4; continue; }

    // A shell surface. Frame bar, or glass face?
    let k = kind;
    let cell = cellEdge(shellDir(p, k), shellFreq(k), f32(k));
    let w = barWidth(k);
    let sn = normalize(p);
    let entering = dot(d, sn) < 0.0;
    let nOut = select(-sn, sn, entering);

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
    let F = fresnel(cosI, eta);
    let refl = reflect(d, nf);
    // The reflected share reads the core's glow, per channel offset by dispersion.
    let dsp = params.dispersion * 0.6;
    let gR = coreGlow(p, normalize(refl + across3(nf) * dsp)).r;
    let gG = coreGlow(p, refl).g;
    let gB = coreGlow(p, normalize(refl - across3(nf) * dsp)).b;
    col = col + tp * F * (vec3f(gR, gG, gB) + background(refl) * 0.6);
    // The transmitted share bends and walks on; total internal reflection turns it back.
    let k2 = 1.0 - etaHere * etaHere * (1.0 - cosI * cosI);
    var t = refl;
    if (k2 >= 0.0) { t = normalize(etaHere * d + (etaHere * cosI - sqrt(k2)) * nf); }
    tp = tp * (1.0 - F) * vec3f(0.93, 0.96, 0.97);
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

  // The orbit: a slow circle with a breathing elevation, the ball a touch above centre.
  let a = t * params.orbit * 0.12 + 0.6;
  let el = 0.22 + 0.10 * sin(t * 0.071);
  let dist = max(params.distance, 1.2);
  let eye = vec3f(dist * cos(a) * cos(el), dist * sin(el), dist * sin(a) * cos(el));
  let aim = vec3f(0.0, -0.08, 0.0);
  let fwd = normalize(aim - eye);
  let right = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let upv = cross(right, fwd);
  let focal = 1.9;
  let rd = normalize(fwd * focal + right * q.x + upv * q.y);

  // Fixed per-pixel dither for the volume integrals: grain, never flicker.
  let px = floor(uv * frameU.resolution);
  let jitter = hash13(vec3f(px, 1.7));

  var col = trace(eye, rd, jitter) * params.exposure;
  // A gentle vignette keeps the eye on the ball.
  let vig = smoothstep(1.9, 0.4, length(q * vec2f(0.8, 1.0)));
  col = col * mix(0.55, 1.0, vig);
  // The input is read so the binding stays live; it contributes a whisper of its texture.
  let bed = textureSampleLevel(inputTexture, inputSampler, uv, 0.0).rgb;
  col = col + bed * 0.02;
  return vec4f(col, 1.0);
}
`;
