# E33 — Obol

A yin-yang medallion — a mosaic of seven hundred little slabs standing proud of a
bevelled bed — turns slowly on a dark studio sweep, lit by two softboxes it can see in
itself. It holds. Then its dividing curve goes soft, and the slabs lift off the face in
a wave that leaves the seam and travels outward, arc, and sink; what they sink into is
not a ball but a three-lobed mass of black oil that pinches between its lobes and hangs.
It holds there too. Then the whole thing runs backwards and the medallion reassembles,
slab by slab. One sixteen-second breath, both directions, forever.

**The morph is a deformation with a FRONT, not a cross-fade.** Every point carries two
places — one on the medallion, one on the goo — and a single rule decides how far along
it has travelled, from its own distance to the emblem's dividing curve. A cross-fade at
50% shows a ghost of both pictures. This shows a medallion whose middle has already gone
liquid while its rim is still a hard, lit edge, with its own tiles in the air between
the two states.

## Graph

```
  ramp ──────┐
  circle ────┤ add ─────────────────► render.environment
  circle ────┤ (studio1)                   ▲
  circle ────┘                             │
                                           │
  pointTube ── pointKernel ── geometry ────┤        ┌─ level ─ limit ─ blur ─┐
   (grid:208x160:wrapU)  (morph1)  (body1) │        │                       │
                                           │        │                       │
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
  lfo tide1 ────────────────────► pointKernel.value1  (the morph, both kernels)
  lfo sheen1 ───────────────────► pointKernel.value2  (the spectrum's phase)
  lfo swing1, lift1 ────────────► camera.eye.x, camera.eye.y
```

| Node | Type | Doing |
| --- | --- | --- |
| `shell1` | `pointTube` | 208 x 160 points with **wrapU**, so the longitude seam closes and the surface has no slit. The kernel overwrites every position; only the topology matters here |
| `morph1` | `pointKernel` | the MASS. Two configurations, the melt order, the two tones and the front's spectrum |
| `oil1` | `materialPhong` | shininess 300, roughness driven 0.190 → 0.085. White base colour: the colour is the per-point tint |
| `body1` | `geometry` | surface mode, `tint` in **map** mode bound to the kernel's `tint` attribute (T478) |
| `segpts1` | `pointGrid` | 36 x 20 = 720 slots. The grid's own positions are discarded; `ctx.index` is what the kernel uses |
| `segs1` | `pointKernel` | the SEGMENTS. A phyllotaxis disc of 720 slabs, each with its own piece of the emblem and its own moment in the wave |
| `shards1` | `geometry` | **instances** mode, box, scale 0.026, the same `oil1` material and the same mapped tint |
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

Measured over 12 orbit angles × 5 moments, on the same 208×160 directions the kernel
uses, projected orthographically and binned into 96 angular sectors:

| silhouette | shipped | T673 | perfect sphere |
| --- | --- | --- | --- |
| radius CV vs angle (mean) | 0.086 | **0.234** | 0.000 |
| radius CV vs angle (worst angle) | 0.049 | **0.191** | 0.000 |
| convexity deficit (mean) | 0.0054 | **0.0492** | 0.000 |
| convexity deficit (worst angle) | 0.0020 | **0.0216** | 0.000 |
| max/min radius (mean) | 1.375 | **2.171** | 1.000 |

The row that matters is the second one. T673's WORST orbit angle is more non-circular
than the shipped file's BEST angle, so this is a form that is lobed from everywhere
rather than from the one angle somebody happened to render. Convexity deficit is the
pinch: a sphere and an egg both measure zero, and only a waist raises it.

### The morph did not read because its endpoints were too alike

A morph is legible in proportion to the distance between its two ends, and easing cannot
rescue two similar shapes. The shipped goo kept the emblem's two tones as marbling over
a smooth ball, so the verb was "the disc inflates" — one boring verb.

Both ends were pushed apart. The emblem is flatter and harder: the bevel is
`smoothstep(0, 0.36)` where it was `smoothstep(0, 0.72)`, so the face is a plateau to
within 6% of the rim instead of a dome, and it is built of hard-edged parts. The goo is
lobed, self-occluding and wet, and its marbling is halved so the mass can be one black
thing. The memory of the emblem is carried by the SLABS instead — and a slab travelling
is something an eye can follow, which a deforming blob is not.

