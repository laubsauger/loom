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
  openness: f32,        // @default 0.5  ⚑ HOW FAR OPEN THE CHAIN SITS — the only audio lane that reaches the SHAPE, and it reaches its LOOSENESS rather than its IDENTITY. The owner asked for "sometimes more loose, sometimes less", and that is the same object breathing, not a different object: 'scale', 'bulbPower' and the seed still read nothing. It is centred on 0.5 so the RETAINED value is exactly neutral (§V914) — silence renders the shipped picture and nothing else
  openSpread: f32,      // @default 0.5  how far the box fold's limit travels either side of itself across the full swing of 'openness'. The creases spread apart on energy and draw back in quiet
  openVoid: f32,        // @default 0.22  how far the sphere fold's inner radius travels with 'openness' — the shells opening. Same mechanism the void clock uses, so it is still the chain's own parameter and the estimate stays exact
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

  // ─── THE POSE: THE OBJECT TUMBLES AND SWIMS IN; THE CAMERA STAYS PARKED ───────────────
  // ⚑ THE OWNER ASKED FOR "different CAMERA POSITIONS so we sometimes follow one of the
  // fractal knobs a little closer and see some angles", AND THEN SAID *"it doesn't have to
  // be the camera that moves, it can also be the piece"*. That second sentence is what lets
  // this be free AND provable. Moving the OBJECT gives the same angles, keeps §V965 intact
  // (a claim comparing two frames of a moving camera measures the camera), and — because a
  // rigid rotation and a uniform scale are exactly invertible — it is applied to the EYE AND
  // THE RAY ONCE PER FRAGMENT rather than inside the march.
  // ⚠ DO NOT MOVE THIS INTO THE MARCH. Transforming the ray once costs one mat3 product per
  // pixel; transforming the sample point would cost one per DE evaluation, and a pixel makes
  // about a hundred and fifty of those.
  posePeriod: f32,      // @default 61  SECONDS for the object to turn once on its own axis. Prime, and prime against all the others, so the angle you see and the shape you see never line up twice
  poseTilt: f32,        // @default 0.42  how far the object nods as it turns, in radians — the reason you see its top and its underside rather than an equatorial band forever
  pushPeriod: f32,      // @default 43  SECONDS between the object SWIMMING IN toward the frame. Prime
  poseNear: f32,        // @default 2.05  how much bigger the object gets at the top of that push. ⚑ The travel is CUBED, so it is near zero for most of the period and rises to a peak briefly — the same "occasionally" idiom the void clock uses, because a dolly that never rests is a ride and the owner asked for a framed object
  aimPeriod: f32,       // @default 67  SECONDS for the framing to wander. Prime
  poseAim: f32,         // @default 0.62  how far off the centroid the camera looks when the object is closest. ⚑ THIS IS THE "FOLLOW ONE OF THE KNOBS" HALF: a compact sculpture framed on its centroid is a portrait of the whole thing forever, and the interesting part of a fractal is never the middle. It rides the SAME push, so the frame only leaves the centre while there is something close enough to be worth looking at

  // ─── THE CAMERA: parked, because the OBJECT carries the motion ────────────────────────
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
  veinBreak: f32,       // @default 0.45  share of the conduit lattice that is DARK. A line that cannot fail is tape; a line that gutters is a conduit (T1304c). ⚑ WHICH cells go dark is chosen by an R3 QUASIRANDOM SEQUENCE, not a hash — see 'goldenPick3'
  veinRate: f32,        // @default 3.1  cells per unit along the conduit lattice: how long a run of vein is before the sequence decides again. The volume reads the same lattice COARSER, which is what makes the air agree with the surface (§V973)
  veinColor: vec4f,     // @default [0.1, 1, 0.72, 1]  the living light. OFF THE BLACKBODY CURVE on purpose — a hue nothing can burn to is the fastest way to say this was not lit by anything that burns
  shellGlow: f32,       // @default 0.5  a second, softer emission on the orbit's SHELL trap, so the object has lit membranes as well as lit filaments
  nodeRadius: f32,      // @default 0.34  how close the orbit has to pass the ORIGIN to leave a node. A third KIND of mark — points, where the veins are lines and the membranes are sheets
  nodeGlow: f32,        // @default 22  how hard a node's CORE burns. 0 removes the cores
  nodeSpill: f32,       // @default 3.2  how hard a node lights the stone AROUND it — the difference between a light and a sprite. A wider window on the SAME trap (§V962), so the pool lands exactly where the pod is. It also lets the core sit lower than the impression needs, which is what stops it clipping to white and losing its hue
  nodeFade: f32,        // @default 15  METRES over which a node's SHARP core fades out, leaving only its spill. ⚑ A MIP LEVEL DONE AS A FADE, because a marcher has no derivatives to pick one with: a sixth-power falloff on a fractal is fine relief, and fine relief far away is smaller than a pixel and turns into SALT. Sanctum's fix for its own grain, taken rather than reinvented
  nodeColor: vec4f,     // @default [1, 0.36, 0.86, 1]  ⚑ THE SECOND HUE, AND IT IS CARRIED BY AN OBJECT (§V972). Six passes on the sibling piece put a second colour on a LIGHT and every one read as a wash; what fixed it was giving the hue to a THING the eye can point at. The nodes are that thing

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
  hazeSteps: f32,       // @default 20  samples along the ray, and this stage's whole cost. ⚑ FEWER THAN IT WAS (28), and that is a consequence of §V973 rather than a saving: the medium now reads the SAME SMOOTH FIELD the surface does instead of a hash-gated one, and a smooth field needs fewer samples to integrate cleanly. The sample count came down because the field got better, not to pay for it
  hazeSharp: f32,       // @default 26  how tightly the medium clings to the object's own filaments. Higher is a thinner, more defined glow; lower is an even ball of fog around the whole thing
  hazeFalloff: f32,     // @default 1.5  how fast the medium thins away from the object's centre
  hazeBase: f32,        // @default 0.16  the medium that is there REGARDLESS of what is lit — the plain atmosphere around the sculpture. Everything above it is the object's own light in the air
  hazeWidth: f32,       // @default 3.4  how much wider the air reads the conduit windows than the surface does. ⚑ §V973 EXACTLY: "smoother" means THE SAME FIELD AT A COARSER SCALE, and the sibling piece's dust failed because it took a DIFFERENT field — the light in the air and the light on the stone were not the same light, and nothing could ever look wrong enough to notice

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
/* Where the conduit sequence STARTS. Not a hash seed: the R3 sequence below is deterministic
   by construction and needs no table, so this only chooses its phase (§V45). */
