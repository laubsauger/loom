import { settings, node, edge, graph, document, drivenSlot, expressionSlot } from "./builders.ts";

/**
 * E5 — Kaleidoscope (T156).
 *
 *   ramp(circular) ─► transform(mirror) ─► tile(mirror x+y) ─► transform(repeat) ─► output
 *          phase ← abstime          r ← abstime        offset ← lfo ×2      r ← abstime
 *
 * Three extend modes in one chain — `mirror` on the fold, the Tile node's own mirroring,
 * `repeat` on the spin — which is what makes a kaleidoscope a kaleidoscope rather than a
 * rotated image with black corners. Getting `extend` wrong is invisible in the middle of
 * the frame and obvious at the edges, so the edges ARE the test.
 *
 * ## T518 — it was static, and it was also invisible
 *
 * Every transform parameter used to be a literal, so nothing in the file moved; the owner
 * asked for "translate rotation or something" and that instinct is right, because a
 * kaleidoscope's whole appeal is the slow drift of a source through fixed mirror lines.
 * Both rotations and the tile offset now move, on the ABSOLUTE clock (§V453) and at rates
 * that do not divide into each other.
 *
 * The second fault was worse and had gone unreported: the source was a `circle` in
 * `distance` mode, which publishes the signed distance in RED and leaves green and blue at
 * zero. `fillcolor` and `bgcolor` were never reaching the picture. The shipped frame was a
 * single-hue red field whose brightest pixel measured 43 out of 255 — and the paired `.md`
 * described "warm on deep blue", which the file had never rendered.
 *
 * The source carries a fixed 2048x2048 resolution override (§V50) and every node after it
 * inherits, so the whole chain runs at 2048x2048 while the project is set to 1280x720. A
 * chain of pure-sampling nodes is cheap enough to run above the project resolution, and
 * doing so is what keeps the mirrored seams from aliasing.
 *
 * The tile count is EVEN (2x2, not the old 3x3) and that is a correctness fix rather than
 * a taste one: a mirrored tiling alternates flipped and unflipped cells, so it is periodic
 * across the frame boundary only at even counts. At 3x3 the `repeat` extend on `spin`
 * wrapped an unmirrored edge onto a mirrored one and drew a hard diagonal seam that swept
 * across the frame — present in every rotated capture, absent from every unrotated one.
 *
 * Note where the override stops: it does not, currently. The Output node declares no
 * `resolutionPolicy`, so its target falls back to its input's size and the presented target
 * is 2048x2048 too, not the project's 1280x720. That is the compiler's current default
 * rather than something this example asks for — `concepts.test.ts` therefore pins the
 * CHAIN's resolution and deliberately says nothing about the sink's.
 */
