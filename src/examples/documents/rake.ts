import { settings, node, edge, graph, document } from "./builders.ts";
import { ALEMBIC_WGSL } from "../shaders/alembic.wgsl.ts";

/**
 * E62 — Rake (T1171). ONE OF THE FIVE LOOKS OF E58's INSTRUMENT, shipped as its own file.
 *
 *   palette1(ramp) ─► alembic1(customWgsl: THE SAME shader E58 ships) ─► out1(output)
 *
 * ## WHAT THIS FILE IS
 *
 * Not a second shader: `alembic.wgsl.ts` is imported, not copied. The technique, the credit
 * to @Xor's family, the march, the tanh shoulder and the palette-as-a-node argument all live
 * in `documents/alembic.ts` and `E58-Alembic.md`. This docblock says what THIS coordinate is.
 *
 * ## THE COORDINATE: DEPTH DRIVES THE PHASE
 *
 * `drift` is how much the marching depth `z` enters the fold's phase. At E58's 1 it is a
 * gentle shear that gives the fibres a wake. At 2.4 it is the dominant term in the phase and
 * the fold turns over more than twice as fast along the ray as it does across the frame — so
 * every structure is drawn out along its own depth into a straight comb, and the picture
 * stops being fibre and becomes rays.
 *
 * The other four values are there to let that be seen and nothing else. `wander` 0 and `coil`
 * 0 put the vessel's axis exactly on the ray's, `flare` 0.28 (positive, where E58 is -0.15)
 * closes the tube with depth into a narrow funnel instead of opening it, `radius` 0.9 brings
 * the wall close, and `looseness` 4 softens the step so the rays are combed rather than
 * ridged. With `wander`, `coil` and the fold all off this vessel is exactly a solid of
 * revolution — so every asymmetry visible in the frame is the fold, and its direction is
 * `drift`'s.
 *
 * `exposure` 0.0035, well under E58's 0.02: an axisymmetric funnel puts far more of the
 * frame near the wall at once than E58's wandering throat does, and at E58's gain the whole
 * picture sits on the tanh shoulder and the combing is lost in white.
 *
 * THE RAMP is a deliberately narrow one — warm white, straw, amber, umber, near-black — and
 * that is a decision rather than a default. The claim of this file is a DIRECTION, and a
 * gradient that swings through several hues would have the eye reading colour boundaries as
 * structure. One hue, and every line you see is the comb.
 *
 * ## MEASURED
 *
 * §V147 — THE CLAIM THIS FILE MAKES ON ITS OWN is the COMB: the share of the frame's gradient
 * energy running ACROSS the rays from the frame centre, because a streak lying ALONG a ray has
 * its gradient perpendicular to it. 0.5 is the value at which neither direction wins. At
 * 320x180, frame 60, sweeping `drift` with nothing else touched:
 *   drift  0     0.5316
 *          0.5   0.5448
 *          1     0.5481
 *          1.6   0.5611
 *          2.4   0.6004   <- as shipped, and monotone up to it
 *
 * ⚑ AND THE CONTROL THAT KEEPS THE SENTENCE HONEST: the SAME knob on E58's own coordinate
 * moves it the OTHER WAY — 0.5390 at `drift` 0 down to 0.5198 at 2.4. So what this file shows
 * is an interaction, depth in the phase on a vessel whose axis is the ray's, and not something
 * `drift` does to any picture. Both halves are asserted in `rake-claims.gpu.test.ts`.
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
 * `drift` is one multiply-add inside the fold. This file is E58's price.
 *
 * MOTION (§V913 — the row AND the whole minute, at 192x108 with 120-frame gaps):
 *   recorded row f60->f180   0.11484
 *   whole minute, 29 gaps    mean 0.08026, min 0.02691, max 0.16535, LAST 0.04195
 *   per frame, shipped: f59->60 5.830e-2   f1799->1800 2.722e-2   f3599->3600 1.858e-2
 * ⚑ THOSE THREE PER-FRAME READINGS LOOK LIKE A DECAY AND ARE NOT ONE, which is exactly the
 * mistake §V923 is about, caught by looking at the series rather than at three instants: the
 * 29 gaps run 0.115 0.097 0.027 0.054 0.091 ... 0.160 0.165 ... 0.103 0.097 0.100 0.042, so
 * the MAXIMUM is at 34 seconds and the minimum at 6. It fluctuates by a factor of six and
 * trends nowhere. Nothing here can settle by construction — the vessel is measured in
 * eye-relative coordinates, so no term grows with the clock — and the series says so.
 *
 * §V923's per-clock work and §V146's knob sweep are NOT repeated: `travel` and `flow` are
 * E58's, untouched, and the knob set is the same twenty-three (§T1171).
 *
 * LOOK BASELINE: motion 0.11484, range 0.5028, f0max 0.7643, cardFloor 0.0053.
 *
 * DUTY (§V903) / RETAINED VALUES (§V914): nothing to report, for E58's reason — no driven
 * parameters, two free-running clocks with no fixed point, every value below its own.
 */
export const rakeDocument = document(
  "e62-rake",
  "E62 Rake",
  settings({ randomSeed: 62, previewFps: 30 }),
  graph(
    [
      node("palette", "ramp", [-600, 0], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [1, 0.98, 0.92, 1] },
          { position: 0.2, color: [1, 0.85, 0.5, 1] },
          { position: 0.45, color: [0.92, 0.6, 0.18, 1] },
          { position: 0.68, color: [0.55, 0.26, 0.06, 1] },
          { position: 0.86, color: [0.16, 0.07, 0.02, 1] },
          { position: 1, color: [0.02, 0.01, 0.01, 1] },
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
        drift: 2.4,
        radius: 0.9,
        flare: 0.28,
        squash: 0.15,
        wander: 0,
        coil: 0,
        steps: 72,
        looseness: 4,
        minStep: 0.001,
        travel: 0.5,
        lens: 1,
        exposure: 0.0035,
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