The transition is also **staged**. `meltDrive` squeezes the LFO's travel into its middle
— `smoothstep(0.18, 0.82)` where it was `smoothstep(0.06, 0.94)` — so the piece parks at
each configuration for about a third of the cycle and spends the rest moving. There is a
medallion, then an event, then a goo. And the per-element timing is offset by POSITION:
`meltOrder` is the distance to the dividing curve blended with radius, so the change
travels as a wave from the seam outward rather than happening everywhere at once.

### The emblem is now made of parts

The owner's own idea, and the strongest one in the note. `segs1` is a second point system
whose 720 slabs are laid out by the golden angle — a polar lattice crowds at the centre
and a square one leaves a stepped rim, and the golden angle spaces evenly at every
radius so one slab size fits the whole disc with no seam. Each wears its own piece of
`taiji`, and each melts on the same `meltOrder` wave the mass melts on, so a slab lifts
exactly as the surface under it goes soft — one clock, one event, without either kernel
being told about the other.

Two things fall out of it. Motion becomes readable PER ELEMENT: you can follow one slab
leaving the face, arcing, and sinking, instead of watching a blob deform. And the gutters
between slabs are real geometry for the shadow pass and the occlusion pass to bite on.

**They cast, and §V617 is the reason that is a fact rather than a hope.** An unlit
geometry casts no shadow in any draw mode, because a surface that ignores light cannot
block it; these slabs wear the lit `oil1` material, so the depth sweep takes them.
Measured with the bed removed so nothing else could be casting: **28,643 pixels of the
frame darken when the key's shadow is switched on** (154ddf1).

### The lighting was flat because the ambient was doing the work

0.62 of ambient against 0.26 of key is a rig with its contrast turned off. Ambient is the
one term that cannot describe a shape — it is added to every surface whatever it faces —
and it is also the term AO multiplies, so a large flat ambient is not more occlusion to
find, it is a floor the occlusion has to climb out of.

| | shipped | T673 |
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

| | shipped f0 | T673 f0 | shipped f484 | T673 f484 |
| --- | --- | --- | --- | --- |
| object median luma | 153.4 | 154.5 | 60.7 | 72.5 |
| backdrop median luma | 53.3 | 28.2 | 62.3 | 34.3 |
| **separation** | 100.1 | **126.4** | **1.6** | **38.2** |
| p99 (the highlight) | 167.6 | 192.9 | 127.4 | 196.7 |
| object pixels within 12 luma of the backdrop | 4.1% | 11.4% | 36.2% | 15.3% |

A separation of **1.6 luma** is §V618's "dark blob", in the shipped file's own pixels:
the goo was carried by its cast shadow and nothing else.

Measured at **154ddf1** (2026-08-31), shipped and T673 minutes apart on that one tree,
on Dawn/Metal. §V641: an absolute with no commit behind it cannot be told apart from a
table stale since authoring — which is T689, and is why the DELTAS are given beside the
absolutes. The silhouette table above is exempt: it is computed from the kernel's own
arithmetic in TypeScript, never rendered, so no shader change can move it.

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

(154ddf1.)

On the goo it lands 1.8× harder on the outline than on the body: that is a rim. On the
emblem it does not, because a flat disc facing the camera has almost no grazing surface
for a Fresnel term to find — which is the same fact as "the emblem end is flat" wearing
a different hat. The room moves under 3 luma either way.

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
the whole draw, plus per-point position and tint, and nothing else — so every slab is the
same size and the same way up. That reads as a deliberate tiling here, and it is worth
knowing rather than discovering: a mosaic that wanted to tumble as it flew would need a
node-level change, not a parameter.

## Ambient occlusion (T624)

