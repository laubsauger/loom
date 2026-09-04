import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E56 — Vesper (T1155, T1152, T1149). THE INTENSITY OF THE MOMENT DECIDES THE TIME OF DAY.
 *
 *   music1(audioPattern) ─┐
 *   track1(audioFileIn)  ─┴► source1(valueSwitch) ─► env1(valueLag) ─► sun1(valueMath, INVERTED)
 *                                                                          ┄high┄► clip1.cuePoint
 *
 *   clip1(movieFileIn, 540x960) ─► tone1(level) ─► grade1(hsv) ─► mul1 ─► out1
 *                                                  vign1(circle) ────────►┘
 *
 * ## The idea
 *
 * A 9.7-second sunset timelapse, and a playhead that is not a clock. The louder the music,
 * the higher the sun; let the music fall away and the sun sinks. Nothing here integrates —
 * the level maps to a POSITION, absolutely, so a given loudness always names the same time
 * of day and the picture is reproducible against the track rather than against how long you
 * have been listening. A speed-driven version drifts, and after a minute the same phrase
 * lands somewhere else.
 *
 * ⚑ THE MAPPING IS INVERTED, AND THAT INVERSION IS THE WHOLE POEM. The clip runs sun-high
 * to sun-gone, so LOUD maps to 0 and QUIET maps to the end: `sun1` is a Range whose output
 * bounds are written backwards (`toLow` 9.7, `toHigh` 0), which is a documented way to
 * write a reversal in one node rather than a subtract-from-one hung off a second.
 *
 * ## The mechanism, and why it needs no new node (T1149's spike, T1152's ruling)
 *
 * `movieFileIn` with `cue: true` holds the element at `cuePoint`, and no transport
 * parameter is `compileTime` — so a DRIVEN `cuePoint` is a scrub input that costs no
 * recompile. The cache cannot do this (its tap is structural and maxes at 63 frames) and it
 * does not need to: the clip is all-intra, so every one of its 291 frames is a keyframe and
 * a seek lands without decoding a GOP.
 *
 * ⚑ MEASURED, real Chrome, this asset, through `applyMediaPlayhead`'s own held branch, over
 * a 30-second steady-state window: 58.9 seeks issued per second, 58.9 COMPLETED, ZERO
 * superseded, 56.6 frames actually presented per second, and 268 of the clip's 291 frames
 * distinctly presented. T1149 measured 88% of seeks superseded and warned that naive
 * per-frame driving costs 59% of the achievable rate — TRUE OF ITS 1080p/100-SECOND
 * FOOTAGE, AND NOT TRUE HERE: this clip is a quarter of the pixels and a tenth of the
 * duration, and it sits in memory. So E56 ships with NO THROTTLE, and that is a measurement
 * rather than an oversight — a minimum-delta gate at one source frame was tried and only
 * lost update rate (59.1 completed per second down to 35.1). The instrument was red-verified
 * against a hostile drive before its zero was believed: a full-clip jump every tick at
 * 240 Hz reports 19.4% superseded, so 0% at 60 Hz is a real zero rather than a blind counter
 * (§V918).
 *
 * ## The asset ships WITH the app, and it is the first one that does
 *
 * `public/media/portrait-sunset.mp4` — 540x960, H.264 8-bit, 291 frames at 30fps, 2.94 MB,
 * every frame a keyframe. Vite copies `public/` verbatim, and the `file` parameter is a
 * plain URL string handed to `video.src`, so `"media/portrait-sunset.mp4"` — RELATIVE, with
 * no leading slash — resolves against the page's own base in both deployments: `/media/...`
 * on the dev server and `/loom/media/...` on Pages, where an absolute path would 404. Named
 * for its SHAPE rather than for this example, because it is the catalogue's only portrait
 * video and the next vertical piece should point at it.
 *
 * This is the first example that opens with real footage already in it, and it is §V363
 * satisfied rather than worked around: every other media example in the catalogue shows its
 * null state until the user supplies a file.
 *
 * ## The envelope does the aesthetic work, and it is `high` rather than `level`
 *
 * ⚑ The owner asked for volume, and on a real track `level` IS the intensity of the moment.
 * On the synthetic understudy it is not: measured over 150 seconds, `audioPattern`'s `level`
 * settles into a bar-to-bar mean of 0.226..0.270 — a 0.044 wiggle that would strobe the sun
 * per beat and sweep nothing. `high` is where T776's arrangement lives: its bar means run
 * 0.39 / 0.43 / 0.44 / 0.35 and repeat, so the quiet bar of every four IS a sunset, every
 * 8.6 seconds. Choosing the channel the shipped fixture actually articulates is what keeps
 * the demo demonstrating the thing it claims.
 *
 * `env1` is a peak follower — 0.6 s rise, x8 release (4.8 s fall). Chosen by scoring phrase
 * swing against per-beat ripple over a long horizon, and the long horizon is load-bearing:
 * the best-scoring settings (lag 2, ratio 32) turned out to be A SLOW MINUTE-LONG CLIMB
 * WEARING A CYCLE, its 4-bar amplitude decaying from 0.022 to 0.008 while the score said it
 * was the cleanest of all. At 0.6/8 the cycle amplitude is stationary at ~0.08 from bar five
 * onward.
 *
 * ## §V903 — the duty cycle, not the range
 *
 * `sun1` maps 0.33..0.45 onto 9.7..0 seconds, CLAMPED, and the clamp is reached on purpose:
 * pinning here means "broad daylight" and "fully dark", which is the picture rather than a
 * saturated control. Measured over 3600 frames of the shipped pattern:
 *
 *   - 93.4% of steady-state draws land in the INTERIOR; longest pinned run 38 frames (0.63s)
 *   - the lane visits 284 of the clip's 291 distinct frames
 *   - the playhead travels 2.55 clip-seconds per wall-second
 *   - whole-run duty including the opening is 83.2%, because the first 394 frames (6.6 s)
 *     sit pinned at 0 while the follower settles. THE FILE OPENS IN DAYLIGHT AND THE SUN
 *     THEN SETS — that hold is the opening shot, and it is why frame 60, the gallery card,
 *     is a bright one.
 *
 * ## §V914 — what stands when there is no audio
 *
 * `cuePoint` retains 3.42, the DRIVEN MEAN, which sits well inside the 0..9.7 the drive
 * produces: a host with no audio opens on the sun already low but still above the horizon,
 * not on a time of day the music never reaches. `dim1.brightness` retains 0.49 on the same
 * rule. Both matter more here than usual — every headless render and every thumbnail is
 * captured with no track at all.
 *
 * ## Portrait, recorded rather than arranged (round two, the owner's first note)
 *
 * The project is 720x1280 and it SHIPS that way, so opening the file sets it. The first
 * version was built at 1280x720 and out-painted the sides — the clip stretched, blurred and
 * dimmed as an ambient bed with the true-aspect panel over it. That was a good trick for the
 * wrong problem: the piece is portrait, so the frame should be. It is gone, and §T1160 is
 * where it goes next as an example about the fill itself.
 *
 * ⚠ The viewer STRETCHES rather than letterboxes today (§T1158, being fixed elsewhere), so a
 * portrait project reads correctly everywhere except the viewer pane. That is the viewer, not
 * this file's resolution.
 *
 * ⚑ `clip1`'s resolution is PINNED to the file's own 540x960 rather than left to inherit.
 * `use-media-sources` writes a `setNodeResolution` patch when the intrinsic size differs from
 * the node's, so an unpinned document MUTATES ITSELF the moment it opens; pinned to the true
 * size, the patch never fires and the file on disk is the file you loaded. `tone1` carries
 * `resolution: project`, so the 540x960 file becomes the 720x1280 frame there — same aspect,
 * a straight 1.33x scale, no reframing.
 *
 * ## ⚑ THE BUG THIS EXAMPLE FOUND, AND IT WAS NOT IN THIS FILE
 *
 * `createMediaTransportRunner` built its resolve options by hand — `{ frame, channels }`,
 * with NO `nodes` reader — and `op('sun1').chan.high` is read INSIDE that reader (§V837),
 * never off `channels`. So EVERY expression on EVERY transport parameter has failed with
 * "this context has no channel resolver" and frozen on §V108's retained static since T493,
 * while that function's own docblock promised "a `cuePoint` bound to a sibling, a `trimStart`
 * driven by an audio channel". Twenty-six tests in `media-playback.test.ts` were green
 * throughout: every one of them resolves a STATIC parameter.
 *
 * §B8's shape, and §V837 already counts four (§T593, §T1000, §T1001, §B46). This was the
 * fifth. Symptom, in the running app: the file loaded, the element reached readyState 4 at
 * 540x960, and `currentTime` sat at 3.42 forever. Fixed through `createParameterReadOptions`,
 * gated in `media-playback.test.ts`, red-verified both ways.
 *
 */
