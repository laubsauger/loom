# E33 — Obol

A yin-yang medallion — seventeen hundred little tiles laid on nothing, the emblem's two
tones and its dividing curve carried by the tiles themselves — turns slowly on a dark
studio sweep, lit by two softboxes it can see in itself. It holds. Then the curve goes
soft, and the tiles lift off the face in a wave that leaves the seam and travels outward,
arc through the air, and pack themselves into a three-lobed drop of black oil that pinches
between its lobes and hangs. It holds there too. Then the whole thing runs backwards and the
medallion reassembles, tile by tile. One sixteen-second breath, both directions, forever.

**There is nothing behind the tiles, and that is the point (T716).** The medallion has no
bed and the goo has no surface: the same seventeen hundred elements are the whole object
at both ends, so the change is a TRANSFORMATION rather than one thing dissolving while
another appears. Every tile carries two places — one on the medallion, one on the goo —
and a single rule decides how far along it has travelled, from its own distance to the
emblem's dividing curve. A cross-fade at 50% shows a ghost of both pictures. This shows a
medallion whose middle has already gone liquid while its rim is still a hard, lit edge,
with its own tiles in the air between the two states.

## Graph

```
  ramp ──────┐
  circle ────┤ add ─────────────────► render.environment
  circle ────┤ (studio1)                   ▲
  circle ────┘                             │
                                           │
                                           │        ┌─ level ─ limit ─ blur ─┐
  pointGrid ── pointKernel ── geometry ────┼── render ──────────────────────add ── output
   (segpts1)             (segs1) (shards1) │   (shot1)                       │
                                           │      ▲  ▲                       │
  pointGrid ── pointKernel ── geometry ────┤      │  └── camera (eye1)       │
   (sweeppts1)           (sweep1)   (cyc1) │      │                          │
                                           └──────┴───── 3 lights            │
                                                                             │
  lfo tide1 ─┬─ multiply ─ add ─► render.aoIntensity        (and the render's own
             ├─ multiply ─ add ─► render.environmentIntensity  output feeds `in1`)
             └─ multiply ─ add ─► materialPhong.roughness
  lfo tide1 ────────────────────► pointKernel.value1  (the morph)
  lfo sheen1 ───────────────────► pointKernel.value2  (the spectrum's phase)
  lfo swing1, lift1 ────────────► camera.eye.x, camera.eye.y
```

| Node | Type | Doing |
| --- | --- | --- |
| `oil1` | `materialPhong` | shininess 300, roughness driven 0.190 → 0.085. White base colour: the colour is the per-point tint |
| `segpts1` | `pointGrid` | 54 x 32 = 1728 slots. The grid's own positions are discarded; `ctx.index` is what the kernel uses |
| `segs1` | `pointKernel` | THE OBJECT — the only one there is. Both configurations, the melt order, the two tones and the front's spectrum, over 1728 tiles that carry the medallion AND the goo |
| `shards1` | `geometry` | **instances** mode, box, scale 0.019, the `oil1` material and the mapped `tint` attribute (T478) |
| `rimband1` | `circle` | the rim — a band on the equirect's horizon, which is what a silhouette reflects (see below) |
| `sweep1` | `pointKernel` | bends a flat 64 x 96 grid into a cyclorama — flat to z = −2, then rising 14 units over the next 16 |
| `shot1` | `render` | three lights, an equirect environment on a wire, `ambientOcclusion` on at quality **high** |
| `cut1`/`clip1`/`veil1`/`bloom1` | `level`/`limit`/`blur`/`add` | the bloom, with the clamp that makes it work (see below) |

## T673 — what the second round changed

The owner's verdict on the shipped file was *"not looking interesting enough… the morph
does not read too well and the target is still too much like a sphere"*, plus an ask for
better lighting and shadows and an idea: *"maybe the ying yang is comprised of separate
little segments or parts"*. Four things, three of them measurable.

### "Too much like a sphere" was a silhouette fault, not a shading one

The eye reads shape from the OUTLINE. High-frequency displacement changes surface
TEXTURE and leaves the outline circular, so a sphere with noise on it stays a sphere
however well it is lit — and no amount of lighting work can fix a silhouette.

