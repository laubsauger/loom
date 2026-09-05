import { settings, node, edge, graph, document, drivenSlot } from "./builders.ts";

/**
 * E56 — Vesper (T1190, T1155, T1152, T1149). THE INTENSITY OF THE MOMENT SETS THE SPEED OF THE DAY.
 *
 *   music1(audioPattern) ─┐
 *   track1(audioFileIn)  ─┴► source1(valueSwitch) ─► env1(valueLag) ─► norm1(valueNormalize)
 *                                                                          │
 *              travel1(valueSpeed) ◄── rate1(valueMath, range) ◄───────────┘
 *                   ┄high┄► clip1.cuePoint
 *
 *   clip1(movieFileIn, 1280x720) ─► tone1(level) ─► grade1(hsv) ─► mul1 ─► out1
 *                                                   vign1(circle) ───────►┘
 *
 * ## The idea
 *
 * A twenty-second aerial timelapse of Tokyo running from the electric night through blue
 * hour to sunrise, and a playhead that is not a clock. The louder the music, the faster the
 * day turns; let the music fall away and it crawls. The picture never stops, and it never
 * arrives anywhere it can get stuck.
 *
 * ## ⚑⚑ ROUND TWO DROVE A POSITION AND IT FROZE. THIS DRIVES A SPEED.
 *
 * The owner, on round two: *"For some reason that causes the playback to freeze and stay in
 * place at certain levels... we're seeing the image freezing a lot... it still doesn't keep
 * interesting and navigates itself into a corner. Maybe we're lagging/enveloping/normalizing
 * it to a flat line and nothing moves until something shuffles."*
 *
 * He is right, he diagnosed the cause himself, and it is STRUCTURAL rather than a tuning
 * failure. Round one and round two both mapped the audio onto an ABSOLUTE POSITION in the
 * clip, and:
 *
 *   UNDER A POSITION MAP, A CONSTANT INPUT IS A FROZEN PICTURE.
 *
 * Every stage that makes a control signal usable makes it FLATTER — the envelope follower,
 * the lag, and yes `norm1` too — and flatness on a position map renders as stillness. There
 * is no setting that escapes it; tuning only trades a freeze for a jitter.
 *
 * ⚑ HIS IMMEDIATE FREEZE HAD A SECOND, SHARPER CAUSE AND IT IS WORTH RECORDING. He set the
 * Range to `From Low 0.20 ... From High 0.99` with `Outside: Clamp`. `norm1` publishes a
 * PERCENTILE, so "below 0.20" is not a rare excursion — it is, by construction, EXACTLY 20%
 * OF THE TIME. Reproduced on this chain: 20.3% of the run pinned at frame 0, with a longest
 * pinned run of 109 frames (1.82 s). A percentile input makes a clamped From Low into a
 * literal duty cycle of frozen picture, which is a trap worth knowing about and not one the
 * node can prevent.
 *
 * ## Driving a SPEED instead, and what it buys
 *
 * `travel1` is a `valueSpeed` — TD's Speed CHOP, and the value family's first accumulator.
 * The audio sets a RATE in clip-seconds per second; the node integrates it into the
 * position that `clip1.cuePoint` reads. Three things follow, and all three are the owner's
 * asks answered at once:
 *
 *  - IT CANNOT FREEZE. A constant input is constant motion. `rate1`'s low end is 0.4
 *    clip-seconds per second, a FLOOR rather than zero, so even the quietest moment is
 *    still travelling. MEASURED over 2400 steady-state frames, as the longest run of frames
 *    showing the same source frame — the honest reading of "it freezes":
 *
 *      position map, the owner's own settings   109 frames still (1.82 s)
 *      position map, as round two shipped        14 frames still (0.23 s)
 *      THIS, the rate drive                       5 frames still (0.08 s)
 *
 *  - IT CANNOT CORNER ITSELF. There is no absolute target to sit on, and `travel1`'s limit
 *    is MIRROR, so the ends of the lane bounce rather than clamp or jump-cut. A wrap would
 *    be a hard cut from sunrise to midnight; a bounce is the day running backwards.
 *
 *  - ⚑ REVERSE IS NOW ON SCREEN. The rate is strictly positive and the picture still runs
 *    BACKWARDS 55% of the time, because the bounce supplies the sign. Round two's file
 *    documented that reverse existed and never showed it, which is why the owner asked for
 *    it twice.
 *
 * ## ⚠ THE COST, AND IT REVERSES T1152's RULING
 *
 * Round one chose an absolute position deliberately, and its argument was good: a given
 * loudness named a given time of day, so the picture was reproducible against the track
 * rather than against how long you had been listening. AN INTEGRATOR GIVES THAT UP. Where
 * the playhead is now depends on how it got there; a scrub does not find it and an offline
 * render reproduces only from a transport reset.
 *
 * That is not new ground — `stateful` with `randomAccess: false` is what Lag, Filter, Slope
 * and Trigger already declare (§V181) — but it IS the trade, and it was made because the
 * owner used both and chose this one. A file that is reproducible and frozen is worth less
 * than one that is alive.
 *
 * ## The mapping into the rate, and why `norm1` stays
 *
 * *"maybe we make up an interesting ranging system that doesn't just make it linear on the
 * frequency or loudness spectrum — it gives more resolution to where there's more
 * interesting changes, instead of wasting most of the resolution on the first 20 decibels
 * that will almost always be used up."*
 *
 * A loudness envelope sits in a narrow band around its own median nearly all the time. Map
 * that band LINEARLY and most of the output range goes to levels the signal rarely visits.
 * `norm1` maps each channel through ITS OWN DISTRIBUTION — the percentile within its last
 * 17 seconds — so equal amounts of TIME map to equal amounts of RANGE, with no floor and no
 * gain to retune when the track changes.
 *
 * ⚑ UNDER A RATE DRIVE THAT IS A BETTER JOB FOR IT THAN IT HAD, and the instrument had to
 * change with it. What `norm1` shapes now is HOW THE SPEED IS DISTRIBUTED — and NOT the
 * position, which under a bounced integral comes out even for almost any positive rate and
 * therefore proves nothing about the mapping. MEASURED as the share of the run in each
 * twentieth of the 0.4..5 rate range:
 *
 *   percentile (ships)   6 6 5 5 5 4 5 5 6 5 5 5 5 5 5 5 5 5 6 6    4.4%..6.0%, TV  3.6%
 *   raw envelope         3 4 3 3 2 2 2 1 1 2 1 1 1 2 2 1 3 5 28 33  1.0%..32.8%, TV 51.3%
 *
 * The raw arm is AUTO-CALIBRATED to the envelope's own measured span (0.113..0.443) — a
 * calibration no human could beat, because it is measured from the answer — and it still
 * spends 61% of the run in the top TENTH of the speed range. That is the owner's sentence
 * exactly, with the sign flipped: the picture would sit near full speed almost always and
 * the quiet moments would never actually be slow.
 *
 * Its one real drawback — the distribution ADAPTS, so the same loudness means different
 * things at different times — also stops mattering nearly as much, because nothing is
 * pinned to an absolute position any more.
 *
 * `window` is the drift knob and the rule is that IT MUST EXCEED THE CYCLE YOU WANT TO SEE;
 * 17 s is two of this fixture's 8.57 s phrases. At 2 s a quarter of the run collapses into
 * one twentieth of the range — the cycle is normalised away and the variation dies.
 *
 * ## The lane, and it stops short of BOTH ends of the file
 *
 * `travel1` travels between 0.4 s and 14.6 s of a 20.67 s file, so the drive never reaches
 * either end — the owner's *"we need to range it so that we don't hit the actual end of
 * frame range"*, and with MIRROR it is structural rather than a clamp. The 6 s given up are
 * a judgement about the footage: the last quarter of this clip is flat white haze, source
 * frames 384 onward differ from each other by almost nothing, and a drive that covered them
 * would spend a quarter of its travel there.
 *
 * ⚑ A CURVE IS DELIBERATELY NOT SHIPPED. *"maybe we can even curve it so there's more
 * resolution in a certain area of the clip"* — a hand-picked curve re-introduces exactly the
 * eyeballed knob the percentile map removes, and the argument against the linear map is the
 * argument against it. When the ask is "dwell in THIS part of the clip", the honest control
 * is the one that names that part: `travel1`'s own bounds, or `trimStart`/`trimEnd`.
 *
 * ## What the transport already did, and why it looked like it did not (T493)
 *
 * *"do we have reverse now? We don't have reverse play."* It has since T493: `speed` is
 * declared down to -4, `mediaPlayhead`'s wrap is a positive modulo written for it, and
 * `applyMediaPlayhead` pauses the element and steps `currentTime` by hand because no browser
 * plays a negative `playbackRate`. `extend: "mirror"` ping-pongs, likewise gated since T493.
 *
 * ⚠ AND NEITHER DID ANYTHING ON THIS FILE, WHICH IS WHY HE COULD NOT FIND THEM.
 * `mediaPlayhead` answers a HELD CUE before it looks at the clock, so with `cue: true` —
 * this file's whole mechanism — `speed`, `play` and `extend` are not read at all. They were
 * live controls doing nothing with nothing saying so. T1190 gave all three an
 * `inactiveWhen` (§V123/§V146) that names the cue and says what to do instead, and gated it
 * against `mediaPlayhead` itself rather than against the schema, so the dimming cannot
 * become a lie. A capability that is present and undiscoverable was not delivered.
 *
 * ## The mechanism, unchanged: a driven `cuePoint` is a scrub input
 *
 * `movieFileIn` with `cue: true` holds the element at `cuePoint`, and no transport
 * parameter is `compileTime` — so a DRIVEN `cuePoint` costs no recompile. The cache cannot
 * do this (its tap is structural and maxes at 63 frames).
 *
 * ## The asset ships WITH the app, and T1190 RE-ENCODED IT
 *
 * `public/media/shibuya-crossing.mp4` — 1280x720, H.264 High 8-bit, 496 frames at 24 fps,
 * 20.67 s, 2.92 MB, 42 keyframes. Vite copies `public/` verbatim, and the `file` parameter
 * is a plain URL string handed to `video.src`, so `"media/shibuya-crossing.mp4"` —
 * RELATIVE, with no leading slash — resolves against the page's own base in both
 * deployments: `/media/...` on the dev server and `/loom/media/...` on Pages, where an
 * absolute path would 404.
 *
 * ⚠⚑ THE ENCODE IS PART OF THE EXAMPLE, AND THE DELIVERED ASSET COULD NOT DO THIS JOB —
 * MEASURED, not reasoned. It arrived with TWO KEYFRAMES in the whole clip (a 250-frame
 * GOP), which is how it fit in 2.53 MB. A driven `cuePoint` seeks EVERY FRAME, so the cost
 * of a random seek is the whole performance story, and in headed Chrome over 40 random
 * seeks it was:
 *
 *   as delivered, 250-frame GOP   median 32.5 ms   p90 50.8 ms   max 55.6 ms
 *   re-encoded, 12-frame GOP      median  4.5 ms   p90  5.7 ms   max  7.6 ms
 *
 * A 60 Hz frame is 16.7 ms. The delivered clip's MEDIAN seek is two frames long and its
 * worst is three; the re-encode's WORST is under half of one. That is the difference
 * between an update rate the drive sets and one the decoder sets.
 *
 * `-g 12 -keyint_min 12 -sc_threshold 0 -bf 0`, with a light `hqdn3d` denoise paying for
 * the extra keyframes: 2.92 MB, which is ABOVE the 2.53 MB delivered and BELOW the 3.09 MB
 * of `portrait-sunset.mp4`, the clip it takes over from. Quality was compared at 1:1 crops
 * on a night frame and a sunrise frame before the crf was believed.
 *
 * ⚠ `public/media/portrait-sunset.mp4` IS NOW REFERENCED BY NOTHING and is deliberately
 * still there: it is 3.09 MB in every deploy, and whether it goes is the owner's call
 * (§T1160 was the example that would have used it again). Named rather than quietly
 * removed, and named rather than quietly left.
 *
 * All-intra — round one's asset was, and its docblock leaned on it — was measured and
 * REJECTED: 720p all-intra of this footage is 5.1 MB at crf 36 and 12.3 MB at crf 30. The
 * all-intra property was never the requirement; a seek the decoder can serve inside a frame
 * was, and twelve frames of GOP buys that at a quarter of the bytes.
 *
 * ## Portrait is GONE — the project is 16:9 again (the owner's T1190 note)
 *
 * Round one shipped 720x1280 for a portrait phone clip. This clip is 1280x720 and the
 * project records that, so opening the file sets it. `clip1`'s resolution is PINNED to the
 * file's own 1280x720 rather than left to inherit: `use-media-sources` writes a
 * `setNodeResolution` patch when the intrinsic size differs from the node's, so an unpinned
 * document MUTATES ITSELF the moment it opens. Pinned — and equal to the project — the
 * patch never fires and there is no resample between the file and the frame at all.
 *
 * ## The envelope, and it is `high` rather than `level`
 *
 * ⚑ The owner asked for volume, and on a real track `level` IS the intensity of the moment.
 * On the synthetic understudy it is not: measured over 150 seconds, `audioPattern`'s
 * `level` settles into a bar-to-bar mean of 0.226..0.270 — a 0.044 wiggle that would sweep
 * nothing. `high` is where T776's arrangement lives: its bar means run 0.39 / 0.43 / 0.44 /
 * 0.35 and repeat, so the quiet bar of every four is a slow bar, every 8.57 seconds.
 *
 * `env1` is a peak follower at 0.25 s rise, x4 release (1 s fall). T1190 SHORTENED IT from
 * T1155's 0.6/x8 on the owner's note — *"I think our lag is probably too intense for
 * something audio reactive"* — and the reason it is safe now is the rate drive: under a
 * POSITION map the lag had to be long, because the playhead's SPEED was the envelope's
 * DERIVATIVE and a twitchy envelope strobed the picture. Under a rate drive the envelope IS
 * the speed, so a faster follower makes the picture accelerate on the beat instead of
 * flickering. The same note would have been the wrong change one round ago.
 *
 * ## §V914 — what stands when there is no audio
 *
 * `cuePoint` retains the DRIVEN MEAN, which sits well inside the 0.4..14.6 the drive
 * produces: a host with no audio opens on the blue hour, not on a time of day the music
 * never reaches. That matters more here than usual — every headless render and every
 * thumbnail is captured with no track at all.
 */