const VEIN_PHASE: f32 = 0.317;
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

  /* ⚑ LOOSENESS, AND IT IS THE ONE AUDIO LANE THAT REACHES THE SHAPE.
     T1310b ruled the object's IDENTITY undriven and that ruling stands — if the music
     decided what the object IS, silence would be a different object, and silence is what
     every thumbnail renders. But there is a third category between "identity" and "not the
     shape at all", and the owner's own words drew the line: *"sometimes more loose,
     sometimes less"* is not a different object, it is THE SAME OBJECT BREATHING. The fold
     limit and the sphere fold's inner radius are already moving continuously on their own
     clocks; this widens the region of that same parameter space the piece visits, driven by
     how much is going on in the music.
     ⚑ AND §V914 IS SATISFIED BY THE CENTRING, NOT BY REFUSING TO DRIVE: 'openness' is read
     as an offset from 0.5, and 0.5 is exactly what it retains. So the no-audio picture is
     bit-for-bit the picture this piece would render with the lane removed, and the drive
     only ever takes it either side of that. The retained value IS the driven mean by
     construction rather than by a measurement somebody has to redo after a retune. */
  let open = clamp(params.openness, 0.0, 1.0) - 0.5;

  s.minRadius = max(
    0.05,
    params.minRadius + params.voidTravel * voidPhase * voidPhase * voidPhase + params.openVoid * open,
  );
  s.foldLimit = max(
    0.4,
    params.foldLimit
      + params.foldTravel * sin((t / max(params.scalePeriod, 1.0)) * TAU * 0.63 + 2.1)
      + params.openSpread * open,
  );

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
  /* How close the orbit passed the ORIGIN, at its closest: the NODES.
     ⚑ A THIRD KIND OF MARK, AND THE KIND MATTERS MORE THAN THE COUNT. The veins are LINES
     and the membranes are SHEETS; a frame made of those two is a frame made of one idea seen
     twice. This one is POINTS — small, bright, discrete — which is the shape of thing the
     measured histogram said the piece has none of (subject p90 116.9 of 255 and trueBright
     0.00% even at four times the exposure: no small bright things anywhere in it).
     ⚑ AND IT RECURS AT EVERY SCALE BY CONSTRUCTION, which is the property §V972 actually
     needs. The sibling piece's second hue worked because a column is large near and small
     far, so the two temperatures INTERLEAVE at every depth; a mark that appears in one place
     would not have worked. An orbit trap is scale-free — the orbit visits the origin at
     coarse structure and at fine structure alike — so the nodes are large on the near lobes
     and small on the far ones, which is the interleaving, for free.
     It is also the cheapest thing in this file: the sphere fold ALREADY computes the radius
     it is trapped on, so this is one 'min' per link and nothing else. */
  node: f32,
  /* 0..1 — how far through the chain the point survived. The large-scale structure, and
     what keeps the colour from being uniform across the whole object. */
  escape: f32,
};

