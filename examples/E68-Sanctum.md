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
| the dust density | `lvl1.low` | a rank rests at its middle, so the air **breathes** |

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

The estimate that shaped the decision to build this was 25–35 ms. It was an estimate, and
nothing had run it. The stages are measured separately and reported as each lands precisely
so that the next number in this table is a fact rather than a forecast.

The resolution is set explicitly on the document rather than inherited, so the piece and its
claims agree about what it was designed for.
