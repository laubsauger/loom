# E56 — Vesper

An aerial timelapse of Tokyo running from the electric night through blue hour to sunrise,
and a playhead that is not a clock. The louder the music, the faster the day turns; let the
music fall away and it crawls. The picture never stops, and it never arrives anywhere it can
get stuck.

Named for the evening: *vespers* is a service sung at dusk. The clip runs the other way now,
and the name stayed.

```
music1(audioPattern) ─┐
track1(audioFileIn) ──┴► source1(valueSwitch) ─► env1(valueLag) ─► norm1(valueNormalize)
                                                                        │
                   travel1(valueSpeed) ◄── rate1(valueMath, range) ◄────┘
                        ┄high┄► clip1.cuePoint

clip1(movieFileIn, 1280×720) ─► tone1(level) ─► grade1(hsv) ─► mul1(multiply) ─► out1(output)
                                                vign1(circle) ──────────────►┘
```

## ⚑ The thing this file learned: drive a SPEED, not a POSITION

The first two rounds mapped the audio onto an **absolute position** in the clip — loudness
named a time of day. The owner used it and reported:

> For some reason that causes the playback to freeze and stay in place at certain levels…
> we're seeing the image freezing a lot… it still doesn't keep interesting and navigates
> itself into a corner. Maybe we're lagging/enveloping/normalizing it to a flat line and
> nothing moves until something shuffles.

He diagnosed it himself and he is right, and it is **structural, not a tuning failure**:

> **Under a position map, a constant input is a frozen picture.**

Every stage that makes a control signal usable makes it *flatter* — the envelope follower,
the lag, and the normaliser too — and flatness on a position map renders as stillness. No
setting escapes it; tuning only trades a freeze for a jitter.

**His immediate freeze also had a sharper, second cause worth recording.** He set the Range
to `From Low 0.20, From High 0.99` with `Outside: Clamp`. `norm1` publishes a *percentile*,
so "below 0.20" is not a rare excursion — by construction it is **exactly 20 % of the time**.
Reproduced on this chain: 20.3 % of the run pinned on frame 0, longest still run **109 frames
(1.82 s)**. On a percentile input, a clamped `From Low` *is* a duty cycle of frozen picture.

### So the audio sets a rate, and `travel1` integrates it

`travel1` is a **Speed** node — TouchDesigner's Speed CHOP, and the value family's first
accumulator. The audio produces a rate in clip-seconds per second; the node integrates it
into the position `clip1.cuePoint` reads. Measured over 2400 steady-state frames, as the
**longest run of frames showing the same source frame** — the literal reading of "it
freezes", and the thing no coverage metric implies:

| drive | longest still run |
| --- | --- |
| position map, the owner's own settings | 109 frames (1.82 s) |
| position map, as round two shipped | 14 frames (0.23 s) |
| **rate drive, as this ships** | **5 frames (0.08 s)** |

Three things follow, and they are three of the asks at once:

- **It cannot freeze.** A constant input is constant motion, and `rate1`'s low end is **0.4**
  clip-seconds per second — a *floor*, not zero — so even the quietest moment is travelling.
- **It cannot corner itself.** There is no absolute target to sit on, and `travel1`'s limit is
  **Mirror**, so the ends of the lane bounce rather than clamp or jump-cut. A wrap would be a
  hard cut from sunrise to midnight; a bounce is the day running backwards.
- **Reverse is on screen.** The rate is strictly *positive* and the picture still runs
  **backwards 55 % of the time**, because the bounce supplies the sign.

### ⚠ The cost, and it reverses an earlier ruling

Round one chose an absolute position deliberately, and the argument was good: a given
loudness named a given time of day, so the picture was reproducible against the *track*
rather than against how long you had been listening. **An integrator gives that up.** Where
the playhead is depends on how it got there; a scrub does not find it, and an offline render
reproduces only from a transport reset.

That is not new ground — `stateful` with `randomAccess: false` is what Lag, Filter, Slope and
Trigger already declare — but it *is* the trade, and it was made because the owner used both
and chose this one. A file that is reproducible and frozen is worth less than one that is
alive.

## Why `norm1` stays, and what it does now

> maybe we make up an interesting ranging system that doesn't just make it linear on the
> frequency or loudness spectrum — it gives more resolution to where there's more interesting
> changes, instead of wasting most of the resolution on the first 20 decibels that will
> almost always be used up and never give us anything.

A loudness envelope sits in a narrow band around its own median nearly all the time. Map that
band **linearly** and most of the output goes to levels the signal rarely visits. `norm1`
maps each channel through **its own distribution** — the percentile within its last 17
seconds — so equal amounts of *time* map to equal amounts of *range*, with no floor and no
gain to retune when the track changes.

Under a rate drive that is a **better** job for it than it had, and the instrument had to
change with it: what `norm1` shapes now is how the **speed** is distributed, *not* the
position — under a bounced integral the position comes out even for almost any positive rate
and therefore proves nothing about the mapping. Measured as the share of the run in each
twentieth of the 0.4–5 rate range:

