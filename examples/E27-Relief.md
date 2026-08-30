# E27 — Relief

A moving picture stands up off the screen. Ninety-six thousand glowing points lie on a
sheet in space, each pushed toward you in proportion to the brightness under it, and a
drifting camera films the result: a magenta and deep-blue plain with a luminous mountain
rising out of it, the whole thing built out of separate points that the bloom fuses into
one surface. Rutt–Etra — the analog video-synth look — with a live graph where the scan
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
                                              │
grid1(pointGrid 480×200) ─► bridge1(textureToAttribute) ─► lift1(pointKernel)
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
grid here (480×200) can be a completely different shape from the field (1280×720) with
nothing going wrong. It is also why the rows are sparser than the columns — that is where
the scan lines come from.

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
- **The picture is there but lies flat** → the sample stopped reaching `position.z` in
  `lift1`. This is the failure the GPU control catches; nothing structural can see it.
- **The panel darkens toward its edges** → the material became lit, or a light list
  appeared on `shot1`.
- **The mountain has a level, scooped summit** → `swell1.fillcolor` went to 1.0 and the add
  is clipping.
- **The relief is squashed to 9:16** → the kernel's aspect stretch was removed.

## Look pass

Rendered on Dawn at 1280×720 and inspected at frames 120, 400 and 700 (§V383).

**Correctness.** The understudy plays from the first frame — a rolling sea with a bright
dome crossing it — and the sway carries the camera through a wide arc, so the relief is seen
from several angles. The panel's rectangular edge is visible and reads as a screen rather
than as an unfinished mesh, which is the right reading for this look.

**Beauty (§V420).** This one passes, and I would share the frame. Deep blue troughs, a
magenta mid-ground, a hot white crest, and the point structure legible everywhere without
the image reading as a grid. Three passes got there: the first rendered a single flat slab
(quads twice the point spacing); the second was correct but shallow, with the swell barely
lifting; the third deepened the relief, pulled the camera back and stopped the summit
clipping. Verdict: **ships.**

**What it is not.** The pitch promised a source with *meaning* in it — a face, a word, a
video. The understudy here is procedural, because `text` renders through a canvas that does
not exist in the headless host, so a shipped word would be black in the GPU gate and in
every look pass while being fine in the app. That is a real limitation and it is stated
rather than worked around: the meaningful source is the one the user switches to.
