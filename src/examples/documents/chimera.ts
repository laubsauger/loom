import { settings, node, edge, graph, document, expressionSlot } from "./builders.ts";
import { CHIMERA_WGSL } from "../shaders/chimera.wgsl.ts";
import { FXAA_WGSL } from "../shaders/fxaa.wgsl.ts";

/** §V966's idiom: continuous properties read the RANK; TRANSIENTS read the band ENVELOPES. */
const LEVELS = (key: string): string => `op('lvl1').chan.${key}`;
const HITS = (key: string): string => `op('hit1').chan.${key}`;

/**
 * E70 — CHIMERA (T1310b). A distance-estimated fold chain that travels through three
 * characters, as a music visualiser.
 *
 * The brief: *"high fidelity 3d fractal like stuff that is evolving, changing segmentation
 * and shape, meant as a music visualizer… hits of bioluminescence, organics with
 * reflections, multiple colored lights in scene, high fidelity lighting… an 8k unreal engine
 * art installation… a really cool VJ patch"* — then, having been shown three separate
 * directions: *"maybe we can combine things and have reef, skeleton and bulb kind a unified
 * into one interesting thing… the most critical part is to have something interesting and
 * not just very flat and boring after 15 seconds."*
 *
 *   sky1(solid) ─► shape1(customWgsl: the fold chain) ─► fxaa1(customWgsl) ─► out1(output)
 *
 *   music1(audioPattern) ─┐
 *                          source1(valueSwitch) ─► analysis1(audioAnalysis) ─┬─► lvl1
 *   track1(audioFileIn) ──┘                                                  └─► hit1
 *
 * ## "Not boring after fifteen seconds" is the acceptance criterion, and it is structural
 *
 * Six things move, on SIX MUTUALLY PRIME PERIODS — 19 / 37 / 47 / 53 / 73 / 113 seconds —
 * so the combined state's repeat is their product and no two moments a viewer compares have
 * the same subset of them moved. They are the shader's, not this file's, and they run on
 * `frameU.absTime`: the piece is fully alive with no track at all, which is what §V914
 * requires of it, because every thumbnail and every headless render has no audio.
 *
 * ⚑ SO NOTHING BELOW DRIVES THE SHAPE'S IDENTITY OR ANY OF ITS CLOCKS. The audio rides
 * AMPLITUDE — how hard the veins burn, how much medium hangs in the air, how wide the spill
 * spreads — and the object would be doing all of this anyway in silence. That is E55's
 * finding (T1138) applied deliberately: liveliness has to be structural, because an audio
 * lane is an envelope and an envelope can settle.
 *
 * ## Transients ride ENVELOPES, not counts (§V966)
 *
 * E68 shipped its hit lanes on `kickCount`, and §V966 was written afterwards: a count is 1
 * for exactly one frame, so anything it drives STEPS in one frame and is a blink by
 * construction — gain and decay shape only the release, never the attack. E57 measured the
 * band envelopes at a 4.2x smaller worst single-frame step, *and they still land*. §V966's
 * own corollary says E68 only gets away with counts because its lanes move a small share of
 * the pixels; here the emission moves the whole frame, which is the E57 case.
 *
 * So every transient lane below reads `kick` / `snare` / `hat` through the HITS bag — the
 * same events, carrying the transient's own rise and fall.
 *
 * ## The tempo lane, and why it rests at exactly 1 (T1309b)
 *
 * E68 is tuned at 112 BPM: every duration in it is an absolute number, so it reads slack at
 * 80 and frantic at 160, and that is the deepest complaint on the sibling row. Here the
 * MORPH clock — the one a viewer reads as "it is moving with the music" — is multiplied by
 * `tempoScale`, expressed so that it is EXACTLY 1 whenever there is no tempo claim to make:
 *
 *     1 + bpmConfidence * (bpm - 112) / 112
 *
 * With no audio, or a live source that estimates nothing, `bpmConfidence` is 0 and the term
 * vanishes. On the shipped pattern the confidence is 1 and the bpm IS 112, so it is 1 by
 * arithmetic rather than by luck — the shipped picture and the rest state are the same
 * picture, and a 140 BPM track moves the morph 25% faster without retuning anything.
 *
 * ⚑ It is read from `source1` rather than from `lvl1`, and that is load-bearing: the levels
 * bag RANKS everything to 0..1 over a sliding window, so a bpm through it would read 0.5
 * forever (§T1302b's clamping-tap lesson, one lane over).
 *
 * ## What the resolution is, and why it is stated
 *
 * 1280x720, set EXPLICITLY on the document rather than inherited from a default, so the
 * piece and its claims agree about what it was designed for — E68's precedent. The owner
 * ruled out taking "8K" literally: it is a look, not a pixel count, and it is bought here by
 * FXAA, the ambient occlusion, the light falloff and the grade rather than by more pixels.
 */