This is the first example to switch on the render's `ambientOcclusion`. It is one
parameter on `shot1` — not a per-geometry opt-in — and the medallion, the slabs and the
cyclorama occlude each other with nothing else to configure (§V437). AO multiplies the
AMBIENT and ENVIRONMENT terms only, never the direct lights: occlusion is about light
that arrives from everywhere, and a key light arrives from one direction whether or not
the neighbourhood is enclosed. The radius came down to 0.34 in T673 because the contacts
it now has to find are 0.009 gutters between 0.052 slabs, and a 0.50 radius sweeps clean
over a contact that size.

The capability itself is pinned somewhere the numbers are unambiguous:
`scene-ao.gpu.test.ts` renders a V-shaped groove with no lights and ambient 1.0, so the
lit result is exactly `albedo × occlusion`. Mid-wall, where the surface is planar, the
byte is **204 with AO on and 204 with AO off**. In the crease it is **146**.

## Clock

The kernels read `ctx.absTime` only — the goo's field, its turn, its drift and the
object's yaw all ride the absolute clock, so nothing snaps at a timeline lap (§V437). The
morph, the spectrum phase and the camera ride LFOs, which are free-running for the same
reason.

Per-slab randomness is `segRand(ctx.index, salt)` and NOT `pointRand`, and the difference
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

- **The goo reads as a sphere again** → the metaball's lobes moved in, or their weights
  went up. Both merge the charges into one ball; the silhouette CV is the number, and
  0.234 is where it should sit.
- **The goo grows spikes, or the mesh tears** → the core charge is gone, or the radius
  solve went back to a bracketed bisection. Without the core a ray misses the field
  entirely; with bisection, neighbouring directions land on different crossings.
- **The mosaic reads as debris rather than as parts** → the slab layout lost the golden
  angle, or the slabs stopped landing on the medallion's own tilt.
- **The slabs are visible inside the goo** → the sink factor drifted above the goo's
  radius. They are drawn under the surface on purpose; a slab riding an oil drop is a
  barnacle.
- **The object and the room are the same brightness** → the ambient went back up, or the
  room's albedo did. The separation number is 38 luma on the goo frame.
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

## Look pass

Dawn, headless, `animate: true`, 1280×720, frames 0 / 200 / 242 / 300 / 484 / 1500 / 2100
— the emblem, the seam beginning to go, the slabs in flight, the full goo, and two far
camera positions. Output space read off the plan (§V470), and every luma judgement taken
from the DISPLAY-ENCODED output rather than a raw linear dump (§V618).

Liveness gate at 192×108, T673 against the shipped file on the same tree:

| | shipped | T673 | floor |
| --- | --- | --- | --- |
| motion | 0.00763 | **0.01256** | 0.002 |
| range | 0.3970 | **0.5953** | 0.30 |
| frame-0 max luma | 0.5963 | **0.8834** | 0.02 |

Both columns measured at **154ddf1**, minutes apart on one tree (§V641). The shipped
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
shipped column above was measured on the unmodified file.

No exemption declared; none needed. Frame 0 is the fully formed emblem on purpose — the
gallery card is frame 0 (T535).

**Wiring guards**, because a parameter that reaches nothing renders a perfectly plausible
picture (§V465, and §B132 is the live example: points-mode `scale` was dropped on the
floor from T647 until today, so every points-mode size ever authored was 0.05). Pixels of
the 1280×720 frame that change, on the emblem frame:

| | pixels changed |
| --- | --- |
| `shards1.scale` 0.026 → 0.045 | 45,651 (4.95%) |
| `shards1` removed from the render | 124,105 (13.47%) |
| `rimband1` unwired from the studio | 209,000 (22.68%) |

(154ddf1.)

The first is the one §B132 would have failed: instances-mode scale is carried, and the
draw changes when it does.

**Beauty (§V420/§V427).** The reservation the first round shipped with — "the fully
melted state reads closer to wet chrome than to oil" — is answered, and by two different
things: T636's diffuse irradiance term (which let the hand-tuned 7× re-exposure come
home to its authored 1.00/0.85, §V575) and, here, by taking the room down so the
reflections are the brightest thing on the object rather than the fill. What remains
honest to say is that the cast shadow is hard, there is no soft area source, and every
slab is the same size and the same way up.
