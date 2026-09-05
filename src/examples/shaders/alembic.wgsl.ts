import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * E58 Alembic — the domain-warped accumulation march (T1166).
 *
 * ## CREDIT, FIRST, BECAUSE IT IS THE CONSTRAINT THIS FILE WAS WRITTEN UNDER
 *
 * The owner brought five golfed GLSL pieces by **@Xor** — *Cauldron*, *Dielectric*,
 * *Archive*, *Coronal* and *Wave* — and asked for examples out of them. Four of the five
 * differ only in their distance estimate and their colour term; what they share is one
 * primitive, written in the golf dialect as
 *
 *     d = k; for(…) d += d, p += sin(p.zxy*d + z − T)/d
 *
 * an OCTAVE-DOUBLING DOMAIN WARP, under a march that accumulates depth from a cheap
 * non-Euclidean estimate and tone-maps the sum with `tanh`.
 *
 * The TECHNIQUE is common currency — iterated `sin` domain warping, an accumulating
 * pseudo-distance march, `tanh` tone-mapping — and nothing about it is ownable. His
 * SPECIFIC GOLFED SOURCE is his, so nothing below is transcribed from it. This is the
 * instrument those five pictures are made ON, written from the technique, and it is
 * deliberately NOT an attempt to reproduce his five frames: reproducing a picture exactly
 * is what pushes a reimplementation back into copying an expression. The five looks in the
 * `.md` are five coordinates of THIS shader's own parameter space, found by eye here.
 * Credit to @Xor for the family and for the golfs that named it.
 *
 * ## WHAT THE MARCH ACTUALLY IS, because it is not a sphere trace
 *
 * A sphere trace steps by the distance to the nearest surface and STOPS at a hit. This
 * marches through and never stops: at every step it takes a cheap estimate `d` of how far
 * the wall is, steps by it, and adds `colour / d` to the sum. Where the estimate is small
 * the step is small AND the contribution is large, so the ray lingers and glows exactly
 * where it grazes the surface. The result is not a lit solid; it is a density integral —
 * which is why an estimate that is only roughly a distance (`abs(length(p.xy) − 1)`, no
 * Lipschitz bound anywhere) is not merely acceptable but is the whole trick. A wrong
 * distance in a sphere trace is an artefact; here it is a shape.
 *
 * Three consequences worth stating because they read as bugs until you know them:
 *
 *   - `minStep` is a FLOOR under the step, so it caps `colour/d` — it is the brightness of
 *     the wall's core, not a quality knob.
 *   - `looseness` divides the estimate. Larger means smaller steps, more of them near the
 *     wall, a softer and brighter fibre; the picture gets deeper AND slower.
 *   - the sum has no upper bound at all before `tanh`, which is why it needs one. `tanh`
 *     per channel is a hard-shouldered tone-map: it saturates toward white without ever
 *     clipping a channel to a flat plateau, and it is what keeps a hundred divisions by a
 *     number near zero looking like light instead of like an overflow.
 *
 * ## THE WARP, and the one generalisation that is mine rather than the family's
 *
 * The golfs rotate the sample axes with a SWIZZLE — `p.zxy` — which is exactly a 120°
 * rotation about the (1,1,1) diagonal, and is the only rotation a swizzle can spell.
 * `spin()` below does that rotation for any angle, so `twist` is a continuous knob whose
 * value 2.0944 (2π/3) IS the swizzle the technique is normally written with. That is the
 * axis the family never had: at 0 the octaves stack on the same axes and the fold is
 * ridged and directional, near 2π/3 it is isotropic fibre, and the values in between are
 * a sheared weave nobody gets to see when the rotation is a letter permutation.
 *
 * Amplitude is `warpGain / f` against frequency `f` — the 1/f the golfs get for free by
 * writing `sin(p*d)/d` with the same `d` on both sides — so `lacunarity` 2 with
 * `warpGain` 1 is the classic doubling, and `lacunarity` 1.25 (Cauldron's `d /= .8`) is a
 * much denser octave stack that has to be paid for with fewer of them.
 *
 * ## THE COLOUR TERM IS A NODE, NOT A CONSTANT (the point of doing this in Loom at all)
 *
 * Every one of the five golfs ends with a colour expression frozen into its source — a
 * cosine of a few magic constants against one coordinate — and that is precisely §T880's
 * complaint about burying a picture in a custom shader: the artistic direction is in the
 * code, so there is nothing to turn. (Those expressions are not repeated here, for the same
 * reason nothing else of his is: the technique is common currency and his particular art
 * direction is his.) Here the shader carries NO palette. It samples the
 * connected texture as a one-dimensional lookup, and the thing connected is a `ramp` node
 * — sixteen stops, a gradient editor, live. The colour term of this family is a control
 * surface in the graph, and what is left in the shader only says WHERE in that gradient a
 * sample lands: `paletteAxis` is the direction hue runs in through the warped volume — the
 * family's `p.y`, made into an axis you can point — with `paletteScale` and `paletteBias`
 * setting how often it repeats along it and where it starts.
 *
 * Determinism (§V44/§V45): `frameU.absTime` is the only clock, and the dither is a hash of
 * the PIXEL alone, so it is grain that holds still rather than flicker, and the same second
 * of the march is the same frame on every device and every replay.
 */
export const ALEMBIC_WGSL = `${SHARED_UNIFORMS_WGSL}
/*
 * E58 Alembic — a domain-warped accumulation march.
 *
 * CREDIT: the technique is the one behind a family of golfed shaders by @Xor (x.com/XorDev)
 * — Cauldron, Dielectric, Archive, Coronal, Wave. An octave-doubling sine domain warp, under
 * a march that accumulates 'colour / d' from a cheap non-Euclidean estimate and tone-maps the
 * sum with tanh. The technique is common currency; his source is his, and none of it is
 * copied here — this is written from the technique and makes no attempt to match his frames.
 *
 * The ray never stops. At every step it takes an estimate of how far the wall is, steps by
 * it, and adds colour divided by it — so the ray lingers AND brightens exactly where it
 * grazes the surface. It is a density integral, not a lit solid, which is why an estimate
 * that is only roughly a distance is not a compromise but the whole trick.
 *
 * There is no palette in here. The connected texture is read as a 1-D lookup, so the colour
 * term of this shader is whatever gradient node you wire into it.
 */
struct Params {
  octaves: f32,       // how many times the fold refines — the fibre count, and the cost
  baseFreq: f32,      // the first octave's frequency: big soft folds, or small busy ones
  lacunarity: f32,    // frequency growth per octave — 2 is the doubling, 1.25 is a dense stack
  warpGain: f32,      // how far each octave pushes the domain sideways
  twist: f32,         // axis rotation per octave, radians — 2.0944 is the classic zxy swizzle
  flow: f32,          // how fast the fold's phase moves with time
  drift: f32,         // how much marching depth enters that phase — shears the fold into a wake
  radius: f32,        // where the vessel's wall sits, in march units
  flare: f32,         // opens the tube into a funnel with depth (negative flares it outward)
  squash: f32,        // elliptical cross-section: 0 is a circular throat
  wander: f32,        // how far the vessel's axis strays from the ray's
  coil: f32,          // how fast that stray winds around, per unit of depth
  steps: f32,         // samples per ray — the integral's resolution
  looseness: f32,     // how much of the estimate one step takes; larger is softer and dearer
  minStep: f32,       // the floor under a step — this is the brightness of the wall's core
  travel: f32,        // how fast the eye flies down the vessel
  lens: f32,          // field of view: larger is wider
  exposure: f32,      // gain into the tanh — the only thing between the sum and white
  depthFade: f32,     // how fast far samples give up; the sense of a receding throat
  paletteAxis: vec3f, // the direction hue runs in through the volume — the ramp's own axis
  paletteScale: f32,  // how many times the ramp repeats along that axis
  paletteBias: f32,   // slides the whole gradient along it
  grain: f32,         // per-pixel dither on the first step — kills the banding, holds still
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

/* The (1,1,1) diagonal, normalised. 'spin(p, 2.0944)' about it IS 'p.zxy'. */
const AXIS: vec3f = vec3f(0.5773502691896258);

/**
 * Rotation about the diagonal by any angle (Rodrigues) — the swizzle, made continuous.
 *
 * The obvious optimisation is to hoist cos/sin of the angle out of the march: it is a
 * UNIFORM, and this runs once per octave per step, so the naive form asks for hundreds of
 * transcendentals a pixel where two would do. It was written that way, measured PAIRED against
 * this form in one alternation, and PUT BACK: 15.61 ms hoisted against 15.43 unhoisted, which
 * is no difference at all. Tint already hoists a loop-invariant read of a uniform, and the
 * hoisted version was one more argument threaded through two functions in exchange for
 * nothing. The measurement is in 'documents/alembic.ts' beside the rest of the cost work.
 */
fn spin(p: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return p * c + cross(AXIS, p) * s + AXIS * dot(AXIS, p) * (1.0 - c);
}

/**
 * THE FOLD. Each octave displaces the point by a sine of a rotated, scaled copy of itself,
 * with amplitude 1/f — so the first octave moves the domain in great slow arcs and the last
 * only combs it. Feeding the DISPLACED point into the next octave (rather than the original)
 * is what makes this a warp instead of a sum of noises: the fine detail rides the coarse
 * shape, which is why the fibres bundle and braid rather than lying in a flat weave.
 */
fn fold(start: vec3f, phase: f32, octaves: i32) -> vec3f {
  var p = start;
  var f = max(params.baseFreq, 1.0e-3);
  for (var k: i32 = 0; k < octaves; k = k + 1) {
    p = p + (params.warpGain / f) * sin(spin(p, params.twist) * f + phase);
    f = f * params.lacunarity;
  }
  return p;
}

/**
 * THE ESTIMATE — the vessel the march accumulates against, and the whole of its geometry.
 *
 * A surface of revolution about the marching axis: 'radius' sets the wall, 'flare' tapers
 * it with depth, 'squash' makes the throat elliptical, and 'wander'/'coil' let the axis
 * itself corkscrew away from the ray so the tunnel is never a straight pipe. 'abs' is what
 * makes it a WALL rather than a solid — the estimate falls to zero on the surface from both
 * sides, so the march glows on the shell and passes through it.
 *
 * It is not a true distance and does not need to be: nothing here sphere-traces.
 */
fn wall(p: vec3f) -> f32 {
  let stray = vec2f(cos(p.z * params.coil), sin(p.z * params.coil)) * params.wander;
  let q = (p.xy - stray) * vec2f(1.0, 1.0 + params.squash);
  return abs(length(q) + p.z * params.flare - params.radius);
}

/** A fixed per-pixel hash: grain that never moves, so the dither cannot read as flicker. */
fn dither(pixel: vec2f) -> f32 {
  return fract(sin(dot(pixel, vec2f(12.9898, 78.233))) * 43758.5453);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let res = frameU.resolution;
  let aspect = res.x / max(res.y, 1.0);
  /* Screen to ray: y is flipped so the picture is right way up, and the horizontal extent
     carries the aspect, so widening the frame widens the view instead of stretching it. */
  let ndc = (uv - vec2f(0.5)) * vec2f(2.0 * aspect, -2.0);
  let rd = normalize(vec3f(ndc * params.lens, 1.0));
  let t = frameU.absTime;

  let steps = i32(clamp(round(params.steps), 1.0, 200.0));
  let octaves = i32(clamp(round(params.octaves), 0.0, 12.0));
  let loose = max(params.looseness, 1.0e-3);
  /* A FLOOR UNDER THE FLOOR. 'minStep' is an artistic knob and 0 is a value somebody will
     type; at exactly 0 a ray that reaches the wall takes a step of zero for ever and divides
     by zero to get there, so the sum is infinite and the pixel is a NaN. One hundred-
     thousandth is four orders below anything the picture uses. */
  let floorStep = max(params.minStep, 1.0e-5);
  /* The phase is wrapped into one turn before it is used. 'sin' is exactly 2π-periodic, so
     this changes NOTHING about the picture and everything about the arithmetic: an
     unwrapped 't * flow' is an f32 that grows without bound, and after an hour its spacing
     is coarser than the finest octave's period. Wrapped, the phase holds full precision for
     as long as anybody leaves it running. */
  let phase = fract(t * params.flow / 6.283185307) * 6.283185307;
  /* THE EYE FLIES AND THE VESSEL DOES NOT. The warp is sampled in a world that slides past
     — which is what makes the fibres stream toward the viewer and grow — while the vessel
     itself is measured in EYE-RELATIVE coordinates, by subtracting the same slide back off.
     Both halves matter: a warp that did not slide would be a still picture that merely
     wobbles, and a vessel that slid would have its 'flare' term grow without limit until the
     throat sealed shut and the file went dark some minutes in. */
  let slide = vec3f(0.0, 0.0, t * params.travel);

  /* The first step is dithered per pixel. A few dozen samples of a hard-edged shell would
     otherwise lay down visible depth rings; offsetting each ray's start by a fraction of the
     floor step scatters those rings into grain, and because the hash is of the PIXEL and
     nothing else, the grain is fixed in place while the picture moves through it. */
  var z = floorStep * params.grain * dither(uv * res);
  var acc = vec3f(0.0);
  for (var i: i32 = 0; i < steps; i = i + 1) {
    let p = fold(rd * z + slide, phase + z * params.drift, octaves) - slide;
    let d = floorStep + wall(p) / loose;
    /* THE COLOUR TERM, and it lives in the graph: the connected ramp read as a 1-D LUT.
       Hue runs along a DIRECTION through the warped volume ('paletteAxis' — the family's
       'p.y' made into an axis you can point), and the read PING-PONGS rather than wrapping,
       so a gradient may repeat as often as you like without ever drawing the seam a
       'fract' would leave where its two ends meet. Luminance is not in here at all: the
       accumulation supplies that, and 'tanh' whitens whatever burns hardest, which is why
       the fibres' cores go pale while their skirts keep the ramp's colour.
       'textureSampleLevel' rather than 'textureSample' because this is inside a loop, where
       WGSL has no implicit derivatives to offer. */
    let along = params.paletteBias + params.paletteScale * dot(p, params.paletteAxis);
    let key = abs(fract(along * 0.5) * 2.0 - 1.0);
    let tint = textureSampleLevel(inputTexture, inputSampler, vec2f(key, 0.5), 0.0).rgb;
    acc = acc + tint / (d * (1.0 + params.depthFade * z * z));
    z = z + d;
  }

  /* Normalised by the sample count so 'steps' is a QUALITY knob and not a brightness one —
     doubling the samples must refine the picture, not double its exposure. Then tanh, which
     is the family's signature: a soft shoulder that saturates toward white per channel and
     never produces the flat clipped plateau a plain clamp would. */
  /* ⚑ AND THE ARGUMENT IS CLAMPED, WHICH IS NOT PEDANTRY — IT IS A BUG THIS FILE HAD.
     'tanh' is commonly evaluated as (e^2x − 1)/(e^2x + 1), and f32 exp overflows at 2x ≈ 88,
     so a large enough argument returns Inf/Inf = NaN and the pixel comes out BLACK. Found by
     the claim that raising 'exposure' may darken no pixel: at sixteen times the shipped
     gain, six channels went from 255 to 0 — the brightest pixels in the picture, inverted.
     tanh(16) is 1 to well inside f32, so this clamp changes no pixel at any usable exposure
     and removes the cliff at the top of the knob's range. */
  let col = tanh(min(acc * (params.exposure / f32(steps)), vec3f(16.0)));
  return vec4f(col, 1.0);
}`;
