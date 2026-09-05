import { settings, node, edge, graph, document } from "./builders.ts";
import { ALEMBIC_WGSL } from "../shaders/alembic.wgsl.ts";

/**
 * E58 — Alembic (T1166). ONE TECHNIQUE, FIVE LOOKS. Credit: @Xor.
 *
 *   palette1(ramp) ─► alembic1(customWgsl: the warp-and-accumulate march) ─► out1(output)
 *
 * ## CREDIT AND THE CONSTRAINT, BECAUSE IT CAME BEFORE ANY OF THE DESIGN
 *
 * The owner brought five golfed GLSL pieces by @Xor — Cauldron, Dielectric, Archive,
 * Coronal and Wave — and asked for examples out of them. Four of the five differ only in
 * their distance estimate and their colour term; what they share is an OCTAVE-DOUBLING
 * DOMAIN WARP under a march that accumulates depth from a cheap non-Euclidean estimate and
 * tone-maps the sum with `tanh`. The technique is common currency; his specific golfed
 * source is his. So the shader beside this file is written FROM the technique and nothing
 * is transcribed, and — the part that matters most — it does not try to reproduce any of
 * his five frames, because chasing an exact picture is what would have forced an expression
 * to be copied. The five looks in the `.md` are five coordinates of THIS shader's own
 * parameter space, found by eye here. `alembic.wgsl.ts` carries the long version.
 *
 * ## ONE EXAMPLE AND NOT FIVE
 *
 * The family is one instrument at five settings, and that is the thing a reader should take
 * away — so it is one shader whose knobs ARE the axes that separate the golfs, and the five
 * looks are a table in the `.md` that the claims file parses and renders. Five documents
 * would have been five slots for one idea (§V471), four copies of the same prose to keep in
 * step, and would have hidden the shared primitive rather than shown it. There is no preset
 * selector either: a selector would have made four of the five unreachable by hand, which is
 * the opposite of the point.
 *
 * ## THE GRAPH IS THREE NODES AND THE MIDDLE ONE OWNS NO COLOUR
 *
 * Every one of the golfs ends with a colour expression frozen into its source — §T880's
 * complaint about burying a picture in a shader, exactly. This shader carries NO palette: it
 * reads its connected texture as a one-dimensional lookup, and the thing connected is a
 * `ramp`. The colour term of this family is a gradient editor. Measured as an identity
 * rather than an impression: with a flat grey ramp, 0 of 57600 pixels carry any hue.
 *
 * `out1` tone-maps with `none` on purpose — `tanh` has already done that job inside the
 * shader, and a filmic curve on top would be tone-mapping a tone-mapped image.
 *
 * ## MEASURED, on the shipped file
 *
 * COST, Dawn/Metal, whole graph, alternating short runs at two frame counts and keeping the
 * minimum of each cell (§T1156's instrument, reused verbatim). ⚠ THE CALIBRATION IS THE OTHER
 * ROWS, AND IT IS WHAT MAKES THIS REPORTABLE AT ALL: a block that does not reproduce E13's
 * and E57's recorded figures was measuring the machine. Two blocks out of a dozen did.
 *
 *                              1920x1080            1280x720
 *   E13 Prism (the datum)       3.95 (rec 3.6)      2.81 (rec 2.8)
 *   E57 Forest                  7.38 (rec 6.6)      3.67 (rec 3.3)
 *   E58 Alembic (this file)    14.47                8.38
 *   E55 Reactor                32.49 (rec 24.3)    13.5 (§T1156's, not re-measured)
 *
 * READ IT WITH ITS OWN ERROR BAR. At 720p E13 lands on its recorded value to 0.4%, so that
 * column is trustworthy and 8.38 is the number. At 1080p E13 and E57 read +10% and +12% — a
 * CONSISTENT offset, which is a lightly loaded machine rather than a broken measurement — so
 * 14.47 is about 10% high too and the honest figure is near 13 ms. E55's +34% in the same
 * block is the bias below. The RATIOS are the robust part: 3.0x E13 and 2.3x E57 at 720p,
 * 3.7x and 2.0x at 1080p, which puts this file between Forest and Reactor at both.
 *
 * ⚠ AND THE INSTRUMENT HAS A BIAS §T1156 DID NOT NAME. The LO/HI difference needs BOTH runs
 * to catch a quiet gap, and a cheap configuration's long run fits in a gap that an expensive
 * one's does not — so under bursty load the cheap rows come back calibrated and the dear ones
 * do not. One block read E13 at 3.93 (right) and E57 at 20.45 (three times its recorded 6.6)
 * in the same alternation. E13 alone is NOT a sufficient calibration; check a dear row too.
 *
 * THE TWO LEVERS are `steps` and `octaves`, and the marching cost is their product. In the
 * calibrated 1080p block: `steps` 72 -> 36 takes 14.47 to 6.82 (-53%), `octaves` 6 -> 3 takes
 * it to 8.28 (-43%). Near-linear in the march, with the ray setup and the palette read as the
 * per-pixel constants neither touches. Two further measurements, both NEGATIVE RESULTS worth
 * having — taken at 1080p on the pre-trim 100-step draft, and PAIRED inside one alternation,
 * which is the part that survives contention even when the absolutes do not:
 *   - the 1-D PALETTE LOOKUP IS FREE. One dependent texture read per march step measured
 *     15.50 ms against the same shader with the read replaced by a constant at 15.61 — no
 *     difference. "The colour term is a node" costs no frame time, which is the measurement
 *     that licenses the whole design.
 *   - HOISTING `twist`'s cos/sin OUT OF THE MARCH BUYS NOTHING. It was written hoisted and PUT
 *     BACK: 15.61 hoisted against 15.43 unhoisted. Tint already hoists a loop-invariant read
 *     of a uniform, and the hoisted form was an extra argument threaded through two functions
 *     in exchange for zero.
 *
 * MOTION (§V913 — the recorded row AND the whole minute, through the look instrument's own
 * arithmetic at 192x108 with its 120-frame gaps, because the row samples frames 60 to 180
 * and by construction cannot see anything the motion does afterwards):
 *   recorded row f60->f180      0.06073
 *   whole minute, 29 gaps       mean 0.05654, min 0.04734, max 0.07235
 *   LAST gap f3480->f3600       0.06259   — above the row
 *
 * And per FRAME, PER CLOCK, which is the measure §V923 demands and the one this file needed
 * most: there are TWO time inputs — `travel` slides the world past the eye, `flow` turns the
 * fold's phase — so a pace read off the shipped file is a pace either of them can carry.
 *   shipped        f59->60 2.473e-2   f1799->1800 2.142e-2   f3599->3600 2.525e-2
 *   march alone    f59->60 2.254e-2   f1799->1800 2.034e-2   f3599->3600 2.311e-2  (flow cut)
 *   fold alone     f59->60 1.651e-2   f1799->1800 1.520e-2   f3599->3600 1.443e-2  (travel cut)
 *   both cut       0.000e+0 at every pair — EXACTLY frozen, so there is no third clock
 *
 * ⚑ THE FIRST DRAFT OF THAT CLAIM WAS VACUOUS AND ITS OWN RED-VERIFY CAUGHT IT. It asserted
 * the SHIPPED file's pace at the end of the minute against its pace at the start; the
 * red-verify put an exponential ease on `travel` so the march settles after four seconds,
 * and the assertion PASSED, because the fold's clock kept the pixels changing at the same
 * rate. §V923 again, in a file with two clocks instead of E57's one. The shipped claim
 * measures each clock with the other one cut.
 *
 * LOOK BASELINE: motion 0.06073, range 0.7612, f0max 0.9994, cardFloor 0.0002.
 *
 * §V146 — EVERY KNOB MOVES THE PICTURE, and it was swept rather than assumed: each of the
 * twenty-three perturbed by 30% on its own at 320x180. The SMALLEST effect in the file is
 * `depthFade`, which still changes 78% of the frame by more than a quantisation step (mean
 * |Δ| 0.0133); the largest is `radius` at 0.1252 over 95% of the frame. The largest change
 * available at all is not a knob — replacing the ramp with flat grey, 0.1458.
 *
 * DUTY (§V903) and RETAINED VALUES (§V914): nothing to report, and it is a decision rather
 * than an omission. There are no driven parameters: the motion here is two free-running
 * clocks with no fixed point BY CONSTRUCTION, and a drive lane would be a lane that never
 * fires. Every value below is its own retained value.
 */
