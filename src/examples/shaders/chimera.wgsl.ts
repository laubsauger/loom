import { SHARED_UNIFORMS_WGSL } from "../../runtime/backend/shared-uniforms.ts";

/**
 * E70 — CHIMERA: one distance-estimated fold chain that travels through three characters
 * (T1310b).
 *
 * The owner's brief was *"high fidelity 3d fractal like stuff that is evolving, changing
 * segmentation and shape, meant as a music visualizer… hits of bioluminescence, organics
 * with reflections, multiple colored lights in scene, high fidelity lighting… an 8k unreal
 * engine art installation… a really cool VJ patch"*, and then, after the shape document
 * offered three separate directions:
 *
 *   *"maybe we can combine things and have reef, skeleton and bulb kind a unified into one
 *   interesting thing… the most critical part is to have something interesting and not just
 *   very flat and boring after 15 seconds, something that keeps interesting and changing"*
 *
 * ⚑ THE SECOND SENTENCE IS THE ACCEPTANCE CRITERION AND IT IS WHAT THIS FILE IS BUILT
 * AGAINST. "Flat and boring after 15 seconds" is a failure a still cannot show — E68's
 * stills looked good while the piece read as a tech demo, and E57's beat lanes read fine
 * frame by frame and blinked in motion. So the question asked of every decision below is
 * *what is different at t=15 s, t=45 s and t=90 s, and would a viewer notice* — and the
 * answer is not one morph but SIX, on mutually prime periods, so nothing lines up (see
 * "THE CLOCKS" below).
 *
 * ## The chain is a COMPOSITION, not a blend — which is why it can be all three at once
 *
 * The shape document ruled out cross-fading two distance estimators, and that ruling
 * stands: a blend of two DEs is not a DE, it under-estimates, and the march walks through
 * the surface. What replaces it is one chain whose steps COMPOSE, so the derivative is
 * exact at every link by the chain rule:
 *
 *   1. ROTATE          an isometry           dr unchanged        — the segmentation knob
 *   2. BOX FOLD        a reflection          dr unchanged        — the SKELETAL character
 *   3. SPHERE FOLD     a scaling             dr *= f             — the REEF character
 *   4. POWER MAP       z -> z^n in spherical dr *= n*r^(n-1)     — the BULB character
 *   5. AFFINE          p*scale + c           dr = dr*|scale| + 1
 *
 * ⚑ AND THE LOAD-BEARING PROPERTY IS THAT EVERY ONE OF THOSE HAS A NEUTRAL SETTING THAT IS
 * EXACT RATHER THAN APPROXIMATE. A box fold whose limit is wider than the point is the
 * IDENTITY (`clamp(p) * 2 - p == p`), so `foldLimit` turns the skeleton off by arithmetic.
 * A power map at `power = 1` is the identity and its derivative factor is `1 * r^0 = 1`,
 * exactly neutral — so `bulbPower` travels from 1 (no bulb at all) to 5 (strongly lobed)
 * through a continuum of real shapes, with no blend and no popping anywhere in between.
 * That is the whole answer to "combine reef, skeleton and bulb into one thing": they are
 * not three objects cross-faded, they are three regions of ONE family's parameter space,
 * and the piece walks between them.
 *
 * ## Why the rotation is the segmentation knob, and why the iteration count is not
 *
 * The owner's word for what should move is "segmentation" — the fold structure itself
 * rearranging rather than the object merely spinning. There are two candidates and only
 * one of them is safe:
 *
 *   - THE ROTATION BETWEEN ITERATIONS is a rigid transform, so its Jacobian is 1 and the
 *     distance estimate stays exactly an estimate at every angle. The fold planes sweep
 *     through the structure continuously and the surface reorganises without ever popping.
 *     It can run forever. This is the one.
 *   - THE ITERATION COUNT is an INTEGER. A step in it is a step in the field, and a step in
 *     the field is a visible pop, however small the step. It is held FIXED at
 *     `iterations` and nothing animates it — which is worth saying because it is the
 *     obvious knob and it is the wrong one.
 *
 * ## A BOUNDED OBJECT, AND THE FIRST VERSION OF THIS WAS WRONG TWICE IN ONE LINE-PAIR
 *
 * The camera is parked, so the subject has to be an OBJECT rather than a place — a Mandelbox
 * is a place and a place wants a flight through it; what this piece needs is a thing to frame
 * and turn. The obvious way to get one is a JULIA iteration: add a fixed constant instead of
 * the ray's own starting point, and the set becomes compact.
 *
 * ⚑ IT WAS TRIED, AND IT FAILED TWICE OVER AT THE SAME TWO LINES — recorded here because the
 * first render looked like a shading problem and was nothing of the kind:
 *
 *   1. THE ESTIMATE WAS INTERNALLY INCONSISTENT. `dr = dr * |scale| + 1` is the MANDELBOX
 *      derivative: the `+ 1` assumes the added term differentiates to 1 with respect to the
 *      ray's starting point. A CONSTANT differentiates to 0. So `dr` ran systematically
 *      large and `de = length(p)/|dr|` systematically small — conservative rather than
 *      dangerous, since it cannot step through a surface, but it makes the march creep.
 *   2. AND THE SET WAS NOT THERE. A Mandelbox-Julia at this scale and these radii is a thin
 *      DUST. Measured on the first render: 86.1 % of the frame near-black, mean luma 7.53,
 *      a scatter of specks and no object anywhere in it.
 *
 * What ships is the true Mandelbox form — the ray's own starting point PLUS A DRIFTING
 * OFFSET. The `+ 1` is then exact, and the set is the bounded, richly structured object the
 * piece needs. **The offset keeps the whole reason the constant was wanted**: it is a point
 * in 3-space, and drifting it reorganises the object's topology continuously — lobes merge,
 * shells open, arms separate — which is exactly "keeps changing", for three floats and with
 * the derivative still correct.
 *
 * The general form is worth more than the fix: A DISTANCE ESTIMATOR IS A PAIR — the map and
 * its derivative — AND CHANGING ONE WITHOUT THE OTHER PRODUCES A PICTURE, NOT AN ERROR.
 *
 * ## THE CLOCKS, and they are mutually prime ON PURPOSE
 *
 * Six things move, at 19 / 37 / 47 / 53 / 73 / 113 seconds. Those are primes, so the
 * combined state's repeat period is their product — over five thousand years — and no
 * viewer will ever see the same frame twice or feel a cycle land. At any two times a viewer
 * compares, a DIFFERENT SUBSET has moved:
 *
 *   morphPeriod      19 s   the fold rotation: the segmentation, always turning
 *   hueTurn          37 s   the colour lap, two hues travelling in OPPOSITION
 *   scalePeriod      47 s   the chain's magnification: the density of incident
 *   lightCycle       53 s   WHICH light is the key — the frame is lit from elsewhere
 *   characterPeriod  73 s   bulbPower 1 -> 5 -> 1: reef/skeleton -> bulb -> back
 *   seedPeriod     113 s   the seed offset's drift: the object's topology
 *
 * `chimera-claims.gpu.test.ts` asserts this as a measurement rather than an intention: with
 * the audio cut AND THE ORBIT FROZEN (§V965 — a claim that compares two frames of a moving
 * camera is measuring the camera), frames at 0 / 15 / 45 / 90 s differ from each other, and
 * freezing the morph clock is what makes that claim fail.
 *
 * ## What is deliberately NOT driven by audio
 *
 * §V914 makes the no-track picture the shipped picture: every thumbnail and every headless
 * render has no audio. So the six clocks above run on `frameU.absTime` and NOTHING about
 * the object's identity is audio-driven — the piece is already fully alive in silence, and
 * the music only scales what is already moving (E55's finding, T1138). Audio rides
 * amplitude, never identity and never a clock.
 *
 * Nothing drives the camera either, for §V965's reason: the orbit is the one stable
 * reference the morph is legible against, and it is what makes every claim in the file
 * provable by holding the frame and cutting one lane.
 *
 * ## Deterministic
 *
 * §V44/§V45: `frameU.absTime` is the only clock, and every "random" figure is an integer
 * hash through `// @use hash` (T1286), so the same seed is the same object on every device
 * and every replay.
 */
