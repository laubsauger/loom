# E56 — Vesper

A sunset timelapse whose playhead is not a clock. The louder the music, the higher the sun;
let the music fall away and the sun sinks below the horizon. The intensity of the moment
decides the time of day.

The mapping is **absolute** — loudness names a *position* in the clip, not a *speed* — so a
given phrase always lands on the same time of day, however long you have been listening. A
speed-driven version drifts, and the relationship between the music and the picture stops
being reproducible after about a minute.

Named for the evening: *vespers* is a service sung at dusk, which is both halves of this
file at once.

```
music1(audioPattern) ─┐
track1(audioFileIn) ──┴► source1(valueSwitch) ─► env1(valueLag) ─► sun1(valueMath, INVERTED)
                                                                       ┄high┄► clip1.cuePoint

clip1(movieFileIn, 540×960) ─► tone1(level) ─► grade1(hsv) ─► mul1(multiply) ─► out1(output)
                                               vign1(circle) ───────────────►┘
```

## The inversion is the whole poem

The clip runs sun-high to sun-gone, so **loud maps to 0 and quiet maps to the end**. `sun1`
is a Range whose output bounds are written backwards — `To Low` 9.7, `To High` 0 — which is
a supported way to express a reversal in one node rather than hanging a subtract-from-one
off a second one.

## It scrubs a video from a wire, with no new node

`movieFileIn` with **Cue** on holds the element at its **Cue Point**, and no transport
parameter is `compileTime` — so a driven Cue Point is a scrub input that costs no recompile.
That is the whole mechanism. The cache node cannot do this (its tap is structural and maxes
at 63 frames) and it does not need to: the clip is *all-intra*, so every one of its 291
frames is a keyframe and a seek lands without decoding a group of pictures.

Measured in real Chrome, on this asset, through the app's own `applyMediaPlayhead` held
branch, over a 30-second steady-state window:

| | |
| --- | --- |
| seeks issued | 58.9 / s |
| seeks **completed** | 58.9 / s |
| superseded | **0 %** |
| frames presented | 56.6 / s |
| distinct source frames reached | 268 of 291 |

T1149 measured 88 % of seeks superseded on 100 seconds of 1080p and warned that naive
per-frame driving costs 59 % of the achievable rate. That is true of *that* footage and not
of this: a quarter of the pixels, a tenth of the duration, and it sits in memory. **So this
file ships with no throttle, and that is a measurement rather than an oversight** — a
minimum-delta gate at one source frame was tried and only lost update rate (59.1 completed
per second down to 35.1).

The zero was red-verified before it was believed: driven with a full-clip jump every tick at
240 Hz the same counter reports 19.4 % superseded, so 0 % at 60 Hz is a real zero rather
than a blind instrument.

## It is the first example that ships with footage in it

`public/media/portrait-sunset.mp4` — 540×960, H.264 8-bit, 291 frames at 30 fps, 2.94 MB,
every frame a keyframe. It is named for its *shape*, not for this example: it is the
catalogue's only portrait video, and the next vertical piece should point at it.

The `file` parameter is a plain URL handed to `video.src`, and the reference is **relative**
— `media/portrait-sunset.mp4`, no leading slash — so it resolves against the page's own base
in both deployments: `/media/…` on the dev server and `/loom/media/…` on Pages, where an
absolute path would 404.

Every other media example in the catalogue shows you its null state until you supply a file.
This one opens with the picture already in it.

## The envelope does the aesthetic work, and it reads `high`

The owner asked for volume, and on a real track `level` *is* the intensity of the moment. On
the synthetic understudy it is not: over 150 seconds `audioPattern`'s `level` settles into a
bar-to-bar mean of 0.226–0.270, a 0.044 wiggle that would strobe the sun per beat and sweep
nothing. `high` is where the arrangement lives — its bar means run 0.39 / 0.43 / 0.44 / 0.35
and repeat, so **the quiet bar of every four is a sunset**, once every 8.6 seconds.

`env1` is a peak follower: 0.6 s rise, ×8 release, so a 4.8 s fall. Fast attack, slow
release — too little lag and the sun strobes, too much and it never reaches either end.

Those numbers were chosen by scoring phrase swing against per-beat ripple over a *long*
horizon, and the length is load-bearing. The best-scoring settings on a short window
(lag 2, ratio 32) turned out to be a slow minute-long climb wearing a cycle: its 4-bar
amplitude decays from 0.022 to 0.008 while the score calls it the cleanest of all. At 0.6/×8
the cycle amplitude is stationary at about 0.08 from the fifth bar on.