The goo is now a **four-charge metaball**: three lobes far enough apart that the surface
between them pinches, plus a **core charge** that keeps the form star-shaped about the
origin. The core is load-bearing rather than tidy — without it the lobes separate, a ray
from the centre misses the field entirely, and the radius along that direction collapses
to zero, which is a torn mesh. The radius is taken at the OUTERMOST field crossing by
scanning inward, not by bracketed bisection: a ray through three charges can cross three
times, and neighbouring directions converging on different crossings is a crack.

T673 recorded, over 12 orbit angles × 5 moments on the mass's own 208×160 directions,
projected orthographically into 96 angular sectors: radius CV vs angle **0.086 → 0.234**,
worst angle 0.049 → 0.191, convexity deficit 0.0054 → 0.0492, max/min radius 1.375 →
2.171 (154ddf1). Its point stands: T673's WORST orbit angle was more non-circular than the
pre-T673 file's BEST one, so the form is lobed from everywhere rather than from the one
angle somebody happened to render.

**Those numbers are about an object that no longer exists.** T716 deleted the mass, so the
outline the eye reads is the TILE CLOUD's, and the number was re-taken on it — see
[T716](#t716--the-disc-is-gone-and-the-tiles-are-the-medallion) below. The mass is
measured again there too, on the same instrument and in the same run, because a figure
re-derived on a different instrument is not comparable to the one it replaces.

### The morph did not read because its endpoints were too alike

A morph is legible in proportion to the distance between its two ends, and easing cannot
rescue two similar shapes. The shipped goo kept the emblem's two tones as marbling over
a smooth ball, so the verb was "the disc inflates" — one boring verb.

Both ends were pushed apart. The emblem is flatter and harder: the bevel is
`smoothstep(0, 0.36)` where it was `smoothstep(0, 0.72)`, so the face is a plateau to
within 6% of the rim instead of a dome, and it is built of hard-edged parts. The goo is
lobed, self-occluding and wet, and its marbling is halved so the goo can be one black
thing. The memory of the emblem is carried by the TILES instead — and a tile travelling
is something an eye can follow, which a deforming blob is not. T716 took the same argument
one step further: with the mass gone the tiles are not the memory of the emblem, they are
the emblem, and the two ends are now a wide flat mosaic and a compact dense drop — a
difference in SIZE as well as in shape.

The transition is also **staged**. `meltDrive` squeezes the LFO's travel into its middle
— `smoothstep(0.18, 0.82)` where it was `smoothstep(0.06, 0.94)` — so the piece parks at
each configuration for about a third of the cycle and spends the rest moving. There is a
medallion, then an event, then a goo. And the per-element timing is offset by POSITION:
`meltOrder` is the distance to the dividing curve blended with radius, so the change
travels as a wave from the seam outward rather than happening everywhere at once.

### The emblem is now made of parts

The owner's own idea, and the strongest one in the note. `segs1` lays its tiles out by the
golden angle — a polar lattice crowds at the centre and a square one leaves a stepped rim,
and the golden angle spaces evenly at every radius so one tile size fits the whole disc
with no seam. Each wears its own piece of `taiji`, and each melts on the same `meltOrder`
wave, so a tile lifts exactly as the wave reaches it.

Two things fall out of it. Motion becomes readable PER ELEMENT: you can follow one tile
leaving the face, arcing, and arriving, instead of watching a blob deform. And the gutters
between tiles are real geometry for the shadow pass and the occlusion pass to bite on.

T673 still ran this mosaic over a solid bed. T716 removed the bed, which is what turned
"parts on a medallion" into "parts that ARE the medallion".

### The lighting was flat because the ambient was doing the work

0.62 of ambient against 0.26 of key is a rig with its contrast turned off. Ambient is the
one term that cannot describe a shape — it is added to every surface whatever it faces —
and it is also the term AO multiplies, so a large flat ambient is not more occlusion to
find, it is a floor the occlusion has to climb out of.

| | pre-T673 | T673, unchanged by T716 |
| --- | --- | --- |
| `shot1.ambientIntensity` | 0.62 | 0.20 |
| `key1.intensity` | 0.26 | 0.55 |
| `key1.shadowExtent` | 2.8 | 3.2 |
| `fill1.intensity` | 0.11 | 0.22 |
| `plaster1` albedo | 0.185 | 0.085 |
| sky ramp | ×1.0 | ×0.42 |
| `keybox1` radius | 0.150 × 0.052 | 0.280 × 0.130 |
| `shot1.aoRadius` | 0.50 | 0.34 |

The sky is dimmed and the softboxes are not, and that pairing is the whole of "wet". The
sky's widest reader is the irradiance tap (five samples over a broad cone along N, T636)
— a DIFFUSE fill — so a bright sky lifts a near-black oil to putty grey however dark its
albedo, and tuning the albedo cannot get it back because the fill scales with the sky and
not with the surface. Dim the room, leave the boxes: the reflections keep their
brightness, the fill goes away, and what is left is the ratio the eye reads as gloss
rather than the level it reads as exposure.

Measured against a render of the same frame with the object removed, on the
DISPLAY-ENCODED output — §V618, with the space read off the plan per §V470, because a
verdict about lighting taken from a raw linear dump is about a stop and a half out:

| | pre-T673 f0 | T673 f0 | pre-T673 f484 | T673 f484 |
| --- | --- | --- | --- | --- |
| object median luma | 153.4 | 154.5 | 60.7 | 72.5 |
| backdrop median luma | 53.3 | 28.2 | 62.3 | 34.3 |
| **separation** | 100.1 | **126.4** | **1.6** | **38.2** |
| p99 (the highlight) | 167.6 | 192.9 | 127.4 | 196.7 |
| object pixels within 12 luma of the backdrop | 4.1% | 11.4% | 36.2% | 15.3% |

A separation of **1.6 luma** is §V618's "dark blob", in the pre-T673 file's own pixels:
the goo was carried by its cast shadow and nothing else.

Measured at **154ddf1** (2026-08-31), the two columns minutes apart on that one tree, on
Dawn/Metal. §V641: an absolute with no commit behind it cannot be told apart from a table
stale since authoring — which is T689, and is why the DELTAS are given beside the
absolutes. **T716 moved this table too, and re-took it** — the object it describes is now
tiles with nothing behind them, and the new column is below.

## T716 — the disc is gone, and the tiles are the medallion

Every number in this section was measured at **bc681b7** (2026-08-31) on Dawn/Metal, both
documents minutes apart on one tree (§V641), display-encoded at 1280×720 (§V618, §V627).

The owner, on the T673 build: *"the obol thing should not have the disc behind the cubes
assembling the yinyang so that it really looks like the cubes transform into the blob and
vice versa"*. T673 shipped TWO objects — a mass (a metaball at one end, a bevelled coin at
the other) and 720 tiles laid on it. The mass showed between the tiles, so the emblem read
as a solid with tiles ON it, and at the goo end the tiles sank out of sight entirely: the
verb was "the tiles vanish and a blob appears".

