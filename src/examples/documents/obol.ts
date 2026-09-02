import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/* The MASS's grid — recovered at T724 with the mass itself. 208x160 with wrapU, so the
   longitude seam closes and the blob has no slit down it. */
const OBOL_COLS = 208;

const OBOL_ROWS = 160;

const OBOL_POINTS = OBOL_COLS * OBOL_ROWS;

/**
 * THE TILES. 1728 of them since T716, and the number is a size rather than a taste. A
 * phyllotaxis lattice of N tiles over a face of radius 0.888 has a hexagonal pitch of
 * 1.0746*sqrt(pi*0.888^2/N), so 1728 gives 0.0407 — and a 0.038 tile then closes to 93.4%
 * of its own spacing: a 6.6% gutter, about 26 screen pixels of tile and 2 of gutter at
 * 1280x720. BOTH bounds are load-bearing now that there is no bed behind the mosaic
 * (T716): past about 115% the tiles interpenetrate and the face goes back to being the
 * solid disc the owner asked us to remove, and below about 60% it is confetti. The count
 * itself only sets how finely the dividing curve is drawn — the coverage is the ratio.
 */
const OBOL_SEG_COLS = 54;

const OBOL_SEG_ROWS = 32;

const OBOL_SEG_POINTS = OBOL_SEG_COLS * OBOL_SEG_ROWS;

/**
 * E33's SHARED WGSL. One definition of the emblem's field, the melt's order and the goo's
 * field, pasted into BOTH kernels below. T673 shared it so a tile could not hover off the
 * face it was inlaid into; T724 gives it a second and harder job, because the mass now
 * has to GROW under an arriving tile at the moment that tile lands, which means both
 * kernels have to agree about the tile's station, its order in the wave and where the
 * goo's surface is. Two copies of that arithmetic is two chances for the skin to
 * materialise somewhere the tiles are not.
 */
const OBOL_PRELUDE = `const TAU: f32 = 6.28318530717958647692;
const PI: f32 = 3.14159265358979323846;

fn ihash(cell: vec3i) -> f32 {
  let q = vec3u(cell + vec3i(4096));
  var n = (q.x * 1597334673u) ^ (q.y * 3812015801u) ^ (q.z * 2246822519u);
  n = (n ^ (n >> 15u)) * 2246822519u;
  n = (n ^ (n >> 13u)) * 3266489917u;
  return f32(n ^ (n >> 16u)) * 2.3283064e-10;
}

fn vnoise(p: vec3f) -> f32 {
  let base = floor(p);
  let f = p - base;
  let w = f * f * (3.0 - 2.0 * f);
  let c = vec3i(base);
  let x00 = mix(ihash(c + vec3i(0, 0, 0)), ihash(c + vec3i(1, 0, 0)), w.x);
  let x10 = mix(ihash(c + vec3i(0, 1, 0)), ihash(c + vec3i(1, 1, 0)), w.x);
  let x01 = mix(ihash(c + vec3i(0, 0, 1)), ihash(c + vec3i(1, 0, 1)), w.x);
  let x11 = mix(ihash(c + vec3i(0, 1, 1)), ihash(c + vec3i(1, 1, 1)), w.x);
  return mix(mix(x00, x10, w.y), mix(x01, x11, w.y), w.z) * 2.0 - 1.0;
}

fn fbm(p: vec3f) -> f32 {
  return vnoise(p) * 0.74 + vnoise(p * 2.07 + vec3f(19.1, 7.3, 31.7)) * 0.20
       + vnoise(p * 4.19 + vec3f(41.7, 63.1, 11.9)) * 0.06;
}

fn spectrum(t: f32) -> vec3f {
  var stops = array<vec3f, 6>(
    vec3f(0.014, 0.020, 0.058),
    vec3f(0.048, 0.098, 0.290),
    vec3f(0.235, 0.086, 0.372),
    vec3f(0.556, 0.108, 0.276),
    vec3f(0.812, 0.372, 0.104),
    vec3f(0.972, 0.836, 0.560),
  );
  let x = clamp(t, 0.0, 1.0) * 5.0;
  let lo = u32(floor(x));
  let hi = min(lo + 1u, 5u);
  return mix(stops[lo], stops[hi], x - floor(x));
}

fn taiji(p: vec2f) -> f32 {
  let e = 0.030;
  let dTop = distance(p, vec2f(0.0, 0.5));
  let dBot = distance(p, vec2f(0.0, -0.5));
  var tone = smoothstep(-e, e, p.x);
  tone = max(tone, smoothstep(e, -e, dTop - 0.5));
  tone = min(tone, smoothstep(-e, e, dBot - 0.5));
  tone = min(tone, smoothstep(-e, e, dTop - 0.142));
  tone = max(tone, smoothstep(e, -e, dBot - 0.142));
  return tone;
}

/* ---- THE ORDER OF THE MELT, in the emblem's own disc coordinate. Built from the two
   circles the S-curve is built from, so the front LEAVES THE SEAM and travels outward.
   The mass and the segments both read it, so a tile lifts exactly as the surface under
   it goes soft. */
fn meltOrder(d: vec2f) -> f32 {
  let arcTop = distance(d, vec2f(0.0, 0.5)) - 0.5;
  let arcBot = distance(d, vec2f(0.0, -0.5)) - 0.5;
  return clamp(min(abs(arcTop), abs(arcBot)) / 0.42, 0.0, 1.0) * 0.6 + length(d) * 0.4;
}

/* ---- THE GOO, as a FOUR-CHARGE METABALL. This is the answer to "still too much like a
   sphere", and the reason it is a field rather than more noise: displacement on a sphere
   changes TEXTURE, and the eye reads shape from the OUTLINE. Only a low-frequency term
   moves the outline, so the lobes are the whole point and the noise below is a skin.
   The CORE charge is load-bearing: without it the three lobes separate and a ray from
   the origin misses entirely, which is a radius of zero and a torn mesh. */
fn gooCentre(k: u32, t: f32) -> vec3f {
  var dirs = array<vec3f, 3>(
    vec3f( 0.895,  0.264,  0.113),
    vec3f(-0.680, -0.566,  0.321),
    vec3f( 0.039,  0.877, -0.479),
  );
  let d = dirs[k] * 0.66;
  let a = t * 0.115 + f32(k) * 2.094;
  return vec3f(
    d.x * cos(a) - d.z * sin(a),
    d.y + 0.10 * sin(t * 0.21 + f32(k) * 1.7),
    d.x * sin(a) + d.z * cos(a),
  );
}

fn gooField(p: vec3f, t: f32) -> f32 {
  var weights = array<f32, 3>(0.130, 0.107, 0.081);
  var f = 0.085 / max(dot(p, p), 1e-5);
  for (var k = 0u; k < 3u; k = k + 1u) {
    let d = p - gooCentre(k, t);
    f = f + weights[k] / max(dot(d, d), 1e-5);
  }
  return f;
}

/* The radius along s where the field crosses 1, found from the OUTSIDE IN. A bracketed
   bisection would converge on whichever crossing it happened to trap, and a ray through
   three charges can cross three times — neighbouring directions landing on different
   crossings is a CRACK in the mesh. Scanning inward always takes the outermost. */
fn gooRadius(s: vec3f, t: f32) -> f32 {
  let top = 1.70;
  let step = top / 30.0;
  var lo = 0.0;
  var hi = 0.0;
  for (var i = 1u; i <= 30u; i = i + 1u) {
    let r = top - f32(i) * step;
    if (gooField(s * r, t) > 1.0) { lo = r; hi = r + step; break; }
  }
  if (hi == 0.0) { return 0.10; }
  for (var j = 0u; j < 7u; j = j + 1u) {
    let mid = (lo + hi) * 0.5;
    if (gooField(s * mid, t) > 1.0) { lo = mid; } else { hi = mid; }
  }
  return (lo + hi) * 0.5;
}

/* The goo's surface point along s: the lobed radius, a small high-frequency skin (texture,
   NOT outline), and a differential sag so the thing hangs rather than floats. */
fn gooAt(s: vec3f, t: f32) -> vec3f {
  let r = gooRadius(s, t) * (1.0 + 0.050 * fbm(s * 2.60 + vec3f(0.0, t * 0.090, 0.0)));
  var g = s * r;
  g.y = g.y - 0.105 * (1.0 - s.y * 0.55);
  g.x = g.x + 0.045 * sin(t * 0.27);
  return g;
}

/* The medallion's own tilt — 17 degrees, so the rim bevel is on screen as a lit edge and
   a disc seen dead-on cannot be mistaken for a sphere. Shared: a tile that did not wear
   the same tilt would float off the face it is inlaid into. */
fn emblemTilt(p: vec3f) -> vec3f {
  let tilt = 0.30;
  return vec3f(p.x, p.y * cos(tilt) - p.z * sin(tilt), p.y * sin(tilt) + p.z * cos(tilt));
}

/* The object's slow yaw. On the ABSOLUTE clock and applied last, to both readings. */
fn obolYaw(p: vec3f, t: f32) -> vec3f {
  let yaw = 0.21 * sin(t * 0.185);
  return vec3f(p.x * cos(yaw) + p.z * sin(yaw), p.y, -p.x * sin(yaw) + p.z * cos(yaw));
}

/* ---- THE STAGING. A sine never HOLDS, and a morph the eye cannot register the ends of
   reads as a crossfade. Squeezing the drive to the middle of the LFO's travel parks the
   piece at each configuration for about a third of the cycle each and spends the rest
   travelling — so there is a medallion, then an event, then a goo. */
fn meltDrive(v: f32) -> f32 {
  return smoothstep(0.18, 0.82, v);
}
`;