export const chimeraDocument = document(
  "chimera",
  "E70 Chimera",
  settings({ randomSeed: 70, outputResolution: { width: 1280, height: 720 } }),
  graph(
    [
      /* The marcher writes every pixel, so its input is a formality — but a `customWgsl`
         node takes one, and a black solid is the honest "nothing comes in here". */
      node("sky", "solid", [-600, 0], { color: [0, 0, 0, 1] }, { label: "sky1" }),

      /* §V920/§T1184: every reflected value is STORED rather than inherited from the
         shader's own `// @default` lines. A declared default is a fallback for a node
         somebody just placed; a shipped example that leans on one moves the day the shader
         is retuned, and nothing would say so. */
      node("shape", "customWgsl", [-300, 0], {
        source: CHIMERA_WGSL,

        /* ─── THE CHAIN ───────────────────────────────────────────────────────────────
         * One chain, three characters, and they COMPOSE rather than blend: a box fold
         * (skeleton), a sphere fold (reef) and a power map (bulb), each with a neutral
         * setting that is EXACT. That is what lets the piece be all three without ever
         * cross-fading two distance estimators, which does not work and was ruled out in
         * the shape document before a line of this was written. */
        iterations: 11,
        scale: -2.1,
        scaleTravel: 0.22,
        /* ⚑ 1.05 -> 1.45, AND THIS IS THE CUBE. The owner said *"the thing looking less
           like a cube all day with warts"* after TWO passes of material work, which is what
           says it was never material. A box fold is 'clamp(p, -limit, limit) * 2 - p', which
           reflects the domain about the faces of a CUBE — so a body shaped mostly by it has a
           cubic silhouette by construction, and surface detail on a cubic body is exactly
           warts on a cube.
           ⚑ AND THE PARAMETER THAT *LOOKED* RESPONSIBLE WAS NOT (§V980). The bulb floor was
           swept 1 -> 2.4 -> 3.4 and the silhouette statistics did not move: fill 0.64/0.61/0.66,
           convolution 2.5/3.9/2.6, no trend. The same statistic on THIS term moves
           2.44 -> 6.19 -> 19.78 across foldLimit 1.05 / 1.6 / 2.6. The instrument was never
           blind; the bulb genuinely does not reach the outline, and no value of it could have.
           1.45 is where the body is branching and holed rather than a block, and still a
           BODY — at 6 the fold is the identity and the set collapses to a 7%-fill dust. */
        foldLimit: 1.45,
        /* How far the box fold's limit breathes on the scale clock — the creases opening and
           closing. STATIC since T1318b at the value its audio lane retained: the body of the
           mix no longer moves it, because it moves the FORM. */
        foldTravel: 0.18,
        minRadius: 0.47,
        /* ⚑⚑ 1.45, AND IT WAS 1 — WHICH PUT THE WHOLE SPACING LANE IN A DEAD ZONE (T1324b).
           The owner: *"LESS IS MORE… we still need to EMBRACE NEGATIVE SPACE a little bit
           better"*, and that is a claim a connectivity test can settle. Enclosed background
           regions inside the silhouette, on a counter validated first against a synthetic
           disc with 0 / 1 / 5 punched holes (it returned 0 / 1 / 5): the body measured
           0.02–2.09% of its own interior across a minute, against 8.87% for that five-hole
           disc. It is a solid knobbly mass, exactly as described.
           ⚑ AND THE OPERATOR THAT FIXES IT IS THE ONE THE FILE ALREADY HAS, PARKED WHERE IT
           DOES NOTHING. Sweeping every candidate with all clocks frozen (foldLimit, minRadius,
           scale, bulbPower, iterations, this): `minRadius` moves the hole statistic NOT AT ALL
           (0.30 / 0.62 / 0.80 are bit-identical — the orbit's radius essentially never goes
           below it, so the inner branch of the sphere fold does not fire and BOTH the "reef
           character" and `voidTravel`'s lane are no-ops), `foldLimit` moves coverage 13% -> 34%
           with holes flat at 1, and this one moves holes 4 -> 12 -> 31 -> 43 and holeShare
           0.74% -> 1.06% -> 4.08% -> 16.92% across effective 1.11 / 1.41 / 1.56 / 1.91.
           ⚠ AND IT HAS A THRESHOLD, WHICH IS WHY THE LANE READ AS WORKING WHILE BUYING NO
           FORM: below an effective ~1.25 the shape statistics do not move at all (0.60 and
           1.20 are identical to 1.00 on coverage, holes and convolution) even though the
           PIXELS do (RMS 6.93 and 8.88 against 0.00 for the A/A control). The lane was moving
           the surface and not the body, and only a statistic that can see the SILHOUETTE
           could tell those apart. It ships centred where the holes are real. */
        fixedRadius: 1.45,
        /* ─── ⚑ THE SPACING LANE: THE GAPS BETWEEN THE NODULES, OPENING AND CLOSING ──────
         * The owner has asked for this THREE TIMES and until now it did not exist:
         * *"the shape is still kinda boring in terms of stuff actually moving away from
         * stuff or changing from cube to sphere to pyramid or rhombus or whatever the name
         * is, opening and closing distances between nodules"*. T1318b answered it by
         * shortening `voidPeriod` 239 -> 107, and that was the wrong lane: the void clock
         * moves `minRadius`, which HOLLOWS OUT the shells. "Stuff moving away from stuff" is
         * the gaps BETWEEN structures, which is the sphere fold's OUTER radius.
         * ⚑ AND IT IS EXACT RATHER THAN CARVED. The fold multiplies the point by
         * `fixedRadius² / r²` and multiplies the derivative by the same factor, so this is a
         * pure scaling: every structure moves away from every other one and the distance
         * estimate stays exactly an estimate. A gap cut with a min/max against the chain
         * would cost the file its step scale and make every cost number in it dishonest. */
        /* ⚑ THE TRAVEL NARROWS BECAUSE THE LANE IS NOW *STEEP*. At the old base the operator
           was flat, so 0.24 of travel bought nothing; centred at 1.45 the same 0.24 would run
           from a nearly-solid body to the 3% dust at the top of the range. 0.10 keeps the slow
           clock inside the region where every value is a form worth looking at. */
        spacingTravel: 0.1,
        spacingPeriod: 103,
        /* Exactly 1 = the identity, and the term is SKIPPED at that value rather than
           computed and multiplied by nothing. The travel to `bulbPeak` is what walks the
           object from reef/skeleton into bulb and back. */
        /* ⚑ 2.4, AND IT WAS 1 — WHICH IS THE IDENTITY, SO THE BULB WAS OFF AT REST.
           The character clock dwells at both ends of its travel, so at a floor of 1 the piece
           spent most of any viewing with NO power map running at all, and the only shaping
           operator left was the box fold. A box fold reflects the domain about the faces of a
           CUBE, so the owner's *"the thing looking less like a cube all day with warts"* —
           said after two passes of material work, and said twice — was a correct reading of
           the dominant operator from the SILHOUETTE. Detail cannot answer it: detail on a
           cubic body is warts on a cube. Floored, the body is permanently lobed and the
           character clock varies an organic shape instead of switching organicity on. */
        bulbPower: 2.4,
        bulbPeak: 4.2,
        /* The object's identity, and the strongest evolution axis in the file: drifting the
           seed offset merges lobes and opens shells CONTINUOUSLY. Nothing audio-driven
           reaches it — if the music decided what the object IS, silence would be a
           different object, and silence is what every thumbnail renders. */
        seedOffset: [0, 0, 0, 0],
        seedDrift: 0.26,
        /* ⚑ `openSpread` AND `openVoid` ARE GONE (T1318b) — the one audio lane that reached
           the shape, cut by the owner by name after they watched it: *"it's still pumping,
           like pulsing instead of us doing it by camera, which then prevents us that we
           can't have close-ups and flyovers that make sense without being noisy."* Deleting
           it is byte-identical at rest, because the lane was centred on its own neutral
           value and contributed exactly zero with no audio. */
        /* THE SEGMENTATION KNOB. Three different rates, so the fold planes precess instead
           of turning as a rigid set — a single axis reads as the object spinning, which is
           the one thing the owner explicitly did not ask for. */
        foldSpin: [0.31, 0.47, 0.23, 0],
        /* ⚑ 2.5 -> 3.0 (T1324b), AND THE ARGUMENT AGAINST RAISING IT — written below and
           correct at the time — HAS AN EXPIRY DATE ON IT: it says `detail` buys quiet by
           RESOLVING LESS STRUCTURE. The owner has since asked for exactly that (*"LESS IS
           MORE… embrace negative space"*), so the cost and the goal now point the same way.
           ⚠ BUT ONLY JUST, AND THE LIMIT WAS MEASURED: at the new density `detail` 4 fills
           the very holes this pass exists to open — holes 31 -> 18, holeShare 5.52% -> 1.38%
           — because a coarser termination threshold stops rays in the thin places and paints
           the gaps solid. 3.0 WITH `stepScale` 0.36 keeps them (34 holes, 6.62%) and reads
           0.943% speckle against 1.035% for the pair it replaces. A quality knob that buys
           the noise number by spending the thing the row is about is not a quality knob. */
        detail: 3,
        /* ⚑ 0.78 -> 0.5, AND IT IS THE SPECKLE FIX (T1322b) — THE ONLY TERM IN THE FILE THAT
           MOVED IT. The owner's *"speckled with noisy stuff… a freckly noisy mess"* has now
           survived three passes of MATERIAL work, and this pass measured why: it is not a
           material defect at all. A speckle statistic that is a threshold on a pixel against
           its OWN 3x3 MEDIAN (so it cannot be fooled by the object getting smaller or
           brighter) reads 0.899 % of lit pixels on the shipped build, and EVERY SHADING TERM
           IS A NO-OP ON IT against a 0.000 A/A floor: `specular` 0 -> 0.893, `polish` 0 ->
           0.948, pods cut -> 0.740, veins cut -> 0.836, `shellGlow` 0 -> 0.882, `haze` 0 ->
           0.891, `fresnelGain` 0 -> 0.803. The two terms that DO move it are the march's own:
           `detail` (0.25 -> 2.237, 4 -> 0.365) and this. ⚑ SO THE SPECKLE IS GEOMETRIC — rays
           terminating at different iterations on structure finer than the pixel — and no
           amount of work on pods, veins, hues or reflections could ever have reached it,
           which is exactly why three passes of that work did not.
           ⚑ AND THE CURE IS ALSO THE CORRECT THING TO DO ON ITS OWN TERMS, which is what
           makes it the one to take rather than `detail`: a chain this long accumulates
           derivative error, so stepping less of the estimate is the file's safety margin
           against marching THROUGH a thin feature at a grazing angle — and an overshoot at a
           grazing angle IS a land-or-miss per pixel. Raising `detail` instead buys the same
           statistic by resolving less structure, and it shows: at `detail` 3 the silhouette
           visibly coarsens and the marks along the veins get WORSE.
           ⛑ T1324b — 0.5 -> 0.36, AND THE HONEST HEADLINE IS THAT THIS LEVER IS NEARLY
           EXHAUSTED. At the shipped density it still works (0.5 -> 0.42 -> 0.32 reads
           1.024 -> 0.873 -> 0.767 and turns back up at 0.25 as rays start running out of
           steps before the surface, coverage 21.1% -> 19.9%). AT THE NEW, OPEN DENSITY IT
           BARELY MOVES AT ALL: 1.035 / 0.957 / 0.984 / 1.018 across 0.50 / 0.42 / 0.36 / 0.30.
           ⚑ AND THE TWO ASKS PULL AGAINST EACH OTHER, WHICH IS WORTH MORE THAN THE NUMBER:
           opening the form COSTS noise by itself — the same statistic reads 1.02% at the old
           density and 1.54% at the top of the new lane's travel — because a sparser body is
           more thin structure seen edge-on per pixel. 0.36 with `detail` 3 lands 0.943%, i.e.
           slightly better than the build the owner called noisy, while the body it is
           measured on has nine times the negative space. That is the whole of what the march
           had left to give; a fifth complaint about noise needs a different idea, not a
           sixth value of this. */
        stepScale: 0.36,
        /* ⚑⚑ 6, AND IT IS THE ANSWER TO *"very very noisy due to all these surfaces at
           anything but close up distance"* (T1328b). THE COMPLAINT IS DISTANCE-DEPENDENT so
           it is aliasing, and the brief's proposed instrument — a level of detail on the
           ITERATION COUNT — TURNED OUT NOT TO EXIST HERE. Measured with a literal in the
           source: `links` 11, 6, 5, 3 and 2 all render a BIT-IDENTICAL frame (mean luma
           7.2474, 102905 lit pixels) and only `links` 1 differs (1.4982, 11443). The chain's
           estimate is converged by its second link at this epsilon; `iterations: 11` has
           nothing to cut and is itself a measured no-op. A LOD on the iteration count would
           have been a pass spent on a knob that does not move the picture.
           ⚑ WHAT THE FIZZ ACTUALLY IS, BY ISOLATION AT orbitRadius 22: the NORMAL. Widening
           its own central differences took the pixel-scale grain 0.1462 -> 0.0950 while every
           other term in the frame moved it by less than a hundredth — `occlusion` 0 (0.1465),
           `specular` 0 (0.1472), `translucency` 0 (0.1462), `haze` 0 (0.1463), `polish` 0
           (0.1430) and ALL FIVE EMISSION TERMS CUT (0.1476), against 0.1462 shipped.
           ⚑ AND IT IS A DISTANCE LOD FOR FREE, because `epsilon` already scales with the
           pixel's footprint: the same multiplier moves orbitRadius 12 by 0.0739 -> 0.0733,
           i.e. THE CLOSE-UPS, WHICH THE OWNER SAYS ARE ALREADY RIGHT, ARE UNTOUCHED. The fall
           with the multiplier is a SLOPE and not a cliff (§V981): x1 0.1462, x2 0.1397, x3
           0.1301, x4 0.1157, x6 0.0950, x8 0.0877.
           ⚑ AND THE SILHOUETTE SURVIVES, which is the thing a LOD cut too deep loses first:
           coverage 11.17 % -> 11.17 % and the convolution statistic 6.28 -> 6.38 at 22,
           15.19 -> 15.12 % and 198.06 -> 198.70 at 12.
           ⚠ 1 IS THE ISOLATION ARM AND RESTORES THE OLD BEHAVIOUR EXACTLY. ⚠ AND THE
           PRINCIPLED-LOOKING VERSION IS REFUTED: widening by the grazing angle instead
           (`epsilon / abs(dot(n, dir))`, the pixel's footprint ON the surface) measured WORSE
           at both ranges — 0.1579 at 22 and 0.0826 at 12 — because that cosine is itself
           noisy, so dividing by it injects the noise it was meant to filter. */
        normalWiden: 6,
        bailout: 256,

        /* ─── THE CLOCKS, PRIME ON PURPOSE — AND SPLIT BY THE OWNER'S RULING ─────────
         * The combined state repeats on their product, so "what is different at 15 s, 45 s
         * and 90 s" always has an answer and it is a different answer each time. This is the
         * row's acceptance criterion expressed as numbers, and `chimera-claims.gpu.test.ts`
         * measures it.
         * ⚑ T1318b MULTIPLIED EVERY *FORM* CLOCK BY ABOUT THREE AND LEFT EVERY LIGHT AND
         * CAMERA CLOCK ALONE: 19 -> 149, 47 -> 181, 73 -> 211, 113 -> 277, 89 -> 239, while
         * `hueTurn` 37 and `lightCycle` 53 stand. The owner's ruling is that light may flash
         * at beat rate and form may not, and the reason is measurable rather than aesthetic:
         * a camera move is a rigid transform of the view, so detail stays coherent and the
         * eye integrates it, while a morph DEFORMS the structure a close-up is magnifying.
         * The window a form clock has to survive is an approach, which at `pushPeriod` 43 is
         * about thirteen seconds — and at 19 s the fold rotation used to turn two thirds of
         * a lap inside one of those. */
        /* Where the rotation's lap STARTS, and it is load-bearing rather than cosmetic: at
           phase 0 the rotation is the identity and the object is a flat axis-aligned slab.
           Thumbnails and headless renders are taken at frame 0, so a clock starting at its
           own degenerate value ships the worst frame in the piece as the picture of it. */
        morphPhase: 0.37,
        morphPeriod: 89,
        /* ⚑⚑ THE PALETTE TRAVELS AS A WHOLE (T1324b) — the owner's *"the lights color should
           probably evolve over time"*, answered WITHOUT re-opening §V996. That invariant
           forbids an UNBOUNDED rotation because it walks one colour into another's; what it
           actually forbids is drift RELATIVE to the rest of the palette. `rotateHue` is a
           rotation about the grey diagonal, so one turn applied to every colour together is
           an isometry of the wheel and every pairwise arc is preserved exactly, at every t.
           197 s is prime and coprime with every other clock here.
           ⚠⚠ AND THE UNBOUNDED LAP WAS BUILT, RENDERED AND THEN BOUNDED — §V995 EARNING ITS
           KEEP, because the algebra was right and the picture was not. At 0.30 of a turn the
           arcs are all exactly intact and the frame is YELLOW PODS ON PINK STONE: the eye is
           not rotation-invariant, so "every relative arc preserved" does not mean "the same
           colour design". `paletteArc` 0.16 is a second ceiling for a second failure — §V996
           stops two colours COLLIDING, this stops the palette leaving its own family — and
           the swing still travels about 0.10 of a turn over a minute, which is visible
           evolution. The arcs are asserted from rendered pixels, not from this paragraph. */
        paletteTurn: 197,
        paletteArc: 0.16,
        /* The pod's shade nudge on the beat — *"maybe also slightly change in shade with
           beat"*. It is the ONE per-element hue move in the file, so §V996's pair enumeration
           is what sets it: 0.018 of a turn against a tightest measured pair of 0.048
           (vein against key) leaves every arc positive for every t and every phase of the
           drum. A shade and not a gain, because a beat-rate gain on a source is the pump this
           owner has rejected three times. */
        beatShade: 0.018,
        hueTurn: 37,
        /* ⚑ THE HUE TRAVEL IS BOUNDED NOW (T1322b), AND THAT IS A GUARD ON THE TRANSFORM
           rather than a third annotation on a third site. The rotation read `t / hueTurn`,
           which grows without bound, so it visited every hue on the wheel — including the one
           the pods own and the one the key owns. Measured: at t = 20 s the veins had travelled
           0.27 of a turn into the key's blue and the conduits were invisible against the stone
           they are supposed to contrast with. A sine is bounded for all t.
           ⚠ AND THE VALUE IS SET BY THE TIGHTEST PAIR, WHICH IS NOT THE PAIR THE BUG WAS
           ABOUT. 0.075 was tried first: it fixed the vein-against-pod separation (0.003 turns
           at a full lap — identical — up to 0.341) and drove the vein-against-KEY separation
           to exactly 0.000, because those two travel in opposition and an opposition closes a
           gap at TWICE the arc. They start 0.137 turns apart, so the arc must stay under half
           of that. At 0.045 the worst case over a full lap is 0.375 turns from the pods and
           0.048 from the key. Checked as arithmetic on `rotateHue` rather than by eye. */
        hueArc: 0.045,
        scalePeriod: 181,
        lightCycle: 53,
        characterPeriod: 71,
        seedPeriod: 277,
        /* ⚑ NEGATIVE SPACE, AND THE OWNER'S WORD WAS "OCCASIONALLY" — so it is a CLOCK, not a
           setting, and 239 is one more prime in a set that is checked pairwise coprime. The
           voids are opened by the sphere fold that already makes the shells, so the distance
           estimate stays exact; a hole carved with a min/max against the chain would cost a
           step-scale and make every cost figure in this file dishonest. */
        /* ⚑ 107, AND IT IS THE OWNER'S *"opening and closing distances between nodules"*.
           This clock moves the sphere fold's inner radius, which is exactly what sets how far
           apart the repeated structures sit — the lane already existed and was simply running
           too slowly for anyone to see it happen. Still CUBED, so the gaps are shut most of
           the time and open now and then, which is the "occasionally" the owner asked for
           when they asked for the negative space in the first place. */
        voidPeriod: 107,
        voidTravel: 0.26,

        /* ─── THE CAMERA'S SECOND AXIS, ITS APPROACH, AND ITS AIM ────────────────────
         * ⚑ THESE WERE CALLED "THE POSE" FOR TWO PASSES AND THEY WERE NEVER THAT. The
         * transform is a rigid rotation applied to the EYE AND THE RAY DIRECTION TOGETHER,
         * which is a camera move by definition — the eye walks a sphere about the origin
         * while the object and the light rig stand still. No render could ever have
         * disagreed with either description, which is how the wrong one survived.
         * It matters now because the owner said *"the thing itself rotates and pumps"*: if
         * this had been the object rotating, the repair would have been here. It was not.
         * What rotates the object is `foldSpin` on the morph clock and what pumped it was
         * the deleted `openness` lane, so the repair went there and this stayed.
         *
         * ⚑ THREE MORE PRIME PERIODS, AND THEY WERE CHECKED RATHER THAN ASSUMED. The
         * claims file enumerates every period in this node and asserts them PAIRWISE
         * COPRIME, because two of the sibling piece's nine shared a factor of three while
         * two commit messages called the whole set mutually prime. */
        /* ⚑ ALL THREE CAME DOWN AND BOTH TRAVELS WENT UP (T1322b), AND IT IS ONE DECISION.
         * The owner: *"camera movements may actually be too slow. should be more dynamic.
         * we're really moving about in slowmo."* ⚑ A PERIOD ALONE COULD NOT HAVE ANSWERED
         * THAT: shortening a clock without widening its travel makes the same small move
         * more often, which reads as fidgeting. `poseTilt` 0.42 -> 0.68 and `orbitRise`
         * 1.35 -> 2.4 are what turn a faster lap into a bigger one. */
        posePeriod: 47,
        poseTilt: 0.68,
        pushPeriod: 31,
        poseNear: 2.05,
        aimPeriod: 59,
        poseAim: 0.62,
        /* ⚑ THE SHOT LANE, AND IT DECIDES *CAMERA* BEHAVIOUR. At 1 the whole rig comes to a
           dead stop at the top of an approach and resumes as the camera pulls out, so a
           close-up is a held look rather than a whip-pan through magnified structure. The
           hold is the closed-form integral of (1 - close), not a multiply on the angle —
           scaling an angle winds the camera BACK to where the lap started, which is a bigger
           move than the one it replaces. 0 is the isolation arm: the rig as it was. */
        shotHold: 1,

        /* ─── THE CAMERA: orbiting, and reading NO audio ─────────────────────────────
         * ⚑ 96 s -> 41 s, AND IT IS A CONSEQUENCE OF THE FORM CLOCKS SLOWING DOWN. The
         * energy the shape gave up has to go somewhere and the owner named where: *"we
         * really need to do this with the camera instead."* A lap in 41 s is a fly-around
         * rather than a drift, and it is safe at a speed no form clock is — a camera move is
         * rigid, so the eye integrates the detail instead of watching it be rebuilt.
         * Still reading no audio, for §V965's reason: the camera is the stable reference the
         * morph is legible against, and parking it is the only way an audio claim is
         * provable. */
        orbitPeriod: 23,
        orbitSpeed: 1,
        /* ⚑ EVERY DISTANCE IN THE FILE WENT UP BY THE SAME 1.4, AND THAT IS ONE DECISION
           RATHER THAN SEVEN. Widening the box fold makes the OBJECT BIGGER as well as less
           cubic, and a camera, a light rig and four fade reaches that were fitted to the old
           extent would each have read as a separate defect — a frame that will not hold the
           subject, a far side gone black, a reflection that stops short, an air that clings to
           the middle. They are all metres against the same body, so they all scale with it. */
        orbitRadius: 17,
        orbitHeight: 1.15,
        /* ⚑ 1.35 -> 2.4. At 1.35 against an `orbitRadius` of 17 the eye moved through about
           4.5 degrees of latitude: the lap was very nearly an equatorial band, which is most
           of why the travel read as slow whatever the period said. */
        orbitRise: 2.4,
        lens: 1.85,

        /* ─── BIOLUMINESCENCE ────────────────────────────────────────────────────────
         * The emission field is the ORBIT TRAP — the closest the chain's orbit passed to
         * the axis — so the light is structure-aware by construction and costs three
         * instructions a link rather than a field of its own. */
        veinWidth: 0.1,
        /* ⚑ 2.4 -> 1.15, AND THE MEASUREMENT IS WHY. The spill wash measured 0.72 against
           the key light's 0.45 at the surface, so the emission was OUTSHINING the three-light
           rig: the object was being painted by its own veins rather than lit by anything,
           which is §V972's tint exactly and is what the owner's *"very very even grey"*
           was describing. Halving it hands the mid-tones back to the lights. */
        /* ⚑ 1.15 -> 1.5 (T1322b): what a vein lights AROUND it, raised with the vein. A gain
           and its spread are one decision — this file learned that on `nodeGlow`'s falloff —
           and raising a core without its pool makes a brighter sprite, not a brighter light. */
        veinSpill: 1.5,
        /* Share of the conduit lattice that is dark. Slightly lower than it was (0.45),
           because the cells are now chosen by an EVEN sequence rather than a clumping hash —
           the same density covers more of the object once it stops leaving voids. */
        veinBreak: 0.38,
        /* Cells per unit along that lattice. The volume reads the SAME lattice coarser. */
        veinRate: 3.1,
        veinColor: [0.1, 1, 0.72, 1],
        /* ─── THE NODES: A THIRD KIND OF MARK, AND THE SECOND HUE RIDES IT ────────────
         * Measured before this landed: the piece had NO top end at all — subject p90 116.9
         * of 255 and trueBright 0.00%, and still 0.00% at four times the exposure. A missing
         * top end is a CONTENT defect, not a grade defect, so what is added is the thing that
         * was absent: small, discrete, bright marks. Veins are lines and membranes are
         * sheets; these are points.
         * ⚑ AND THE SECOND HUE IS ON THEM RATHER THAN ON A LIGHT (§V972). Six passes of the
         * sibling piece put a second colour on a light and every one read as a wash; what
         * makes an object work is that it RECURS at a scale the eye can compare, and an orbit
         * trap is scale-free — large on a near lobe, small on a far one, in the same frame. */
        /* ⚑ 6, AND IT IS THE MAGENTA SALT'S CURE (T1318b). The node trap reads the orbit's
           closest approach to the origin, and the orbit's LATE links are at the chain's
           finest scale, where adjacent rays visit different structure — so the trapped value
           is chaotic pixel to pixel and every mark on it is speckle. Armed: the salt survived
           `nodeGlow` 0 and survived `nodeSpill` 0 SEPARATELY, so it was never a brightness
           and no falloff could have reached it; it is the FIELD. Truncating the trap is a
           level of detail, and six links is still six decades of scale in one frame, which is
           the interleaving §V972 actually asks for.
           ⚑ AND THE SWEEP WENT FAR ENOUGH TO SEE WHICH SHAPE IT HAD (§V981). At 6 the salt
           was UNCHANGED and at 4 it was unchanged again — read as "the LOD is a weak lever"
           that would have been abandoned. It is a CLIFF, not a slope: links 3 and up are
           already below the pixel at this framing, so the whole of the noise lives there and
           nothing above it moves at all until you cross. */
        nodeLinks: 2,
        /* ⚑ 0.62 AND THE SWEEP SAYS *BIGGER*, WHICH IS THE OPPOSITE OF WHAT I CHANGED IT TO.
           Swept against a connected-component count of the magenta marks at the shipped
           framing: 0.62 -> 1584 marks averaging 7.98 px; 0.44 -> 1329 at 5.46; 0.30 -> 1082 at
           2.75; 0.20 -> 980; 0.12 -> 957; 0.06 -> 956. ⚠ IT FALLS TO A *PLATEAU*, NOT TO ZERO
           (§V981 read the other way round): ~956 of those marks survive a node radius of 0.06,
           so THEY ARE NOT NODES. They are the VEINS, whose tint is hue-ROTATED on `hueTurn`
           and which at this moment of the lap has travelled into magenta — the identical trap
           this file already records at `rimColor`, which is exempted from the rotation for
           exactly that reason, and which §V980 caught on `fillColor` one pass ago. Shrinking
           the pods could never have reached it, and a smaller radius only made the marks that
           ARE pods smaller and therefore frecklier. Left at 0.62; the vein hue is the next
           row's work and it is named in the commit. */
        nodeRadius: 0.62,
        /* ⚑ 12, AND IT IS HIGH ON PURPOSE. Swept against the measurement: 2.6 -> 6 -> 12 moves
           subject p99 from 182 to 196 to 217 and trueBright from 0.01% to 0.15%, while p50
           moves 56.4 -> 58.4. That ratio IS the definition of a highlight — a few pixels at
           the top, not a gain on everything — and it is the shape §V977 says a missing top
           end needs, as against the exposure sweep that moved the whole slab and clipped
           nothing. Specular and roughness were swept in the same run and moved p99 by 0.1,
           so the top end is the NODES and the frame is not spent on speculars. */
        /* ⚑ 9 AND 7.5, NOT 22 AND 3.2, AND THE TRADE WAS MEASURED RATHER THAN JUDGED.
           A luminous object should keep its colour as it brightens; going white at the
           centre is what an over-range value looks like after a per-channel tone map, and it
           costs the hue at the one place the eye is looking hardest. Mean chroma of the
           brightest slice of the subject, swept:
               glow 22 / spill 3.2   p99 237.8   top-5% chroma 0.158
               glow 14 / spill 5.5   p99 230.7   top-5% chroma 0.203
               glow  9 / spill 7.5   p99 224.8   top-5% chroma 0.253
           Moving the energy from the core into the spill buys 60% more hue across the pod
           for 13 units of peak. The very brightest pixels still clip to white, which is what
           a bright source does in a photograph; what changes is that the pod is PINK rather
           than a white disc with a pink edge. */
        /* ⛑ 9 -> 5.5 (T1324b), AND IT IS A CONSEQUENCE OF THE GATE FIX RATHER THAN A TASTE
           TWEAK. The pod used to be diced by the CONDUIT lattice, so most of any pod sat at
           6% of this gain and only the fragments that landed on a live cell reached the top of
           the range. Taking the gate once per pod puts a live pod at FULL gain over its whole
           face, so the same number is now a much larger dose and the cores blew to white —
           losing the hue they exist to carry, which is a standing item since pass 2.
           ⚠ THE FIRST MEASUREMENT OF THIS COULD NOT SEE IT (§V994 again, in miniature): it
           counted clipped pixels INSIDE the magenta mask, and a pixel that has gone white is
           not magenta by construction, so it read 0.00% at every gain from 9 down to 2.5.
           Counted directly — every channel above 225, as a share of lit pixels — it isolates
           cleanly to this term: 0.174% shipped, 0.003% with `nodeGlow` 0, 0.142% with
           `nodeSpill` 0, 0.153% with the flare removed entirely. 5.5 halves it to 0.100%. */
        nodeGlow: 5.5,
        /* The pool a pod casts on the stone it sits in. This is the term that makes the
           owner's *"they need to ACTUALLY EMIT LIGHT"* true rather than approximated. */
        nodeSpill: 7.5,
        /* ⚑⚑ THE POD STILL READS AS A FLAT DISC AND IT IS NOT A SHADING BUG — THE PODS ARE
           GEOMETRY (T1325b, and this is the fact six passes of work did not have).
           Set `nodeGlow` AND `nodeSpill` BOTH TO ZERO and the pods are still in the frame:
           smooth, shaded, unmistakably three-dimensional BALLS, scattered through the body.
           They are the sphere fold's own solids, and the node trap lights them because both
           read the same orbit radius. ∴ the owner's *"flat, perfectly round, UNSHADED discs
           — stickers pasted on the frame, with no falloff, no internal structure and no
           relationship to the surface they sit on"* is the description of A SOLID WHOSE OWN
           SHADING HAS BEEN PAINTED OVER, not of a mark being drawn badly. Every pass that
           treated it as a mark was working on the wrong object.
           ⚑ FOUR ARMS MEASURED, ALL NO-OPS, RECORDED SO THE SEVENTH PASS DOES NOT BUY THEM
           AGAIN — the pod's radial profile (mean luma per one-pixel ring, largest pod, 25 s)
           is the instrument, because the frame-wide statistics this file already had CANNOT
           SEE THIS: "core span across the pod mask" mixes pod-to-pod brightness differences
           into a number named for within-pod structure, and it reported the repair as done
           while the still showed a sticker (§V994's shape, third instance in this file):
             (a) THE DISPLAY CEILING ALONE — the shoulder above. It fixes the WHITE and
                 leaves a PINK sticker. Necessary, and not sufficient.
             (b) THE FALLOFF WINDOW'S SHAPE — `near` is one minus a smoothstep, which is
                 flat-topped by construction, so an inverse-square pool factor looked certain.
                 Swept 0 -> 300 it moved the profile by THREE LUMA (188.6 -> 185.0 at r=5) and
                 the plateau not at all.
             (c) THE POD'S OWN GAIN — `nodeGlow`/`nodeSpill` from 5.5/7.5 down to 1.2/1.3.
                 The profile SCALES (centre lift 121 -> 69) and the plateau stays at r=8 in
                 every arm. ⚑ THIS IS THE AXIS SIX PASSES SPENT THEMSELVES ON (`nodeGlow`
                 22 -> 9 -> 5.5) and it cannot reach the complaint.
             (d) THE VOLUME — `haze` 0 leaves the discs exactly where they were, so the disc
                 is not the pod field integrated through the air.
           ⚑ AND THE OBVIOUS FIFTH — multiplying the emission by the ball's own cosine, which
           is the physically right move — IS ALSO A NO-OP AT THIS GAIN (188 -> 188), because
           a cosine of 0.3 on a value of 7.5 is still 2.5 and the ceiling is 1.1. It only
           becomes a lever once the pod's peak is near the ceiling, and PAIRED with (c) it
           still only moved the plateau r=7 -> r=6. NOT SHIPPED: a measured no-op does not
           ship, whatever its rationale (§V994's rule, applied to this pass's own idea). */
        /* ⚑⚑ 0.15 AND 1.4 — THE POD'S OWN SHADING, AND IT IS THE OTHER HALF OF §V1001
           (T1326b). The four arms above are the ones that could not reach it; this is the
           one that does, and it starts from a structural fact none of the seven passes had:
           ⚑ THE POD'S VISIBLE SURFACE IS A LEVEL SET OF THE VERY QUANTITY THE MARK IS BUILT
           ON. `trace.node` is the orbit's closest approach to the origin and the sphere
           fold's inner inversion makes the pod a ball of ONE radius, so every visible pixel
           of a pod reads the SAME trap value. ∴ no function of `trace.node` can vary across
           a pod — which is why the window's shape, the pod's gain and the volume were all
           measured no-ops, and why six passes on the MARK could not have worked. Rendered on
           its own, `glow.node` is a flat-topped disc with a hard edge: that IS the sticker.
           ⚑ MEASURED PER POD, NOT OVER THE MASK (§V1002) — 17 pods at 25 s, rank span within
           each pod as a share of its own median, median over the pods. The candidates: the
           shell's own three-light luminance 1.113, the key cosine 0.739, the view cosine
           0.447, the shadow 0.156, the ambient occlusion 0.030. The lit shell wins, and the
           §V1001 arm is the known positive that says what the ceiling is: cut both pod terms
           and the ball underneath reads 1.206 against the shipped pod's 0.154.
           ⚑ AND IT GOES IN TWO PLACES BECAUSE ONE IS NOT ENOUGH, WHICH IS ALSO MEASURED. On
           the EMISSION alone it is T1325b's refuted arm (e) for the bright pods, because the
           shoulder erases it; on the CEILING alone it reaches only the pods whose peak clears
           the knee — a flat ceiling scale of 0.25 left TEN OF SEVENTEEN pods' median luma
           unchanged to the byte, because `nodeFade` has faded their cores and they are
           carried by their pool. Together: per-pod span 0.154 -> 0.695 and the correlation
           with the ball's own shading 0.513 -> 0.888.
           ⚠ AND `podShadeLevel` IS SWEPT AGAINST THE PEAK, because a shading term that dims
           the whole pod is §V977's defect wearing a repair's clothes — and the claim's own
           brightness guard caught it: at 3.5 the pod core's luma falls 192.7 -> 153.3 and the
           test goes red. At 1.4 the core is 185.1, the within-pod span is HIGHER (0.628 ->
           0.714) and the core keeps more chroma. The lit side saturates; only the terminator
           is paid for. ⚠ 1 IS THE ISOLATION ARM and it is what `chimera-claims` now uses to
           restore the white-clipping defect, because this term alone takes the shoulder-off
           control from 16.0 % white down to 1.24 % — the control had stopped controlling. */
        podShade: 0.15,
        podShadeLevel: 1.4,
        /* Where a pod's sharp core gives way to its spill alone. Sanctum's grain fade. */
        nodeFade: 21,
        nodeColor: [1, 0.36, 0.86, 1],
        /* ─── THE FLARE: THE BEAT'S ONLY DESTINATION, AND IT ARRIVES ONE MARK AT A TIME ─
         * `flareDepth` is the gain the global `veinEmission` lane used to carry, moved onto
         * the individual mark; `flareWidth` is what share of the marks are lit at any one
         * instant of the sweep. Width 1 would be unison — every mark together, which is the
         * global pump wearing a different coat — and the owner's words were "the brightness
         * of SOME of the glow areas". */
        /* ⚑ 7, AND IT WAS 3 UNTIL THE TRANSIENT INSTRUMENT SAW IT. At 3 the flare moved the
           frame by 0.10 of a 7.14 per-frame delta on a hit — 1.4%, which is "a lane that is
           technically present". The marks are a small share of the pixels, so a mark gain has
           to be large before it is a picture. */
        flareDepth: 7,
        flareWidth: 0.3,

        /* ─── THE LIGHT RIG ──────────────────────────────────────────────────────────
         * Three sources of different hue, each with REACH, and a hierarchy that hands the
         * key from one to the next over `lightCycle`. §T1304c: a light with no falloff
         * lights the far side as hard as the near, and that is most of what makes a picture
         * read cheap. §T1309b: without a hierarchy it is "lights all over the place". */
        keyColor: [0.55, 0.78, 1, 1],
        /* ⚑ NEUTRAL, AND IT USED TO BE MAGENTA. Isolated one arm at a time: cutting the
           SPILL left the object magenta, cutting the FILL left it teal stone with discrete
           magenta nodes on it — so the magenta wash the owner was looking at was THIS LIGHT,
           and it was covering the marks it was meant to contrast with. §V972: the second hue
           belongs to an OBJECT, and it now does (the nodes). This light's whole job is to
           model form. It is also no longer hue-rotated, which is why retuning its colour
           could not have fixed it — an amber fill was measured and came back magenta, walked
           there by the rotation, which is the failure `rimColor` is exempted from. */
        fillColor: [0.8, 0.84, 0.92, 1],
        /* The warm one does NOT morph: rotating an orange about the luminance axis walks it
           into magenta, which is the specific way this trick fails (T1304c). */
        rimColor: [1, 0.62, 0.26, 1],
        /* ⚑ THE LIGHTS COME UP BECAUSE THE WASH CAME DOWN. Halving `veinSpill` handed the
           mid-tones back to the rig, and the rig was set against a frame where the emission
           was doing that job: measured, the object fell to p50 43.8 before these moved and
           sits at 58.4 after. This is the light modelling the form again, which is what was
           missing when the whole surface read as one even tint. */
        rimIntensity: 6.2,
        lightReach: 8,
        lightDistance: 10.5,
        lightSwing: 0.35,
        ambient: 0.12,
        /* ─── THE KEY CASTS A SHADOW, AND UNTIL T1318b NOTHING IN THIS FILE DID ──────────
         * The owner's *"as if the lights are all like not cones but just all global god
         * lights"* was a correct reading of the code: `occlusionAt` is AMBIENT occlusion and
         * knows nothing about where a light is, so it darkened the same creases by the same
         * amount whatever the rig did, and `lightAt` had nothing between a light and a
         * surface at all. Moving a light could change its tint and its intensity and could
         * not change the shading PATTERN — which is precisely "statically lit while the
         * lights demonstrably move".
         * ⚑ THE KEY ALONE. It is a second full march per light and the frame cannot buy
         * three; fill and rim without it are AMBIENT WRAP, which is what a fill light is
         * for. `lightSwing` 0.35 is what makes that hold across the whole hierarchy lap —
         * the key's weight never drops below 0.65, so the shadowed source is the dominant
         * one at every moment rather than at two thirds of them. */
        shadowStrength: 1,
        shadowSoft: 9,
        shadowSteps: 28,
        shadowReach: 13,

        /* ─── MATERIAL: wet, chitinous ───────────────────────────────────────────────── */
        baseColor: [0.3, 0.33, 0.36, 1],
        roughness: 0.26,
        fresnelGain: 1.1,
        translucency: 0.75,
        occlusion: 1.15,
        aoReach: 1,

        /* ─── THE REFLECTION: a SECOND MARCH, and the expensive idea in the file ──────
         * `polish` at 0 skips it entirely, which is what makes its cost measurable by
         * alternating a parameter rather than by editing the shader. */
        polish: 0.62,
        reflectSteps: 30,
        /* ⚑ THE FRECKLES ARE THE *REFLECTION*, AND THAT IS THE THIRD DIAGNOSIS THIS ONE
           DEFECT HAS HAD (T1322b). Found by isolation, not by sweep: `polish 0` took the
           frame from 1519 magenta marks to 382 AND RAISED their mean area 7.4 px -> 17.2 —
           three quarters of the marks gone and the survivors BIGGER, which is a small-mark
           population being removed rather than a general dimming. Cutting every VEIN term,
           by contrast, left 1385 of 1519 standing, which is what overturned §V988.
           ⛑ `reflectLinks` 4 IS NOT THE FIX AND IS NOT SHIPPED AS ONE: swept 11/8/6/4/3/2
           the count reads 1593/1593/1593/1593/1594/1585, flat. It is kept because four links
           instead of eleven is real work saved on most shaded pixels, and the number it did
           not move is recorded next to it. */
        reflectLinks: 4,
        /* ⚑ AND THIS IS THE FIX: A REFLECTION CARRIES A POD'S POOL, NOT ITS FILAMENT. The
           reflected ray's HIT is a per-pixel boolean off a fractal normal, and a sixth-power
           core with a gain of 22 pushed through a per-pixel boolean is salt with a 22x gain.
           The smooth spill survives the same decision as a pool. 1 restores the old
           behaviour, which is the isolation arm. */
        reflectSharp: 0,
        reflectFade: 7.7,

        /* ─── THE VOLUME ─────────────────────────────────────────────────────────────
         * Light visible in the air. It samples a FOUR-LINK chain, not the surface's
         * eleven: §V962's companion — a volume wants a DIFFERENT field from a surface, not
         * a cheaper one, and a short chain is genuinely smoother while still being shaped
         * like the object it surrounds. */
        /* ⚑ 28 -> 20, AND IT IS A CONSEQUENCE RATHER THAN A SAVING. The air now reads the
           SAME emission field the surface does (§V973) instead of a constant tint, and a
           field that is smooth by construction integrates cleanly with fewer samples than a
           hash-gated one. The sibling piece measured the same trade the same way round. */
        hazeSteps: 20,
        hazeSharp: 26,
        /* ⚑⚑ 2.1 -> 1.1, AND IT IS THE OWNER'S *"what are these small coloured dots? are
           those light rays but just badly implemented?"* (T1327b). THEY ARE NOT RAYS AND THEY
           ARE NOT THE R2 JITTER EITHER — that diagnosis is refuted at `volumeAlong`, with the
           detector validated against a synthetic dot field placed on the R2 lattice itself.
           They are THIS STAGE's own marks, sub-pixel and already converged: twelve times the
           samples (`hazeSteps` 20 -> 240) leaves the mean void luma at 0.0050, unmoved.
           ⚑ THE TRADE, MEASURED AT ONE FRAME: the WHOLE volume stage lifts the subject's mean
           luma by 0.213 — three tenths of one per cent of the picture — and puts 177 separate
           dots, median ONE pixel, up to luma 184, into a void that is otherwise pure black.
           At 1.1 the lift is 0.064 and the dots are 42 at a peak of 151. ∴ 76 % OF THE
           ARTEFACT FOR 0.15 LUMA OF A GLOW THAT IS 0.3 % OF THE FRAME.
           ⚠ AND THE REPAIR THIS FILE USES EVERYWHERE ELSE MAKES IT WORSE, which is why the
           lever is the REACH and not the width: widening the volume's marks to the pixel's
           own footprint took the dots 177 -> 270 and their peak 184 -> 216, because a wider
           mark is a mark that more rays catch. Fading them with range instead is a no-op
           (177 -> 171). ⛑ THE BIGGER NUMBER IS THE 0.213 AND IT IS AN OWNER QUESTION, NOT
           MINE: a stage that runs twenty four-link chain evaluations per pixel to move the
           subject by two tenths of a luma is a stage whose keep-or-cut is a look decision. */
        hazeFalloff: 1.1,
        hazeBase: 0.16,
        hazeWidth: 3.4,

        /* ─── THE VOID AND THE GRADE ─────────────────────────────────────────────────── */
        /* ⚑ THE BACKDROP IS BLACK AND THE ENVIRONMENT IS NOT THE SAME THING (owner: "needs a
           black background instead of having this weird gradient background"). A graded
           backdrop competes with a compact subject and raises the floor the bioluminescence
           must read against. The gradient stays where it was doing work — the fresnel rim and
           what a reflected ray finds — so the object is still lit by an environment it no
           longer sits in front of. */
        backdrop: [0, 0, 0, 1],
        skyTop: [0.021, 0.03, 0.052, 1],
        skyBottom: [0.055, 0.028, 0.042, 1],
        fog: 0.028,
        exposure: 1.55,
        pivot: 0.2,
        contrast: 1.13,
        /* ⚑ ZERO, AND IT WAS 0.004. A lift exists to open crushed shadows; against a BLACK
           backdrop it has nothing to open and simply greys the void — measured, it put 96.3%
           of the frame above the floor and the "black" background was luma 4.5. With it at 0
           the backdrop is 70-87% TRUE black and the subject still spans p01 15 / p50 71 /
           p90 124, which is a real distribution rather than a crushed one. */
        lift: 0,
        /* ⚑⚑ THE POD'S HUE WAS BEING DESTROYED BY THE SINK, NOT BY ITS OWN BRIGHTNESS
           (T1325b), and the two are told apart by a measurement rather than by a story.
           The owner's fifth-pass stills read the pods as FLAT, PERFECTLY ROUND, UNSHADED
           DISCS — stickers pasted on the frame — and T1324b measured 16.0% of pod pixels at
           full white, every channel above 225, at 25 s.

           ⚑ THE CAUSE IS THE OUTPUT NODE'S TONE MAP AND IT IS PER CHANNEL. `out` runs
           `toneMap: "filmic"` (Narkowicz's ACES fit), and a per-channel curve compresses
           r, g and b INDEPENDENTLY: every channel walks to 1 on its own, so the wider a
           colour's channel spread the faster it turns grey at the top. Recovered in pixels
           rather than derived (§V995 — this file has twice had a correct-looking derivation
           name the wrong mechanism): because `lift` is 0 the grade is EXACTLY proportional
           to `exposure`, so rendering with the tone map off at 1/8 and 1/64 gain and
           rescaling reconstructs the precise linear value the sink receives. It agrees with
           itself across the two gains to a median 1.4%, and filmic-plus-encode applied to it
           reproduces the shipped bytes with a median error of ZERO.
           ⚑ AND THE RECONSTRUCTION PREDICTS THE DEFECT FROM THE OTHER SIDE: a channel at
           0.80 linear lands on byte 226, so "minimum channel over 0.80" is the white test
           stated in the sink's own terms. It reads 16.26% of the pod. The shipped frame's
           byte test reads 16.0%. Two instruments sharing no code, one number.

           ⚑ WHICH IS A *TRANSFER* DEFECT, AND §V977's DISCRIMINATOR IS WHAT SAYS SO. That
           row settled a MISSING top end as a content defect by sweeping the gain; this is
           the same axis inverted and the same sweep settles it. The subject's max channel is
           p50 0.116 / p99 1.907 with 1.53% of it over 1, while the pod is 43.98% over 1 —
           p99 moves, p50 does not, so the over-range is a HIGHLIGHT and not a slab. The
           refuted arm is in the file: a flat gain must fall to a QUARTER before white drops
           to 0.3%, and it takes the subject p50 from 74.9 to 22.5. ⚠ THE POD'S OWN GAIN IS A
           DIFFERENT ARM AND IT IS REFUTED SEPARATELY, at `nodeSpill` above — it does not move
           the slab, it simply cannot reach this either.

           ∴ THE REPAIR IS AT THE TOP END ONLY: roll the MAXIMUM channel onto a ceiling and
           scale all three by that one factor, which preserves the hue exactly. Measured at
           25 s, shipped -> shoulder: white 16.0% -> 0.0%, and the pod's core carries hue
           again — chroma 0.042 -> 0.227, a factor of five, with the same 0.0% holding at 0 s
           and 60 s. THE COST IS PEAK: pod luma 171 -> 155 and peak 253 -> 219.
           ⚠ WHAT THIS DOES NOT FIX, SAID HERE BECAUSE THE NUMBERS LOOKED LIKE IT DID: THE POD
           IS STILL A FLAT DISC. It is a PINK flat disc now rather than a white one, which is
           the hue half of the complaint and not the sticker half. The frame-wide statistics
           read the sticker as cured (core byte span 14.9 -> 28.2, core flatness 58% -> 9%)
           AND THE STILL SHOWS OTHERWISE — because a span taken across the whole pod MASK is
           mostly pod-to-pod brightness differences, not within-pod structure (§V994 again,
           and the still is the thing that caught it, not the number). The cause of the
           remaining half, and the four arms that do not touch it, are at `nodeSpill`.
           ⚑ AND THE REST OF THE PICTURE DOES NOT MOVE. The non-pod subject reads p50 73.9 /
           p90 118.1 / p99 146.8 / p999 166.7 against a shipped 73.9 / 118.1 / 146.9 / 166.7,
           because the knee reaches EIGHTY-ONE pixels outside the pods. The palette is
           untouched by construction: a common scale on r, g and b is not a hue rotation. */
        highlightKnee: 0.8,
        highlightCeiling: 1.1,
        steps: 132,
      }, {
        label: "shape1",
        parameters: {
          /* ─── THE TRANSIENTS, ON ENVELOPES (§V966) ─────────────────────────────────
           * `hit1.kick` is the kick BAND ENVELOPE carried through the hits lane's 1 ms
           * attack and 420 ms release — the same event a count marks, but with the
           * transient's own rise and fall, so it SWELLS and GUTTERS where a count would
           * step in a single frame.
           *
           * Every retained value below is the lane's DRIVEN MEAN rather than its floor or
           * its peak (§V914): the value that stands when no drive arrives has to look like
           * the piece, because that is the picture every thumbnail and every headless
           * render actually shows. */

          /* ⚑ THE KICK MOVED OFF `veinEmission` AND ONTO `flare` (T1318b), AND THAT IS THE
             WHOLE OF THE ROW'S THIRD ITEM. `veinEmission` is a GLOBAL multiplier on the vein
             term: a kick lifted every conduit in the frame by the same factor at the same
             instant, which is the picture inflating rather than anything happening inside
             it. `flare` reaches the SAME marks one at a time — the shader reads the envelope
             twice, once as an amount and once as a POSITION in an R3 sequence over the
             conduit lattice, so the release sweeps through the marks in an order that is
             independent of how bright each one already is.
             The vein term keeps the value this lane retained, so the rest picture does not
             move: 6.25 was the driven mean and it is now the static. */
          /* ⚑ 6.25 -> 8.4, AND THE ORDER MATTERED: the owner asked for the glow to be MORE
             INTENSE and also called the picture a freckly noisy mess, and raising a gain
             before fixing the noise is how the last pass made the speckle worse. It is raised
             here because the speckle was measured and traced to the MARCH rather than to any
             emission gain (see `stepScale`), so the two are independent and this one can move
             on its own merits. */
          veinEmission: 8.4,
          flare: expressionSlot(`${HITS("kick")}`, 0.25),
          /* ⚑ THE CAMERA PUNCH IS GONE, AND IT WAS GONE THE DAY AFTER IT LANDED (T1322b).
             `punch` read the kick envelope as a dolly on the eye. The mechanism was right —
             a rigid magnification really does keep world-space detail coherent where the
             deleted pump destroyed it, and the lane measured at 92 % of the piece's entire
             transient response. THE OWNER REJECTED THE EFFECT ANYWAY, twice, by name:
             *"camera pulses are so ugly too. that's vomit inducing"*, then *"we can't have
             like 1 frame camera punches on kick and stuff. it's horrible."*
             ⚑ NOTE WHICH WORD IS THE DIAGNOSIS: *1 FRAME*. The complaint is the DURATION, not
             the destination — so it is removed rather than softened, because a smaller punch
             is the same gesture with a smaller amplitude and the objection was never to the
             amplitude. A CORRECT MECHANISM POINTED AT AN EFFECT NOBODY WANTS IS STILL THE
             WRONG EFFECT. ⚑ AND BECAUSE THE LANE WAS READ CENTRED, deleting it is
             bit-for-bit invisible with no audio — the second time in two passes that centring
             a lane on its neutral value is what let it be removed without a retune.
             ⚠ BEAT-DRIVEN CAMERA MOTION IS A STANDING REFUSAL FOR THIS PIECE NOW. What the
             piece lost is stated rather than replaced: the fast lane drops to near zero, and
             the owner's replacement is on the ANALYSIS side (*"rather use a better kick
             detection… and then mids and highs and lows separated out used to drive stuff"*),
             which is a different row and a different file. */
          /* ⚑ AND THE KEY LIGHT PUNCHES ON THE BACKBEAT — which, now that the key CASTS,
             moves the shading pattern across static geometry rather than merely brightening
             it. That is the cue the piece has never had, and it costs nothing beyond the
             shadow march that is already running.
             ⚑ IT WAS ON THE SNARE AND THE INSTRUMENT SAID IT DID NOTHING — 5.064 against a
             5.065 with the lane live, i.e. not one part in five thousand, because the snare
             envelope is not moving at the kick the measurement straddles. A lane that measures
             as absent is absent, whoever specified it. It is on the KICK now, with the camera
             and the marks, so a hit is ONE gesture: the camera thrusts, the marks flare in
             succession, the key punches — and because the key now CASTS, its shadow snaps with
             it, which is a beat moving the shading pattern across static geometry rather than
             brightening it. Centred on the kick envelope's own mean, so the retained value is
             exactly the 8.5 the rig was tuned at. */
          keyIntensity: expressionSlot(`7.82 + 2.72 * ${HITS("kick")}`, 8.5),
          /* The MEMBRANES answer on the backbeat — a different structure from the veins,
             so the two hit lanes are visibly different events rather than one gesture read
             twice (§T1279's split, learned on E57's fog and moon). */
          shellGlow: expressionSlot(`0.4 + 0.5 * ${HITS("snare")}`, 0.5),
          /* FINER REACTION TO FINER DETAIL (§T1304b): a hat widens the spill a little. The
             smallest lane in the file, on the fastest part of the signal, and it moves the
             glow around the veins rather than the veins themselves. */
          veinSpread: expressionSlot(`2.6 + 1.4 * ${HITS("hat")}`, 3),

          /* ─── THE CONTINUOUS PROPERTIES, ON RANKS ──────────────────────────────────
           * A rank rests at its MIDDLE, so each retained value below is the expression
           * evaluated at 0.5 — silence renders the shipped density exactly. */
          /* ⚑ THE MASTER CAME DOWN (0.22 -> 0.075) BECAUSE WHAT IT MULTIPLIES GOT BIGGER,
             not because there is less medium. The volume used to accumulate a constant tint;
             it now accumulates the object's OWN emission — vein core times `veinEmission`,
             spill times `veinSpill`, nodes times `nodeGlow` — so the same master would be
             several times the light it was. The air is dimmer per unit of field and far
             brighter where the field is lit, which is the whole point. */
          /* ⚑ AND THE AIR CARRIES MORE OF IT (0.075 -> 0.104 at the driven mean). The volume
             accumulates the object's OWN emission, so a brighter vein is a brighter glow
             around it for free; this raises the medium the glow is carried IN on top of that,
             which is the half that makes the light read as being in the room rather than on
             the shell. */
          haze: expressionSlot(`0.072 + 0.064 * ${LEVELS("low")}`, 0.104),
          /* ─── ⚑ NO AUDIO LANE REACHES THE FORM ANY MORE (T1318b) ────────────────────
           * `openness` (the looseness) and `foldTravel` (the creases opening with the body
           * of the mix) were the two that did, and the owner cut them by watching the
           * result: *"it's still pumping, like pulsing instead of us doing it by camera,
           * which then prevents us that we can't have close-ups and flyovers that make sense
           * without being noisy because the thing itself rotates and pumps."*
           * ⚑ AND THE ARGUMENT FOR HAVING CENTRED `openness` ON ITS NEUTRAL VALUE PAID OUT
           * HERE RATHER THAN WHERE IT WAS MADE: because the lane retained EXACTLY the value
           * at which it contributed nothing, deleting it is bit-for-bit invisible in the
           * no-track picture — no thumbnail moves, no claim's rest state moves, and §V914 is
           * satisfied by the same arithmetic that satisfied it when the lane landed. A lane
           * centred on its floor could not have been removed without a retune.
           * `foldTravel` keeps its retained 0.18 as a static, for the same reason. */
          /* ─── ⚑ AND *ONE* AUDIO LANE REACHES THE FORM AGAIN (T1322b) ────────────────
           * The owner, in the same breath as rejecting the camera punch: *"the shape
           * shifting should be more audio reactive, that's for sure."* That looks like a
           * reversal of the ruling above and it is not — THE DISTINCTION IS THE WHOLE DESIGN:
           *
           *   ⚑ THE TIMESCALE OF THE DRIVER MUST MATCH THE TIMESCALE OF THE THING DRIVEN.
           *
           * What this owner has now rejected THREE TIMES is a TRANSIENT driving something
           * STRUCTURAL: the global scale pumping per beat (deleted twice) and a one-frame
           * dolly on a kick (deleted above, and note their diagnosis was the DURATION).
           * What they are asking for is the MORPH — a slow, structural thing — to answer the
           * music ON ITS OWN TIMESCALE. A transient driving form is a pump; a transient
           * driving a camera is a twitch; A SUSTAINED SIGNAL DRIVING FORM IS THE PIECE
           * DANCING, and that is the thing this file has never had.
           * So the lane is the SPACING between the nodules — the gaps opening and closing —
           * and its driver is a RANKED LEVEL, not a hit. A rank is a percentile over a
           * window: it moves over seconds, which is a form timescale, and it CANNOT step.
           * ⚑ IT DRIVES AN OFFSET ON A BOUNDED QUANTITY, NOT A RATE ON A CLOCK. A rate would
           * have to be integrated to give a phase, a fragment shader has nothing to integrate
           * into, and multiplying a rate into `t` makes the phase jump by `t · Δrate / period`
           * — an error that GROWS WITH THE CLOCK. An offset is continuous in its drive
           * however the drive behaves.
           * ⚑ AND IT IS READ CENTRED ON THE RANK'S OWN REST VALUE (0.5), so the retained
           * 0.11 is the driven mean and §V914 holds by arithmetic: the silent picture is
           * exactly the picture with this lane deleted.
           * ⛑ THE SIGNAL IT SITS ON IS THE BEST ONE AVAILABLE TODAY AND IT IS KNOWN TO BE
           * POOR: §T1323b measured the four published bands as effectively TWO signals
           * (low x lowMid r = 0.917), so `low` today is very nearly `lowMid` and a gain here
           * is silently compensating for unequal band spans. When the decorrelated contrast
           * channels land this lane REPOINTS AT THEM and the coefficient below is refitted;
           * it is not hand-decorrelated here, because two answers to one question is worse
           * than one poor answer with a note on it.
           * ⛑⛑ T1324b — THE LANE NOW CARRIES *DENSITY*, IT RUNS THE OTHER WAY, AND IT READS A
           * DIFFERENT BAND. THREE CHANGES, EACH WITH ITS OWN REASON.
           *   (1) DIRECTION. The owner: *"EMBRACE NEGATIVE SPACE"* and, in the same message,
           *   *"have enough going on in the actual DRIVING PART OF THE SONG"*. Those are not
           *   two targets, they are the TWO ENDS OF ONE LANE — sparse and open when the track
           *   is quiet, closing up and proliferating when it drives — so the coefficient is
           *   NEGATIVE. Raising `fixedRadius` pushes every structure away from every other,
           *   which is what opens the holes, so more energy means a SMALLER offset.
           *   (2) BAND. It reads `lowMid` rather than `low`, and that is measured rather than
           *   preferred. §T1323b, on the owner's own track through this exact 60 s window, put
           *   the surviving slow movement (σ of a 30 s moving average) at low .1006 /
           *   lowMid .1323 / highMid .1303 / high .1211: `low` carries the LEAST slow
           *   structure of the four and this lane is the file's only slow structural lane.
           *   It is the same measurement that set the window; `haze` keeps `low`.
           *   (3) SPAN. 0.18 of offset against an operator whose hole statistic runs
           *   0.74% -> 16.92% over 0.8 of travel is a real excursion, and the retained 0.15
           *   is the driven mean (the rank rests at 0.5), so §V914 still holds by arithmetic
           *   — with no track the piece sits at the middle of its own density range, which
           *   the stills show is the form worth looking at rather than either extreme. */
          spacingOpen: expressionSlot(`0.24 - 0.18 * ${LEVELS("lowMid")}`, 0.15),
          fillIntensity: expressionSlot(`5.9 + 2.6 * ${LEVELS("highMid")}`, 7.2),
          specular: expressionSlot(`1.05 + 0.6 * ${LEVELS("high")}`, 1.35),
          /* Spectral brightness opens the chroma — a grade that follows the music rather
             than a constant one. */
          saturation: expressionSlot(`1.1 + 0.24 * ${LEVELS("centroid")}`, 1.22),

          /* ─── THE TEMPO (T1309b) ────────────────────────────────────────────────────
           * Read from `source1`, NOT from the analysis bags: the levels lane ranks
           * everything to 0..1 over a window, so a bpm through it would read 0.5 forever.
           * The form is chosen so the term VANISHES whenever there is no tempo claim —
           * `bpmConfidence` is 0 on a live source that estimates nothing and on no audio at
           * all — and so it is exactly 1 on the shipped pattern, whose bpm IS 112. */
          tempoScale: expressionSlot(
            `1 + op('source1').chan.bpmConfidence * (op('source1').chan.bpm - 112) / 112`,
            1,
          ),
        },
      }),

      /* FXAA, one pass (§T1276's shader, the same one E67 ships). A marcher cannot MSAA —
         that is free only on the rasterised path — and the owner refused a 1.69x supersample
         on E67. Clean edges are a large part of what "8K" actually means here, and this is
         the version of them that costs one pass rather than two and a half frames. */
      node("fxaa", "customWgsl", [0, 0], { source: FXAA_WGSL, amount: 1 }, { label: "fxaa1" }),

      node("out", "output", [300, 0], { toneMap: "filmic" }, { label: "out1" }),

      /* ── THE DRIVE ────────────────────────────────────────────────────────────────────
       * The catalogue's fixed shape: a deterministic pattern at index 0 so the file is
       * audio-reactive on open with no track at all (§V363), and a real file at index 1 one
       * drop away. Everything downstream reads `source1`, so swapping the source changes
       * nothing else.
       *
       * ONE analysis instance, two bags — `lvl1` for the ranked levels and `hit1` for the
       * transients. The split is the finding (§T1234/§T1271): a percentile cannot spread a
       * tie, so a transient read through a rank rests at its mid and becomes a permanent
       * half-lit nothing.
       *
       * ⚑ NOTHING DRIVES THE CAMERA, and nothing drives a clock except `tempoScale`. */
      node("music1", "audioPattern", [-1200, 400], { amount: 1, bpm: 112 }, { label: "music1" }),
      node("track1", "audioFileIn", [-1200, 620], {
        cue: false, cuePoint: 0, extend: "loop", file: "", monitor: true, play: true,
        playMode: "freeRun", speed: 1, trimEnd: 0, trimStart: 0, volume: 1,
      }, { label: "track1" }),
      node("source1", "valueSwitch", [-960, 510], { index: 0 }, { label: "source1" }),
      node("analysis1", "component:audioAnalysis@1", [-720, 510], {
        /* hitDecay 420 rather than 250 (T1304c): 250 ms puts a whole gesture inside fifteen
           frames, which is what "too blinky blinky" named. On an ENVELOPE lane the decay
           shapes a release that already has a shape, rather than being the only shaping the
           lane has. */
        /* ⚑ window 60, NOT THE COMPONENT'S DEFAULT 16 (§T1323b), AND THIS IS THE WHOLE OF
           THE ANALYSER'S ANSWER TO *"the shape shifting should be more audio reactive"*.
           The levels bag is RANKED — each band as a percentile of its own recent window —
           and the window is what decides which timescale survives that ranking. Measured on
           the owner's own 4:32 track as the sigma of a 30 s moving average (i.e. what is
           left once fast detail is gone): low .0501 -> .1006, lowMid .0614 -> .1323,
           highMid .0700 -> .1303, high .0584 -> .1211 going from 16 s to 60 s. ROUGHLY
           TWICE THE SLOW MOVEMENT ON EVERY BAND.
           ⚠ AND IT IS A PEAK, NOT A MONOTONE — 180 s is WORSE than 60 (.0850 / .1229 /
           .1107 / .0956), because a window approaching the track's length has too little
           history to rank against. The optimum is around 45-90 s. Do not read this as
           "longer is better" and do not move the component's own 16 s default, which is
           right for the beat-scale lanes it was fitted to (two four-bar phrases at 120 bpm).
           ⚑ THE COUNTERINTUITIVE PART IS WHY THE NUMBER IS WORTH TRUSTING: the rank does not
           DESTROY slow structure, it AMPLIFIES it. Raw `low` on real music lives inside
           0.891..0.970 — an eight-percent working range — so its slow movement is tiny in
           absolute terms; ranked, that same structure occupies the full 0..1.
           ⚠ AND THE HITS BAG STILL READS THIS COMPONENT. `kick` is NOT reliable on ambient
           material (p50 0.002 on this track, §V992), which is one more reason the form lane
           above is driven from a ranked BAND and not from a hit. */
        envelope: 0.08, window: 60, settle: 0.15, hitDecay: 420,
      }, { label: "analysis1" }),
      /* T1302b: a Select at `*` passes every channel through unchanged — a Limit at 0..1
         would clip the tempo claims the hits bag also carries. */
      node("lvl1", "valueSelect", [-480, 420], { channels: "*" }, { label: "lvl1" }),
      node("hit1", "valueSelect", [-480, 600], { channels: "*" }, { label: "hit1" }),
    ],
    [
      edge("e-sky-shape", ["sky", "out"], ["shape", "input"]),
      edge("e-shape-fxaa", ["shape", "out"], ["fxaa", "input"]),
      edge("e-fxaa-out", ["fxaa", "out"], ["out", "input"]),
      edge("e-music-source", ["music1", "out"], ["source1", "in1"]),
      edge("e-track-source", ["track1", "out"], ["source1", "in2"]),
      edge("e-source-analysis", ["source1", "out"], ["analysis1", "audio"]),
      edge("e-analysis-lvl", ["analysis1", "levels"], ["lvl1", "in"]),
      edge("e-analysis-hit", ["analysis1", "hits"], ["hit1", "in"]),
    ],
  ),
);