fn chainAt(start: vec3f, shape: Shape, links: i32) -> Trace {
  var p = start;
  var dr = 1.0;
  var trap2 = 1.0e9;
  var shell2 = 1.0e9;
  var node2 = 1.0e9;
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
    /* ⚑ THE NODES ARE TRAPPED *HERE*, AND THE FIRST VERSION TRAPPED THEM AFTER THE AFFINE,
       WHICH MEASURED SOMETHING THAT ESSENTIALLY NEVER HAPPENS. Measured: 21 marks over
       0.02% of the frame at a radius of 0.34, and ZERO below 0.2. The reason is arithmetic
       rather than tuning — the affine step ends with 'p * scale + start + seed', so the
       orbit's post-affine radius sits around the ray's own starting radius, a couple of
       units out, and a trap asking "did it pass within a third of a unit of the ORIGIN"
       is asking about a place the orbit does not go.
       Taken BEFORE the fold instead, 'r2' is the quantity the sphere fold itself tests: it
       is exactly "how close to the origin did the orbit come before being pushed back out",
       which is the structural definition of a core. It is the value the fold ALREADY
       computed, so this stays one instruction — and now it is one instruction that fires.
       ⚠ THE GENERAL SHAPE IS §V968's: the arm reported nothing, and nothing was the honest
       reading of a detector pointed at the wrong place. The tell was that the radius sweep
       fell to ZERO marks rather than to FEWER — a mark that vanishes between 0.2 and 0.12
       is not a mark that is too rare, it is a mark that was never there. */
    node2 = min(node2, r2);
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
  /* Squared, for the same reason 'shell' is: the zero set is identical and a square root here
     would be one per link of every evaluation. 'nodeRadius' is squared where it is read. */
  out.node = node2;
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
  /* The NODES: small, discrete, and the only thing in the frame allowed to reach the top of
     the range. They carry the SECOND HUE rather than the living green (§V972). */
  node: f32,
  /* ⚑ WHAT A NODE CASTS ON THE STONE AROUND IT, and it is the difference between a light and
     a sprite. The owner asked for the highlights to *"ACTUALLY EMIT LIGHT"*, and a term added
     to the surface colour does not: it makes the pixels it covers bright and leaves every
     neighbouring pixel exactly as it was. This is the same construction the veins already
     use — a WIDER window on the SAME trap, which is what a glow is (§V962) — and it is what
     makes a pod read as sitting in a pool of its own light rather than pasted on.
     It also earns its keep twice: the visible brightness around a pod now comes from the
     spill, so the CORE does not have to carry the whole impression and can sit lower, which
     is what keeps it from clipping to white and losing the hue at the one place the eye is
     looking hardest. */
  nodeSpill: f32,
};