| | histogram | worst bin | evenness¹ |
| --- | --- | --- | --- |
| **percentile (ships)** | `6 6 5 5 5 4 5 5 6 5 5 5 5 5 5 5 5 5 6 6` | **6.0 %** | **3.6 %** |
| raw envelope, best-calibrated | `3 4 3 3 2 2 2 1 1 2 1 1 1 2 2 1 3 5 28 33` | 32.8 % | 51.3 % |

¹ total-variation distance from a perfectly even range; 0 % would be flat.

The raw arm is *auto-calibrated* to the envelope's own measured span (0.113–0.443) — a
calibration no human could beat, because it is measured from the answer — and it still spends
**61 % of the run in the top tenth** of the speed range. That is the owner's sentence with the
sign flipped: the picture would sit near full speed almost always, and the quiet moments would
never actually be slow.

Mid-rank also means the percentile can never reach 0 or 1 — with N samples the extremes are
exactly `0.5/N` and `1 − 0.5/N` — so the rate can never reach either end of its range either.

**The trade, as a knob rather than a surprise.** A distribution measured over history
*adapts*, so the same loudness means different things at different times. `Window` decides how
much, and the rule is: **it must be longer than the cycle you want to see.** 17 s is two of
this fixture's 8.57 s phrases. At 2 s a quarter of the run collapses into one twentieth of the
range — the cycle is normalised away and the variation dies. (Under a rate drive the drift
also matters much less, because nothing is pinned to an absolute position any more.)

## The lane stops short of both ends of the file

> We need to range it so that we don't hit the actual end of frame range, and maybe we can
> even curve it so there's more resolution in a certain area of the clip.

`travel1` bounces between **0.4 s and 14.6 s** of a 20.67 s file, so the drive never reaches
either end — and with Mirror that is structural rather than a clamp. The 6 s given up are a
judgement about the footage: the last quarter of this clip is flat white haze, source frames
384 onward differ from each other by almost nothing, and a drive that covered them would spend
a quarter of its travel there.

**A curve is deliberately not shipped.** A hand-picked curve re-introduces exactly the
eyeballed knob the percentile map removes, and the argument against the linear map is the
argument against it. When the ask is "dwell in *this* part of the clip", the honest control is
the one that names that part: `travel1`'s own bounds, or Trim Start / Trim End.

## Reverse and ping-pong: what shipped, and why it looked like it had not

> do we have reverse now? We don't have reverse play.

Reverse has shipped on `movieFileIn` since T493. `Speed` is declared down to −4; because no
browser plays a negative `playbackRate`, the app pauses the element and steps `currentTime`
per frame, so reverse playback *is* a scrub. `At End → Mirror` ping-pongs, likewise gated.

> ⚠ **And neither did anything on this file, which is why they could not be found.** The
> playhead answers a **held cue** before it looks at the clock — so with Cue on, which is this
> file's whole mechanism, `Speed`, `Play` and `At End` are *not read at all*. They were live
> controls doing nothing, with nothing saying so.

T1190 gave all three an inactive-reason that names the cue and says what to do instead, and
gated it against the playhead function itself rather than against the schema, so the dimming
cannot become a lie. A capability that is present and undiscoverable was not delivered.

The reverse you see in this file is the **bounce**.

## It scrubs a video from a wire, with no new transport parameter

`movieFileIn` with **Cue** on holds the element at its **Cue Point**, and no transport
parameter is `compileTime` — so a driven Cue Point is a scrub input that costs no recompile.
That is the whole mechanism. The cache node cannot do this: its tap is structural and maxes
out at 63 frames.

## The asset ships with the app, and the encode is part of the example

`public/media/shibuya-crossing.mp4` — 1280×720, H.264 High 8-bit, 496 frames at 24 fps,
20.67 s, **2.92 MB**, 42 keyframes. The `file` parameter is a plain URL handed to `video.src`,
and the reference is **relative** — `media/shibuya-crossing.mp4`, no leading slash — so it
resolves against the page's own base in both deployments: `/media/…` on the dev server and
`/loom/media/…` on Pages, where an absolute path would 404.

> ⚠ **The clip as delivered could not do this job.** It arrived with **two keyframes in the
> whole file** — a 250-frame group of pictures, which is how it fit in 2.53 MB.

A driven Cue Point seeks **every frame**, so the cost of a random seek *is* the performance
story. Measured in headed Chrome, 40 random seeks per clip:

| | median | p90 | max |
| --- | --- | --- | --- |
| as delivered, 250-frame GOP | 32.5 ms | 50.8 ms | 55.6 ms |
| **re-encoded, 12-frame GOP** | **4.5 ms** | **5.7 ms** | **7.6 ms** |
| (the old portrait clip, all-intra, ⅕ the pixels) | 1.7 ms | 2.5 ms | 2.8 ms |

