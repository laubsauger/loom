# E70 — Chimera

A distance-estimated fractal that will not hold still. One fold chain walks it from a
rounded, wet, coral-like reef through a rectilinear skeleton and out into a lobed bulb, and
then back, while bioluminescent veins run in its creases and fire on the drums. Three
coloured lights circle it, handing the key from one to the next. The camera does almost
nothing — it is the shape that moves.

The brief was *"high fidelity 3d fractal like stuff that is evolving, changing segmentation
and shape, meant as a music visualizer… hits of bioluminescence, organics with reflections,
multiple colored lights in scene, high fidelity lighting… an 8k unreal engine art
installation… a really cool VJ patch"*. Shown three separate directions — reef, skeleton and
bulb — the owner asked for something else:

> *"maybe we can combine things and have reef, skeleton and bulb kind a unified into one
> interesting thing… the most critical part is to have something interesting and not just
> very flat and boring after 15 seconds, something that keeps interesting and changing"*

**The second sentence is what this file is built against**, and it is the harder of the two.
"Flat and boring after fifteen seconds" is a failure a still cannot show. E68's stills looked
good while the piece read as a tech demo; E57's beat lanes read fine frame by frame and
blinked in motion. So the question asked of every decision here is *what is different at 15
seconds, at 45, at 90 — and would anybody notice?*

## What it is made of

```
sky1(solid) ─► shape1(customWgsl: the fold chain) ─► fxaa1(customWgsl) ─► out1(output)

music1(audioPattern) ─┐
                       source1(valueSwitch) ─► analysis1 ─┬─► lvl1(valueSelect)
track1(audioFileIn) ──┘                                   └─► hit1(valueSelect)
```

One `customWgsl` pass holds the whole picture — the same lane as E55, E57, E67 and E68 —
followed by one pass of FXAA.

## Three characters, one chain, and they compose rather than blend

The obvious way to give a piece three characters is to write three distance estimators and
cross-fade them. It does not work, and the reason is worth stating because it is the decision
the rest of the file rests on: **a blend of two distance estimators is not a distance
estimator.** It under-estimates between the two, the march steps past the surface, and the
object develops holes at exactly the grazing angles a fractal is mostly seen at.

What is here instead is one chain whose five steps *compose*, so the derivative is exact at
every link by the chain rule:

| link | what it is | what it does to the estimate | the character it carries |
|---|---|---|---|
| rotate | an isometry | nothing — the Jacobian is 1 | **the segmentation** |
| box fold | a reflection | nothing | the **skeleton** |
| sphere fold | a scaling | multiplies by the fold factor | the **reef** |
| power map | z → zⁿ in spherical coordinates | multiplies by n·rⁿ⁻¹ | the **bulb** |
| affine | p·scale + c | multiplies by \|scale\|, then adds 1 | — |

And the property that makes it work is that **every one of those has a neutral setting that
is exact rather than approximate.** A box fold whose limit is wider than the point is the
identity: `clamp(p, -l, l) * 2 - p` is `p`. A power map at n = 1 is the identity, and its
derivative factor is `1 · r⁰ = 1`, exactly neutral.

So the three characters are not three objects being mixed. They are three regions of one
family's parameter space, and the piece walks between them through a continuum of real
shapes. `bulbPower` travels from 1 — no bulb at all, and the term is *skipped*, not computed
and multiplied by nothing — up to 4.2 and back, over 73 seconds.

## The segmentation is a rotation, and the iteration count is deliberately frozen

"Changing segmentation" is the owner's word for the fold structure rearranging rather than
the object merely spinning. Two knobs can do it and only one of them is safe.

**The rotation between iterations** is a rigid transform. Its Jacobian is 1, so the estimate
stays exactly an estimate at every angle, and the fold planes can sweep through the structure
forever without the surface ever popping. Three axes turn at three different rates (0.31,
0.47, 0.23 turns a lap), so the planes *precess* instead of turning as a rigid set — a single
axis just reads as the object spinning, which is the one thing the brief explicitly did not
ask for.

**The iteration count** is an integer. A step in it is a step in the field, and a step in the
field is a visible pop however small the step is. It is held at 11 and nothing animates it.
That is worth saying out loud because it is the obvious knob and it is the wrong one.

## A bounded object — and the first version of this was wrong twice in one line-pair

The camera is parked, so the subject has to be an *object* rather than a place: a Mandelbox
is a place and a place wants a flight through it; what this piece needs is a thing to frame
and turn. The obvious way to get one is a **Julia** iteration — add a fixed constant instead
of the ray's own starting point, and the set becomes compact.

It was tried, and it failed twice over at the same two lines. This is recorded because the
first render looked like a shading problem and was nothing of the kind:

```
p  = p * scale + juliaC;            // a JULIA iteration: adds a CONSTANT
dr = dr * abs(scale) + 1.0;         // the MANDELBOX derivative
```

1. **The estimate was internally inconsistent.** The `+ 1` is the Mandelbox derivative: it
   assumes the added term differentiates to 1 with respect to the ray's starting point. A
   constant differentiates to 0. So `dr` ran systematically large and the estimate
   systematically small — conservative rather than dangerous, but the march creeps.
2. **And the set was not there.** A Mandelbox-*Julia* at this scale and these radii is a thin
   dust. Measured on the first render: **86.1 % of the frame near-black, mean luma 7.53** — a
   scatter of specks and no object anywhere in it.

