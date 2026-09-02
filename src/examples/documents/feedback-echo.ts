import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E1 — Feedback Echo (T153).
 *
 *   lfo ×2 ─► circle.center                                THE PEN (T518)
 *   circle ─────────────────────────► over.in1 ─► over ─┬─► output
 *                                                       │
 *            feedback ─► transform ─► blur ─► level ────┘ (over.in2)
 *                 ▲                                     │
 *                 └─────────────── feedback.in ─────────┘
 *
 * The cycle over → feedback → transform → blur → level → over is legal because exactly one
 * of its edges leaves `feedback.out`, which the Feedback manifest declares temporal (§V4).
 * The compiler splits that edge, backs the output with a ping-pong pair and appends the
 * swap after every current-frame consumer (§V22).
 *
 * The fade lives on the Feedback node itself (`persistence` 0.997, `clearColor` transparent
 * black) rather than in an extra Level: that is what `persistence` is for. Level is still
 * in the loop doing real work — `blacklevel` crushes the dimmest survivors to zero so a
 * trail actually terminates instead of asymptoting toward a permanent smear.
 *
 * ## T518 — a feedback loop is only as alive as what it is fed
 *
 * The source used to be a circle at a fixed centre, and a fixed source through a fixed
 * loop reaches a STEADY STATE: measured on Dawn, the shipped file was byte-identical from
 * frame 90 onward while 90% of its pixels sat at pure black. Nothing was broken and there
 * was nothing to watch. Two free-running LFOs on `center` turn the disc into a pen and the
 * loop into the thing that draws its path — which is what a feedback echo is FOR, and it
 * costs two nodes and no new mechanism.
 */
export const feedbackEchoDocument = document(
  "feedback-echo",
  "E1 Feedback Echo",
  settings(),
  graph(
    [
      node(
        "source",
        "circle",
        [-360, -120],
        {
          mode: "fill",
          center: [0.5, 0.5],
          radius: [0.055, 0.055],
          softness: 0.02,
          fillcolor: [1, 0.72, 0.28, 1],
          bgcolor: [0, 0, 0, 0],
        },
        {
          /**
           * T518 — THE SOURCE MOVES, and that is what makes this a piece rather than a
           * node demo. A feedback loop fed by a STATIC disc reaches a steady state and
           * then never changes again: measured on Dawn, the shipped file was byte-stable
           * from frame 90 onward (mean |Δ| between frames 90 and 240 was exactly 0.00)
           * while 90% of the frame sat at pure black. Every assertion in the file passed.
           *
           * Two LFOs on the centre turn the disc into a pen. The frequencies are
           * INCOMMENSURATE (0.31 against 0.23) so the Lissajous never closes and the
           * ribbon is different every lap; two equal — or simply related — rates would
           * retrace one closed curve and the piece would repeat.
           */
          parameters: {
            "center.x": drivenSlot("pathx1", 0.5),
            "center.y": drivenSlot("pathy1", 0.5),
          },
        },
      ),
      /**
       * FREE-RUNNING, so the path is continuous across a timeline lap (§V453, B98). The
       * LFO reads the absolute clock by design; nothing here declares otherwise.
       */
      node(
        "pathx",
        "lfo",
        [-620, -160],
        { shape: "sine", frequency: 0.31, amplitude: 0.3, offset: 0.5, phase: 0 },
        { label: "pathx1" },
      ),
      node(
        "pathy",
        "lfo",
        [-620, 40],
        { shape: "sine", frequency: 0.23, amplitude: 0.24, offset: 0.5, phase: 0.25 },
        { label: "pathy1" },
      ),
      node("over", "over", [40, -60], { opacity: 1 }, { label: "over1" }),
      node("echo", "feedback", [40, 152], {
        // T350 (§V285): the loop is a NAME — no wired back-edge, edges stay a DAG.
        source: "over1",
        /**
         * 0.997 is a MEASUREMENT, not a taste: the trail decays to 1/e in 1/(1-p) = 333
         * frames = 5.5 s at 60fps, and the disc's slower LFO has a 4.3 s period. So the
         * ribbon is just long enough to hold a whole figure and no longer. At the old
         * 0.94 the trail lived 17 frames — during which the disc moved about one percent
         * of the frame, which is why it read as a smudge rather than a path.
         */
        persistence: 0.997,
        clearColor: [0, 0, 0, 0],
      }),
      node("drift", "transform", [-160, 220], {
        // Gentle now that the SOURCE supplies the motion: over 333 surviving frames this
        // is 83 degrees of roll and a 28% shrink, which curls the old ribbon inward
        // instead of shredding it. At the old 3.5 deg/frame the tail spun a full turn in
        // a second and a half and the loop was the only thing you could see.
        t: [0, -0.0008],
        r: 0.25,
        s: [0.999, 0.999],
        p: [0, 0],
        xord: "srt",
        extend: "zero",
        aspectcorrect: true,
      }),
      node("soften", "blur", [-360, 240], { size: 1.4, filter: "gaussian", extend: "zero" }),
      node("decay", "level", [-360, 60], { blacklevel: 0.0015, whitelevel: 1, opacity: 1 }),
      node("out", "output", [260, -60]),
    ],
    [
      edge("e-source-over", ["source", "out"], ["over", "in1"]),
      edge("e-feedback-drift", ["echo", "out"], ["drift", "input"]),
      edge("e-drift-soften", ["drift", "out"], ["soften", "input"]),
      edge("e-soften-decay", ["soften", "out"], ["decay", "input"]),
      edge("e-decay-over", ["decay", "out"], ["over", "in2"]),
      edge("e-over-out", ["over", "out"], ["out", "input"]),
    ],
  ),
);