/**
 * THE MASS — the organic blob, and ONLY the blob (T724). Its emblem configuration is
 * deleted: the coin behind the mosaic was the disc the owner objected to, and it was the
 * only thing this kernel drew at the emblem end. What is left is the shape the whole piece
 * morphs onto, plus the rule for when it is there.
 */
const OBOL_KERNEL = `${OBOL_PRELUDE}
fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  let lon = f32(ctx.dim.i) / f32(ctx.dim.cols) * TAU;
  let lat = f32(ctx.dim.j) / f32(max(ctx.dim.rows - 1u, 1u)) * PI;
  let s = vec3f(sin(lat) * cos(lon), sin(lat) * sin(lon), cos(lat));

  /* T724 — THE MASS IS ONLY THE GOO, AND IT GROWS INTO EXISTENCE UNDER THE TILES.
     Its emblem configuration is deleted: the coin behind the mosaic was the disc the
     owner asked us to remove (T716), and it was the only thing this kernel did at the
     emblem end. What is left is the organic blob — which is the gimmick — plus the rule
     for when it is there. */

  /* WHICH TILE LANDS HERE. The tiles walk a Fibonacci sphere whose latitude is z = 1 - 2u
     against a Fibonacci disc of radius 0.930*sqrt(u), and both share their azimuth — so
     the disc station of the tile arriving along s is recoverable exactly, and this
     surface can be told to appear ON THAT TILE'S OWN CLOCK. That is what makes the fuse
     read as one event instead of two: the skin materialises under a tile at the moment
     the tile reaches it, not on a schedule of its own. */
  let ax = vec2f(s.x, s.y);
  let axLen = length(ax);
  /* the pole is one point with no azimuth; give it its neighbours' RADIUS rather than
     the disc centre's, or it grows first while everything around it grows last and the
     mesh leaves a spike standing at the south pole. */
  let dir2 = select(vec2f(1.0, 0.0), ax / max(axLen, 1e-6), axLen > 1e-4);
  let station = dir2 * (0.930 * sqrt(max(0.0, (1.0 - s.z) * 0.5)));

  let order = meltOrder(station);
  let drive = meltDrive(ctx.value1);
  let front = clamp(drive * 2.35 - order * 1.35, 0.0, 1.0);
  let melt = front * front * (3.0 - 2.0 * front);

  /* A BUD, not a switch. The radius runs from a speck to the field's own value on the
     same front the tiles ride, so the drop swells out of the seam under the arriving
     mosaic. melt is smooth in s, so the surface stays star-shaped about the origin
     at every intermediate size and nothing tangles. The floor is not zero: a mesh
     collapsed to a point has no normals, and 0.010 is a speck 2px across at 1280x720,
     behind the mosaic that is still standing in front of it. */
  q.position = obolYaw(gooAt(s, ctx.absTime) * mix(0.010, 1.0, melt), ctx.absTime);

  /* ONE WET BLACK THING. There is no emblem configuration left to travel from, so there
     is no rest tone here any more — the tiles carry the emblem, all of it. What the
     mass keeps is the halved marbling that stops the oil reading as flat paint, and the
     spectrum on the growth front, which is what makes the skin look like it is forming
     rather than being revealed. */
  let tone = taiji(station);
  let oil = mix(vec3f(0.0125, 0.0120, 0.0195), vec3f(0.0335, 0.0315, 0.0290), tone);
  let band = 1.0 - abs(melt * 2.0 - 1.0);
  let irid = spectrum(fract(order * 1.85 + ctx.value2 + tone * 0.18));
  let colour = oil + irid * band * band * 0.26 * (1.0 - tone * 0.55);
  q.tint = vec4f(colour, 1.0);
  return q;
}`;

