import { settings, node, edge, graph, document } from "./builders.ts";
import { ALEMBIC_WGSL } from "../shaders/alembic.wgsl.ts";

/**
 * E59 — Vault (T1171). ONE OF THE FIVE LOOKS OF E58's INSTRUMENT, shipped as its own file.
 *
 *   palette1(ramp) ─► alembic1(customWgsl: THE SAME shader E58 ships) ─► out1(output)
 *
 * ## WHAT THIS FILE IS, AND WHAT IT DELIBERATELY IS NOT
 *
 * It is not a second shader. `alembic.wgsl.ts` is imported, not copied, and every word of
 * the technique, the credit to @Xor's family, the march, the tanh shoulder and the
 * palette-as-a-node argument lives in `documents/alembic.ts` and `E58-Alembic.md`. Read
 * those; this docblock only says what THIS coordinate is.
 *
 * §T1166 shipped one example and put the other four looks in a table, on the argument that
 * five copies of one idea is five catalogue slots for one thing. The owner overruled the
 * conclusion and not the argument (§T1171): the catalogue IS the product surface, and four
 * looks that exist only as rows to type in are not shown, they are merely reachable. So the
 * four ship as documents that share one shader module, and each carries its own gradient —
 * because "the colour term is a node" is worth nothing if five files ship one gradient.
 *
 * ## THE COORDINATE: `twist` 0.5, AND THE FOLD GOES ARCHITECTURAL
 *
 * `twist` is the rotation applied to the sample axes between octaves. At 2π/3 (2.0944, what
 * E58 ships) it is exactly the `p.zxy` swizzle the family is written with, and the octaves
 * land isotropically — fibre. At 0.5 they stack on very nearly the SAME axes, so the fold
 * stops being a weave and starts being a set of parallel displacements: flat planes,
 * corners, a corridor. That axis does not exist in the golfs at all, because a swizzle can
 * only spell one angle; this file is the argument for making it a knob.
 *
 * `warpGain` 1.2 (from 1.6) keeps the planes from folding back over each other, `flare` 0
 * makes the vessel a straight corridor rather than a funnel, `wander` 0.15 / `coil` 0.3 bend
 * it just enough that the light source is around a corner, and `depthFade` 0.9 (from 0.3)
 * pulls the far end down so there is somewhere for the corridor to go.
 *
 * THE RAMP is sodium on slate: a warm near-white through amber to rust in the first third,
 * then straight to cold blue-grey and black. One warm source, cold stone, which is what
 * makes a plane read as a wall instead of as a bright fold.
 *
 * ## MEASURED
 *
 * §V147 — THE CLAIM THIS FILE MAKES ON ITS OWN is not "it differs from E58" (§T1166 already
 * asserts every look is far from every other), it is that the DIRECTIONALITY IS `twist`'s.
 * The measure is the normalised gradient's p99 over its median — a long tail over an empty
 * middle is what piecewise-constant means when you cannot segment the image — and it is a
 * ratio of two quantiles of the same frame, so exposure and ramp cannot move it. At 320x180,
 * frame 60: 21.18 as shipped against 10.06 with `twist` ALONE put back to the family's
 * 2.0944, and 25.6% of the frame flat against 16.7%. And the same one-knob move from E58's
 * own coordinate goes the same way (10.96 -> 15.63), which is what says the effect belongs to
 * the parameter and not to this file's other six numbers. See `vault-claims.gpu.test.ts`.
 *
 * COST, Dawn/Metal, whole graph, §T1156's alternating instrument at 16 rounds, keeping the
 * minimum of each cell. §V929's rule (two references of different cost, both near record)
 * could not be met on this machine — see the family note in `skein.ts` for why, and for the
 * INTERNAL criterion used instead, which is stronger: E58/E59/E60/E62 all march 72 steps at
 * 6 octaves, so the arithmetic says they MUST cost the same, and their spread inside a block
 * IS that block's error bar. One block of eight met it (spread 11%, E13 within 7% of record):
 *
 *   1280x720   E13 Prism 2.60 (rec 2.8)    E58 6.36    E59 6.85    E60 6.30   E61  9.68  E62 6.19
 *   1920x1080  E13 Prism 4.53 (rec 3.6)    E58 17.17   E59 16.74   E60 17.10  E61 25.16  E62 17.65
 *
 * ⚑ THE 1080p BLOCK IS THE ARGUMENT FOR THE INTERNAL CRITERION: E13 reads +26% there, so
 * §V929's external rule REJECTS it — and its four-way control group agrees to 5.4%, the
 * tightest of any block measured, and its octave ratio (1.47) matches the calibrated 720p
 * block's (1.51). Deflating it by E13's own offset puts E58 at 13.6, which is where §T1166
 * said the honest 1080p figure was. A block can be uniformly slow and still be internally
 * exact; the reference tells you the scale, the control group tells you the noise.
 *
 * `twist` costs nothing — it is a cos/sin of a uniform, and §T1166 measured hoisting it out
 * of the march as worth zero. This file is E58's price.
 *
 * MOTION (§V913 — the recorded row AND the whole minute, through the look instrument's own
 * arithmetic at 192x108 with its 120-frame gaps):
 *   recorded row f60->f180   0.03153
 *   whole minute, 29 gaps    mean 0.04690, min 0.02714, max 0.07042, LAST 0.06291
 * ⚑ AND HERE THE ROW IS THE PESSIMIST, which is §V913's point running the other way from
 * E58's: the row reads HALF the minute's peak and two thirds of its mean, so this file's
 * baseline understates it. The last gap is twice the row. Nothing settles.
 *   per frame, shipped: f59->60 2.972e-3   f1799->1800 3.309e-3   f3599->3600 5.356e-3
 *
 * §V923's per-clock work is NOT repeated here and that is deliberate. `travel` 0.5 and
 * `flow` 0.6 are E58's, untouched, and no override in this file reaches either — so "two
 * clocks, no third, and each measured with the other cut" is E58's claim about this shader
 * and re-asserting it four times would be four tests for one fact (§T1171's constraint).
 *
 * §V146 — same: E58 swept all twenty-three knobs and the smallest moved 78% of the frame.
 * This document uses the same twenty-three.
 *
 * LOOK BASELINE: motion 0.03153, range 0.6358, f0max 0.9139, cardFloor 0.0001.
 *
 * DUTY (§V903) / RETAINED VALUES (§V914): nothing to report, for E58's reason — no driven
 * parameters, two free-running clocks with no fixed point, every value below its own.
 */
export const vaultDocument = document(
  "e59-vault",
  "E59 Vault",
  settings({ randomSeed: 59, previewFps: 30 }),
  graph(
    [
      node("palette", "ramp", [-600, 0], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [1, 0.95, 0.84, 1] },
          { position: 0.14, color: [1, 0.72, 0.3, 1] },
          { position: 0.33, color: [0.72, 0.3, 0.12, 1] },
          { position: 0.55, color: [0.18, 0.26, 0.28, 1] },
          { position: 0.78, color: [0.04, 0.1, 0.16, 1] },
          { position: 1, color: [0.01, 0.02, 0.04, 1] },
        ],
      }, { label: "palette1" }),

      node("alembic", "customWgsl", [-300, 0], {
        source: ALEMBIC_WGSL,
        octaves: 6,
        baseFreq: 3,
        lacunarity: 2,
        warpGain: 1.2,
        twist: 0.5,
        flow: 0.6,
        drift: 1,
        radius: 2,
        flare: 0,
        squash: 0.15,
        wander: 0.15,
        coil: 0.3,
        steps: 72,
        looseness: 3,
        minStep: 0.001,
        travel: 0.5,
        lens: 1,
        exposure: 0.02,
        depthFade: 0.9,
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
