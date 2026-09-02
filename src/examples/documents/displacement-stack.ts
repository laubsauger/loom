import { settings, node, edge, graph, document, expressionSlot } from "./builders.ts";

/**
 * E6 — Displacement Stack (T156).
 *
 *   checker ────────────────────────────────► displace.source ─► output
 *   noise(4D) ─► level ─► transform ─► displace.disp
 *                          r ← abstime
 *
 * T518: the field was `simplex2d`, which has no time axis, so the plate was frozen — mean
 * |Δ| of exactly 0.00 between frames on Dawn. It is `perlin4d` now, and `place.r` turns as
 * well, so the two motions in the branch are the two jobs the branch has: the field
 * EVOLVES (Level shapes what it produces) and it is also PLACED (Transform decides where
 * it lands). Watching them separately is the argument for the stack being a stack.
 *
 * The displacement branch is a STACK, not a single Noise: shaping the field (Level) and
 * placing it (Transform) before it reaches `displace.disp` is how a displacement is
 * actually authored, and it is also where the §V56/§V57 discipline gets tested. Every node
 * in that branch inherits its format from its input, so the branch has ONE space from end
 * to end and nothing along it converts anything. The field arrives at Displace as the
 * numbers Noise produced.
 *
 * `sourcex`/`sourcey` name the channels explicitly and `offset` is [0.5, 0.5] because the
 * Noise output is a 0..1 field, so 0.5 is "no displacement". Those three parameters are the
 * contract between the two branches; leaving them at defaults happens to work here and
 * would not if the field were signed.
 *
 * WHAT THIS EXAMPLE DOES NOT DO, and why: §V56 flags a genuinely non-colour texture as
 * `data`, and the compiler derives that flag from the format — `r32float` is the only
 * format in the catalogue that produces it. The plan binds ONE shared sampler, created with
 * linear filtering, to every texture, and `r32float` is not filterable on WebGPU without
 * the optional `float32-filterable` feature. So a `data`-flagged displacement field would
 * not render on a baseline Tier B device today. The example takes the renderable path and
 * `runner.test.ts` covers the `data` path as a compile-only case beside it, rather than
 * shipping an example that cannot render.
 */
export const displacementStackDocument = document(
  "displacement-stack",
  "E6 Displacement Stack",
  settings(),
  graph(
    [
      node("plate", "checker", [-520, -140], {
        size: [10, 6],
        offset: [0, 0],
        color1: [0.04, 0.06, 0.1, 1],
        color2: [0.85, 0.87, 0.95, 1],
      }),
      /**
       * T518 — `simplex2d` had no time axis, so this file could not move at all: measured
       * mean |Δ| of exactly 0.00 between frames 90 and 240 on Dawn. `perlin4d` at the same
       * period and harmonic count keeps the field's character and gives it a fourth
       * dimension for `speed` to advance. `t4d: 0.37` starts it off the 4D lattice plane,
       * where the amplitude would otherwise collapse for the first frames (see E4).
       */
      node("field", "noise", [-520, 120], {
        type: "perlin4d",
        seed: 5,
        period: 0.3,
        harmon: 2,
        spread: 2,
        gain: 0.55,
        rough: 0.5,
        exp: 1,
        amp: 1,
        offset: 0,
        mono: true,
        aspectcorrect: true,
        t4d: 0.37,
        s4d: 1,
        speed: 0.1,
      }),
      /**
       * The window narrowed from 0.2..0.8 to 0.33..0.67 because a 4D perlin's usable range
       * is narrower than a 2D simplex's — at the old numbers the same `weight` produced a
       * visibly weaker warp than the file used to ship. The MIDPOINT is unchanged at 0.5,
       * which is the part that matters: `warp.offset` below is 0.5 and means "no
       * displacement", and that contract survives only while the shaping stays centred.
       */
      node("shape", "level", [-260, 120], {
        blacklevel: 0.33,
        whitelevel: 0.67,
        gamma1: 1.2,
        contrast: 1.1,
      }),
      node(
        "place",
        "transform",
        [0, 120],
        {
          t: [0.05, -0.03],
          r: 12,
          s: [1.4, 1.4],
          p: [0, 0],
          xord: "srt",
          extend: "mirror",
          aspectcorrect: true,
        },
        // The field EVOLVES (noise speed) and is also PLACED differently over time, and
        // those are two different motions doing two different jobs — which is the whole
        // reason `shape` and `place` are separate nodes. ABSOLUTE clock (§V453).
        // T583: `% 360` guard removed — see E5; T537 made it unnecessary.
        { parameters: { r: expressionSlot("abstime * 4", 12) } },
      ),
      node("warp", "displace", [260, -60], {
        weight: [0.18, 0.13],
        offset: [0.5, 0.5],
        sourcex: "red",
        sourcey: "green",
        extend: "mirror",
      }),
      node("out", "output", [520, -60]),
    ],
    [
      edge("e-plate-warp", ["plate", "out"], ["warp", "source"]),
      edge("e-field-shape", ["field", "out"], ["shape", "input"]),
      edge("e-shape-place", ["shape", "out"], ["place", "input"]),
      edge("e-place-warp", ["place", "out"], ["warp", "disp"]),
      edge("e-warp-out", ["warp", "out"], ["out", "input"]),
    ],
  ),
);
