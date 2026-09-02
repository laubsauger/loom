import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E26 — Interference (T475).
 *
 *   rings1(circle: distance) ─► gain1(level) ─► wrap1(limit: zigzag) ─┬──────► beat1.in1
 *                                                                     │
 *                                          warp1(transform) ◄─────────┘
 *                                                │  t.x ┄ driftx1, t.y ┄ drifty1
 *                                                └───────────────────────► beat1.in2
 *   beat1(difference) ─► tint1(lookup) ◄─ palette1(ramp) ─► out1
 *
 * THE WHOLE EXAMPLE IS THE FAN-OUT. `wrap1` is generated ONCE and consumed TWICE — once
 * as itself, once through a Transform — and the output is the difference between those
 * two readings. Nothing in this file oscillates faster than 0.05 Hz and nothing in it is
 * bigger than a few pixels, yet the picture carries enormous rosettes and hyperbolic fans
 * sweeping across the frame. That is moiré: the visible structure is the BEAT between two
 * patterns, and it belongs to neither of them.
 *
 * WHY IT IS A DISTANCE FIELD AND NOT A RADIAL RAMP. Ramp's radial coordinate is
 * `clamp(length(uv - 0.5) * 2, 0, 1)` — it saturates at radius 0.5, so a periodic radial
 * ramp is flat in the corners, which on a 16:9 frame is a fifth of the image. Circle's
 * `distance` mode is an unclamped signed distance in uv units over the WHOLE frame, and
 * aspect-correct, so the rings stay circular. Level then says how many rings there are
 * (`whitelevel` is a gain: 1/0.007 ≈ 143), and Limit in ZIGZAG mode folds that ramp into a
 * triangle wave. Zigzag rather than loop is deliberate and it is the anti-aliasing: a
 * sawtooth has a hard edge every ring and crawls under motion; a triangle wave is
 * continuous, so ~18px rings resolve cleanly instead of shimmering.
 *
 * WHY THE SECOND COPY IS OFFSET AND SCALED, NOT ROTATED. Concentric rings are
 * rotationally symmetric about their own centre: rotating them changes nothing and the
 * difference would be exactly zero — a black frame, every wire correct. What breaks the
 * symmetry is a translation (which gives hyperbolic fringes with foci at the two centres)
 * and a scale difference (which gives concentric beat rings, one every 1/(s−1) ≈ 10
 * rings). Both are present, and the two LFOs on `t` run at incommensurate rates — 0.05 Hz
 * and 0.031 Hz — so the offset traces a Lissajous figure rather than a circle and the
 * pattern does not repeat on any period a viewer will sit through.
 *
 * The Transform samples at most 2.5% outside its input, so `extend: "mirror"` shows in a
 * thin border and nowhere else; `hold` there would streak the rings radially.
 *
 * There is no WGSL in this file, no simulation, no state, and no temporal boundary. It is
 * the cheapest graph in the set that produces something you cannot read off its inputs.
 */
