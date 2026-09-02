import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E27 — Relief (T475, T409).
 *
 * A moving picture STANDS UP off the screen: a grid of points is pushed toward the viewer
 * in proportion to the brightness under it, drawn as thousands of small unlit quads and
 * filmed by a drifting camera. Rutt-Etra, the analog video-synth look — except the source
 * is a live graph rather than a scan converter.
 *
 * ## THE UNDERSTUDY PATTERN (V411), and it is the reusable idea here
 *
 * §V363 says a demo must demonstrate itself, and until now that has meant no example may
 * contain a live input at all. That is exactly why `webcam` shipped DEAD for months (B39):
 * no example used it, so nothing ever compiled its shader or bound its external texture.
 *
 * `pick1` dissolves the conflict. A Switch's branches are all rendered — it selects a
 * RESOURCE, it does not prune a subgraph — so with `index: 0` this file opens playing its
 * own synthetic performer, AND `cam1` is in the graph, in the plan, and compiled on Dawn by
 * `examples.gpu.test.ts`. That is the integration gate §V362 names as the only one we have,
 * and it is the gate B39 escaped. Move the index to 1 and it is your camera; nothing else
 * in the graph changes.
 *
 * The same shape generalises to `audioIn`/`audioFileIn`, the other two nodes §V363 has been
 * keeping unexampled. It is not applied here — one example, one claim — but it is the
 * reason to write this one down.
 *
 * ## Why POINTS and not a surface
 *
 * `textureToAttribute` reads with `textureLoad` — NEAREST, unfiltered, deliberately, so a
 * data field survives it (§V57). A displaced SURFACE is therefore brutally sensitive to the
 * ratio between mesh and field: coarser and a narrow feature falls between two vertices and
 * spikes, finer and every vertex in one texel shares a height and the surface steps. Points
 * have neither failure, because there is no shared edge between them to tear or facet — a
 * point that samples a texel just sits where that texel says. That is what makes a relief
 * the honest thing to build on this bridge, and it is why the grid here can be a different
 * shape from the field without anything going wrong.
 *
 * ## The aspect fix lives in the kernel
 *
 * The bridge maps `position.xy * 0.5 + 0.5` to uv, so the sampling grid HAS to span
 * x,y in [-1,1] — a square. The source is 16:9. So `lift1` samples on the square and then
 * stretches x by 16/9 on its way out: the picture is read square and DRAWN wide, which is
 * one line of kernel and the only place the aspect appears.
 *
 * ## T503 — THE THREE THINGS THAT WERE WRONG, and they were different bugs
 *
 * The owner's verdict on the first build was "weak, inverted and hard to see". All three
 * were true and none of them was tuning.
 *
 * **1. IT WAS LITERALLY UPSIDE DOWN, by construction.** The bridge maps `position.y = -1`
 * to `uv.y = 0`, and `uv.y = 0` is TEXEL ROW 0 — the row an output node shows at the TOP
 * of the frame. But world +y is UP, so `position.y = -1` renders at the BOTTOM. Every
 * texture-to-points bridge therefore hands the picture back mirrored across the horizon,
 * and nothing in the understudy was asymmetric enough to make that visible. Flip the
 * Switch to the webcam and it is your own face, upside down. The fix is `-p.position.y`
 * in the kernel: the bridge already sampled at the grid's own xy, so negating y at DRAW
 * time reseats the image without touching what was read.
 *
 * **2. THE HEIGHT CAME OUT OF THE PALETTE, so the terrain was a caricature of the
 * picture.** `lift1` took luminance off the COATED colour, and this palette's luminance
 * runs 0.02 / 0.14 / 0.28 / 0.49 / 0.95 across its five stops — monotone, yes, but wildly
 * non-linear. Four fifths of the source was squashed into the bottom half of the height
 * range and the last fifth exploded, which renders as a flat plate with one needle spike
 * in it. That is the whole of "weak".
 *
 * The fix is the reason `braid1` exists: a Reorder carries the COLOUR in rgb and the
 * SOURCE's own luminance in alpha, so one RGBA texture crosses the one bridge carrying two
 * different fields. The kernel then reads `sample.a` for shape and `sample.rgb` for colour,
 * and the palette is free to be chosen for how it LOOKS instead of doubling as a height
 * transfer function. Generalisable: the bridge is four channels wide and a displacement
 * only needs one.
 *
 * **3. THE CAMERA WAS ALMOST DOWN THE HEIGHT AXIS.** The old eye looked along (-0.32,
 * 0.40, -0.86) at a sheet whose relief is entirely in z — 86% of the view direction was
 * parallel to the displacement, so the thing the example is about barely projected. The
 * doc claimed the opposite ("face-on, a height field is just the picture again"), which is
 * how it survived review. `eye1` now sits low and off to one side, a landscape view: the
 * height axis is across the frame, the hills have silhouettes, and the scan lines bunch on
 * a rising slope the way a contour map's do.
 */