export const kaleidoscopeDocument = document(
  "kaleidoscope",
  "E5 Kaleidoscope",
  settings(),
  graph(
    [
      /**
       * T518 — THE SOURCE IS A COLOUR WHEEL, and the old one could not have been.
       *
       * This was a `circle` in `distance` mode, and `distance` publishes the signed
       * distance in RED and leaves green and blue at zero. So `fillcolor` and `bgcolor`
       * were never reaching the picture at all: the shipped frame was a single-hue red
       * field whose brightest pixel measured 43/255, and the paired `.md` described it as
       * "warm on deep blue", which it had never been.
       *
       * A `circular` ramp is the right source for a kaleidoscope for a reason that is not
       * taste: its coordinate is the ANGLE about the centre, so it is periodic, and with
       * `period` 0.5 the palette wraps twice around the circle — the pattern arrives with
       * rotational symmetry already in it, before the fold and the tile add theirs.
       *
       * The stops are CYCLIC — the last colour equals the first — because `phase` scrolls
       * a ramp by `fract((coord + phase) / period)`. With any other last stop the scroll
       * would jump every time it wrapped.
       */
      node(
        "source",
        "ramp",
        [-760, 0],
        {
          type: "circular",
          interp: "smooth",
          period: 0.5,
          phase: 0,
          stops: [
            { position: 0, color: [0.02, 0.02, 0.09, 1] },
            { position: 0.2, color: [0.22, 0.06, 0.42, 1] },
            { position: 0.4, color: [0.85, 0.18, 0.32, 1] },
            { position: 0.6, color: [1, 0.63, 0.22, 1] },
            { position: 0.8, color: [0.32, 0.78, 0.72, 1] },
            { position: 1, color: [0.02, 0.02, 0.09, 1] },
          ],
        },
        {
          definitionVersion: 2,
          resolution: { mode: "fixed", width: 2048, height: 2048 },
          // ABSOLUTE clock (§V453, T497): `abstime` keeps counting across a timeline lap,
          // so the wheel turns through the loop point instead of snapping back to phase 0.
          // `% 1` because the ramp's own period is 1 and the stops are cyclic.
          parameters: { phase: expressionSlot("abstime * 0.06 % 1", 0) },
        },
      ),
      node(
        "fold",
        "transform",
        [-500, 0],
        {
          t: [0.12, 0],
          r: 30,
          s: [0.5, 0.5],
          p: [0, 0],
          xord: "srt",
          extend: "mirror",
          aspectcorrect: true,
        },
        // The translate is what makes this rotation VISIBLE: a circular ramp centred on
        // the frame is rotationally symmetric, so spinning it about its own centre would
        // be a no-op that every structural test would pass (§V361). Off-centre, it turns.
        // T583: the `% 360` guard is gone — T537 freed expression values from the
        // parameter's stored range, so the angle can just grow (E13's removal rendered
        // byte-identical before its first wrap; only float rounding after).
        { parameters: { r: expressionSlot("abstime * 5", 30) } },
      ),
      /**
       * TWO, NOT THREE, and the reason is measurable rather than aesthetic.
       *
       * A mirrored tiling alternates flipped and unflipped cells, so the tiled image is
       * periodic across the frame boundary only when the count is EVEN. At 3x3 the right
       * edge met the left edge unmirrored, and `spin`'s `repeat` extend then showed that
       * discontinuity as a hard diagonal seam sweeping across the frame — visible in every
       * rotated capture and in none of the unrotated ones, which is exactly the kind of
       * thing an edge-mode example must not ship.
       */
      node(
        "facets",
        "tile",
        [-240, 0],
        {
          repeat: [2, 2],
          offset: [0.15, 0.05],
          mirrorx: true,
          mirrory: true,
        },
        {
          parameters: {
            "offset.x": drivenSlot("driftx1", 0.15),
            "offset.y": drivenSlot("drifty1", 0.05),
          },
        },
      ),
      // Free-running (§V453). 0.023 against 0.031 does not close, so the grid never
      // returns to an arrangement it has already shown.
      node(
        "driftx",
        "lfo",
        [-240, 260],
        { shape: "sine", frequency: 0.023, amplitude: 0.25, offset: 0.15, phase: 0 },
        { label: "driftx1" },
      ),
      node(
        "drifty",
        "lfo",
        [-240, 470],
        { shape: "sine", frequency: 0.031, amplitude: 0.25, offset: 0.05, phase: 0.25 },
        { label: "drifty1" },
      ),
      node(
        "spin",
        "transform",
        [20, 0],
        {
          t: [0, 0],
          r: -15,
          s: [1, 1],
          p: [0, 0],
          xord: "rst",
          extend: "repeat",
          aspectcorrect: true,
        },
        // Counter-rotating, and slower than the fold: two rotations at the same rate are
        // one rotation, and the beat between 5 and 2.5 degrees a second is the drift the
        // owner asked for. T583: the old `360 - x % 360` contortion existed only to stay
        // inside the stored range; T537 freed that, so this is just the negative rate.
        { parameters: { r: expressionSlot("-abstime * 2.5", -15) } },
      ),
      node("out", "output", [280, 0]),
    ],
    [
      edge("e-source-fold", ["source", "out"], ["fold", "input"]),
      edge("e-fold-facets", ["fold", "out"], ["facets", "input"]),
      edge("e-facets-spin", ["facets", "out"], ["spin", "input"]),
      edge("e-spin-out", ["spin", "out"], ["out", "input"]),
    ],
  ),
);
