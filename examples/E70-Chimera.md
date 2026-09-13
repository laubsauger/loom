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

## The speckle was the epsilon, and the fix was also the cost saving

The first lit render was covered in coloured salt-and-pepper noise. It was not the step size
(halving `stepScale` and raising the step count moved the frame's mean by 0.06) and it was not
the specular exponent. It was the **termination threshold**.

A fixed epsilon asks every ray for the same absolute precision. A ray crossing a region whose
detail is finer than its own pixel stops wherever it happens to run out — and neighbouring
rays run out in different places, which is exactly what salt-and-pepper on a fractal surface
*is*. Stopping when the estimate falls below **what the pixel actually covers** asks each ray
for the precision its pixel can show, and the normal is sampled at that same width so it is
not averaging detail the pixel cannot display.

It is also cheaper — the far half of the object stops sooner — so the quality fix and the cost
fix were the same line.

## Ten clocks, and they are prime — checked, not asserted

This is the answer to "not boring after fifteen seconds", and it is structural rather than
decorative.

| clock | period | what moves |
|---|---|---|
| `morphPeriod` | **19 s** | the fold rotation — the segmentation, always turning |
| `hueTurn` | **37 s** | the colour lap, two hues travelling in opposition |
| `scalePeriod` | **47 s** | the chain's magnification: the density of incident |
| `lightCycle` | **53 s** | *which* light is the key — the frame is lit from elsewhere |
| `characterPeriod` | **73 s** | reef/skeleton → bulb → back |
| `seedPeriod` | **113 s** | the seed offset's drift: the object's topology |
| `voidPeriod` | **89 s** | the shells opening: negative space *inside* the sculpture |
| `posePeriod` | **61 s** | the object turns on its own axis — the angles you see it from |
| `pushPeriod` | **43 s** | the object swims *toward* the frame and back |
| `aimPeriod` | **67 s** | which part of it the frame is centred on when it is close |

Those are ten primes (plus `orbitPeriod` at 96, coprime with all of them), so the combined
state repeats on their product and no viewer ever sees a cycle land.

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
| `foldTravel` | `lvl1.level` rank | the creases open and close — an amplitude on a morph already running |
| `specular` | `lvl1.high` rank | the wetness follows the top end |
| `saturation` | `lvl1.centroid` rank | spectral brightness opens the chroma |
| `openness` | `lvl1.level` rank | **how far open the chain sits** — see below |
| the camera | **nothing** | the orbit is the stable reference the morph is legible against |

Every retained value is the lane's **driven mean**, not its floor and not its peak: the value
that stands when no drive arrives has to look like the piece, because that is the picture the
thumbnail shows.

### Looseness is driven; identity still is not

The owner asked the shape to be *"sometimes more loose, sometimes less"* and to *"react to the
energy and the song"*. The ruling that nothing audio-driven may touch the object's **identity**
stands — if the music decided what the object *is*, silence would be a different object. But
"looser" is not a different object, it is the same object breathing, and the box fold's limit
and the sphere fold's inner radius were already travelling on their own clocks. `openness`
widens the region of that same parameter space the piece visits.

⚑ **§V914 is satisfied here by arithmetic rather than by a measurement anyone has to redo.**
The lane is `0.25 + 0.5 × rank` on a rank that rests at its middle, so it retains **exactly
0.5**, and the shader reads `openness − 0.5`. The rest picture is therefore *byte-identical*
to the picture this file would render with the lane deleted — which the claims assert, both
halves: zero differing pixels at rest, and a measurably different shape when it is driven to
the top of its range.

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