const RELIEF_COLS = 480;

const RELIEF_ROWS = 220;

const RELIEF_LIFT_KERNEL = `fn process(p: Point, ctx: PointCtx) -> Point {
  var q = p;
  /* p.sample is the bridge's pair, bound from UPSTREAM (T401), and it carries TWO fields:
     rgb is the paletted colour, alpha is the SOURCE's own luminance (braid1). Height comes
     off alpha so the palette never doubles as a height curve — see the note above. */
  let height = p.sample.a;
  /* T676 — THE SHEET STANDS UP, 70 degrees off the floor, and ORIENTATION FOLLOWS THE
     SOURCE.

     Owner: "its on its Back both in preview and final output. we're laying the points on
     their back which makes sense for the mountains but looks weird when we do webcam
     right". That sentence is the rule, and it is why this is not a tuning change. A
     HEIGHTFIELD is read from above, so T503 was right to lay the sheet down for the
     noise-and-dome understudy. A SCANNED VIDEO IMAGE is read FACE-ON — you look at a face
     the way you looked at it — and this example's real subject is the webcam on branch 1.
     Face-on with a slight lean is also the historical Rutt-Etra frame, which is what this
     document is quoting.

     WHY 70 AND NOT THE 90 THE OWNER SAID. The owner gave a number describing the problem.
     A true 90 with a camera in front puts the view direction straight back down the height
     axis, which is EXACTLY the failure T503 fixed (the first build looked 86% down it and
     the relief did not project at all). It also removes both cues this example actually
     reads by, and it has no third one to fall back on: the material is UNLIT, so there is
     no shading and no raking light — a bas-relief's usual mechanism is simply unavailable
     here. What is left is SILHOUETTE against the far ground and SCAN LINES BUNCHING on a
     rising slope, and both are obliquity cues. Leaning the sheet back 20 degrees keeps the
     camera about 20-25 degrees off its normal: the image reads face-on, and the relief
     still has somewhere to project.

     THE GEOMETRY. The grid arrives in the xy plane. Read 'u' as across, 'v' as up the
     sheet, 'h' as out along its normal, then rotate (v, h) about x by 70 degrees:
       y = v*sin70 + h*cos70,  z = -v*cos70 + h*sin70
     so the sheet's own up axis leans back and its normal leans toward the camera on +z.
     At 0 degrees this collapses to the old (u, h, v) lay-down, which is the check that the
     rotation is the only thing that changed.

     THE 'v' SIGN IS T512's AND IT SURVIVES INTACT. The bridge reads
     uv.y = 0.5 - position.y*0.5, so position.y = +1 is TEXEL ROW 0 — the row an output
     shows at the TOP of the frame. Laid flat, the top of a picture belonged at the FAR
     edge, which is z NEGATIVE from a camera on +z. STOOD UP, the top of a picture belongs
     at the TOP, which is y POSITIVE — and the same negation delivers both, because the
     rotation carries it. Read the mapping in points/codegen.ts rather than guessing: this
     sign is coupled to it and B105 is what guessing costs.

     Baked rather than parameterised: this kernel has exactly one consumer, the 'lift1'
     node below. A shared kernel that could only do one orientation would be the same fault
     as two hand-maintained branches — but there is nothing here to share it with.
     Sampled on a square (the mapping demands it), drawn 16:9. */
  let v = p.position.y * 1.15;
  /* T809 — THE AUDIO SCALES THE LIFT AMPLITUDE, AND NOTHING ELSE.
     ctx.value1 is the kick, rest-subtracted so silence IS zero (T479, T701). It is added
     to the 1.05 here rather than driving norm1's white point, because the white point
     belongs to the exposure loop and a second driver on it would fight the normalisation
     T797 just gave this file (§V730: one decision, one site). Shipped at gain 0, which
     makes this term EXACTLY 1.05 + 0.0 — an f32 add of zero is exact, so the shipped
     picture is byte-identical to the pre-T809 file and relief-claims measures it. */
  let h = height * (1.05 + ctx.value1) - 0.16;
  q.position = vec3f(p.position.x * 1.7778, v * 0.9397 + h * 0.3420, -v * 0.3420 + h * 0.9397);
  /* Alpha has done its job, so it goes back to 1 before the draw: body1 maps this same
     attribute onto the material TINT (T478), and a tint whose alpha carried the HEIGHT
     would have made the low ground transparent as well as dark. */
  q.sample = vec4f(p.sample.rgb, 1.0);
  return q;
}`;

