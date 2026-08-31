# E27 — Relief

A moving picture stands up off the screen, and since T676 it means that literally. A
hundred and five thousand glowing points stand in a sheet leaning back seventy degrees,
each pushed toward you in proportion to the brightness under it, and a swaying camera
watches it face-on: teal valleys, a magenta ridge line, a white crest, and a luminous dome
that wanders across the frame. The bloom fuses thousands of separate points into one
surface. Rutt–Etra — the analog video-synth look — with a live graph where the scan
converter used to be.

**It opens playing its own performer, and your camera is one number away.**

## Graph

```
ripple1(noise) ─► bed1(level) ─────────────► sum1(add).in2
swell1(circle, centre ┄ driftx1/drifty1) ──► sum1.in1
                                              │        order 0
                                              ├──────────────► pick1(switch, index 0)
cam1(webcam) ─────────────────────────────────┘        order 1        │
                                                                      ▼
palette1(ramp) ─────────────────────────► coat1(lookup) ◄──────────────┘
                                              │              ┌─ pick1 (raw, for HEIGHT)
palette1 ─► coat1(lookup) ─────────────► braid1(reorder) ◄─────┘
                              rgb = colour, alpha = source luminance
                                              │
grid1(pointGrid 480×220) ─► bridge1(textureToAttribute) ─► lift1(pointKernel)
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

**What it is not.** The pitch promised a source with *meaning* in it — a face, a word, a
video. The understudy here is procedural, because `text` renders through a canvas that does
not exist in the headless host, so a shipped word would be black in the GPU gate and in
every look pass while being fine in the app. That is a real limitation and it is stated
rather than worked around: the meaningful source is the one the user switches to.
