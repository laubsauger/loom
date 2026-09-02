# E27 — Relief

A hundred and five thousand glowing points stand in a leaning sheet, each pushed toward you
in proportion to the brightness under it. Rutt–Etra: a moving picture standing up off the
screen.

The sheet leans back seventy degrees and a swaying camera watches it face-on: teal valleys,
a magenta ridge line, a white crest, and a luminous dome that wanders across the frame. The
bloom fuses thousands of separate points into one surface. The analog video-synth look,
with a live graph where the scan converter used to be — and since T676 the picture stands
up literally.

**It opens playing its own performer, and your camera is one number away.** Since T797 it
also **sets its own exposure** — the frame's measured top drives the gain, so a dark room
still gets a relief instead of a flat plate — and **movement adds height on top of
brightness**, so what moves stands further out of the sheet.

Since T809 it carries **two knobs that are off**: the beat can scale how far the sheet
stands out, and the palette can travel along the ramp. Both ship at zero, and *zero* is a
gate rather than a promise — the file with them in it renders the same bytes as the file
without.

## Graph

```
ripple1(noise) ─► bed1(level) ─────────────► sum1(add).in2
swell1(circle, centre ┄ driftx1/drifty1) ──► sum1.in1
                                              │        order 0
                                              ├──────────────► pick1(switch, index 0)
cam1(webcam) ─────────────────────────────────┘        order 1        │
                                                                      ▼
                             roof1(analyze, max) ◄────────────────────┤
                                    │                                 ▼
     ceil1(channelIn) ─► roofsafe1(valueLimit) ┄┄► whitelevel of norm1(level)
                                                                      │
                    ┌─────────────────────────────────────────────────┤
     cycle1(lfo) ┄┄► offset of                                        │
palette1(ramp) ─► coat1(lookup) ◄─────────────────────────────────────┤ (colour)
                    │                                                 │
                    │        now1(cache, 1 back) ◄────────────────────┤
                    │        past1(cache, 6 back) ◄───────────────────┤
                    │                └──► moved1(difference) ─► stir1(level)
                    │                                                 │
                    │                        heat1(add) ◄── norm1 + stir1
                    ▼                              │
                 braid1(reorder) ◄─────────────────┘
                        rgb = paletted colour, alpha = luminance + movement
                                              │
grid1(pointGrid 480×220) ─► bridge1(textureToAttribute) ─► lift1(pointKernel)
  beat1(audioPattern) ─► bsub1(valueMath) ─► env1(valueLag) ─► kick1(valueMath) ┄┄► lift1.value1
                                              │
                    phosphor1(materialUnlit) ─┴─► body1(geometry: instances, tint ← sample)
                    eye1(camera, eye.x ┄ sway1)
                    shot1(render) ─┬─► halo1(blur) ─┐
                                   └────────────────┴─► burn1(add) ─► out1
```

## The understudy pattern (§V411)

§V363 says a demo must demonstrate itself. Until now that has meant no example may contain
a live input at all — and that is precisely why `webcam` shipped **dead** for months (B39):
nothing used it, so nothing ever compiled its shader or bound its external texture.

`pick1` dissolves the conflict. **A Switch selects a resource; it does not prune the branch
it did not select.** So this file opens playing a synthetic performer — a soft dome
wandering over a rolling sea of noise — *and* `cam1` is in the graph, in the plan, and
compiled on a real device by `examples.gpu.test.ts`. That is the integration gate §V362
names as the only one we have, and it is the gate B39 escaped.

Move `pick1.index` to 1 and it is your camera. Nothing else in the graph changes.

**The order is load-bearing, and it bit while this was being built.** A variadic port's
input order lives on the EDGES (§V131/T225), and an edge with no declared order falls
through to an id tiebreak — where `e-cam-pick` sorts before `e-sum-pick`. The first build
therefore opened on a black webcam: the exact null state §V363 exists to prevent, chosen by
spelling. Both edges now declare `order`, and the concept test asserts that the ids would
still sort the other way, so the declaration cannot quietly stop mattering.

