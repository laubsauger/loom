# E68 — Sanctum

A slow walk down the nave of a buried temple. Eroded stone, a colonnade receding into the
dark, a doorway at the far end that is the only cold light in the picture, and inlay
channels cut into the columns that are still powered after whatever happened here.

This is the showcase the owner asked for — *"triple AAA alien technology / temple visuals,
with proper pbr materials, reflections, specular, structured textures, lights, and camera
moves, details in scene driven by audio"* — and it is a **deliberate outlier** in the
catalogue rather than a budget failure. The feasibility read offered three directions and
recommended the rasterised one; the owner chose the raymarched one with its estimated price
in front of them, then removed the ceiling entirely: *"make it look right."*

## What it is made of

One `customWgsl` pass holds the whole thing: a full-screen raymarcher, in E55/E57/E67's
lane rather than the scene node family's.

```
sky1(solid) ─► temple1(customWgsl: the nave marcher) ─► out1(output)
```

## The hall costs about what one pillar costs

The colonnade is **domain repetition** — `p.z` folded into a single bay and `p.x` mirrored
about the nave's axis — so the marcher answers "how far to the nearest column" once, however
many the eye can see. There are roughly thirty columns in frame and the distance function
evaluates one.

That is the single structural decision that makes a temple affordable at all, and it is also
why the composition is a nave rather than a courtyard: the cost decision and the art
direction here are the same decision.

## Four shapes cannot describe a building

The first version of this hall was a floor, one repeated column, a flat ceiling and a far
wall. It read as a corridor, and the reason is arithmetic rather than taste: **four shapes
is not a vocabulary**.

The fix is the same finding the colonnade is built on, pushed further. Because the hall is
domain-repeated, **adding a kind is nearly free where adding a count is not** — a
thirty-first column costs nothing and a *capital* costs one box. So the hall now has
plinths, fillet courses, capitals in two members, an architrave running the length of each
colonnade, transverse ribs across the vault, three steps and a dais at the far end, and a
fifth of the bays fallen with a block of what fell lying on the floor.

The whole vocabulary costs less than the erosion noise that weathers it.

One shape is worth more than the rest of them together: **the plinth**. A cylinder that
meets the floor with no base reads as a pipe pushed through it, and no amount of weathering
on the shaft fixes that — the eye is asking where the load goes.

⚑ **The ribs came down to the floor and filled half the frame.** A circle centred at the
springing is an arch in its *top* half; the bottom half keeps curving inward, across the
nave at head height. The first render had a two-metre stone hoop passing through the
camera. The clip is one `max` — but the failure is the general one: a shape defined by a
whole primitive is rarely the shape you wanted.

## The floor felt like mud because it had nothing under it

It was the plane `y = 0` with a reflection on it. A mirror with no material underneath is
not a polished floor, it is a puddle, which is exactly how it read.

Three facts make it stone: **slabs** at a size a person could lift, **joints** cut deep
enough to catch light, and **settlement** — each slab sits at a slightly different height,
because a floor that is perfectly flat is a floor nobody has walked on for a thousand years.

The result is scaled by 0.7 before it is returned, and that is not a fudge. A height field
added to a plane's distance is no longer a distance: its gradient exceeds one wherever the
field is steep, and a marcher that trusts an overestimate steps *through* the surface. That
puts holes in the floor at grazing angles, which is precisely where this floor is seen.

## The bedding joints are the difference between age and dirt

Banding the erosion in height (below) stopped the stone reading as wax. It did not make it
read as *stone*, and the reason is that **noise does not know what it is sitting on**.

Real decay is not applied to a structure, it follows one. Water sits in the horizontal joint
between two courses and that joint is the first thing to open, so a weathered wall is a
stack of blocks with the lines between them eaten back. One `fract` at the mason's course
pitch, cut as a real groove so it breaks the silhouette. It is the cheapest shape in the
file and it is doing more for "eroded stone" than the two octaves of noise above it.

