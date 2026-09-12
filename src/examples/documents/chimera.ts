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
        foldLimit: 1.05,
        minRadius: 0.47,
        fixedRadius: 1,
        /* Exactly 1 = the identity, and the term is SKIPPED at that value rather than
           computed and multiplied by nothing. The travel to `bulbPeak` is what walks the
           object from reef/skeleton into bulb and back. */
        bulbPower: 1,
        bulbPeak: 4.2,
        /* The object's identity, and the strongest evolution axis in the file: drifting the
           seed offset merges lobes and opens shells CONTINUOUSLY. Nothing audio-driven
           reaches it — if the music decided what the object IS, silence would be a
           different object, and silence is what every thumbnail renders. */
        seedOffset: [0, 0, 0, 0],
        seedDrift: 0.26,
        /* THE SEGMENTATION KNOB. Three different rates, so the fold planes precess instead
           of turning as a rigid set — a single axis reads as the object spinning, which is
           the one thing the owner explicitly did not ask for. */
        foldSpin: [0.31, 0.47, 0.23, 0],
        detail: 2.5,
        stepScale: 0.78,
        bailout: 256,

        /* ─── THE SIX CLOCKS, and they are prime on purpose ───────────────────────────
         * 19 / 37 / 47 / 53 / 73 / 113. The combined state repeats on their product, so
         * "what is different at 15 s, 45 s and 90 s" always has an answer and it is a
         * different answer each time. This is the row's acceptance criterion expressed as
         * six numbers, and `chimera-claims.gpu.test.ts` measures it. */
        /* Where the rotation's lap STARTS, and it is load-bearing rather than cosmetic: at
           phase 0 the rotation is the identity and the object is a flat axis-aligned slab.
           Thumbnails and headless renders are taken at frame 0, so a clock starting at its
           own degenerate value ships the worst frame in the piece as the picture of it. */
        morphPhase: 0.37,
        morphPeriod: 19,
        hueTurn: 37,
        scalePeriod: 47,
        lightCycle: 53,
        characterPeriod: 73,
        seedPeriod: 113,
        /* ⚑ NEGATIVE SPACE, AND THE OWNER'S WORD WAS "OCCASIONALLY" — so it is a CLOCK, not a
           setting, and 89 keeps the six prime periods seven and still mutually prime. The
           voids are opened by the sphere fold that already makes the shells, so the distance
           estimate stays exact; a hole carved with a min/max against the chain would cost a
           step-scale and make every cost figure in this file dishonest. */
        voidPeriod: 89,
        voidTravel: 0.26,

        /* ─── THE CAMERA: parked, orbiting, and reading NO audio ─────────────────────
         * The shape carries the motion. A fractal is self-similar, so flying through one
         * makes the morph unreadable — everything changes at once and nothing reads as
         * changing. A slow lap also leaves the frame stable enough that a claim can hold it
         * and cut one lane, which is the only way an audio claim is provable (§V965).
         * ⚑ 96 s is a STARTING POINT to be judged from stills, not a fabricated bound —
         * §T1268 measured the owner choosing 240 s over an invented 60 s on E67. */
        orbitPeriod: 96,
        orbitSpeed: 1,
        orbitRadius: 12,
        orbitHeight: 1.15,
        orbitRise: 1.35,
        lens: 1.85,

        /* ─── BIOLUMINESCENCE ────────────────────────────────────────────────────────
         * The emission field is the ORBIT TRAP — the closest the chain's orbit passed to
         * the axis — so the light is structure-aware by construction and costs three
         * instructions a link rather than a field of its own. */
        veinWidth: 0.1,
        veinSpill: 2.4,
        veinBreak: 0.45,
        veinColor: [0.1, 1, 0.72, 1],

        /* ─── THE LIGHT RIG ──────────────────────────────────────────────────────────
         * Three sources of different hue, each with REACH, and a hierarchy that hands the
         * key from one to the next over `lightCycle`. §T1304c: a light with no falloff
         * lights the far side as hard as the near, and that is most of what makes a picture
         * read cheap. §T1309b: without a hierarchy it is "lights all over the place". */
        keyColor: [0.55, 0.78, 1, 1],
        fillColor: [1, 0.42, 0.6, 1],
        /* The warm one does NOT morph: rotating an orange about the luminance axis walks it
           into magenta, which is the specific way this trick fails (T1304c). */
        rimColor: [1, 0.62, 0.26, 1],
        keyIntensity: 5.2,
        rimIntensity: 3.8,
        lightReach: 5.6,
        lightDistance: 7.5,
        lightSwing: 0.35,
        ambient: 0.12,

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
        reflectFade: 5.5,

        /* ─── THE VOLUME ─────────────────────────────────────────────────────────────
         * Light visible in the air. It samples a FOUR-LINK chain, not the surface's
         * eleven: §V962's companion — a volume wants a DIFFERENT field from a surface, not
         * a cheaper one, and a short chain is genuinely smoother while still being shaped
         * like the object it surrounds. */
        hazeSteps: 28,
        hazeSharp: 26,
        hazeFalloff: 1.5,

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

          /* THE HITS OF BIOLUMINESCENCE the brief asked for by name. The veins are the
             frame's primary light, so this is the lane a viewer reads as the music. */
          veinEmission: expressionSlot(`4.95 + 2.2 * ${HITS("kick")}`, 5.5),
          /* The MEMBRANES answer on the backbeat — a different structure from the veins,
             so the two hit lanes are visibly different events rather than one gesture read
             twice (§T1279's split, learned on E57's fog and moon). */
          shellGlow: expressionSlot(`0.4 + 0.5 * ${HITS("snare")}`, 0.5),
          /* FINER REACTION TO FINER DETAIL (§T1304b): a hat widens the spill a little. The
             smallest lane in the file, on the fastest part of the signal, and it moves the
             glow around the veins rather than the veins themselves. */
          veinSpread: expressionSlot(`5 + 1.6 * ${HITS("hat")}`, 5.5),

          /* ─── THE CONTINUOUS PROPERTIES, ON RANKS ──────────────────────────────────
           * A rank rests at its MIDDLE, so each retained value below is the expression
           * evaluated at 0.5 — silence renders the shipped density exactly. */
          haze: expressionSlot(`0.15 + 0.14 * ${LEVELS("low")}`, 0.22),
          fillIntensity: expressionSlot(`3.8 + 1.6 * ${LEVELS("highMid")}`, 4.6),
          /* The creases open and close with the body of the mix. This is an AMPLITUDE on a
             morph that is already running, never the morph's own identity. */
          foldTravel: expressionSlot(`0.1 + 0.16 * ${LEVELS("level")}`, 0.18),
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
