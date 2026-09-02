import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E29 — Descent (T503). A VJ piece first: an endless tunnel you fall into.
 *
 * A ring of light is born in the middle of the frame, then rushes outward past you,
 * turning as it goes and sliding around the hue wheel — and behind it the next ring, and
 * the next, so the frame reads as a corridor receding to a point that never arrives. On
 * every kick the fall LURCHES: the zoom per frame jumps, the whole corridor surges, and it
 * settles back over the following beat.
 *
 * ## Why this is not E1 with more knobs
 *
 * E1 Feedback Echo is a SMEAR — a trail that transforms slightly and fades. The two
 * differences here are the whole picture and neither is a matter of degree:
 *
 *  1. **The scale inside the loop is greater than one.** E1's loop shrinks and drifts;
 *     this one MAGNIFIES by 5.5% per pass about the frame's centre. Content therefore
 *     leaves through the edges rather than piling up, which is what a corridor is, and it
 *     is also what keeps the loop stable without a hard fade — an expanding image spreads
 *     its energy over more pixels every pass, so the gain can sit essentially at unity and
 *     the picture still terminates.
 *  2. **The hue rotates inside the loop.** Each pass is a few degrees further round, so
 *     depth reads as COLOUR: the ring nearest you is a different hue from the one behind
 *     it, and you can count the corridor's rings by their colour even where their edges
 *     have blurred into each other.
 *
 * ## The clock, and why this one cannot snap at a lap
 *
 * There is no clock read in the picture path at all — not `time`, not `absTime`. The
 * motion is the feedback loop's own iteration, one pass per frame, and the state carries
 * across a timeline lap like any other frame boundary (T489). An example whose animation
 * comes from state rather than from a clock position is loop-proof BY CONSTRUCTION, which
 * for a piece meant to run for an hour behind a set is worth more than it sounds. The one
 * clock reader is `beat1`, which is timeline-anchored ON PURPOSE (§V436): it stands in for
 * a track, so bar one lands on the in point.
 *
 * ## The sound, and what happens when you drop your own in
 *
 * `beat1` is the deterministic Audio Pattern, so the file OPENS PLAYING with no asset
 * bound (§V363, B74) and an offline render of it reproduces (§V45). The kick drives two
 * things at different time constants — the zoom, through a fast Lag so the surge is felt
 * as an impact, and the ring's own brightness, through a slower one so the corridor stays
 * lit between beats. Swap `beat1` for an `audioFileIn` and keep its label and every
 * mapping downstream follows.
 */