export const interferenceDocument = document(
  "e26-interference",
  "E26 Interference",
  settings({ randomSeed: 26 }),
  graph(
    [
      node(
        "rings",
        "circle",
        [-1160, 0],
        {
          // `distance` publishes the signed distance in red and leaves g/b at zero, so
          // everything downstream is operating on ONE channel that means "how far from
          // the centre" — never on a colour (§V56/§V57).
          mode: "distance",
          center: [0.5, 0.5],
          radius: [0.5, 0.5],
          softness: 0.005,
          fillcolor: [1, 1, 1, 1],
          bgcolor: [0, 0, 0, 0],
          aspectcorrect: true,
        },
        { label: "rings1" },
      ),
      node(
        "gain",
        "level",
        [-900, 0],
        {
          /**
           * THE RING COUNT LIVES HERE. whitelevel is the divisor in
           * `(v - black)/(white - black)`, so 0.011 is a gain of ~91 and the distance
           * field crosses ~18 full triangle periods between the centre and a corner: an
           * ~28px ring at 720p.
           *
           * 0.007 (~18px) was the first number and the look pass rejected it: at that
           * pitch the fine structure reads as corduroy across the whole frame and
           * competes with the beat rather than carrying it. Wider rings let the rosettes
           * be the subject.
           */
          blacklevel: 0,
          whitelevel: 0.011,
          invert: 0,
          gamma1: 1,
          contrast: 1,
          brightness: 1,
          opacity: 1,
        },
        { label: "gain1" },
      ),
      node(
        "wrap",
        "limit",
        [-640, 0],
        // Zigzag: `abs(fract(v/2)*2 - 1)`, which is a continuous triangle. Loop would be a
        // sawtooth with a hard edge on every ring, and hard edges at this pitch crawl.
        { mode: "zigzag", low: 0, high: 1, steps: 4 },
        { label: "wrap1" },
      ),
      node(
        "warp",
        "transform",
        [-380, 0],
        {
          t: [0, 0],
          r: 0,
          /**
           * 16% larger, so the two ring families beat once every ~6 rings — and, just as
           * load-bearing, so the Transform never samples outside its input. A scale of s
           * reads the region `0.5 ± 0.5/s`, the drift shifts that by up to its amplitude,
           * and 0.5/1.16 + 0.05 = 0.481 leaves a ~2% margin on every edge. At s = 1.1 and
           * a drift of 0.07 the window ran 2.5% PAST the edge and the extend mode showed
           * as a hard mirrored band crawling along whichever edge the drift was pushing
           * toward — visible in the render, invisible to every assertion.
           */
          s: [1.16, 1.16],
          p: [0, 0],
          xord: "srt",
          // Never reached at these numbers; it is the honest answer if someone widens the
          // drift, and a mirrored ring field folds more gracefully than a held edge.
          extend: "mirror",
          aspectcorrect: true,
        },
        {
          label: "warp1",
          parameters: {
            "t.x": drivenSlot("driftx1", 0),
            "t.y": drivenSlot("drifty1", 0),
          },
        },
      ),
      node(
        "beat",
        "difference",
        [-120, 0],
        {},
        { label: "beat1" },
      ),
      node(
        "palette",
        "ramp",
        [-120, 240],
        {
          type: "horizontal",
          interp: "smooth",
          phase: 0,
          period: 1,
          /**
           * THE PALETTE IS WHERE THIS EXAMPLE WAS WON OR LOST (V420), and the shape of it
           * is the finding: nearly half the range is FLOOR.
           *
           * The difference field puts most of its pixels in the upper half, so a palette
           * that travels evenly from 0 to 1 spends its whole journey inside the busy part
           * and the frame comes out as a uniform woven texture — correct, animated, and
           * dull. Holding 0..0.46 near black gives the image somewhere to REST, so the
           * beat reads as luminous filaments standing on a dark ground instead of as
           * corduroy. The colour then travels indigo → violet → coral → gold in the top
           * third, where the pixels actually are.
           *
           * Five candidates were rendered and looked at; this one won on having both a
           * real dark and a real hue journey. Display space, decoded per entry (§V196).
           */
          stops: [
            { position: 0, color: [0.01, 0.01, 0.04, 1] },
            { position: 0.46, color: [0.06, 0.03, 0.22, 1] },
            { position: 0.68, color: [0.42, 0.09, 0.5, 1] },
            { position: 0.83, color: [0.92, 0.25, 0.36, 1] },
            { position: 0.93, color: [1, 0.66, 0.28, 1] },
            { position: 1, color: [1, 0.97, 0.85, 1] },
          ],
        },
        { label: "palette1", definitionVersion: 2 },
      ),
      node(
        "tint",
        "lookup",
        [140, 0],
        // RED, not luminance: the whole chain carries its value in red and leaves green
        // and blue at zero, so a luminance index would read the beat at 21% strength.
        { channel: "red", row: 0.5, offset: 0, scale: 1 },
        { label: "tint1" },
      ),
      node(
        "driftx",
        "lfo",
        [-640, 240],
        { shape: "sine", frequency: 0.05, amplitude: 0.05, offset: 0, phase: 0 },
        { label: "driftx1" },
      ),
      node(
        "drifty",
        "lfo",
        [-380, 240],
        // Not 0.05: two commensurate rates trace a closed ellipse and the piece loops in
        // twenty seconds. 0.031 against 0.05 does not close.
        { shape: "sine", frequency: 0.031, amplitude: 0.05, offset: 0, phase: 0.25 },
        { label: "drifty1" },
      ),
      node("out", "output", [400, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-rings-gain", ["rings", "out"], ["gain", "input"]),
      edge("e-gain-wrap", ["gain", "out"], ["wrap", "input"]),
      // ONE generator, TWO consumers (§V6): the ring field is rendered once per frame.
      edge("e-wrap-beat", ["wrap", "out"], ["beat", "in1"]),
      edge("e-wrap-warp", ["wrap", "out"], ["warp", "input"]),
      edge("e-warp-beat", ["warp", "out"], ["beat", "in2"]),
      edge("e-beat-tint", ["beat", "out"], ["tint", "source"]),
      edge("e-palette-tint", ["palette", "out"], ["tint", "lookup"]),
      edge("e-tint-out", ["tint", "out"], ["out", "input"]),
    ],
  ),
);