What ships is the true Mandelbox form: the ray's own starting point **plus a drifting
offset**. The `+ 1` is then exact, and the set is the bounded, richly structured object the
piece needs. The offset keeps the whole reason the constant was wanted — it is a point in
space, and drifting it merges lobes, opens shells and separates arms continuously — for three
floats, with the derivative still correct.

⚑ The general form is worth more than the fix: **a distance estimator is a pair — the map and
its derivative — and changing one without the other produces a picture, not an error.**

## The speckle is the MARCH, and three passes looked for it in the shading

The owner has called this piece *"speckled with noisy stuff… these details don't scale well
when zooming out etc. it all gets just a freckly noisy mess."* Two passes treated that as a
**mark** problem — first under-widened pods, then veins hue-rotated into magenta — and the
speckle survived both. T1322b measured why.

⚑ **The instrument everyone used was wrong.** It counted connected magenta marks above a
brightness threshold, and that count is a brightness statistic wearing a count's clothes: it
reads **zero** with the camera pulled back to `orbitRadius` 34, it fell 75 % when `polish` was
cut *while the visible speckle did not change at all*, and it cannot see a **white** speck by
construction. Every conclusion drawn from it was a conclusion about brightness.

What replaced it is scale-free and colour-blind: a speck is a lit pixel standing more than
twice **its own 3×3 median**. Nothing in it depends on absolute brightness or on how many
pixels the object covers. Read that way, on a 0.000 A/A floor:

| arm | specks, % of lit pixels |
| --- | --- |
| shipped | 0.899 |
| `specular` 0 | 0.893 |
| `polish` 0 | 0.948 |
| pods cut (`nodeGlow` 0, `nodeSpill` 0) | 0.740 |
| veins cut (`veinEmission` 0, `veinSpill` 0) | 0.836 |
| `shellGlow` 0 | 0.882 |
| `fresnelGain` 0 | 0.803 |
| `haze` 0 | 0.891 |
| **`stepScale` 0.78 → 0.45** | **0.619** |
| **`detail` 1 → 4** | **0.365** |

⚑ **Every shading term is a no-op and only the march moves it.** The speckle is *geometric* —
rays terminating at different iterations on structure finer than the pixel — so no amount of
work on pods, veins, hues or reflections could ever have reached it, which is exactly why
three passes of that work did not.

The fix taken is `stepScale` 0.78 → 0.5 (0.920 → 0.635 %, +0.34 ms against a 0.029 ms A/A
floor), and it is the right thing on its own terms besides: a chain this long accumulates
derivative error, so stepping less of the estimate is the file's margin against marching
*through* a thin feature at a grazing angle — and an overshoot at a grazing angle **is** a
land-or-miss per pixel. Raising `detail` buys a better number by resolving less structure, and
it shows: at `detail` 3 the silhouette visibly coarsens.

### T1324b: the lever is nearly exhausted, and the two asks pull against each other

The owner said "noisy, grizzly" for the fifth time and, in the same message, asked for **less**
— *"LESS IS MORE… embrace negative space"*. Those two interact, and the interaction is the
finding: **opening the form costs noise by itself.** The same statistic reads 1.02 % at the old
density and 1.54 % at the top of the new spacing lane's travel, because a sparser body is more
thin structure seen edge-on per pixel.

And at that new density `stepScale` stops being a lever at all: 1.035 / 0.957 / 0.984 / 1.018
across 0.50 / 0.42 / 0.36 / 0.30 — flat and non-monotone, where at the old density the same
sweep read 1.024 / 0.873 / 0.767. The arm that used to be the claim's positive control went the
**wrong way**: `stepScale` 0.78 measured 0.0105 against a shipped 0.0133.

What ships is `stepScale` 0.36 with `detail` 2.5 → 3, which lands **0.943 %** — slightly
quieter than the build the owner called noisy, on a body with nine times the negative space.
⚠ And `detail` is bounded from the other side by the same trade: at 4 it fills the very holes
this pass exists to open (holes 31 → 18, hole share 5.52 % → 1.38 %), because a coarser
termination threshold stops rays in the thin places and paints the gaps solid. **A quality knob
that buys the noise number by spending the thing the row is about is not a quality knob.**

## The checkerboard: right symptom, wrong place to look — twice

The owner reported *"a CHECKERBOARD TEXTURE IN THE MAGENTA GLOW"*, and the volume march's
per-pixel jitter was indicted for it: `hash2i` multiplies each coordinate by an **odd**
constant, so the low bit of the xor is x⊕y parity — a checkerboard by construction, before the
finaliser. **That half is exactly true: 262 144 of 262 144 pixels.**

⚑ **It does not reach the picture.** The PCG finaliser destroys it. Mean jitter over
even-parity pixels against odd reads 0.499409 / 0.499714 — a gap of **0.000306, five times
smaller than the 0.001476 the same statistic returns split on a bit pair the hash cannot know
about**. And the rendered frame has no checkerboard either: a three-mode Haar detector (HH
against (LH+HL)/2, which has a known null of 1.0 for isotropic noise) was validated first —
white noise 0.98, gradient 0.95, stripes 0.00, a synthetic checkerboard 8×10¹⁶ — and then read
**0.10 to 0.44** on this frame, at cell sizes 1/2/4/8 px, at eight times across the run, at
every shot state. `haze` 0 did not move it.

