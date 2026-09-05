import { settings, node, edge, graph, document } from "./builders.ts";
import { ALEMBIC_WGSL } from "../shaders/alembic.wgsl.ts";

/**
 * E60 — Snarl (T1171). ONE OF THE FIVE LOOKS OF E58's INSTRUMENT, shipped as its own file.
 *
 *   palette1(ramp) ─► alembic1(customWgsl: THE SAME shader E58 ships) ─► out1(output)
 *
 * ## WHAT THIS FILE IS
 *
 * Not a second shader: `alembic.wgsl.ts` is imported, not copied. The technique, the credit
 * to @Xor's family, the march, the tanh shoulder and the palette-as-a-node argument all live
 * in `documents/alembic.ts` and `E58-Alembic.md`. This docblock says what THIS coordinate is.
 *
 * ⚠ THE NAME. §T1166's table called this row *Corona*, and E31 Corona has shipped since long
 * before it and is the reel's opening shot. Two catalogue entries with one name is not a
 * thing to leave standing, so the row is renamed here and in E58's table (§T1171). *Snarl*
 * is deliberately the opposite of *Skein*: a skein is thread wound in order, a snarl is the
 * same thread lost, and E61 and this file are the two ends of what the fold can do to a
 * filament.
 *
 * ## THE COORDINATE: THE VESSEL OPENS AND ITS AXIS CORKSCREWS WIDE
 *
 * E58 marches down a tube with a dark eye at the end of it. Here `wander` 1.1 (from 0.4)
 * strays the vessel's axis nearly its own radius away from the ray, `coil` 1.4 (from 0.6)
 * winds that stray more than twice as fast with depth, `radius` 1.4 (from 2) brings the wall
 * in and `flare` 0 stops it tapering. The throat is gone: nothing in the frame is a hole any
 * more, because there is no depth at which the wall is far from every ray at once.
 *
 * `looseness` 5 (from 3) makes the steps small near the wall so the filaments are soft and
 * numerous rather than hard, `depthFade` 0.15 (from 0.3) lets the far ones keep their weight
 * so the storm has depth in it, and `exposure` 0.012 pulls the whole thing back off white.
 *
 * THE RAMP is cold, which is the other half of the difference from E58: white through pale
 * cyan and azure into indigo and violet-black. Gold on this geometry would read as fire; the
 * cold ramp is what makes the same filaments read as a discharge.
 *
 * ## MEASURED
 *
 * §V147 — THE CLAIM THIS FILE MAKES ON ITS OWN is the INVERSION, not a difference: the mean
 * luma of a centred disc over the mean of the whole frame. Below 1 the middle of the picture
 * is darker than the picture, which is a hole; above 1 it is not. At 320x180, frame 60:
 *   E58 Throat, as shipped                    0.548   <- the eye this file removes
 *   THIS FILE, as shipped                     2.106   <- the centre is twice the frame
 *   this file with E58's wander/coil/radius   0.685   <- the hole comes straight back
 * A ratio of two means of the same frame, so the cold ramp and the lower exposure cannot
 * carry it. See `snarl-claims.gpu.test.ts`.
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
 * `looseness` 5 does NOT show up as cost, and that is worth stating because it reads like it
 * should: it divides the estimate, so the steps are smaller, but the loop count is `steps`
 * and nothing else. This file is E58's price.
 *
 * MOTION (§V913 — the row AND the whole minute, at 192x108 with 120-frame gaps):
 *   recorded row f60->f180   0.13296
 *   whole minute, 29 gaps    mean 0.13024, min 0.08427, max 0.16106, LAST 0.12283
 * The steadiest of the family: the row is the minute's mean to 2%. Twice E58's motion, which
 * is what an open vessel with no still centre in it looks like.
 *   per frame, shipped: f59->60 3.791e-2   f1799->1800 3.532e-2   f3599->3600 3.319e-2
 *
 * §V923's per-clock work is NOT repeated here and that is deliberate: `travel` 0.5 and
 * `flow` 0.6 are E58's, untouched, so "two clocks and no third" is E58's claim about this
 * shader, and re-asserting it four times would be four tests for one fact (§T1171).
 * §V146 likewise — E58 swept all twenty-three knobs; this document uses the same twenty-three.
 *
 * LOOK BASELINE: motion 0.13296, range 0.8572, f0max 1, cardFloor 0.0016.
 *
 * DUTY (§V903) / RETAINED VALUES (§V914): nothing to report, for E58's reason — no driven
 * parameters, two free-running clocks with no fixed point, every value below its own.
 */
export const snarlDocument = document(
  "e60-snarl",
  "E60 Snarl",
  settings({ randomSeed: 60, previewFps: 30 }),
  graph(
    [
      node("palette", "ramp", [-600, 0], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [0.92, 0.99, 1, 1] },
          { position: 0.15, color: [0.45, 0.9, 0.95, 1] },
          { position: 0.35, color: [0.16, 0.45, 0.9, 1] },
          { position: 0.58, color: [0.24, 0.16, 0.7, 1] },
          { position: 0.8, color: [0.1, 0.03, 0.24, 1] },
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
        radius: 1.4,
        flare: 0,
        squash: 0.15,
        wander: 1.1,
        coil: 1.4,
        steps: 72,
        looseness: 5,
        minStep: 0.001,
        travel: 0.5,
        lens: 1,
        exposure: 0.012,
        depthFade: 0.15,
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