export const vesperDocument = document(
  "e56-vesper",
  "E56 Vesper",
  /* ⚑ T1190, the owner's note: BACK TO WIDE. 1280x720 is exactly the clip's own size, so
     the file, the node and the frame are all the same pixels and nothing resamples. */
  settings({ randomSeed: 56, outputResolution: { width: 1280, height: 720 } }),
  graph(
    [
      // ---- the drive: the catalogue's fixed shape (audio-rd.ts, reactor.ts) -----------
      node("music", "audioPattern", [-2400, 700], { bpm: 112, amount: 1, beatsPerBar: 4 }, { label: "music1" }),
      node("track", "audioFileIn", [-2400, 1120], {
        cue: false, cuePoint: 0, extend: "loop", file: "", monitor: true, play: true,
        playMode: "freeRun", speed: 1, trimEnd: 0, trimStart: 0, volume: 1,
      }, { label: "track1" }),
      /* Index 0 is the deterministic pattern so the file plays on open (§V363); drop a track
         into `track1` and move this to 1 and the same city answers to real music. */
      node("source", "valueSwitch", [-2100, 910], { index: 0 }, { label: "source1" }),
      /* Fast attack, faster release than T1155's: 0.25 s up, 1 s down. Shortened on the
         owner's "the lag is too intense" note, and only safe because the drive is now a
         RATE — see the docblock. */
      node("env", "valueLag", [-1850, 910], { lag: 0.25, releaseRatio: 4 }, { label: "env1" }),
      /* The envelope's PERCENTILE within its own last 17 seconds, so equal time maps to
         equal range. 17 s is two of the fixture's 8.57 s phrases; the window must exceed the
         cycle you want to traverse or it normalises that cycle away. */
      node("norm", "valueNormalize", [-1600, 910], { window: 17 }, { label: "norm1" }),
      /* THE RATE, in clip-seconds per wall-second. `toLow` is 0.4 and NOT ZERO: that floor
         is what makes "it never freezes" a property of the file rather than a hope. 0..1 in
         is a percentile by construction, so `clamp` never fires and the twelvefold spread
         between quiet and loud is the whole of the audio reactivity. */
      node("rate", "valueMath", [-1350, 910], {
        operation: "range", fromLow: 0, fromHigh: 1, toLow: 0.4, toHigh: 5, outside: "clamp",
      }, { label: "rate1" }),
      /* ⚑ THE INTEGRATOR. Rate in, position out, bouncing between 0.4 s and 14.6 s of the
         file — so the playhead is always moving, can never reach the file's own ends, and
         runs BACKWARDS on every other leg. Labelled `travel1` rather than `speed1` so it
         never reads as `clip1`'s own Speed parameter. */
      node("travel", "valueSpeed", [-1100, 910], {
        minimum: 0.4, maximum: 14.6, limit: "mirror",
      }, { label: "travel1" }),

      // ---- the footage ---------------------------------------------------------------
      node("clip", "movieFileIn", [-2400, 0], {
        file: "media/shibuya-crossing.mp4",
        playMode: "freeRun", play: true, speed: 1,
        /* Cue HOLDS the element at the cue point in either play mode, which is what turns a
           transport into a scrub input. ⚠ It also makes `speed`, `play` and `extend` inert —
           they render inactive and say so (T1190), which is where the "we don't have
           reverse" confusion came from. The reverse in this file is the BOUNCE. */
        cue: true,
        extend: "hold", trimStart: 0, trimEnd: 0,
      }, {
        label: "clip1",
        resolution: { mode: "fixed", width: 1280, height: 720 },
        /* 8.0 is the DRIVEN MEAN over 3600 frames (measured 7.9988), not the lane's
           midpoint — §V914 wants the value the drive actually spends its time around. */
        parameters: { cuePoint: drivenSlot("travel1:high", 8) },
      }),

      // ---- THE GRADE, and it is the file's exposure and contrast desk -----------------
      /*
       * The desk is graph work rather than a grading page bolted onto `movieFileIn`, which
       * would be a second copy of `level` disagreeing with the first (§T1064 deleted ~180
       * lines of exactly that). `tone1` is the exposure/contrast half, `grade1` the colour
       * half, and between them they are the knobs to reach for on ANY video in the
       * catalogue.
       *
       * ⚑ T1190 RETUNED THEM AND EVERY KNOB WENT THE OTHER WAY, which is the lesson worth
       * more than the numbers. Round one's footage was a flat phone timelapse that needed a
       * hard black point (0.055), a pulled-down white point (0.86), heavy contrast (1.3),
       * mids DOWN (gamma 0.9) and saturation UP (1.32). This is a properly exposed aerial
       * with real blacks and vivid neon, and round one's desk applied to it — checked in
       * the running app at full resolution, not reasoned about — plugged the night into
       * black shapes and turned the sky electric magenta. So:
       *
       *   blacklevel 0.015  a black POINT, not a crush. The night half already reaches
       *                     black; this only takes the milk off the haze.
       *   whitelevel 0.94   the neon clips through the filmic tonemap otherwise — the one
       *                     knob that moved the same direction as round one's, for the
       *                     opposite reason (highlights too hot, not too cold).
       *   contrast   1      untouched. The footage has its own; adding an S closed the
       *                     shadows the gamma below is opening.
       *   gamma1     1.14   MIDS UP — the inverse of round one. This is the knob that gives
       *                     the night its shadow detail back and lets the dawn mist read as
       *                     depth rather than as grey.
       *   saturation 0.88   PULLED BACK. A night city is already saturated and the tonemap
       *                     adds punch on top; at 1.2 the blue hour read as a cyanotype.
       *
       * The general answer the owner asked for is therefore NOT a set of numbers — it is
       * that these two nodes are the desk, and where they go is a property of the footage.
       *
       * §V914 does NOT apply to any of them: they are static knobs, deliberately, so that
       * the person tuning them is the person looking at the picture.
       */
      node("tone", "level", [-1700, 0], {
        blacklevel: 0.015, whitelevel: 0.94, invert: 0, gamma1: 1.14,
        contrast: 1, brightness: 1, opacity: 1,
      }, { label: "tone1", resolution: { mode: "project" } }),
      node("grade", "hsv", [-1400, 0], { hueoffset: 0, saturation: 0.88, value: 1 }, { label: "grade1" }),

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
      edge("e-env-norm", ["env", "out"], ["norm", "in"]),
      edge("e-norm-rate", ["norm", "out"], ["rate", "a"]),
      edge("e-rate-travel", ["rate", "out"], ["travel", "in"]),

      edge("e-clip-tone", ["clip", "out"], ["tone", "input"]),
      edge("e-tone-grade", ["tone", "out"], ["grade", "input"]),
      edge("e-grade-mul", ["grade", "out"], ["mul", "in1"]),
      edge("e-vign-mul", ["vign", "out"], ["mul", "in2"], 0),
      edge("e-mul-out", ["mul", "out"], ["out", "input"]),
    ],
  ),
);