export const vesperDocument = document(
  "e56-vesper",
  "E56 Vesper",
  /* ⚑ T1155 round two, the owner's first note: THE PROJECT IS PORTRAIT, and it is recorded
     here so opening the file sets it. 720x1280 is exactly the clip's own 9:16 (540/960 =
     720/1280 = 0.5625), so the only resample between the file and the frame is a 1.33x
     scale with no reframing at all. */
  settings({ randomSeed: 56, outputResolution: { width: 720, height: 1280 } }),
  graph(
    [
      // ---- the drive: the catalogue's fixed shape (audio-rd.ts, reactor.ts) -----------
      node("music", "audioPattern", [-2100, 700], { bpm: 112, amount: 1, beatsPerBar: 4 }, { label: "music1" }),
      node("track", "audioFileIn", [-2100, 1120], {
        cue: false, cuePoint: 0, extend: "loop", file: "", monitor: true, play: true,
        playMode: "freeRun", speed: 1, trimEnd: 0, trimStart: 0, volume: 1,
      }, { label: "track1" }),
      /* Index 0 is the deterministic pattern so the file plays on open (§V363); drop a track
         into `track1` and move this to 1 and the same sun answers to real music. */
      node("source", "valueSwitch", [-1800, 910], { index: 0 }, { label: "source1" }),
      /* Fast attack, slow release: 0.6 s up, 4.8 s down. See the docblock — the settings were
         scored on a 150-second horizon precisely because a shorter one cannot tell a cycle
         apart from a climb. */
      node("env", "valueLag", [-1500, 910], { lag: 0.6, releaseRatio: 8 }, { label: "env1" }),
      /* ONE affine map, calibrated on the shipped pattern's measured 0.33..0.45, and its
         output bounds are INVERTED (9.7 down to 0): loud is the start of the clip, where the
         sun is still up. This is the file's only driven lane. */
      node("sun", "valueMath", [-1200, 910], {
        operation: "range", fromLow: 0.33, fromHigh: 0.45, toLow: 9.7, toHigh: 0, outside: "clamp",
      }, { label: "sun1" }),

      // ---- the footage ---------------------------------------------------------------
      node("clip", "movieFileIn", [-2100, 0], {
        file: "media/portrait-sunset.mp4",
        playMode: "freeRun", play: true, speed: 1,
        /* Cue HOLDS the element at the cue point in either play mode, which is what turns a
           transport into a scrub input. `cuePoint` is seconds into the file. */
        cue: true,
        extend: "hold", trimStart: 0, trimEnd: 0,
      }, {
        label: "clip1",
        resolution: { mode: "fixed", width: 540, height: 960 },
        parameters: { cuePoint: drivenSlot("sun1:high", 3.42) },
      }),

      // ---- THE GRADE, and it is the file's exposure and contrast desk -----------------
      /*
       * ⚑ The owner's third note: "feels very flat and very weak on contrast", and he is
       * right about the picture and it is not a colour-space fault — `media.ts` uploads
       * `rgba8unorm-srgb` and the hardware decodes to linear correctly (§V56). THE FOOTAGE
       * IS FLAT: a dusk timelapse on a phone, with auto-exposure actively flattening it as
       * the light falls.
       *
       * So the desk is graph work rather than a grading page bolted onto `movieFileIn`,
       * which would be a second copy of `level` disagreeing with the first (§T1064 deleted
       * ~180 lines of exactly that). `tone1` is the exposure/contrast half, `grade1` the
       * colour half, and between them they are the knobs to reach for on ANY video in the
       * catalogue — which is the general answer he asked for.
       *
       * The values are chosen FOR THIS CLIP rather than left neutral, because a shipped
       * identity grade would be no answer at all:
       *
       *   blacklevel 0.055  the haze floor. The clip's darkest scrub is a lifted grey, so
       *                     the black point is where the picture's own black is, not 0.
       *   whitelevel 0.86   the sun and its water track are the only real highlights and
       *                     they sit well under 1; pulling the white point down is the
       *                     exposure half of the answer.
       *   contrast   1.3    after the two points, the S the flat curve was missing.
       *   gamma1     0.9    the mids down a little, so the dune reads as a silhouette
       *                     rather than as grey — which is the thing that made it "weak".
       *   saturation 1.32   a sunset carries it, and auto-exposure had drained it.
       *
       * §V914 does NOT apply to any of them: they are static knobs, deliberately, so that
       * the person tuning them is the person looking at the picture.
       *
       * `resolution: project` is on `tone1` and that is where the 540x960 file becomes the
       * 720x1280 frame — same aspect, so a straight 1.33x scale.
       */
      node("tone", "level", [-1700, 0], {
        blacklevel: 0.055, whitelevel: 0.86, invert: 0, gamma1: 0.9,
        contrast: 1.3, brightness: 1, opacity: 1,
      }, { label: "tone1", resolution: { mode: "project" } }),
      node("grade", "hsv", [-1400, 0], { hueoffset: 0, saturation: 1.32, value: 1 }, { label: "grade1" }),

      // ---- the finish ----------------------------------------------------------------
      node("vign", "circle", [-1400, 420], {
        mode: "fill", center: [0.5, 0.5], radius: [0.78, 0.78], softness: 0.6,
        fillcolor: [1, 1, 1, 1], bgcolor: [0.3, 0.28, 0.34, 1], aspectcorrect: true,
      }, { label: "vign1", resolution: { mode: "project" } }),
      node("mul", "multiply", [-1100, 0], { opacity: 1 }, { label: "mul1" }),
      node("out", "output", [-800, 0], { toneMap: "filmic" }, { label: "out1" }),
    ],
    [
      edge("e-music-source", ["music", "out"], ["source", "in1"]),
      edge("e-track-source", ["track", "out"], ["source", "in2"]),
      edge("e-source-env", ["source", "out"], ["env", "in"]),
      edge("e-env-sun", ["env", "out"], ["sun", "a"]),

      edge("e-clip-tone", ["clip", "out"], ["tone", "input"]),
      edge("e-tone-grade", ["tone", "out"], ["grade", "input"]),
      edge("e-grade-mul", ["grade", "out"], ["mul", "in1"]),
      edge("e-vign-mul", ["vign", "out"], ["mul", "in2"], 0),
      edge("e-mul-out", ["mul", "out"], ["out", "input"]),
    ],
  ),
);