A 60 Hz frame is 16.7 ms. The delivered clip's *median* seek is two frames long and its worst
is three, so the decoder — not the drive — would have set the update rate. The re-encode's
*worst* is under half a frame.

`-g 12 -keyint_min 12 -sc_threshold 0 -bf 0`, with a light `hqdn3d` denoise paying for the
extra keyframes: 2.92 MB, which is above the 2.53 MB delivered and below the 3.09 MB of
`portrait-sunset.mp4`, the clip it takes over from. Night and sunrise frames were compared at
1:1 crops before the crf was believed.

> `public/media/portrait-sunset.mp4` is now referenced by nothing and is deliberately still
> there. It is 3.09 MB in every deploy, and whether it goes is a call for whoever owns the
> example that would have used it again.

All-intra — round one's asset was, and its notes leaned on it — was measured and rejected:
720p all-intra of this footage is 5.1 MB at crf 36 and 12.3 MB at crf 30. All-intra was never
the requirement. *A seek the decoder can serve inside a frame* was, and twelve frames of GOP
buys that at a quarter of the bytes.

## It is 16:9

The project is **1280×720** and the file records it, so opening the example sets it. That is
exactly the clip's own size, so the file, the node and the frame are all the same pixels and
nothing resamples anywhere in the chain.

`clip1`'s resolution is pinned to 1280×720 rather than left to inherit. The media hook writes
a `setNodeResolution` patch when the intrinsic size differs from the node's, so an unpinned
document would mutate itself the moment it opened. `tone1` carries `resolution: project`,
which is a no-op here and is where the chain would resample if you swapped in a file of
another size.

## The envelope reads `high`, not `level` — and it got faster

The owner asked for volume, and on a real track `level` *is* the intensity of the moment. On
the synthetic understudy it is not: over 150 seconds `audioPattern`'s `level` settles into a
bar-to-bar mean of 0.226–0.270, a 0.044 wiggle that would sweep nothing. `high` is where the
arrangement lives — its bar means run 0.39 / 0.43 / 0.44 / 0.35 and repeat, so the quiet bar
of every four is a slow bar, once every 8.57 seconds.

`env1` is a peak follower at **0.25 s rise, ×4 release** (a 1 s fall), shortened from round
one's 0.6 / ×8 on the note *"I think our lag is probably too intense for something audio
reactive."* **The rate drive is what makes that safe.** Under a position map the playhead's
*speed* was the envelope's *derivative*, so a twitchy envelope strobed the picture and the lag
had to be long. Under a rate drive the envelope *is* the speed, so a faster follower makes the
picture accelerate on the beat instead of flickering. The same note would have been the wrong
change one round earlier.

Measured: the speed of the playhead correlates with the envelope at **0.837**, over a 13×
range from 0.38 to 5.0 clip-seconds per second.

## The grade, and its knobs are the point

Two ordinary nodes in the chain rather than a grading page bolted onto `movieFileIn`, which
would be a second copy of `level` free to disagree with the first. `tone1` is the exposure and
contrast desk, `grade1` the colour, and they are the knobs to reach for on **any** video in
the catalogue.

**Every knob went the other way from round one, and that is worth more than the numbers.**
Round one's footage was a flat phone timelapse that needed a hard black point, a pulled-down
white point, heavy contrast, mids *down* and saturation *up*. This is a properly exposed
aerial with real blacks and vivid neon, and round one's desk applied to it — checked in the
running app at full resolution, not reasoned about — plugged the night into black shapes and
turned the sky electric magenta.

| knob | ships at | why |
| --- | --- | --- |
| `tone1` Black Level | 0.015 | a black *point*, not a crush — the night half already reaches black, and this only takes the milk off the haze |
| `tone1` White Level | 0.94 | the neon clips through the filmic tone map otherwise |
| `tone1` Contrast | 1 | untouched: the footage has its own, and an S closed the shadows the gamma is opening |
| `tone1` Gamma | 1.14 | **mids up** — the inverse of round one. This is the knob that gives the night its shadow detail back and lets the dawn mist read as depth rather than grey |
| `grade1` Saturation | 0.88 | **pulled back**: a night city is already saturated and the tone map adds punch on top. At 1.2 the blue hour read as a cyanotype |

All five are static, deliberately: the person turning them is the person looking at the
picture.

So the general answer is not a set of numbers. It is that these two nodes are the desk, and
where they go is a property of the footage in front of you.

## What stands when there is no audio

`clip1.cuePoint` retains **8.0 s**, the driven mean over 3600 frames, which sits well inside
the 0.4–14.6 the drive produces. A host with no audio opens on the blue hour, not on a time of
day the music never reaches. It is the file's only driven parameter, and it matters more here
than usual: every headless render and every thumbnail is captured with no track at all, so the
retained value *is* the picture in all of them.

## Swap the pattern for a track

`source1` is a Switch at index 0, the deterministic pattern. Drop a track into `track1`, move
`source1` to index 1, and the same city answers to real music — which is what this file is
for, and the reason the mapping had to stop depending on numbers measured off the fixture.
