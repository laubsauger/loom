# E60 — Snarl

The same instrument as [E58 Alembic](./E58-Alembic.md) with its vessel opened and its axis corkscrewing wide: a cold filament storm with no throat in it at all, where E58 is a dark eye with fibre wound round it.

## This file defers to E58

One `customWgsl` node runs the *same shader module* E58 ships — imported, not copied — so the technique, the credit, what the march actually is, why `tanh` is a shoulder rather than a clip, and the argument for the colour term being a `ramp` node all live in **[E58 Alembic](./E58-Alembic.md)**. Read that first. What follows is only what this coordinate does differently.

## Credit, and the name

The technique belongs to a family of golfed GLSL pieces by **[@Xor](https://x.com/XorDev)** — *Cauldron*, *Dielectric*, *Archive*, *Coronal* and *Wave*. None of his source is transcribed, here or in E58, and this is not an attempt at any of his frames: *Snarl* is a coordinate of **this** shader's own parameter space, found by eye in this repository.

E58's table called this row *Corona*, which was already the name of [E31](./E31-Corona.md) — a shipped example, and the reel's opening shot. Two catalogue entries with one name is not a thing to leave standing, so it is *Snarl* here and in E58's table. The pairing with [E61 Skein](./E61-Skein.md) is deliberate: a skein is thread wound in order and a snarl is the same thread lost, and the two files are the two ends of what this fold can do to a filament.

## The throat is gone, and that is the claim

E58 marches down a tube. Its wall is at `radius` 2, its axis strays `wander` 0.4 from the ray's and winds at `coil` 0.6, and the result is a **hole** — a region near the frame centre that no ray grazes, which is the dark eye the file is named for.

Here `wander` is 1.1, nearly the vessel's own radius, and `coil` 1.4 winds that stray more than twice as fast with depth. `radius` comes in to 1.4 and `flare` 0 stops the tube tapering. There is now no depth at which the wall is far from every ray at once, so there is nowhere for a hole to be.

Measured as the thing the eye actually notices: the mean luma of a disc at the centre of the frame, over the mean of the whole frame. E58 Throat reads **0.55** — the middle is half as bright as the picture, which is a hole. This file reads **2.11**: the middle is twice as bright as the picture, which is a storm. Put E58's vessel back (`wander` 0.4, `coil` 0.6, `radius` 2) with everything else here held and it falls to 0.69 — the hole reappears, so it is the vessel and not the palette or the exposure.

## The other knobs

- **`looseness` 5** (E58: 3). Divides the estimate, so the steps near the wall are smaller and there are more of them: soft, numerous filaments instead of hard ones. Deeper *and* dearer.
- **`depthFade` 0.15** (E58: 0.3). Far samples keep their weight, so the storm has depth in it rather than a near shell over black.
- **`exposure` 0.012** (E58: 0.02). With no hole in the frame there is a great deal more to accumulate, and at E58's gain the whole picture sits on the `tanh` shoulder.

## The ramp

Cold, and that is half the difference from E58. White through pale cyan and azure into indigo and violet-black. Gold on this geometry reads as fire; the cold ramp is what makes the same filaments read as a discharge. The gradient is a node — sixteen stops in an editor, not a constant in the shader — which is E58's argument, and four documents shipping one gradient would have wasted it.

## Cost and motion

Dawn/Metal, whole graph, the alternating instrument E58's doc describes, at sixteen rounds. §V929 asks for two references of different cost and both near record; that could not be met on this machine, so the block is certified from the **inside** instead, which turns out to be stronger. E58, E59, E60 and E62 all march 72 steps at 6 octaves — the arithmetic says they *must* cost the same — so their spread inside a block is that block's error bar.

| | 1280×720 | 1920×1080 |
| --- | --- | --- |
| E13 Prism (the reference) | 2.60 (recorded 2.8) | 4.53 (recorded 3.6) |
| E58 Alembic | 6.36 | 17.17 |
| **E59 Vault** | **6.85** | **16.74** |
| **E60 Snarl** | **6.30** | **17.10** |
| **E61 Skein** | **9.68** | **25.16** |
| **E62 Rake** | **6.19** | **17.65** |

The four six-octave files agree to 11% at 720p and to 5.4% at 1080p: **one price**, as predicted. [E61 Skein](./E61-Skein.md) is the only one that costs more, and it costs the octave ratio — 1.51× at 720p and 1.47× where 9⁄6 is 1.50 — measured directly as well, with E58's own document at nine octaves reading within 2% of Skein's. Read the absolutes with the reference's own offset: the 1080p column is about a quarter high throughout.

Motion, through the look instrument's own arithmetic at 192×108 with its 120-frame gaps (§V913 — the recorded row *and* the whole minute). The recorded row reads **0.13296**; the minute averages **0.13024** over 29 gaps (min 0.08427, max 0.16106) and the last gap reads 0.12283.

The steadiest file of the family — the row lands on the minute's mean to 2% — and twice E58's motion, which is what an open vessel with no still centre in it looks like. The two clocks are E58's, untouched, so "two clocks and no third" stays E58's claim about this shader rather than being re-asserted four times.

## The chain

```
palette1(ramp) -> alembic1(customWgsl) -> out1(output)
```

`out1` tone-maps with `none`, for E58's reason: `tanh` has already done that job inside the shader.
