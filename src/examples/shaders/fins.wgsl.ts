/**
 * E67 Fins — the two shaders of the owner's hand-built piece (T1265), VERBATIM.
 *
 * `FINS_GLASS_WGSL` is the analytic glass raytracer (lofted slabs, traced beams, thin film,
 * the procedural room); `FINS_GRADE_WGSL` is the light-handed final grade. Both are the
 * `source` strings of `glassRT` and `finalGrade` in `fins-11.loom.json` as the owner left
 * them, byte for byte, so the shipped example is the hand-built piece and not a rewrite of
 * it. Each declares its own `SharedFrame` rather than importing `SHARED_UNIFORMS_WGSL`,
 * because that is what the hand-built nodes carry.
 */

export const FINS_GLASS_WGSL = `// ═══ GLASS · analytic ray-traced slabs ═════════════════════════════
// A slab is an oriented box with an EXACT ray intersection. A ray
// enters, refracts, crosses the interior accumulating Beer-Lambert
// absorption, refracts again leaving, and carries on into the NEXT
// slab — which materialGlass structurally cannot do, being screen-space
// and drawing after the opaques, so glass never sees glass.
//
// THE BEAMS ARE TRACED, NOT DRAWN. Each beam used to be an infinite
// straight line that did not know the glass was there: the camera ray
// refracted, the beam did not, so it crossed the stack dead straight.
// Now every beam is fired as a RAY through the same slabs, refracting
// at each interface, offsetting laterally across each body, dimming by
// Fresnel and absorption as it goes. What is stored is the resulting
// POLYLINE, and light is added where a camera segment passes near any
// BEAM SEGMENT. So a beam visibly kinks entering a slab, walks sideways
// inside it, and leaves on a new heading — and each dogleg dims,
// because the energy went somewhere.
//
// The beam path does not depend on the viewer, so this wants computing
// once a frame; a fragment shader has no such place, so it is rebuilt
// per pixel. That is why the beam bounce budget is small and why beams
// below a brightness threshold are skipped entirely — with a short duty
// cycle only one is usually alight, which is what keeps this affordable.
//
// THE BEVEL IS SHADED, NOT MODELLED. A perfect 90-degree edge has ZERO
// AREA and can never catch a highlight; a ground chamfer picks up a
// bright line along the edge. Distance in from each face plane blends
// the normal toward the bisector of the two adjoining faces. The
// silhouette stays sharp, which is a lie you only catch looking for it.
//
// SURFACE IS NOT POLISH: micro-scratches smear a narrow source into a
// streak; THIN-FILM INTERFERENCE cancels wavelengths across the whole
// FACE — the oil-slick sweep, which dispersion cannot produce.
//
// THREE SPIN AXES, DIFFERENT COSTS: selfSpin (own long axis, needs
// spacing > 2*width), spinTumble (end over end, free), spinRoll
// (clock-face, needs spacing > 2*length). Interpenetration is not
// cosmetic — the tracer assumes a ray is inside at most one slab.

struct SharedFrame {
  time: f32,
  deltaTime: f32,
  frameIndex: f32,
  randomSeed: f32,
  wallTime: f32,
  wallDelta: f32,
  absTime: f32,
  absFrame: f32,
  resolution: vec2f,
  pointer: vec4f,
};
struct Params {
  amount: f32,
  envMix: f32,      // @default 0  0 is the built-in panels, 1 is the wired latlong map.
  envPunch: f32,    // @default 0.6  Rebuilds highlight energy an LDR map lost to clipping. 0 for a true HDR.
  envRotate: f32,   // @default 0  Turns the map around the vertical axis, in turns.
  envSpin: f32,     // @default 0.006  Turns per second the room drifts.
  envLevel: f32,    // @default 1  Master level for the whole room.
  slabs: f32,       // @default 9  How many slabs. Up to 16.
  spacing: f32,     // @default 0.44  Pitch along the stack. Must clear the widest the slab ever gets.
  stackAngle: f32,  // @default 0.68  Radians the stack turns AWAY from camera. This is what overlaps them.
  thickness: f32,   // @default 0.055  Half-thickness.
  width: f32,       // @default 0.20  Half-depth — the broad face.
  length: f32,      // @default 0.66  Half-height.
  bevel: f32,       // @default 0.009  Width of the shaded chamfer, in world units.
  bevelAmt: f32,    // @default 1  How fully the edge rounds. 0 is an infinitely sharp, lifeless edge.
  yawBase: f32,     // @default 1.15  Radians the slabs turn to FACE the camera. This is what lets you see through.
  selfSpin: f32,    // @default 0.05  Turns/sec about the slab's own LONG axis. Needs spacing > 2*width.
  spinTumble: f32,  // @default 0  Turns/sec end over end. Costs no spacing at all.
  spinRoll: f32,    // @default 0  Turns/sec clock-face roll. Needs spacing > 2*length.
  spinAlt: f32,     // @default 1  How much neighbours counter-rotate. 1 alternates, 0 all one way.
  spinStagger: f32, // @default 0.085  Turns of fixed offset between neighbours. The helix.
  fan: f32,         // @default 0.22  Yaw spread across the stack.
  wave: f32,        // @default 0.05  Small incoherent wobble.
  waveLen: f32,     // @default 3.7  Slabs per cycle of that wobble.
  spin: f32,        // @default 0.3  Radians of the travelling SPIRAL surge, on top of the steady spin.
  spinRate: f32,    // @default 26  Seconds for one lap of that spiral.
  spinOffset: f32,  // @default 0.16  Turns of phase between neighbours in the spiral.
  surgeCycle: f32,  // @default 52  Seconds between surges.
  surgeFloor: f32,  // @default 0.2  How much spiral remains between surges.
  lean: f32,        // @default 0.05  Tilt off vertical.
  sway: f32,        // @default 0.03  Drift off the stack line.
  motion: f32,      // @default 1  Speed of the whole animation.
  ior: f32,         // @default 1.52  Index of refraction.
  dispersion: f32,  // @default 0.055  Index spread across the band. Splits colour AT EDGES.
  absorb: f32,      // @default 2.6  Absorption per unit path.
  reflFade: f32,    // @default 0.55  How fast reflections fade with depth. Low values white out and cost more.
  edgeLift: f32,    // @default 0.9  Extra brightness where a face turns edge-on. The angle response.
  film: f32,        // @default 0.75  Thin-film iridescence. The oil-slick rainbow ACROSS a face.
  filmThick: f32,   // @default 0.62  Coating thickness. Shifts which colours cancel.
  filmVary: f32,    // @default 0.55  How much the coating varies over a face.
  scratch: f32,     // @default 0.35  Micro-scratch depth.
  scratchScale: f32,// @default 90  Scratch fineness.
  laserCycle: f32,  // @default 26  Seconds for one full pass of all three beams.
  laserDuty: f32,   // @default 5  Briefness of each pass. Higher also means fewer beams alight at once, which is cheaper.
  laserReach: f32,  // @default 0.5  How much of a long segment alongside a beam still counts.
  beamSpan: f32,    // @default 40  How far a beam runs through empty space before and after the stack.
  beamBend: f32,    // @default 1  How much beams refract. 0 sends them straight through, as before.
  laserInside: f32, // @default 4.5  How much brighter a beam scatters INSIDE glass than in the gaps.
  laser: f32,       // @default 2.6  Brightness of beam 1.
  laserHue: f32,    // @default 0.02  Beam 1 colour. Around 0.02 is red.
  laserAim: f32,    // @default 0.45  0 aims across the frame, 1 down the stack (where it becomes a dot).
  laserRadius: f32, // @default 0.016  Beam 1 thickness.
  laser2: f32,      // @default 2  Brightness of beam 2.
  laser2Hue: f32,   // @default 0.55  Beam 2 colour. Around 0.55 is green-cyan.
  laser2Aim: f32,   // @default 0.2  Beam 2 aim blend.
  laser2Radius: f32,// @default 0.021  Beam 2 thickness.
  laser3: f32,      // @default 2.1  Brightness of beam 3.
  laser3Hue: f32,   // @default 0.33  Beam 3 colour. 0.33 is a clean blue.
  laser3Aim: f32,   // @default 0.35  Beam 3 aim blend.
  laser3Radius: f32,// @default 0.014  Beam 3 thickness.
  excite: f32,      // @default 1.6  How strongly a slab lights up when a beam passes through it.
  exciteRadius: f32,// @default 0.42  How close a beam must pass to light a slab.
  glow: f32,        // @default 0.3  Light scattered from INSIDE the glass by a wandering source.
  glowRadius: f32,  // @default 0.6  How far that inner light reaches.
  glowSpeed: f32,   // @default 1  How fast it wanders through the stack.
  gelLevel: f32,    // @default 0.55  Built-in panels, when envMix is below 1.
  stripLevel: f32,  // @default 4  Built-in narrow sources. Raise carefully: these are what white out.
  envDetail: f32,   // @default 5  Bars across the built-in panels.
  detailDepth: f32, // @default 0.5  How deeply those bars cut.
  panelSize: f32,   // @default 0.62  Built-in panel extent.
  panelSoft: f32,   // @default 0.3  Built-in panel edge softness.
  chroma: f32,      // @default 1  Colour intensity of the room.
  fill: f32,        // @default 0.004  Dim ambient so nothing is absolutely dead.
  bg: f32,          // @default 0  Room visible as background. 0 is pure black.
  aa: f32,          // @default 1  Sub-pixel spread. 0 collapses to one ray and goes jagged.
  eyeX: f32,        // @default 0.5  Camera.
  eyeY: f32,        // @default 0.16
  eyeZ: f32,        // @default 2.6
  fov: f32,         // @default 40  Degrees.
  tint: vec3f,      // @default 1  Overall grade.
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

const TAU: f32 = 6.2831853;
const PI: f32 = 3.1415927;
const MAXSLAB: i32 = 16;
const MAXBOUNCE: i32 = 10;
const NBEAM: i32 = 3;
const BPTS: i32 = 6;          // points per beam polyline: 5 segments
const FIRE_EPS: f32 = 0.004;  // below this a beam is skipped entirely

var<private> gR: array<mat3x3f, 16>;
var<private> gC: array<vec3f, 16>;
var<private> gExcite: array<vec3f, 16>;
var<private> gN: i32;
var<private> gGlow: vec3f;

var<private> bCol: array<vec3f, 3>;
var<private> bFire: array<f32, 3>;
var<private> bRad: array<f32, 3>;
var<private> bLev: array<f32, 3>;
var<private> bPt: array<vec3f, 18>;   // NBEAM * BPTS
var<private> bAtt: array<vec3f, 18>;  // energy left at the START of each segment

fn wrapPi(x: f32) -> f32 {
  return x - TAU * floor((x + PI) / TAU);
}

fn hash21(p: vec2f) -> f32 {
  var q = fract(p * vec2f(0.1031, 0.1030));
  q = q + dot(q, q.yx + 33.33);
  return fract((q.x + q.y) * q.x);
}

fn panel(lon: f32, up: f32, cLon: f32, cUp: f32, wLon: f32, wUp: f32) -> f32 {
  let s = clamp(params.panelSoft, 0.02, 0.99);
  let k = max(params.panelSize, 0.05);
  let d = abs(wrapPi(lon - cLon));
  let a = 1.0 - smoothstep(wLon * k * (1.0 - s), wLon * k, d);
  let b = 1.0 - smoothstep(wUp * k * (1.0 - s), wUp * k, abs(up - cUp));
  return a * b;
}

fn stripe(lon: f32, up: f32, cLon: f32, w: f32) -> f32 {
  let d = wrapPi(lon - cLon);
  return exp(-(d * d) / (2.0 * w * w))
       * smoothstep(-0.85, -0.1, up) * smoothstep(0.98, 0.30, up);
}

fn proceduralEnv(lon: f32, up: f32) -> vec3f {
  var gel = vec3f(0.42, 0.32, 1.00) * panel(lon, up,  1.95,  0.24, 0.80, 0.66) * 0.95
          + vec3f(0.22, 0.86, 1.00) * panel(lon, up,  2.85, -0.26, 0.62, 0.52) * 0.85
          + vec3f(1.00, 0.52, 0.16) * panel(lon, up, -0.62,  0.14, 0.74, 0.62) * 1.10
          + vec3f(1.00, 0.26, 0.62) * panel(lon, up, -1.85, -0.24, 0.66, 0.54) * 0.95
          + vec3f(0.55, 1.00, 0.72) * panel(lon, up,  0.55, -0.42, 0.48, 0.40) * 0.55
          + vec3f(1.00, 0.86, 0.42) * panel(lon, up, -3.00,  0.30, 0.56, 0.48) * 0.75;

  let bar = 0.5 + 0.5 * cos(lon * params.envDetail * 2.0 + up * 3.1);
  gel = gel * (1.0 - params.detailDepth * (1.0 - bar * bar));

  let st = stripe(lon, up, 0.62, 0.038) + stripe(lon, up, -2.85, 0.05) * 0.7;
  return gel * params.gelLevel + vec3f(1.0, 0.99, 0.97) * st * params.stripLevel;
}

fn envColor(d: vec3f) -> vec3f {
  let dir = normalize(d);
  let up = clamp(dir.y, -1.0, 1.0);
  let drift = (params.envRotate + frameU.absTime * params.envSpin) * TAU;
  let lon = atan2(dir.z, dir.x) + drift;

  var room = proceduralEnv(lon, up);

  if (params.envMix > 0.001) {
    let uvm = vec2f(fract(lon / TAU + 0.5), clamp(0.5 - asin(up) / PI, 0.0, 1.0));
    let tex = max(textureSampleLevel(inputTexture, inputSampler, uvm, 0.0).rgb,
                  vec3f(0.0, 0.0, 0.0));
    let pk = max(max(tex.r, tex.g), tex.b);
    let boost = 1.0 + params.envPunch * pow(clamp(pk, 0.0, 1.0), 5.0) * 24.0;
    room = mix(room, tex * boost, clamp(params.envMix, 0.0, 1.0));
  }

  let g = dot(room, vec3f(0.2126, 0.7152, 0.0722));
  room = mix(vec3f(g, g, g), room, params.chroma);

  return (room + vec3f(0.08, 0.09, 0.14) * params.fill) * params.envLevel;
}

fn glowAt(p: vec3f) -> f32 {
  let d = p - gGlow;
  let r = max(params.glowRadius, 0.02);
  return exp(-dot(d, d) / (2.0 * r * r));
}

fn hueTint(h: f32) -> vec3f {
  return 0.5 + 0.5 * cos(TAU * (vec3f(0.0, 0.33, 0.67) + h));
}

fn boxSpan(ro: vec3f, rd: vec3f, h: vec3f) -> vec2f {
  let inv = 1.0 / rd;
  let a = (h - ro) * inv;
  let b = (-h - ro) * inv;
  let lo = min(a, b);
  let hi = max(a, b);
  return vec2f(max(max(lo.x, lo.y), lo.z), min(min(hi.x, hi.y), hi.z));
}

fn boxNormal(pl: vec3f, h: vec3f) -> vec3f {
  let d = abs(pl) - h;
  if (d.x > d.y && d.x > d.z) { return vec3f(sign(pl.x), 0.0, 0.0); }
  if (d.y > d.z) { return vec3f(0.0, sign(pl.y), 0.0); }
  return vec3f(0.0, 0.0, sign(pl.z));
}

fn bevelNormal(pl: vec3f, h: vec3f) -> vec3f {
  let hard = boxNormal(pl, h);
  let amt = clamp(params.bevelAmt, 0.0, 1.0);
  if (amt < 0.001) { return hard; }
  let bw = max(params.bevel, 1e-5);
  let q = max(h - abs(pl), vec3f(0.0, 0.0, 0.0));
  let w = exp(-q / bw);
  var nb = vec3f(sign(pl.x) * w.x, sign(pl.y) * w.y, sign(pl.z) * w.z);
  if (dot(nb, nb) < 1e-9) { return hard; }
  nb = normalize(nb);
  return normalize(mix(hard, nb, amt));
}

fn microNormal(pl: vec3f, nl: vec3f) -> vec3f {
  let s = max(params.scratchScale, 1.0);
  let a = pl.z * s + sin(pl.y * s * 0.11) * 1.9;
  let b = pl.y * s * 0.09 + sin(pl.z * s * 0.6) * 1.1;
  var pert = vec3f(sin(a) * 0.55 + sin(a * 2.7 + 1.3) * 0.28,
                   sin(b) * 0.30,
                   sin(a * 0.47 + b) * 0.40);
  pert = pert - nl * dot(pert, nl);
  return normalize(nl + pert * params.scratch * 0.09);
}

fn thinFilm(ct: f32, d: f32) -> vec3f {
  let nf = 1.42;
  let s2 = (1.0 - ct * ct) / (nf * nf);
  let cf = sqrt(max(1.0 - s2, 0.0));
  let opd = 2.0 * nf * d * cf;
  let ph = TAU * opd / vec3f(0.66, 0.55, 0.45);
  return 0.35 + 0.65 * (0.5 + 0.5 * cos(ph));
}

fn fresnelSchlick(ct: f32, f0: f32) -> f32 {
  let m = clamp(1.0 - ct, 0.0, 1.0);
  let m2 = m * m;
  return f0 + (1.0 - f0) * m2 * m2 * m;
}

// Closest distance between two finite segments. The beam is a polyline
// now, so a point-to-infinite-line test no longer describes it.
fn segSegDist(p1: vec3f, q1: vec3f, p2: vec3f, q2: vec3f) -> f32 {
  let d1 = q1 - p1;
  let d2 = q2 - p2;
  let r = p1 - p2;
  let a = dot(d1, d1);
  let e = dot(d2, d2);
  let f = dot(d2, r);
  var s = 0.0;
  var t = 0.0;
  if (a <= 1e-9 && e <= 1e-9) { return length(r); }
  if (a <= 1e-9) {
    t = clamp(f / e, 0.0, 1.0);
  } else {
    let c = dot(d1, r);
    if (e <= 1e-9) {
      s = clamp(-c / a, 0.0, 1.0);
    } else {
      let b = dot(d1, d2);
      let den = a * e - b * b;
      if (den > 1e-9) { s = clamp((b * f - c * e) / den, 0.0, 1.0); }
      t = (b * s + f) / e;
      if (t < 0.0) { t = 0.0; s = clamp(-c / a, 0.0, 1.0); }
      else if (t > 1.0) { t = 1.0; s = clamp((b - c) / a, 0.0, 1.0); }
    }
  }
  return length((p1 + d1 * s) - (p2 + d2 * t));
}

// Fire a beam through the stack and record where it actually goes.
fn traceBeam(k: i32, start: vec3f, dir: vec3f) {
  let h = vec3f(params.thickness, params.length, params.width);
  let eta = params.ior;
  let f0 = ((eta - 1.0) / (eta + 1.0)) * ((eta - 1.0) / (eta + 1.0));
  let far = max(params.beamSpan, 1.0);
  let bend = clamp(params.beamBend, 0.0, 1.0);

  var ro = start;
  var rd = dir;
  var att = vec3f(1.0, 1.0, 1.0);
  var inside = -1;
  let base = k * BPTS;

  bPt[base] = ro;
  bAtt[base] = att;

  var j = 1;
  loop {
    if (j >= BPTS) { break; }

    var bestT = 1e9;
    var bestI = -1;
    for (var i = 0; i < gN; i = i + 1) {
      let lo = (ro - gC[i]) * gR[i];
      let ld = rd * gR[i];
      let sp = boxSpan(lo, ld, h);
      if (sp.y <= sp.x) { continue; }
      var tc = sp.x;
      if (inside == i) { tc = sp.y; }
      if (tc > 1e-4 && tc < bestT) { bestT = tc; bestI = i; }
    }

    if (bestI < 0) {
      // out the far side: run to the horizon and stop
      ro = ro + rd * far;
      bPt[base + j] = ro;
      bAtt[base + j] = att;
      j = j + 1;
      break;
    }

    ro = ro + rd * bestT;
    let pl = (ro - gC[bestI]) * gR[bestI];
    var nw = normalize(gR[bestI] * bevelNormal(pl, h));
    let entering = (inside != bestI);
    if (!entering) {
      att = att * exp(-params.absorb * vec3f(1.0, 1.16, 1.4) * bestT);
      nw = -nw;
    }
    let ci = clamp(dot(-rd, nw), 0.0, 1.0);
    att = att * (1.0 - fresnelSchlick(ci, f0));

    bPt[base + j] = ro;
    bAtt[base + j] = att;
    j = j + 1;

    let e = select(eta, 1.0 / eta, entering);
    let refr = refract(rd, nw, e);
    if (dot(refr, refr) < 1e-6) {
      rd = reflect(rd, nw);
    } else {
      // beamBend at 0 keeps the old dead-straight behaviour
      rd = normalize(mix(rd, normalize(refr), bend));
      inside = select(-1, bestI, entering);
    }
    ro = ro + rd * 2e-4;
  }

  // pad the rest with the last point: zero-length segments are skipped
  for (var m = j; m < BPTS; m = m + 1) {
    bPt[base + m] = ro;
    bAtt[base + m] = vec3f(0.0, 0.0, 0.0);
  }
}

fn beamsAlong(A: vec3f, B: vec3f) -> vec3f {
  var s = vec3f(0.0, 0.0, 0.0);
  let camLen = length(B - A);
  if (camLen < 1e-6) { return s; }
  let reach = max(params.laserReach, 0.02);

  for (var k = 0; k < NBEAM; k = k + 1) {
    if (bFire[k] < FIRE_EPS) { continue; }
    let r = max(bRad[k], 0.004);
    let base = k * BPTS;
    var sum = vec3f(0.0, 0.0, 0.0);
    for (var j = 0; j < BPTS - 1; j = j + 1) {
      let p0 = bPt[base + j];
      let p1 = bPt[base + j + 1];
      if (dot(p1 - p0, p1 - p0) < 1e-8) { continue; }
      let d = segSegDist(A, B, p0, p1);
      let core = exp(-(d * d) / (2.0 * r * r));
      let halo = exp(-(d * d) / (2.0 * r * r * 16.0)) * 0.18;
      sum = sum + (core + halo) * bAtt[base + j];
    }
    s = s + sum * min(camLen, reach) * bFire[k] * bLev[k] * bCol[k];
  }
  return s;
}

fn buildStack(n: f32, t: f32) {
  gN = i32(min(n, f32(MAXSLAB)));

  let sc = max(params.surgeCycle, 1.0);
  let e = 0.5 - 0.5 * cos(TAU * t / sc);
  let surge = mix(clamp(params.surgeFloor, 0.0, 1.0), 1.0, e * e * e);
  let amp = params.spin * surge;

  let sa = params.stackAngle;
  let axis = vec3f(cos(sa), 0.0, sin(sa));
  let perp = vec3f(-sin(sa), 0.0, cos(sa));

  for (var i = 0; i < gN; i = i + 1) {
    let fi = f32(i);
    let c = fi - (n - 1.0) * 0.5;
    let ph = c * TAU / max(params.waveLen, 0.5);
    let pA = 41.0 + 17.0 * sin(fi * 1.73);
    let pB = 67.0 + 23.0 * sin(fi * 2.91 + 1.0);
    let pC = 97.0 + 31.0 * sin(fi * 0.71 + 2.0);

    let odd = fi - 2.0 * floor(fi * 0.5);
    let hand = mix(1.0, select(1.0, -1.0, odd > 0.5), clamp(params.spinAlt, 0.0, 1.0));
    let stag = TAU * params.spinStagger * c;

    let spiral = amp * sin(TAU * (t / max(params.spinRate, 1.0)
                                  - c * params.spinOffset));

    let yaw = -params.yawBase
            + params.fan * (c / max(n * 0.5, 1.0))
            + params.wave * sin(ph + TAU * t / pA)
            + TAU * params.selfSpin * t * hand + stag
            + spiral;
    let lz = params.lean * sin(ph * 0.7 + TAU * t / pB)
           + TAU * params.spinRoll * t * hand + stag * 0.5;
    let px = 0.03 * sin(ph * 1.3)
           + TAU * params.spinTumble * t * hand + stag * 0.75;

    let cy = cos(yaw); let sy = sin(yaw);
    let cz = cos(lz);  let sz = sin(lz);
    let cx = cos(px);  let sx = sin(px);

    gR[i] = mat3x3f(
      vec3f(cy * cz, sz, -sy * cz),
      vec3f(cy * (-sz * cx) + sy * sx, cz * cx, -sy * (-sz * cx) + cy * sx),
      vec3f(cy * (sz * sx) + sy * cx, -cz * sx, -sy * (sz * sx) + cy * cx));

    gC[i] = axis * (c * params.spacing)
          + vec3f(0.0, params.sway * sin(ph * 0.8 + TAU * t / pB), 0.0)
          + vec3f(0.0, 0.0, params.sway * 0.5 * cos(ph * 1.1 + TAU * t / pC));
  }

  let g = t * params.glowSpeed;
  let half = (n - 1.0) * 0.5 * params.spacing;
  gGlow = axis * (half * 1.1 * sin(g * 0.041 * TAU))
        + vec3f(0.0, params.length * 0.55 * sin(g * 0.023 * TAU), 0.0);

  let lc = max(params.laserCycle, 1.0);
  let du = max(params.laserDuty, 1.0);
  let cyc = t / lc;

  bLev[0] = params.laser;  bRad[0] = params.laserRadius;
  bLev[1] = params.laser2; bRad[1] = params.laser2Radius;
  bLev[2] = params.laser3; bRad[2] = params.laser3Radius;
  bCol[0] = hueTint(params.laserHue);
  bCol[1] = hueTint(params.laser2Hue);
  bCol[2] = hueTint(params.laser3Hue);

  for (var k = 0; k < NBEAM; k = k + 1) {
    let ph = cyc - f32(k) / f32(NBEAM);
    bFire[k] = pow(max(0.5 + 0.5 * cos(TAU * ph), 0.0), du);
  }

  let far = max(params.beamSpan, 1.0);

  let a1 = clamp(params.laserAim, 0.0, 1.0);
  let d1 = normalize(mix(normalize(perp + vec3f(0.0, 0.45 * sin(TAU * t / 31.0), 0.0)),
                         axis, a1)
         + vec3f(0.0, 0.22 * sin(TAU * t / 37.0), 0.0));
  let o1 = vec3f(0.0, params.length * 0.6 * sin(TAU * t / 19.0), 0.0)
         + axis * (half * 0.8 * sin(TAU * t / 43.0));

  let a2 = clamp(params.laser2Aim, 0.0, 1.0);
  let d2 = normalize(mix(normalize(-perp * 0.75 - axis * 0.35
                         + vec3f(0.0, 0.55 + 0.35 * sin(TAU * t / 23.0), 0.0)),
                         -axis, a2)
         + vec3f(0.0, -0.18 * sin(TAU * t / 17.0), 0.0));
  let o2 = vec3f(0.0, -params.length * 0.5 * sin(TAU * t / 27.0), 0.0)
         + axis * (half * 0.9 * sin(TAU * t / 33.0 + 2.1))
         + perp * (params.width * 0.8 * sin(TAU * t / 21.0));

  let a3 = clamp(params.laser3Aim, 0.0, 1.0);
  let d3 = normalize(mix(normalize(perp * 0.55 + axis * 0.30
                         + vec3f(0.0, -0.95, 0.0)),
                         axis, a3)
         + perp * 0.20 * sin(TAU * t / 41.0));
  let o3 = vec3f(0.0, params.length * 0.25 * sin(TAU * t / 29.0), 0.0)
         + axis * (half * 0.7 * sin(TAU * t / 47.0 + 1.1))
         - perp * (params.width * 0.9 * sin(TAU * t / 25.0));

  // each beam starts well off stage so it enters the frame already lit
  if (bFire[0] >= FIRE_EPS) { traceBeam(0, o1 - d1 * far * 0.5, d1); }
  if (bFire[1] >= FIRE_EPS) { traceBeam(1, o2 - d2 * far * 0.5, d2); }
  if (bFire[2] >= FIRE_EPS) { traceBeam(2, o3 - d3 * far * 0.5, d3); }

  // a slab lights up by how near the beam's ACTUAL path runs to it
  let er = max(params.exciteRadius, 0.02);
  for (var i = 0; i < gN; i = i + 1) {
    var ex = vec3f(0.0, 0.0, 0.0);
    for (var k = 0; k < NBEAM; k = k + 1) {
      if (bFire[k] < FIRE_EPS) { continue; }
      let base = k * BPTS;
      var near = 1e9;
      for (var j = 0; j < BPTS - 1; j = j + 1) {
        let p0 = bPt[base + j];
        let p1 = bPt[base + j + 1];
        let seg = p1 - p0;
        let ll = dot(seg, seg);
        if (ll < 1e-8) { continue; }
        let u = clamp(dot(gC[i] - p0, seg) / ll, 0.0, 1.0);
        near = min(near, length(gC[i] - (p0 + seg * u)));
      }
      ex = ex + bCol[k] * exp(-(near * near) / (2.0 * er * er))
              * bFire[k] * bLev[k];
    }
    gExcite[i] = ex;
  }
}

fn trace(ro0: vec3f, rd0: vec3f, eta: f32) -> vec3f {
  var ro = ro0;
  var rd = rd0;
  var thr = vec3f(1.0, 1.0, 1.0);
  var acc = vec3f(0.0, 0.0, 0.0);
  var inside = -1;
  var hitAny = false;
  let h = vec3f(params.thickness, params.length, params.width);
  let f0 = ((eta - 1.0) / (eta + 1.0)) * ((eta - 1.0) / (eta + 1.0));

  for (var b = 0; b < MAXBOUNCE; b = b + 1) {
    var bestT = 1e9;
    var bestI = -1;

    for (var i = 0; i < gN; i = i + 1) {
      let lo = (ro - gC[i]) * gR[i];
      let ld = rd * gR[i];
      let sp = boxSpan(lo, ld, h);
      if (sp.y <= sp.x) { continue; }
      var tc = sp.x;
      if (inside == i) { tc = sp.y; }
      if (tc > 1e-4 && tc < bestT) { bestT = tc; bestI = i; }
    }

    if (bestI < 0) { break; }
    hitAny = true;

    let prev = ro;
    ro = ro + rd * bestT;

    let inGlass = (inside == bestI);
    let medium = select(1.0, params.laserInside, inGlass);
    acc = acc + thr * medium * beamsAlong(prev, ro);

    if (inGlass) {
      acc = acc + thr * gExcite[bestI] * params.excite * bestT;
    }

    let pl = (ro - gC[bestI]) * gR[bestI];
    var nw = normalize(gR[bestI] * microNormal(pl, bevelNormal(pl, h)));

    if (inGlass) {
      acc = acc + thr * params.glow * glowAt((prev + ro) * 0.5) * bestT
                * vec3f(1.0, 0.86, 0.72);
      thr = thr * exp(-params.absorb * vec3f(1.0, 1.16, 1.4) * bestT);
      nw = -nw;
    }
    let ci = clamp(dot(-rd, nw), 0.0, 1.0);
    let F = fresnelSchlick(ci, f0);

    let dv = params.filmThick
           * (1.0 + params.filmVary * (sin(pl.y * 5.3 + pl.z * 7.1)
                                     + 0.6 * sin(pl.y * 11.7 - pl.z * 3.3)) * 0.5);
    let irid = mix(vec3f(1.0, 1.0, 1.0), thinFilm(ci, dv), params.film);

    let lift = 1.0 + params.edgeLift * pow(1.0 - ci, 4.0);

    let fade = 1.0 / (1.0 + f32(b) * params.reflFade);
    acc = acc + thr * F * envColor(reflect(rd, nw)) * irid * fade * lift;
    thr = thr * (1.0 - F) * (0.82 + 0.18 * fade);

    let e = select(eta, 1.0 / eta, !inGlass);
    let refr = refract(rd, nw, e);
    if (dot(refr, refr) < 1e-6) {
      rd = reflect(rd, nw);
    } else {
      rd = normalize(refr);
      inside = select(-1, bestI, !inGlass);
    }
    ro = ro + rd * 2e-4;

    if (max(thr.r, max(thr.g, thr.b)) < 0.02) { break; }
  }

  let far = max(params.beamSpan, 1.0);
  acc = acc + thr * 0.55 * beamsAlong(ro, ro + rd * far);

  let back = envColor(rd) * select(params.bg, 1.0, hitAny);
  return acc + thr * back;
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let res = max(frameU.resolution, vec2f(1.0, 1.0));
  let asp = res.x / res.y;
  let t = frameU.absTime * params.motion;
  let n = max(params.slabs, 1.0);
  let ipx = 1.0 / res;

  buildStack(n, t);

  let eye = vec3f(params.eyeX, params.eyeY, params.eyeZ);
  let fwd = normalize(-eye);
  let rgt = normalize(cross(fwd, vec3f(0.0, 1.0, 0.0)));
  let upv = cross(rgt, fwd);
  let tanH = tan(params.fov * 0.008726646);

  var offs = array<vec2f, 4>(
    vec2f(-0.375, -0.125), vec2f( 0.125, -0.375),
    vec2f( 0.375,  0.125), vec2f(-0.125,  0.375));

  var wgt = array<vec3f, 4>(
    vec3f(0.150, 0.030, 0.508),
    vec3f(0.026, 0.324, 0.431),
    vec3f(0.289, 0.500, 0.051),
    vec3f(0.526, 0.147, 0.010));

  let rot = i32(hash21(floor(uv * res)) * 4.0) & 3;

  var col = vec3f(0.0, 0.0, 0.0);
  for (var i = 0; i < 4; i = i + 1) {
    let j = (i + rot) & 3;
    let o = offs[i] * clamp(params.aa, 0.0, 2.0);
    let f = (f32(j) + 0.5) * 0.25 - 0.5;
    let eta = params.ior * (1.0 + params.dispersion * f * 2.0);

    let p = uv + o * ipx;
    let ndc = vec2f((p.x - 0.5) * 2.0 * asp, (0.5 - p.y) * 2.0);
    let rd = normalize(fwd + rgt * ndc.x * tanH + upv * ndc.y * tanH);

    col = col + trace(eye, rd, eta) * wgt[j];
  }

  return vec4f(col * params.tint * params.amount, 1.0);
}
`;