## Continuous was right; uniform is what was wrong

The rule that produced the previous version was *"a mark that stops and starts in blocks is
a glyph; a line that runs the length of a structure is a conduit"*. Taken literally it
produces a strip of even width and even brightness running the full height of every column
— which is **neon tape applied to a column**, not something that is part of one.

A conduit varies **along its run** while staying continuous, and it wants four separate
kinds of variation: width swells and narrows; brightness dips; the line gutters out and
comes back; and light **pools at the junctions** where a conduit crosses a member, because
that is the one place a viewer can see these lines are connected to each other rather than
merely parallel.

All four come from a **one-dimensional** value noise along the run — two hashes, against the
eight a three-dimensional lattice would cost. A conduit varies along one axis, so paying for
two dimensions nobody sees is paying for nothing. It runs inside the distance function, and
the distance function runs at every step of every ray and six more times per normal.

⚑ **And a real bug fell out of writing it.** The inlay indexed bays as `floor(p.z / bay)`
while the columns are folded with `fract(p.z / bay + 0.5)` — so the column centres sit
exactly where the inlay's bay index changes. **Every column in the hall was split down its
middle**, carrying one circuit on its near half and a different one on its far half. It was
invisible because both halves are plausible circuits and the seam runs down a shadowed axis.

## The vault is broken open, and that is where the drama is

Every light in this hall came from inside it, at one temperature, along one axis. That is
the whole of "not dramatic enough".

A hall that has been buried has been *crushed*, so a share of the bays have a hole in the
roof with a shaft of daylight standing in it. One hole and one hash, and it buys three
things at once: a light from **above**, which is the one direction nothing was coming from;
a second temperature with a **source in shot** rather than a wash; and a vertical to answer
the columns with.

The shaft **is not scaled by the dust density**, and the first version was. Everything else
in the volumetric is light scattered by what hangs in the hall, so `dust` is the right gain
for it — but a beam through a hole in the roof is set by what is *outside*. Multiplying it
by a 0.032 density made it invisible in the air while it was still bright on the floor, and
a beam you can see land but not see travel is a fog decal.

It also **lands**: same hash, same hole, read at the surface, pointing straight down. So it
rakes the horizontal stone — floor, plinth tops, rubble, the steps — and leaves the vertical
faces to the inlay. That separation is doing as much for the picture as the shaft itself.

## The key light had no falloff, and that is what made it look like a render

A directional light with no reach lights every surface facing the camera equally, all the
way down the hall, so every column arrived at the same pale blue-grey however far away it
was. That is frontal flat-lighting, and it is most of what makes a picture read as a viewer
rather than a place. It is also false: light from a doorway forty metres away does not reach
the near end of a building undiminished.

With the reach in, the piece has **depth as colour**. Near the eye the only light is the
inlay's own, so the near hall is lit by what is in it; far down the nave the cold key takes
over. Two zones the eye can read distance from, out of one `smoothstep`.

## Two hues in opposition, and where the second one actually belongs

The first morph moved the conduits along a sixth of the wheel. It worked and it was not
enough: a single hue drifting has nothing to be measured against, so nothing in the frame
*changes* — it is one colour, slightly different.

The first attempt at a second hue put it on a **directional warm fill**, and the render said
exactly what is wrong with that: every surface facing one way acquired a flat wash, measured
on the rubble at **(70, 42, 57)** — blue over green, a mauve slab of painted stone. **A wash
with no source in frame cannot read as light.**

So the second colour lives in two places that both have somewhere to come from: the
**daylight** in the breaches, and the **junctions** of the network, which are small, bright,
scattered at every depth, and already the most interesting points on a column. The two
temperatures are now interleaved through the hall at the scale of a detail rather than split
across it at the scale of a wall.

And the low warm rake that remains **does not morph**. Rotating an orange about the
luminance axis moves it toward magenta; the morph belongs on the junctions, where the colour
is the point. Two uses of one colour do not have to move together.

