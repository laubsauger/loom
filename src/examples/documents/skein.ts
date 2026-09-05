import { settings, node, edge, graph, document } from "./builders.ts";
import { ALEMBIC_WGSL } from "../shaders/alembic.wgsl.ts";

/**
 * E61 — Skein (T1171). ONE OF THE FIVE LOOKS OF E58's INSTRUMENT, shipped as its own file.
 *
 *   palette1(ramp) ─► alembic1(customWgsl: THE SAME shader E58 ships) ─► out1(output)
 *
 * ## WHAT THIS FILE IS
 *
 * Not a second shader: `alembic.wgsl.ts` is imported, not copied. The technique, the credit
 * to @Xor's family, the march, the tanh shoulder and the palette-as-a-node argument all live
 * in `documents/alembic.ts` and `E58-Alembic.md`. This docblock says what THIS coordinate is.
 *
 * ## THE COORDINATE: NINE OCTAVES THAT COME OUT COARSER THAN SIX
 *
 * This is the row that looks like a contradiction on the parameter page and is arithmetic.
 * The fold's frequency starts at `baseFreq` and multiplies by `lacunarity` each octave, so
 * the FINEST detail in the picture sits at `baseFreq * lacunarity^(octaves-1)`:
 *
 *   E58 Throat   3.0 x 2.00^5  =  96.0
 *   E61 Skein    1.6 x 1.25^8  =   9.5
 *
 * Ten times coarser, with half again as many octaves. That is what a dense low-lacunarity
 * stack buys: the octaves are packed so closely in frequency that no single one of them is
 * the detail, and the displacement accumulates into long smooth sheets instead of resolving
 * into fibre. It reads as ribbon — silk rather than thread — and it is the one look in the
 * family whose cost is materially above the rest, because nine octaves is nine.
 *
 * `warpGain` 1 (from 1.6) is not a taste knob here: amplitude is `warpGain / f`, and with
 * nine terms whose frequencies barely separate, 1.6 folds the domain back over itself and
 * the sheets tear.
 *
 * THE RAMP is a shot silk — cream through chartreuse into jade and teal. Green because it
 * is the one hue family neither E58 (gold/magenta) nor E60 (blue/violet) occupies, and
 * because a broad smooth sheet is where a gradient's MIDDLE is actually visible: on E58's
 * fibre the ramp reads as edge colour, here it reads across the whole width of a ribbon.
 *
 * ## MEASURED
 *
 * §V147 — THE CLAIM THIS FILE MAKES ON ITS OWN is ELONGATION: the mean structure-tensor
 * coherence weighted by local gradient energy, which asks how consistently one direction wins
 * in a small window. A share in [0,1] built from gradient ratios, so exposure and ramp cannot
 * move it. At 320x180, frame 60:
 *   THIS FILE                       0.5471   <- the highest of the five looks
 *   this file with E58's fold back  0.3390   <- and it lands where E58 lands
 *   E58 Throat 0.3514, E60 Snarl 0.3819, E62 Rake 0.4715, E59 Vault 0.4857
 * The control is the WHOLE fold, which is honest rather than lazy: this file's overrides ARE
 * the fold and nothing else. See `skein-claims.gpu.test.ts`.
 *
 * ⚑ TWO PREMISES DIED IN THE MEASUREMENT AND BOTH ARE RECORDED IN THE `.md`, because a doc
 * that reports only its wins is not evidence. (1) The finest octave here is 1.6 x 1.25^8 =
 * 9.5 against E58's 3 x 2^5 = 96 — ten times coarser, real arithmetic — but the frame's
 * autocorrelation falls below half at lag 9 against E58's-fold 12, i.e. FINER not coarser, so
 * "coarse stack, coarse picture" is asserted nowhere. (2) It is NOT the octave count: drop to
 * six and hold the rest and elongation RISES to 0.6207; knob by knob `warpGain` carries most
 * of it (0.3523 alone). Nine octaves are what lacunarity 1.25 costs to span any frequency
 * range; the ribbon is the stack and the gain together and no single number owns it.
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
 * ⚑ THIS IS THE ONE THAT COSTS, AND IT COSTS EXACTLY THE OCTAVE RATIO. 9.68 against the
 * six-octave four's mean of 6.43 is 1.51x, where 9/6 is 1.50. Corroborated across all eight
 * blocks by dividing by each block's own cheapest six-octave row — the least contaminated
 * cell available — which gives 1.31 to 1.56 with a median near 1.49. And measured DIRECTLY,
 * paired inside one alternation: E58's own document at `octaves` 9 read 10.72 against this
 * file's 10.98, 2% apart, so the whole of the extra is the octave count and nothing else in
 * the fold. §T1166's "the marching cost is `steps` x `octaves`" holds across the family.
 *
 * ⚠ AND AN INSTRUMENT BIAS §V929 DOES NOT NAME, found here and worth having: THE POSITION IN
 * THE ALTERNATION IS NOT NEUTRAL. In five of six blocks with E58 second, E58 read ~25% above
 * the other three six-octave looks; reversing the order moved that inflation onto whichever
 * file was then second (E62), not onto E58. The row after the reference eats the reference's
 * tail. So V929's "carry two references" wants a third clause: carry a CONTROL GROUP of
 * configurations the arithmetic says must price identically, and treat their spread as the
 * block's error bar — it certifies a block from the inside, with no recorded value at all.
 *
 * MOTION (§V913 — the row AND the whole minute, at 192x108 with 120-frame gaps):
 *   recorded row f60->f180   0.25675
 *   whole minute, 29 gaps    mean 0.14671, min 0.07528, max 0.29574, LAST 0.14229
 * ⚠ THE ROW IS THE OPTIMIST HERE — it lands near the minute's MAXIMUM and is 1.75x its mean,
 * so read the baseline as a lively window rather than as this file's pace. Nothing settles;
 * the last gap is the mean.
 *   per frame, shipped: f59->60 3.235e-2   f1799->1800 3.667e-2   f3599->3600 1.818e-2
 *
 * §V923's per-clock work and §V146's knob sweep are NOT repeated: `travel` and `flow` are
 * E58's, untouched, and the knob set is the same twenty-three (§T1171).
 *
 * LOOK BASELINE: motion 0.25675, range 0.9919, f0max 0.9994, cardFloor 0.0025.
 *
 * DUTY (§V903) / RETAINED VALUES (§V914): nothing to report, for E58's reason — no driven
 * parameters, two free-running clocks with no fixed point, every value below its own.
 */
export const skeinDocument = document(
  "e61-skein",
  "E61 Skein",
  settings({ randomSeed: 61, previewFps: 30 }),
  graph(
    [
      node("palette", "ramp", [-600, 0], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [1, 0.99, 0.86, 1] },
          { position: 0.16, color: [0.86, 0.95, 0.5, 1] },
          { position: 0.36, color: [0.3, 0.78, 0.5, 1] },
          { position: 0.6, color: [0.08, 0.44, 0.46, 1] },
          { position: 0.82, color: [0.03, 0.15, 0.22, 1] },
          { position: 1, color: [0.01, 0.02, 0.04, 1] },
        ],
      }, { label: "palette1" }),

      node("alembic", "customWgsl", [-300, 0], {
        source: ALEMBIC_WGSL,
        octaves: 9,
        baseFreq: 1.6,
        lacunarity: 1.25,
        warpGain: 1,
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