/* THE TILES. The owner's own idea, and after T716/T724 it is the emblem end's ONLY
   substance: the medallion is not decorated with tiles and it is not a disc with tiles on
   it, it IS the tiles. That is what the owner asked for — "the obol thing should not have
   the disc behind the cubes assembling the yinyang" — and the mass is grown down to a
   speck there rather than merely hidden, so that dropping `body1` from the render changes
   ZERO pixels of the emblem frame.

   AND THE GOO END IS THE ORGANIC BLOB, which is the gimmick (T724). The tiles do not have
   to BE the drop — a drop made of cubes is the thing the owner did not ask for. They travel
   ONTO it and FUSE into it, which is a better event than either end alone: the mosaic opens,
   the skin buds out underneath, and each tile lands on the surface and settles just inside
   it. Discrete becoming continuous.

   THE MAP IS WHAT MAKES THE FUSE LEGIBLE. The disc layout is a Fibonacci lattice
   (`rr = sqrt(u)`, `ang = i*137.5deg`) and the Fibonacci SPHERE is the same sequence read
   with `z = 1 - 2u`. Every tile keeps its azimuth exactly, the centre of the face goes to
   one pole and the rim to the other, and the density is area-uniform at both ends — so an
   individual tile can be FOLLOWED across the change rather than being re-dealt, and the

   mass can invert that map to grow on the arriving tile's own clock. */
const OBOL_SEG_KERNEL = `${OBOL_PRELUDE}
/* Stable per-segment noise. NOT pointRand: that hash is salted with the FRAME index by
   contract, so a "random" draw taken per point changes every frame — a per-element
   constant has to come from the element's own index. */
fn segRand(i: u32, salt: u32) -> f32 {
  var n = (i * 1597334673u) ^ (salt * 2246822519u);
  n = (n ^ (n >> 15u)) * 2246822519u;
  n = (n ^ (n >> 13u)) * 3266489917u;
  return f32(n ^ (n >> 16u)) * 2.3283064e-10;
}

fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;

  /* PHYLLOTAXIS, not a grid. A polar lattice crowds at the centre and a square one leaves
     a stepped rim; the golden angle gives even spacing at every radius, so the tile size
     can be one number and the mosaic still has no seam. */
  let n = f32(max(ctx.count, 1u));
  let u = (f32(ctx.index) + 0.5) / n;
  let ang = f32(ctx.index) * 2.39996323;
  let rr = sqrt(u) * 0.930;
  let disc = vec2f(rr * cos(ang), rr * sin(ang));

  /* CONFIGURATION A — the tile IS the medallion. There is no bed behind it (T716): the
     face, the two tones and the dividing curve are carried by the tiles ALONE, and the
     mass is grown down to a speck at this end of the morph so that the disc the owner
     objected to genuinely is not there. Measured: dropping body1 from the render
     changes ZERO pixels of the emblem frame. The small height jitter is what keeps the
     tiles reading as laid pieces rather than as one plate, and it is what the key light's
     shadow and the occlusion pass bite on. */
  let face = sqrt(max(0.0, 1.0 - dot(disc, disc)));
  let plateau = smoothstep(0.0, 0.36, face);
  let relief = plateau * 0.125 + 0.030 + 0.008 * segRand(ctx.index, 47u);
  let emblem = emblemTilt(vec3f(disc.x, disc.y, relief) * 0.955);

  /* CONFIGURATION B — the SAME tile's place on the goo's SKIN. The disc's golden-angle
     layout is a Fibonacci lattice and the Fibonacci SPHERE is that same sequence read with
     z = 1 - 2u, so this map keeps every tile's AZIMUTH exactly, sends the centre of the
     face to one pole and the rim to the other, and is area-uniform at both ends. One tile,
     one continuous journey, and an eye can follow it the whole way. */
  let zc = 1.0 - 2.0 * u;
  let ring = sqrt(max(0.0, 1.0 - zc * zc));
  let sdir = vec3f(ring * cos(ang), ring * sin(ang), zc);

  let order = meltOrder(disc);
  let drive = meltDrive(ctx.value1);
  let front = clamp(drive * 2.35 - order * 1.35, 0.0, 1.0);
  let melt = front * front * (3.0 - 2.0 * front);

  /* THE MASS IS BACK AT THIS END (T724), so the tiles no longer have to BE the skin —
     they LAND on it. They ride a little proud of the field's own radius while the front
     passes, which is what lets the eye follow one cube all the way in, and then settle
     just under it: a tile drawn ON an oil drop is a barnacle, a tile drawn just inside it
     is a tile that has fused. The drop is at full size again — T716 shrank it to 0.620
     because 1728 fixed-size tiles could not cover a sphere twice the area of the face,
     and with a surface under them that constraint is gone — which is the whole reason the
     goo end is an ORGANIC BLOB again rather than a blob made of cubes. */
  let sink = mix(1.030, 0.880, smoothstep(0.45, 1.0, front));
  let goo = gooAt(sdir, ctx.absTime) * sink;

  /* The ARC. Straight-line travel between two configurations is a crossfade with extra
     steps; lifting each tile off its own normal at the half-way point makes the change a
     FLIGHT, and the band peaks exactly where the wave is passing. */
  let band = 1.0 - abs(melt * 2.0 - 1.0);
  let lift = normalize(emblem - vec3f(0.0, -0.12, 0.0)) * band * band * (0.16 + 0.10 * segRand(ctx.index, 29u));

  q.position = obolYaw(mix(emblem, goo, melt) + lift, ctx.absTime);

  /* THE TWO HALVES ARE THE TILES' OWN COLOUR — at the emblem end there is nothing under
     them to carry the S-curve, so the emblem is legible only if this tone survives at
     tile resolution. Measured rather than hoped: see the gate in examples.gpu.test.ts. */
  let tone = taiji(disc);
  let porcelain = vec3f(0.400, 0.388, 0.360);
  let ink = vec3f(0.0180, 0.0205, 0.0295);
  let oil = mix(vec3f(0.0125, 0.0120, 0.0195), vec3f(0.0335, 0.0315, 0.0290), tone);
  let irid = spectrum(fract(order * 1.85 + ctx.value2 + tone * 0.18));
  let colour = mix(mix(ink, porcelain, tone), oil, melt) + irid * band * band * 0.34 * (1.0 - tone * 0.55);
  q.tint = vec4f(colour, 1.0);
  return q;
}`;

