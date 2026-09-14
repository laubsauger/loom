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
 * ## ⚑ THE SUBJECT HOLDS STILL. THE CAMERA DOES ALL THE MOVING. (T1318b)
 *
 * The owner watched two passes of this and reversed their own earlier instruction:
 *
 *   *"it's still pumping, like pulsing instead of us doing it by camera, which then prevents
 *   us that we can't have close-ups and flyovers that make sense without being noisy because
 *   the thing itself rotates and pumps. So I think we really need to do this with the camera
 *   instead."*
 *
 * That closes the object-motion route that `T1310b` opened on their earlier *"it doesn't
 * have to be the camera that moves, it can also be the piece"*. **A camera move is a rigid
 * transform of the view, so world-space detail stays coherent across frames and the eye can
 * integrate it. A pump or a fast morph DEFORMS THE VERY STRUCTURE THE SHOT IS MAGNIFYING** —
 * so at close range the detail is not sliding out of frame, it is being destroyed and
 * rebuilt every frame, which is what reads as noise. The owner's two complaints ("can't do
 * close-ups" and "noisy") are one consequence, and no shot-gating fixes it: only removing
 * the deformation does.
 *
 * So: the audio lane that reached the shape is DELETED, the FORM clocks are about three
 * times longer than they were, the LIGHT and COLOUR clocks are untouched, and the camera's
 * own lap came down from 96 s to 41 s to carry the energy the form gave up.
 * **LIGHT MAY FLASH AT BEAT RATE. FORM MAY NOT.**
 *
 * ## THE CLOCKS, and they are mutually prime ON PURPOSE
 *
 * Nine things move, on nine primes, so the combined state's repeat period is their product
 * and no viewer will ever feel a cycle land. At any two times a viewer compares, a DIFFERENT
 * SUBSET has moved. The table is split by what the owner's ruling splits:
 *
 *   FORM — slow, because a shot has to survive being pointed at it
 *     morphPeriod     149 s   the fold rotation: the object's own turning
 *     scalePeriod     181 s   the chain's magnification: the density of incident
 *     characterPeriod 211 s   bulbPower 1 -> 4.2 -> 1: reef/skeleton -> bulb -> back
 *     voidPeriod      239 s   the shells opening
 *     seedPeriod      277 s   the seed offset's drift: the object's topology
 *   LIGHT AND CAMERA — fast, because both are safe at speed
 *     hueTurn          37 s   the colour lap, two hues travelling in OPPOSITION
 *     orbitPeriod      41 s   one lap of the camera around the object
 *     pushPeriod       43 s   the approach, and the SHOT LANE
 *     lightCycle       53 s   WHICH light is the key — and now, which way the shadow falls
 *     posePeriod       61 s   the camera's second axis
 *     aimPeriod        67 s   where the camera looks when it is close
 *
 * `chimera-claims.gpu.test.ts` asserts this as a measurement rather than an intention: with
 * the audio cut AND THE WHOLE CAMERA RIG PARKED (§V965 — a claim that compares two frames of
 * a moving camera is measuring the camera; and note that until T1318b that claim parked only
 * the orbit, while the "pose" it left running was a camera move all along), frames out to
 * 90 s differ from the one before, and freezing the clocks is what makes that claim fail.
 *
 * ## What is deliberately NOT driven by audio
 *
 * §V914 makes the no-track picture the shipped picture: every thumbnail and every headless
 * render has no audio. So the clocks above run on `frameU.absTime` and NOTHING about the
 * object's SHAPE is audio-driven any more — not its identity and not, since T1318b, its
 * looseness either. The piece is fully alive in silence and the music only scales what is
 * already moving (E55's finding, T1138). Audio rides amplitude, never identity, never a
 * clock, and never the form.
 *
 * Nothing drives the camera either, for §V965's reason: the camera is the one stable
 * reference the morph is legible against, and it is what makes every claim in the file
 * provable by holding the frame and cutting one lane.
 *
 * ## Deterministic
 *
 * §V44/§V45: `frameU.absTime` is the only clock, and there is no longer a "random" figure
 * anywhere in the file — not one hash. Every scattered quantity is a LOW-DISCREPANCY
 * SEQUENCE evaluated in closed form: the conduit lattice's membership and rank off R3
 * (`goldenPick3`), the flare's per-mark phase off a second projection of the same lattice,
 * and, since T1322b, the volume march's per-pixel start offset off R2 over the pixel. The
 * `// @use hash` include came out with the last of them (T1286's module is still the right
 * tool; this file simply has nothing left to hash). Same value on every device and every
 * replay, with no seed and no table.
 */
export const CHIMERA_WGSL = `${SHARED_UNIFORMS_WGSL}
struct Params {
  // ─── THE CHAIN ────────────────────────────────────────────────────────────────────────
  iterations: f32,      // @default 11  links in the fold chain — HELD FIXED, never animated: it is an integer and a step in it is a pop
  scale: f32,           // @default -2.1  the affine magnification. NEGATIVE turns the structure inside out each link, which is what gives the chain its wound, shell-inside-shell reading
  scaleTravel: f32,     // @default 0.22  how far 'scale' drifts either side of itself over scalePeriod — the density of incident, breathing
  foldLimit: f32,       // @default 1.45  the box fold's extent: the SKELETAL character, and ⚑ THE KNOB THAT DECIDES WHETHER THE SILHOUETTE IS A CUBE. 'clamp(p, -limit, limit) * 2 - p' reflects the domain about the faces of a cube, so a body shaped mostly by this operator HAS A CUBIC OUTLINE BY CONSTRUCTION and no amount of surface detail can answer it — detail on a cubic body is warts on a cube, which is the owner's phrase, twice. Measured on the subject mask's convolution (perimeter^2 / 4*pi*area): 1.05 -> 2.44, 1.6 -> 6.19, 2.6 -> 19.78, against a bulb-floor sweep over the same statistic that did not move at all (§V980). Wider than the point is the IDENTITY, so raising this turns the skeleton off by arithmetic rather than by a branch
  foldTravel: f32,      // @default 0.18  how far the fold limit breathes — creases opening and closing
  minRadius: f32,       // @default 0.47  inside this the sphere fold inverts hardest: the REEF character, and the knob that makes the surface read as grown rather than machined
  fixedRadius: f32,     // @default 1  the sphere fold's outer radius. ⚑ AND IT IS THE SPACING KNOB — see 'spacingTravel'
  spacingTravel: f32,   // @default 0.24  ⚑ THE "OPENING AND CLOSING DISTANCES BETWEEN NODULES" LANE, AND THE OWNER ASKED FOR IT THREE TIMES BEFORE IT EXISTED: *"the shape is still kinda boring in terms of stuff actually moving away from stuff… opening and closing distances between nodules"*. It travels 'fixedRadius' either side of itself, and the reason THAT is the spacing rather than a carve is arithmetic: the sphere fold multiplies the point by 'fixedRadius²/r²' and multiplies the derivative by the same factor, so raising it INFLATES every structure away from every other one while the estimate stays EXACT. ⚠ IT IS A DIFFERENT AXIS FROM THE TWO IT WOULD BE EASY TO CONFUSE IT WITH, and that is why it earns its own parameter rather than a bigger number on one of theirs: 'scaleTravel' moves the DENSITY OF INCIDENT (how much structure there is), 'voidTravel' moves 'minRadius' and OPENS HOLLOWS INSIDE the shells, and this moves THE GAPS BETWEEN the structures that are already there. Sweepable to 0 for the isolation arm
  spacingOpen: f32,     // @default 0.11  ⚑ HOW FAR SUSTAINED ENERGY HOLDS THE GAPS OPEN — AND THIS IS THE FILE'S FIRST AUDIO LANE TO REACH THE FORM SINCE T1318b DELETED THE LAST ONE. It is here deliberately and on the one principle all three of the owner's rejections point at: *"the shape shifting should be more audio reactive"* arrived in the same breath as *"we can't have like 1 frame camera punches on kick"* ∴ ⚑ THE TIMESCALE OF THE DRIVER MUST MATCH THE TIMESCALE OF THE THING DRIVEN. A TRANSIENT driving form is a PUMP (deleted twice); a transient driving a camera is a TWITCH (deleted once, by name); A SUSTAINED SIGNAL DRIVING FORM IS THE PIECE DANCING. ⚑ AND IT IS AN OFFSET ON THE GAP, NOT A RATE ON THE CLOCK — which is a correctness point and not a taste one. A fragment shader cannot INTEGRATE a time-varying rate (there is no state to integrate into), and multiplying a rate into 't' instead makes the phase JUMP by 't × Δrate / period' whenever the drive moves — an error that GROWS WITH THE CLOCK and at a minute in is a fifth of a lap of lurch per beat. An offset added to a bounded quantity is continuous by construction however the drive behaves. ⚠ READ CENTRED (its driven mean is its retained value) so §V914 holds by arithmetic: the silent picture is the picture with this lane deleted
  spacingPeriod: f32,   // @default 103  SECONDS for the gaps to breathe once, unforced. Prime, and prime against the other ten. A FORM clock ∴ slow: the owner's *"opening and closing"* is a thing a shot has to be able to sit inside, which is the same test every form clock in this file is set by
  bulbPower: f32,       // @default 2.4  ⚑ THE BULB'S *FLOOR*, AND IT USED TO BE 1 — WHICH IS THE IDENTITY, SO THE BULB WAS SWITCHED OFF AT REST. The character clock travels from here to 'bulbPeak' through a raised cosine that DWELLS AT BOTH ENDS, so a value of 1 meant the piece spent most of any viewing with NO bulb at all, and the only shaping operator actually running was the box fold. ⚠ A BOX FOLD IS A CUBE BY CONSTRUCTION ('clamp(p, -limit, limit) * 2 - p' reflects the domain about the faces of a cube) — so the owner's *"the thing looking less like a cube all day with warts"*, said after two passes of material work, was a correct reading of the DOMINANT OPERATOR from the silhouette, and no amount of surface detail could ever have answered it: detail on a cubic body IS warts on a cube. Above 1 the body is permanently lobed and the character clock varies an already-organic shape rather than switching organicity on and off
  bulbPeak: f32,        // @default 4.2  how far bulbPower travels at the top of its cycle. Lobe count rises with it and the travel is continuous, so the lobes GROW rather than appear
  seedOffset: vec4f,     // @default [0, 0, 0, 0]  added to the fold seed alongside the ray's own starting point: the object's identity. Drifting it merges lobes and opens shells — the strongest evolution axis in the file
  seedDrift: f32,      // @default 0.26  how far the constant wanders over seedPeriod
  // ⚑ 'openness', 'openSpread' AND 'openVoid' ARE GONE (T1318b). They were the one audio lane
  // that reached the SHAPE, and the owner cut them by name after watching the result:
  // *"it's still pumping, like pulsing instead of us doing it by camera, which then prevents
  // us that we can't have close-ups and flyovers that make sense without being noisy because
  // the thing itself rotates and pumps. So I think we really need to do this with the camera
  // instead."* That REVERSES their earlier *"it doesn't have to be the camera that moves"* and
  // it is now the rule the file is built against: LIGHT MAY FLASH AT BEAT RATE, FORM MAY NOT.
  // The reason is not taste — a camera move is a rigid transform of the view, so world-space
  // detail stays coherent across frames and the eye integrates it, while a pump DEFORMS the
  // very structure the shot is magnifying. Deleting the lane is byte-identical at rest, which
  // is the whole argument for having centred it on 0.5 in the first place: the picture the
  // piece shipped with no audio is exactly the picture it ships now.
  foldSpin: vec4f,      // @default [0.31, 0.47, 0.23, 0]  the rotation between iterations, in turns per lap, per axis — THE SEGMENTATION KNOB. An isometry, so the estimate stays exact at every angle and this can run forever
  detail: f32,          // @default 1  scales the march's termination threshold against the PIXEL'S OWN FOOTPRINT. Below 1 resolves finer structure and costs steps; above 1 stops sooner and is the cheapest quality knob in the file
  stepScale: f32,       // @default 0.78  how much of the estimate the march actually steps. Below 1 because a chain this long accumulates derivative error; it is the file's safety margin against marching THROUGH the surface at grazing angles
  normalWiden: f32,     // @default 1  how many termination epsilons wide the NORMAL's central differences are, and 1 is the shipped-before-T1328b behaviour exactly, so it doubles as the isolation arm. ⚑ THIS IS THE FILE'S DISTANCE LEVEL OF DETAIL AND IT LIVES ON THE *NORMAL*, NOT ON THE ITERATION COUNT (T1328b). 'epsilon' already scales with the pixel's footprint, so a constant multiplier here is automatically wider at range and untouched close up — measured, at the same frame: pixel-scale grain 0.1462 -> 0.0950 at orbitRadius 22 and 0.0739 -> 0.0733 at 12, with coverage 11.17 -> 11.17 % and the silhouette's convolution 6.28 -> 6.38 ∴ the fizz goes and the OUTLINE does not move. ⚠ THE DOCBLOCK AT 'normalAt' ARGUED THE OPPOSITE ('a normal sampled wider than the feature it sits on reads as a melted object') AND THE SWEEP OVERRULED IT — at range the feature IS below the pixel and averaging it is the only honest answer. ⚠ AND THE GRAZING-ADAPTIVE VERSION IS REFUTED: dividing the width by 'abs(dot(n, dir))' measured WORSE at both ranges (0.1462 -> 0.1579 at 22, 0.0739 -> 0.0826 at 12), because that cosine is itself noisy and dividing by a noisy quantity injects noise
  bailout: f32,         // @default 256  escape radius — where a point is declared outside and the orbit stops

  // ─── THE CLOCKS (T1310b's acceptance criterion: what is different at 15 s, 45 s, 90 s) ──
  // ⚑ EVERY *FORM* CLOCK BELOW IS ROUGHLY THREE TIMES LONGER THAN IT WAS (T1318b), AND THE
  // LIGHT AND COLOUR CLOCKS ARE UNTOUCHED. That split is the owner's ruling stated as
  // numbers: form may evolve visibly over a minute and may not restructure under a shot,
  // light may do whatever the music asks. An approach lasts about thirteen seconds at
  // 'pushPeriod' 43 — the window where the cubed travel is over half — so the test a form
  // clock has to pass is "does the structure survive thirteen seconds of being looked at",
  // and at 19 s the fold rotation used to turn through two thirds of a lap inside one.
  morphPhase: f32,      // @default 0.37  where in the fold rotation's lap the clock STARTS. ⚑ NOT cosmetic: at phase 0 the rotation is the IDENTITY and the object is its own axis-aligned degenerate case — a flat slab. Every thumbnail and every headless render begins at t=0, so phase 0 ships the single worst frame in the piece as the picture of it
  morphPeriod: f32,     // @default 89  SECONDS for the fold rotation to make one lap. ⚑ WAS 19, AND THIS IS THE OBJECT'S OWN ROTATION — the thing the owner meant by *"the thing itself rotates"*, as against the camera travel that was mislabelled as a pose
  paletteTurn: f32,     // @default 197  ⚑⚑ SECONDS FOR THE WHOLE PALETTE TO SWING ONCE THROUGH ITS ARC AND BACK. The owner asked for *"the lights color should evolve over time"* and §V996 forbids an unbounded rotation because it walks one colour into another's. ⚑ BOTH ARE SATISFIED BY ROTATING THE PALETTE AS A *RIGID BODY*: 'rotateHue' is a Rodrigues rotation about the luma axis, so one turn applied to EVERY colour is an isometry of the wheel and EVERY pairwise arc is preserved EXACTLY, for every t. §V996's defect is PER-ELEMENT drift — a colour moving RELATIVE to the others — and common-mode drift cannot produce it. ⚠ §V995 BINDS AND THE ALGEBRA IS NOT THE MEASUREMENT: the pairwise arcs are asserted from rendered pixels, not from this paragraph. 1e9 parks the palette exactly where its author put it, which is the isolation arm
  paletteArc: f32,      // @default 0.16  ⚑ HOW FAR THE WHOLE PALETTE MAY TRAVEL, IN TURNS — AND A *BOUNDED COMMON-MODE SWING* IS THE FORM THIS TOOK AFTER THE UNBOUNDED LAP WAS RENDERED AND LOOKED AT (T1324b). The isometry argument is exactly true and it is an argument about ARCS: rotating every colour together preserves every angle, so §V996's collision cannot happen at any phase. ⚠ IT DOES ⊥ FOLLOW THAT EVERY PHASE IS THE SAME DESIGN, BECAUSE THE EYE IS ⊥ ROTATION-INVARIANT: measured, at 0.30 of a turn the piece is yellow pods on pink stone, with every arc intact and nothing left of the teal-against-magenta the frame was built on. ⚑ SO THE BOUND IS ⊥ §V996's BOUND & IT IS ⊥ REDUNDANT WITH IT — 'hueArc' stops two colours COLLIDING, this stops the palette WANDERING OUT OF ITS OWN FAMILY, and those are two different failures needing two different ceilings. 0.5 restores the full-wheel behaviour, which is the arm the yellow frame came from; 0 pins the palette exactly as authored
  beatShade: f32,       // @default 0.018  ⚑ HOW FAR A TRANSIENT NUDGES THE POD'S SHADE, IN TURNS — the owner's *"maybe also slightly change in shade with beat"*. §V990 permits a transient to move something that RETURNS, and a hue is exactly that: the envelope decays and the colour comes back. ⚠ IT IS A SHADE AND NOT A BRIGHTNESS — a beat-rate gain on a source is the pump the owner rejected three times, wearing a colour's clothes. ⚠ AND IT IS THE ONE PER-ELEMENT HUE MOVE IN THE FILE ∴ §V996 APPLIES TO IT AND NOT TO 'paletteTurn': the arc it may open or close is measured against EVERY other pair, and 0.018 is set by the tightest one. Read UN-CENTRED like 'burst' beside it, so the no-audio picture is the DRIVEN MEAN's colour (§V914 by the same arithmetic as every other lane here)
  hueTurn: f32,         // @default 37  SECONDS for the colour to travel one lap of its arc. UNCHANGED: colour is light
  hueArc: f32,          // @default 0.045  ⚑ HOW FAR A HUE MAY TRAVEL FROM WHERE ITS AUTHOR PUT IT, IN TURNS — AND IT IS THE GUARD ON A TRANSFORM THAT HAS BITTEN THIS FILE THREE TIMES. 'fillTint' rotated into magenta and was neutralised, 'rimColor' carries a standing exemption for the same reason, and the vein tint was the third. ⚑ THE DEFECT WAS NEVER A BAD VALUE, IT WAS AN UNBOUNDED LAP: the hue clock reads 't / hueTurn' and GROWS WITHOUT BOUND ∴ the rotation visits EVERY hue, including whichever one another object in the frame owns. Bounding the travel makes that impossible by ARITHMETIC instead of by a comment asking the next person to be careful, which is what three annotations have already failed to do. ⚠ AND THE VALUE IS SET BY THE *TIGHTEST* PAIR, WHICH IS NOT THE ONE THE BUG WAS ABOUT — the first value tried, 0.075, fixed the vein-against-pod separation (0.003 turns at a full lap, i.e. IDENTICAL, up to 0.341) and drove the vein-against-KEY separation to EXACTLY 0.000, because those two travel in OPPOSITION and an opposition closes a gap at TWICE the arc. The vein and the key start only 0.137 turns apart ∴ the arc must stay under half of that. At 0.045 the worst case over a full lap is 0.375 turns from the pods and 0.048 from the key, both positive and both bounded for all t. ⚑ THE GENERAL FORM: A BOUND ON A TRAVEL IS SET BY THE CLOSEST PAIR IT CAN BRING TOGETHER, & OPPOSED TRAVELS CLOSE AT THE SUM OF THEIR ARCS. 0 pins both colours exactly as authored, which is the isolation arm; 0.5 restores the old full-wheel behaviour
  scalePeriod: f32,     // @default 181  SECONDS for the magnification to breathe. ⚑ WAS 47 — this is the pump, and a pump is the one thing a magnified shot cannot survive
  lightCycle: f32,      // @default 53  SECONDS for the key light to hand off to the next one. UNCHANGED: a light rig may move at any speed, and now that the key casts a shadow this clock is what sweeps that shadow across the form
  characterPeriod: f32, // @default 71  SECONDS for the shape to travel through its character and back. ⚑ IT WENT 73 -> 211 -> 71 IN ONE PASS, AND BOTH MOVES WERE RIGHT AT THE TIME: 211 was the owner's "stop pumping" applied to the clock measured to be the file's biggest deformer, and 71 is the same owner, minutes later, saying *"the shape is still static"* about a character cycle NOBODY HAS EVER WATCHED COMPLETE. What reconciles them is that the TRAVEL shrank: with 'bulbPower' floored at 2.4 the character moves through 1.8 of exponent rather than 3.2, so the shape changes visibly in a quarter of a minute while deforming more slowly per second than it ever did
  seedPeriod: f32,     // @default 277  SECONDS for the seed offset's drift. ⚑ WAS 113
  voidPeriod: f32,      // @default 107  SECONDS between the shells OPENING. ⛑ WAS 89. The owner asked for negative space inside the sculpture "occasionally", and occasionally is a CLOCK rather than a setting
  voidTravel: f32,      // @default 0.26  how far the sphere fold's inner radius travels when they open. ⚑ THIS IS A CHAIN PARAMETER, NOT A CARVE: the voids are opened by the fold that already makes the shells, so the estimate stays exact. A hole cut with a min/max AGAINST the chain would cost a step-scale and make every cost figure in this file dishonest
  tempoScale: f32,      // @default 1  multiplies the MORPH clock only (T1309b). Driven from the track's own bpm over 112, so it RESTS AT EXACTLY 1 on the shipped pattern and the piece runs faster under faster music instead of being tuned to one tempo

  // ─── THE CAMERA'S SECOND AXIS, ITS APPROACH, AND ITS AIM ─────────────────────────────
  // ⚑ THESE WERE DOCUMENTED AS "THE OBJECT'S POSE" AND THEY WERE NEVER THAT. The transform
  // is 'transpose(rotY * rotX)' applied to the EYE AND THE RAY DIRECTION TOGETHER, and a
  // rigid rotation applied to both is a CAMERA MOVE by definition — the eye walks a sphere
  // about the origin while the object and the light rig stand still. Nothing visible ever
  // distinguished the two readings, which is why a docblock could describe a camera orbit as
  // an object rotation for two passes without any render disagreeing (§V973's class exactly:
  // a claim nothing can contradict).
  // ⚑ AND THAT MATTERS NOW, BECAUSE THE OWNER SAID *"the thing itself rotates and pumps"*.
  // If this were the object rotating, the fix would be here. It is not: what actually rotates
  // the OBJECT is 'foldSpin' on the morph clock, and what pumped it was the deleted
  // 'openness' lane. So the repair went there, and this stayed — correctly named at last.
  // ⚠ DO NOT MOVE THIS INTO THE MARCH. Transforming the ray once costs one mat3 product per
  // pixel; transforming the sample point would cost one per DE evaluation, and a pixel makes
  // about a hundred and fifty of those.
  posePeriod: f32,      // @default 47  SECONDS for the camera to travel once around its second axis. Prime, and prime against all the others, so the angle you see and the shape you see never line up twice. ⛑ WAS 61 (T1322b, with the whole camera): see 'orbitPeriod'
  poseTilt: f32,        // @default 0.68  how far the camera rises and dips across that travel, in radians — the reason you see the object's top and its underside rather than an equatorial band forever. ⛑ WAS 0.42, AND A PERIOD ALONE COULD NOT HAVE ANSWERED *"we're really moving about in slowmo"*: shortening a clock without widening its travel makes the SAME small move more often, which reads as fidgeting rather than as travel. RATE AND REACH ARE ONE DECISION, the same pairing 'nodeGlow' and its falloff turned out to be
  pushPeriod: f32,      // @default 31  SECONDS between APPROACHES. Prime. This clock is also the SHOT LANE: 'shotAt' reads it for how close the camera is and for how much the rig should settle while it is there. ⛑ WAS 43 (T1322b): the approach is the piece's biggest single camera gesture and at 43 s a viewer saw one and a half of them in a minute
  poseNear: f32,        // @default 2.05  how much bigger the object gets at the top of an approach. ⚑ The travel is CUBED, so it is near zero for most of the period and rises to a peak briefly — the same "occasionally" idiom the void clock uses, because a dolly that never rests is a ride and the owner asked for a framed object
  aimPeriod: f32,       // @default 59  SECONDS for the framing to wander. Prime. ⛑ WAS 67 (T1322b)
  poseAim: f32,         // @default 0.62  how far off the centroid the camera looks when it is closest. ⚑ THIS IS THE "FOLLOW ONE OF THE KNOBS" HALF: a compact sculpture framed on its centroid is a portrait of the whole thing forever, and the interesting part of a fractal is never the middle. It rides the SAME approach, so the frame only leaves the centre while there is something close enough to be worth looking at
  // ⚑ 'punch' AND 'punchGain' ARE GONE (T1322b). THEY WERE A DOLLY ON THE KICK, AND THE OWNER
  // REJECTED THE WHOLE IDEA BY NAME ON SEEING IT: *"camera pulses are so ugly too. that's
  // vomit inducing. i don't think that's really what we wanna do."* ⛑ THE ARGUMENT FOR THEM
  // WAS SOUND AND THE ARGUMENT WAS NOT THE POINT: a rigid dolly really does preserve
  // world-space detail across a transient where the deleted pump destroyed it, and T1318b
  // measured the lane at 92 % of the piece's entire fast response (5.07 on a hit against 1.12
  // between). It was removed anyway, unsoftened, because A CORRECT MECHANISM POINTED AT AN
  // EFFECT NOBODY WANTS IS STILL THE WRONG EFFECT, and shrinking it would have kept the
  // gesture and only made it smaller. ⚑ THE CONSEQUENCE IS STATED RATHER THAN HIDDEN: with
  // this gone the piece's fast-lane response drops to near zero, which is what the punch was
  // carrying. That is expected and it is NOT paid for here with a substitute motion — the
  // owner's replacement is on the audio side (*"rather use a better kick detection… and then
  // mids and highs and lows separated out used to drive stuff"*), which is a change to the
  // ANALYSER and not to this file. ⚠ SO DO NOT REINSTATE A BEAT-DRIVEN CAMERA TERM HERE. The
  // camera's ORDINARY travel is a different question and it got faster in the same pass; what
  // is closed is the camera moving ON A HIT.
  shotHold: f32,        // @default 1  ⚑ HOW MUCH THE RIG SETTLES AT THE TOP OF AN APPROACH — the shot lane, and it decides CAMERA behaviour rather than which drive is gated. At 1 the orbit, the second axis and the aim all come to a dead stop while the camera is close and resume as it pulls out, so a close-up is a HELD LOOK rather than a whip-pan through magnified detail. At 0 the rig runs exactly as it did before this existed, which is the isolation arm

  // ─── THE CAMERA: parked, because the OBJECT carries the motion ────────────────────────
  orbitPeriod: f32,     // @default 23  SECONDS for one lap around the object. ⛑ WAS 96, THEN 41, AND IT IS 23 BECAUSE THE OWNER WATCHED 41 AND SAID *"camera movements may actually be too slow. should be more dynamic. we're really moving about in slowmo"*. ⚑ AND THIS IS THE *SLOW* LANE, WHICH IS THE HALF OF THAT COMPLAINT STILL STANDING: the FAST lane's answer (a kick-driven dolly) was measured at 92 % of the piece's transient response and then rejected outright by the same owner — *"camera pulses are so ugly too. that's vomit inducing"* — so beat-driven camera motion is closed and what is left to speed up is the ORDINARY travel, which is this. ⚑ IT CAME DOWN BECAUSE THE SHAPE SLOWED DOWN: the energy the form used to carry has to go somewhere, and the owner named where — *"we really need to do this with the camera instead"*. A lap in 41 s is a real fly-around rather than a drift, and it is safe at a speed no form clock is, because a camera move is a RIGID transform of the view and the detail stays coherent under it
  orbitSpeed: f32,      // @default 1  multiplier on the orbit. 0 parks the camera dead still, which is what a claim about the SHAPE's evolution must do (§V965)
  orbitRadius: f32,     // @default 12  how far the eye sits from the object's centre
  orbitHeight: f32,     // @default 1.15  the eye above the object's equator at rest
  orbitRise: f32,       // @default 2.4  how far the eye rises and falls, on a period deliberately incommensurable with the lap so the camera never repeats a position. ⛑ WAS 1.35 (T1322b): at 1.35 against an 'orbitRadius' of 12 the eye moved through about 6° of latitude and the lap was very nearly an equatorial band — which is most of why a faster lap alone would still have read as slow. The eye now swings through about 11°, so the lap is a real arc over the body rather than a circle around its waist
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
  nodeLinks: f32,       // @default 2  ⚑ HOW DEEP INTO THE CHAIN THE *NODE* TRAP LOOKS, and it is this file's cure for the magenta SALT. The trap is 'min(dot(p,p))' over the orbit, and the orbit's LATE links live at the chain's finest scale — where neighbouring rays visit genuinely different structure, so the trapped value is CHAOTIC FROM PIXEL TO PIXEL and every mark built on it is single-pixel noise. ⚠ AND WIDENING THE MARK CANNOT FIX THAT: a wider threshold on a chaotic field is a chaotic field with a wider threshold, which is why the pixel-footprint widening that works for the veins does nothing here (measured — the salt survived 'nodeGlow' 0 AND 'nodeSpill' 0 separately, so it was never a brightness). ⚠ AND THE SWEEP IS A CLIFF, NOT A SLOPE (§V981): 6 links and 4 links are INDISTINGUISHABLE from 11, and 2 is clean. Everything from the third link down is already under the pixel, so the whole of the noise lives there and a cautious value buys exactly nothing. Truncating the trap is a genuine level of detail: a node becomes a COARSE feature of the orbit, the marks get bigger and fewer, and the interleaving §V972 needs survives because six links is still six decades of scale in one frame
  nodeRadius: f32,      // @default 0.34  how close the orbit has to pass the ORIGIN to leave a node. A third KIND of mark — points, where the veins are lines and the membranes are sheets
  nodeGlow: f32,        // @default 22  how hard a node's CORE burns. 0 removes the cores
  nodeSpill: f32,       // @default 3.2  how hard a node lights the stone AROUND it — the difference between a light and a sprite. A wider window on the SAME trap (§V962), so the pool lands exactly where the pod is. It also lets the core sit lower than the impression needs, which is what stops it clipping to white and losing its hue
  nodeFade: f32,        // @default 15  METRES over which a node's SHARP core fades out, leaving only its spill. ⚑ A MIP LEVEL DONE AS A FADE, because a marcher has no derivatives to pick one with: a sixth-power falloff on a fractal is fine relief, and fine relief far away is smaller than a pixel and turns into SALT. Sanctum's fix for its own grain, taken rather than reinvented
  podShade: f32,        // @default 0.15  how dark a pod's own emission goes on the side of it that the rig does not light, as a fraction of its lit side. ⚑ 1 IS THE PRE-T1326b BEHAVIOUR EXACTLY AND IS THE ISOLATION ARM. A pod is GEOMETRY (§V1001) and a self-lit ball's own shading is drowned by its own emission; this is the factor that lets the shading survive the light. See 'podShadeLevel'
  podShadeLevel: f32,   // @default 1.4  the shell luminance at which a pod's emission reaches full. ⚑ SWEPT AGAINST THE PEAK, BECAUSE A SHADING TERM THAT DIMS THE WHOLE POD IS §V977's DEFECT WEARING A REPAIR'S CLOTHES: at 3.5 the pod's core luma falls 192.7 -> 153.3 and the claim's own brightness guard catches it; at 1.4 it is 185.1 and the within-pod span is HIGHER (0.628 -> 0.714), because the lit side saturates and only the TERMINATOR is paid for. The core chroma goes the other way (0.349 -> 0.257) and both are well above the 0.226 this replaced, which is the trade: 1.4 buys back 32 luma of peak for 0.09 of chroma the pod did not have before. The pod's modulation is 'mix(podShade, 1, clamp(shellLuma / podShadeLevel, 0, 1))' — the ball's OWN three-light response, which is the one quantity measured to vary across a pod (per-pod rank span 1.113, against 0.030 for the ambient occlusion and 0.156 for the shadow)
  nodeColor: vec4f,     // @default [1, 0.36, 0.86, 1]  ⚑ THE SECOND HUE, AND IT IS CARRIED BY AN OBJECT (§V972). Six passes on the sibling piece put a second colour on a LIGHT and every one read as a wash; what fixed it was giving the hue to a THING the eye can point at. The nodes are that thing

  // ─── THE BEAT'S ONLY DESTINATION, AND IT FIRES IN SUCCESSION (T1318b) ─────────────────
  flare: f32,           // @default 0  ⚑ THE KICK'S BAND ENVELOPE, AND THE *ONLY* AUDIO LANE LEFT THAT TOUCHES THE PICTURE'S STRUCTURE. It is read TWICE — as an AMOUNT and as a POSITION — which is what makes the marks fire one after another instead of all at once. See 'emissionAt'
  flareDepth: f32,      // @default 7  how many times over a mark burns at the top of its own turn in the sweep. This is the gain the global 'veinEmission' lane used to carry, moved onto the individual mark
  flareWidth: f32,      // @default 0.3  what SHARE of the marks are lit at any one instant of the sweep. 1 is unison — every mark flares together, which is the global pump wearing a different coat — and small is a thin travelling wave. The owner's words were "the brightness of SOME of the glow areas"

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

  // ─── THE KEY LIGHT CASTS A SHADOW, AND UNTIL T1318b NOTHING IN THIS FILE DID ──────────
  // ⚑ The owner: *"the whole thing still looks too statically lit and still very grey and
  // weird AS IF THE LIGHTS ARE ALL LIKE NOT CONES BUT JUST ALL GLOBAL GOD LIGHTS."* That was
  // literally true and it was not a cone problem: the file had AMBIENT OCCLUSION and no cast
  // shadow at all, so every surface facing a light was lit by it regardless of what stood in
  // between. AO darkens creases by GEOMETRY ALONE, which means it looks the same wherever the
  // lights are — which is exactly why the piece read *statically* lit while the lights
  // demonstrably moved. On a deep-folded fractal self-shadowing is not a refinement; it is
  // the term that makes a fold read as depth rather than as grey noise.
  shadowStrength: f32,  // @default 1  how much of the key a shadow takes away. ⚑ 0 SKIPS THE SECOND MARCH ENTIRELY rather than multiplying its result by one — the same wavefront-uniform branch 'polish' uses, and the reason this stage's cost can be measured by alternating a parameter instead of editing the shader
  shadowSoft: f32,      // @default 9  the penumbra. Low is a broad soft-edged shadow, high is a hard contact one. It is the ratio of the closest approach to the distance travelled, which is the standard DE penumbra estimate and costs nothing beyond the march that is already happening
  shadowSteps: f32,     // @default 28  iterations for the SHADOW ray. A fraction of the primary's, like the reflection's — but unlike the reflection this march uses the FULL chain, because a shadow sampled from a coarser field is a shadow of a different object and would not land where the geometry is (§V973)
  shadowReach: f32,     // @default 9  metres marched toward the key before the ray is declared unobstructed. The lights sit at 'lightDistance'; this bounds the worst case rather than the typical one, because on a folded surface most shadow rays terminate in a handful of steps

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
  reflectLinks: f32,    // @default 4  how deep into the chain the reflection's EMISSION looks. ⛑ THIS WAS BUILT AS THE FRECKLE FIX AND IT IS NOT ONE — SWEPT 11/8/6/4/3/2 THE MAGENTA MARK COUNT IS 1593/1593/1593/1593/1594/1585, i.e. FLAT, and only at 1 link does it move (1279). It is kept for the one thing it does honestly buy — four links instead of eleven in a march that runs on most shaded pixels — and its docblock says what it measured rather than what it was meant to do (§V973's own rule: a claim nothing can contradict is not a claim). ⚑ WHAT THE FLAT SWEEP *PROVED* IS WHERE THE FRECKLES ARE NOT: not in the depth of the field, ∴ not in anything a smoother field can fix. See 'reflectSharp'
  reflectSharp: f32,    // @default 0  ⚑ HOW MUCH OF A POD'S *SHARP CORE* A REFLECTION CARRIES, AND AT 0 THE ANSWER IS NONE — THIS IS THE FRECKLE FIX (T1322b). ⚑ THE MECHANISM, AFTER TWO WRONG GUESSES: the reflected ray's HIT IS A PER-PIXEL BOOLEAN. 'reflect(view, n)' off a FRACTAL normal means adjacent pixels' rays diverge; each one either finds something within 'reflectFade' or does not, and the two branches return wildly different brightnesses. THAT is the chaotic field, and it is not made smoother by reading fewer links (measured flat) or by widening the marks (measured ~7 %, which is nothing) — because neither touches the hit/miss decision. ⚑ WHAT *CAN* BE FIXED IS WHAT THE HIT RETURNS. A pod's core is a SIXTH-POWER falloff, i.e. the highest-frequency signal in the file, multiplied by a 'nodeGlow' of 22; sprayed through a binary per-pixel decision it is salt with a 22x gain. Its SPILL is a smooth first-power pool and survives the same decision as a pool. ∴ ⚑ A REFLECTION MAY CARRY A LIGHT'S POOL BUT NOT ITS FILAMENT. That is the same mip reasoning already written at 'nodeFade' — fine relief is correct at arm's length and NONSENSE where one period of it is smaller than a pixel — applied to the one path that never got it. 1 is the isolation arm and restores the old behaviour exactly
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
  highlightKnee: f32,   // @default 0.8  where the hue-preserving shoulder starts, in linear light AFTER the grade. Below it nothing is touched at all, which is what makes this a HIGHLIGHT operator and not a second grade: measured, a knee of 0.8 reaches 45.2% of pod pixels and 0.07% — eighty-one pixels — of everything else in the subject, and the non-pod subject's p50/p90/p99/p999 come out 73.9/118.1/146.8/166.7 against a shipped 73.9/118.1/146.9/166.7
  highlightCeiling: f32, // @default 1.1  where it ends: the largest value any channel may hand to the output node's tone map. ⚑ THE WHOLE REPAIR IS IN THIS NUMBER AND THE REASON IS DOWNSTREAM (T1325b). The sink runs Narkowicz PER CHANNEL, and a per-channel curve turns a saturated colour white as soon as its DIMMEST channel is large — measured exactly: a channel at 0.80 linear lands on byte 226, so a pixel whose minimum channel passes 0.80 has no hue left. 16.26% of pod pixels were past it, against 16.0% measured white in the shipped frame by an instrument that shares no code with this one. Capping the MAXIMUM channel at 1.1 caps the minimum at 1.1 times the pod's own hue ratio, which is under the line by construction. ⚠ AND A HIGHER CEILING IS NOT THE SAFER CHOICE IT LOOKS LIKE: filmic is so compressive up here that 1.1 -> 1.6 buys SIX BYTES of peak and costs a THIRD of the core's remaining chroma
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
/* ⚑ 'HAZE_SEED' IS GONE WITH THE HASH IT SEEDED (T1322b). The volume's start offset is an R2
   sequence over the pixel now, which needs a PHASE and not a seed — and it borrows
   'VEIN_PHASE' rather than carrying its own, because two independent generators over
   different lattices cannot alias whatever phase either one starts at. */
/* Where the FLARE sequence starts. See 'emissionAt' for why it is a second projection of the
   same lattice rather than a second offset into the first one. */
const FLARE_PHASE: f32 = 0.618;

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
  /* The sphere fold's OUTER radius at this moment: THE SPACING BETWEEN STRUCTURES (see
     'spacingTravel'). It was a bare uniform read inside the chain until T1322b; it is a
     'Shape' field now because it MOVES, and everything in the chain that moves lives here so
     one function owns the whole of "what shape is this at time t". */
  fixedRadius: f32,
  /* 0..1 through the character cycle, published so the shading can follow the shape: a bulb
     phase and a skeleton phase should not be graded identically. */
  character: f32,
};

/**
 * THE SHOT — how close the camera is, and how much the rig has settled to look at it.
 *
 * ⚑ A SHOT LANE IS A CAMERA DECISION, AND THAT IS THE WHOLE OF T1318b's SECOND ITEM ONCE THE
 * OWNER RULED THAT FORM DOES NOT MOVE. It was originally specified as "close shots gate which
 * drive is running"; with the form lanes deleted outright there is nothing left to gate, and
 * what remains is the part that was always the point: A CLOSE-UP SHOULD BE A HELD LOOK.
 *
 * ⚑ AND THE HOLD IS AN INTEGRAL, NOT A MULTIPLY — which is the only difficult line in it.
 * Scaling the camera's ANGLE by (1 - close) does not stop the camera: it winds the angle
 * BACK toward where the lap started as the shot closes, which is a bigger move than the one
 * it replaced and in the wrong direction. "Stop" is a statement about the RATE, so the angle
 * has to be the integral of (1 - close) dt. That integrand has an exact antiderivative, which
 * is why this costs four instructions and carries no state:
 *
 *     d/du [ (2.5u - 4 sin u + 0.75 sin 2u + sin^3 u / 3) / 8 ]  =  ((1 - cos u) / 2)^3
 *
 * Expanded rather than eyeballed: 2.5 - 4c + 1.5(2c^2 - 1) + (1 - c^2)c = 1 - 3c + 3c^2 - c^3,
 * which is (1 - c)^3. The mean of the cubed travel is 2.5/8 = 0.3125, so the SECULAR quarter
 * of the integral is exactly 0.3125 * t and is subtracted in closed form — otherwise the term
 * would be computed as the difference of two large and nearly equal numbers, which in f32 is
 * how a camera develops a jitter at minute fifteen.
 */
struct Shot {
  /* 0 = a wide shot, 1 = the top of an approach. */
  close: f32,
  /* SECONDS OF CAMERA TIME: real time with the approach's own dwell removed. Every lap in the
     rig reads this instead of 't', so they all settle together and resume together. */
  held: f32,
};

fn shotAt(t: f32) -> Shot {
  let period = max(params.pushPeriod, 1.0);
  let u = (t / period) * TAU;
  /* CUBED, so the camera is wide most of the period and close briefly — the owner's word for
     the negative space was "occasionally" and a dolly that never rests is a ride. */
  let phase = 0.5 - 0.5 * cos(u);
  var s: Shot;
  s.close = phase * phase * phase;
  let sn = sin(u);
  let swing = (-4.0 * sn + 0.75 * sin(2.0 * u) + sn * sn * sn / 3.0) / 8.0;
  let dwell = 0.3125 * t + (period / TAU) * swing;
  s.held = t - clamp(params.shotHold, 0.0, 1.0) * dwell;
  return s;
}

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

  /* ⚑ NOTHING AUDIO-DRIVEN REACHES THIS FUNCTION ANY MORE (T1318b), AND THE DELETION WAS
     BYTE-IDENTICAL AT REST — which is the dividend of having centred the lane on its own
     neutral value rather than on its floor. The lane that used to be here read 'openness'
     as an offset from 0.5 and retained exactly 0.5, so the term it added was exactly zero
     with no audio; removing it therefore cannot move the no-track picture by one bit, and
     §V914 is satisfied by the SAME arithmetic that satisfied it when the lane was added.
     What the piece lost is the owner's *"sometimes more loose, sometimes less"* — and what
     it bought is the shot the owner asked for instead. A close-up is a magnification, and a
     magnification of a surface that is being rebuilt every frame is noise however good the
     rest of the frame is. The music now moves LIGHT (see 'flare'); the camera moves. */
  s.minRadius = max(0.05, params.minRadius + params.voidTravel * voidPhase * voidPhase * voidPhase);

  /* ⚑ THE SPACING: THE GAPS BETWEEN THE NODULES OPENING AND CLOSING (T1322b), AND THE OWNER
     ASKED FOR IT THREE TIMES BEFORE IT EXISTED. T1318b shortened 'voidPeriod' 239 -> 107 and
     called it answered; it was not. The void clock moves 'minRadius', which HOLLOWS OUT the
     shells — a different thing from the structures pulling apart from one another, and the
     owner's words are *"stuff actually moving away from stuff"*.
     ⚑ WHY 'fixedRadius' IS THE RIGHT OPERATOR AND WHY THIS COSTS NOTHING. The sphere fold is
     'p *= fixedRadius² / r²', and it multiplies the DERIVATIVE by the same factor — so it is a
     pure scaling, the estimate stays EXACT at every value, and raising it pushes every
     structure outward from every other one. A gap cut with a min/max against the chain would
     cost the whole file its step scale and make every cost figure in it dishonest, which is
     the argument already written at 'voidTravel' and it applies twice as hard here.
     ⚑ A PLAIN SINE, NOT A CUBED RAISED COSINE. The voids open OCCASIONALLY (the owner's word)
     so their clock dwells shut; the gaps BREATHE (the owner's word) so this one is moving at
     every moment of its lap. The two shapes are the two different asks, stated as two
     different curves off two coprime clocks.
     ⚑ AND THE AUDIO TERM IS AN OFFSET ON A BOUNDED QUANTITY, which is what makes a sustained
     drive safe on the form where a transient never was: however the drive moves, the gap is
     continuous in it, and the clamp below is the only guard the estimator needs. */
  let spacingPhase = t / max(params.spacingPeriod, 1.0);
  s.fixedRadius = clamp(
    params.fixedRadius
      + params.spacingTravel * sin(spacingPhase * TAU)
      + params.spacingOpen,
    s.minRadius + 0.02,
    3.0,
  );
  s.foldLimit = max(
    0.4,
    params.foldLimit + params.foldTravel * sin((t / max(params.scalePeriod, 1.0)) * TAU * 0.63 + 2.1),
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
     it is trapped on, so this is one 'min' per link and nothing else.
     ⚠⚠ AND THE "RECURS AT EVERY SCALE" CLAIM ABOVE IS FALSE AS SHIPPED, MEASURED (T1324b):
     'nodeLinks' 1 / 2 / 6 give BIT-IDENTICAL pods (8 pods, 2834 px, the same two shape
     statistics to three decimals) because the FIRST link wins the min essentially everywhere
     the pods are visible — at i = 0 the trapped quantity is |boxFold(rot * p)|, a fixed
     world-space ball, so the pods are ONE size on ONE lattice rather than an interleaving.
     The claim is left standing above as the intent it was written for; this is what it
     actually does. Read the two together before tuning anything here. */
  node: f32,
  /* ⚑⚑ WHICH POD THIS IS — THE POD'S OWN IDENTITY, CONSTANT OVER THE WHOLE POD BY
     CONSTRUCTION, AND IT IS THE FIX FOR THE OWNER'S "SQUARE PATTERNS / CHECKERBOARD IN THE
     MAGENTA LIGHTS" (T1324b).
     The pod used to be gated and flared on 'floor(p * veinRate)' — the CONDUIT lattice — and
     that cell is 1/3.1 = 0.32 units across while a pod is 2 * nodeRadius = 1.24 units across.
     A membership test evaluated on cells FOUR TIMES SMALLER THAN THE OBJECT IT GATES does not
     gate the object, IT DICES IT: every pod was multiplied by a piecewise-constant,
     AXIS-ALIGNED field that stepped up to 16x across planes running through its own face.
     That is the flat faces, the hard edges and the grid on the face, and it is a checkerboard
     in the strict sense — a square lattice of alternating levels.
     WHAT MAKES THIS EXACT RATHER THAN MERELY COARSER: the pod is the set where the folded
     point is within 'reach' of the origin, so the UNFOLDED point is within 'reach' of a box
     fold lattice site 2 * foldLimit apart. reach (0.62) is smaller than foldLimit (1.45), so
     'round(unfolded / (2 * foldLimit))' names the same site at every point of the pod and
     CANNOT step inside one. A coarser 'floor' lattice would only have made the seams rarer. */
  nodeCell: vec3f,
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
  /* See 'Trace.nodeCell': the box fold lattice site that owns whichever link wins the node
     trap, i.e. the POD's identity. Constant across a pod because reach < foldLimit. */
  var nodeCell = vec3f(0.0);
  var survived = links;

  let minR = max(shape.minRadius, 0.02);
  let minR2 = minR * minR;
  /* ⚑ READ FROM 'shape', NOT FROM 'params' (T1322b): the outer radius is the SPACING lane and
     it moves. Everything the chain reads that moves comes from 'shapeAt' now. */
  let fixR = max(shape.fixedRadius, minR + 0.02);
  let fixR2 = fixR * fixR;
  let limit = vec3f(max(shape.foldLimit, 0.05));
  /* The power map is the file's only transcendental work, so it is SKIPPED ENTIRELY at the
     neutral setting rather than computed and multiplied by nothing. 'bulbPower' is a
     uniform, so the whole wavefront takes this branch together and "no bulb" is genuinely
     free — the same discipline as 'polish' on the reflection. */
  let withBulb = shape.bulbPower > 1.0005;
  /* See 'nodeLinks': the node trap stops at a depth the pixel can still resolve. */
  let nodeLinks = i32(clamp(params.nodeLinks, 1.0, 24.0));
  let bail = max(params.bailout, 16.0);

  for (var i = 0; i < links; i = i + 1) {
    // 1. ROTATE — an isometry: |J| = 1, so the estimate stays exact at every angle.
    p = shape.rot * p;

    // 2. BOX FOLD — a reflection: |J| = 1. Wider than the point, this is the identity.
    let unfolded = p;
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
    /* ⚑ THE MIN IS WRITTEN OUT SO THE WINNER CAN BE NAMED (T1324b). The pod's gate and its
       flare phase have to be constant over a pod, and the only thing that is, is the lattice
       site of whichever link actually trapped it — see 'Trace.nodeCell'. The '+ 7 i' keeps
       one link's sites from picking the same membership as another's. */
    if (i < nodeLinks && r2 < node2) {
      node2 = r2;
      nodeCell = round(unfolded / (2.0 * limit.x)) + vec3f(f32(i) * 7.0);
    }
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
  out.nodeCell = nodeCell;
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

/**
 * ⚑ THE KEY LIGHT'S CAST SHADOW — THE TERM THIS FILE DID NOT HAVE.
 *
 * The owner's *"as if the lights are all like not cones but just all global god lights"* was
 * a literally correct reading of the code. 'occlusionAt' above is AMBIENT occlusion: it asks
 * "how enclosed is this point" and knows nothing about where any light is, so it darkens the
 * same creases by the same amount whatever the rig does. 'lightAt' below had a distance
 * falloff and a lambert term and NOTHING BETWEEN THE LIGHT AND THE SURFACE — so every
 * surface facing a light was lit by it regardless of what stood in the way. That is why the
 * piece read *statically* lit while the lights demonstrably moved: moving a light changed its
 * tint and its intensity and could not change the SHADING PATTERN, because nothing in the
 * shading pattern depended on where the light was.
 *
 * On a deep-folded fractal this is not a refinement. A fold reads as depth because the far
 * wall of it is dark; with only AO, a fold reads as a grey crease of fixed darkness, and a
 * frame full of those is the "very even grey" three passes have been chasing (§V977).
 *
 * ⚑ THE KEY ALONE, AND THAT IS A DIVISION RATHER THAN A CORNER CUT. This is a second full
 * march per light and the frame cannot buy three of them. What fill and rim become without it
 * is AMBIENT WRAP — soft, directionless fill, which is what a fill light is FOR — and the
 * cinematic convention is the same one: the key carries the modelling and the shadow, and the
 * fill exists to keep the shadow from going to black. 'lightSwing' at 0.35 is what makes this
 * hold across 'lightCycle': the key's weight never falls below 0.65, so the shadowed source
 * is the dominant one at every moment of the lap rather than at two thirds of it.
 *
 * ⚑ AND IT MARCHES THE FULL CHAIN, unlike the reflection's short one. A shadow sampled from a
 * coarser field is the shadow of a DIFFERENT OBJECT, and it lands where that object is, not
 * where this one is — §V973's exact failure, and the one shape of it that a viewer WOULD
 * notice, because a shadow that misses its own geometry is the most visible kind of wrong.
 */
fn shadowAt(p: vec3f, l: vec3f, far: f32, start: f32, shape: Shape, links: i32) -> f32 {
  /* 0 SKIPS THE MARCH ENTIRELY rather than multiplying its result by one — a branch the
     whole wavefront takes together, which is what makes the stage's cost measurable by
     alternating a parameter instead of by editing the shader ('polish' does the same). */
  if (params.shadowStrength < 0.001) { return 1.0; }
  let count = i32(clamp(params.shadowSteps, 4.0, 96.0));
  let k = max(params.shadowSoft, 0.5);
  let reach = min(far, max(params.shadowReach, 0.2));
  var shade = 1.0;
  var travelled = start;
  for (var i = 0; i < count; i = i + 1) {
    let d = deAt(p + l * travelled, shape, links);
    /* A hit: fully occluded, and the common case on a folded surface — most shadow rays
       terminate in a handful of steps, which is why the worst-case step count above is much
       larger than the typical one. */
    if (d < 1.0e-4) { return 1.0 - clamp(params.shadowStrength, 0.0, 1.0); }
    /* THE PENUMBRA, and it is free: the ratio of the ray's closest approach to how far it
       had travelled when it got there is exactly "how wide a light would have to be for this
       to be a partial shadow". Nothing is sampled for it that the march was not sampling. */
    shade = min(shade, k * d / travelled);
    if (shade < 0.003) { break; }
    travelled = travelled + d * params.stepScale;
    if (travelled > reach) { break; }
  }
  return mix(1.0, clamp(shade, 0.0, 1.0), clamp(params.shadowStrength, 0.0, 1.0));
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
fn emissionAt(trace: Trace, p: vec3f, widthScale: f32, nodeScale: f32, rate: f32, detail: f32) -> Emission {
  /* Which cells carry a live conduit, and how principal each one is. */
  let cell = floor(p * max(rate, 0.05));
  let pick = goldenPick3(cell, VEIN_PHASE);
  let density = clamp(1.0 - params.veinBreak, 0.05, 1.0);
  let alive = 1.0 - smoothstep(density - 0.14, density + 0.02, pick);
  /* 0 = this region's principal conduit, 1 = the least of the ones that made the cut. */
  let rank = clamp(pick / density, 0.0, 1.0);

  /* ⚑ THE BEAT, AND IT ARRIVES ONE MARK AT A TIME (T1318b).
     The owner asked for *"the brightness of SOME of the glow areas"*, and every audio lane
     this file had reached EVERY mark at once: 'veinEmission' was a global multiplier on the
     vein term, so a kick lifted the whole network together. Unison across every mark is the
     same global pump wearing a different coat, and it reads as the picture inflating rather
     than as anything happening IN it.
     ⚑ THE ENVELOPE IS READ TWICE — AS AN AMOUNT AND AS A POSITION — which is what buys the
     succession without any per-mark state. A kick's band envelope rises in a millisecond and
     decays over about four hundred, so '1 - flare' TRAVELS from 0 to 1 across the release;
     read as a position in the sequence below, it sweeps through the marks in order, and each
     one is lit only while the sweep is passing it. At rest 'flare' is its driven mean and the
     sweep parks; with the lane deleted it is zero and every mark is exactly its own base
     value again, so there is no term here that silence turns into a different picture.
     ⚑ AND THE PHASE IS A *SECOND PROJECTION* OF THE SAME LATTICE, NOT A SECOND OFFSET INTO
     THE FIRST. 'fract(pick + c)' looks like a new sequence and is a rigid rotation of the old
     one — perfectly correlated with it — so the marks would have fired strictly in order of
     RANK and only the principal conduits would ever have flared brightly. The same three R3
     generators assigned to different axes give an equidistributed sequence that is
     independent of the membership pick, for one more dot product and one more fract. */
  let markPhase = fract(dot(cell, vec3f(0.4301597090, 0.7548776662, 0.5698402910)) + FLARE_PHASE);
  let beat = clamp(params.flare, 0.0, 1.0);
  let sweep = 1.0 - beat;
  let turn = 1.0 - smoothstep(0.0, max(params.flareWidth, 0.02), abs(sweep - markPhase));
  let burst = 1.0 + max(params.flareDepth, 0.0) * beat * turn;

  /* ⚑⚑ THE POD READS ITS OWN CELL, NOT THE CONDUIT'S (T1324b) — THE OWNER'S CHECKERBOARD.
     Everything above is the VEIN lattice: cells 1/veinRate = 0.32 units across, which is the
     right granularity for a filament of width 'veinWidth' 0.1 and the WRONG one for a pod of
     width 2 * nodeRadius = 1.24. Gating a 1.24-unit object on a 0.32-unit lattice does not
     decide whether the pod is there, it multiplies the pod by an axis-aligned piecewise
     constant that steps 0.06 -> 1 (SIXTEEN TIMES) across planes crossing its own face, and
     'burst' put a second such lattice on top of it at rest. Measured inside the pod mask, on
     a detector validated first against a synthetic disc (0.00 %) and a synthetic disc times
     exactly this kind of lattice (13.55 %): interior step density 36.35 % of pod pixels
     against an A/A floor of 0.00.
     'trace.nodeCell' is the pod's OWN identity and is constant across it by construction, so
     the two decisions the lattice is for — is this pod lit, and when does it flare — survive
     intact and are now taken ONCE PER POD, which is what they always meant. */
  let nodePick = goldenPick3(trace.nodeCell, VEIN_PHASE);
  let nodeAlive = 1.0 - smoothstep(density - 0.14, density + 0.02, nodePick);
  /* ⚠ AND RANKING THE POD'S GAIN THE WAY THE CONDUITS ABOVE RANK THEIRS WAS TRIED, MEASURED
     AND REJECTED (T1324b) — THE ARM CONTRADICTED ITS OWN ARGUMENT. The reasoning was the
     file's own rule ('core' and 'bright' covary with 'rank' because an even spread of
     identical marks is a grid) plus a real observable: 16.0 % of pod pixels at t = 25 s have
     gone WHITE — every channel's MINIMUM above 225, so no hue left to carry — which is the
     second hue of a two-hue piece spent on a clipped disc. 'mix(1.0, 0.45, nodePick/density)'
     took that to 13.4 % and took the OTHER two sampled moments to 0.0 % and 0.2 % from 1.3 %
     and 2.0 %. ⚑ BUT THE POINT OF IT WAS VARIETY, AND MEASURED AS VARIETY IT WENT BACKWARDS:
     the per-pod brightness spread FELL, cv 0.350 / 0.449 / 0.387 to 0.330 / 0.424 / 0.342 —
     because the rank multiplier is correlated with the gate, so it dims the pods that were
     already dimmest and flattens the population it was meant to spread. It also cut the pod
     pixel count by 13 %, i.e. it spent the brightness the owner asked for twice. The pods
     already vary by a third of their own mean from distance and incidence alone. */
  let nodePhase = fract(dot(trace.nodeCell, vec3f(0.4301597090, 0.7548776662, 0.5698402910)) + FLARE_PHASE);
  let nodeTurn = 1.0 - smoothstep(0.0, max(params.flareWidth, 0.02), abs(sweep - nodePhase));
  let nodeBurst = 1.0 + max(params.flareDepth, 0.0) * beat * nodeTurn;
  /* The pool a flaring mark casts takes half the gain: a mark that brightens has to brighten
     the stone around it or it is a sprite again (§V972), but a spill driven as hard as the
     core is a wash driven as hard as the core, which is the defect §V977 measured. */
  let wash = mix(1.0, burst, 0.5);

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
  /* ⚑ THE NODE IS WIDENED AGAINST ITS *OWN* WIDTH, NOT THE VEIN'S. One 'lod' was computed as
     '1 + epsilon / veinWidth' and spent on both marks, and that ratio is the right multiplier
     for a mark of width 'veinWidth' and the wrong one for anything else — over-widening the
     nodes here (they are six times the veins' width) and under-widening them for any tuning
     where they are narrower. The widening is free either way; being free is not a reason to
     compute it once and use it twice. */
  let reach = max(params.nodeRadius, 0.01) * max(nodeScale, 0.05);
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
  /* ⚑ A POD IN A DEAD CELL IS A POD THE LATTICE SAID SHOULD NOT BE THERE, and the floor used
     to be 0.45 — so every cell the conduit break had switched OFF still carried nearly half a
     pod, and the marks appeared everywhere the orbit passed the origin rather than where the
     network is. Swept by distance, that measured 1584 separate magenta marks in one frame at
     the shipped radius, averaging 8 px: not salt (they resolve, and their count FALLS as the
     camera pulls back rather than exploding, which is what would have said under-resolved)
     but FRECKLES — the owner's word — because there were simply too many of them. The break
     is the lattice's own statement about where the light lives; the pods obey it now. */
  out.node = near2 * near2 * near2 * mix(0.06, 1.0, nodeAlive) * detail;
  out.nodeSpill = near * mix(0.06, 1.0, nodeAlive);

  /* THE FLARE APPLIES TO THE MARKS AND NOT TO THE FIELD.
     ⚑ AND THE TWO KINDS OF MARK NO LONGER FLARE ON THE SAME CLOCK (T1324b). They used to
     share 'markPhase', so a conduit run and a pod in the same conduit cell lit together and
     the flare read as a REGION rather than as one motif blinking — which was the intent, and
     which the cell size made a lie: the pods are four times the cell, so "the same cell" was
     never a pod, it was a SLICE of one, and the succession was arriving as a grid drawn
     across each pod's face. A pod now flares once, whole, on its own lattice site's phase.
     The region reading survives because both phases come from the same R3 generators on the
     same box-fold lattice, so neighbouring marks still land near each other in the sweep. */
  out.core = out.core * burst;
  out.node = out.node * nodeBurst;
  out.spill = out.spill * wash;
  out.nodeSpill = out.nodeSpill * mix(1.0, nodeBurst, 0.5);
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
 *
 * ⚑⚑ AND THIS IS WHERE THE MAGENTA FRECKLES CAME FROM (T1322b) — THE ONE MARCH IN THE FILE
 * THAT WAS NEVER GIVEN THE LEVEL OF DETAIL EVERY OTHER PATH HAS.
 *
 * The emission call below used to read 'emissionAt(trace, q, 1.0, 1.0, veinRate, 1.0)': width
 * scale 1, node scale 1, detail 1 — i.e. it asked the emission field for FULL, unwidened,
 * undimmed detail on THE ONE RAY IN THE FRAME LEAST ABLE TO RESOLVE IT. A reflected direction
 * is 'reflect(viewDir, n)' where 'n' is a FRACTAL normal, so adjacent pixels' reflected rays
 * DIVERGE and land on genuinely different structure; this march also stops on a threshold
 * three times coarser than the primary's and gets a third of its steps. A sixth-power pod
 * core sampled at full sharpness on a field like that lands-or-misses per pixel, which is
 * the exact mechanism the primary path's widening and distance fade exist to defeat, written
 * out at their own declarations, and never applied here.
 *
 * ⚑ MEASURED BY ISOLATION, NOT BY SWEEP (§V980): cutting 'polish' took the frame from 1519
 * magenta marks to 382 AND RAISED THEIR MEAN AREA FROM 7.4 px TO 17.2 — three quarters of the
 * marks gone and the survivors BIGGER, which is the signature of a small-mark population
 * being removed rather than of a general dimming. Cutting every VEIN term, by contrast, left
 * 1385 of the 1519 standing, which is what overturned §V988's reading.
 */
fn reflectionAt(
  p: vec3f, n: vec3f, viewDir: vec3f, shape: Shape, links: i32, hue: f32, podTint: vec3f,
  surfaceEpsilon: f32, surfaceDetail: f32,
) -> vec3f {
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
  /* ⚑ A SHORT CHAIN FOR THE EMISSION, WHICH IS WHERE THE FRECKLES LIVED. Not a cheaper
     approximation of the long one — a genuinely SMOOTHER FIELD THAT SHARES THE SAME
     STRUCTURE, which is what §V973 means by coarser and what the volume march already does.
     The primary march above still uses the FULL chain, because the reflection's SILHOUETTE is
     the half of it the eye actually checks. */
  let trace = chainAt(q, shape, min(links, i32(clamp(params.reflectLinks, 1.0, 24.0))));
  /* ⚑ THE REFLECTED HIT'S OWN FOOTPRINT, AND IT IS STRICTLY WIDER THAN THE SURFACE'S.
     Three terms, each one a real source of divergence rather than a fudge:
       - 'surfaceEpsilon' is what the primary march decided THIS pixel can resolve, and the
         reflected ray starts from that surface, so it inherits the whole of it;
       - 'travelled * 0.004' is this march's OWN termination slope — the distance at which it
         stops caring, which is by definition the finest detail it can claim to have found;
       - and the ray FANS as it goes, because the mirror is curved everywhere: two rays a
         pixel apart leave with different normals. That is bounded below by the primary's
         angular footprint over the reflected distance, which is what the ratio to the
         surface's own travel gives without needing the curvature itself.
     ⚠ WIDENED, NOT REMOVED — the same distinction the primary path draws. The reflected
     conduits and pods must still be there; a wet shell showing a small bright thing twice is
     most of what the reflection is FOR. They simply stop trying to resolve what the pixel
     cannot carry. */
  let refEpsilon = max(surfaceEpsilon, SURFACE * 3.0) + travelled * 0.004;
  let glow = emissionAt(
    trace, q,
    1.0 + refEpsilon / max(params.veinWidth, 1.0e-4),
    1.0 + refEpsilon / max(params.nodeRadius, 1.0e-4),
    params.veinRate,
    /* ⚑ AND THE SHARP POD CORE IS TURNED OFF HERE ('reflectSharp' 0), WHICH IS THE FRECKLE
       FIX. 'detail' is the mip fade 'emissionAt' applies to the pod's sixth-power core and to
       nothing else, so this removes the highest-frequency signal in the file from the one path
       whose hit is a per-pixel coin flip, and leaves the pod's smooth SPILL — which is the
       half a reflection can actually carry. 'surfaceDetail' still multiplies in, so at
       'reflectSharp' 1 (the isolation arm) the old behaviour is restored including the
       primary's own distance fade, which the call never had either. */
    surfaceDetail * clamp(params.reflectSharp, 0.0, 1.0),
  );
  let tint = rotateHue(params.veinColor.rgb, hue);
  let fade = 1.0 - smoothstep(0.0, reach, travelled);
  /* The nodes reflect too, and on a wet shell that is most of what a reflection is FOR: a
     small bright thing seen twice is what says the surface is polished. */
  let burn = tint * (glow.core * params.veinEmission + glow.spill * params.veinSpill)
    + podTint * (glow.node * params.nodeGlow + glow.nodeSpill * params.nodeSpill);
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
  /* ⚑ AN R2 OFFSET OVER THE PIXEL, NOT A HASH OF IT — AND THE HONEST VERSION OF WHY (T1322b).
     THE REASON THIS WAS OPENED: the line read 'unitFloat(hash2i(vec2i(pixel), HAZE_SEED))' and
     was indicted for producing a CHECKERBOARD in the magenta glow. 'hash2i' is
     'hashU32((x*73856093 ^ y*19349663) ^ seed)', both multipliers are ODD ∴ the low bit of
     each product is the low bit of its coordinate ∴ the low bit of the xor is x-xor-y PARITY.
     ⚑ THAT HALF IS EXACTLY TRUE — 262144 / 262144 pixels, 100.0 %. ⚑⚑ AND IT DOES NOT REACH
     THE PICTURE, WHICH IS THE HALF THAT MATTERED: the PCG finaliser destroys it. Mean jitter
     over even-parity pixels against odd reads 0.499409 / 0.499714, a gap of 0.000306 — AND
     THE SAME STATISTIC SPLIT ON A BIT PAIR THE HASH CANNOT KNOW ABOUT RETURNS 0.001476, i.e.
     THE EFFECT IS FIVE TIMES SMALLER THAN ITS OWN A/A FLOOR. The projection onto the
     checkerboard basis is 0.000153 against an rms of 0.289.
     ⚑ AND THERE IS NO CHECKERBOARD IN THE RENDERED FRAME EITHER. A three-mode Haar detector —
     HH against (LH+HL)/2, which has a KNOWN NULL OF 1.0 for isotropic noise and needed no
     threshold — was validated first (white noise 0.98, smooth gradient 0.95, stripes 0.00,
     a synthetic checkerboard 8e16, checker-plus-noise 3.40) and then read 0.10 to 0.44 on
     this frame: at cell sizes 1, 2, 4 and 8 px, at eight times across the run, at every shot
     state. 'haze 0' did not move it by 0.001. ⚠ SO IF THE OWNER IS SEEING A CHECKERBOARD IT
     IS NOT IN THIS IMAGE — it is in the display path (a non-integer canvas scale resampling
     fine static grain will manufacture one), and that is a browser question, not this one.
     ⛑ WHAT WAS REAL IN THE INDICTMENT IS THE OTHER HALF: the offset is INDEPENDENT PER PIXEL
     AND CARRIES NO TIME TERM ∴ twenty sparse samples leave quadrature error BURNED INTO THE
     IMAGE rather than averaging away. ⚠ AND THE REPLACEMENT DID NOT MEASURABLY FIX THAT
     EITHER, WHICH IS WHY THIS COMMENT SAYS SO. A/B'd on ONE build against a 240-sample
     reference: hash 4.25 %, R2 4.13 %, a constant half-stride 4.79 % — and THE REFERENCE
     DISAGREES WITH ITSELF BY 3.21 % when its own offset is changed, so 240 samples is not
     converged and all three arms sit inside the instrument's own noise. The speckle statistic
     agrees: 0.631 / 0.635 / 0.614 %. THREE ARMS INSIDE A FLOOR IS A RESULT, AND IT IS "NO
     DIFFERENCE" — not "the new one is better" (§V968: an instrument that cannot see the
     change reports that nothing caused it).
     ⚑ SO WHY IS R2 SHIPPED? For the two things it does buy that ARE certain, neither of them
     noise: it is CHEAPER (one dot and one fract against a PCG finaliser), and it retires the
     file's LAST hash along with the '// @use hash' include — which makes the parity property
     moot for free rather than arguing about it again in a fourth pass. ⚠ THE FIX FOR THE
     RESIDUAL GRAIN, IF IT IS EVER WANTED, IS MORE SAMPLES OR A TIME TERM, AND THE TIME TERM
     IS NOT FREE: this file's frozen-clock controls assert that frames at DIFFERENT absTime
     values are THE SAME PICTURE, and a per-frame jitter breaks them. A control traded for a
     dither is a bad trade.
     The two generators are the plastic constants 'goldenPick3' and the flare phase already
     use, one dimension down.

     ⚑⚑ AND R2 WAS THEN INDICTED A SECOND TIME, FOR THE OWNER'S *"what are these small coloured
     dots? are those light rays but just badly implemented?"*, ON A DERIVATION THAT IS TRUE
     AND STILL DOES NOT REACH THE PICTURE (T1327b). The algebra of the indictment is sound:
     R2's constants are low-discrepancy over a SEQUENCE INDEX, so 'fract(a1 x + a2 y)' read as
     a SCALAR over a 2-D integer grid is a plane wave whose near-rational approximations put
     near-identical offsets 4 to 7 px apart. ⚑ MEASURED IN THE FRAME, IT IS NOT THERE. An
     autocorrelation detector over the void, validated first against a SYNTHETIC DOT FIELD
     PLACED ON THIS EXACT R2 LATTICE (peak 0.411 at lag (11,10)) and against a random field at
     the same density (0.011), reads NO peak at any R2 lag on the real frame: the shipped
     frame's largest lags are (2,1) and (2,0) at 0.128, which is blob-neighbour correlation
     and nothing else. ⚑ AND THE TWO REPLACEMENT ARMS SAY THE SAME: a real 2-D integer hash
     gives 0.026 % lit void against the shipped 0.027 %, and a CONSTANT half-stride — no
     per-pixel jitter at all — gives 0.037 %. THE DOTS DO NOT COME FROM THE JITTER.
     ⚑ WHAT THEY ARE, BY ARMS: they are the volume's own marks. 'haze' 0 removes them (0.17 %
     of the void lit falls to 0.01 %); cutting the pod terms in the air halves them and
     cutting the vein terms halves them; and they are NOT quadrature error — TWELVE TIMES the
     samples ('hazeSteps' 20 -> 240) leaves the mean void luma at 0.0050, unmoved. They are
     converged, sub-pixel, and irreducible by sampling. ⚠ AND WIDENING THEM TO THE PIXEL, THE
     REPAIR THIS FILE USES EVERYWHERE ELSE, MAKES THEM WORSE: 177 blobs -> 270 and peak 184 ->
     216, because a wider mark is a mark more rays catch.
     ⚑ WHAT MOVED THEM IS 'hazeFalloff' — THE VOLUME'S REACH — AND THE REASON THAT IS THE
     RIGHT LEVER IS THAT THE VOLUME BUYS ALMOST NOTHING AT RANGE. Measured at the same frame:
     the WHOLE volume stage lifts the subject's mean luma by 0.213, and 2.1 -> 1.1 keeps 0.064
     of that while taking the void's dot count 177 -> 42 and its peak 184 -> 151. See
     'hazeFalloff' in the document for the trade written out. */
  let jitter = fract(pixel.x * 0.7548776662 + pixel.y * 0.5698402910 + VEIN_PHASE);
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
    let em = emissionAt(coarse, q, params.hazeWidth, params.hazeWidth, rate, 1.0);
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
  /* ⚑⚑ A BOUNDED SWING, NOT A LAP — AND THIS IS THE GUARD ON THE TRANSFORM RATHER THAN A
     THIRD ANNOTATION ON A SITE (T1322b). This file has now been bitten THREE TIMES by a hue
     rotation walking a colour somewhere it should not go: 'fillTint' went magenta and was
     neutralised (§V980), 'rimColor' carries a standing exemption saying an orange rotated
     about the luminance axis becomes magenta, and the vein tint was the third.
     ⚑ THE DEFECT IS THE UNBOUNDED LAP, AND IT IS STRUCTURAL RATHER THAN A BAD VALUE. These
     read 't / hueTurn', which GROWS WITHOUT BOUND, so the rotation visits EVERY HUE ON THE
     WHEEL — including, necessarily, whatever hue another object in the frame owns. The
     frame's whole colour design is teal veins against magenta pods lit by a cold key, and a
     rotation that eventually reaches magenta destroys that design for part of every lap, by
     construction, however the base colour is tuned. MEASURED: at t = 20 s the lap has carried
     the veins 0.27 of a turn, into the key's own blue, and the render shows a blue object
     with the conduits invisible against it — the two-temperature frame collapsed to one.
     ⚑ SO THE TRAVEL IS NOW A SINE, AND 'hueArc' IS ITS CEILING. A sine is bounded for all t,
     so no value of the clock can take a colour more than 'hueArc' from where its author put
     it, and the guard is a property of the ARITHMETIC rather than a note asking the next
     person to be careful. The two hues still travel in OPPOSITION and still separate and
     re-converge over the lap — which was the whole point of having them — they simply do it
     inside their own families. */
  /* ⚑⚑ THE PALETTE TRAVELS AS A WHOLE (T1324b), AND THAT IS WHY IT IS ALLOWED TO BE
     UNBOUNDED WHERE THE SWING ABOVE IS NOT. Every tint below takes the SAME 'paletteHue', so
     the transform applied to the palette is one rotation of the RGB cube about its grey
     diagonal: an isometry. It moves every colour and changes no angle between any two, which
     is precisely the property §V996 is protecting — that invariant names RELATIVE drift as
     the defect, and a rigid rotation has none by construction. See 'paletteTurn'. */
  let paletteHue = sin((t / max(params.paletteTurn, 1.0)) * TAU) * clamp(params.paletteArc, 0.0, 0.5);
  let swing = sin(hue * TAU) * clamp(params.hueArc, 0.0, 0.5);
  let veinHue = swing + paletteHue;
  let keyHue = -swing + paletteHue;
  /* THE POD'S OWN SHADE, AND IT IS THE ONLY THING IN THE FILE THAT MOVES RELATIVE TO THE
     REST — so it is the only one §V996's pair enumeration has to bound. See 'beatShade'. */
  let podHue = paletteHue + clamp(params.beatShade, 0.0, 0.08) * clamp(params.flare, 0.0, 1.0);
  let podTint = rotateHue(params.nodeColor.rgb, podHue);

  /* THE CAMERA: parked, orbiting slowly, and reading NO audio. The orbit is the stable
     reference the morph is legible against — and freezing it is what lets a claim measure
     the shape's own evolution rather than the camera's (§V965). The ANGLES the owner asked
     for are delivered by the object's own pose, below, for exactly that reason. */
  /* ⚑ THE WHOLE RIG READS 'shot.held' AND NOT 't'. That is the shot lane: camera time is
     real time with the top of an approach removed, so the orbit, the second axis and the aim
     all come to a stop together while the camera is close and resume together as it pulls
     out. A close-up is then a HELD LOOK at magnified structure rather than a whip-pan across
     it, which is the owner's *"we actually can appreciate the fractality of some parts there
     without them moving out of view and constantly slipping around"*. The SHAPE clocks below
     are deliberately not held — they are slow enough now to be looked at, and a piece whose
     every clock stops for six seconds is a piece that has stopped. */
  let shot = shotAt(t);
  let tc = shot.held;
  let lap = (tc / max(params.orbitPeriod, 1.0)) * TAU * params.orbitSpeed;
  let rise = sin((tc / max(params.orbitPeriod, 1.0)) * TAU * 0.37 * params.orbitSpeed) * params.orbitRise;
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
  let poseLap = (tc / max(params.posePeriod, 1.0)) * TAU;
  let nod = sin((tc / max(params.posePeriod, 1.0)) * TAU * 0.41) * params.poseTilt;
  /* World -> object. 'transpose' of a rotation is its inverse, exactly. */
  let toObject = transpose(rotY(poseLap) * rotX(nod));

  /* THE PUSH: the object swims toward the frame and back. CUBED, so it is near zero for most
     of its period and rises to a peak briefly — "occasionally", the owner's word for the
     negative space, and the same reason applies to a dolly. A push that never rests is a
     ride, and a VJ patch wants a framed object. */
  /* THE APPROACH ITSELF READS REAL TIME, and it must: it is the clock the hold is derived
     FROM, so holding it against its own integral would be circular and the camera would
     never come back out. */
  let push = shot.close;
  /* ⚑ AND NOTHING FAST RIDES THIS AXIS ANY MORE (T1322b). A kick-driven dolly sat here for one
     pass and the owner called it *"vomit inducing"* on sight. The term is gone rather than
     reduced, and because it was read CENTRED on the kick envelope's own mean the removal is
     bit-for-bit invisible in the no-track picture — the same dividend the deleted 'openness'
     lane paid, and the second time in two passes that centring a lane on its neutral value is
     what let it be deleted without a retune. */
  let closeness = mix(1.0, max(params.poseNear, 0.2), push);

  /* THE AIM: where the camera looks WHEN it is close. The interesting part of a fractal is
     never the middle, and a compact sculpture framed on its centroid is the same portrait
     forever. It rides the push, so the frame only leaves the centre while there is something
     near enough to be worth framing. */
  let aimLap = (tc / max(params.aimPeriod, 1.0)) * TAU;
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

  /* ⚑ THE POD'S OWN SHADING, CARRIED OUT TO THE SHOULDER (T1326b). The grade's ceiling is
     the last thing that happens to a pixel, and a pod whose peak clears the knee arrives
     there at the ceiling WHATEVER its emission was — so a shading term applied upstream is
     erased on exactly the pods that look flattest. This carries the ball's own response to
     the one place the ceiling cannot erase it: the ceiling. 1 everywhere else. */
  var ceilScale = 1.0;
  var colour = params.backdrop.rgb;
  if (hit) {
    let p = eye + dir * travelled;
    /* ⚑ THE NORMAL IS SAMPLED WIDER THAN THE MARCH STOPPED, AND THAT IS THIS FILE'S DISTANCE
       LEVEL OF DETAIL (T1328b). The owner: *"very very noisy due to all these surfaces at
       anything but close up distance"* — a DISTANCE-dependent complaint, so it is aliasing,
       and the fizz was isolated to this one line: at orbitRadius 22, widening the normal's
       own central differences took the pixel-scale grain 0.1462 -> 0.0950 while EVERY other
       term in the frame moved it by less than a hundredth (occlusion 0, specular 0,
       translucency 0, haze 0 and ALL FIVE EMISSION TERMS CUT all read 0.146 - 0.148).
       'epsilon' already scales with the pixel's footprint, so one constant multiplier is a
       LOD by construction: at orbitRadius 12 the same arm moves the grain 0.0739 -> 0.0733,
       i.e. it costs the close-ups nothing, which is the half the owner says is already right.
       See 'normalWiden' for the arms this replaced and the one it refuted. */
    let n = normalAt(p, shape, links, epsilon * max(params.normalWiden, 1.0));
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
    let nodeLod = 1.0 + epsilon / max(params.nodeRadius, 1.0e-4);
    let glow = emissionAt(trace, p, lod, nodeLod, params.veinRate, detail);
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
    /* ⚑ ROTATED BY THE COMMON-MODE TURN ONLY (T1324b). 'fillColor' is very nearly neutral
       precisely because §V980 measured it walking into magenta when it had a hue to walk,
       and a rotation of a near-grey is very nearly the identity — so this joins the
       palette's rigid turn without re-opening that defect, and the isolation arm for it is
       'paletteTurn' 1e9 rather than a second exemption. */
    let fillTint = rotateHue(params.fillColor.rgb, paletteHue);
    let veinTint = rotateHue(params.veinColor.rgb, veinHue);
    /* The warm rim still does not travel ON ITS OWN — the standing exemption at its
       declaration is about a rotation RELATIVE to the rest of the frame, and the palette's
       common-mode turn is not one. Left OUT of the turn and it would be the only colour
       standing still, which is per-element drift with the sign flipped. */
    let rimTint = rotateHue(params.rimColor.rgb, paletteHue);

    /* ⚑ THE KEY CASTS, AND IT IS THE ONLY ONE THAT DOES (T1318b).
       The march starts four pixel-footprints off the surface rather than at a constant
       offset: 'epsilon' is what the primary march already decided this pixel can resolve, so
       a fixed start would be acne on the near half of the object and a floating shadow on
       the far half. It is the same quantity, used the same way, as the mark-widening below.
       Fill and rim stay unshadowed on purpose — that is what makes them AMBIENT WRAP, and it
       is the division that lets one shadow march buy the whole cue. */
    let toKey = lightPosition(0.0, t) - p;
    let keyDist = length(toKey);
    let shadow = shadowAt(
      p, toKey / max(keyDist, 1.0e-4), keyDist, max(epsilon * 4.0, SURFACE * 4.0), shape, links,
    );

    /* THREE COLOURED SOURCES, each with reach, and a hierarchy that hands over. The rim
       does not morph, for the reason given at its declaration. */
    var lit = lightAt(p, n, view, 0.0, t, keyTint, params.keyIntensity, specPower) * shadow;
    lit = lit + lightAt(p, n, view, 1.0, t, fillTint, params.fillIntensity, specPower);
    lit = lit + lightAt(p, n, view, 2.0, t, rimTint, params.rimIntensity, specPower);

    /* ⚑ THE VEINS ARE A LIGHT, NOT A DECAL. The spill term lights the shell around a
       conduit, so the emission is a source in the scene rather than a bright texture on it —
       and because the spill reads a wider window on the same trap, it lands exactly where
       the creases the AO darkens are, which is what makes it POOL. */
    /* ⚑ AND THE PODS LIGHT THE STONE, WHICH IS THE OWNER'S *"they also need to ACTUALLY
       EMIT LIGHT"* taken literally rather than as a brightness request. Both terms are
       lights on the shell here, not marks on it: a vein pools in the creases around it and a
       pod throws its hue onto the stone it sits in. Without this the pods were sprites —
       bright where they covered a pixel and changing nothing anywhere else. */
    /* ⚑⚑ THE POD IS A BALL AND ITS OWN SHADING HAS TO SURVIVE ITS OWN LIGHT (T1326b, §V1001).
       THE STRUCTURAL FACT SIX PASSES DID NOT HAVE: the pod's visible surface is a LEVEL SET
       OF THE VERY QUANTITY THE MARK IS BUILT ON. 'trace.node' is the orbit's closest
       approach to the origin, the sphere fold's inner inversion makes the pod a ball of one
       radius, and every visible pixel of that ball therefore reads the SAME trap value. ∴ NO
       FUNCTION OF 'trace.node' CAN EVER VARY ACROSS A POD — which is why the falloff window's
       shape (0 -> 300 moved three luma), the pod's gain (5.5/7.5 -> 1.2/1.3 scales the
       profile, plateau unmoved) and the volume were all measured no-ops, and why six passes
       on the MARK could not reach it. Rendered on its own, 'glow.node' is a flat-topped disc
       with a hard edge: that IS the sticker.
       ⚑ SO THE SHADING COMES FROM THE ONE QUANTITY THAT DOES VARY ACROSS A POD, MEASURED PER
       POD RATHER THAN OVER THE MASK (§V1002). Rank span within each pod, median over 17 pods:
       the shell's own three-light luminance 1.113, the key cosine 0.739, the view cosine
       0.447, the shadow 0.156, the ambient occlusion 0.030. The lit shell wins, and it wins
       because it is the same quantity the §V1001 arm exposes — cut both pod terms and what is
       left is a SMOOTH SHADED BALL, per-pod span 1.206 against the shipped 0.154.
       ⚑ AND IT IS APPLIED IN TWO PLACES BECAUSE ONE IS NOT ENOUGH, WHICH IS ALSO MEASURED.
       Modulating the EMISSION alone is T1325b's refuted arm (e) for the bright pods — the
       shoulder erases it — and modulating the CEILING alone reaches only the pods whose peak
       clears the knee, which is 7 of 17 (a flat ceiling scale of 0.25 left ten pods' median
       luma unchanged to the byte). Together: per-pod span 0.154 -> 0.695 and the correlation
       with the ball's own shading 0.513 -> 0.888, against the ball's own 1.206. See 'ceilScale' below for the other half.
       ⚠ IT IS A COMMON SCALE ON ALL THREE CHANNELS, NOT A ROTATION (§V999), so the palette's
       measured arcs are untouched by it. */
    let podBall = mix(
      clamp(params.podShade, 0.0, 1.0), 1.0,
      clamp(dot(lit, vec3f(0.2126, 0.7152, 0.0722)) / max(params.podShadeLevel, 1.0e-3), 0.0, 1.0),
    );
    let bleed = (veinTint * glow.spill * params.veinSpill
      + podTint * glow.nodeSpill * params.nodeSpill * podBall)
      * mix(1.0, occ, params.translucency);

    /* The grazing rim. On an all-curved silhouette this is where the environment shows —
       §V640 measured 10.2x on curvature against 1.11x on a flat face, and a fractal has no
       flat faces at all, which is what makes this term worth more here than on a slab. */
    let fresnel = pow(1.0 - max(dot(n, view), 0.0), 4.0) * params.fresnelGain;
    let rim = skyAt(reflect(dir, n)) * fresnel;

    var reflected = vec3f(0.0);
    if (params.polish > 0.001) {
      /* ⚑ 'epsilon' AND 'detail' GO IN (T1322b): the reflection's marks are widened and faded
         against the primary's own footprint. Passing 1.0 for both is what made three quarters
         of the frame's magenta freckles. */
      reflected = reflectionAt(p, n, dir, shape, links, veinHue, podTint, epsilon, detail)
        * params.polish * mix(0.15, 1.0, fresnel);
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
    let nodes = podTint * glow.node * params.nodeGlow * podBall;
    /* How much of this pixel IS a pod. Read off the SPILL as well as the core: the core is
       faded with view distance by 'nodeFade', so the far pods are carried almost entirely by
       their pool and a gate on the core alone misses them (measured: ten of seventeen). */
    ceilScale = mix(1.0, podBall, smoothstep(0.05, 0.45, glow.nodeSpill + glow.node));
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
      eye, dir, far, uv * frameU.resolution, shape, veinHue, podTint,
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

  /* ⚑ THE HUE-PRESERVING SHOULDER, AND IT IS THE LAST THING THAT HAPPENS HERE ON PURPOSE
     (T1325b). Everything above hands the sink an UNBOUNDED value — the grade is a luminance
     ratio with no top — and the sink runs the Narkowicz filmic curve PER CHANNEL. A
     per-channel curve is a saturation destroyer at the top end and nowhere else: each
     channel approaches 1 independently, so a pixel of (6, 2, 5) arrives as (254, 246, 253)
     and a magenta pod is a WHITE STICKER. Measured on the pods at 25 s: 16.0% of them.

     ⚑ WHICH END OF §V977's AXIS THIS IS, MEASURED RATHER THAN ASSUMED. That row established
     that a MISSING top end is a content defect; this is the same axis inverted, and the same
     discriminator settles it. The over-range is not a slab: the subject's max channel reads
     p50 0.116 against p99 1.907, and only 1.53% of it is above 1 at all while 43.98% of the
     pod is. p99 moves, p50 does not ∴ IT IS A HIGHLIGHT, and the content is right — the
     piece HAS the small bright things §V977 asked for. What was missing is a way to SHOW
     them. The exposure arm is in the file as the refuted one: a flat gain has to fall to a
     QUARTER before the pods stop being white, and it takes the subject's p50 from 74.9 to
     22.5 with it. That is the whole piece, paid to fix eight pods.

     THE OPERATOR: roll the MAXIMUM CHANNEL onto a ceiling and scale all three by the same
     factor. Scaling all three is what preserves the hue exactly — a per-channel curve cannot,
     which is the defect this exists to answer. The shoulder is C1 at the knee ('rolled' and
     its slope are both continuous there), and it approaches the ceiling as 1/m rather than
     exponentially, so no two distinct brightnesses ever land on the same output.

     ⚠ AND THE SHAPE OF THE APPROACH IS NOT WHERE THE WIN IS — that was this pass's own wrong
     prediction, refuted by the sweep. At a matched ceiling the exponential and the hyperbolic
     forms measure within a few points of each other on every statistic (core flatness 4% vs
     7% at 1.3, 47% vs 57% at 2.2). THE CEILING IS THE LEVER. The hyperbolic form is kept for
     the monotonicity, not because it bought the result. */
  /* ⚑ AND THE KNEE AND THE CEILING BOTH RIDE 'ceilScale' (T1326b). Scaling the pair rather
     than the ceiling alone keeps the curve's SHAPE and moves only where it sits, so a pod's
     dark side is the same tone curve at a lower exposure rather than a different one; and
     because the operator's output is 'saturated * rolled / peak', a scale on the pair is a
     COMMON scale on all three channels, which is what keeps the hue exactly (§V999). */
  let peak = max(max(saturated.r, saturated.g), saturated.b);
  let knee = max(params.highlightKnee, 1.0e-3) * ceilScale;
  let head = max(params.highlightCeiling * ceilScale - knee, 1.0e-3);
  let rolled = knee + head * (1.0 - 1.0 / (1.0 + (peak - knee) / head));
  return vec4f(saturated * select(1.0, rolled / max(peak, 1.0e-5), peak > knee), 1.0);
}
`;
