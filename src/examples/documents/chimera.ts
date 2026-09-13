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
        fixedRadius: 1,
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
        detail: 2.5,
        stepScale: 0.78,
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
        hueTurn: 37,
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
        posePeriod: 61,
        poseTilt: 0.42,
        pushPeriod: 43,
        poseNear: 2.05,
        aimPeriod: 67,
        poseAim: 0.62,
        /* How far the camera thrusts at the top of a kick, as a share of its distance. */
        punchGain: 0.16,
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
        orbitPeriod: 41,
        orbitSpeed: 1,
        /* ⚑ EVERY DISTANCE IN THE FILE WENT UP BY THE SAME 1.4, AND THAT IS ONE DECISION
           RATHER THAN SEVEN. Widening the box fold makes the OBJECT BIGGER as well as less
           cubic, and a camera, a light rig and four fade reaches that were fitted to the old
           extent would each have read as a separate defect — a frame that will not hold the
           subject, a far side gone black, a reflection that stops short, an air that clings to
           the middle. They are all metres against the same body, so they all scale with it. */
        orbitRadius: 17,
        orbitHeight: 1.15,
        orbitRise: 1.35,
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
        veinSpill: 1.15,
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
        nodeGlow: 9,
        /* The pool a pod casts on the stone it sits in. This is the term that makes the
           owner's *"they need to ACTUALLY EMIT LIGHT"* true rather than approximated. */
        nodeSpill: 7.5,
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
        hazeFalloff: 2.1,
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
          veinEmission: 6.25,
          flare: expressionSlot(`${HITS("kick")}`, 0.25),
          /* ⚑ AND THE SAME TRANSIENT PUNCHES THE CAMERA — the fast lane the deleted pump was
             carrying badly, moved onto the one thing that is allowed to be fast. A dolly is a
             RIGID transform of the view: it magnifies structure without touching it, so the
             detail stays coherent across the punch, which is exactly what the pump destroyed.
             ⚑ READ CENTRED, so §V914 holds by arithmetic rather than by measurement: the kick
             envelope's mean is the 0.25 this file already assumes elsewhere, so the lane
             retains EXACTLY 0 and the no-audio picture is bit-for-bit the picture with the
             lane deleted. Between hits the camera eases back a little and on a hit it thrusts,
             which is a breath rather than a ratchet. */
          punch: expressionSlot(`${HITS("kick")} - 0.25`, 0),
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
          haze: expressionSlot(`0.052 + 0.046 * ${LEVELS("low")}`, 0.075),
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
        envelope: 0.08, window: 16, settle: 0.15, hitDecay: 420,
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