## The stone is eaten in bands, and that is what stops it looking like wax

The first cut displaced the stone with plain fbm noise, and it read as **melted candle** —
lobed silhouettes, drips down the columns. Higher frequency and lower amplitude helped and
did not fix it. What fixed it was one extra noise on `p.y` alone, so the damage varies in
height bands: soft courses eaten, hard courses left standing, which is what weathering
actually does to a pillar. One lookup, not an extra octave.

The displacement only ever **removes** material, so an eroded edge is bitten rather than
inflated.

## The first inlay made this a flooded crypt, and the fix was not more detail

The version that shipped through stage 4 laid rows of hashed marks at regular heights:
rectangular, warm, evenly spaced, human-scaled. Every one of those properties says
**window**, and a hall of lit windows in eroded stone is a ruin with people in it. The brief
asked for alien technology, and the stone alone cannot say that — eroded rock reads "old",
never "made by something else".

Two changes carry it, and neither adds detail:

**The channels follow the geometry instead of sitting on it.** Veins run the full height of
a column, spaced around its circumference, crossed by rings at intervals. They are
**continuous**, which is what separates circuitry from writing: a mark that stops and starts
in blocks is a glyph, a line that runs the length of a structure is a conduit.

**The light is not on the blackbody curve.** Amber at that temperature is fire, and fire is
human — a torch, a forge, a lamp. A cyan-green with no red in it cannot be produced by
anything burning, and the eye knows that without being told.

It is also *cheaper*: 4.73 ms against the amber version's 5.51, because a vein is one angular
test where a glyph was three hashes.

## The inlay is cut, not painted

The channels are subtracted from the distance function itself, so a channel breaks the
silhouette of a column seen edge-on. A decal would not.

Which veins are live is an integer hash of the vein index, the bay and the side, so a column
carries a different circuit in every bay — and the same one on every device and every replay
(§V45). A dead conduit is still a channel cut in the stone, which is what keeps the
architecture reading as built rather than as decorated.

**Procedural, not the `text` node.** §V403: the text node renders black headless, so glyph
rows made of it would be invisible in every thumbnail, every claim and every headless render
— which is to say in every picture anything automated ever sees.

## The glow is a coarser field, not a blurred copy

Getting light to leave the channels took three attempts, and the two failures are the
interesting part.

**Sampling along the surface normal** moves off the surface into the air, where the field is
whatever sits directly underneath — so a lit point read lit, a dark point read dark, and the
"spill" was the channel's own value again.

**Sampling four offsets in the tangent plane** is the right direction to move and still the
wrong thing to sample: the glyph hash is keyed on cells about 0.2 m across, so a 0.12 m tap
usually lands in the same cell and returns the same value. A blur whose radius is smaller
than its subject is not a blur.

What works is not a blur at all. It is a **separate, wider field** sharing the channel's
structure but not its detail — the same row test, the same coarse mark, a soft window
several times the channel's width, and the fine stroke hash dropped entirely. It answers
"is there writing near here", which is what a glow is. It is also cheaper than the version
that did not work.

## The dust is what makes the inlay a light

Everything before stage 3 showed light only where it **landed**. A buried hall has air in
it, and air is what lets you see a beam rather than infer one. Twenty-two samples along the
primary ray, carrying the inlay's glow near the columns and a cold shaft through the doorway
at the far end. Dust settles, so density thins with height — that is what puts the shaft's
edge where the eye expects it and keeps the vault from fogging over.

**The volume reads a smoother field than the surface does, and that is not a shortcut.** The
first version sampled the same spill field the stone uses, and the result was salt and
pepper: that field is hash-gated and so nearly binary, and twenty-two sparse samples through
a binary volume is a speckle generator rather than a fog. The second version smoothed it and
painted continuous horizontal bands the full width of the hall, because a row window is a
function of height alone. What works keeps the row-and-bay gate — so the air glows where
there is writing and not in bays without any — and drops the fine glyph and stroke hashes,
which are what made it speckle.