export const reliefDocument = document(
  "e27-relief",
  "E27 Relief",
  settings({ randomSeed: 41 }),
  graph(
    [
      /* THE UNDERSTUDY. A hill travelling across a living bed of noise: something with
         SHAPE in it, so the relief is a picture rather than a texture, and something that
         moves everywhere, so no part of the frame is still (T402). */
      node("ripple", "noise", [-1680, 300], {
        type: "perlin4d", seed: 41, period: 0.32, harmon: 4, spread: 2.1, gain: 0.58,
        rough: 0.55, exp: 1, amp: 1, offset: 0, mono: true, aspectcorrect: true,
        t4d: 0.37, s4d: 1, speed: 0.16, // T535: off the lattice plane
      }, { label: "ripple1" }),
      node("bed", "level", [-1380, 300], {
        /* T503: the bed used to be crushed to a 0.42..1.05 sliver — a sixth of the height
           range for the entire terrain, which is most of why nothing read. It now uses its
           whole range, and `gamma1` under 1 lifts the mid-slopes so the valleys stay dark
           and the ridges separate. The DOME is still the subject; contrast is what makes
           the ground it stands on a landscape rather than a haze. */
        blacklevel: 0.12, whitelevel: 0.86, contrast: 1.25, brightness: 1, gamma1: 0.85, opacity: 1,
      }, { label: "bed1" }),
      /* THE SWELL. A soft dome, wide and low-contrast, wandering across the sea on two
         incommensurate drifts. It is the SHAPE in the picture: without it the relief is a
         texture, and a texture in relief is E20 with extra steps. */
      node("swell", "circle", [-1680, 0], {
        mode: "fill", center: [0.5, 0.5], radius: [0.3, 0.3],
        /* Softness far past the radius makes this a DOME rather than a disc (E13's
           finding): a hard disc lifts as a cylinder with a cliff edge, and a cliff is
           where a point relief looks like a bug. */
        softness: 0.62,
        /* Under 1.0 on purpose: the bed is ADDED on top, and a dome already at full
           brightness clips flat where the two meet — which renders as a scooped, level
           summit instead of a peak. */
        fillcolor: [0.72, 0.7, 0.66, 1], bgcolor: [0, 0, 0, 0], aspectcorrect: true,
      }, {
        label: "swell1",
        parameters: {
          "center.x": drivenSlot("driftx1", 0.5),
          "center.y": drivenSlot("drifty1", 0.5),
        },
      }),
      node("driftx", "lfo", [-1680, 560], {
        shape: "sine", frequency: 0.019, amplitude: 0.3, offset: 0.5, phase: 0,
      }, { label: "driftx1" }),
      node("drifty", "lfo", [-1380, 560], {
        shape: "sine", frequency: 0.013, amplitude: 0.22, offset: 0.5, phase: 0.25,
      }, { label: "drifty1" }),
      node("sum", "add", [-1080, 140], {}, { label: "sum1" }),

      /* THE REAL THING — in the graph, in the plan, compiled on Dawn, one index away. */
      node("cam", "webcam", [-1080, 420], {}, { label: "cam1" }),
      node("pick", "switch", [-780, 280], { index: 0 }, { label: "pick1" }),

      /* T797 — THE RELIEF IS A LUMINANCE HISTOGRAM, AND A DARK ROOM HAS NO HISTOGRAM.
         Owner: "relief when driving with camera and a rather dark image is kind a boring
         and needs to react more to darker colors and movement of these".

         The mechanism is the one T503 built: `braid1` puts the SOURCE's own luminance in
         alpha and `lift1` pushes each point out in proportion to it. That is exactly a
         luminance histogram stood on edge — so a dark room compresses every point into a
         narrow band near zero and the sheet goes FLAT. Measured on a dimmed understudy
         (x0.14, the "dark room" fixture): mean display luma 0.0159 against the lit 0.1713,
         and the frame is a featureless navy rectangle.

         THE FIX IS AN AUTO-GAIN, AND IT NEEDED NO NEW NODE. §T767 records a missing
         normalize/running-range VALUE node and this looked like its second customer — but
         a TEXTURE already has the primitive: `analyze` reduces its input to average /
         minimum / MAXIMUM and publishes the number as a driven channel (T236, §V144).
         So the observed top of the source's range drives a Level's white point and the
         picture is re-ranged before anything reads it. Dimmed x0.14 the frame comes back
         to 0.1961 — past the lit original — with the palette's whole climb in use again.

         ONLY THE WHITE POINT IS DRIVEN, AND THAT IS §V694. A positive `blacklevel` IS a
         subtraction and `rgba16float` does not clamp, so driving the black point from the
         measured MINIMUM would push pixels negative on the two counts this node cannot
         avoid: `analyze` reduces a 64x64 SUBSAMPLE (the true per-pixel floor can sit below
         it) and answers with the LAST COMPLETED frame (§V144), so a frame that just got
         darker is below the number being subtracted from it. A pure gain has neither
         failure — it cannot produce a value the source did not already have the sign of.

         `roofsafe1` is the rail, and it is a real one: the white point is a DIVISOR, so an
         unfloored channel on a frame that goes black is a divide-by-nothing. 0.06 caps the
         gain at ~17x, which is two and a half stops past the dark fixture and still short
         of amplifying sensor noise into a mountain range. §V471(3)/T544: a gain is
         range-checked against its target, not hopeful.

         AND THE LATENCY IS DELIBERATE (§V144, §V436): the value visible while frame N
         renders is the reduction of frame N-1, so a SEEK lands one frame on the previous
         exposure and self-corrects on the next. That is the mild, one-frame version of the
         history-dependence §V436 warns about — this is a per-frame range, not a running
         one, so scrubbing is repeatable everywhere except that single frame. */
      node("roof", "analyze", [-480, 1180], {
        channel: "luminance", operation: "maximum",
      }, { label: "roof1" }),
      node("ceil", "channelIn", [-180, 1180], { channel: "roof1", fallback: 1 }, { label: "ceil1" }),
      node("guard", "valueLimit", [120, 1180], { minimum: 0.06, maximum: 2 }, { label: "roofsafe1" }),
      node("norm", "level", [-1080, 700], {
        /* Black stays at 0 — see §V694 above. Everything else is identity: this node's one
           job is the exposure, and a second job here would be a transfer curve nobody
           asked for (the mistake T503 took out of `coat1`). */
        blacklevel: 0, whitelevel: 1, contrast: 1, brightness: 1, gamma1: 1, invert: 0, opacity: 1,
      }, {
        label: "norm1",
        parameters: { whitelevel: drivenSlot("roofsafe1", 1) },
      }),

      /* T797(b) — MOTION INTO THE SAME ALPHA. E41 Cinder packs rgb = colour, alpha =
         MOTION through this identical `reorder`; E27 packs rgb = colour, alpha = LUMINANCE.
         The two examples differ by what goes in alpha and nothing else, so the second half
         of the owner's sentence is E41's rig moved one file over: `cache` six frames back,
         `difference`, `level` to range it (§V694: `whitelevel` alone, no subtractive
         offset), and an `add` so the height is luminance PLUS movement. Move and you stand
         further out of the sheet.

         READ OFF `norm1`, NOT OFF `pick1`, AND THAT ORDER IS THE FINDING. The owner's
         reading was that motion carries the frame exactly when luminance is starved. It
         does not, and the frame says so: a frame difference of a dark picture is itself
         dark by the same factor, and the motion rig alone on the dimmed fixture measures
         0.0160 against the untouched 0.0159 — no visible change at all. Auto-gain first is
         what gives the difference anything to be a difference OF; (a) is not one of two
         independent fixes, it is the precondition for (b).

         `stir1.whitelevel` is E41's own 0.6, kept rather than re-fitted: the difference is
         taken off a source that has just been normalised to the same range in both files,
         so the number transfers. At 0.6 the motion term moves 56% of the frame's pixels
         (mean |Δ| 18.7/255 against the same graph with `stir1` bypassed) — a contribution,
         not a garnish — while the lit understudy still reads as the shipped picture.

         THE UNDERSTUDY IS AN HONEST-BUT-WEAK WITNESS FOR THIS HALF, and the md says so:
         E27's performer moves EVERYWHERE (a drifting dome over a bed of noise on a live
         4d axis), so the motion term reads here as a fine chatter over the whole sheet
         rather than as one thing standing out of a still room. E41 had to make its bed
         nearly still for the same claim to be legible (§V687). The witness for "the moving
         part stands out" is branch 1.

         BOTH SIDES OF THE DIFFERENCE COME OUT OF A RING, AND THAT IS THE FRAME-0 FIX.
         §V229 says a Cache tap reads the OLDEST SLICE WRITTEN rather than black — and it
         does, from frame 1 onward (measured: `past1` holds frame 0's picture at frames
         1..6 while the ring fills). On FRAME 0 there is no oldest slice yet and the tap
         reads black, so a difference taken against the LIVE source is `picture − black` =
         the whole picture: `stir1` measured mean 0.935 / peak 1.72 on frame 0 against
         0.015 from frame 1 on, and the sheet opened over-lifted and blown. That is §V732's
         transient exactly — the one that was baked into E41's baseline and passed — and
         §V769 says frame 0 is the thumbnail, so it is not a frame anyone may hand-wave.
         E41 could guard it with `ctx.firstRun` because the decision lived in a SPAWN HOOK;
         here the motion is already summed into alpha before any kernel sees it, so the
         guard has to be structural. Taking the near side out of a ring too makes frame 0
         `black − black` = 0 and every later frame identical to before: `now1` at index 1
         needs a two-slice ring, which is the cheapest allocation the node allows. */
      node("now", "cache", [-1380, 940], { frames: 2, index: 1, scale: 1 }, { label: "now1" }),
      node("past", "cache", [-1080, 940], { frames: 8, index: 6, scale: 1 }, { label: "past1" }),
      node("moved", "difference", [-780, 940], {}, { label: "moved1" }),
      node("stir", "level", [-480, 940], {
        blacklevel: 0, whitelevel: 0.6, contrast: 1, brightness: 1, gamma1: 1, invert: 0, opacity: 1,
      }, { label: "stir1" }),
      node("heat", "add", [-180, 940], {}, { label: "heat1" }),

      /* T809 — OPTIONAL AUDIO, ON THE LIFT AMPLITUDE, AND ZERO IS AN IDENTITY.
         Owner: "optional audio reactivity to drive relief in some way would be cool".
         E43 Splice is the pattern (§V147): `optional` is worth nothing as a promise and
         everything as a GATE, so the shipped gain is 0 and `relief-claims` renders the
         file with the chain in place and compares BYTES against the pre-T809 frames.

         WHERE IT IS ALLOWED TO PUSH. The height is `luminance x exposure` since T797, and
         the exposure loop OWNS `norm1.whitelevel` — a second driver there would be two
         decisions on one number, fighting the normalisation this file just gained (§V730).
         So the audio scales the kernel's LIFT AMPLITUDE instead, which is the one term
         downstream of everything the exposure decided: the sheet breathes on the kick and
         the frame's re-ranging is untouched.

         THE CHAIN IS BIAS-ENVELOPE-GAIN, AND THE ORDER IS THE IDENTITY. `low` rests at
         0.713 in the analyser's dB domain (T701), so `bsub1` puts rest at zero and the
         drive is a pure excursion. `kick1` multiplies LAST, which is what makes 0 exact: a
         gain of zero before a bias would leave the bias behind. `env1` sits BETWEEN them,
         which costs the identity nothing (anything finite times zero is zero) and is where
         an envelope has to go — smoothing a signal that has already been zeroed at rest is
         the same as smoothing it before, and putting it after the gain would smooth the
         KNOB instead of the signal.

         T820 — `env1` IS NOT OPTIONAL DRESSING, IT IS THE FEATURE. Owner, on the T809
         chain: "relief audioreactivity is too glitchy and jumpy and jittery". They were
         right and the cause was not subtle: T809 wired a RAW per-frame band value straight
         to the lift, so every frame's value was a height. `beat1`'s strike has an INSTANT
         attack (`exp(-beatPhase * 7)` at phase 0), so the drive jumped its whole 0.262
         excursion in ONE 16 ms frame and then sagged to zero before the next beat — snap,
         collapse, repeat. Measured on the picture: the strike frame's per-pixel |Δ| against
         the frame before it was 0.0649 where the file's own motion floor is 0.0228.

         `env1` IS AN ENVELOPE FOLLOWER, and it is one node now only because T814 gave the
         smoother a `releaseRatio` — before that this took a hand-built chain, which is
         exactly the per-example rebuilding T738 measured and T821 is meant to end. Lag 0.04
         is a 40 ms attack, so the strike still lands inside three frames and reads as a
         strike; ratio 8 makes the release 320 ms, so at 112 bpm it has decayed to about a
         fifth by the next beat — it PUMPS and resets rather than pumping into a plateau.
         Measured at gain 1: the strike frame's audio-attributable |Δ| falls 42% and the
         frames BETWEEN strikes fall about 80%, while the peak keeps 71% of the raw
         excursion. DO NOT "SIMPLIFY" THIS NODE AWAY — a straight `bsub1 → kick1` wire is
         the shipped bug, not a shorter spelling of this.

         AND `low` IS THE BAND THAT DOES NOT SHOW T776'S ARRANGEMENT, deliberately. The
         four-bar pull-back keeps the kick (depth 0.90 on `low` against 0.07 on `high`), so
         a breakdown moves this band by about 0.006 against a per-beat excursion of 0.26 —
         2%. What this drives is therefore per-BEAT breathing, not a phrase-length dynamic,
         and the reader should not go looking for one here. A phrase-length version of this
         is `level` or `high`, and it would swing the relief once every four bars. */
      node("beat", "audioPattern", [-1680, 1180], { bpm: 112, amount: 1 }, { label: "beat1" }),
      node("bsub", "valueMath", [-1380, 1180], { operation: "add", operand: -0.713 }, { label: "bsub1" }),
      node("env", "valueLag", [-1080, 1180], { lag: 0.04, releaseRatio: 8 }, { label: "env1" }),
      node("bgain", "valueMath", [-780, 1180], { operation: "multiply", operand: 0 }, { label: "kick1" }),

      node("palette", "ramp", [-1080, -180], {
        type: "horizontal", interp: "smooth", phase: 0, period: 1,
        /* A scan-line palette: near-black in the valleys, through a cold teal and a hot
           magenta, to a white crest. T503 freed it from a second job — `braid1` carries the
           height separately now — so these stops are chosen for CONTRAST and nothing else:
           a long dark foot so the low ground goes properly black at thumbnail size, then a
           short, violent climb through the top third so a ridge line ignites. */
        stops: [
          { position: 0, color: [0.004, 0.01, 0.035, 1] },
          { position: 0.34, color: [0.02, 0.13, 0.3, 1] },
          { position: 0.56, color: [0.08, 0.5, 0.62, 1] },
          { position: 0.76, color: [0.86, 0.2, 0.6, 1] },
          { position: 0.9, color: [1, 0.46, 0.32, 1] },
          { position: 1, color: [1, 0.97, 0.9, 1] },
        ],
      }, { label: "palette1", definitionVersion: 2 }),
      /* T809 — THE PALETTE TRAVELS, and it is a SWEEP rather than a wrap-around cycle.
         That distinction was measured, not chosen (§V471), and the reason to write it down
         is that the wrap-around is the one that sounds right.

         WHAT WAS TRIED FIRST. Ramp's own `phase` is the only parameter in this file that
         truly rotates a colour table — the shader ends in `fract(raw)` (T556), so a phase
         drive walks every colour past every stop and back. Rendered at four phases across
         one turn (0.05 / 0.30 / 0.55 / 0.80) it takes the picture apart, and the mechanism
         is structural rather than a tuning miss: THIS RAMP IS MONOTONE IN LUMINANCE BY
         DESIGN (T503 chose a near-black foot and a white crest so the colour climbs with
         the height), and rotating a monotone table makes it non-monotone. So "brighter"
         stops meaning "further up the ramp", and the relief loses the only reading it has:
         at 0.05 the crest wraps past white and punches BLACK HOLES in the summit; at 0.30
         the dome inverts to a black silhouette inside a white outline; at 0.55 the frame
         is a posterised contour map of white islands. Held in the graph at zero it would
         be a knob that looks broken the moment anyone turns it, so it is not wired.

         WHAT SHIPS. Lookup's shader is `clamp(index * scale + offset, 0, 1)`, so driving
         `offset` slides the picture ALONG the ramp and clamps at the ends — it never
         wraps, which means it never breaks the monotone mapping. The colours still travel
         (a white crest cools to orange and magenta, the ridge line moves down the sheet,
         the teal ground deepens) and the composition survives every phase of the swing.
         Negative is the free direction; positive costs the summit's detail to the top
         stop, which is why the swing is small.

         AND IT CANNOT REACH THE GEOMETRY. `braid1` carries the shape in alpha and the
         colour in rgb (T503), so this is a colour-only drive by construction — it cannot
         fight T797's exposure loop or its motion path, both of which are in alpha.

         Shipped at `cycle1.amplitude = 0`. An LFO returns `offset + amplitude * wave`, so
         that is EXACTLY 0.0 and the frame is the one T797 left. */
      node("coat", "lookup", [-780, -20], {
        channel: "luminance", row: 0.5, scale: 1, offset: 0,
      }, { label: "coat1", parameters: { offset: drivenSlot("cycle1", 0) } }),
      /* 0.035 Hz is §V471(8)'s long cycle — about 29 seconds, and incommensurate with the
         sway (0.024) and both drifts (0.019, 0.013), so no two laps of the camera meet the
         same palette. Sine rather than saw: a saw would snap the colour back at the wrap,
         and a clamped sweep has no wrap to hide it in. */
      node("cycle", "lfo", [-1380, -420], {
        shape: "sine", frequency: 0.035, amplitude: 0, offset: 0, phase: 0,
      }, { label: "cycle1" }),
      /* T503 — TWO FIELDS, ONE BRIDGE. rgb is the paletted colour; ALPHA is the source's
         own luminance, straight off `pick1` before the palette touched it. There is exactly
         one texture-to-points bridge in the catalogue and it carries four channels, so the
         shape and the colour do not have to be the same number — which is what stopped the
         relief from being a caricature of the palette's transfer curve. */
      node("braid", "reorder", [-480, -20], {
        outr: "in1r", outg: "in1g", outb: "in1b", outa: "in2lum",
      }, { label: "braid1" }),

      node("sheet", "pointGrid", [-480, 280], {
        count: RELIEF_COLS * RELIEF_ROWS, cols: RELIEF_COLS, rows: RELIEF_ROWS,
      }, { label: "grid1" }),
      node("bridge", "textureToAttribute", [-180, 140], {
        count: RELIEF_COLS * RELIEF_ROWS,
      }, { label: "bridge1" }),
      node("lift", "pointKernel", [120, 140], {
        capacity: RELIEF_COLS * RELIEF_ROWS,
        seed: 41,
        attributes: JSON.stringify([
          { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
          { name: "sample", type: "vec4f", default: [0, 0, 0, 0] },
        ]),
        kernel: RELIEF_LIFT_KERNEL,
      }, {
        label: "lift1",
        /* T479: a value write per frame, never a rebuild (§V5). Retained 0 as well as
           driven 0, so a host with no channels attached renders the same picture — and so
           a rename of `kick1` falls back to the shipped file rather than to a surprise
           (§V129 is the reason that matters). */
        parameters: { value1: drivenSlot("kick1:low", 0) },
      }),

      /* UNLIT, and that is the look: a phosphor does not have a diffuse response. The
         colour comes entirely from T478's per-point TINT, so `render`'s light list is
         empty and nothing shades these quads. */
      node("phosphor", "materialUnlit", [120, -180], {
        color: [1, 1, 1, 1],
      }, { label: "phosphor1" }),
      node("body", "geometry", [420, 140], {
        /* The quad half-extent must stay UNDER half the point spacing (3.56 world units
           across 480 columns = 0.0074), or the quads overlap into a solid slab and the
           scan lines disappear. The first build ran 0.0075 and rendered one flat sheet. */
        mode: "instances", shape: "quad", scale: 0.0026, material: "phosphor1",
        tint: [1, 1, 1, 1],
      }, {
        label: "body1",
        /* T478: the sampled colour multiplies the material's base colour PER POINT. White
           base means the tint IS the colour. */
        parameters: { tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] }, map: { kind: "map", attribute: "sample" } } } },
      }),
      node("eye", "camera", [420, -180], {
        /* T676 — A FRONT VIEW, because the sheet stands up now (see RELIEF_LIFT_KERNEL).
           T503's number is still the one that matters — how much of the view direction runs
           PARALLEL to the height axis — and this framing keeps it where T503 put it. The
           first build ran 86% and the relief did not project at all; the landscape camera
           got it to ~19%; standing the sheet up and looking at it LEVEL gives the same ~19%
           from the other side, because the sheet leans back 20 degrees and the eye is on its
           centre line. So the picture reads face-on, as a scanned frame should, and the
           silhouettes and the scan-line bunching are still there to read it by.

           Framed on the stood-up extent rather than guessed: the sheet spans y -1.14..+1.39
           and its middle row sits at z ~ +0.35, so a half-height of 1.26 at fov 40 needs
           3.46 and this sits at 3.90 for margin. Width is not the binding constraint at
           16:9 (half-width 1.78 against 2.53 available).

           THE SWAY IS NOW LOAD-BEARING, not decoration. A relief seen face-on under no
           light has no shading to give it depth, so PARALLAX is what remains: eye.x swings
           +/-1.15 at 0.024 Hz, which is +/-16 degrees at this distance, and the near ridges
           slide against the far ground the way they would if you moved your head. Laid down
           this was a garnish; stood up it is the depth cue. */
        eye: [0, 0.13, 4.25], lookAt: [0, 0.13, 0.35], fov: 40, near: 0.1, far: 100, ortho: false,
      }, {
        label: "eye1",
        parameters: { "eye.x": drivenSlot("sway1", 0) },
      }),
      node("sway", "lfo", [120, -420], {
        shape: "sine", frequency: 0.024, amplitude: 1.15, offset: 0, phase: 0,
      }, { label: "sway1" }),
      node("shot", "render", [720, 140], {
        scenes: "body1", camera: "eye1", lights: "",
        ambientColor: [1, 1, 1, 1], ambientIntensity: 0,
        background: [0.002, 0.004, 0.011, 1],
      }, { label: "shot1" }),

      /* BLOOM, and on an unlit phosphor it is not decoration: it is what makes thousands of
         separate quads read as one glowing surface instead of as a dotted grid. */
      node("halo", "blur", [1020, 300], { size: 18, filter: "gaussian", extend: "hold" }, { label: "halo1" }),
      node("burn", "add", [1320, 140], {}, { label: "burn1" }),
      node("out", "output", [1620, 140], {}, { label: "out1" }),
    ],
    [
      edge("e-ripple-bed", ["ripple", "out"], ["bed", "input"]),
      edge("e-swell-sum", ["swell", "out"], ["sum", "in1"]),
      edge("e-bed-sum", ["bed", "out"], ["sum", "in2"]),
      // BRANCH 0 is the understudy, BRANCH 1 is the camera, and the ORDER SAYS SO (§V131).
      // Left to the id tiebreak, "e-cam-pick" sorts before "e-sum-pick" and the file opens
      // on a black camera — the exact null state §V363 exists to prevent, chosen by
      // alphabet.
      edge("e-sum-pick", ["sum", "out"], ["pick", "inputs"], 0),
      edge("e-cam-pick", ["cam", "out"], ["pick", "inputs"], 1),
      // T797 — THE EXPOSURE, and it is measured off the source BEFORE the gain, which is
      // what keeps it a measurement rather than a loop: `roof1` reads `pick1`, `norm1`
      // applies what `roof1` said. Nothing downstream of `norm1` feeds back into it.
      edge("e-pick-roof", ["pick", "out"], ["roof", "input"]),
      edge("v-ceil-guard", ["ceil", "out"], ["guard", "in"]),
      edge("e-pick-norm", ["pick", "out"], ["norm", "input"]),
      // ...and EVERY reader is downstream of it: the colour, the height, and the motion.
      edge("e-norm-coat", ["norm", "out"], ["coat", "source"]),
      edge("e-palette-coat", ["palette", "out"], ["coat", "lookup"]),
      // T797(b) — E41's motion instrument, off the RE-RANGED source (see the note above:
      // a difference of a dark picture is a dark difference).
      edge("e-norm-now", ["norm", "out"], ["now", "input"]),
      edge("e-norm-past", ["norm", "out"], ["past", "input"]),
      // BOTH taps are rings, so the first frame differences black against black (§V229's
      // gap on frame 0) instead of the whole picture against black (§V732/§V769).
      edge("e-now-moved", ["now", "out"], ["moved", "in1"]),
      edge("e-past-moved", ["past", "out"], ["moved", "in2"]),
      edge("e-moved-stir", ["moved", "out"], ["stir", "input"]),
      edge("e-norm-heat", ["norm", "out"], ["heat", "in1"], 0),
      edge("e-stir-heat", ["stir", "out"], ["heat", "in2"], 1),
      // T809 — the optional audio, wired but at gain zero. `kick1:low` reaches `lift1`'s
      // value slot, which is the LIFT AMPLITUDE and nothing else.
      edge("v-beat-bsub", ["beat", "out"], ["bsub", "a"]),
      // T820: the envelope follower goes BETWEEN the bias and the gain. `bsub1 → kick1`
      // direct is what shipped and what the owner called jittery.
      edge("v-bsub-env", ["bsub", "out"], ["env", "in"]),
      edge("v-env-bgain", ["env", "out"], ["bgain", "a"]),
      // THE BRAID: colour in from the palette, SHAPE in from the un-coated source — which
      // is now that source's luminance PLUS its movement (T797). Only the height carries
      // the motion; the colour path stays the picture.
      edge("e-coat-braid", ["coat", "out"], ["braid", "in1"]),
      edge("e-heat-braid", ["heat", "out"], ["braid", "in2"]),
      edge("e-sheet-bridge", ["sheet", "out"], ["bridge", "points"]),
      edge("e-braid-bridge", ["braid", "out"], ["bridge", "texture"]),
      edge("e-bridge-lift", ["bridge", "out"], ["lift", "in"]),
      edge("e-lift-body", ["lift", "out"], ["body", "points"]),
      edge("e-shot-halo", ["shot", "out"], ["halo", "input"]),
      edge("e-shot-burn", ["shot", "out"], ["burn", "in1"]),
      edge("e-halo-burn", ["halo", "out"], ["burn", "in2"]),
      edge("e-burn-out", ["burn", "out"], ["out", "input"]),
    ],
  ),
);