### And then the owner sent a close-up, and there WAS one (T1324b)

The Haar sweep above is honest and it answered a different question: it swept the **whole
frame**, and the defect is a **local patch on one object**, which averages away to nothing in a
frame-wide statistic. Measured inside the pod mask instead — on a detector validated first
against a synthetic shaded disc (0.00 % interior steps) and the same disc multiplied by an
axis-aligned piecewise-constant lattice (18.67 %) — the pods read **48–51 %** of their own
interior pixels sitting on a hard luminance step, at every moment across a minute.

⚑ **The cause is a granularity mismatch and nothing to do with a hash.** A pod is
`2 × nodeRadius` = 1.24 units across. It was gated (*is this pod lit?*) and flared (*when does
it burst?*) on `floor(p × veinRate)` — the **conduit** lattice, cells 1/3.1 = **0.32** units
across. A membership test evaluated on cells four times smaller than the object it gates does
not gate the object, **it dices it**: every pod was multiplied by an axis-aligned piecewise
constant stepping 0.06 → 1, sixteenfold, across planes running through its own face. Flat
faces, hard edges, a grid on the face.

⚠ **Two other diagnoses were measured and killed.** The trap was thought to be a sphere seen
through the box fold, and the `min` across links was thought to crease: `nodeLinks` 1 / 2 / 6
give **bit-identical pods** (9 pods, 3122 px, both shape statistics to three decimals), because
the first link wins the trap essentially everywhere a pod is visible. Neither hypothesis had
anything to answer for.

The fix gives the pod its own identity — `Trace.nodeCell`, the box-fold lattice site of
whichever link trapped it, which is **constant across a pod by construction** because the
trap's reach (0.62) is smaller than `foldLimit` (1.45), so the site index cannot change inside
one. Interior step density **48–51 % → 27–34 %**, and the number that makes that mean
something is the **stone's own relief read through the identical mask**: 32–36 %. The pod was
half again rougher than the surface it is painted on; it is now at or below it, which is as
smooth as a glow on this surface can be. Both are claims: a guard asserts the pods no longer
read `veinRate` at all (and that the veins still do), and a second one holds the ratio.

⚠ **A third diagnosis died here too, and it was the one that named this row.** The pod was
read as *"a sphere seen through the box fold, whose pre-image has flat faces"*. It has none:
`clamp(p,-L,L)*2 - p` is a **reflection** per component — an isometry — so the pre-image of a
ball is a union of reflected **balls**. A boundary-orientation detector (validated: synthetic
disc 59.1 %, synthetic square 99.4 %) puts the pod outline at **60.0 %** shipped and **65.1 %**
with the defect restored: both at the disc end, neither anywhere near the square. The pods were
never boxes in outline. The owner's *"square patterns"* were the interior steps above, and
rounding the shape was never the fix.

So the **frame-wide** reading stands: there is no global checkerboard, and if one is visible at
that scale it is in the display path, not in this image — a
non-integer canvas scale resampling fine static grain will manufacture one. The jitter is an
R2 sequence now rather than a hash, and the page says plainly what that bought: **not less
noise** (A/B'd on one build, hash 4.25 % / R2 4.13 % / a constant half-stride 4.79 %, against
a reference that disagrees with itself by 3.21 % — three arms inside the instrument's own
floor) but one dot product instead of a PCG finaliser, and the retirement of the file's last
hash along with its `// @use hash` include.

## Twelve clocks, and they are prime — checked, not asserted

This is the answer to "not boring after fifteen seconds", and it is structural rather than
decorative.

| clock | period | what moves |
|---|---|---|
| `hueTurn` | **37 s** | the colour lap, two hues travelling in opposition |
| `orbitPeriod` | **23 s** | one lap of the camera around the object |
| `pushPeriod` | **31 s** | the approach — and the shot lane |
| `posePeriod` | **47 s** | the camera's second axis |
| `lightCycle` | **53 s** | *which* light is the key — and which way the shadow falls |
| `aimPeriod` | **59 s** | where the camera looks when it is close |
| `characterPeriod` | **71 s** | reef/skeleton → bulb → back |
| `morphPeriod` | **89 s** | the fold rotation: the object's own turning |
| `spacingPeriod` | **103 s** | **the gaps between the nodules opening and closing** |
| `voidPeriod` | **107 s** | the shells opening: negative space *inside* the sculpture |
| `scalePeriod` | **181 s** | the chain's magnification: the density of incident |
| `seedPeriod` | **277 s** | the seed offset's drift: the object's topology |
| `paletteTurn` | **197 s** | **the whole palette's swing: the colour evolving without any colour moving relative to another** |

Twelve primes, split by the ruling that splits them: **form may evolve over a minute and may
not restructure under a shot; light and camera may do whatever the music asks.** The combined
state repeats on their product, so no viewer ever sees a cycle land.

⚑ **And that is now a gate rather than a sentence.** `chimera-claims.gpu.test.ts` enumerates
every period in the document and asserts them **pairwise coprime** — it needs no GPU, because
it is arithmetic. It exists because the same enumeration, run for the first time on the
sibling piece, found two of nine periods sharing a factor of three while two commit messages
described the whole set as mutually prime. Nobody had checked; everybody had said it. More usefully, **any two moments a viewer
compares have a different subset of them moved**: at fifteen seconds the segmentation has
turned and the colour has started to separate; at forty-five the magnification has breathed
and the key light has handed over; at ninety the object is a different shape with a different
topology, lit from a different side, in a different pair of hues.

