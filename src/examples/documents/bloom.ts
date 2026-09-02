import { settings, node, edge, graph, document } from "./builders.ts";

/**
 * E4 — Bloom (T156).
 *
 *   noise(4D) ─► level(hot) ─► limit(floor) ─┬─► threshold ─► blur ─► lookup ─► add.in1
 *                                              └────────────────────────────────► add.in2
 *                                        ramp(palette) ─► lookup.lookup     add ─► output
 *
 * The project working format is rgba8unorm — deliberately, because that is what makes the
 * per-node override mean something (§V51). `level` pushes highlights past 1.0 and every
 * node from there to the composite carries
 * `format: { mode: "fixed", format: "rgba16float" }`, so the over-range values survive the
 * threshold and the blur instead of being clipped at the first target. Delete those
 * overrides and the bloom does not dim, it DISAPPEARS: the threshold sits at 1.1, and a
 * value clipped to 1.0 cannot clear it.
 *
 * Two branches converging on one Add, with `floor` fanning out to both, is also the §V6
 * case again — the expensive half of the chain is computed once.
 *
 * ## T518 — what was wrong, measured rather than judged
 *
 * The owner's report was "bloom is really not doing anything for me and is also not
 * animated", and there were three separate faults behind it.
 *
 * 1. The source was `perlin2d`. `speed` advances a noise field's FOURTH dimension, so a 2D
 *    type has no time axis at all and no parameter in the product could have animated it.
 * 2. `exp: 2.2` on a field whose |n| is below 1 CRUSHES it toward the midpoint — the whole
 *    image lived between 0.468 and 0.552 in linear — so a threshold at 0.9 passed almost
 *    nothing and the bloom had nothing to bloom.
 * 3. Once the level's window was tightened enough to make real over-range cores, the
 *    composite went DARKER than its own inputs, because a Level's black point turns
 *    everything below it into a large negative number and rgba16float keeps what rgba8unorm
 *    would have clamped. See `floor` below; it is the least obvious node in the file and
 *    the one without which there is no picture.
 */