`shell1`, `morph1` and `body1` are deleted. The tiles are the whole object, at both ends.

**THE ONE NUMBER THAT SAYS WHY.** Shrink the tiles to `scale 0.007` in each file and
re-measure how much of the emblem's face each of its two tone populations holds. T673's
emblem is STILL a legible yin-yang with its tiles reduced to specks — the smaller
population holds **41.3%** of the object — because the disc was drawing it. T716's
collapses to **19.1%**, because there is nothing else. That is the owner's complaint
stated arithmetically, it is better evidence than any before-and-after picture because it
isolates the disc's contribution rather than describing the result, and it is the reason
the emblem's legibility is now MEASURED below rather than asserted.

### Both ends out of one element, and the map between them is one line

The tiles were already a Fibonacci lattice on the disc: tile *i* sits at radius
`sqrt(u)·0.930` and azimuth `i·137.5°`, with `u = (i+½)/n`. The Fibonacci SPHERE is the
same sequence read with `z = 1 − 2u`. So the disc and the sphere are the same lattice in
two poses, and the map between them is one line of arithmetic that

- keeps every tile's AZIMUTH exactly — a tile does not swap places with its neighbours,
- is monotone in radius: the centre of the face goes to one pole and the rim to the other,
- is area-uniform at BOTH ends, so the mosaic has no crowding at either.

