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

## The inlay is cut, not painted

The channels are subtracted from the distance function itself, so a channel breaks the
silhouette of a column seen edge-on. A decal would not.

Which rows carry writing is an integer hash of the row index and the bay, so the same column
geometry carries a different sentence in every bay — and it is the same figure on every
device and every replay (§V45). Most of the stone is blank: the first version lit two thirds
of the rows and the hall read as a circuit board. An inlay is remarkable because the surface
around it is not.

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

The estimate that shaped the decision to build this was 25–35 ms. It was an estimate, and
nothing had run it. The stages are measured separately and reported as each lands precisely
so that the next number in this table is a fact rather than a forecast.

The resolution is set explicitly on the document rather than inherited, so the piece and its
claims agree about what it was designed for.