`chimera-claims.gpu.test.ts` asserts this as a measurement rather than as an intention — with
the audio cut and **the orbit frozen**, so what is being measured is the shape's own
evolution and not the camera's.

## The light rig has reach, and a hierarchy

Three point sources of different hue — a cold key, a magenta opposition, a warm back light —
each with a **falloff**. That is the single most important number in the lighting and it is
not an aesthetic preference: a light with no reach lights the far side of the object exactly
as hard as the near side, which is frontal flat-lighting, and §T1304c found it was most of
what made E68 read cheap. With the reach in, the object has depth as colour.

The **hierarchy** exists because three equal lights are three lights, and one dominant light
with two supports is a lit scene — "lights all over the place" was the complaint on the
sibling piece and it was about incoherence, not brightness. Each source's weight swings on the
53-second cycle offset by a third of a lap, so at any moment one of the three is the key, and
which one it is rotates.

The warm rim does **not** travel round the wheel with the other two. Rotating an orange about
the luminance axis walks it into magenta, which is the one specific way this trick fails.

⚑ **And the fill does not travel either any more, because it was doing exactly that.** The
fill was the frame's "second temperature" — a magenta in opposition to the key — and the owner
looked at the result and called the material *"very even grey"* while it was, in fact, evenly
magenta. One arm at a time settled it: **cut the spill and the object stays magenta; cut the
fill and it is teal stone with discrete magenta nodes on it.** The wash was the light.

Two lessons came out of that, and the second is sharper than the first:

- **A hue sprayed over geometry that already has a colour is a tint; a hue carried by an
  object the eye can point at is a second light.** This is the sixth recorded case of a second
  colour failing because it was put on a light. The opposition survives, and it is now between
  two *objects*: teal veins and magenta nodes.
- **Retuning the fill's colour could not have fixed it.** An amber fill was measured and came
  back magenta anyway — `fillTint` was hue-*rotated*, and the hazard that exempts `rimColor`
  two paragraphs above was never extended to it. A parameter sweep cannot find a defect that
  lives in the code the parameter feeds.

## The nodes: a third kind of mark, and the second hue rides it

The veins are **lines** and the membranes are **sheets**. A frame made of those two is a frame
made of one idea seen twice, and it had no top end at all. The nodes are **points** — how
close the orbit passed the *origin* before the sphere fold pushed it back out, which is the
structural definition of a core. They cost one `min` per link, on a radius the fold already
computes.

⚑ **The first version of this trap was pointed at a place the orbit never goes** — it measured
the radius *after* the affine step, which ends by adding the ray's own starting point, so the
orbit's radius there sits a couple of units out. It produced 21 marks over 0.02 % of the frame
and **zero** below a radius of 0.2. The tell was the shape of the sweep: **a mark that falls to
*zero* rather than to *fewer* is absence, not rarity**, and reading it as rarity would have led
to widening the radius and buying nothing.

**They recur at every scale, which is the property that makes the second hue work.** An object
carrying a hue only reads as a second light if it appears at a size the eye can compare — the
win is the interleaving, not the object-ness. Measured with a connected-component pass over the
soloed node term, in a **single frame**: **949 marks, median area 1 px, largest 1 247 px, four
decades of area.** Single-pixel nodes on far structure and 35-pixel pods on near structure, at
the same time.

**And they light the stone they sit in.** A term added to a surface's colour does not emit
anything — it brightens the pixels it covers and leaves every neighbour untouched, and in a
still that is indistinguishable from a light. So a `nodeSpill` term reads a wider window on the
same trap, exactly as the vein's spill does. Measured by cutting it: stone within ten pixels of
a pod moves by **1.708** mean luma and stone beyond it by **0.034** — a ratio of **50×**. That
is a light, and it is a local one.

Moving energy from the core into the spill is also what stops the pods going white at the
centre and losing their hue where the eye looks hardest:

| `nodeGlow` / `nodeSpill` | p99 | mean chroma, brightest 5 % |
|---|---|---|
| 22 / 3.2 | 237.8 | 0.158 |
| 14 / 5.5 | 230.7 | 0.203 |
| **9 / 7.5** (shipped) | 224.8 | **0.253** |

Sixty per cent more hue across the pod for thirteen units of peak.

## The distribution is quasirandom, because "too rarely" is a distribution complaint

Which cells carry a live conduit used to be chosen by an **independent uniform hash**, and
independent uniform samples have no repulsion: the gaps between chosen cells are exponentially
distributed, so some neighbours land adjacent and some regions carry nothing at all. The
sibling piece's owner saw the clumping half (*"all over the place and overlap in an ugly
way"*); this one saw the void half (*"they appear too rarely"*). **One defect, two complaints**
— and raising the density would only have made the clumps worse.

The sibling's repair was `fract(index × 0.618…)`, the golden ratio's conjugate, the most
equidistributed sequence there is in one dimension. A conduit lattice in a fractal is not
one-dimensional, so what is used here is its three-dimensional form — the **plastic number's**
reciprocal powers, the R3 sequence. It is *cheaper* than the hash it replaces, and just as
deterministic.

