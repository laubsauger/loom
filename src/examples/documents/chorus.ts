import { settings, node, edge, graph, document, drivenSlot, expressionSlot } from "./builders.ts";

/**
 * E51 — Chorus (T956's component arc; slitScan T321, tile T242).
 *
 *   bed1(noise, perlin4d) ─┐
 *   orb1(circle) ───┤
 *   mate1(circle) ──┴─► stand1(add) ──┐ order 0
 *   cam1(webcam) ────────────────────┤ order 1 ─► pick1(switch) ─► wall1 ─► out1(output)
 *   clip1(movieFileIn) ──────────────┘ order 2                      ▲
 *
 * ## What it is
 *
 * ONE stream, played back at nine different moments at once. `wall1` is an instance of
 * the TimeGrid library component: Tile repeats the picture into a grid, SlitScan gives
 * each cell its own delay out of a one-second history, and a duotone ties the nine
 * independently-lit moments together. The performer turns eight knobs and never opens
 * the component.
 *
 * The default is Ordered — the CANON. The disc travels its path once, and the wall shows
 * nine points along that path simultaneously, oldest at the bottom right. Mode 0 is
 * unison, 2 scatters the voices, 3 rolls a freeze across the wall, 4 cuts between four
 * angles. That is what the modes ARE: a chorus singing the same line, together or apart.
 *
 * ## THE SOURCE IS A PORT, and that is the whole point of the boundary
 *
 * §V411's understudy pattern, and here it earns its place twice. The shipped branch is a
 * deterministic disc on two incommensurate LFOs — something with IDENTITY, because a wall
 * of delayed noise is a wall of noise (§V427, E8's lesson). Branch 1 is the WEBCAM: flip
 * `pick1` to 1 and the wall is nine moments of your own face, which is the thing this
 * example is actually for. Branch 2 takes a clip. The component cannot tell the three
 * apart — it takes a texture — so nothing inside it changes when you switch.
 *
 * ## THE COST, and it is the reason the component pins its own resolution
 *
 * SlitScan's ring inherits its size from its input, so an unpinned wall fed 1080p would
 * allocate 1.9 GiB. TimeGrid pins 512x288 internally: 512 x 288 x 8 B x 62 layers =
 * 69.75 MiB for 61 frames, 1.02 s at 60 fps. The SPAN sets the depth, not the cell count
 * — a ring holds a contiguous run — and 61 frames is enough for every cell of an 8x8 wall
 * to hold a moment of its own. See `starter-components.ts`, where the number is chosen.
 *
 * ## What moves — and the knob that CANNOT, which is a defect and not a choice
 *
 * The two bodies travel, so every cell's content changes and the cascade rolls. Blend and
 * Colour are STATIC, and the first draft of this file had Blend on a clock expression
 * before that turned out to be undeliverable: `flatten.ts` resolves an instance's
 * published page through `resolveNodeParameters` with NO resolution context — no `nodes`
 * reader and no `frame` — and `flattenComponents` is then memoized on the document
 * revision. So `op('x')` on a published knob warns ("node references need a graph to
 * read") and a clock expression silently evaluates `abstime` as 0: measured, frames 30,
 * 150 and 260 of a frozen world came back byte-identical. A component's parameter page
 * cannot be animated today. Reported against the compiler track; nothing here works
 * around it, because a dead expression in a shipped example is a lie about the feature.
 */
/**
 * `low` mapped off its own floor. audioPattern's bands are calibrated against real music
 * (see `audio.ts`): `low` rests at 0.713 and peaks at 0.975, so the raw channel spans a
 * quarter of its nominal range and drives almost nothing. This affine puts the kick on the
 * body's whole radius, taken off the slow envelope so it swells rather than snaps.
 *
 * ⚠ ARITHMETIC ONLY, NO `clamp()`, AND THAT IS NOT A STYLE CHOICE. `opReferenceNames` in
 * `domain/graph/parameter-dependencies.ts` walks number / variable / opRef / unary /
 * binary and has NO case for `call`, so an `op()` nested inside any whitelisted function
 * is invisible to the dependency graph — no reference line on the canvas, nothing for
 * liveness to count, nothing for the cycle gate to refuse. The first version of this file
 * wrapped the affine in `clamp(...)`, and the audio node then read as orphaned on the
 * canvas: the owner's report that "the audioPattern is not wired into anything at all"
 * was that defect, not a missing wire. Reported; not fixed here (not this track's path).
 *
 * Unclamped is honest anyway: `low` bottoms out near 0.69, which lands the radius at
 * 0.082 — a slightly smaller body, not a broken one.
 */
