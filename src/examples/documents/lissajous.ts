import { settings, node, edge, graph, document } from "./builders.ts";

/**
 * E49 — Lissajous (T947). AN X-Y OSCILLOSCOPE, SIMULATED BY ITS OWN PHYSICS.
 *
 *   gen1(pointKernel: x = sin 3θ+φt, y = sin 2θ) ─► scope1(laserPath) ─► draw1(renderPoints)
 *   draw1 ─► trace1(add) ◄─ echo1(feedback, the phosphor)
 *   trace1 ─► hot1(threshold) ─► halo1(blur) ─► glow1(add ◄ trace1) ─► out1
 *
 * ## What the picture is
 *
 * The classic scope demo: two sine waves into the deflection channels, a 3:2 Lissajous
 * figure, phosphor green, drifting as the phase between the channels moves. §T947's
 * ruling is that a scope in X-Y mode IS a vector display, and this example is the
 * planner (`laserPath`) with the planner's stages turned DOWN: corner hold is zero
 * because an electron beam has no mirrors to settle — the scope is the laser with the
 * planner switched off, one node, one fact, two instruments.
 *
 * ## Where the look comes from — mechanisms, not decoration (§T940's family)
 *
 * BRIGHTNESS IS DWELL TIME and nothing here paints it. The kernel samples the figure
 * uniformly in θ, but the FIGURE's speed varies — a Lissajous decelerates into its
 * turning points — so samples crowd where the beam moves slowly, and under additive
 * blending crowded samples ARE brightness: the lobes glow at their extremes exactly
 * where a real CRT brightens, because that is the same arithmetic the CRT does with
 * electrons. The plan (~1,200 samples) EXCEEDS the 500-point budget of 30,000 pps at
 * 60 fps, so `laserPath`'s scan window sweeps the figure at its honest ~25 Hz refresh
 * — the bright drawing head chasing around the trace is the beam, and the tail behind
 * it is `echo1`, the phosphor: `feedback` at persistence 0.9 (≈ 1/e in 10 frames, a
 * P31 phosphor's order of magnitude). The bloom is the shipped threshold → blur → add
 * chain; only what the beam deposited can glow.
 */
export const lissajousDocument = document(
  "e49-lissajous",
  "E49 Lissajous",
  settings({ randomSeed: 49 }),
  graph(
    [
      /* The signal: uniform θ, a 3:2 figure, phase creeping at 0.11 Hz so the figure
         tumbles the way the textbook photo does. Positions land directly in clip
         space — a scope face is 2D, no camera. */
      node("gen", "pointKernel", [-1500, 0], {
        capacity: 1200,
        seed: 49,
        attributes: "",
        group: "",
        kernel: `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let theta = f32(ctx.index) / 1200.0 * 6.28318530718;
  let phase = ctx.time * 0.7;
  q.position = vec3f(0.78 * sin(3.0 * theta + phase), 0.78 * sin(2.0 * theta), 0.0);
  return q;
}`,
        value1: 0, value2: 0, value3: 0, value4: 0,
      }, { label: "gen1" }),

      /* The planner in scope trim: resampling on (the beam is continuous), corner hold
         OFF (no mirrors), the scanner clock at a real 30 kpps. 1,200 points against a
         500-point frame budget = a ~25 Hz sweep, honestly. */
      node("scope", "laserPath", [-1200, 0], {
        pps: 30000,
        maxStep: 0.01,
        holdMin: 0,
        holdMax: 0,
        closed: true,
        color: [0.5, 1, 0.62, 1],
        slots: 4,
      }, { label: "scope1" }),

      /* The beam spot: small, soft, additive — deposited energy sums, which is the
         whole dwell-time mechanism. Colour is MAPPED from the plan's tint: samples
         outside this frame's scan window carry zero and draw nothing. */
      node("draw", "renderPoints", [-900, 0], {
        count: 4800, blend: "additive", accumulate: false, sizePixels: 1.8, group: "",
        color: [1, 1, 1, 1],
      }, { label: "draw1", parameters: {
        color: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
      } }),

      /* The phosphor: last frame's trace, decayed. 0.9 ≈ 1/e in ten frames — the tail
         is a beat long, so the sweeping beam leaves a whole figure on the glass. */
      node("trace", "add", [-600, 0], {}, { label: "trace1" }),
      node("echo", "feedback", [-900, 280], {
        source: "trace1",
        persistence: 0.9,
        clearColor: [0, 0, 0, 1],
      }, { label: "echo1" }),

      // ---- the glass glow: the shipped bloom chain, green already in the beam -------
      node("hot", "threshold", [-300, -160], { threshold: 0.55, softness: 0.3, channel: "luminance", compare: "greater" }, { label: "hot1" }),
      node("halo", "blur", [0, -160], { size: 22, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("glow", "add", [300, 0], {}, { label: "glow1" }),
      node("out", "output", [600, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-gen-scope", ["gen", "out"], ["scope", "points"]),
      edge("e-scope-draw", ["scope", "out"], ["draw", "points"]),
      edge("e-draw-trace", ["draw", "out"], ["trace", "in1"]),
      edge("e-echo-trace", ["echo", "out"], ["trace", "in2"]),
      edge("e-trace-hot", ["trace", "out"], ["hot", "input"]),
      edge("e-hot-halo", ["hot", "out"], ["halo", "input"]),
      edge("e-trace-glow", ["trace", "out"], ["glow", "in1"]),
      edge("e-halo-glow", ["halo", "out"], ["glow", "in2"]),
      edge("e-glow-out", ["glow", "out"], ["out", "input"]),
    ],
  ),
);