That is what makes the change followable rather than a re-shuffle, and it costs nothing:
`u` and `ang` are computed once and both configurations are built from them. T673's
staging (`meltDrive`'s `smoothstep(0.18, 0.82)` hold at each end) and its positional wave
(`meltOrder`, the distance to the dividing curve) are reused unchanged — a tile still
lifts when the wave reaches it, and the arc still peaks at the half-way point.

### The drop is drawn at 0.620, and that is arithmetic

Without a mass under them the tiles have to COVER the goo, and a tile count that tiles a
disc does not tile a sphere. Measured on the kernel's own field:

| | |
| --- | --- |
| the medallion's face | π · 0.888² = **2.478** |
| the metaball's surface at its natural size (4π·⟨r²⟩, ⟨r²⟩ = 0.403) | **5.059** |
| ratio | **2.04×** |
| goo scale at coverage PARITY with the face | **0.700** |
| goo scale shipped | **0.620** |

0.620 rather than 0.700 because tiles are laid per unit SOLID ANGLE while a lobe at radius
`r` has area going as `r²` — coverage thins as `1/r²`, so the mean is the wrong statistic
and the lobes are where the holes appear. At 0.620 the mosaic closes out to `r = 0.72`,
about the field's 73rd percentile, and the 15% radial jitter puts a second tile behind
what is left. It is also, pleasingly, the size the medallion's own material makes: the
plate is 0.89 in radius and 0.148 thick, and that volume is a ball of radius 0.44 against
the drop's mean radius of 0.38.

The mosaic itself: 1728 tiles, hexagonal pitch **0.0407**, tile edge **0.038** — the
tiles close to **93.4%** of their own spacing, so there are gutters (6.6%) and no merging.
Both bounds matter and both are one parameter away: at edge/pitch ≈ 1.15 the tiles
interpenetrate and the face goes back to being a plate, and below ≈ 0.6 it is confetti.

### Does it still read as a yin-yang with nothing behind it?

This is the question the change could have failed, and "the mass is gone" is not an answer
to it. Three numbers on the emblem frame at 1280×720, display-encoded (§V618, §V627), over
the object's own pixels (mask from a shadowless pair, so the cast shadow is not counted):

| frame 0 | T673 (with the disc) | T716 (tiles alone) |
| --- | --- | --- |
| object pixels | 166,454 | 150,536 |
| smaller tone population, as a share of the object | 42.2% | **45.6%** |
| tone contrast (median light − median dark) | 130.3 | **129.6** |
| best straight line's misclassification | 17.0% | **17.4%** |

The third row is the one that says "yin-yang" rather than "two-tone disc": a bisected disc
is separated perfectly by one straight cut, and a taiji's boundary is two arcs, so any
straight line has to give up the lobes. It went slightly UP without the disc.

**And the instrument is not blind, which is the part that makes it evidence** (§V655,
§V666). Shrink the tiles to `scale 0.007` and re-measure:

| tiles at `scale 0.007` | T673 | T716 |
| --- | --- | --- |
| object pixels | 157,373 | 92,278 |
| smaller tone population | 41.3% | **19.1%** |

With the disc present the emblem is still a perfectly legible yin-yang with the tiles
reduced to specks, **because the disc was drawing it**. That is the owner's complaint,
stated as a number, and it is the reason the same measurement means something now.

Two more mutations move the other two rows and nothing else: `tone = smoothstep(-0.03,
0.03, disc.x)` (a straight bisector instead of `taiji`) takes the straight-line error to
**7.3%**, and `tone = 1.0` takes the smaller tone population to **6.9%**.

### The silhouette, re-measured on the object that now exists

Same instrument as T673 — 12 orbit angles × 5 moments, orthographic, 96 angular sectors —
run on both objects in the same pass. The tile cloud's sector radius includes a tile's own
half-diagonal, because a tile is a solid box and not a point.

| silhouette | the mass (T673's object) | the tile cloud (T716's object) | perfect sphere |
| --- | --- | --- | --- |
| radius CV vs angle (mean) | 0.239 | **0.224** | 0.000 |
| radius CV vs angle (worst angle) | 0.168 | **0.158** | 0.000 |
| convexity deficit (mean) | 0.0433 | **0.0795** | 0.000 |
| convexity deficit (worst angle) | 0.0145 | **0.0515** | 0.000 |
| max/min radius (mean) | 2.360 | **2.343** | 1.000 |

The lobes survive: CV falls 6% and the pinch — the thing that says "not an egg" — nearly
doubles, because a cloud of boxes has a rougher outline than the surface it samples. The
mass column here is a RE-RUN, not T673's recorded row: it reads 0.239 against the recorded
0.234 because the moments and orbit phases are sampled slightly differently. That is the
point of running both in one pass — the two columns are comparable to each other, which is
what the table is for, and neither is comparable to a number taken on another instrument.

### The body, the separation and the shadow

Everything the mass was silently providing had to come back from the tiles. Same
instrument, same tree, both documents minutes apart:

| | T673 f0 | T716 f0 | T673 f484 | T716 f484 |
| --- | --- | --- | --- | --- |
| object median luma | 165.0 | 165.6 | 72.5 | 66.7 |
| backdrop median luma | 28.2 | 28.2 | 34.1 | 35.0 |
| **separation** | 136.9 | **137.4** | 38.4 | **31.6** |
| p99 (the highlight) | 193.6 | 187.5 | 196.6 | 170.3 |
| object pixels within 12 luma of the backdrop | 4.2% | 5.7% | 11.0% | 9.4% |
| object pixels | 166,454 | 150,536 | 95,248 | 32,879 |

The emblem end is unmoved. **The goo end loses 6.8 luma of separation and that is a real
cost, stated rather than buried**: the drop is a third of the pixels it was and the room
shows through its gutters, so its median falls. It is still 20× §V618's "dark blob" figure
of 1.6, and the fraction of object pixels indistinguishable from the room went DOWN.

Shadows, which is §V617 and the thing that gives a pile of boxes its body:

| pixels that darken when the key's shadow is switched on | T673 | T716 |
| --- | --- | --- |
| full scene, f0 | 64,999 | 31,557 |
| full scene, f484 | 37,418 | 24,061 |
| tiles alone (nothing else can be casting), f0 | 56,799 | **22,016** |
| tiles alone, f484 | 8,779 | **11,710** |
| tiles alone, **material mutated to the unlit one** | **0** | **0** |

The last row is what makes the others evidence. §V617 says an unlit geometry casts no
shadow in any draw mode, because a surface that ignores light cannot block it — and the
number goes to exactly zero when `oil1` is swapped for a light-ignoring material, at both
ends, for both documents. The tiles cast BECAUSE they are lit matter, not because a shadow happens to
appear. The f0 count halves against T673 because the tiles are smaller and flatter and
there is no bed for them to cast onto; at the goo end, where they now form the whole mass
and shade each other, it goes UP.

## The rim is not a light, and that is a fact about this renderer

"Rim light is what makes slick oil read" is the standard answer, and it is unavailable
here. The diffuse term is TWO-SIDED by rule — `lambert = abs(dot(N, L))` (T301) — and so
is the highlight, `abs(dot(N, H))`. A directional light placed behind the subject
therefore lights the faces pointing AT the camera exactly as hard as the ones pointing
away: a back light in this engine is a second key wearing a rim's name. One at intensity
1.60 blew the emblem's light half to white and produced no edge at all.

What rims here is the environment's Schlick term (T632). `envFresnel` rises to 1 at
grazing incidence, and at grazing the reflection vector points AWAY from the camera — so
the silhouette samples the equirect at its horizon, `(0.5, 0.5)`, and until now there was
nothing there but the dim end of the sky ramp. `rimband1` is that texel.

**And it is a rim on the goo and a fill on the emblem** — which is the Fresnel term
working rather than a compromise, and is worth stating because "rim light" implies an
edge everywhere. Mean |Δ| luma with the band wired against unwired, split by a 6px
erosion of the object mask:

| | silhouette ring | body interior | the room |
| --- | --- | --- | --- |
| goo frame (484) | **45.8** | 25.9 | 2.8 |
| emblem frame (0) | 14.5 | **19.5** | 1.8 |

(154ddf1, on the object as T673 shipped it: a smooth mass with tiles on it.)

On the goo it lands 1.8× harder on the outline than on the body: that is a rim. On the
emblem it does not, because a flat disc facing the camera has almost no grazing surface
for a Fresnel term to find — which is the same fact as "the emblem end is flat" wearing
a different hat. The room moves under 3 luma either way.

**T716 did not re-take this pair, and the limit it records is the reason.** §V640 is
already stated with these two numbers and T716 changes nothing about `rimband1` or the
Fresnel term — but the object it was measured on is gone, so the table is kept with its
stamp rather than presented as current. What T716 does change is the direction of the
finding: the emblem end is now MORE grazing surface, not less, because a mosaic of boxes
has a rim of vertical faces where a flat plate had none. Whether that turns the fill into a
rim is unmeasured and is not claimed.

## Three things that had to be arithmetic, not taste

**A flat medallion seen dead-on is pixel-identical to a sphere.** The first build had the
coin facing the camera and every look pass read it as a ball, because in silhouette it
*is* one. The emblem is tilted 17° about x, which puts the rim bevel on screen as a lit
edge, and the camera's own swing rests off-axis rather than at zero.

**Distance to the dividing curve has a conical local maximum at each dot.** Raw
`min(|d₁|, |d₂|)` peaks at the centre of each of the two dots, so each dot was the last
thing left un-melted and got pulled out into a literal spike with a specular on it. The
fix is two-part and both parts are needed: cap the distance at 0.42 so those peaks become
plateaus, then blend 40% of the plain radius in so the front has a global outward sweep
and there is no interior maximum for the surface to be drawn towards.

**A Level's black point is a subtraction — §V510, paid for again.** The bloom's threshold
is a `level`, and on a float target it sends the whole background to
`(0.0006 − 0.80) / 0.5 = −1.6`. `add` is front + back, so the first build of this chain
subtracted a constant −1.6 from the finished frame: the picture came back BLACK with a
blown-out object floating in it, and the render itself was perfect. `limit` in clamp mode
is the node that was missing. E4 records the same pairing; it cost this file a build
anyway.

## What "ambient studio lighting" needed, and what it did not

**It did not need an area light.** The catalogue has directional and point lights only,
and the visually load-bearing part of a softbox on a slick surface is its REFLECTION —
which arrives through the environment input. What an area light would still add is a soft
shadow EDGE and a diffuse wrap; the cast shadow here is hard, and that is recorded rather
than hidden (§V328: state the capability, never promise the hardware).

**It did need a POINT light.** Directional lights do not fall off, so three of them paint
a cyclorama one flat grey and the piece reads as a model on a card table. The `crown1`
light is a point light at (0, 2.90, −3.40) with intensity 14, which the 1/(1 + d²)
attenuation eats down to about 0.6 at the object. The gradient on the backdrop is that
ratio and nothing else.

**And it needed a cyclorama, not a floor.** A floor ends, and its far edge lands inside a
42° frame as a hard horizon with black above it. The cove was grown again in T673: the
old sheet put its far lip at y = 9.96 where the frame top is 8.34 and its edge at x = 15.0
where the frame half-width is 14.75 at the camera's widest swing — both inside the picture
with nothing to spare, which showed as a dark curved wedge in the top-left corner once the
room was dark enough to see it against.

## What is still not here

**A per-instance SCALE or ORIENTATION.** The instanced path carries one `instance.x` for
the whole draw, plus per-point position and tint, and nothing else — so every tile is the
same size and the same way up. That reads as a deliberate tiling here, and it is worth
knowing rather than discovering: a mosaic that wanted to tumble as it flew would need a
node-level change, not a parameter.

**It is also the constraint that sets the goo's size.** One tile size has to serve a face
of 2.478 and a surface of 5.059, and the only free variable left is how big the drop is
drawn — which is why 0.620 is arithmetic and not a taste call. A per-instance scale would
let the drop be full size and the tiles grow into it, and nothing short of that will.

## Ambient occlusion (T624)

This is the first example to switch on the render's `ambientOcclusion`. It is one
parameter on `shot1` — not a per-geometry opt-in — and the tiles and the cyclorama occlude
each other with nothing else to configure (§V437). AO multiplies the AMBIENT and
ENVIRONMENT terms only, never the direct lights: occlusion is about light that arrives
from everywhere, and a key light arrives from one direction whether or not the
neighbourhood is enclosed. The radius came down to 0.34 in T673 because the contacts it
had to find were 0.009 gutters between 0.052 slabs, and a 0.50 radius sweeps clean over a
contact that size. T716's gutters are smaller again — 0.0027 between 0.038 tiles — but the
contacts that matter are no longer only the gutters: the height jitter puts every tile
0 to 0.008 proud of its neighbours, and at the goo end the tiles pile against each other
through the whole depth of the drop. The radius is left at 0.34 and that is a decision,
not an oversight: it is now sized for the pile rather than for the seam.

The capability itself is pinned somewhere the numbers are unambiguous:
`scene-ao.gpu.test.ts` renders a V-shaped groove with no lights and ambient 1.0, so the
lit result is exactly `albedo × occlusion`. Mid-wall, where the surface is planar, the
byte is **204 with AO on and 204 with AO off**. In the crease it is **146**.

## Clock

The kernels read `ctx.absTime` only — the goo's field, its turn, its drift and the
object's yaw all ride the absolute clock, so nothing snaps at a timeline lap (§V437). The
morph, the spectrum phase and the camera ride LFOs, which are free-running for the same
reason. There are three salts: `11u` for a tile's depth in the rind, `29u` for how high it
arcs, and `47u` for how proud it sits on the face.

Per-tile randomness is `segRand(ctx.index, salt)` and NOT `pointRand`, and the difference
matters: `pointRand`'s hash is salted with the FRAME index by contract, so a draw taken
per point changes every frame. A per-element CONSTANT has to come from the element's own
index.

**The yaw is a gate, not a flourish.** Every other motion arrives through the value graph,
and the cook oracle (T249) renders each example with no channel resolver — so the first
build of this file hashed all eighty of its oracle frames identical. That is not a harness
artefact: an idle value graph in the app produces the same still picture. A 12° sway on
the absolute clock fixes it at the source, and it is also what keeps the softbox
reflections travelling across the surface.

## Regression signatures

- **The emblem stops reading as a yin-yang** → the tiles' own colouring or their spacing
  moved, and there is no longer a disc behind them to cover for it. The three numbers are
  45.6% smaller tone population, 129.6 luma of tone contrast and 17.4% straight-line
  error; a straight bisector takes the third to 7.3% and one flat tone takes the first
  to 6.9%.
- **The emblem reads as a solid plate again** → the tile edge went above its own lattice
  pitch. 0.038 against 0.0407 is 93.4%; past about 115% the tiles interpenetrate and the
  mosaic closes into a disc, which is exactly what T716 removed.
- **The emblem reads as confetti** → the same ratio went the other way, or the tile count
  fell. Below about 60% the face has more room than tiles in it.
- **The goo reads as a sphere again** → the metaball's lobes moved in, or their weights
  went up. Both merge the charges into one ball; the silhouette CV is the number, and
  0.224 on the tile cloud is where it should sit.
- **The goo grows spikes, or the mesh tears** → the core charge is gone, or the radius
  solve went back to a bracketed bisection. Without the core a ray misses the field
  entirely; with bisection, neighbouring directions land on different crossings.
- **The goo reads as a rind with holes in it** → the goo scale drifted up from 0.620.
  Coverage thins as 1/r², so the lobes empty first and the pinches crowd; 0.700 is bare
  parity with the face and anything above it is see-through.
- **The mosaic reads as debris rather than as parts** → the tile layout lost the golden
  angle, or the tiles stopped landing on the medallion's own tilt.
- **The tiles vanish at the goo end** → somebody reintroduced a sink factor. Before T716
  they were drawn UNDER a surface that no longer exists, and a tile that sinks now is a
  tile that has left the object.
- **The object and the room are the same brightness** → the ambient went back up, or the
  room's albedo did. The separation numbers are 137 luma on the emblem frame and 32 on
  the goo frame.
- **No rim at all** → `rimband1` is unwired, or it moved off `v = 0.5`. The silhouette
  reflects the equirect's horizon and nowhere else. Expect the goo's silhouette ring to
  move ~46 luma when it is switched off; if it moves like the body does, the band is
  acting as fill only and has drifted off the horizon.
- **The emblem's light half is blown to white** → somebody added a "rim light" as a
  directional light. The diffuse term is two-sided; a back light is a front light here.
- **The frame is black and the object is blown out** → the bloom's `limit` is gone or its
  `low` is below zero. §V510: a Level's black point subtracts.
- **A dotted crescent across the lit half** → the shadow bias went back to a constant.
- **A dark arc in a top corner** → the camera swung past the edge of the cyclorama.
- **The oracle hashes every frame the same** → the object lost its absolute-clock yaw.
- **A tile swaps places with its neighbours across the morph** → the disc-to-sphere map
  stopped sharing `u` and `ang` with the disc layout. The map is followable only because
  it is the SAME Fibonacci sequence in two poses; an independently generated sphere
  direction renders an identical still frame and a re-shuffle in motion.

## Look pass

Dawn, headless, `animate: true`, 1280×720, frames 0 / 200 / 242 / 300 / 484 / 1500 / 2100
— the emblem, the seam beginning to go, the tiles in flight, the full goo, and two far
camera positions. Output space read off the plan (§V470), and every luma judgement taken
from the DISPLAY-ENCODED output rather than a raw linear dump (§V618).

Liveness gate at 192×108. T673 against the file it replaced, then T716 against T673,
each pair measured minutes apart on one tree:

| | pre-T673 | T673 | T716 | floor |
| --- | --- | --- | --- | --- |
| motion | 0.00763 | 0.01256 | **0.01124** | 0.002 |
| range | 0.3970 | 0.5953 | **0.5713** | 0.30 |
| frame-0 max luma | 0.5963 | 0.8834 | **0.7051** | 0.02 |

**A moved baseline row is not evidence either way about this change.** The liveness
instrument samples 192×108 and reports three scalars, and structural damage far larger
than anything here passes it — so the row below is a record of a deliberate move, not a
check that the example survived. What checks that is the legibility gate in
`examples.gpu.test.ts`, at full resolution with its control rendered in the same run.

**`look-baselines.json`'s E33 row moves in this commit, deliberately (§V643), by
−0.00132 / −0.0240 / −0.1783.** The first two are small; the third is not, and it has one
cause: frame 0's brightest pixel used to be the specular hot-spot on the mass's glossy
dome, and there is no dome. The tiles' own highlights are smaller and flatter, and 0.705
is what the picture actually contains. Re-measured with `measure-look-baselines.ts
--only E33` so no other example's row was swept up (§V646).

The first column was measured at **154ddf1**; the T673 and T716 columns above were
re-measured together at **bc681b7**, and T673's row reproduced its recorded value exactly. The pre-T673 column does NOT match the row this file used to carry
— 0.01191 / 0.7419 / 0.7621 — and that disagreement is T689, filed rather than papered
over.

The pre-T673
column does NOT match the row this file used to carry — 0.01191 / 0.7419 / 0.7621 — and
that disagreement is T689, filed rather than papered over.

**Those old numbers were not wrong when they were written. They were measured on an
engine that no longer exists.** The bisect came back clean: this example's `.loom.json` is
byte-identical to its md-authoring commit, so the DOCUMENT never moved — the shading path
did, at `44d010b`, when T632's Schlick Fresnel and T636's diffuse irradiance replaced
E33's hand-tuned environment gain with physical terms. That pair left the file 22% dimmer
at frame 0, 46% flatter in range and 36% less lively, and nothing since has moved it.
Which is §V642's lesson, and this file is where it was learned: **reverting a PARAMETER is
not reverting an EFFECT.** T636 brought `environmentIntensity` home from 7.00/9.00 to its
authored 1.00/0.85 and recorded that as the constant going home (§V575) — true of the
number, and only approximately true of the picture, because the two terms that made the
revert possible are not the term they replaced. Nothing in T673 caused any of this; the
pre-T673 column above was measured on the unmodified file.

No exemption declared; none needed. Frame 0 is the fully formed emblem on purpose — the
gallery card is frame 0 (T535).

**Wiring guards**, because a parameter that reaches nothing renders a perfectly plausible
picture (§V465, and §B132 is the live example: points-mode `scale` was dropped on the
floor from T647 until today, so every points-mode size ever authored was 0.05). Pixels of
the 1280×720 frame that change, on the emblem frame:

| | T673 | T716 |
| --- | --- | --- |
| `shards1.scale` → 0.030 | 28,842 (3.13%) | 30,515 (3.31%) |
| `shards1` removed from the render | 185,496 (20.13%) | 165,678 (17.98%) |
| `rimband1` unwired from the studio | 159,359 (17.29%) | 142,011 (15.41%) |

Counted at a threshold of 8 luma. The rim guard is given at 8 rather than 1 because the
environment reaches the cyclorama as well as the object, so at 1 luma it saturates at
99.99% of the frame in both columns and stops discriminating — a guard that always passes
at 100% is not a guard. T673's md recorded 209,000 (22.68%) for it on an unstated
threshold; this row replaces it rather than sitting beside it.

The first is the one §B132 would have failed: instances-mode scale is carried, and the
draw changes when it does. The second is now the whole object rather than a layer on it —
removing `shards1` leaves an empty room.

**Beauty (§V420/§V427).** The reservation the first round shipped with — "the fully
melted state reads closer to wet chrome than to oil" — is answered, and by two different
things: T636's diffuse irradiance term (which let the hand-tuned 7× re-exposure come
home to its authored 1.00/0.85, §V575) and, here, by taking the room down so the
reflections are the brightest thing on the object rather than the fill. What remains
honest to say is that the cast shadow is hard, there is no soft area source, and every
tile is the same size and the same way up — and, after T716, that the goo end costs 6.8
luma of object-to-room separation and is drawn at 0.620 of the field's natural size,
because one fixed tile size cannot cover both a disc and a sphere twice its area.