⚑ **And the value is used twice, which is the half without which this reads as a grid.** A
distribution fixes *where*, not *how much*; evenly spaced marks of identical width and
brightness are mechanical. The pick doubles as a **rank** — a cell well inside the threshold is
a principal conduit, wide and bright; one that only just made the cut is a minor one. The
hierarchy is free: it falls out of the number the membership test already computed.

## The pose moves the object, not the camera

The owner asked to *"sometimes follow one of the fractal knobs a little closer and see some
angles"*, and then settled the mechanism themselves: *"it doesn't have to be the camera that
moves, it can also be the piece."* That is the better half of the choice. A parked camera is
the stable reference the morph is legible against, and it is what keeps every claim in this
file provable — a two-frame comparison across a moving camera measures the camera.

So the object turns on its own axis (61 s), swims toward the frame and back (43 s, **cubed**,
so it is near zero most of the time and rises to a peak briefly), and the framing drifts off
the centroid while it is close (67 s) — because the interesting part of a fractal is never the
middle.

⚑ **It costs nothing, and the reason is worth stating so nobody moves it.** A rigid rotation
and a uniform scale are exactly invertible, so "the object turned and grew" and "the ray was
turned and shortened" are the same picture. The transform is applied to the eye and the ray
**once per fragment**. Applying it to the sample point instead would pay the same matrix
product on every distance evaluation, and a pixel makes about a hundred and fifty of those.

## Marks are never narrower than the pixel looking at them

A dense scatter of single-pixel marks across the surface is **salt**, not detail. It is the
same defect the sibling piece hit with its surface grain, and it has the same cause: a feature
finer than a pixel lands or misses per pixel, and neighbouring pixels disagree at random.

Two fixes, and they do different jobs:

- A node's **sharp core** fades out with view distance, leaving its spill behind. That is a mip
  level, done as a fade because a marcher has no derivatives to pick one with. The node does
  not disappear — only its high-frequency half does — so the interleaving the second hue
  depends on survives.
- **Every mark widens to at least the pixel's own footprint**, which is this file's own march
  epsilon lesson one level up. `epsilon` is already computed by the march, so it is free and
  exactly proportionate: near marks untouched, far marks smeared to the width the image can
  actually carry.

## The bioluminescence is the orbit trap

The emission field is not a second field painted onto the surface. It is the **orbit trap** —
how close the chain's orbit passed to the axis, tracked as it iterates — so the light is
aware of the structure by construction and costs three instructions a link rather than a
field of its own.

There are two of them, and the difference is §V962 applied rather than rediscovered. The
**vein** is a narrow window on the trap: what the surface burns. The **spill** is a *wider
window on the same trap*: what the surface is lit by. That is what a glow actually is — a
coarser field with the same structure — and blurring the vein instead would fail here for
exactly the reason that row measured, because the vein is thinner than any blur radius worth
having, so a blur of it returns the vein again.

A vein also **gutters**: a share of its run is dark, hashed on a lattice so it fails in the
same places on every device. A line that cannot fail reads as tape; a line that can reads as a
conduit.

## The palette travels as a rigid body

The owner: *"the lights color should probably evolve over time and maybe also slightly change
in shade with beat or something."* That is in direct tension with the bound this file put on
its hue rotation one pass earlier, after an **unbounded** lap walked the veins into the key
light's blue at t = 20 s and cancelled the two-temperature design the piece is built on.

⚑ **The resolution is to rotate the palette as a whole.** `rotateHue` is a Rodrigues rotation
about the grey diagonal, so one turn applied to *every* colour is an **isometry**: every
pairwise arc is preserved exactly, at every t. The defect the bound exists to prevent is drift
of one colour **relative** to the others, and common-mode drift has none by construction.

⚠ **And the algebra is not the measurement.** The unbounded common-mode lap was built,
rendered and then bounded: at 0.30 of a turn every arc is exactly intact and the frame is
**yellow pods on pink stone** — the eye is not rotation-invariant, so "every relative arc
preserved" does not mean "the same colour design". `paletteArc` 0.16 is a **second** ceiling
for a **second** failure: `hueArc` stops two colours colliding, this stops the palette leaving
its own family. Over a minute the swing travels about 0.10 of a turn, which is visible
evolution and still this piece.

The arcs are read off rendered pixels, with each element isolated by **difference** — the same
frame with that element's own gains at zero, subtracted. Two instruments were wrong before that
one. The first bucketed pixels by brightness and its parked-palette control moved
(0.032 → 0.002 → 0.422 with the palette frozen): it was measuring which population happened to
be bright. The second rendered each element **alone**, which sounds like isolation and is not —
the sky, the environment rim and the stone are still in the frame, they do not travel with the
palette, and on the dim arms they outvoted the thing being measured (vein chroma 0.036 against
0.153 once isolated properly). That instrument reported the turn closing the tightest pair from
0.041 to 0.023, which would have condemned the feature.