export const alembicDocument = document(
  "e58-alembic",
  "E58 Alembic",
  settings({ randomSeed: 58, previewFps: 30 }),
  graph(
    [
      node("palette", "ramp", [-600, 0], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [1, 0.97, 0.9, 1] },
          { position: 0.16, color: [1, 0.76, 0.36, 1] },
          { position: 0.38, color: [0.86, 0.22, 0.3, 1] },
          { position: 0.62, color: [0.36, 0.1, 0.5, 1] },
          { position: 0.84, color: [0.05, 0.08, 0.3, 1] },
          { position: 1, color: [0.01, 0.01, 0.04, 1] },
        ],
      }, { label: "palette1" }),

      node("alembic", "customWgsl", [-300, 0], {
        source: ALEMBIC_WGSL,
        octaves: 6,
        baseFreq: 3,
        lacunarity: 2,
        warpGain: 1.6,
        twist: 2.0944,
        flow: 0.6,
        drift: 1,
        radius: 2,
        flare: -0.15,
        squash: 0.15,
        wander: 0.4,
        coil: 0.6,
        steps: 72,
        looseness: 3,
        minStep: 0.001,
        travel: 0.5,
        lens: 1,
        exposure: 0.02,
        depthFade: 0.3,
        paletteAxis: [0.34, 0.86, 0.38],
        paletteScale: 0.5,
        paletteBias: 0.4,
        grain: 1,
      }, { label: "alembic1" }),

      node("out", "output", [0, 0], { toneMap: "none" }, { label: "out1" }),
    ],
    [
      edge("e-palette-alembic", ["palette", "out"], ["alembic", "input"]),
      edge("e-alembic-out", ["alembic", "out"], ["out", "input"]),
    ],
  ),
);