const BODY_ON_THE_KICK = "0.085 + 0.26 * (op('env1').chan.low - 0.7)";

/**
 * The hats, on the FAST envelope, driving how hard the whole source is lit — and through
 * that, how much of the wall breaks.
 *
 * This is the second audio gesture and it reaches the degradations, which is the thing the
 * published knobs cannot do (§T1017). The vocabulary shader arms a cell in proportion to
 * that cell's OWN BRIGHTNESS, so lifting the source on a transient arms more cells: the
 * wall tears, snows and drops out ON THE HATS without a single channel crossing the
 * component boundary. `high` rests at 0.381 and peaks at 0.574, so this rides 1.00 to
 * about 1.50 and sits at exact unity — a true identity — when nothing is playing.
 */
const LIT_ON_THE_HATS = "1 + 2.6 * (op('snap1').chan.high - 0.381)";

export const chorusDocument = document(
  "e51-chorus",
  "E51 Chorus",
  settings({ randomSeed: 11 }),
  graph(
    [
      // ── the understudy: a subject with identity, travelling ────────────────
      /* A living bed so the delayed cells differ in their BACKGROUND too, not only in
         where the disc is — nine copies of one flat colour would make the cascade read
         as a lighting trick rather than as nine moments. */
      node(
        "bed",
        "noise",
        [-1700, 120],
        {
          type: "perlin4d",
          seed: 11,
          period: 0.19,
          harmon: 3,
          spread: 2,
          gain: 0.5,
          rough: 0.5,
          // DARK, and that is the composition. The wall multiplies nine copies of this bed
          // by one colour; a bright bed makes the duotone a wash rather than a grade and
          // the subject stops being the subject. The shader centres the field on 0.5
          // (`0.5 + 0.5*shaped*amp + offset`), so the offset is what puts its mass on
          // black and leaves only the wisps — measured flat at 0.47 linear before it.
          exp: 2.1,
          amp: 1.9,
          offset: -0.36,
          mono: true,
          aspectcorrect: true,
          speed: 0.05,
          // Off the 4D lattice plane: t4d = 0 collapses the amplitude on frame 0 (T786).
          t4d: 0.41,
          s4d: 1,
        },
        { label: "bed1" },
      ),
      /* TWO bodies, not one, and on incommensurate paths: one disc gives every cell the
         same POSE at a different place, which reads as polka dots. Two give each cell a
         different CONFIGURATION — near, crossing, far apart — and a configuration is what
         a viewer reads as "a different moment". */
      node(
        "orb",
        "circle",
        [-1700, -420],
        {
          mode: "fill",
          center: [0.5, 0.5],
          radius: [0.11, 0.11],
          softness: 0.22,
          // NEUTRAL, and deliberately: Blend keeps 18% of the untinted wall, so a warm
          // body drags the graded result toward the oranges the owner ruled out. Let the
          // palette decide the hue and let the source decide only the shape.
          fillcolor: [0.94, 0.95, 1, 1],
          bgcolor: [0, 0, 0, 0],
          aspectcorrect: true,
        },
        {
          label: "orb1",
          parameters: {
            "center.x": drivenSlot("swoopa1", 0.5),
            "center.y": drivenSlot("swoopb1", 0.5),
            /*
             * THE ONE AUDIO MAPPING, and it is on the SOURCE rather than on a knob.
             *
             * Driving Spread or Rate or Blend from a band is what you would reach for
             * first, and it cannot be done: a component's published page is resolved with
             * no frame and no node reader, so a channel read there silently returns its
             * retained value (see the note at the foot of this docblock). Putting the kick
             * on the BODY is not a consolation prize — it is the mapping this instrument
             * was waiting for. Every cell holds a different moment, so ONE kick reaches
             * each cell at a different time and the pulse rolls across the wall as a wave.
             * The tear rides the same signal for free, because a cell's own brightness is
             * what arms its glitch.
             *
             * Enveloped before it touches anything visible: audioPattern's `low` sits at
             * 0.71 at rest and peaks near 0.98, so a raw drive would be a body that never
             * shrinks. The affine maps that band onto the whole radius range.
             */
            "radius.x": expressionSlot(BODY_ON_THE_KICK, 0.11),
            "radius.y": expressionSlot(BODY_ON_THE_KICK, 0.11),
          },
        },
      ),
      /*
       * ── THE AUDIO CHAIN, AND IT IS WIRED ────────────────────────────────────────────
       *
       * E24's shape, and it is the right one for the reason E24 gives: two audio sources
       * landing on one value port MERGE, and both publish the same channel names, so the
       * later edge would win and the other source would vanish with the graph still
       * looking right. `valueSwitch` is exclusive by construction — the unselected branch
       * is not read into the output at all — which also makes it the only safe way to
       * offer a live source in a shipped file.
       *
       * INDEX 0 IS THE PATTERN and stays that way: §V44/§V45 are not negotiable, a
       * shipped example must not open a device, and every gate has to see the same
       * performance twice. Index 1 is the drop target — put a track on `track1`, flip the
       * index, and everything downstream follows because everything downstream reads
       * `source1`.
       *
       * `audioIn` (the microphone) is DELIBERATELY ABSENT: a shipped one opens the device
       * on load. The `.md` says how to add it. That is E24's ruling, unchanged.
       */
      node("music", "audioPattern", [-2540, 1460], { bpm: 124, amount: 1, beatsPerBar: 4 }, { label: "music1" }),
      node("track", "audioFileIn", [-2540, 1700], { monitor: true }, { label: "track1" }),
      node("source", "valueSwitch", [-2260, 1580], { index: 0 }, { label: "source1" }),
      /*
       * TWO ENVELOPES, because the piece has two timescales and one Lag cannot be both.
       * `env1` is slow — it turns the kick into a swell the BODY rides. `snap1` is fast —
       * it keeps the transient the hats need, because what it drives is an EVENT rate
       * rather than a shape (see `flare1`).
       */
      node("env", "valueLag", [-1980, 1460], { lag: 0.11 }, { label: "env1" }),
      node("snap", "valueLag", [-1980, 1700], { lag: 0.035 }, { label: "snap1" }),
      node(
        "mate",
        "circle",
        [-1700, -160],
        {
          mode: "fill",
          center: [0.5, 0.5],
          radius: [0.09, 0.09],
          softness: 0.18,
          fillcolor: [0.62, 0.72, 0.86, 1],
          bgcolor: [0, 0, 0, 0],
          aspectcorrect: true,
        },
        {
          label: "mate1",
          parameters: {
            "center.x": drivenSlot("matex1", 0.5),
            "center.y": drivenSlot("matey1", 0.5),
          },
        },
      ),
      /* Free-running and incommensurate (§V453), and SLOW on purpose: the ring holds one
         second, so a path that crosses the frame in under a second would put the same
         gesture in every cell. 0.19 Hz and 0.13 Hz take about five seconds to repeat the
         shape, which is five ring-lengths of distinct material. */
      /*
       * ── REST, THEN STRIKE ───────────────────────────────────────────────────────────
       *
       * These were four sine LFOs and the wall wobbled continuously. The owner's verdict:
       * "I don't love the permanent wobble either. We can make some more explosive
       * movement between these things occasionally, rather than constant wobbling."
       *
       * SAMPLE-AND-HOLD on the LEAD body: it picks a new position and HOLDS it, so the orb
       * is still for several seconds and then goes somewhere. The Lag turns the jump into
       * an eased swoop rather than a teleport, which is what makes it read as a MOVE.
       *
       * The SECOND body keeps a slow sine, and dropping it would have been the mistake
       * this file nearly made: a wall whose source is perfectly still shows the SAME frame
       * in every cell, because nine different moments of a still picture are one picture.
       * So the composition is a calm continuous element plus a striking one — which is
       * what "explosive movement between these things" actually needs to be visible
       * against.
       *
       * And on this instrument a strike is worth more than it is anywhere else: every cell
       * holds a different moment, so ONE fast move arrives in each cell at a different
       * time and the wall shows the whole gesture at once, spread across the grid.
       */
      node("pathx", "lfo", [-2260, 380], { shape: "noise", frequency: 0.16, amplitude: 0.33, offset: 0.5, phase: 0 }, { label: "pathx1" }),
      node("pathy", "lfo", [-2260, 620], { shape: "noise", frequency: 0.125, amplitude: 0.28, offset: 0.5, phase: 0.25 }, { label: "pathy1" }),
      node("matex", "lfo", [-2260, 860], { shape: "sine", frequency: 0.043, amplitude: 0.34, offset: 0.5, phase: 0.6 }, { label: "matex1" }),
      node("matey", "lfo", [-2260, 1100], { shape: "sine", frequency: 0.029, amplitude: 0.24, offset: 0.5, phase: 0.1 }, { label: "matey1" }),
      node("swoopa", "valueLag", [-1980, 380], { lag: 0.3 }, { label: "swoopa1" }),
      node("swoopb", "valueLag", [-1980, 620], { lag: 0.3 }, { label: "swoopb1" }),
      node("stand", "add", [-1420, -20], { opacity: 1 }, { label: "stand1" }),

      // ── the two live inputs, in the plan and compiled (§V363) ───────────────
      node("cam", "webcam", [-1700, 400], {}, { label: "cam1" }),
      node("clip", "movieFileIn", [-1700, 640], { file: "", playMode: "freeRun", speed: 1 }, { label: "clip1" }),
      /* BRANCH 0 understudy, 1 camera, 2 clip, and the ORDER SAYS SO (§V131) — leaving
         it to id order would let a spelling decide what plays on open. */
      node("pick", "switch", [-1140, 160], { index: 0 }, { label: "pick1" }),

      /*
       * THE FLARE — the hats, made visible, and the wall's damage gate in one node.
       * At rest it is exactly unity, so the picture is unchanged when nothing plays.
       */
      node("flare", "level", [-860, 160], {
        blacklevel: 0,
        whitelevel: 1,
        gamma1: 1,
        contrast: 1,
        invert: 0,
        opacity: 1,
      }, { label: "flare1", parameters: { brightness: expressionSlot(LIT_ON_THE_HATS, 1) } }),

      /*
       * ── THE MATTE, ON A SWITCH (§V363/§V411, E47's shape) ───────────────────────────
       *
       * TimeGrid's second input is a MATTE TEXTURE, not "the matte node" — which is what
       * lets a luma key, a real person matte, a depth cut or a hand-drawn shape all feed
       * the same component. Index 0 is the understudy: a luma threshold, which is the
       * honest answer for a bright subject on a dark bed and is DETERMINISTIC, so every
       * gate and the gallery card see the dropout event actually happen.
       *
       * Index 1 is `cut1`, MODNet. Per §T715 the document loads and renders without the
       * model — the node publishes ZERO everywhere, "nobody is here", so the dropout
       * simply blanks its cell rather than failing. Flip to 1 with the webcam on and the
       * wall drops the room away from behind whoever is in front of it.
       */
      node("key", "threshold", [-580, 420], {
        threshold: 0.24,
        softness: 0.3,
        channel: "luminance",
        compare: "greater",
      }, { label: "key1" }),
      /* T1024/T1036: NOT the quantized build. It is not faster (928 ms vs 818 ms on the
         same input) and it collapses below ~0.2 mean input — measured coverage 0.037 at
         0.095 and 0.007 at 0.046, with the surviving fragment no longer on the subject.
         Pictures reach this node in LINEAR working space, ~1.5 stops under display-
         referred, so a normally-lit room lands squarely in that collapse zone: the app's
         own input buffer measured 0.049 and 0.103. The accurate build is flat across five
         stops, centroid stable to a texel. The default is the accurate one. */
      node("cut", "matte", [-580, 660], {}, { label: "cut1" }),
      node("mpick", "switch", [-300, 540], { index: 0 }, { label: "mpick1" }),

      // ── the wall ────────────────────────────────────────────────────────────
      /* The published page, turned from the outside. Grid is a vec2 because a component
         publishes onto whole parameters and Tile's repeat is one — its two fields are
         columns and rows, and BOTH are uniforms, so dragging them mid-show re-partitions
         the wall without touching the 69.75 MiB ring. */
      node(
        "wall",
        "component:timeGrid@1",
        [-20, 160],
        {
          columns: 5,
          rows: 6,
          /* Occasional, not constant: the wall holds a grid for 16-24 s and then re-cuts.
             At 5 this reaches roughly 2x2 at one end and 10x11 at the other, and the two
             axes hold independently — so most of the states it visits are NON-SQUARE,
             which is exactly the range that was stretching the picture until the cell fit
             landed.

             BACK UP TO 5, and the reason the floor is no longer an objection: this used to
             be pulled back to 3 because the sample-and-hold parked the wall at 2x2, where
             four copies of a sparse frame is not a wall. The floor is ONE now, and one
             copy of the frame IS a picture — the wall collapsing to a single delayed
             image, then re-cutting back out to nine or ten. That collapse is the gesture,
             not the failure mode.

             This spans 1 to 10 columns and 1 to 11 rows on two clocks that never realign.
             The RATE is untouched: range is what makes it dynamic, the clock is what would
             make it hectic. Past ~61 cells they share moments; that is the ring's depth,
             stated at the Span knob. */
          churn: 5,
          span: 90,
          spread: 1,
          mode: 1,
          // 2 Hz at 124 bpm is very nearly one tick per beat, so the tear re-deals with
          // the music instead of drifting against it.
          rate: 2,
          seed: 7,
          glitch: 0.4,
          chroma: 0.55,
          crush: 1.5,
          colour: [1, 0.87, 0.74, 1],
          blend: 0.82,
        },
        {
          label: "wall1",
        },
      ),

      node("out", "output", [280, 160], {}, { label: "out1" }),
    ],
    [
      edge("e-bed-stand", ["bed", "out"], ["stand", "in1"], 0),
      edge("e-orb-stand", ["orb", "out"], ["stand", "in2"], 1),
      edge("e-mate-stand", ["mate", "out"], ["stand", "in2"], 2),
      edge("e-stand-pick", ["stand", "out"], ["pick", "inputs"], 0),
      edge("e-cam-pick", ["cam", "out"], ["pick", "inputs"], 1),
      edge("e-clip-pick", ["clip", "out"], ["pick", "inputs"], 2),
      edge("e-pick-flare", ["pick", "out"], ["flare", "input"]),
      // ONE lit source, THREE consumers (§V6): the wall, the luma key and the ML matte.
      edge("e-flare-wall", ["flare", "out"], ["wall", "in1"]),
      edge("e-flare-key", ["flare", "out"], ["key", "input"]),
      edge("e-flare-cut", ["flare", "out"], ["cut", "input"]),
      edge("e-key-mpick", ["key", "out"], ["mpick", "inputs"], 0),
      edge("e-cut-mpick", ["cut", "out"], ["mpick", "inputs"], 1),
      edge("e-mpick-wall", ["mpick", "out"], ["wall", "in2"]),
      edge("e-wall-out", ["wall", "out"], ["out", "input"]),
      // The audio chain, with real wires all the way to the envelopes.
      edge("e-music-source", ["music", "out"], ["source", "in1"]),
      edge("e-track-source", ["track", "out"], ["source", "in2"]),
      edge("e-source-env", ["source", "out"], ["env", "in"]),
      edge("e-source-snap", ["source", "out"], ["snap", "in"]),
      // The bodies: hold, then swoop.
      edge("e-pathx-swoopa", ["pathx", "out"], ["swoopa", "in"]),
      edge("e-pathy-swoopb", ["pathy", "out"], ["swoopb", "in"]),
    ],
  ),
);