export const descentDocument = document(
  "e29-descent",
  "E29 Descent",
  settings({ outputResolution: { width: 1280, height: 720 }, randomSeed: 29 }),
  graph(
    [
      // ---- the sound -------------------------------------------------------------
      node("beat", "audioPattern", [-1560, 600], { bpm: 124, amount: 1 }, { label: "beat1" }),
      /* Two envelopes off one source, and the difference between them is the feel — but
         also, for the ring, the difference between a stable loop and a white frame. The
         slow one (0.28 s) reaches the ZOOM, where a smooth surge is what you want. The fast
         one (30 ms) reaches the ring's brightness, and it has to be fast: anything the ring
         adds is added EVERY FRAME into a loop whose gain is 0.985, so a DC term of `x`
         settles at `x / 0.015` — sixty-odd times itself. A ring lit by an ENVELOPE is a DC
         term. A ring lit by a STRIKE is not, and that is why this one is nearly zero
         between beats rather than merely dimmer. */
      node("punch", "valueLag", [-1300, 480], { lag: 0.28 }, { label: "punch1" }),
      /* THE RING IS BORN BY A TRIGGER, not by an envelope, and this is the load-bearing
         line in the graph. Whatever the ring adds is added into a loop whose gain is 0.985,
         so the loop integrates roughly 67 frames of it: a DC term of `x` settles at
         `x / 0.015`. An envelope — even a fast one — is a DC term, and three builds of this
         example went to solid white before that was the diagnosis rather than the fade
         being "not strong enough". A Trigger emits 1 for the ONE frame the kick crosses its
         threshold and 0 for the other twenty-eight, so the mean input is a twenty-ninth of
         the peak and the steady state lands under one by arithmetic instead of by luck. */
      node("hit", "valueTrigger", [-1300, 740], { threshold: 0.84 }, { label: "hit1" }),
      node("zgain", "valueMath", [-1040, 480], { operation: "multiply", operand: 0.107 }, { label: "zgain1" }),
      node("zbase", "valueMath", [-780, 480], { operation: "add", operand: 0.9466 }, { label: "zbase1" }),
      /* Two fences, like E24's: above ~1.13 per frame the corridor outruns the eye and
         reads as a flash, and at or below 1.0 the loop stops expanding and piles up into
         white. The clamp is not tuning, it is what keeps a loud passage recoverable. */
      node("zcap", "valueLimit", [-520, 480], { minimum: 1.006, maximum: 1.048 }, { label: "zoom1" }),
      node("strike", "valueMath", [-1040, 740], { operation: "multiply", operand: 0.85 }, { label: "strike1" }),
      node("bcap", "valueLimit", [-780, 740], { minimum: 0, maximum: 0.85 }, { label: "lamp1" }),

      // ---- the ring that is born every frame --------------------------------------
      /* THE FRAME, as two rounded squares and a Difference.
         WHY A SQUARE AND NOT A CIRCLE, and it is the difference between a tunnel and a
         dartboard: the loop ROTATES, and a rotation of a rotationally symmetric shape is
         invisible. The first build seeded circles, and the 0.26° per pass — thirty degrees
         between one ring and the next — did nothing at all to the picture. A square turns
         visibly, so the corridor reads as a twisting shaft rather than a bullseye, and the
         twist per ring is something you can literally count off the corners.
         AND WHY TWO SHAPES AND NOT ONE NODE: `rectangle`'s `distance` mode gives a SIGNED
         field, and a Level cannot cut a band out of a signed field because it has no
         absolute value — every setting that brightens the edge also brightens the whole
         interior, which renders as a soft blob (measured, on the build before that one).
         |a − b| over two coverage masks is exact, and the frame's WIDTH is then the
         difference of two sizes, which is a number you can reason about. */
      node("bore", "rectangle", [-1560, -80], {
        mode: "fill", center: [0.5, 0.5], size: [0.124, 0.124], roundness: 0.028, softness: 0.004,
        fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: true,
      }, { label: "bore1" }),
      node("core", "rectangle", [-1560, 180], {
        mode: "fill", center: [0.5, 0.5], size: [0.113, 0.113], roundness: 0.028, softness: 0.004,
        fillcolor: [1, 1, 1, 1], bgcolor: [0, 0, 0, 1], aspectcorrect: true,
      }, { label: "core1" }),
      node("ring", "difference", [-1300, 50], {}, { label: "ring1" }),
      /* The kick lands HERE — AFTER the palette, and that ordering is the whole of it. Put
         the same gain BEFORE the lookup and a quiet moment does not dim the ring, it moves
         it to the DARK END OF THE RAMP: the ring turns black-purple instead of faint, and
         between beats the frame goes to nothing. Measured on the first build. A brightness
         that means brightness has to act on colour, not on a lookup coordinate. */
      node("lamp", "level", [-780, -80], {
        blacklevel: 0, whitelevel: 1, contrast: 1, brightness: 1, gamma1: 1, opacity: 1,
      }, {
        label: "lampl1",
        parameters: { brightness: drivenSlot("lamp1:low", 1) },
      }),
      /* The frame's colour, and the crest is SATURATED rather than white — which is not a
         taste call, it is what makes the hue rotation inside the loop do anything at all.
         Rotating the hue of a neutral is a no-op: the first coloured build ended on
         (1, 0.98, 0.92), every ring came out white, and thirty degrees per ring changed
         nothing. Ending on a saturated teal gives `shift1` something to turn, so depth
         reads as colour down the whole corridor. */
      node("hue", "ramp", [-1300, -280], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        stops: [
          { position: 0, color: [0, 0, 0, 1] },
          { position: 0.4, color: [0.03, 0.06, 0.22, 1] },
          { position: 0.72, color: [0.05, 0.42, 0.6, 1] },
          { position: 1, color: [0.1, 0.95, 0.88, 1] },
        ],
      }, { label: "hue1", definitionVersion: 2 }),
      node("paint", "lookup", [-1040, -80], { channel: "luminance", row: 0.5, scale: 1, offset: 0 }, { label: "paint1" }),

      // ---- the loop: magnify, turn, shift hue, add the new ring ---------------------
      /* THE TEMPORAL BOUNDARY (§V4/§V22). `source` names the node whose output is captured,
         so last frame's finished picture re-enters here and the three stages below run on
         it before the new ring is added on top. */
      node("loop", "feedback", [-780, 230], {
        /* PERSISTENCE IS THE ENERGY SINK, and the first build got this wrong in a way worth
           recording: I assumed an expanding loop dims itself, because the same light lands
           on more pixels. It does not. `s > 1` DIVIDES the sampling coordinates, so the
           pass magnifies the centre and DUPLICATES its pixels — nothing leaves the frame
           and nothing is diluted. With a near-unity gain the corridor went to white in
           under four seconds. Every bit of the decay here is deliberate. */
        source: "born1", persistence: 0.985, clearColor: [0, 0, 0, 1],
      }, { label: "loop1" }),
      node("fall", "transform", [-520, 230], {
        /* Scale ABOVE ONE about the centre: the corridor's whole geometry, in one number.
           `extend: "zero"` matters — with `hold`, the edge pixels of an expanding image
           streak outward forever and the corners fill with smeared colour. */
        t: [0, 0], r: 0.55, s: [1.019, 1.019], p: [0, 0], xord: "srt", extend: "zero", aspectcorrect: true,
      }, {
        label: "fall1",
        parameters: {
          "s.x": drivenSlot("zoom1:low", 1.019),
          "s.y": drivenSlot("zoom1:low", 1.019),
        },
      }),
      node("fade", "level", [-260, 230], {
        /* Two jobs, neither of them the fade (that is `loop1`'s persistence). `blacklevel`
           above zero gives the corridor an END — without it the far rings asymptote toward
           a permanent grey haze instead of going out. GAMMA above one fights the other
           thing the loop does to a picture: every pass resamples bilinearly, so an edge
           that has gone round fifty times is a gradient, and lifting the midtones
           re-steepens its dark ramp.
           SIGN CHECKED (T618, §V481c): Level computes `pow(v, 1 / gamma1)`, so 1.12 is
           `pow(v, 0.893)` — ABOVE `v` on (0,1), a midtone LIFT, i.e. mildly expansive.
           An earlier version of this comment claimed the opposite and §V481(c) was
           first recorded from it. What actually keeps the loop bounded is not this
           stage contracting — it is `persistence 0.989` shrinking every pass and the
           `blacklevel` floor clipping the tail; the lift only has to stay small enough
           that their product with it is below one, which at 1.12 it does. Contrast was
           still the wrong knob for a different reason: its expansion PIVOTS at mid-grey,
           so the bright half gets gain exactly where the loop already accumulates, and
           the first build went to white in seven seconds with contrast 1.05.
           Every stage inside a feedback loop has to be sign-checked like this. */
        blacklevel: 0.006, whitelevel: 1, contrast: 1, brightness: 1, gamma1: 1.12, opacity: 1,
      }, { label: "fade1" }),
      node("shift", "hsv", [0, 230], {
        /* Three degrees per pass. Each frame of the corridor has been round the loop one
           more time than the one inside it, so ~90° separates one square from the next and
           DEPTH READS AS COLOUR — you can count the shaft by hue where the edges have
           already blurred into each other. Small numbers do not work here: at 1.6° the
           corridor was one colour with a fringe. */
        hueoffset: 3.1, saturation: 1.004, value: 1,
      }, { label: "shift1" }),
      /* ADD, not Screen. Screen is `1 − (1 − a)(1 − b)`: it saturates toward white by
         construction, which is fine once but is a ratchet inside a loop — the first build
         used it and the corridor was solid white within four seconds, whatever the fade
         was set to. Add is linear, so the steady state is the ring's height over one minus
         the loop gain, which is a number you can choose. */
      node("born", "add", [260, 60], {}, { label: "born1" }),

      // ---- the look ---------------------------------------------------------------
      node("halo", "blur", [520, 340], { size: 26, filter: "gaussian", extend: "zero" }, { label: "halo1" }),
      node("haze", "level", [780, 340], {
        /* The bloom's own gain. A blur normalises, so adding it back at unity doubles the
           picture's total light; at 0.55 it reads as glow around the rings rather than as
           a second, softer copy of them. */
        blacklevel: 0, whitelevel: 1, contrast: 1, brightness: 0.5, gamma1: 1, opacity: 1,
      }, { label: "haze1" }),
      node("burn", "add", [1040, 60], {}, { label: "burn1" }),
      node("trim", "level", [1300, 60], {
        /* W5, stated: there is no tone map yet, so an additive bloom over an additive loop
           clips at the encode. This is the hand gain that keeps the crest inside the range,
           and it should come OUT the day an output transform lands. */
        blacklevel: 0, whitelevel: 1, contrast: 1, brightness: 1, gamma1: 1, opacity: 1,
      }, { label: "trim1" }),
      node("out", "output", [1560, 60], {}, { label: "out1" }),
    ],
    [
      edge("e-beat-punch", ["beat", "out"], ["punch", "in"]),
      edge("e-beat-hit", ["beat", "out"], ["hit", "in"]),
      edge("e-punch-zgain", ["punch", "out"], ["zgain", "a"]),
      edge("e-zgain-zbase", ["zgain", "out"], ["zbase", "a"]),
      edge("e-zbase-zcap", ["zbase", "out"], ["zcap", "in"]),
      edge("e-hit-strike", ["hit", "out"], ["strike", "a"]),
      edge("e-strike-bcap", ["strike", "out"], ["bcap", "in"]),

      edge("e-bore-ring", ["bore", "out"], ["ring", "in1"]),
      edge("e-core-ring", ["core", "out"], ["ring", "in2"]),
      edge("e-ring-paint", ["ring", "out"], ["paint", "source"]),
      edge("e-paint-lamp", ["paint", "out"], ["lamp", "input"]),
      edge("e-hue-paint", ["hue", "out"], ["paint", "lookup"]),

      edge("e-loop-fall", ["loop", "out"], ["fall", "input"]),
      edge("e-fall-fade", ["fall", "out"], ["fade", "input"]),
      edge("e-fade-shift", ["fade", "out"], ["shift", "input"]),
      // in1 is the corridor, in2 is the new ring: Screen is commutative, but the order is
      // still the reading order of the picture and it costs nothing to state it.
      edge("e-shift-born", ["shift", "out"], ["born", "in1"]),
      edge("e-lamp-born", ["lamp", "out"], ["born", "in2"]),

      edge("e-born-halo", ["born", "out"], ["halo", "input"]),
      edge("e-born-burn", ["born", "out"], ["burn", "in1"]),
      edge("e-halo-haze", ["halo", "out"], ["haze", "input"]),
      edge("e-haze-burn", ["haze", "out"], ["burn", "in2"]),
      edge("e-burn-trim", ["burn", "out"], ["trim", "input"]),
      edge("e-trim-out", ["trim", "out"], ["out", "input"]),
    ],
  ),
);