const OBOL_SWEEP_COLS = 64;

const OBOL_SWEEP_ROWS = 96;

const OBOL_SWEEP_POINTS = OBOL_SWEEP_COLS * OBOL_SWEEP_ROWS;

/**
 * The studio itself: a CYCLORAMA, not a floor. A floor ends, and its far edge lands
 * inside a 42° frame as a hard horizon with black above it — which is the "floating
 * torus and no screen" failure of §V383 wearing a different hat. Curving the same grid
 * up into a cove removes the horizon entirely and gives the key light something to
 * throw a shadow onto.
 */
const OBOL_SWEEP_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let across = p.position.x * 19.0;
  let run = (p.position.y * 0.5 + 0.5);
  let depth = 2.5 - run * 23.0;
  let rise = clamp((-2.0 - depth) / 16.0, 0.0, 1.0);
  q.position = vec3f(across, -1.04 + 14.0 * rise * rise, depth);
  return q;
}`;

/**
 * E33 — Obol (T625/T624, reworked T673, T716, T724).
 *
 * WHAT YOU SEE. A yin-yang medallion — SEVENTEEN HUNDRED little tiles and nothing behind
 * them — turns slowly on a dark studio sweep under two softboxes it can see in itself. It
 * holds. Then its dividing curve goes soft, and the tiles lift off the face in a wave that
 * leaves the seam and travels outward, arc, and close again around a three-lobed drop of
 * black oil that pinches between its lobes and hangs. It holds there too. Then the whole
 * thing runs backwards and the medallion reassembles, tile by tile. One sixteen-second
 * breath, both directions.
 *
 * **The morph is a deformation with a FRONT, not a cross-fade.** Every tile carries two
 * configurations — a place on the medallion and a place on the goo — and ONE rule decides
 * how far along it has travelled, from its distance to the emblem's own dividing curve.
 * The seam melts first and re-forms last, so the picture is always ONE object changing
 * shape. A cross-fade at 50% shows a ghost of both; this shows a medallion whose middle
 * has already gone liquid while its rim is still a hard edge, and its own tiles in the air
 * between the two states.
 *
 * **T716: nothing is behind the tiles AT THE EMBLEM END.** The owner, on the T673 build:
 * "the obol thing should not have the disc behind the cubes assembling the yinyang". The
 * mass's coin configuration is deleted and the mass itself is grown down to a speck there,
 * so the tiles are the only thing drawing the medallion. THE MEASUREMENT THAT SAYS WHY:
 * shrink the tiles to `scale 0.007` and the T673 file's emblem is STILL a legible yin-yang
 * (the smaller of its two tone populations holds 41.3% of the object) because the disc was
 * drawing it, while this one collapses to 19.1%. That is the owner's complaint stated
 * arithmetically, and it is why the emblem's legibility is now measured rather than
 * assumed — 45.6% / 129.6 luma of tone contrast / 17.4% straight-line error.
 *
 * **T724: and the goo end is the ORGANIC BLOB, which is the gimmick.** T716 read the note
 * as "the mass must go" and made the goo end a blob built of cubes; the owner: "obol is
 * supposed to morph onto the organic blob not a blob made up of cubes thats the whole
 * gimmick on top of the reorg". The complaint was only ever about the EMBLEM end. So the
 * mass is back at the goo end and FADES IN as the morph runs, with the tiles landing on
 * its surface and settling just inside it — discrete becoming continuous, which is a
 * better event than either end alone and is what makes a cube followable all the way in.
 * Measured: dropping `body1` changes 0 pixels of the emblem frame and 106,056 of the goo
 * frame, and the goo end's object-to-room separation recovers to 41.7 luma — past T716's
 * 31.6 and past T673's own 38.4, because the gutters the tiles used to show through are
 * now closed by a skin.
 *
 * ## What T673 changed, and why each was a defect rather than a preference
 *
 * The owner's verdict was "not looking interesting enough… the morph does not read too
 * well and the target is still too much like a sphere". Four things, three of them
 * measurable.
 *
 * **"TOO MUCH LIKE A SPHERE" WAS A SILHOUETTE FAULT, NOT A SHADING ONE.** The eye reads
 * shape from the OUTLINE, and high-frequency displacement changes surface TEXTURE while
 * leaving the outline circular — so a sphere with noise on it stays a sphere however well
 * it is lit. The goo is now a FOUR-CHARGE METABALL: three lobes far enough apart that the
 * surface between them pinches, plus a core charge that keeps the form star-shaped about
 * the origin so no ray from the centre misses and no radius collapses to zero. Measured
 * over 12 orbit angles x 5 moments, on the same 208x160 directions the kernel uses:
 *
 *   | silhouette                       | shipped | T673  | perfect sphere |
 *   | -------------------------------- | ------- | ----- | -------------- |
 *   | radius CV vs angle (mean)        | 0.086   | 0.234 | 0.000          |
 *   | radius CV vs angle (WORST angle) | 0.049   | 0.191 | 0.000          |
 *   | convexity deficit (mean)         | 0.0054  | 0.049 | 0.000          |
 *   | max/min radius (mean)            | 1.375   | 2.171 | 1.000          |
 *
 * The row that matters is the second: T673's WORST orbit angle is more non-circular than
 * the shipped file's BEST one, so this is a shape that is lobed from everywhere rather
 * than from the angle somebody happened to render.
 *
 * **THE MORPH DID NOT READ BECAUSE ITS ENDPOINTS WERE TOO ALIKE.** A morph is legible in
 * proportion to the distance between its two ends, and the shipped goo kept the emblem's
 * two tones as marbling over a smooth ball — so the verb was "the disc inflates". Both
 * ends were pushed apart: the emblem is flatter (a 0.36 bevel where it was 0.72, so the
 * face is a plateau to within 6% of the rim rather than a dome) and made of hard-edged
 * parts; the goo is lobed, self-occluding, and its marbling is halved so the mass can be
 * one wet black thing. The memory of the emblem is carried by the SLABS instead, which
 * travel — and travel is something an eye can follow.
 *
 * And the transition is STAGED. `meltDrive` squeezes the LFO's travel into its middle
 * (smoothstep 0.18..0.82 where it was 0.06..0.94), so the piece parks at each
 * configuration for about a third of the cycle and spends the rest moving: there is a
 * medallion, then an EVENT, then a goo, rather than a continuous ooze the eye reads as a
 * dissolve.
 *
 * **THE EMBLEM IS NOW MADE OF PARTS** — the owner's own idea, and the strongest one in
 * the note. `segs1` is a second point system whose 720 slabs are laid out by golden angle
 * (a polar lattice crowds at the centre; a square one leaves a stepped rim), each wearing
 * its own piece of `taiji` and each melting on the same `meltOrder` wave the mass melts
 * on, so a slab lifts exactly as the surface under it goes soft. Two things fall out of
 * it that a single smooth body could not give: motion becomes readable PER ELEMENT, and
 * the gutters between slabs are real geometry for the shadow pass and the occlusion pass
 * to bite on.
 *
 * **THE LIGHTING WAS FLAT BECAUSE THE AMBIENT WAS DOING THE WORK.** 0.62 of ambient
 * against 0.26 of key is a rig with its contrast turned off — and ambient is the one term
 * that cannot describe a shape, as well as being the term AO multiplies. Ambient is now
 * 0.20, the key is 0.55 and casts over a wider volume, the room's albedo is down to 46%
 * of what it was, and the sky is dimmed to 42% while the softboxes keep their brightness
 * and grow. Measured against a render of the same frame with the object removed, on the
 * DISPLAY-ENCODED output (§V618, and the space read off the plan per §V470):
 *
 *   | goo frame (484)                        | shipped | T673 |
 *   | -------------------------------------- | ------- | ---- |
 *   | object median luma                     | 60.7    | 72.5 |
 *   | backdrop median luma                   | 62.3    | 34.3 |
 *   | separation                             | 1.6     | 38.2 |
 *   | p99 (the highlight)                    | 127.4   | 196.7|
 *   | object pixels within 12 luma of backdrop| 36.2%  | 15.3%|
 *
 * A separation of 1.6 luma is §V618's "dark blob" in the shipped file's own pixels: the
 * goo was carried by its cast shadow and nothing else.
 *
 * Both columns measured at 154ddf1, minutes apart on one tree (§V641) — an absolute with
 * no commit behind it cannot be told apart from a table stale since authoring, which is
 * T689. The silhouette table above is exempt: it is computed from the kernel's own
 * arithmetic in TypeScript and never rendered, so no shader change can move it.
 *
 * ## The rim is not a light, and that is a fact about this renderer
 *
 * "Rim light" is the standard answer to "make it look wet", and it is unavailable here:
 * the diffuse term is TWO-SIDED by rule (`lambert = abs(dot(N, L))`, T301) and so is the
 * highlight, so a directional light behind the subject lights the faces pointing at the
 * camera exactly as hard as the ones pointing away. One at 1.60 blew the emblem's light
 * half to white and produced no edge at all.
 *
 * What rims in this engine is the environment's Schlick term (T632): `envFresnel` rises
 * to 1 at grazing, and at grazing the reflection vector points away from the camera — so
 * the silhouette samples the equirect at its horizon, (0.5, 0.5), where nothing had ever
 * been put. `rimband1` is that texel — and it is a RIM ON THE GOO and a FILL ON THE
 * EMBLEM, which is the Fresnel term working rather than a compromise: on the goo frame
 * the silhouette ring moves 45.8 luma against the body's 25.9, and on the emblem frame
 * 14.5 against 19.5. A flat disc facing the camera has almost no grazing surface for a
 * Fresnel rim to land on, which is the same fact as "the emblem end is flat".
 *
 * ## Graph
 *
 *   ramp ─┐
 *  circle ─┤ add ── environment
 *  circle ─┤  │                    ┌── level ── limit ── blur ──┐
 *  circle ─┘  │                    │                            │
 *             ▼                    │                            add ── output
 *  pointTube ── pointKernel ── geometry (surface) ─┐             │
 *   (grid,wrapU)   (morph1)        (body1)         │             │
 *                                                  ├── render ───┘
 *  pointGrid ── pointKernel ── geometry (instances)│   ▲  ▲
 *   (segpts1)     (segs1)         (shards1)        │   │  └── camera
 *                                                  │   └── 3 lights
 *  pointGrid ── pointKernel ── geometry (surface) ─┘
 *   (sweeppts1)   (sweep1)         (cyc1)
 *
 * ## What it took from §V471, and where
 *
 *  - **§V471.1/.2 — the kernel writes what selection reads.** Corona's cloud is split
 *    three ways by a group predicate over an attribute its kernel wrote. Here the split
 *    is between two READINGS of the same idea — a continuous mass and a set of discrete
 *    parts — and the thing both of them read is the same free attribute: `meltOrder`, the
 *    distance to the emblem's dividing curve, which the shape already knows. It decides
 *    the colour, the order the surface melts in AND the order the slabs leave, which is
 *    why they agree without either one being told about the other.
 *  - **§V471.3 / §V477 — gain and bias per band.** One source (`tide1`) drives three
 *    properties, each through its OWN multiply→add pair rather than one shared knob:
 *    AO intensity 0.55→1.45, environment intensity 1.00→1.85, roughness 0.190→0.085.
 *    Every one rests where the eye expects calm and travels toward the interesting end.
 *  - **§V471.6/.8 — a ramp that goes somewhere, on a long cycle.** Six stops
 *    (midnight, indigo, violet, magenta, amber, gold) worn by the melt FRONT only — now
 *    by the slabs' fronts as well as the surface's, so the travelling parts are the
 *    coloured ones. Its phase turns on a 0.011 Hz LFO: 91 seconds a lap, and unlike the
 *    file §V471.8 was measured from this amplitude IS in its target's units.
 *
 * ## Clock
 *
 * The kernels read `ctx.absTime` only — the goo's field, its turn, its drift and the
 * object's YAW all ride the absolute clock, so nothing snaps at a timeline lap (§V437).
 * The morph rides an LFO, free-running for the same reason. The yaw is the one motion
 * that does not come through the value graph, and it is there because a value-graph-only
 * piece is a still frame wherever no resolver runs — the cook oracle caught exactly that.
 *
 * ## What is still not here
 *
 * A per-instance SCALE or ORIENTATION. The instanced path carries one `instance.x` for
 * the whole draw and per-point position and tint, nothing else — so every slab is the
 * same size and the same way up. That reads as a deliberate tiling here, and it is worth
 * knowing rather than discovering: a mosaic that wanted to tumble as it flew would need a
 * node-level change, not a parameter.
 *
 * Soft shadow edges. The cast shadow is hard, because the catalogue's lights are point
 * and directional and an area source is a different feature (§V328 — state it, never
 * promise the hardware).
 */
export const obolDocument = document(
  "e33-obol",
  "E33 Obol",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 33 }),
  graph(
    [
      /* ---- the studio, as an equirect environment ---------------------------- */
      node(
        "sky",
        "ramp", [-2400, -1200],
        {
          type: "vertical",
          interp: "smooth",
          phase: 0,
          period: 1,
          stops: [
            /* DIMMED to 42% of what shipped (T673), and the reason is what the sky is
               FOR here. It is not a backdrop — nothing draws it — it is the environment
               map, and its widest reader is the irradiance tap: five samples over a broad
               cone along N, which is a DIFFUSE fill. A bright sky therefore lifts a
               near-black oil to putty grey no matter how dark its albedo, and no amount
               of tuning the albedo gets it back, because the fill scales with the sky and
               not with the surface. Dim the room and leave the softboxes where they are:
               the reflections keep their brightness, the fill goes away, and what is left
               is the ratio the eye reads as GLOSS rather than the level it reads as
               exposure. Measured on the goo frame: the body's median falls to 38 luma
               above its backdrop where it used to sit 1.6 luma above it. */
            { position: 0, color: [0.277, 0.302, 0.361, 1] },
            { position: 0.4, color: [0.071, 0.080, 0.109, 1] },
            { position: 0.62, color: [0.025, 0.027, 0.036, 1] },
            { position: 1, color: [0.013, 0.013, 0.016, 1] },
          ],
        },
        { label: "sky1", definitionVersion: 2 },
      ),
      node(
        "keyBox",
        "circle", [-2400, -740],
        {
          mode: "fill",
          center: [0.46, 0.265],
          /* GROWN (T673). On a slick surface the visually load-bearing part of a softbox
             is its REFLECTION, and a 0.150 x 0.052 ellipse reflects as a glint. A box
             this size reads as a broad shape TRAVELLING across the form as it turns,
             which is the half of "wet" a tighter specular cannot supply. */
          radius: [0.280, 0.130],
          softness: 0.22,
          fillcolor: [1, 1, 1, 1],
          bgcolor: [0, 0, 0, 1],
          aspectcorrect: false,
        },
        { label: "keybox1" },
      ),
      node(
        "fillBox",
        "circle", [-2400, -280],
        {
          mode: "fill",
          center: [0.715, 0.375],
          radius: [0.110, 0.220],
          softness: 0.26,
          fillcolor: [0.62, 0.74, 1, 1],
          bgcolor: [0, 0, 0, 1],
          aspectcorrect: false,
        },
        { label: "fillbox1" },
      ),
      /*
       * THE RIM, and the whole point is that it is NOT A LIGHT.
       *
       * This renderer's diffuse term is TWO-SIDED by rule — `lambert = abs(dot(N, L))`,
       * T301, and the highlight is `abs(dot(N, H))` beside it — so a directional light
       * placed behind the subject lights the faces pointing AT the camera exactly as hard
       * as the ones pointing away. A back light here is a second key wearing a rim's
       * name; one at intensity 1.60 blew the emblem's light half to white and produced no
       * edge at all.
       *
       * What DOES rim in this engine is the environment's Schlick term (T632).
       * `envFresnel` rises to 1 at grazing incidence, and at grazing the reflection
       * vector points AWAY from the camera — so the silhouette reflects the equirect at
       * (0.5, 0.5), its horizon dead centre, and until now there was nothing there but
       * the dim end of the sky ramp. This band is that texel.
       *
       * WHAT IT ACTUALLY DOES, measured rather than claimed — it is a rim on the GOO and
       * a fill on the EMBLEM, and the difference is the Fresnel term doing its job. Mean
       * |delta| luma with the band wired vs unwired, split by a 6px erosion of the object
       * mask: on the goo frame the silhouette ring moves 45.8 against the body's 25.9
       * (1.8x, a rim); on the emblem frame the ring moves 14.5 against the body's 19.5
       * (fill, not a rim). A flat disc facing the camera has almost no grazing surface,
       * so there is nothing there for a Fresnel rim to land on — which is the same fact
       * as "the emblem end is flat" wearing a different hat. The room moves under 3 luma
       * either way.
       */
      node(
        "rimBand",
        "circle", [-2400, 180],
        {
          mode: "fill",
          center: [0.5, 0.5],
          radius: [0.500, 0.160],
          softness: 0.55,
          fillcolor: [0.74, 0.84, 1, 1],
          bgcolor: [0, 0, 0, 1],
          aspectcorrect: false,
        },
        { label: "rimband1" },
      ),
      node("studio", "add", [-2080, -740], {}, { label: "studio1" }),

      /* ---- the emblem / the goo ---------------------------------------------- */
      node(
        "shell",
        "pointTube", [-2080, 200],
        { count: OBOL_POINTS, cols: OBOL_COLS, rows: OBOL_ROWS, radius: 1, sizeZ: 2 },
        { label: "shell1" },
      ),
      node(
        "morph",
        "pointKernel", [-1760, 200],
        {
          capacity: OBOL_POINTS,
          seed: 33,
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
            { name: "tint", type: "vec4f", semantic: "color", default: [1, 1, 1, 1] },
          ]),
          kernel: OBOL_KERNEL,
        },
        {
          label: "morph1",
          parameters: {
            value1: drivenSlot("tide1", 0),
            value2: drivenSlot("sheen1", 0.5),
          },
        },
      ),
      node(
        "oil",
        "materialPhong", [-1760, -260],
        { color: [1, 1, 1, 1], specular: [1, 0.97, 0.93, 1], shininess: 300, roughness: 0.190 },
        { label: "oil1", parameters: { roughness: drivenSlot("glossrest1", 0.190) } },
      ),
      node(
        "body",
        "geometry", [-1440, 200],
        { mode: "surface", material: "oil1", tint: [1, 1, 1, 1] },
        {
          label: "body1",
          parameters: {
            tint: {
              mode: "map",
              bindings: {
                static: { kind: "static", value: [1, 1, 1, 1] },
                map: { kind: "map", attribute: "tint" },
              },
            },
          },
        },
      ),

      /* ---- the tiles: the emblem, and the mosaic that fuses into the goo ------- */
      node(
        "segPts",
        "pointGrid", [-2080, 1280],
        { count: OBOL_SEG_POINTS, cols: OBOL_SEG_COLS, rows: OBOL_SEG_ROWS, sizeX: 2, sizeY: 2 },
        { label: "segpts1" },
      ),
      node(
        "segs",
        "pointKernel", [-1760, 1280],
        {
          capacity: OBOL_SEG_POINTS,
          seed: 33,
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
            { name: "tint", type: "vec4f", semantic: "color", default: [1, 1, 1, 1] },
          ]),
          kernel: OBOL_SEG_KERNEL,
        },
        {
          label: "segs1",
          /* One clock for one object: `tide1` is the morph and `sheen1` is the melt
             front's spectrum. There is no second kernel to keep in step any more — T716
             deleted it — so this is the whole of the object's timing. */
          parameters: {
            value1: drivenSlot("tide1", 0),
            value2: drivenSlot("sheen1", 0.5),
          },
        },
      ),
      node(
        "shards",
        /*
         * INSTANCES mode, and §V617 is why that matters rather than being a draw-call
         * detail: an instanced primitive under a LIT material CASTS, and a points-mode
         * billboard does not. These tiles wear `oil1`, so the depth sweep takes them and
         * the occlusion pass finds the gutters between them. That was worth having in
         * T673 and it is LOAD-BEARING after T716, because self-shadowing is now the only
         * thing giving the object a body — there is no mass under the mosaic to be solid
         * on its behalf. Re-measured at THIS commit with nothing else in the scene, so
         * nothing else could be casting: 22 016 pixels of the emblem frame and 11 710 of
         * the goo frame darken when the key's shadow is switched on, and BOTH go to
         * exactly 0 when the material is mutated to the unlit one. The zero is the point:
         * it is what makes the other two evidence rather than a coincidence.
         *
         * The scale is UNIFORM — this path has one `instance.x` for every point and no
         * per-point size or orientation attribute — which is what makes the mosaic read
         * as a tiling rather than as debris. Position and tint are per point; those are
         * the two the path carries. It is also the constraint that sets the goo's size:
         * one tile size has to serve a face of area 2.478 and a drop whose surface at the
         * field's natural size is 5.059, so the drop is drawn at 0.620 instead.
         */
        "geometry", [-1440, 1280],
        { mode: "instances", shape: "box", scale: 0.019, material: "oil1", tint: [1, 1, 1, 1] },
        {
          label: "shards1",
          parameters: {
            tint: {
              mode: "map",
              bindings: {
                static: { kind: "static", value: [1, 1, 1, 1] },
                map: { kind: "map", attribute: "tint" },
              },
            },
          },
        },
      ),

      /* ---- the cyclorama ------------------------------------------------------ */
      node(
        "sweepPts",
        "pointGrid", [-2080, 660],
        { count: OBOL_SWEEP_POINTS, cols: OBOL_SWEEP_COLS, rows: OBOL_SWEEP_ROWS, sizeX: 2, sizeY: 2 },
        { label: "sweeppts1" },
      ),
      node(
        "sweep",
        "pointKernel", [-1760, 660],
        {
          capacity: OBOL_SWEEP_POINTS,
          seed: 3,
          attributes: JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
          ]),
          kernel: OBOL_SWEEP_KERNEL,
        },
        { label: "sweep1" },
      ),
      node(
        "plaster",
        "materialPhong", [-1760, 1060],
        /* THE ROOM GOES DOWN (T673). A slick black object is separated from its backdrop
           by its HIGHLIGHT, and a highlight needs somewhere to be brighter than: on the
           goo frame the shipped file put the object's median at 60.7 luma against a
           backdrop of 62.3 — the silhouette was carried by the cast shadow and nothing
           else, and 36% of the object's pixels sat within 12 luma of the room. At 46% of
           this albedo the same frame reads 72.5 against 34.3. */
        { color: [0.085, 0.090, 0.108, 1], specular: [0.101, 0.106, 0.133, 1], shininess: 40, roughness: 0.58 },
        { label: "plaster1" },
      ),
      node("cyc", "geometry", [-1440, 660], { mode: "surface", material: "plaster1", tint: [1, 1, 1, 1] }, { label: "cyc1" }),

      /* ---- lights, camera ----------------------------------------------------- */
      node(
        "key",
        "light", [-1120, -1200],
        {
          kind: "directional",
          direction: [0.42, -0.72, -0.55],
          color: [1, 0.95, 0.88, 1],
          /* UP from 0.26 (T673). The shipped rig put 0.62 of flat ambient against 0.26 of
             key, which is a lighting setup with the contrast turned off: the shadow it
             throws is a smudge and the occlusion pass has almost nothing to darken. The
             ambient is now 0.20 and the key is the light in the room. */
          intensity: 0.55,
          shadows: true,
          /* WIDER, because the shadow volume is a box around the origin and the object it
             has to hold got bigger: the goo's lobes reach 1.1 where the medallion reached
             1.02, and the slabs arc out past both at the half-way point. */
          shadowExtent: 3.2,
        },
        { label: "key1" },
      ),
      node(
        "fill",
        "light", [-1120, -780],
        { kind: "directional", direction: [-0.85, -0.10, -0.52], color: [0.58, 0.70, 1, 1], intensity: 0.22 },
        { label: "fill1" },
      ),
      node(
        "crown",
        /*
         * A POINT light, and the choice is the whole studio. Directional lights do not
         * fall off, so three of them paint the cyclorama one flat grey and the piece
         * reads as a model on a card table. A point light attenuates by 1/(1+d^2) — a
         * POOL behind the object falling into the corners, which is the one thing a
         * backdrop has to do. The intensity looks enormous because the attenuation eats
         * it: at the object's ~3.3 units it is 1/(1+11) of what is written here.
         */
        "light", [-1120, -360],
        { kind: "point", position: [0, 2.90, -3.40], color: [0.90, 0.95, 1, 1], intensity: 14 },
        { label: "crown1" },
      ),
      node(
        "eye",
        "camera", [-1120, 100],
        { eye: [0, 0.78, 3.70], lookAt: [0, -0.10, 0], fov: 42, near: 0.1, far: 40, ortho: false },
        {
          label: "eye1",
          parameters: {
            "eye.x": drivenSlot("swing1", 0.50),
            "eye.y": drivenSlot("lift1", 0.78),
          },
        },
      ),
      node(
        "shot",
        "render", [-800, 200],
        {
          scenes: "cyc1 body1 shards1",
          camera: "eye1",
          lights: "key1 fill1 crown1",
          ambientColor: [0.62, 0.68, 0.84, 1],
          /* DOWN from 0.62 (T673). Ambient is a constant added to every surface whatever
             it faces — it is the one term that cannot describe a shape — and at 0.62 it
             was most of the light in the picture. It is also the term AO multiplies, so a
             large flat ambient is not "more occlusion to find", it is a floor the
             occlusion has to climb out of. */
          ambientIntensity: 0.20,
          background: [0.008, 0.009, 0.013, 1],
          /* T643: the STATIC value matches the driven slot's rest (1.00) — 7.00 was the
             Fresnel-era re-exposure left stranded under the slot after T636 brought the
             constant home; the driven value always won, so this row was dead and lying. */
          environmentIntensity: 1.00,
          ambientOcclusion: true,
          /* TIGHTER (T673): the occlusion now has 0.052 slabs with 0.009 gutters to bite
             on, and a 0.50 radius sweeps clean over a contact that size. */
          aoRadius: 0.34,
          aoIntensity: 0.55,
          aoQuality: "high",
        },
        {
          label: "shot1",
          parameters: {
            environmentIntensity: drivenSlot("envrest1", 1.00),
            aoIntensity: drivenSlot("aorest1", 0.55),
          },
        },
      ),

      /* ---- bloom, so the softbox highlights bleed the way a real one does ----- */
      /*
       * §V510, paid for again here: a Level's black point is a SUBTRACTION, and on a
       * float target the whole background lands at (0.0006 - 0.80) / 0.5 = -1.6. `add`
       * is front + back, so the first build of this chain SUBTRACTED a constant -1.6
       * from the picture and the frame came back black with a blown object floating in
       * it. `limit` is the node that was missing — the same pairing E4 records.
       */
      node("cut", "level", [-480, 660], { blacklevel: 0.55, whitelevel: 1.20, gamma1: 1, contrast: 1, brightness: 1 }, { label: "cut1" }),
      node("clip", "limit", [-160, 660], { mode: "clamp", low: 0, high: 6, steps: 4 }, { label: "clip1" }),
      node("halo", "blur", [160, 660], { size: 34, filter: "gaussian", extend: "hold" }, { label: "veil1" }),
      node("glow", "add", [440, 200], {}, { label: "bloom1" }),
      node("out", "output", [720, 200], {}, { label: "out1" }),

      /* ---- the value graph ---------------------------------------------------- */
      node("tide", "lfo", [-2400, 1560], { shape: "sine", frequency: 0.062, amplitude: 0.5, offset: 0.5, phase: 0.75 }, { label: "tide1" }),
      node("sheen", "lfo", [-2400, 1920], { shape: "sine", frequency: 0.011, amplitude: 0.5, offset: 0.5, phase: 0 }, { label: "sheen1" }),
      node("swing", "lfo", [-2400, 2280], { shape: "sine", frequency: 0.035, amplitude: 1.35, offset: 0, phase: 0.06 }, { label: "swing1" }),
      node("lift", "lfo", [-2400, 2640], { shape: "sine", frequency: 0.029, amplitude: 0.30, offset: 0.78, phase: 0.0 }, { label: "lift1" }),
      node("aoswing", "valueMath", [-2080, 1560], { operation: "multiply", operand: 0.90 }, { label: "aoswing1" }),
      node("aorest", "valueMath", [-1760, 1560], { operation: "add", operand: 0.55 }, { label: "aorest1" }),
      /*
       * BACK TO THE AUTHORED VALUES (T636), and the round trip is the story. These were
       * 1.00/0.85; T632's Fresnel removed the head-on reflection from the dielectric
       * goo and, with only a SPECULAR environment half, nothing physical was left to
       * fill it — so T632 re-exposed to 7.00/9.00, a tuning constant doing a missing
       * term's job. T636 added the missing term (diffuse irradiance along N, scaled by
       * (1 − F)(1 − metallic)), and the constant comes home: measured on the same two
       * frames T632 used, 1.00/0.85 puts the melted frame's environment contribution
       * at 17.2 against the 17.3 that was judged (and the old 7× frame was blown to
       * chalk — the fill reads as oil where the re-exposure read as plaster).
       */
      node("envswing", "valueMath", [-2080, 1920], { operation: "multiply", operand: 0.85 }, { label: "envswing1" }),
      node("envrest", "valueMath", [-1760, 1920], { operation: "add", operand: 1.00 }, { label: "envrest1" }),
      node("glossswing", "valueMath", [-2080, 2280], { operation: "multiply", operand: -0.105 }, { label: "glossswing1" }),
      node("glossrest", "valueMath", [-1760, 2280], { operation: "add", operand: 0.190 }, { label: "glossrest1" }),
    ],
    [
      edge("e-sky-studio", ["sky", "out"], ["studio", "in1"]),
      edge("e-key-studio", ["keyBox", "out"], ["studio", "in2"], 0),
      edge("e-fill-studio", ["fillBox", "out"], ["studio", "in2"], 1),
      edge("e-rim-studio", ["rimBand", "out"], ["studio", "in2"], 2),
      edge("e-studio-shot", ["studio", "out"], ["shot", "environment"]),

      edge("e-shell-morph", ["shell", "out"], ["morph", "in"]),
      edge("e-morph-body", ["morph", "out"], ["body", "points"]),

      edge("e-segpts-segs", ["segPts", "out"], ["segs", "in"]),
      edge("e-segs-shards", ["segs", "out"], ["shards", "points"]),

      edge("e-sweeppts-sweep", ["sweepPts", "out"], ["sweep", "in"]),
      edge("e-sweep-cyc", ["sweep", "out"], ["cyc", "points"]),

      edge("e-shot-cut", ["shot", "out"], ["cut", "input"]),
      edge("e-cut-clip", ["cut", "out"], ["clip", "input"]),
      edge("e-clip-halo", ["clip", "out"], ["halo", "input"]),
      edge("e-shot-glow", ["shot", "out"], ["glow", "in1"]),
      edge("e-halo-glow", ["halo", "out"], ["glow", "in2"], 0),
      edge("e-glow-out", ["glow", "out"], ["out", "input"]),

      edge("e-tide-aoswing", ["tide", "out"], ["aoswing", "a"]),
      edge("e-aoswing-aorest", ["aoswing", "out"], ["aorest", "a"]),
      edge("e-tide-envswing", ["tide", "out"], ["envswing", "a"]),
      edge("e-envswing-envrest", ["envswing", "out"], ["envrest", "a"]),
      edge("e-tide-glossswing", ["tide", "out"], ["glossswing", "a"]),
      edge("e-glossswing-glossrest", ["glossswing", "out"], ["glossrest", "a"]),
    ],
  ),
);