⚑ **And the honest answer is not the one the isometry argument predicts.** Measured properly,
the three elements' own travel under the same turn reads **0.214 / 0.145 / 0.123** — a rigid
rotation of the tints, put through a base colour, an exposure, a tone map and a saturation
grade, none of which commute with it. So the pairwise arcs do move, by up to 0.092 of a turn,
and the tightest pair in the piece — veins against key — closes from **0.126 parked to 0.103
turning**, an eighteen per cent squeeze rather than the zero the algebra claims. What the bound
buys is therefore the thing §V996 is actually about: no pair can be **walked into** another.
Every arc keeps at least four fifths of itself and none comes near zero. That is a claim now,
red-verified against `hueArc` 0.5 — the unbounded per-element rotation this file shipped two
passes ago — which fails it at *"pods and veins must not arrive at the same colour at 49 s"*,
0.0535 against a 0.06 bound.

The beat half is a **shade** nudge on the pods and nothing else — 0.018 of a turn at the peak
of a kick, measured pod hue 0.9889 silent / 0.9990 at rest / 0.0295 at the peak. A hue is
exactly the kind of thing a transient may move, because it **returns**. A beat-rate gain on a
source is the pump this owner has rejected three times.

## Negative space is not a constant — it is what the piece looks like in the quiet parts

The owner, fifth pass: *"LESS IS MORE sometimes. I think we still need to EMBRACE NEGATIVE
SPACE a little bit better… and have enough going on in the actual DRIVING PART OF THE SONG."*
Four earlier passes had asked for **more development**, and the natural answer to that is more
lanes, more marks, more motion. This is the correction: the body was too **uniformly dense** —
structure everywhere and rest nowhere.

That reads as taste and it is a connectivity property. **Enclosed background regions inside the
silhouette**: a piece with negative space has them, a solid knobbly mass does not. On a counter
validated first against a synthetic disc with 0 / 1 / 5 holes punched in it (it returned 0 / 1
/ 5), the body measured **0.02–2.09 %** of its own interior across a minute — against 8.87 %
for that five-hole disc. Solid, exactly as described.

⚑ **The operator that fixes it was already in the file, parked where it does nothing.** Every
candidate was swept with all clocks frozen:

| operator | what it moves | holes |
| --- | --- | --- |
| `minRadius` 0.30 / 0.62 / 0.80 | **nothing at all — bit-identical** | 4 / 4 / 4 |
| `foldLimit` 1.10 / 1.90 | coverage 13.3 % → 33.7 % | 1 / 1 |
| `bulbPower` 1.6 / 3.6 | coverage 16.5 % → 22.4 % | 1 / 7 |
| **`fixedRadius`, effective 1.11 / 1.41 / 1.56 / 1.91** | **hole share 0.74 % → 1.06 % → 4.08 % → 16.92 %** | **4 / 12 / 31 / 43** |

⚠ `minRadius` being a **no-op** is worth saying out loud: the orbit's radius essentially never
goes below it, so the inner branch of the sphere fold does not fire — which makes both the
"reef character" and `voidTravel`'s whole lane inert at the shipped settings.

⚠ And the spacing lane has a **threshold**, which is why it read as working while buying no
form. Below an effective ~1.25 the shape statistics do not move at all (0.60 and 1.20 are
identical to 1.00 on coverage, holes and convolution) even though the **pixels** do — RMS 6.93
and 8.88 against 0.00 for the A/A control. It was moving the surface and not the body, and only
a statistic that can see the **silhouette** could tell those apart.

Centred at 1.45 and travelling, the body reads **9–40 holes and 3.87–13.61 %** hole share
across a minute, up from 1–15 and 0.02–2.09 %. Coverage fell only 19.8 % → 16.9 %, which is the
half that matters: **the holes came from the form, not from the object getting smaller.**

And the sustained lane now drives *that*. Sparse and still when the music is, dense and active
when it drives — "less is more" and "enough going on" are the two ends of one lane rather than
two competing targets. It reads `lowMid` because that band carries the most slow movement on
the owner's own track through this exact window (σ of a 30 s moving average: low .1006,
lowMid .1323, highMid .1303, high .1211), and this is the file's only slow structural lane.

## The audio rides amplitude, never identity

Every clock above runs on `absTime`. **Nothing about the shape's identity is audio-driven** —
if the music decided what the object *is*, then silence would be a different object, and
silence is what every thumbnail and every headless render actually shows (§V914). The piece
is fully alive with no track at all; the music scales what is already moving.

Transients ride **envelopes, not counts** (§V966). A count is 1 for exactly one frame, so
anything it drives steps in one frame and is a blink by construction — gain and decay shape
only the release, never the attack. E57 measured the band envelopes at a 4.2× smaller worst
single-frame step, *and they still land*.

| target | lane | why |
|---|---|---|
| `veinEmission` | `hit1.kick` envelope | the hits of bioluminescence the brief asked for by name |
| `shellGlow` | `hit1.snare` envelope | the membranes answer on the backbeat — a *different* structure, so two hit lanes are two events rather than one read twice |
| `veinSpread` | `hit1.hat` envelope | finer reaction to finer detail: a hat widens the glow, not the veins |
| `haze` | `lvl1.low` rank | the medium breathes |
| `fillIntensity` | `lvl1.highMid` rank | the opposition light opens |
| `specular` | `lvl1.high` rank | the wetness follows the top end |
| `saturation` | `lvl1.centroid` rank | spectral brightness opens the chroma |
| `spacingOpen` | `lvl1.lowMid` rank, **centred**, **inverted** | **sustained** energy CLOSES the gaps: sparse and open when the track is quiet, dense and busy when it drives — the one lane that reaches the form, and the only kind that may |
| `keyIntensity` | `hit1.kick` envelope | the key punches, and because the key now CASTS, its shadow snaps with it |
| the shape | **nothing at all** | see below |