## Duty, not range

`sun1` maps 0.33–0.45 onto 9.7–0 seconds, clamped, and **the clamp is reached on purpose**:
pinning here means *broad daylight* and *fully dark*, which is the picture rather than a
saturated control. Over 3600 frames of the shipped pattern:

- **93.4 %** of steady-state draws land in the interior; longest pinned run 38 frames (0.63 s)
- the lane visits **284 of the clip's 291** distinct frames
- the playhead travels 2.55 clip-seconds per wall-second
- whole-run duty including the opening is 83.2 %, because the first 394 frames (6.6 s) sit
  pinned at 0 while the follower settles

That opening hold is the opening shot: **the file opens in daylight and the sun then sets**,
which is also why frame 60 — the gallery card — is a bright one.

## What stands when there is no audio

`clip1.cuePoint` retains **3.42 s**, the driven mean, which sits well inside the 0–9.7 the
drive produces. A host with no audio opens on the sun already low but still above the
horizon, not on a time of day the music never reaches. It is the file's only driven
parameter, and it matters more here than usual: every headless render and every thumbnail is
captured with no track at all, so the retained value *is* the picture in all of them.

## It ships portrait

The project is **720×1280** and the file records it, so opening the example sets it — no
manual resize. That is exactly the clip's own 9:16 (540/960 = 720/1280 = 0.5625), so the
only resample between the file and the frame is a 1.33× scale with no reframing at all.

> The viewer pane currently *stretches* rather than letterboxes, so a portrait project reads
> correctly everywhere except there. That is the viewer, not this file.

`clip1`'s resolution is pinned to the file's own 540×960 rather than left to inherit. The
media hook writes a `setNodeResolution` patch when the intrinsic size differs from the
node's, so an unpinned document would mutate itself the moment it opened. `tone1` carries
`resolution: project`, and that is where 540×960 becomes 720×1280.

An earlier version was built at 1280×720 and **out-painted** the sides — the clip stretched,
blurred and dimmed as an ambient bed, with the true-aspect panel over it. Good trick, wrong
problem: the piece is portrait, so the frame is. The trick gets its own example.

## The grade, and its knobs are the point

The footage is flat. That is not a colour-space fault — `movieFileIn` uploads
`rgba8unorm-srgb` and the hardware decodes to linear correctly — it is **a dusk timelapse on
a phone, with auto-exposure actively flattening it as the light falls**.

So the answer is two ordinary nodes in the chain rather than a grading page bolted onto
`movieFileIn`, which would be a second copy of `level` free to disagree with the first.
`tone1` is the exposure and contrast desk, `grade1` the colour, and they are the knobs to
reach for on **any** video in the catalogue:

| knob | ships at | why |
| --- | --- | --- |
| `tone1` Black Level | 0.055 | the haze floor — the clip's darkest scrub is a lifted grey, so the black point goes where the picture's black actually is |
| `tone1` White Level | 0.86 | the sun and its water track are the only real highlights and they sit well under 1 |
| `tone1` Contrast | 1.3 | the S the flat curve was missing, once the two points are set |
| `tone1` Gamma | 0.9 | mids down, so the dune reads as a **silhouette** rather than as grey — the thing that made it look weak |
| `grade1` Saturation | 1.32 | a sunset carries it, and auto-exposure had drained it |

They ship **tuned for this clip rather than neutral**, because an identity grade would be no
answer at all. All five are static: the person turning them is the person looking at the
picture.

## ⚑ The bug this example found, and it was not in this example

`createMediaTransportRunner` built its resolve options by hand — `{ frame, channels }`, with
no node-reference reader — and `op('sun1').chan.high` is read *inside* that reader, never off
`channels`. So **every expression on every transport parameter has failed since T493**,
falling back to the retained static and freezing there, while that function's own docblock
promised "a `cuePoint` bound to a sibling, a `trimStart` driven by an audio channel".

Twenty-six tests in `media-playback.test.ts` were green throughout, because every one of them
resolves a *static* parameter.

The symptom in the running app: the file loaded, the element reached readyState 4 at 540×960,
and `currentTime` sat at the retained 3.42 forever. Fixed through the one factory
(`createParameterReadOptions`), gated, and red-verified in both directions.

## Swap the pattern for a track

`source1` is a Switch at index 0, the deterministic pattern. Drop an orchestral track into
`track1`, move `source1` to index 1, and the same sun answers to real music — which is what
this file is for.