The march's start offset is dithered by a hash of the **pixel**, fixed across frames. A
fixed step count through a volume bands; jittering removes the bands, and a jitter that
changed every frame would turn them into boiling noise instead. The dither is grain, never
flicker.

## The floor is the second march, and it is the only expensive idea here

Everything else in this piece is a lookup. The reflection is a whole second ray, and it is
what the original 25–35 ms estimate was really pricing. It runs on a third of the primary's
steps, over a shorter reach, with a distance fade — not a corner cut but what a reflection
can afford to be, because the eye checks a silhouette against the thing above it and
forgives everything else.

**A missed reflected ray is not black.** Most floor pixels reflect a *gap* between columns,
so "nothing hit" is the common case rather than the edge one; returning zero there made the
first version invisible. A ray that leaves the colonnade is looking at the lit end of the
hall, and a wet floor shows exactly that.

`polish` at 0 removes the march entirely rather than multiplying its result by zero — a
branch the whole wavefront takes together on a flat floor, and the difference between "this
idea is off" and "this idea is free".

## ⚑ Every still before stage 4 was upside down

The camera basis used `cross(right, forward)` for its up vector, which points **down**. The
image was vertically flipped from the first line of this shader, and it survived three
stages and a dozen renders because a symmetric hall of eroded stone looks almost the same
either way up in the dark: the vault and the floor are the same material, and neither had
anything on it that says which way gravity goes.

What exposed it was the floor reflection appearing along the **top** edge of the frame. The
reflection was correct; the camera was not — and the bug was only visible once something in
the picture knew which surface it belonged to.

## The audio lands rather than breathes

One `AudioAnalysis` instance, two bags: `lvl1` for the ranked levels, `hit1` for the drum
counts. A deterministic pattern plays at index 0 so the file is reactive on open with no
track at all, and a real file is one drop away on index 1.

| what | channel | why that one |
| --- | --- | --- |
| the conduits' emission | `hit1.kickCount` | a count is 1 on the frame the drum lands and 0 between, so the conduits **fire** |
| the junction pools | `hit1.snareCount` | a backbeat on the **finest** structure in the hall, not on the brightest object in frame |
| how many ring members are lit | `hit1.hatCount` | the finest event in a kit ticking the finest structure |
| the primary light's strength | `lvl1.lowMid` | a rank rests at its middle, so the hall's own light **swells** |
| the doorway's beam | `lvl1.high` | a continuous property on a continuous channel |
| the counter-light | `lvl1.highMid` | the frame's second colour breathes where the conduits land |
| the dust density | `lvl1.low` | a rank rests at its middle, so the air **breathes** |
| the exposure | `lvl1.low` | dynamic range **in time**: a quiet passage sits down, a loud one up |

### "Too blinky blinky" was two numbers, not a curve

The kick's gain came down from 1.5 to **0.7** and the hit decay went up from 250 ms to
**420 ms**. A count is a *step* — 1 on the frame the drum lands, 0 between — so the only
things that decide whether a viewer reads it as a swell or as a strobe are how far it
travels and how long it takes to come back. 1.5 on top of a rest of 0.85 is a light that
nearly triples in one frame, and that is a strobe however you shape it.

The snare also moved **off** the doorway's beam and onto the junctions. A backbeat landing on
the brightest object in frame is the same complaint again; landing on the pools where
conduits cross members is the same event read on the finest structure in the hall.

A consequence worth stating: at 112 bpm a beat is 536 ms and the decay is now 420 ms, so
**the lane no longer returns to zero between kicks** — the next one arrives while the last
is still visible. That is what a light that gutters does. The claim in
`sanctum-claims.gpu.test.ts` asserts that shape (a sharp attack, a monotone fall) rather
than a return to rest, and it is red-verified in both directions: a flat lane and a
continuous rank each fail it.