Every retained value is the lane's **driven mean**, not its floor and not its peak: the value
that stands when no drive arrives has to look like the piece, because that is the picture the
thumbnail shows.

### Light may flash at beat rate. Form may not.

The piece used to drive its **shape** from the music — `openness` for how far open the chain
sat, `foldTravel` for the creases. The owner watched it and cut both by name:

> *"it's still pumping, like pulsing instead of us doing it by camera, which then prevents us
> that we can't have close-ups and flyovers that make sense without being noisy because the
> thing itself rotates and pumps. So I think we really need to do this with the camera
> instead."*

That reverses their earlier *"it doesn't have to be the camera that moves, it can also be the
piece"*, and the reason it is right is measurable rather than aesthetic. **A camera move is a
rigid transform of the view, so world-space detail stays coherent frame to frame and the eye
integrates it. A pump deforms the very structure the shot is magnifying** — at close range the
detail is not sliding out of frame, it is being destroyed and rebuilt every frame, which is
what reads as noise. No shot-gating fixes that; only removing the deformation does.

### And then the camera punch was rejected outright

A rigid dolly on the kick landed for one pass and measured as **92 % of the whole piece's
transient response** (5.07 on a hit against 1.12 between; punch cut, 0.41 / 0.11; every drive
cut, 0.000 / 0.000). The owner saw it and said:

> *"camera pulses are so ugly too. that's vomit inducing… we can't have like 1 frame camera
> punches on kick and stuff. it's horrible."*

⚑ **It was removed rather than softened, and the word that decided that is "1 frame".** The
complaint is the *duration*, not the destination, so a smaller punch is the same gesture with
a smaller amplitude. **A correct mechanism pointed at an effect nobody wants is still the
wrong effect.** The consequence is stated rather than hidden: with it gone the fast lane drops
to near zero, and that is not paid for here with a substitute motion. Beat-driven camera
motion is a standing refusal for this piece.

### The timescale of the driver must match the timescale of the thing driven

In the same breath the owner asked for *"the shape shifting should be more audio reactive"*,
which looks like a reversal of "form may not" and is not. What has been rejected three times
is a **transient** driving something **structural** — the scale pumping per beat, then a
one-frame dolly. What is asked for is the **morph**, a slow thing, answering on **its own**
timescale.

⚑ **A transient driving form is a pump. A transient driving a camera is a twitch. A sustained
signal driving form is the piece dancing.** So `spacingOpen` — the gaps between the nodules —
reads a **ranked level**, which moves over seconds and cannot step, and it drives an *offset*
on a bounded quantity rather than a *rate* on a clock. (A rate would need integrating, a
fragment shader has no state to integrate into, and multiplying a rate into `t` makes the
phase jump by `t · Δrate / period` — an error that grows with the clock.)

That lane takes `window: 60` on the analyser rather than the component's 16 s default.
Measured on the owner's own track as the σ of a 30 s moving average — what survives once fast
detail is gone — 16 s → 60 s roughly **doubles** the slow movement on every band (low .0501 →
.1006, lowMid .0614 → .1323, highMid .0700 → .1303, high .0584 → .1211). It is a **peak, not a
monotone**: 180 s is worse than 60, because a window approaching the track's length has too
little history to rank against.

⚑ **§V914 was satisfied by arithmetic, and it paid out at the deletion rather than at the
landing** — twice now. `openness` and `punch` were both centred so they retained *exactly*
their neutral value, so removing each is bit-for-bit invisible in the no-track picture. A lane
centred on its floor could not have been removed without a retune.

## It works at any tempo

E68 is tuned at 112 BPM — every duration in it is an absolute number, so it reads slack at 80
and frantic at 160, which is the deepest complaint on that row. Here the morph clock is
multiplied by `tempoScale`, written so the term vanishes whenever there is no tempo to claim:

```
1 + bpmConfidence * (bpm - 112) / 112
```

With no audio, or a live source that estimates nothing, `bpmConfidence` is 0 and the whole
term is 1. On the shipped pattern the confidence is 1 and the bpm *is* 112, so it is 1 by
arithmetic rather than by luck — the rest state and the shipped picture are the same picture,
and a 140 BPM track moves the morph 25% faster with nothing retuned.

It is read from `source1` rather than from the analysis bags, and that is load-bearing: the
levels lane ranks everything to 0..1 over a sliding window, so a bpm through it would read 0.5
forever.

## Resolution, and what "8K" was taken to mean

1280×720, set **explicitly** on the document rather than inherited from a default, so the
piece and its claims agree about what it was designed for.

The owner ruled out taking the number literally — it is a look, not a pixel count — so the
frame is spent on what the pixels contain. The density of incident comes from the fold chain,
the clean edges from FXAA (a marcher cannot MSAA), the sense of a rendered rather than a
shaded surface from the ambient occlusion, and the richness of light from three sources with
real falloff and a grade that moves tone without moving chroma.

## The cost

Measured at 1280×720 as GPU extent on Dawn, arms **alternated**, **awaited** every frame, as
**trimmed means** over 260 of 276 frames rather than medians — Dawn quantises timestamps to
65 536 ns and a median lands on the quantum and reads "free" (§B211). Every arm reported a
**complete set of spans, 828/828**, printed rather than assumed, because a back-to-back
render reports a fraction of its passes and looks entirely plausible (§T1295).