export const FINS_GRADE_WGSL = `// ═══ COMPOSITE · final grade ═══════════════════════════════════════
// Deliberately light-handed. An earlier version crushed the toe hard
// enough to swallow the sculpture: the brief asks for two-thirds of the
// frame almost black, but that darkness has to come from the LIGHTING
// leaving most of the frame empty, not from a curve stamping on it
// afterwards. A grade that has to rescue an exposure is the wrong tool.
//
// So: an asymptotic ceiling that highlights approach and never reach,
// a shallow toe that settles the empty frame without touching anything
// the eye is meant to read, and a light vignette.

struct SharedFrame {
  time: f32,
  deltaTime: f32,
  frameIndex: f32,
  randomSeed: f32,
  wallTime: f32,
  wallDelta: f32,
  absTime: f32,
  absFrame: f32,
  resolution: vec2f,
  pointer: vec4f,
};
struct Params {
  amount: f32,
  exposure: f32,   // @default 1.25  Overall gain, before everything else.
  ceiling: f32,    // @default 2.2  Peak luminance. Highlights approach this and never reach it.
  toe: f32,        // @default 0.012  Settles the empty frame to black. Keep this small.
  vignette: f32,   // @default 0.14  Corner falloff.
  saturation: f32, // @default 1.12  The rolloff desaturates highlights; this puts a little back.
  tint: vec3f,     // @default 1  Overall grade.
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let src = textureSampleLevel(inputTexture, inputSampler, uv, 0.0);
  var col = max(src.rgb, vec3f(0.0, 0.0, 0.0)) * params.tint * params.exposure;

  let ceil = max(params.ceiling, 0.05);
  let luma = max(dot(col, vec3f(0.2126, 0.7152, 0.0722)), 0.0);
  col = col * (ceil / (ceil + luma));

  // shallow toe — settles black without eating the sculpture
  let t = max(params.toe, 1e-5);
  col = col * (col + vec3f(t, t, t) * 0.5) / (col + vec3f(t, t, t));

  let q = (uv - vec2f(0.5, 0.5)) * vec2f(1.0, 0.9);
  let vig = 1.0 - params.vignette * smoothstep(0.14, 0.85, dot(q, q) * 2.4);
  col = col * clamp(vig, 0.0, 1.0);

  let g = dot(col, vec3f(0.2126, 0.7152, 0.0722));
  col = mix(vec3f(g, g, g), col, params.saturation);

  return vec4f(max(col, vec3f(0.0, 0.0, 0.0)), 1.0);
}
`;
