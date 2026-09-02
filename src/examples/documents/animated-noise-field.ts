import { settings, node, edge, graph, document } from "./builders.ts";

/**
 * E3 — Animated Noise Field (T155).
 *
 *   noise(perlin4d) ─┬─► level ─► displace.source ─► output
 *                    └────────────► displace.disp
 *
 * `type: "perlin4d"` with `speed` non-zero is the TD animation idiom: the fourth dimension
 * advances from `FrameEvaluationInput.timeSeconds` through the shared frame block, so the
 * field evolves without anything in the graph reading a clock (§V44 — a node cannot reach
 * one; it is lint-enforced). A fixed-step offline render and the live preview therefore
 * produce the same frame for the same `frameIndex`.
 *
 * One Noise node, two consumers: §V6 says that renders ONCE and both consumers sample the
 * same texture. The self-displacement is also the cheapest way to make 4D noise stop
 * looking like 4D noise — the field warps itself, which no single Noise node can do.
 */
export const animatedNoiseFieldDocument = document(
  "animated-noise-field",
  "E3 Animated Noise Field",
  settings(),
  graph(
    [
      node("field", "noise", [-360, 0], {
        type: "perlin4d",
        seed: 3,
        period: 0.22,
        harmon: 3,
        spread: 2,
        gain: 0.5,
        rough: 0.5,
        exp: 1,
        amp: 1,
        offset: 0,
        mono: true,
        aspectcorrect: true,
        t4d: 0.37, // T535: off the 4D lattice plane, where t4d=0 collapses amplitude — frame 0 (the thumbnail) was flatter than every frame after it
        s4d: 1,
        speed: 0.35,
      }),
      node("shape", "level", [-100, -80], { blacklevel: 0.15, whitelevel: 0.85, contrast: 1.35 }),
      node("warp", "displace", [160, 0], {
        weight: [0.06, 0.06],
        offset: [0.5, 0.5],
        sourcex: "red",
        sourcey: "green",
        extend: "mirror",
      }),
      node("out", "output", [420, 0]),
    ],
    [
      edge("e-field-shape", ["field", "out"], ["shape", "input"]),
      edge("e-shape-warp", ["shape", "out"], ["warp", "source"]),
      edge("e-field-warp", ["field", "out"], ["warp", "disp"]),
      edge("e-warp-out", ["warp", "out"], ["out", "input"]),
    ],
  ),
);