Each stage is removed by a **parameter on a wavefront-wide branch** rather than by an edit:
`polish` at 0 skips the reflection march entirely, `haze` at 0 skips the volume's loop,
`veinEmission`/`veinSpill`/`shellGlow` at 0 remove the bioluminescence. So a cost belongs to
an idea rather than to a rebuild.

| stage | what it adds | ms @720 | delta |
|---|---|---|---|
| 1 | the bare chain: march, normals, occlusion, three lights, grade | **2.147** | — |
| 2 | + the bioluminescence: veins, spill, membranes | **2.457** | +0.31 |
| 3 | + the volume: light visible in the air | **2.543** | +0.09 |
| 4 | + the reflection bounce — a *second march* | **3.329** | +0.79 |
| — | **A/A control** (byte-identical to stage 4) | **3.156** | *0.17* |

**The last row is the one that makes the others citable.** It is the shipped arm run twice,
so the 0.17 ms between it and stage 4 is the *machine*, not an idea. Read against that floor:

- **the reflection bounce is real and it is the expensive idea** — +0.79 ms, four and a half
  times the noise floor, exactly as predicted for the only second march in the file;
- **the bioluminescence is measurable** — +0.31 ms, about twice the floor;
- **the volume is not resolvable on this instrument.** +0.09 ms is *below* the 0.17 ms the
  machine moves by on its own, and saying so is the honest answer rather than a failure.

**The whole piece is ~3.2 ms** — between E13's 2.8 ms datum and E57's 4.1, and well under
E68's 10.6. No idea was cut to get there; the piece is simply cheap, because a fold chain is
all ALU and the expensive character (the power map) is *skipped* at its neutral setting
rather than computed and multiplied by nothing.

**No estimate is quoted here as though it were a measurement.** The shape document priced
this family at 7–13 ms and labelled it a guess; it measured 3.2. That rule has its own
invariant because this catalogue has paid for it twice — E68 was priced at 25–35 ms by a
read that had never run it, and shipped at 4.76.

### What each arm actually removes

Before a millisecond was attributed to an idea, each arm was checked for doing only its own
job — an arm that quietly scales something else looks like a second independent cause.
Measured as the share of the frame that changes, and the share of the **outer margin**, which
the sculpture never reaches:

| arm | frame changed | margin changed |
|---|---|---|
| no veins | 2.5 % | **0.00 %** |
| no reflection | 16.7 % | **0.00 %** |
| no volume | 36.4 % | 9.38 % |

The first two touch nothing outside the subject, which is what a surface term must do. The
volume moves 9.38 % of the margin, and that is correct rather than a leak — a participating
medium *is* a full-frame term. It is recorded so the number is not later read as a localised
effect.

## The grade, measured after the backdrop went black

The owner asked for a black background and then for the contrast to be tuned *to it*, in that
order — and the order matters, because the old histogram described a picture that no longer
exists.

⚑ **On a black backdrop a whole-frame histogram is mostly measuring the backdrop.** It will
always report "crushed", and grading against it would be grading the empty space. So the
distribution is reported twice: whole-frame, and **subject only** — pixels the sculpture
actually occupies.

| | p01 | p50 | p90 | p99 | true bright |
|---|---|---|---|---|---|
| first pass | 14.7 | 66.4 | 116.9 | — | **0.00 %** |
| **second pass** | 14.4 | **86.3** | **165.8** | **227.1** | **0.15 %** |

⚑ **THE FIRST PASS HAD NO TOP END AT ALL, AND THAT WAS A CONTENT DEFECT RATHER THAN A GRADE
ONE.** The owner's *"the material is for the most part very very even grey"* is that table's
first row: ninety per cent of the object below mid-grey and the upper half of the range empty.
The instrument was validated against a known positive before the null was believed — and the
validation is the finding:

| exposure | p50 | p90 | true bright |
|---|---|---|---|
| 1.55 (shipped) | 66.4 | 116.9 | **0.00 %** |
| 6 (≈4×) | 150.3 | 195.3 | **0.00 %** |
| 20 (≈13×) | 210.7 | 235.3 | 4.43 % |

**Four times the gain moves the whole slab up and still clips nothing.** So a regrade would
have produced a *brighter* even slab and looked like progress. What the frame was missing was
small bright things, so what was added is small bright things — see the nodes, below. Cutting
them takes p99 from 227.1 back to 182.0 and true-bright to 0.00 %, while p50 moves only 86.3
to 70.9: **a term that moves the top of the distribution and not its middle is a highlight.**

Two numbers were found by that instrument and fixed:

- **`lift` shipped at 0.004 and is now 0.** A lift exists to open crushed shadows; against a
  black backdrop it has nothing to open and simply greys the void. Measured, it put **96.3 %
  of the frame above the floor** and made the "black" background luma 4.5.
- **The volume was filling the frame.** Its falloff tightened from 3.2 to 1.5 so the medium
  clings to the sculpture instead of hazing the void it hangs in.

And the subject's own share of the frame moves across the run — **12.3 %, 29.2 %, 19.5 %,
18.7 %** at four sampled frames — which is the acceptance criterion showing up in an
instrument that was not built to look for it.