/**
 * WHERE THE CONDUITS LIVE — R3, THE GOLDEN ANGLE IN THREE DIMENSIONS (T1309f, generalised).
 *
 * ⚑ THE OWNER'S *"they appear too rarely"* IS A DISTRIBUTION COMPLAINT, NOT A COUNT ONE, and
 * the sibling piece is fixing the identical defect from the other side (*"all over the place
 * and overlap in an ugly way"*). Both are the same statistics: the first version of this
 * chose which cells carry a live conduit with an INDEPENDENT UNIFORM HASH per cell, and
 * independent uniform samples have no repulsion — the gaps between chosen cells are
 * exponentially distributed, so some neighbours land adjacent (the clumping the sibling's
 * owner saw) and some regions carry NOTHING AT ALL (the "too rarely" this one saw). One
 * defect, two complaints, and raising the density would only have made the clumps worse.
 *
 * Sanctum's repair was 'fract(index * 0.6180339887)' — the golden ratio's conjugate, the most
 * equidistributed sequence there is in one dimension. A conduit lattice in a fractal is not
 * one-dimensional, so what is used here is its three-dimensional form: the PLASTIC NUMBER's
 * reciprocal powers, 'fract(dot(cell, (1/p, 1/p^2, 1/p^3)))' with p the real root of
 * x^3 = x + 1. That is the R3 sequence, and it is the 3-D statement of the same property —
 * successive cells land in the largest remaining gap, for any density, with no table.
 *
 * It is also CHEAPER than what it replaces: one dot product and a fract against an integer
 * hash, and it is exactly as deterministic (§V45 — no seed, no table, same value on every
 * device forever).
 *
 * ⚑ AND THE VALUE IS USED TWICE, WHICH IS THE HALF WITHOUT WHICH THIS READS AS A GRID.
 * A distribution fixes WHERE, not HOW MUCH; evenly spaced marks of identical width and
 * brightness are mechanical, which is a different ugliness rather than a repair. So the pick
 * doubles as a RANK — a cell well inside the threshold is a principal conduit, wide and
 * bright; one that only just made the cut is a minor one, narrow and dim. The hierarchy is
 * free: it falls out of the number the membership test already computed.
 */
fn goldenPick3(cell: vec3f, offset: f32) -> f32 {
  return fract(dot(cell, vec3f(0.7548776662, 0.5698402910, 0.4301597090)) + offset);
}

/**
 * ⚑ ONE FUNCTION, TWO SCALES — AND THAT IS §V973 RATHER THAN TIDINESS.
 *
 * The surface calls this with the full chain and the conduit lattice's own rate; the VOLUME
 * calls it with a short chain, a wider window and a coarser lattice. Both read THE SAME
 * FIELD. §V973 was filed because the sibling piece's volume sampled a field that knew nothing
 * about where its veins were, so the light in the air and the light on the surface were not
 * the same light — and the tell was that the two patterns had no way to DISAGREE visibly,
 * which is why it survived three passes and a written defence. Making the width and the rate
 * ARGUMENTS is what makes "smoother" structurally unable to become "different".
 */