export const bloomDocument = document(
  "bloom",
  "E4 Bloom",
  settings({ workingFormat: "rgba8unorm" }),
  graph(
    [
      /**
       * T518 — THE SOURCE HAD TO CHANGE, not gain a speed.
       *
       * This was `perlin2d`, and a 2D noise has NO TIME AXIS: `speed` advances the field's
       * fourth dimension, so on a 2D type there is no number anywhere in the product that
       * could have made this example move. That is why it measured mean |Δ| = 0.00 between
       * every pair of frames while every assertion in the file stayed green.
       *
       * `t4d: 0.37` rather than 0, and it is not decoration. Zero puts the field on a
       * LATTICE PLANE of the 4D noise, where the gradient contributions from the w
       * neighbours cancel and the amplitude collapses; the first candidate for this file
       * measured mean 24 at frame 0 against 54 at frame 300 for that reason alone, and the
       * level window below was very nearly tuned against an unrepresentative frame 0. Off
       * the plane the distribution is stationary (mean ~22 at every capture) — which also
       * matters because a gallery thumbnail is usually frame 0.
       */
      node("source", "noise", [-760, 0], {
        type: "perlin4d",
        seed: 11,
        // Small features: bloom is legible when a SMALL bright thing wears a LARGE halo,
        // and at the old 0.16 the cores came out the same size as their own glow.
        period: 0.12,
        harmon: 4,
        spread: 2,
        gain: 0.5,
        rough: 0.5,
        // 1, not 2.2. `shaped = sign(n) * |n|^exp` and |n| < 1, so an exponent above one
        // CRUSHES the field toward its midpoint: at 2.2 the whole image lived between
        // 0.468 and 0.552 in linear, which is the real reason a threshold at 0.9 passed
        // almost nothing. Measured, not reasoned: at exp 1 the field spans 0.34 to 0.70.
        exp: 1,
        amp: 1,
        offset: 0,
        mono: true,
        aspectcorrect: true,
        t4d: 0.37,
        s4d: 1,
        speed: 0.12,
      }),
      /**
       * THE HDR CURVE, and every number in it is read off the field's own distribution.
       *
       * The measured percentiles of `source` are p50 0.503, p90 0.584, p99 0.651, p999
       * 0.694. A black point of 0.605 therefore keeps roughly the top two percent, and a
       * white point of 0.65 gives them a gain of 22 — so the survivors land between 1.0
       * and about 2.0, which is exactly the over-range this example exists to protect.
       * The old pair (0.35 / 0.72) was a gain of 2.7 applied to a field that only spanned
       * 0.09, and it produced a flat mid-grey cloud with nothing to bloom.
       */
      node(
        "hot",
        "level",
        [-500, 0],
        { blacklevel: 0.605, whitelevel: 0.65, contrast: 1 },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      /**
       * THE CLAMP, and it is the node this example was missing. It looks like plumbing and
       * it is the whole difference between a bloom and nothing.
       *
       * A Level's black point is a SUBTRACTION: everything below it maps to a NEGATIVE
       * number. In an 8-bit target those clamp to zero for free, which is why the old file
       * never met this. The moment you override to rgba16float to protect the HIGHLIGHTS
       * you inherit the LOWS as well, and here the floor of the field lands at
       * (0.34 - 0.605) / 0.045 = -5.9. `add` is `front + back`, so composing the glow over
       * a field of -5.9 SUBTRACTS the glow into oblivion — measured on Dawn, the composite
       * came out DARKER than either of its inputs (p90 0.004 against the glow's own 0.771)
       * and the bloom was invisible except as a hairline rim.
       *
       * §V51's format override has a second consequence, and this node is it.
       */
      node(
        "floor",
        "limit",
        [-500, 260],
        { mode: "clamp", low: 0, high: 4, steps: 4 },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      /**
       * THE THRESHOLD SITS WHERE THE 8-BIT TARGET WOULD HAVE CLIPPED — 1.1, with the
       * softness reaching down to 0.975. That is the sentence the old 0.9 could not say.
       * What passes here is precisely what an rgba8unorm target could not have
       * represented, so deleting the format overrides does not merely dim the bloom, it
       * deletes it: a clipped 1.0 does not clear 1.1.
       */
      node(
        "bright",
        "threshold",
        [-240, -160],
        { threshold: 1.1, softness: 0.22, channel: "luminance", compare: "greater" },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      node(
        "glow",
        "blur",
        [20, -160],
        // 40 is near the Gaussian's fully-sampled limit of 42; past that the kernel is
        // undersampled and the halo picks up rings.
        { size: 40, filter: "gaussian", extend: "hold" },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      /**
       * BLOOM COLOUR — the halo's chromatic falloff, which is the thing that makes a bloom
       * look like light rather than like a blurred copy.
       *
       * The stops are crowded into the BOTTOM of the range on purpose. A blurred mask peaks
       * around 0.23 and spends most of its area far below that, so a palette spread evenly
       * over 0..1 would map the entire visible halo into its first, near-black segment.
       * Positions 0.02 / 0.06 / 0.12 / 0.22 / 0.4 put violet, red, orange and amber where
       * the pixels actually are.
       */
      node(
        "palette",
        "ramp",
        [20, 120],
        {
          type: "horizontal",
          interp: "smooth",
          phase: 0,
          period: 1,
          stops: [
            { position: 0, color: [0, 0, 0, 1] },
            { position: 0.02, color: [0.3, 0.04, 0.36, 1] },
            { position: 0.06, color: [0.9, 0.16, 0.26, 1] },
            { position: 0.12, color: [1, 0.5, 0.14, 1] },
            { position: 0.22, color: [1, 0.88, 0.55, 1] },
            { position: 0.4, color: [1, 1, 0.96, 1] },
          ],
        },
        { definitionVersion: 2 },
      ),
      node(
        "tint",
        "lookup",
        [280, -160],
        { channel: "luminance", row: 0.5, offset: 0, scale: 1 },
        // The halo is a wide, gentle gradient and 8 bits band it visibly. This node holds
        // no over-range values; it is overridden for RESOLUTION of tone, not for headroom,
        // and that is a different reason from `hot`'s.
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      node(
        "combine",
        "add",
        [540, 0],
        { opacity: 1 },
        { format: { mode: "fixed", format: "rgba16float" } },
      ),
      node("out", "output", [800, 0]),
    ],
    [
      edge("e-source-hot", ["source", "out"], ["hot", "input"]),
      edge("e-hot-floor", ["hot", "out"], ["floor", "input"]),
      edge("e-floor-bright", ["floor", "out"], ["bright", "input"]),
      edge("e-bright-glow", ["bright", "out"], ["glow", "input"]),
      edge("e-glow-tint", ["glow", "out"], ["tint", "source"]),
      edge("e-palette-tint", ["palette", "out"], ["tint", "lookup"]),
      edge("e-tint-combine", ["tint", "out"], ["combine", "in1"]),
      edge("e-floor-combine", ["floor", "out"], ["combine", "in2"]),
      edge("e-combine-out", ["combine", "out"], ["out", "input"]),
    ],
  ),
);