The same shape generalises to `audioIn` and `audioFileIn`, the other two nodes §V363 has
been keeping unexampled. It is not applied here — one example, one claim — but it is the
reason to write this one down.

## Why points, and not a surface

`textureToAttribute` reads with `textureLoad`: **nearest, unfiltered, deliberately**, so a
data field survives the trip (§V57). A displaced *surface* is brutally sensitive to the
ratio between mesh and field because of it — coarser and a narrow feature falls between two
vertices and spikes; finer and every vertex inside one texel shares a height, so the surface
steps. Points have neither failure. There is no shared edge between them to tear or facet:
a point that samples a texel simply sits where that texel says.

That is what makes a *relief* the honest thing to build on this bridge, and it is why the
grid here (480×220) can be a completely different shape from the field (1280×720) with
nothing going wrong. It is also why the rows are sparser than the columns — that is where
the scan lines come from.

## T503 — the three things that were wrong, and they were three different bugs

The owner's verdict on the first build was **"weak, inverted and hard to see"**. All three
were true, none of them was tuning, and they had nothing to do with each other.

### It was literally upside down, and the bug was not in this file

The bridge mapped `position.y = -1` to `uv.y = 0`, and `uv.y = 0` is **texel row 0** — the
row an output node shows at the *top* of the frame. World +y is up, so `position.y = -1`
draws at the *bottom*. Every texture-to-points bridge therefore handed the picture back
mirrored across the horizon. Nothing caught it because the understudy — noise plus a
centred dome — has no top and no bottom; flip `pick1` to the webcam and it was your own
face, upside down.

The one-node probe that settled it is worth copying: a `circle` at `center.y = 0.2`
rendered straight to an output, and read back to see which row it landed on. **A fixture
has to be able to tell apart the thing its test asserts** (§V461) — every earlier probe
image had been symmetric, and a symmetric image is structurally blind to a vertical flip.
Fixed at source in `src/points/codegen.ts` (B105/T512), not compensated for here.

**And the kernel's sign moved WITH that fix, which is the part to remember.** The bridge
now reads `uv.y = 0.5 − position.y·0.5`, so `position.y = +1` is texel row 0 — the top of
the picture. Laid flat, the top of a picture belonged at the *far* edge, which is z
negative from a camera on +z. Stood up (T676), the top of a picture belongs at the *top*,
which is y positive — and the same negation delivers both, because the rotation carries it.
This sign is COUPLED to `points/codegen.ts` and it is not guessable from inside this file:
read the mapping there rather than assuming, because assuming is exactly what B105 cost.

### The height came out of the palette, which is why it was "weak"

`lift1` took luminance off the **coated** colour. That palette's luminance runs 0.02, 0.14,
0.28, 0.49, 0.95 across its stops — monotone, but wildly non-linear. Four fifths of the
source got squashed into the bottom half of the height range and the last fifth exploded,
so the shipped picture was a flat plate with a single needle spike in it.

`braid1` is the fix, and it generalises. **The bridge is four channels wide and a
displacement only needs one**: a Reorder puts the paletted colour in rgb and the *raw*
source luminance in alpha, so one texture crosses one bridge carrying two different fields.
`lift1` reads `sample.a` for shape and `sample.rgb` for colour, and the palette is free to
be chosen for how it looks instead of doubling as a height transfer function.

### The camera looked down the height axis

