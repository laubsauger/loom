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
 * body's whole radius.
 */
const BODY_ON_THE_KICK = "0.085 + 0.075 * clamp((op('beat1').chan.low - 0.7) / 0.28, 0, 1)";

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
          offset: -0.5,
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
          fillcolor: [1, 0.9, 0.66, 1],
          bgcolor: [0, 0, 0, 0],
          aspectcorrect: true,
        },
        {
          label: "orb1",
          parameters: {
            "center.x": drivenSlot("pathx1", 0.5),
            "center.y": drivenSlot("pathy1", 0.5),
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
      /* The deterministic fixture, not a live input: a shipped example must not open a
         device, and every gate has to see the same performance twice (§V44, §V45). */
      node("beat", "audioPattern", [-1980, 1340], { bpm: 124, amount: 1, beatsPerBar: 4 }, { label: "beat1" }),
      node(
        "mate",
        "circle",
        [-1700, -160],
        {
          mode: "fill",
          center: [0.5, 0.5],
          radius: [0.09, 0.09],
          softness: 0.18,
          fillcolor: [0.42, 0.78, 1, 1],
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
      node("pathx", "lfo", [-1980, 380], { shape: "sine", frequency: 0.19, amplitude: 0.32, offset: 0.5, phase: 0 }, { label: "pathx1" }),
      node("pathy", "lfo", [-1980, 620], { shape: "sine", frequency: 0.13, amplitude: 0.28, offset: 0.5, phase: 0.25 }, { label: "pathy1" }),
      node("matex", "lfo", [-1980, 860], { shape: "sine", frequency: 0.11, amplitude: 0.34, offset: 0.5, phase: 0.6 }, { label: "matex1" }),
      node("matey", "lfo", [-1980, 1100], { shape: "sine", frequency: 0.29, amplitude: 0.24, offset: 0.5, phase: 0.1 }, { label: "matey1" }),
      node("stand", "add", [-1420, -20], { opacity: 1 }, { label: "stand1" }),

      // ── the two live inputs, in the plan and compiled (§V363) ───────────────
      node("cam", "webcam", [-1700, 400], {}, { label: "cam1" }),
      node("clip", "movieFileIn", [-1700, 640], { file: "", playMode: "freeRun", speed: 1 }, { label: "clip1" }),
      /* BRANCH 0 understudy, 1 camera, 2 clip, and the ORDER SAYS SO (§V131) — leaving
         it to id order would let a spelling decide what plays on open. */
      node("pick", "switch", [-1140, 160], { index: 0 }, { label: "pick1" }),

      // ── the wall ────────────────────────────────────────────────────────────
      /* The published page, turned from the outside. Grid is a vec2 because a component
         publishes onto whole parameters and Tile's repeat is one — its two fields are
         columns and rows, and BOTH are uniforms, so dragging them mid-show re-partitions
         the wall without touching the 69.75 MiB ring. */
      node(
        "wall",
        "component:timeGrid@1",
        [-860, 60],
        {
          grid: [3, 3],
          spread: 1,
          mode: 1,
          // 2 Hz at 124 bpm is very nearly one tick per beat, so the tear re-deals with
          // the music instead of drifting against it.
          rate: 2,
          seed: 7,
          glitch: 0.4,
          colour: [1, 0.87, 0.74, 1],
          blend: 0.7,
        },
        {
          label: "wall1",
        },
      ),

      node("out", "output", [-560, 60], {}, { label: "out1" }),
    ],
    [
      edge("e-bed-stand", ["bed", "out"], ["stand", "in1"], 0),
      edge("e-orb-stand", ["orb", "out"], ["stand", "in2"], 1),
      edge("e-mate-stand", ["mate", "out"], ["stand", "in2"], 2),
      edge("e-stand-pick", ["stand", "out"], ["pick", "inputs"], 0),
      edge("e-cam-pick", ["cam", "out"], ["pick", "inputs"], 1),
      edge("e-clip-pick", ["clip", "out"], ["pick", "inputs"], 2),
      edge("e-pick-wall", ["pick", "out"], ["wall", "input"]),
      edge("e-wall-out", ["wall", "out"], ["out", "input"]),
    ],
  ),
);