export const CHIMERA_WGSL = `// @use hash
${SHARED_UNIFORMS_WGSL}
struct Params {
  // ─── THE CHAIN ────────────────────────────────────────────────────────────────────────
  iterations: f32,      // @default 11  links in the fold chain — HELD FIXED, never animated: it is an integer and a step in it is a pop
  scale: f32,           // @default -2.1  the affine magnification. NEGATIVE turns the structure inside out each link, which is what gives the chain its wound, shell-inside-shell reading
  scaleTravel: f32,     // @default 0.22  how far 'scale' drifts either side of itself over scalePeriod — the density of incident, breathing
  foldLimit: f32,       // @default 1.05  the box fold's extent: the SKELETAL character. Wider than the point is the IDENTITY, so raising this turns the skeleton off by arithmetic rather than by a branch
  foldTravel: f32,      // @default 0.18  how far the fold limit breathes — creases opening and closing
  minRadius: f32,       // @default 0.47  inside this the sphere fold inverts hardest: the REEF character, and the knob that makes the surface read as grown rather than machined
  fixedRadius: f32,     // @default 1  the sphere fold's outer radius
  bulbPower: f32,       // @default 1  the power map's exponent: the BULB character. EXACTLY 1 is the identity — no bulb, and no cost, because the whole term is skipped
  bulbPeak: f32,        // @default 4.2  how far bulbPower travels at the top of its cycle. Lobe count rises with it and the travel is continuous, so the lobes GROW rather than appear
  seedOffset: vec4f,     // @default [0, 0, 0, 0]  added to the fold seed alongside the ray's own starting point: the object's identity. Drifting it merges lobes and opens shells — the strongest evolution axis in the file
  seedDrift: f32,      // @default 0.26  how far the constant wanders over seedPeriod
  foldSpin: vec4f,      // @default [0.31, 0.47, 0.23, 0]  the rotation between iterations, in turns per lap, per axis — THE SEGMENTATION KNOB. An isometry, so the estimate stays exact at every angle and this can run forever
  detail: f32,          // @default 1  scales the march's termination threshold against the PIXEL'S OWN FOOTPRINT. Below 1 resolves finer structure and costs steps; above 1 stops sooner and is the cheapest quality knob in the file
  stepScale: f32,       // @default 0.78  how much of the estimate the march actually steps. Below 1 because a chain this long accumulates derivative error; it is the file's safety margin against marching THROUGH the surface at grazing angles
  bailout: f32,         // @default 256  escape radius — where a point is declared outside and the orbit stops

  // ─── THE CLOCKS (T1310b's acceptance criterion: what is different at 15 s, 45 s, 90 s) ──
  morphPhase: f32,      // @default 0.37  where in the fold rotation's lap the clock STARTS. ⚑ NOT cosmetic: at phase 0 the rotation is the IDENTITY and the object is its own axis-aligned degenerate case — a flat slab. Every thumbnail and every headless render begins at t=0, so phase 0 ships the single worst frame in the piece as the picture of it
  morphPeriod: f32,     // @default 19  SECONDS for the fold rotation to make one lap — the fastest of the six, and the one the eye reads as "it is moving"
  hueTurn: f32,         // @default 37  SECONDS for the colour to travel one lap of its arc
  scalePeriod: f32,     // @default 47  SECONDS for the magnification to breathe
  lightCycle: f32,      // @default 53  SECONDS for the key light to hand off to the next one
  characterPeriod: f32, // @default 73  SECONDS for the shape to travel reef/skeleton -> bulb -> back
  seedPeriod: f32,     // @default 113  SECONDS for the seed offset's drift
  voidPeriod: f32,      // @default 89  SECONDS between the shells OPENING. The owner asked for negative space inside the sculpture "occasionally", and occasionally is a CLOCK rather than a setting
  voidTravel: f32,      // @default 0.26  how far the sphere fold's inner radius travels when they open. ⚑ THIS IS A CHAIN PARAMETER, NOT A CARVE: the voids are opened by the fold that already makes the shells, so the estimate stays exact. A hole cut with a min/max AGAINST the chain would cost a step-scale and make every cost figure in this file dishonest
  tempoScale: f32,      // @default 1  multiplies the MORPH clock only (T1309b). Driven from the track's own bpm over 112, so it RESTS AT EXACTLY 1 on the shipped pattern and the piece runs faster under faster music instead of being tuned to one tempo

  // ─── THE CAMERA: parked and slowly orbiting, because the SHAPE carries the motion ──────
  orbitPeriod: f32,     // @default 96  SECONDS for one lap around the object. A STARTING POINT chosen to be brought to the owner from stills, not a fabricated bound (T1268)
  orbitSpeed: f32,      // @default 1  multiplier on the orbit. 0 parks the camera dead still, which is what a claim about the SHAPE's evolution must do (§V965)
  orbitRadius: f32,     // @default 12  how far the eye sits from the object's centre
  orbitHeight: f32,     // @default 1.15  the eye above the object's equator at rest
  orbitRise: f32,       // @default 1.35  how far the eye rises and falls, on a period deliberately incommensurable with the lap so the camera never repeats a position
  lens: f32,            // @default 1.85  focal length — long, so the object compresses and reads as SCULPTURE rather than as a wide-angle ride

  // ─── BIOLUMINESCENCE: the orbit trap IS the emission field ────────────────────────────
  veinWidth: f32,       // @default 0.1  how close the orbit has to pass the axis to light: the width of a vein
  veinEmission: f32,    // @default 5.5  how hard the veins burn — the DRIVEN MEAN of its lane, not its floor (§V914). 0 removes the whole bioluminescent stage
  veinSpill: f32,       // @default 2.4  how hard a vein lights the surface AROUND it. §V962: this reads a WIDER window on the SAME trap — a coarser field with the same structure, which is what a glow IS, rather than a blur of the source
  veinSpread: f32,      // @default 5.5  how many vein-widths the spill reaches
  veinBreak: f32,       // @default 0.45  share of a vein's length that is DARK. A line that cannot fail is tape; a line that gutters is a conduit (T1304c)
  veinColor: vec4f,     // @default [0.1, 1, 0.72, 1]  the living light. OFF THE BLACKBODY CURVE on purpose — a hue nothing can burn to is the fastest way to say this was not lit by anything that burns
  shellGlow: f32,       // @default 0.5  a second, softer emission on the orbit's SHELL trap, so the object has lit membranes as well as lit filaments

  // ─── THE LIGHT RIG: three coloured sources with REACH, and a HIERARCHY ─────────────────
  keyColor: vec4f,      // @default [0.45, 0.72, 1, 1]  the cold key
  fillColor: vec4f,     // @default [1, 0.3, 0.52, 1]  the opposition — a magenta the key has no path to, so the frame carries two temperatures rather than one family
  rimColor: vec4f,      // @default [1, 0.62, 0.26, 1]  the warm back light that separates the silhouette. It does NOT morph: rotating an orange about the luminance axis walks it into magenta (T1304c)
  keyIntensity: f32,    // @default 5.2  the key's drive at its own distance
  fillIntensity: f32,   // @default 4.6  the opposition's drive
  rimIntensity: f32,    // @default 3.8  the back light's drive
  lightReach: f32,      // @default 5.6  METRES over which a light falls to a quarter. ⚑ THE SINGLE MOST IMPORTANT NUMBER IN THE LIGHTING: a light with no reach lights the far side of the object exactly as hard as the near side, and that is most of what makes a render read cheap (T1304c)
  lightDistance: f32,   // @default 6.2  how far the three sources sit from the object's centre
  lightSwing: f32,      // @default 0.65  how much of the hierarchy actually hands over: 0 pins the key permanently, 1 takes each light to nothing at the bottom of its turn
  ambient: f32,         // @default 0.055  the floor under everything, so a surface facing away is a shape rather than a hole

  // ─── MATERIAL: wet, chitinous ─────────────────────────────────────────────────────────
  baseColor: vec4f,     // @default [0.075, 0.088, 0.105, 1]  the shell under the lights — DARK, because a bioluminescent thing is read by what it emits, not by what it reflects
  roughness: f32,       // @default 0.26  0 is a wet lacquer, 1 is chalk
  specular: f32,        // @default 1.35  how hard the highlights drive — this is the 'wet' in wet organic
  fresnelGain: f32,     // @default 1.1  the grazing-angle rim. On an all-curved silhouette this is where the environment actually shows (§V640 measured 10.2x on curvature), which is why it is worth more here than it would be on flat slabs
  translucency: f32,    // @default 0.75  how much the veins bleed THROUGH the shell into the creases around them — the difference between a light on a surface and a light inside one
  occlusion: f32,       // @default 1.15  how hard the folds shade themselves. The cheapest signal in the frame and the one that makes a distance-estimated surface read as RENDERED
  aoReach: f32,         // @default 1  how far the occlusion samples travel

  // ─── STAGE: THE REFLECTION BOUNCE — a SECOND MARCH, the expensive idea in the file ────
  polish: f32,          // @default 0.62  how mirrored the shell is. ⚑ 0 SKIPS THE SECOND MARCH ENTIRELY rather than multiplying its result by nothing — a branch the whole wavefront takes together, and the difference between "this idea is off" and "this idea is free"
  reflectSteps: f32,    // @default 30  march iterations for the REFLECTED ray. A fraction of the primary's, because the eye checks a reflection's silhouette and forgives everything else
  reflectFade: f32,     // @default 5.5  metres over which the reflection fades with distance

  // ─── STAGE: THE VOLUME — light visible IN THE AIR rather than only where it lands ─────
  haze: f32,            // @default 0.22  how much luminous medium hangs around the object. 0 skips the loop
  hazeSteps: f32,       // @default 28  samples along the ray, and this stage's whole cost
  hazeSharp: f32,       // @default 26  how tightly the medium clings to the object's own filaments. Higher is a thinner, more defined glow; lower is an even ball of fog around the whole thing
  hazeFalloff: f32,     // @default 1.5  how fast the medium thins away from the object's centre

  // ─── THE GRADE ────────────────────────────────────────────────────────────────────────
  backdrop: vec4f,      // @default [0, 0, 0, 1]  ⚑ WHAT THE CAMERA SEES WHERE IT SEES NOTHING. Separate from the environment below, and that separation is the point: a graded backdrop behind a compact sculpture COMPETES with the subject, and black is also what makes the bioluminescence read, because contrast is a ratio
  skyTop: vec4f,        // @default [0.021, 0.03, 0.052, 1]  the ENVIRONMENT above — what a REFLECTION and the grazing rim see. It still lights the object; it is simply no longer painted behind it
  skyBottom: vec4f,     // @default [0.055, 0.028, 0.042, 1]  and below, warmer, so even the empty frame has two temperatures
  fog: f32,             // @default 0.028  aerial perspective: depth as colour, and the thing that lets the march stop early without a visible wall of nothing
  exposure: f32,        // @default 1.55  master gain before the display transform
  pivot: f32,           // @default 0.2  the tone the contrast rotates about, in linear light
  contrast: f32,        // @default 1.13  above 1 crushes about the pivot, below 1 opens the shadows
  lift: f32,            // @default 0  raises the floor of the curve. ZERO against a black backdrop: a lift has nothing to open there and only greys the void
  saturation: f32,      // @default 1.22  its own knob, because a tone curve that moves chroma is a tone curve with a bug
  steps: f32,           // @default 132  primary march iterations — the frame budget, stated as a number
};

@group(0) @binding(0) var inputSampler: sampler;
@group(0) @binding(1) var inputTexture: texture_2d<f32>;
@group(0) @binding(2) var<uniform> frameU: SharedFrame;
@group(0) @binding(3) var<uniform> params: Params;

const TAU: f32 = 6.2831853;
const MAX_DISTANCE: f32 = 26.0;
const SURFACE: f32 = 0.0009;
/* One seed for the vein break-up, so the same conduits fail in the same places (§V45). */
const VEIN_SEED: u32 = 70u;
/* A second for the volumetric dither, so re-jittering the air cannot move the veins. */
const HAZE_SEED: u32 = 7021u;

/* ── The three axis rotations, composed once per fragment ────────────────────────────────
   The matrix is built ONCE and passed down through every call that needs the chain. It is a
   function of the CLOCK alone — the same for every pixel and every march step — and
   building it inside the chain would put six transcendentals on every one of the ~150
   distance evaluations a pixel makes. That is E68's hoisting lesson applied before it could
   become this file's bug rather than after. */
fn rotX(a: f32) -> mat3x3f {
  let c = cos(a);
  let s = sin(a);
  return mat3x3f(vec3f(1.0, 0.0, 0.0), vec3f(0.0, c, s), vec3f(0.0, -s, c));
}

fn rotY(a: f32) -> mat3x3f {
  let c = cos(a);
  let s = sin(a);
  return mat3x3f(vec3f(c, 0.0, -s), vec3f(0.0, 1.0, 0.0), vec3f(s, 0.0, c));
}

fn rotZ(a: f32) -> mat3x3f {
  let c = cos(a);
  let s = sin(a);
  return mat3x3f(vec3f(c, s, 0.0), vec3f(-s, c, 0.0), vec3f(0.0, 0.0, 1.0));
}

/**
 * THE SHAPE AT A MOMENT — every clock read once, in one place.
 *
 * Six independent periods, all prime, so the combined state does not repeat inside any
 * viewing anyone will ever give it. Each field is what the chain is CURRENTLY at; nothing
 * downstream reads a clock.
 */
struct Shape {
  rot: mat3x3f,
  seedOffset: vec3f,
  scale: f32,
  foldLimit: f32,
  bulbPower: f32,
  /* The sphere fold's inner radius AT THIS MOMENT: what opens the voids (see 'voidPeriod'). */
  minRadius: f32,
  /* 0..1 through the character cycle, published so the shading can follow the shape: a bulb
     phase and a skeleton phase should not be graded identically. */
  character: f32,
};

fn shapeAt(t: f32) -> Shape {
  var s: Shape;

  /* THE SEGMENTATION. Each axis turns at its own rate, so the fold planes precess rather
     than spinning as a rigid set — a single-axis rotation reads as the object turning,
     which is the thing the owner explicitly did not ask for. 'tempoScale' is the ONLY audio
     that reaches a clock, and it rests at exactly 1 (T1309b). */
  /* ⚑ THE PHASE OFFSET IS WHY THIS IS NOT A SLAB AT t=0. The rotation at phase zero is the
     IDENTITY, and an axis-aligned Mandelbox seen down an axis is a flat square face — which
     is exactly what the first thumbnail rendered, because a thumbnail is taken at frame 0.
     §V914 says the no-audio picture is the shipped picture; this is the same rule one step
     further on — THE t=0 PICTURE IS THE ADVERTISED PICTURE, and a clock that starts at its
     own degenerate value ships that value to the gallery. */
  let morph = ((t / max(params.morphPeriod, 0.5)) * clamp(params.tempoScale, 0.25, 3.0) + params.morphPhase) * TAU;
  s.rot = rotZ(morph * params.foldSpin.z) * rotY(morph * params.foldSpin.y) * rotX(morph * params.foldSpin.x);

  /* THE CHARACTER: bulbPower travels 1 -> bulbPeak -> 1. A raised cosine, so it DWELLS at
     both ends — the piece spends real time being a reef and real time being a bulb rather
     than sweeping through both and resting in the middle where it is neither. */
  let charPhase = t / max(params.characterPeriod, 1.0);
  s.character = 0.5 - 0.5 * cos(charPhase * TAU);
  s.bulbPower = mix(max(params.bulbPower, 1.0), max(params.bulbPeak, 1.0), s.character * s.character);

  /* THE TOPOLOGY: the seed offset wanders a Lissajous figure rather than a circle, so it
     never retraces its own path. */
  let jp = t / max(params.seedPeriod, 1.0);
  s.seedOffset = params.seedOffset.xyz + params.seedDrift * vec3f(
    sin(jp * TAU),
    sin(jp * TAU * 1.31 + 1.7),
    cos(jp * TAU * 0.77 + 0.4),
  );

  /* THE DENSITY OF INCIDENT. 'scale' is the knob that decides how much structure the eye
     can find, and it is the one that must stay inside a band: a magnification that crosses
     its own degenerate values does not morph, it reorganises. The travel is deliberately
     small for that reason and the band is stated here rather than discovered later. */
  s.scale = params.scale + params.scaleTravel * sin((t / max(params.scalePeriod, 1.0)) * TAU);
  /* THE VOIDS OPEN OCCASIONALLY, and the CUBE is what makes it occasional: a raised cosine
     cubed sits near zero for most of its period and rises to a peak briefly, so the shells
     are shut most of the time and open now and then — which is what the owner asked for and
     is not what a plain sine would have given. */
  let voidPhase = 0.5 - 0.5 * cos((t / max(params.voidPeriod, 1.0)) * TAU);
  s.minRadius = max(0.05, params.minRadius + params.voidTravel * voidPhase * voidPhase * voidPhase);
  s.foldLimit = max(0.4, params.foldLimit + params.foldTravel * sin((t / max(params.scalePeriod, 1.0)) * TAU * 0.63 + 2.1));

  return s;
}

/**
 * THE CHAIN — the distance estimate, the orbit traps, and the escape, in one walk.
 *
 * The traps are accumulated SQUARED and rooted once at the end: three instructions a link
 * instead of a square root a link, on a function that runs ~150 times per pixel. The trap
 * is what the bioluminescence is made of, so it cannot be split out into its own walk
 * without paying for the whole chain twice.
 *
 * ⚑ 'links' IS AN ARGUMENT rather than a read of params because the VOLUME calls this with
 * a short chain. §V962's companion: a volume wants a DIFFERENT field from a surface, not a
 * cheaper approximation of it — and a four-link chain is genuinely a different, smoother
 * field that shares the surface's structure, which is exactly what a luminous medium around
 * an object should be.
 */
struct Trace {
  de: f32,
  /* Distance the orbit passed from the marching axis, at its closest: the FILAMENTS. */
  trap: f32,
  /* Distance the orbit passed from the unit shell, at its closest: the MEMBRANES. */
  shell: f32,
  /* 0..1 — how far through the chain the point survived. The large-scale structure, and
     what keeps the colour from being uniform across the whole object. */
  escape: f32,
};

fn chainAt(start: vec3f, shape: Shape, links: i32) -> Trace {
  var p = start;
  var dr = 1.0;
  var trap2 = 1.0e9;
  var shell2 = 1.0e9;
  var survived = links;

  let minR = max(shape.minRadius, 0.02);
  let minR2 = minR * minR;
  let fixR = max(params.fixedRadius, minR + 0.02);
  let fixR2 = fixR * fixR;
  let limit = vec3f(max(shape.foldLimit, 0.05));
  /* The power map is the file's only transcendental work, so it is SKIPPED ENTIRELY at the
     neutral setting rather than computed and multiplied by nothing. 'bulbPower' is a
     uniform, so the whole wavefront takes this branch together and "no bulb" is genuinely
     free — the same discipline as 'polish' on the reflection. */
  let withBulb = shape.bulbPower > 1.0005;
  let bail = max(params.bailout, 16.0);

  for (var i = 0; i < links; i = i + 1) {
    // 1. ROTATE — an isometry: |J| = 1, so the estimate stays exact at every angle.
    p = shape.rot * p;

    // 2. BOX FOLD — a reflection: |J| = 1. Wider than the point, this is the identity.
    p = clamp(p, -limit, limit) * 2.0 - p;

    // 3. SPHERE FOLD — the inversion that makes the surface read as GROWN.
    let r2 = dot(p, p);
    if (r2 < minR2) {
      let f = fixR2 / minR2;
      p = p * f;
      dr = dr * f;
    } else if (r2 < fixR2) {
      let f = fixR2 / r2;
      p = p * f;
      dr = dr * f;
    }

    // 4. THE POWER MAP — z -> z^n in spherical coordinates. Exactly the identity at n = 1.
    if (withBulb) {
      let r = length(p);
      if (r > 1.0e-5) {
        let n = shape.bulbPower;
        let theta = acos(clamp(p.z / r, -1.0, 1.0)) * n;
        let phi = atan2(p.y, p.x) * n;
        let rn = pow(r, n);
        dr = dr * n * pow(r, n - 1.0);
        let st = sin(theta);
        p = rn * vec3f(st * cos(phi), st * sin(phi), cos(theta));
      }
    }

    /* 5. AFFINE.
       ⚑ THE ADDED TERM IS THE RAY'S OWN STARTING POINT PLUS A DRIFTING OFFSET, and that is
       the correction that made this file render at all. The first version added a CONSTANT
       (a Julia iteration) while keeping the '+ 1.0' below, which is the MANDELBOX
       derivative — it assumes the added term differentiates to 1, and a constant
       differentiates to 0. The estimate was internally inconsistent, and a Mandelbox-Julia
       at this scale is a thin dust besides: the first render was 86% black with a scatter
       of specks and no object anywhere in it.
       With the starting point added, '+ 1.0' is EXACT, and the set is the bounded,
       richly-structured object the piece needs. The OFFSET keeps what the Julia constant
       was chosen for — drifting it reorganises the topology continuously — without costing
       the derivative its correctness. */
    p = p * shape.scale + start + shape.seedOffset;
    dr = dr * abs(shape.scale) + 1.0;

    let rr = dot(p, p);
    trap2 = min(trap2, dot(p.xy, p.xy));
    shell2 = min(shell2, abs(rr - 1.0));
    if (rr > bail) {
      survived = i;
      break;
    }
  }

  var out: Trace;
  /* The linear escape-time estimate. It is the CONSERVATIVE form for a chain with folds in
     it — the logarithmic one is tighter for a pure power map and over-steps once a sphere
     fold is in the sequence, which is precisely the combination this file ships. */
  out.de = length(p) / max(abs(dr), 1.0e-6);
  out.trap = sqrt(trap2);
  /* ⚑ THE MEMBRANE TRAP STAYS IN SQUARED SPACE, deliberately. |r^2 - 1| has exactly the
     same zero set as |r - 1|, so it marks the same surfaces — and it costs a subtract where
     the honest distance costs a SQUARE ROOT ON EVERY LINK OF EVERY EVALUATION, which is
     ~150 of them per pixel. It is not a distance and nothing below treats it as one:
     'shellGlow' is tuned against these units. */
  out.shell = shell2;
  out.escape = f32(survived) / max(f32(links), 1.0);
  return out;
}

fn deAt(p: vec3f, shape: Shape, links: i32) -> f32 {
  return chainAt(p, shape, links).de;
}

/* Central differences, at the epsilon THE MARCH ACTUALLY STOPPED AT rather than a constant.
   A normal sampled wider than the feature it sits on returns the average of several
   features, which reads as a melted object; sampled narrower than a pixel covers, it
   returns detail the pixel cannot show and that lands as NOISE. Tying it to the same
   distance-scaled epsilon the march uses keeps it at the scale the pixel is actually
   asking about. */
fn normalAt(p: vec3f, shape: Shape, links: i32, epsilon: f32) -> vec3f {
  let e = vec2f(epsilon, 0.0);
  return normalize(vec3f(
    deAt(p + e.xyy, shape, links) - deAt(p - e.xyy, shape, links),
    deAt(p + e.yxy, shape, links) - deAt(p - e.yxy, shape, links),
    deAt(p + e.yyx, shape, links) - deAt(p - e.yyx, shape, links),
  ));
}

/**
 * Self-shading from the estimate itself — five taps along the normal, asking "how much
 * nearer is the surface than this sample's own height above it".
 *
 * ⚑ Per op, the highest-leverage term in the frame. A distance-estimated surface lit
 * without it reads as a plastic maquette however good the light rig is, because the folds
 * are full of creases that should be dark and nothing else in the shading knows they are
 * there. It is also what makes the veins POOL, since the creases they run in are the parts
 * this darkens.
 */
fn occlusionAt(p: vec3f, n: vec3f, shape: Shape, links: i32) -> f32 {
  var occluded = 0.0;
  var weight = 1.0;
  let reach = max(params.aoReach, 0.05);
  for (var i = 0; i < 5; i = i + 1) {
    let h = (0.012 + 0.075 * f32(i)) * reach;
    occluded = occluded + (h - deAt(p + n * h, shape, links)) * weight;
    weight = weight * 0.72;
  }
  return clamp(1.0 - params.occlusion * occluded, 0.0, 1.0);
}

/* THE ENVIRONMENT — what a REFLECTION and the grazing rim see, and no longer what the
   camera sees where it hits nothing.
   ⚑ THE TWO WERE ONE FUNCTION AND THE OWNER CAUGHT IT: *"needs a black background instead
   of having this weird gradient background"*. Painting the environment behind the subject
   makes the backdrop compete with it, and it raises the floor the bioluminescence has to
   read against — contrast is a RATIO, which is E68's "a beat cannot read against a hall
   that is already bright" arriving on a different piece. The object still needs something
   to be lit BY, so the gradient stays exactly where it was doing work — in the fresnel rim
   and in what a reflected ray finds — and the camera gets 'backdrop'. */
fn skyAt(dir: vec3f) -> vec3f {
  let h = dir.y * 0.5 + 0.5;
  return mix(params.skyBottom.rgb, params.skyTop.rgb, smoothstep(0.0, 1.0, h));
}

/* Rotate a colour about the luma axis: it keeps the value the author chose and moves only
   where the hue sits on the wheel. */
fn rotateHue(base: vec3f, turn: f32) -> vec3f {
  let k = vec3f(0.57735);
  let c = cos(turn * TAU);
  let s = sin(turn * TAU);
  return (base * c) + (cross(k, base) * s) + (k * dot(k, base) * (1.0 - c));
}

/**
 * THE EMISSION AT A POINT, and it is TWO fields rather than one.
 *
 * ⚑ §V962, applied rather than rediscovered: the SPILL is not a blurred copy of the vein.
 * It is the SAME orbit trap read through a WIDER window — a coarser field with the same
 * structure, which is what a glow actually is. Blurring the vein would fail here for
 * exactly the reason that row measured: the vein is thinner than any blur radius worth
 * having, so a blur of it returns the vein again.
 *
 * The break-up is what stops a conduit reading as tape (T1304c): a vein varies along its
 * run and it GUTTERS — it goes dark and comes back — so the eye reads a network that can
 * fail rather than a painted-on stripe.
 */
struct Emission {
  /* What the surface BURNS: the vein itself, narrow and hot. */
  core: f32,
  /* What the surface is LIT BY: the wider field around it. */
  spill: f32,
};

fn emissionAt(trace: Trace, p: vec3f) -> Emission {
  let width = max(params.veinWidth, 0.0008);
  /* A vein's own run, hashed on a lattice along it, so a conduit is interrupted in the same
     places on every device and every replay (§V45). One hash, not an octave of noise: a
     conduit varies along ONE axis and paying for three nobody can see is paying for
     nothing. */
  let cell = vec3i(floor(p * 3.1));
  let run = unitFloat(hash3i(cell, VEIN_SEED));
  let alive = 1.0 - smoothstep(1.0 - params.veinBreak, 1.0 - params.veinBreak + 0.35, run);

  var out: Emission;
  out.core = (1.0 - smoothstep(0.0, width, trace.trap)) * alive;
  out.spill = (1.0 - smoothstep(0.0, width * max(params.veinSpread, 1.2), trace.trap)) * mix(0.35, 1.0, alive);
  /* The membranes: a second, softer source on the SHELL trap, so the object has lit sheets
     as well as lit filaments and the bioluminescence is not one motif repeated. */
  let membrane = (1.0 - smoothstep(0.0, width * 9.0, trace.shell)) * params.shellGlow;
  out.spill = out.spill + membrane;
  out.core = out.core + membrane * 0.35;
  return out;
}

/* Where a light sits at this moment. Each rides its own slow circle at its own rate, so the
   rig itself is never in the same configuration twice. */
fn lightPosition(slot: f32, t: f32) -> vec3f {
  let a = (t / max(params.lightCycle, 1.0)) * TAU * (0.31 + slot * 0.17) + slot * 2.2;
  let d = max(params.lightDistance, 0.5);
  return vec3f(cos(a) * d, sin(a * 0.63 + slot) * d * 0.55, sin(a) * d);
}

/**
 * THE HIERARCHY, and the reason it exists is a complaint on the sibling row: *"lights are
 * still ugly, all over the place"* (T1309b) — which was not about brightness but about
 * INCOHERENCE. Three equal lights are three lights; one dominant light and two supports is
 * a LIT SCENE.
 *
 * So each source's weight swings on the same period, offset by a third of a lap: at any
 * moment one of the three is the key and the other two are support, and WHICH ONE rotates.
 * That is a second-order change on a 53 s period — the frame is lit from somewhere else at
 * t=15 and t=45 without anything in the shape having to move.
 */
fn lightWeight(slot: f32, t: f32) -> f32 {
  let phase = (t / max(params.lightCycle, 1.0)) - slot / 3.0;
  let bump = 0.5 + 0.5 * cos(phase * TAU);
  return mix(1.0 - clamp(params.lightSwing, 0.0, 1.0), 1.0, bump);
}

/**
 * One light's contribution, WITH REACH.
 *
 * ⚑ The falloff is the point (T1304c). A light with no reach lights the far side of the
 * object exactly as hard as the near side, which is frontal flat-lighting, and it is most
 * of what makes a render read cheap. With it, the object has DEPTH AS COLOUR — the near
 * folds carry one source, the far ones another.
 */
fn lightAt(
  p: vec3f, n: vec3f, view: vec3f, slot: f32, t: f32,
  tint: vec3f, drive: f32, specPower: f32,
) -> vec3f {
  let toLight = lightPosition(slot, t) - p;
  let dist = length(toLight);
  let l = toLight / max(dist, 1.0e-4);
  let reach = max(params.lightReach, 0.1);
  let falloff = 1.0 / (1.0 + (dist * dist) / (reach * reach));
  let lambert = max(dot(n, l), 0.0);
  let half = normalize(l + view);
  let spec = pow(max(dot(n, half), 0.0), specPower) * params.specular;
  return tint * drive * lightWeight(slot, t) * falloff * (lambert + spec * lambert);
}

/**
 * THE REFLECTION — a SECOND MARCH, and the only genuinely expensive idea in the file.
 *
 * It gets a deliberately smaller budget than the primary ray: a third of the steps and a
 * short reach. That is not a corner cut — it is what a reflection can afford to be, because
 * the eye checks a reflection's silhouette against the thing above it and forgives
 * everything else.
 *
 * 'polish' at 0 removes the march ENTIRELY rather than multiplying its result by zero: a
 * branch the whole wavefront takes together, and the difference between "this idea is off"
 * and "this idea is free". That is also what makes the stage's cost measurable by
 * alternating a parameter rather than by editing the shader.
 */
fn reflectionAt(p: vec3f, n: vec3f, viewDir: vec3f, shape: Shape, links: i32, hue: f32) -> vec3f {
  let dir = reflect(viewDir, n);
  let count = i32(clamp(params.reflectSteps, 4.0, 96.0));
  let reach = max(params.reflectFade, 0.4);
  var travelled = 0.02;
  var found = false;
  for (var i = 0; i < count; i = i + 1) {
    let q = p + dir * travelled;
    let d = deAt(q, shape, links);
    if (d < max(SURFACE * 3.0, travelled * 0.004)) {
      found = true;
      break;
    }
    travelled = travelled + d * params.stepScale;
    if (travelled > reach) { break; }
  }
  /* A MISS IS NOT BLACK. Most reflected rays leave the object entirely — it is convex at
     the scale a reflection travels — so "nothing hit" is the COMMON case and returning zero
     is what makes a reflection invisible rather than subtle. */
  if (!found) { return skyAt(dir); }

  /* The reflected hit is shaded by its EMISSION alone. A second light rig on a ray the
     camera cannot see past buys nothing anybody can name, and what a wet shell shows is the
     bright things — which here means the living light. */
  let q = p + dir * travelled;
  let trace = chainAt(q, shape, links);
  let glow = emissionAt(trace, q);
  let tint = rotateHue(params.veinColor.rgb, hue);
  let fade = 1.0 - smoothstep(0.0, reach, travelled);
  return (tint * (glow.core * params.veinEmission + glow.spill * params.veinSpill) + skyAt(dir) * 0.5) * fade;
}

/**
 * THE VOLUME — the light that is visible IN THE AIR rather than only where it lands.
 *
 * ⚑ §V962's companion, and the reason this reads as a medium rather than as salt and
 * pepper: the air samples a SHORT chain, not the surface's. The surface's field is gated by
 * a hash and is very nearly binary, and twenty sparse samples through a binary field is a
 * speckle generator. A four-link chain is a genuinely different field — smooth everywhere,
 * and still shaped like the object it surrounds, which is what puts the glow WHERE THE
 * OBJECT IS rather than in a uniform ball around it.
 *
 * The start offset is dithered by a hash of the PIXEL, fixed across frames: grain, never
 * flicker (E55's finding, applied to a third march).
 */
fn volumeAlong(eye: vec3f, dir: vec3f, far: f32, pixel: vec2f, shape: Shape, hue: f32) -> vec3f {
  let count = i32(clamp(params.hazeSteps, 2.0, 64.0));
  let span = min(far, MAX_DISTANCE);
  let stride = span / f32(count);
  let jitter = unitFloat(hash2i(vec2i(pixel), HAZE_SEED));
  let tint = rotateHue(params.veinColor.rgb, hue);
  let falloff = max(params.hazeFalloff, 0.2);
  var sum = vec3f(0.0);
  for (var i = 0; i < count; i = i + 1) {
    let travel = (f32(i) + jitter) * stride;
    let q = eye + dir * travel;
    /* Thins with distance from the object's centre, so the medium belongs to the sculpture
       rather than filling the room. */
    let radial = exp(-length(q) / falloff);
    let coarse = chainAt(q, shape, 4);
    /* ⚑ A RECIPROCAL, NOT A SMOOTHSTEP, and this is §V962's finding arriving on schedule.
       The first version thresholded the coarse trap, and a threshold on a field that is
       nearly binary to begin with is a SPECKLE GENERATOR rather than a fog — the render
       showed exactly that: grainy green streaks rather than a medium. A smoothstep has an
       edge, and an edge is the thing a volume must not have.
       This falls off smoothly everywhere and has no edge anywhere, so twenty-odd sparse
       samples integrate to a medium instead of to salt and pepper. Same field, same
       structure, no threshold. */
    let near = 1.0 / (1.0 + coarse.trap * coarse.trap * max(params.hazeSharp, 0.5));
    sum = sum + tint * near * radial;
  }
  return sum * (params.haze * stride);
}

@fragment
fn fs(@location(0) uv: vec2f) -> @location(0) vec4f {
  let aspect = max(frameU.resolution.x, 1.0) / max(frameU.resolution.y, 1.0);
  let ndc = vec2f((uv.x - 0.5) * 2.0 * aspect, (0.5 - uv.y) * 2.0);

  /* The absolute clock (T468): it keeps growing across timeline laps, so nothing in the
     piece snaps back when the timeline wraps. Every clock below is derived from it and
     NOTHING here is a wall reading (§V44). */
  let t = frameU.absTime;
  let shape = shapeAt(t);
  let links = i32(clamp(params.iterations, 2.0, 24.0));

  /* Per-FRAME values, evaluated once per fragment rather than per sample. The hue lap and
     the light weights are functions of the clock alone; E68 measured what it costs to let
     one of these drift into a loop body. */
  let hue = (t / max(params.hueTurn, 1.0));
  /* TWO HUES IN OPPOSITION, not a drift inside one family (T1304b/T1271): the living light
     travels one way round the wheel and the cold key travels the OTHER, so the frame's two
     temperatures separate and re-converge over the lap. The warm rim does NOT travel —
     rotating an orange about the luminance axis walks it into magenta, which is the one
     specific way this trick fails. */
  let veinHue = hue * 0.5;
  let keyHue = -hue * 0.5;

  /* THE CAMERA: parked, orbiting slowly, and reading NO audio. The orbit is the stable
     reference the morph is legible against — and freezing it is what lets a claim measure
     the shape's own evolution rather than the camera's (§V965). */
  let lap = (t / max(params.orbitPeriod, 1.0)) * TAU * params.orbitSpeed;
  let rise = sin((t / max(params.orbitPeriod, 1.0)) * TAU * 0.37 * params.orbitSpeed) * params.orbitRise;
  let eye = vec3f(
    sin(lap) * params.orbitRadius,
    params.orbitHeight + rise,
    cos(lap) * params.orbitRadius,
  );
  let forward = normalize(vec3f(0.0) - eye);
  /* cross(forward, worldUp) then cross(right, forward) — the standard frame. The other
     order mirrors the image, and a near-symmetric object hides that almost perfectly, which
     is how E68 rendered five stages upside down before anything noticed. */
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = normalize(cross(right, forward));
  let dir = normalize((right * ndc.x) + (up * ndc.y) + (forward * params.lens));

  /* THE PRIMARY MARCH. The step is scaled below the estimate because a chain this long
     accumulates derivative error and the object is seen at grazing angles everywhere — a
     fractal has no flat faces to be forgiving about. */
  /* ⚑ THE TERMINATION THRESHOLD SCALES WITH THE PIXEL'S OWN FOOTPRINT, and that is the fix
     for the speckle the first lit render was covered in. A fixed epsilon asks every ray for
     the same absolute precision, so a ray crossing a region whose detail is finer than the
     pixel it belongs to terminates at whatever iteration it happened to run out of — and
     neighbouring rays run out at different places, which is EXACTLY what salt-and-pepper
     noise on a fractal surface is. Stopping when the estimate is smaller than the pixel
     covers asks each ray for the precision its pixel can actually show.
     It is also CHEAPER, which is the part worth remembering: the far half of the object
     stops sooner, so the quality fix and the cost fix are the same line. */
  let pixelAngle = 2.0 / (max(frameU.resolution.y, 1.0) * max(params.lens, 0.1));
  var travelled = 0.6;
  var hit = false;
  var epsilon = SURFACE;
  let steps = i32(clamp(params.steps, 8.0, 512.0));
  for (var i = 0; i < steps; i = i + 1) {
    let p = eye + dir * travelled;
    let d = deAt(p, shape, links);
    epsilon = max(SURFACE, travelled * pixelAngle * max(params.detail, 0.05));
    if (d < epsilon) {
      hit = true;
      break;
    }
    travelled = travelled + d * params.stepScale;
    if (travelled > MAX_DISTANCE) { break; }
  }

  var colour = params.backdrop.rgb;
  if (hit) {
    let p = eye + dir * travelled;
    let n = normalAt(p, shape, links, epsilon);
    let view = -dir;
    let trace = chainAt(p, shape, links);
    let glow = emissionAt(trace, p);
    let occ = occlusionAt(p, n, shape, links);
    let specPower = mix(4.0, 220.0, 1.0 - clamp(params.roughness, 0.0, 1.0));

    let keyTint = rotateHue(params.keyColor.rgb, keyHue);
    let fillTint = rotateHue(params.fillColor.rgb, keyHue);
    let veinTint = rotateHue(params.veinColor.rgb, veinHue);

    /* THREE COLOURED SOURCES, each with reach, and a hierarchy that hands over. The rim
       does not morph, for the reason given at its declaration. */
    var lit = lightAt(p, n, view, 0.0, t, keyTint, params.keyIntensity, specPower);
    lit = lit + lightAt(p, n, view, 1.0, t, fillTint, params.fillIntensity, specPower);
    lit = lit + lightAt(p, n, view, 2.0, t, params.rimColor.rgb, params.rimIntensity, specPower);

    /* ⚑ THE VEINS ARE A LIGHT, NOT A DECAL. The spill term lights the shell around a
       conduit, so the emission is a source in the scene rather than a bright texture on it —
       and because the spill reads a wider window on the same trap, it lands exactly where
       the creases the AO darkens are, which is what makes it POOL. */
    let bleed = veinTint * glow.spill * params.veinSpill * mix(1.0, occ, params.translucency);

    /* The grazing rim. On an all-curved silhouette this is where the environment shows —
       §V640 measured 10.2x on curvature against 1.11x on a flat face, and a fractal has no
       flat faces at all, which is what makes this term worth more here than on a slab. */
    let fresnel = pow(1.0 - max(dot(n, view), 0.0), 4.0) * params.fresnelGain;
    let rim = skyAt(reflect(dir, n)) * fresnel;

    var reflected = vec3f(0.0);
    if (params.polish > 0.001) {
      reflected = reflectionAt(p, n, dir, shape, links, veinHue) * params.polish * mix(0.15, 1.0, fresnel);
    }

    let shell = params.baseColor.rgb * (lit * occ + bleed + params.ambient);
    let burn = veinTint * glow.core * params.veinEmission;
    let surface = shell + burn + rim + reflected;

    /* Aerial perspective, which is also what lets the march stop early without a visible
       wall of nothing behind it. */
    let depth = 1.0 - exp(-travelled * params.fog);
    colour = mix(surface, params.backdrop.rgb, depth);
  }

  /* The volume is ADDED over whatever the ray found: light in the air is IN FRONT of the
     thing behind it, not mixed with it. */
  if (params.haze > 0.0005) {
    let far = select(MAX_DISTANCE, travelled, hit);
    colour = colour + volumeAlong(eye, dir, far, uv * frameU.resolution, shape, veinHue);
  }

  /* ⚑ THE GRADE MOVES TONE WITHOUT MOVING CHROMA, and that is not tidiness — E68 measured
     the naive version: a flat lift added to r, g and b shrinks the RATIOS between them, so
     it took saturation from 0.55 to 0.155 while doing exactly what was asked to the tone.
     The curve is computed on LUMINANCE and the colour is scaled by what the curve did, so
     every hue arrives with its ratios intact and saturation stays its own knob. */
  let level = max(dot(colour, vec3f(0.2126, 0.7152, 0.0722)), 1.0e-5);
  let curved = (pow(level / max(params.pivot, 1.0e-3), params.contrast) * params.pivot * params.exposure)
    + params.lift;
  let scaled = colour * (curved / level);
  let grey = dot(scaled, vec3f(0.2126, 0.7152, 0.0722));
  let saturated = mix(vec3f(grey), scaled, params.saturation);
  return vec4f(saturated, 1.0);
}
`;
