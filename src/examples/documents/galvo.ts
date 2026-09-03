import { settings, node, edge, graph, document } from "./builders.ts";

/**
 * E50 — Galvo (T947). A SHOW LASER, SIMULATED BY ITS OWN PHYSICS. Simulation only —
 * the output stage is sequenced behind §T949's sideEffect declaration, deliberately.
 *
 *   gen1(pointKernel: 10-vertex star, slow spin) ─► beam1(laserPath, FULL planner)
 *   beam1 ─► draw1(renderPoints) ─► trace1(add) ◄─ echo1(feedback, the eye)
 *   trace1 ─► hot1(threshold) ─► halo1(blur) ─► glow1(add ◄ trace1) ─► out1
 *
 * ## What the picture is
 *
 * A scanned laser star on a dark wall. E49 Lissajous is the same planner with its
 * stages turned down; here it runs at FULL strength, because a galvo is a mirror with
 * mass: it cannot turn a corner at speed, so the planner DWELLS there — extra samples
 * at every vertex, scaled linearly by angle steepness (TD's own mincornerhold/
 * maxcornerhold formulation).
 *
 * ## The hot dots are the physics, not a decoration (§T940's family)
 *
 * Real laser art has bright dots at path vertices because the beam decelerates into
 * every corner, and a constant-brightness polyline is exactly what makes a fake look
 * fake (§T947's own words). Here the dots are never drawn: the planner inserts up to
 * fourteen coincident samples at the star's points, each sample is one tick of the
 * 30,000 pps clock rendered as a small additive splat, and fifteen ticks in one place
 * deposit fifteen times the energy. Delete the corner hold (holdMax to 0) and the dots
 * vanish; turn resampling off (maxStep to 0) and every edge goes bright-ended and
 * dim-bellied — both are the plan document's acceptance criteria, both are one knob.
 *
 * The star's ~430 samples sit INSIDE the 500-point budget of 30 kpps at 60 fps, so the
 * figure is rock steady — that is what a correctly driven scanner looks like. Drop
 * `beam1.pps` toward 5,000 and the same figure starts to crawl and flicker as the scan
 * window stops covering the plan: the overdriven-scanner artifact, from arithmetic.
 * The afterglow is the EYE, not phosphor — `echo1` at 0.55 is a much shorter tail than
 * E49's CRT — and the wide soft bloom is beam divergence on a real wall.
 */
export const galvoDocument = document(
  "e50-galvo",
  "E50 Galvo",
  settings({ randomSeed: 50 }),
  graph(
    [
      /* Ten vertices, outer/inner radius alternating: five sharp outer points (near
         full reversal, maximum dwell) and five gentler inner ones — a built-in
         contrast the corner-hold formula makes visible. The slow spin proves the dots
         ride the geometry, not the framebuffer. */
      node("gen", "pointKernel", [-1500, 0], {
        capacity: 10,
        seed: 50,
        attributes: "",
        group: "",
        kernel: `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  let i = ctx.index % 10u;
  let angle = f32(i) * 0.62831853072 - 1.57079632679 + ctx.absTime * 0.12;
  let radius = select(0.74, 0.3, (i & 1u) == 1u);
  q.position = vec3f(cos(angle) * radius, sin(angle) * radius, 0.0);
  return q;
}`,
        value1: 0, value2: 0, value3: 0, value4: 0,
      }, { label: "gen1" }),

      /* The planner at full strength: bounded galvo velocity (maxStep) and corner
         dwell (holdMin/holdMax by angle steepness). ~430 planned samples against the
         500-point budget: steady, as a correctly driven scanner is. */
      node("beam", "laserPath", [-1200, 0], {
        pps: 30000,
        maxStep: 0.016,
        holdMin: 1,
        holdMax: 14,
        closed: true,
        color: [1, 0.16, 0.06, 1],
        slots: 48,
      }, { label: "beam1" }),

      /* The spot on the wall: additive splats, colour mapped from the plan so only the
         scan window's samples emit. Slightly larger spot than E49 — a diverged beam. */
      node("draw", "renderPoints", [-900, 0], {
        count: 480, blend: "additive", accumulate: false, sizePixels: 2.4, group: "",
        color: [1, 1, 1, 1],
      }, { label: "draw1", parameters: {
        color: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "tint" } } },
      } }),

      /* The afterglow is the EYE (persistence of vision), far shorter than a CRT
         phosphor: 0.55 ≈ 1/e in under two frames. */
      node("trace", "add", [-600, 0], {}, { label: "trace1" }),
      node("echo", "feedback", [-900, 280], {
        source: "trace1",
        persistence: 0.55,
        clearColor: [0, 0, 0, 1],
      }, { label: "echo1" }),

      // ---- divergence on the wall: wide soft bloom over the raw beam ----------------
      node("hot", "threshold", [-300, -160], { threshold: 0.4, softness: 0.35, channel: "luminance", compare: "greater" }, { label: "hot1" }),
      node("halo", "blur", [0, -160], { size: 34, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("glow", "add", [300, 0], {}, { label: "glow1" }),
      node("out", "output", [600, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-gen-beam", ["gen", "out"], ["beam", "points"]),
      edge("e-beam-draw", ["beam", "out"], ["draw", "points"]),
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
