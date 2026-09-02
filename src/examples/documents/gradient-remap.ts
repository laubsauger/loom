import { settings, node, edge, graph, document, expressionSlot } from "./builders.ts";

/**
 * E11 — Gradient Remap (T354, T270).
 *
 *   noise1(noise, 4D) ──────► lookup1.source ─┐
 *   ramp1(ramp, 6 cyclic stops) ─► .lookup ───┴─► lookup1(lookup) ─► out1(output)
 *            phase ← abstime                       offset -0.86, scale 2.6
 *
 * Ramp into Lookup is the standard way to recolour an image through a palette, and it is
 * the pairing multi-stop Ramp (T270) was built for: with two colours it is a tinted
 * greyscale and barely worth wiring: the extra stops are what make it a PALETTE. The noise
 * supplies structure, its luminance is read as a POSITION along the gradient, and the
 * colour found there is the output — so every pixel's brightness becomes a hue.
 *
 * ## T518 / T523 — a palette example that showed a third of its palette
 *
 * Two faults, and the second is the interesting one. The field was `perlin2d` at `speed:
 * 0`, so nothing moved (mean |Δ| of exactly 0.00 on Dawn). And the lookup indexed on the
 * field's RAW luminance, which for a fractal noise runs from about 0.34 to 0.70 — so the
 * index never left the middle third of the gradient, and the deep end and the pale end
 * were never rendered at all. An example whose entire subject is a multi-stop palette was
 * hiding most of its own stops, and no assertion could notice: every stop was present in
 * the document, every stop decoded correctly, and the picture was still wrong.
 * `offset`/`scale` are the two parameters that exist for exactly this, and they are now
 * doing it.
 *
 * The two inputs are not interchangeable and the manifest's policies say so: resolution
 * inherits `source` (the image whose shape survives), format inherits `lookup` (the output
 * pixels ARE the palette's pixels, so their space belongs to the palette).
 *
 * This is also multi-stop Ramp's only shipped regression test, and a better one than a
 * unit test: §V196 decodes a display-space colour PER ENTRY, and a list makes a
 * double-decode or a dropped entry N times harder to see because the eye checks one swatch
 * and assumes the rest. Here a mis-decoded stop is a WRONG PALETTE — the whole image goes
 * muddy or the midtones lose their hue, which is legible at a glance.
 */
export const gradientRemapDocument = document(
  "e11-gradient-remap",
  "E11 Gradient Remap",
  settings({ randomSeed: 11 }),
  graph(
    [
      node(
        "field",
        "noise",
        [-640, -120],
        {
          // T518: `perlin2d` with `speed: 0` — two independent reasons this file could not
          // move, and it measured mean |Δ| of exactly 0.00 across every pair of frames.
          // `perlin4d` gives `speed` a dimension to advance; `t4d: 0.37` starts the field
          // off the 4D lattice plane where its amplitude would otherwise be suppressed.
          type: "perlin4d",
          // Large, soft features: the palette needs broad areas to show a hue in, and a
          // fine field would dither the stops into visual mud.
          period: 0.9,
          harmon: 4,
          spread: 2,
          gain: 0.55,
          rough: 0.5,
          exp: 1,
          amp: 1,
          offset: 0,
          mono: true,
          aspectcorrect: true,
          seed: 3,
          s4d: 1,
          t4d: 0.37,
          // Slow. The palette scroll below is the fast motion; if the field drifted at the
          // same rate the two would beat against each other and read as noise.
          speed: 0.08,
        },
        { label: "noise1" },
      ),
      node(
        "palette",
        "ramp",
        [-640, 160],
        {
          type: "horizontal",
          interp: "smooth",
          phase: 0,
          period: 1,
          /**
           * Six stops with real hue movement — near-black indigo to violet to magenta to
           * amber to teal and back to indigo. Stored in DISPLAY space (§V56), which is
           * what a colour picker hands over, and decoded per entry on the way to the
           * shader (§V196).
           *
           * The last colour EQUALS the first, and that is structural rather than a
           * preference: `phase` scrolls the ramp by `fract((coord + phase) / period)`, so
           * a palette whose ends disagree jumps every time the scroll wraps. Cyclic, it
           * runs forever.
           */
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
          label: "ramp1",
          definitionVersion: 2,
          // ABSOLUTE clock (§V453): the palette walks past the field instead of the field
          // walking past the palette, so every stop visits every part of the picture. It
          // is also the proof that all six decoded — you watch each one arrive.
          parameters: { phase: expressionSlot("abstime * 0.04 % 1", 0) },
        },
      ),
      /**
       * T523 — `offset` AND `scale` ARE THE FIX FOR A PALETTE YOU CANNOT SEE.
       *
       * At the shipped 0 and 1 the index was the field's raw luminance, and a fractal
       * noise does not span 0..1: measured, this field runs from about 0.34 to 0.70 with
       * its median at 0.50. So the lookup only ever read the MIDDLE THIRD of the gradient
       * — the deep indigo end and the pale end never appeared at all, and an example whose
       * entire subject is a multi-stop palette was showing two of its stops and hiding the
       * rest.
       *
       * `index = luminance * scale + offset`. Solving that line through (0.34 -> 0.03) and
       * (0.70 -> 0.97) gives a slope of 2.6 and an intercept of -0.86, and those are the
       * two numbers below. The tails clamp, which is what the ramp's hold-outside-range
       * behaviour is for.
       */
      node(
        "remap",
        "lookup",
        [-260, 0],
        // Luminance is the index: a mono field's brightness IS its position along the
        // palette. `row` picks the middle of the gradient image, which is the whole of it
        // for a horizontal ramp.
        { channel: "luminance", row: 0.5, offset: -0.86, scale: 2.6 },
        { label: "lookup1" },
      ),
      node("out", "output", [120, 0], {}, { label: "out1" }),
    ],
    [
      edge("e-field-remap", ["field", "out"], ["remap", "source"]),
      edge("e-palette-remap", ["palette", "out"], ["remap", "lookup"]),
      edge("e-remap-out", ["remap", "out"], ["out", "input"]),
    ],
  ),
);