That split is the whole finding of the rows before this one: a percentile cannot spread a
tie, so a count read through a rank rests at its mid and a beat becomes a permanent
half-lit nothing. Continuous properties on ranks, drums on counts.

**Nothing drives the camera.** The dolly *is* the piece's pace, and modulating it makes the
walk a limp rather than a groove — a refusal inherited from E57, where it was measured
rather than argued.

With no track the counts rest at zero and the rank at its middle, so the retained values
render the shipped picture exactly — which matters because every thumbnail, every headless
render and every first open has no audio.

## What this file does not have

It is a marcher, so it owns its own shading. That means **none of the scene family's PBR material** — none of the
GGX/Smith BRDF or the prefiltered environment that landed the same night — because those
belong to the scene node family and a full-screen `customWgsl` never touches them. The
renderer's flagship material ships in the smaller PBR example that follows this one, not in
the temple.

It also **cannot MSAA**. That is free on the rasterised path and unavailable here, which is
why the anti-aliasing is FXAA rather than the 1.69× supersample the owner refused on E67.

## The cost, stage by stage

Each idea was costed before the next went in, at 1280×720, measured as GPU extent — trimmed
means over 240 of 300 frames rather than medians, because Dawn quantizes timestamps to
65 536 ns and a median lands exactly on the quantum.

| stage | what it adds | extent |
| --- | --- | --- |
| 1 | the bare march: stone, erosion, one key | **2.94 ms** |
| 2 | the inlay, its channels and its spill | **3.57 ms** |
| 3 | the dust: light visible in the air, and the shaft | **3.77 ms** |
| 4 | the floor reflection: a second march | **5.51 ms** |
| — | the inlay rebuilt as conduits (below) | **4.73 ms** |
| 5 | the audio, on the shipped document | **4.76 ms** |
| 6 | the architecture, the ruin, the breaches and the daylight | **8.85 / 9.01 ms** |

The last row is the **shipped document** rather than the shader in a test rig, so it
carries the audio graph, the component instance and the real node chain. The audio costs
nothing measurable on the GPU, which is what you would expect: the drive changes uniform
values and the value graph runs on the CPU.

**The estimate that shaped the decision to build this was 25–35 ms.** It was an estimate,
and nothing had ever run it — the finished piece, with every idea in, is **4.76 ms**. The
stages are measured separately and reported as each lands precisely so that the next number
in this table is a fact rather than a forecast.

**Stage 6 is quoted against a control, and the control is why it is quoted at all.** An
earlier attempt to measure this piece read ~9.9 ms — but E57, *unchanged since it shipped*,
read 8.0 ms against its documented 4.1 on the same runs, and the machine was carrying a load
average of 7.2. An unchanged control that doubles means the number is not attributable to
anything, and that run was deliberately not reported. The stage 6 figures above were taken
on a quiet machine (load 1.9) in the same session as a control run of **E57 at 3.655 ms**
against its documented 4.1 — at or below its own datum, which is what makes E68's number
this row's rather than the machine's. Two independent runs, 8.848 and 9.009 ms.

The piece therefore costs **1.9× what it did before this pass**, for the architectural
vocabulary, the ruin, the broken vaults and their daylight, the slab floor, the bedding
joints, the conduits' run-length variation, and eight volumetric samples more per ray. The
owner's budget note was *"we're at 7 ms so we can go nuts"*; at 1280×720 this is about
113 fps.

Every figure here is a trimmed mean over 240 of 300 frames after a 40-frame warm-up, and
every run is checked for **dropped GPU spans** — consecutive renders never yield the
event-loop turn `mapAsync` needs, so a probe that does not await can silently measure a
fraction of its passes. All runs behind this table reported a complete set (340 of 340).

The resolution is set explicitly on the document rather than inherited, so the piece and its
claims agree about what it was designed for.