The old eye looked along (-0.32, 0.40, -0.86) at a sheet whose relief was entirely in +z —
**86% of the view direction was parallel to the displacement**, so the thing the example is
about barely projected. The doc claimed the opposite ("face-on, a height field is just the
picture again"), which is how it survived review.

T503 fixed it by laying the sheet into **xz** with the height on +y, so the world's up axis
*is* the height axis, and putting the eye low and to one side: about 19% of the view along
the height axis, so the hills had silhouettes and a rising slope bunched its scan lines the
way a contour map does.

### And then the landscape was the wrong shape for the subject (T676)

Owner: *"its on its Back both in preview and final output. we're laying the points on their
back which makes sense for the mountains but looks weird when we do webcam right."*

That sentence is a rule, not a note. **Orientation follows the source.** A heightfield is
read from above — mountains lie down, and T503 was right for the understudy. A scanned
video image is read *face-on*, because you look at a face the way you looked at it, and the
real subject of this example is the webcam on branch 1. Face-on with a slight lean is also
the historical Rutt–Etra frame, which is what this document is quoting.

So the sheet now stands at **70° off the floor**, not the 90° the report named. 90° with a
camera in front puts the view direction straight back down the height axis — exactly the
86% failure above — and it removes both cues this example reads by, with no third one to
fall back on: `phosphor1` is **unlit**, so there is no shading here and a raking key, a
bas-relief's usual mechanism, is not available. What remains is silhouette and scan-line
bunching, and both are obliquity cues. Leaning back 20° keeps the eye about 20–25° off the
sheet's normal: the image reads face-on and the relief still has somewhere to project.

**The sway became load-bearing in the same move.** With no light and no shading, parallax
is the only depth cue left, so `sway1` swinging `eye.x` ±1.15 at 0.024 Hz — ±16° at this
distance — is what makes the near ridges slide against the far ground. Laid down it was a
garnish; stood up it is the reason you can see depth at all.

## T797 — the relief is a luminance histogram, and a dark room has no histogram

Owner: *"i think relief when driving with camera and a rather dark image is kind a boring
and needs to react more to darker colors and movement of these."*

That is not a taste note, it is a description of the mechanism working exactly as built.
`braid1` puts the source's own luminance in alpha and `lift1` pushes each point out in
proportion to it, so **the sheet IS this frame's luminance histogram stood on edge** — and
a dark room's histogram is a narrow band near zero. Every point lands at nearly the same
height and the relief flattens. Rendered against a dimmed understudy (×0.14, this
document's "dark room" fixture) the shipped file measured **mean display luma 0.0159
against the lit 0.1713**: a featureless navy rectangle, which is precisely what was
reported.

### It needed no new node, and that is the finding

§T767 records a missing normalize / running-range **value** node, and this looked like its
second customer arriving from video after audio. It is not. **A texture already has the
primitive**: `analyze` reduces its input to average / minimum / **maximum** and publishes
the number as a driven channel (T236, §V144) — E14 has been closing an image→parameter loop
with it since T654. So `roof1` measures the top of the source's range and drives the white
point of `norm1`, and the picture is re-ranged **before anything reads it**: the colour, the
height and the motion are all downstream of one Level. Dimmed ×0.14 the frame comes back to
**0.1961**, past the lit original, with the palette's whole climb in use again.

The gap §T767 names is real and still open — it is on the **value** side, where a band of
audio has no equivalent of `analyze` — but a *texture* has never needed it.

### Only the white point is driven, and that is §V694

A positive `blacklevel` is a **subtraction**, and `rgba16float` does not clamp. Driving the
black point from the measured *minimum* would push pixels negative on the two counts this
node cannot avoid: `analyze` reduces a **64×64 subsample**, so the true per-pixel floor can
sit below the number being subtracted, and it answers with the **last completed frame**
(§V144), so a frame that just got darker is already below it. A pure gain has neither
failure. `roofsafe1` floors the divisor at 0.06 — the white point is a *divisor*, so an
unfloored channel on a frame that goes black is a divide-by-nothing — which caps the gain at
about 17×: two and a half stops past the dark fixture, and short of amplifying sensor noise
into a mountain range.

**The one-frame latency is displayed, not hidden** (§V144, §V436). Frame 0 has no completed
readback, so it renders at the fallback white point of 1.0: point a genuinely dark camera at
it and the first frame opens dark and corrects on the second (measured on the dark fixture:
0.0164 at frame 0, 0.1773 at frame 1). A seek does the same thing once. This is a *per-frame*
range, not a running one, so scrubbing is repeatable everywhere except that single frame —
which is the mild version of the history-dependence §V436 warns about, and the reason a
running range was not built here.

### Movement is E41's rig, and it is downstream of the exposure — not an alternative to it

E41 Cinder packs `rgb = colour, alpha = motion` through **this same `reorder` node**;
E27 packs `rgb = colour, alpha = luminance`. **The two examples differ by what goes in
alpha and nothing else**, so the second half of the owner's sentence is E41's instrument
moved one file over: `cache` six frames back, `difference`, a `level` to range it
(`whitelevel` alone — §V694 again, no subtractive offset anywhere in this file), and an
`add` so the height is luminance **plus** movement. Move, and you stand further out of the
sheet.

**It reads off `norm1`, not off `pick1`, and that order is the whole finding.** The natural
reading is that a dark scene has little luminance but plenty of motion, so the motion term
carries the frame exactly where the luminance term is starved. **It does not, and the frame
says so**: a frame difference of a dark picture is dark by the same factor. The motion rig
alone on the dark fixture measured **0.0160 against the untouched 0.0159** — no visible
change at all, still a navy rectangle. Auto-gain first is what gives the difference anything
to be a difference *of*. These are not two independent fixes; (a) is the precondition for (b).

With the gain in front of it, the motion term is not decoration either: at
`stir1.whitelevel` 0.6 — E41's own number, kept rather than re-fitted, because the
difference is taken off a source normalised to the same range in both files — it moves
**56% of the frame's pixels, mean |Δ| 18.7/255**, against the same graph with `stir1`
bypassed.

**The understudy is an honest but weak witness for this half, and this is the place that
says so.** E27's performer moves *everywhere* — a drifting dome over a bed of noise on a
live 4d axis — so the motion term reads here as a fine chatter over the whole sheet rather
than as one thing standing out of a still room. E41 had to make its bed nearly still for the
same claim to be legible (§V687). The witness for *the moving part stands out* is branch 1.

### Both sides of the difference come out of a ring, and that is the frame-0 fix

§V229 says a Cache tap reads the **oldest slice written** rather than black, and it does —
*from frame 1 onward*. Measured: `past1` holds frame 0's picture at frames 1…6 while the
ring fills. On **frame 0** there is no oldest slice yet and the tap reads black, so a
difference taken against the live source is `picture − black` = the whole picture: `stir1`
measured **mean 0.935, peak 1.72** on frame 0 against 0.015 from frame 1 on, and the sheet
opened over-lifted and blown (whole-frame mean 0.256 against a steady 0.178).

That is §V732's transient exactly — the one that was baked into a baseline and passed — and
§V769 says frame 0 is the thumbnail, so it is not a frame anyone may hand-wave. E41 could
guard it with `ctx.firstRun` because the decision lived in a **spawn hook**; here the motion
is already summed into alpha before any kernel sees it, so the guard has to be structural.
**Taking the near side out of a ring too** makes frame 0 `black − black` = 0 and leaves every
later frame identical: `now1` at index 1 needs a two-slice ring, the cheapest allocation the
node allows. Frame 0 now measures 0.1752 against 0.1721 at frame 1 — no flash.

## T809 — two optional knobs, and *optional* is measured

Owner: *"optional audio reactivity to drive relief in some way would be cool and also some
sort color rotation"*.

E43 Splice is the pattern (§V147). A feature that ships **off** is only honestly off if the
frame with it in the graph is the frame without it, byte for byte — so both knobs ship at
zero and `relief-claims` renders the file against a control with both driven bindings
replaced by plain numbers. **0 differing pixels of 921,600**, at frame 0 and frame 90, on
the lit understudy *and* on the ×0.14 dark fixture. The machinery is compiled, in the plan
and inert.

### The audio scales the LIFT, not the exposure

`beat1(audioPattern)` → `bsub1` subtracts the low band's T701 rest of 0.713 → `env1`
follows the envelope (T820, below — this is the node that stops it jittering) → `kick1`
multiplies by the knob → `lift1.value1`, and the kernel reads it as
`height * (1.05 + ctx.value1)`. The sheet stands further out on the kick.

**It could not go on the white point, and that is §V730.** The height is `luminance ×
exposure` since T797, and `norm1.whitelevel` already has a driver — `roof1`'s measurement
of the frame. A second driver there would be two decisions on one number, and the one that
lost would be the auto-gain this file exists to have. The lift amplitude is the term
*downstream* of everything the exposure decided, so audio scales it and the re-ranging is
untouched.

Measured at `kick1.operand = 1` (a full strike is the low band's 0.26 excursion, so the lift
runs 1.05 → 1.31, about a quarter more relief):

| arm | frame | mean display luma | mean \|Δ\| vs. the same frame at rest |
| --- | --- | --- | --- |
| lit, on the strike (f97) | 0.1816 → 0.1909 | +5.1% | **0.0746** |
| lit, off the beat (f90) | 0.1803 → 0.1803 | — | 0.0110 |
| dark, on the strike (f97) | 0.1977 → 0.2100 | +6.2% | **0.0914** |

The 7:1 ratio between the strike and the decay is the claim: it **breathes on the beat**
rather than sitting on. A drive that lost its rest subtraction would read the same at both.

**The dark case gets MORE of it, not less, and that is the opposite of T797's motion
finding.** §V781 records that a frame difference of a dark picture is dark by the same
factor — the motion term was starved by darkness because it was *derived from the picture*.
This driver is a synthesized pattern, so it is level-independent by construction, and the
auto-gain has already put the height field in full range for it to scale. There was nothing
to gate here.

**One honest correction to the brief.** §T776's arrangement was cited as the reason the
pattern now has phrase-length dynamics to show — and it does, but **not on `low`**. The
per-band pull-back depths are `low` 0.90 against `high` 0.07 precisely because *a breakdown
drops the top end and keeps the kick*, so a quiet bar moves this band by about 0.006 against
a per-beat excursion of 0.26 — 2%. What this knob delivers is per-**beat** breathing. A
phrase-length version would read `level` or `high` instead, and would swing the relief once
every four bars.

### The colour travels along the ramp, and it does not rotate around it

`cycle1(lfo, sine, 0.035 Hz)` → `coat1.offset`. Measured at amplitude 0.1: mean |Δ| luma
0.0464 at the bottom of the swing and 0.0485 at the top on the lit understudy, 0.0405 at
the bottom on the dark fixture — and the dark frame at the cool end still reads **0.1641**
mean, clear of the 0.12 floor and nowhere near the 0.0159 the original report measured.
The white crest cools through orange to magenta and back over about 29 seconds, the ridge
line walks down the sheet, and the composition is the same at every point of the swing.

**And it is a SWEEP, not a cycle. The wrap-around was tried first and it takes the picture
apart.** The move that would make it a true cycle is `palette1.phase` — Ramp's shader ends
in `fract(raw)` (T556), so a phase drive walks every colour past every stop and returns,
which is exactly what a Rutt–Etra colouriser does. Rendered at four phases across one turn
on the lit understudy at frame 90:

| ramp phase | mean | what the frame shows |
| --- | --- | --- |
| 0.05 | 0.1991 | **black holes punched in the summit** — the crest wraps past white to stop 0 |
| 0.30 | 0.1993 | **the dome inverts to a black silhouette** inside a hard white outline |
| 0.55 | 0.1204 | a posterised contour map — white islands on dark blue, no subject |
| 0.80 | 0.1060 | the composition survives, with white specks scattered over the hills |

That is not tuning, it is structural. **This ramp is monotone in luminance by design** —
T503 chose a near-black foot and a white crest so the colour climbs with the height — and
rotating a monotone table makes it non-monotone. The instant "brighter" stops meaning
"further up the ramp", the relief loses the only reading it has, because `phosphor1` is
unlit and there is no shading to fall back on. Wired at zero it would be a knob that looks
broken the moment anyone turns it, so **it is not wired**, and the frames are recorded here
rather than the option being quietly dropped.

`coat1.offset` has the opposite property for the opposite reason: Lookup's shader is
`clamp(index * scale + offset, 0, 1)`, so it slides and clamps instead of wrapping, and the
monotone mapping survives. Sliding **down** is the free direction; sliding **up** buys the
summit's detail at the top stop, which is why the swing is small. Negative is also the
direction that could have walked a dark frame back toward the flat plate T797 fixed, and
the gate measures that it does not.

**Neither knob can reach the geometry from the colour side, or vice versa.** `braid1`
carries the shape in alpha and the colour in rgb (T503), so the audio drive is height-only
and the palette drive is colour-only. Neither touches the exposure loop or the motion path.

## What else it proves

**T478: per-point colour reaches the scene pipeline.** `body1`'s `tint` is in map mode on
the bridged `sample`, so the palette colour multiplies the material's base colour *per
point*. Before T478 a scene-pipeline draw had one colour per object and per-point colour
lived only on the legacy renderers — a deep 3D example had to choose. This one does not,
and it needs no albedo map and no uv mapping to do it.

**Unlit is the look, not a shortcut.** A phosphor has no diffuse response. `shot1` names no
lights at all, so nothing shades these quads and the colour is exactly the sample. A lit
material here would multiply the palette by a lambert term and the panel would fall dark at
its edges — plausible, and wrong.

**The aspect fix lives in the kernel.** The bridge maps `position.xy * 0.5 + 0.5` to uv, so
the sampling grid *has* to span [-1,1] on both axes — a square. The source is 16:9. `lift1`
therefore samples on the square and stretches x by 16/9 on the way out: read square, drawn
wide, one line, and the only place the aspect appears.

## The numbers that are constraints, not taste

- **`body1.scale` must stay under half the point spacing.** The sheet is 3.56 world units
  across 480 columns, so the points are 0.0074 apart; a quad half-extent at or above 0.0037
  closes every gap and the scan lines fuse into a solid slab. The first build ran 0.0075 and
  rendered one flat sheet with every wire correct. Pinned by test.
- **`swell1.fillcolor` stays under 1.0** because `bed1` is added on top of it. A dome
  already at full brightness clips flat where the two meet, and the mountain comes out with
  a scooped, level summit.
- **`lift1` returns `sample.a` to 1 before the draw.** `body1` maps that same attribute onto
  the material tint, and a tint whose alpha still carried the height would have made the low
  ground transparent as well as dark.
- **`swell1.softness` is larger than its radius**, which is E13's finding: past the radius a
  Circle is a *dome* rather than a disc, and a disc lifts as a cylinder with a cliff edge.

## No tone map, deliberately

Peak channel in a shipped frame is 0.9995 — nothing exceeds 1.0, so a curve has nothing to
roll off and Reinhard or Filmic would only darken the image. The Output stays on `none`.
Worth stating because this looks like an HDR image and is not one: the bloom is a blur and
an add inside the working range, not a highlight rolloff.

**Re-measured after T797, because an auto-gain is exactly the change that would break it**:
0.9995 at frames 0, 1, 2, 90 and 240 on the lit understudy and on the dark fixture. `norm1`
does push its own output past 1 (peak 1.035 on the lit source, which is the clip the shipped
file was quietly taking), but that is a *height* field, not a colour — the palette is what
sets the drawn colour and its top stop is 1.0.

## Regression signatures

- **A black frame on open** → the switch is selecting the webcam. Either `index` moved or
  an edge lost its `order` and the id tiebreak took over.
- **One flat glowing sheet, no scan lines** → `body1.scale` grew past half the point
  spacing and the quads closed the gaps.
- **The picture is there but lies flat** → the sample stopped reaching the height term in
  `lift1`. This is the failure the GPU control catches; nothing structural can see it.
- **The sheet is on its back again** → the rotation in `lift1` collapsed to 0°, which is
  exactly the old lay-down mapping (`y = h`, `z = −v`). That is the check the coefficients
  were chosen against, so a sheet on the floor means the sines and cosines were swapped.
- **The terrain is a flat plate with one spike in it** → `lift1` went back to reading
  luminance off `coat1` instead of `braid1`'s alpha, and the palette is acting as the height
  curve again.
- **The picture is mirrored top-to-bottom** → the bridge's uv mapping changed and `lift1`'s
  z sign did not follow it, or vice versa. The two move together (B105/T512), and the
  understudy cannot show you: pin the dome at one end of the source to find out which way
  round it is.
- **The panel darkens toward its edges** → the material became lit, or a light list
  appeared on `shot1`.
- **The mountain has a level, scooped summit** → `swell1.fillcolor` went to 1.0 and the add
  is clipping.
- **The relief is squashed to 9:16** → the kernel's aspect stretch was removed.
- **A dark source is a flat plate again** → the exposure loop is open. Either `roof1` lost
  its input edge, or `norm1.whitelevel` fell back to static, or `roofsafe1` was renamed —
  the channel is the node's *name* (§V129), so a rename silently drops the drive back to its
  1.0 fallback and every symptom is "it looks like it did before T797".
- **A dark source blows out into white spray** → `roofsafe1.minimum` went below 0.06 and the
  gain is amplifying whatever the source's noise floor is.
- **Dark pixels go negative / the low ground turns to holes** → someone drove `norm1` or
  `stir1`'s `blacklevel` from the measured minimum. §V694: a black point is a subtraction,
  this target does not clamp, and `analyze` is both subsampled and one frame late.
- **The first frame is blown and over-lifted, then it settles** → `moved1`'s near side went
  back to reading the live source instead of `now1`. On frame 0 a ring reads black, so the
  first difference is the whole picture (§V732's transient, §V769's thumbnail).
- **The whole sheet boils** → `stir1.whitelevel` dropped; it is a *divisor*, so smaller is
  louder. 0.12 shreds the surface into a spray, which is what the tuning pass rejected.
- **The shipped file no longer matches its pre-T809 frames** → one of the two knobs left
  zero. `kick1.operand` and `cycle1.amplitude` are both 0 in the shipped file and the
  identity gate reads exactly 0 differing pixels; anything else means a default moved.
- **Black holes in the summit, or the dome inverted to a silhouette** → someone drove
  `palette1.phase`. See T809 above: a wrap-around rotation of a monotone palette is
  non-monotone, and this file's only depth cues are silhouette and scan-line bunching.
  The rotation that ships is `coat1.offset`, which clamps rather than wraps.
- **The relief pumps on every frame instead of on the beat** → `bsub1`'s rest subtraction
  moved off the low band's T701 value of 0.713, so the drive no longer returns to zero
  between kicks.

## Look pass

Rendered on Dawn at 1280×720 — full project resolution, because additive point density is
resolution-dependent and a half-res look call lies about exposure (§V627) — and read
display-encoded, not off the linear target (§V618). Inspected at frames 1, 90 and 240,
before and after (§V383). The before-and-after is the point: the first build's frame is what "weak" looks
like.

**Correctness.** The understudy plays from the first frame, the sway carries the camera
through a wide arc, and the dome crosses the frame on two incommensurate drifts so no
two laps look alike.

**Beauty (§V420).** The rebuild passes and the original did not. Before: mean frame
luminance 0.076, everything in one mid-blue band, a flat plate with a needle in it, and
nothing legible at thumbnail size. After: teal valleys, a magenta ridge, a white crest, a
clear silhouette against the far ground, and it still reads at 220px wide — which is where
people actually meet it. Verdict: **ships.**

### T797's pass, and it was judged on a dark input (§V471)

The shipped understudy is **lit**, which is very probably why the flat-in-the-dark
behaviour shipped at all: nothing in the gate or the look pass had ever asked this file for
a dark frame. So this pass was run against a dimmed copy of the understudy (`bed1.brightness`
and `swell1.fillcolor` both ×0.14 — the same picture, one fourteenth of the light), at
1280×720, frames 0, 90 and 240, and the frames were **looked at** rather than read off the
numbers (§V732: a baseline delta has no sign).

| arm | frame 90, mean display luma | what the frame shows |
| --- | --- | --- |
| shipped-before, lit | 0.1713 | the Rutt–Etra relief |
| shipped-before, dark ×0.14 | 0.0159 | **a flat navy rectangle** — the report, reproduced |
| motion rig only, dark | 0.0160 | still a flat navy rectangle |
| the same Level with **static** 0…1, dark | 0.0159 | unchanged — so the fix is the *measurement*, not the node |
| auto-gain, dark | 0.1961 | full relief, palette climbing again |
| auto-gain + motion, dark | 0.1977 | the shipped file |
| auto-gain + motion, lit | 0.1812 | still teal valleys, magenta ridge, white crest |

The two controls in the middle are the ones that carried the argument. The **static-Level**
arm says the recovery is the analyze channel and not a lucky extra pass; the **motion-only**
arm refutes the reading that motion carries a frame whose luminance is starved.

**The lit case did not break, which was the other half of the brief.** Side by side with the
pre-T797 frame at 90 and 240: the same composition — teal valleys, magenta ridge line, white
crest, dome silhouette against the far ground, scan lines bunching on the rising slopes. It
is slightly hotter (0.1812 against 0.1713) because `norm1` re-ranges a source that peaked at
1.035 and was clipping, and slightly crisper because the motion term adds high-frequency
relief. It still reads at 220px. Verdict: **ships.**

**What it is not.** The pitch promised a source with *meaning* in it — a face, a word, a
video. The understudy here is procedural, because `text` renders through a canvas that does
not exist in the headless host, so a shipped word would be black in the GPU gate and in
every look pass while being fine in the app. That is a real limitation and it is stated
rather than worked around: the meaningful source is the one the user switches to.

## T820 — the smoothing IS the point

Owner, on the T809 chain: *"relief audioreactivity is too glitchy and jumpy and jittery"*.

They were right, and the cause is one sentence: **T809 wired a raw per-frame band value
straight to the lift.** No smoothing anywhere, so every frame's value was a height, and
`beat1`'s strike has an *instant* attack — `exp(-beatPhase * 7)` is 1.0 on the beat
boundary. Measured on the drive at `kick1.operand = 1`: the value jumped its whole **0.262**
excursion in **one 16 ms frame**, then sagged to ~0 before the next beat. Snap, collapse,
repeat. That is not a musical response, it is a strobe.

Measured on the *picture*, per-pixel mean |Δ| against the previous frame, across the beat at
frame 225:

| arm | the strike frame | a quiet frame | between strikes |
| --- | --- | --- | --- |
| audio **off** (the shipped gain) | 0.0244 | 0.0228 | 0.0228 — the file's own motion floor |
| raw drive, gain 1 | **0.0649** | 0.0228 | 0.038 – 0.042 |
| `env1`, gain 1 | **0.0478** | 0.0243 | 0.026 |

Subtracting the audio-off floor gives the part the audio is responsible for: **0.0405 on the
strike frame, cut to 0.0234 — 42% less**, and the frames *between* strikes fall from ~0.016
down to ~0.003, about **80% less**. The peak keeps **71%** of the raw excursion, so the kick
still reads as a kick.

### `env1` is an envelope follower, and it is one node only because of T814

`valueLag` with **`lag` 0.04** and **`releaseRatio` 8**: a 40 ms attack, so a strike still
lands inside three frames, and a 320 ms release, so at 112 bpm it has decayed to about a
fifth by the next beat. It **pumps and resets** instead of pumping into a plateau — which is
what a longer release buys you, and why the release is 320 ms and not 500 ms. The resting
floor it does introduce is 22% of the peak: the sheet no longer fully collapses between
beats, and that is the intended half of the trade.

Before T814 gave the smoother a `releaseRatio`, fast-attack/slow-release took a hand-built
chain of three or four nodes, rebuilt per example and tuned against a fixture — the exact
duplication T738 measured and T821 exists to end. Here it is one node with two knobs.

**Do not "simplify" this node away.** A straight `bsub1 → kick1` wire is not a shorter
spelling of this graph; it is the bug the owner reported. If you are reading this because
`env1` looks redundant with the gain at zero — it is inert at zero *by construction*, like
everything else T809 added, and the moment anyone turns the knob up it is the difference
between a pump and a strobe.

### The order is still the identity

The chain is now **bias → envelope → gain**, and `kick1` still multiplies **last**. Anything
finite times zero is zero, so `env1` costs T809's identity claim nothing, and that is
measured rather than argued: **12 of 12 byte hashes identical** across frames 0, 1, 2, 60, 90
and 240, on the lit understudy *and* the ×0.14 dark fixture, before and after this node
joined the graph. The envelope belongs between the bias and the gain rather than after it —
after the gain it would smooth the *knob* instead of the signal.