fn emissionAt(trace: Trace, p: vec3f, widthScale: f32, rate: f32, detail: f32) -> Emission {
  /* Which cells carry a live conduit, and how principal each one is. */
  let cell = floor(p * max(rate, 0.05));
  let pick = goldenPick3(cell, VEIN_PHASE);
  let density = clamp(1.0 - params.veinBreak, 0.05, 1.0);
  let alive = 1.0 - smoothstep(density - 0.14, density + 0.02, pick);
  /* 0 = this region's principal conduit, 1 = the least of the ones that made the cut. */
  let rank = clamp(pick / density, 0.0, 1.0);

  let base = max(params.veinWidth, 0.0008) * max(widthScale, 0.05);
  /* SIZING COVARIES WITH THE DISTRIBUTION. An even spread of identical marks is a grid. */
  let core = base * mix(1.55, 0.55, rank);
  let bright = mix(1.45, 0.45, rank);

  var out: Emission;
  out.core = (1.0 - smoothstep(0.0, core, trace.trap)) * alive * bright;
  /* The spill's window is the BASE width, NOT the rank-scaled one — otherwise a principal
     conduit would wash wider as well as burning brighter, and the wash is the thing the
     measured histogram indicted (subject p50 66.4, p90 116.9, a narrow band parked low: the
     emission was painting the object instead of lighting it, which is §V972's TINT). */
  out.spill = (1.0 - smoothstep(0.0, base * max(params.veinSpread, 1.2), trace.trap))
    * mix(0.2, 1.0, alive);
  /* The membranes: a second, softer source on the SHELL trap, so the object has lit sheets
     as well as lit filaments and the bioluminescence is not one motif repeated. */
  let membrane = (1.0 - smoothstep(0.0, base * 9.0, trace.shell)) * params.shellGlow;
  out.spill = out.spill + membrane;
  out.core = out.core + membrane * 0.35;

  /* THE NODES, AND THE POWER IS WHY THEY ARE POINTS RATHER THAN A THIRD WASH.
     A plain smoothstep over the node radius lights every region the orbit ever passed near
     the origin, which is most of the object — one more even tint, and the defect the
     measurement named in the first place.
     ⚑ THE EXPONENT WAS MEASURED, AND CUBING WAS NOT ENOUGH. At the glow the top end
     actually needs (12, swept: p99 182 -> 217, trueBright 0.01% -> 0.15%, p50 moving only
     56 -> 58), a cubed falloff's TAILS come up with the core and the object went broadly
     magenta — the second hue back to being a wash, by a different route than the one §V972
     names but with the same result. The sixth power holds the core and drops the tail, so
     the gain buys the highlight without buying the halo.
     The lesson is worth more than the number: A BRIGHTNESS AND A FALLOFF ARE ONE DECISION.
     Raising a source's gain without steepening its falloff spreads it; what looks like
     "the mark is too strong" is usually "the mark's tail is now visible". */
  let reach = max(params.nodeRadius, 0.01) * max(widthScale, 0.05);
  let near = 1.0 - smoothstep(0.0, reach * reach, trace.node);
  let near2 = near * near;
  /* ⚑ AND THE SHARP CORE FADES WITH VIEW DISTANCE WHILE THE SPILL DOES NOT — which is a MIP
     LEVEL, done as a fade because a marcher has no derivatives to pick one with. This is
     Sanctum's fix for the same defect, taken rather than reinvented: fine relief is correct
     at arm's length and NONSENSE far away, where one period of it is smaller than a pixel,
     so each pixel takes an essentially random value and the far surface fills with SALT. A
     sixth-power falloff on a fractal is exactly that kind of fine relief.
     ⚠ NOTE WHAT IS FADED AND WHAT IS NOT. The node does not disappear with distance — only
     its HIGH-FREQUENCY half does, and the smooth spill underneath carries on. That is what a
     mip level is, and it is why this does not cost the interleaving the second hue depends
     on: a far node still lights its patch of stone, it simply stops trying to resolve a core
     narrower than the pixel looking at it. */
  out.node = near2 * near2 * near2 * mix(0.45, 1.0, alive) * detail;
  out.nodeSpill = near * mix(0.3, 1.0, alive);
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
  let glow = emissionAt(trace, q, 1.0, params.veinRate, 1.0);
  let tint = rotateHue(params.veinColor.rgb, hue);
  let fade = 1.0 - smoothstep(0.0, reach, travelled);
  /* The nodes reflect too, and on a wet shell that is most of what a reflection is FOR: a
     small bright thing seen twice is what says the surface is polished. */
  let burn = tint * (glow.core * params.veinEmission + glow.spill * params.veinSpill)
    + params.nodeColor.rgb * (glow.node * params.nodeGlow + glow.nodeSpill * params.nodeSpill);
  return (burn + skyAt(dir) * 0.5) * fade;
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
fn volumeAlong(
  eye: vec3f, dir: vec3f, far: f32, pixel: vec2f, shape: Shape, hue: f32, nodeTint: vec3f,
) -> vec3f {
  let count = i32(clamp(params.hazeSteps, 2.0, 64.0));
  let span = min(far, MAX_DISTANCE);
  let stride = span / f32(count);
  let jitter = unitFloat(hash2i(vec2i(pixel), HAZE_SEED));
  let tint = rotateHue(params.veinColor.rgb, hue);
  let falloff = max(params.hazeFalloff, 0.2);
  let rate = max(params.veinRate, 0.05) * 0.34;
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

    /* ⚑ AND THIS IS THE HALF THAT MAKES THE HIGHLIGHTS *EMIT* (§V973).
       The medium used to be a constant tint shaped by 'near' alone: it knew WHERE the object
       was and nothing whatever about which parts of it were LIT. So a vein could flare on a
       kick and the air around it did not move — the owner's *"they also need to ACTUALLY EMIT
       LIGHT"*, and it was literally true, because the light in the air and the light on the
       surface were two unrelated quantities.
       What runs now is the SAME 'emissionAt' the surface calls, on the SAME conduit lattice
       read coarser and wider — so a guttered run is dark in the air exactly where it is dark
       on the shell, a membrane glows the air around it, a node throws its own hue into the
       space beside it, and every one of those scales with the gains the DRUM drives. The
       'hazeBase' term is the plain atmosphere that is there regardless; everything above it
       is the object's own light, in the air, because it is the object's own light.
       ⚠ "SMOOTHER" MEANS THE SAME FIELD AT A COARSER SCALE. It does not mean a different
       field, and the reason §V973 exists is that those two read identically in a docblock and
       nothing can ever look wrong enough to tell them apart. */
    let em = emissionAt(coarse, q, params.hazeWidth, rate, 1.0);
    let burn = em.core * params.veinEmission + em.spill * params.veinSpill;
    let pods = em.node * params.nodeGlow + em.nodeSpill * params.nodeSpill;
    sum = sum + (tint * (params.hazeBase + burn) + nodeTint * pods) * near * radial;
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
     the shape's own evolution rather than the camera's (§V965). The ANGLES the owner asked
     for are delivered by the object's own pose, below, for exactly that reason. */
  let lap = (t / max(params.orbitPeriod, 1.0)) * TAU * params.orbitSpeed;
  let rise = sin((t / max(params.orbitPeriod, 1.0)) * TAU * 0.37 * params.orbitSpeed) * params.orbitRise;
  let worldEye = vec3f(
    sin(lap) * params.orbitRadius,
    params.orbitHeight + rise,
    cos(lap) * params.orbitRadius,
  );
  let forward = normalize(vec3f(0.0) - worldEye);
  /* cross(forward, worldUp) then cross(right, forward) — the standard frame. The other
     order mirrors the image, and a near-symmetric object hides that almost perfectly, which
     is how E68 rendered five stages upside down before anything noticed. */
  let right = normalize(cross(forward, vec3f(0.0, 1.0, 0.0)));
  let up = normalize(cross(right, forward));
  let worldDir = normalize((right * ndc.x) + (up * ndc.y) + (forward * params.lens));

  /* ─────────────────────────────────────────────────────────────────────────────────────
     THE POSE — AND IT IS THE OBJECT THAT MOVES, NOT THE EYE.

     The owner asked to *"sometimes follow one of the fractal knobs a little closer and see
     some angles"*, and then settled the mechanism themselves: *"it doesn't have to be the
     camera that moves, it can also be the piece."* That is the better half of the choice.
     A parked camera is the stable reference the morph is legible against, and it is what
     keeps every claim in this file provable — §V965 exists because a two-frame comparison
     across a moving camera measures THE CAMERA, and it silently credited a walk to a drum
     for five stages on the sibling piece.

     ⚑ WHY THIS COSTS NOTHING. A rigid rotation and a uniform scale are exactly invertible,
     so "the object turned and grew" and "the ray was turned and shortened" are the same
     picture. Marching the transformed ray through the untouched field is therefore free:
     ONE mat3 product and one divide PER FRAGMENT. The march itself never learns the object
     moved.
     ⚠ DO NOT MOVE THIS INSIDE THE MARCH. Transforming the sample point instead would pay
     the same product on every distance evaluation, and a pixel makes about a hundred and
     fifty of them.

     The scale is exact rather than approximate, which is the part that keeps the estimator
     honest: with the eye divided by 'closeness' and the ray direction left unit, the march
     parameter is simply the world distance divided by 'closeness', so every distance the
     chain returns is still a true distance in the space being marched. Nothing needs a
     fudge factor and 'stepScale' keeps meaning what it meant.

     The environment is the one thing left in object space, and the error is bounded and
     tiny by construction: 'skyAt' reads only 'dir.y', and a rotation about Y — which is all
     of the tumble but the nod — does not change '.y' at all. What is left is the nod's own
     'poseTilt' radians, on a gradient whose two ends are 0.02 and 0.055. */
  let poseLap = (t / max(params.posePeriod, 1.0)) * TAU;
  let nod = sin((t / max(params.posePeriod, 1.0)) * TAU * 0.41) * params.poseTilt;
  /* World -> object. 'transpose' of a rotation is its inverse, exactly. */
  let toObject = transpose(rotY(poseLap) * rotX(nod));

  /* THE PUSH: the object swims toward the frame and back. CUBED, so it is near zero for most
     of its period and rises to a peak briefly — "occasionally", the owner's word for the
     negative space, and the same reason applies to a dolly. A push that never rests is a
     ride, and a VJ patch wants a framed object. */
  let pushPhase = 0.5 - 0.5 * cos((t / max(params.pushPeriod, 1.0)) * TAU);
  let push = pushPhase * pushPhase * pushPhase;
  let closeness = mix(1.0, max(params.poseNear, 0.2), push);

  /* THE AIM: where the camera looks WHEN it is close. The interesting part of a fractal is
     never the middle, and a compact sculpture framed on its centroid is the same portrait
     forever. It rides the push, so the frame only leaves the centre while there is something
     near enough to be worth framing. */
  let aimLap = (t / max(params.aimPeriod, 1.0)) * TAU;
  let aim = params.poseAim * push * vec3f(sin(aimLap), cos(aimLap * 0.71 + 1.3), sin(aimLap * 0.53));

  let eye = (toObject * worldEye) / closeness - aim;
  let dir = toObject * worldDir;

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
    /* Sanctum's mip-as-a-fade, on the distance this ray actually travelled. */
    let detail = 1.0 - smoothstep(params.nodeFade * 0.35, max(params.nodeFade, 0.1), travelled);
    /* ⚑ AND EVERY MARK IS WIDENED TO AT LEAST THE PIXEL LOOKING AT IT, which is this file's
       OWN epsilon lesson applied one level up. The march already stops when the estimate is
       smaller than the pixel covers, for the reason written at that loop: asking every ray
       for the same ABSOLUTE precision is what fills a fractal with salt, because neighbouring
       rays run out of precision in different places. A conduit 0.1 wide seen through a pixel
       that covers 0.045 of the surface is the same problem wearing the emission's clothes —
       the mark is barely wider than the sample, so it lands or misses per pixel and the
       surface fills with single-pixel dots.
       'epsilon' IS the pixel's footprint at this hit, already computed by the march, so the
       widening is free and it is exactly proportionate: near marks are untouched (the
       footprint is small against the width) and far marks smear to the width the pixel can
       actually resolve. That is a mip level, and it costs one divide per shaded pixel.
       ⚠ IT WIDENS RATHER THAN REMOVES, which is the difference from the fade above. The far
       conduits must still be there — they are the structure — they simply stop trying to
       resolve detail finer than the image can carry. */
    let lod = 1.0 + epsilon / max(params.veinWidth, 1.0e-4);
    let glow = emissionAt(trace, p, lod, params.veinRate, detail);
    let occ = occlusionAt(p, n, shape, links);
    let specPower = mix(4.0, 220.0, 1.0 - clamp(params.roughness, 0.0, 1.0));

    let keyTint = rotateHue(params.keyColor.rgb, keyHue);
    /* ⚑ THE FILL NO LONGER TRAVELS, AND IT NO LONGER CARRIES A HUE — §V972, ARRIVED AT BY
       ISOLATION RATHER THAN BY TASTE.
       It used to be the frame's "second temperature": a magenta rotating in OPPOSITION to
       the key, which is a good idea and was the wrong place to put it. Measured, one arm at
       a time, at the same frame: cutting the SPILL leaves the object magenta; cutting the
       FILL leaves it teal stone with discrete magenta nodes on it. The magenta wash was this
       light, and it was covering the very marks it was supposed to be contrasting with.
       That is §V972 in its exact words — a hue sprayed over geometry that already has a
       colour is a TINT; a hue carried by an object the eye can point at is a second light —
       and it is now the SIXTH recorded instance of a second colour failing because it was
       put on a light. The opposition survives, but it is between two OBJECTS: teal veins and
       magenta nodes, both of which the eye can point at, both of which recur at every scale.
       ⚠ AND ROTATING IT WAS THE SECOND HALF OF THE BUG. This file already knows that
       rotating a warm hue about the luminance axis walks it into magenta — it is written at
       'rimColor''s declaration, which is exempted for exactly that reason. The fill was not
       exempted, so RETUNING ITS COLOUR COULD NOT FIX IT: an amber fill was measured and came
       back magenta anyway, because the rotation took it there. A neutral tint has no hue for
       the rotation to walk, so the light models form and contributes no colour at all. */
    let fillTint = params.fillColor.rgb;
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
    /* ⚑ AND THE PODS LIGHT THE STONE, WHICH IS THE OWNER'S *"they also need to ACTUALLY
       EMIT LIGHT"* taken literally rather than as a brightness request. Both terms are
       lights on the shell here, not marks on it: a vein pools in the creases around it and a
       pod throws its hue onto the stone it sits in. Without this the pods were sprites —
       bright where they covered a pixel and changing nothing anywhere else. */
    let bleed = (veinTint * glow.spill * params.veinSpill
      + params.nodeColor.rgb * glow.nodeSpill * params.nodeSpill)
      * mix(1.0, occ, params.translucency);

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
    /* ⚑ THE NODES ARE THE ONLY THING IN THE FRAME ALLOWED TO REACH THE TOP OF THE RANGE, AND
       THEY CARRY THE SECOND HUE (§V972).
       Measured before this landed: subject p01 14.7 / p50 66.4 / p90 116.9 with trueBright
       0.00% — and still 0.00% at FOUR TIMES the exposure, which is what proves the missing
       top end was a CONTENT defect rather than a grade one. What was absent was small bright
       things, so what is added is small bright things.
       And the hue is on the NODE rather than on a light, because six passes of the sibling
       piece put a second colour on a light and every one read as a wash. The condition that
       makes an object work is that it RECURS AT A SCALE THE EYE CAN COMPARE — the win is the
       interleaving, not the object-ness — and an orbit trap is scale-free, so a node is large
       on a near lobe and small on a far one within the same frame.
       It is NOT multiplied by 'baseColor' or by the occlusion: a node is a source, and a
       source is not shaded by the shell it sits in. */
    let nodes = params.nodeColor.rgb * glow.node * params.nodeGlow;
    let surface = shell + burn + nodes + rim + reflected;

    /* Aerial perspective, which is also what lets the march stop early without a visible
       wall of nothing behind it. */
    let depth = 1.0 - exp(-travelled * params.fog);
    colour = mix(surface, params.backdrop.rgb, depth);
  }

  /* The volume is ADDED over whatever the ray found: light in the air is IN FRONT of the
     thing behind it, not mixed with it. */
  if (params.haze > 0.0005) {
    let far = select(MAX_DISTANCE, travelled, hit);
    colour = colour + volumeAlong(
      eye, dir, far, uv * frameU.resolution, shape, veinHue, params.nodeColor.rgb,
    );
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
