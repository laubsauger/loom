# E59 — Vault

The same instrument as [E58 Alembic](./E58-Alembic.md) at `twist` 0.5, where the fold stops being fibre and turns architectural: flat planes, corners, a corridor going somewhere, lit warm from around a bend with cold slate everywhere else.

## This file defers to E58

One `customWgsl` node runs the *same shader module* E58 ships — imported, not copied — so the technique, the credit, what the march actually is, why `tanh` is a shoulder rather than a clip, and the argument for the colour term being a `ramp` node all live in **[E58 Alembic](./E58-Alembic.md)**. Read that first. What follows is only what this coordinate does differently.

## Credit

The technique belongs to a family of golfed GLSL pieces by **[@Xor](https://x.com/XorDev)** — *Cauldron*, *Dielectric*, *Archive*, *Coronal* and *Wave*. None of his source is transcribed, here or in E58, and this is not an attempt at any of his frames: *Vault* is a coordinate of **this** shader's own parameter space, found by eye in this repository. E58 carries the long version of that argument, and the crediting line ships inside the WGSL itself.

## What `twist` does, and why it is the whole file

`twist` is the rotation applied to the sample axes between octaves of the fold. The family writes that rotation as a **swizzle** — `p.zxy` — which is exactly 2π⁄3 about the (1, 1, 1) diagonal, and is the only angle a letter permutation can spell. E58 ships 2.0944, which *is* the swizzle. Here it is 0.5.

At 2π⁄3 successive octaves land on axes that share nothing, so their displacements average into isotropic fibre. Near zero they stack on very nearly the **same** axes, and the octaves stop cancelling: the displacement becomes a set of nearly parallel folds, and the picture goes piecewise flat — large regions doing nothing, separated by hard creases. That is a wall, a corner, a corridor.

Measured, because "architectural" is otherwise a word about a screenshot. The picture's normalised gradient has its 99th percentile at **21.2 times its median** — a long tail over a nearly empty middle, which is what piecewise-constant means numerically — and **25.6% of the frame** carries essentially no gradient at all. Put `twist` back to the family's 2.0944 with every other value held and those become 10.1 and 16.7%. The same knob does the same thing from E58's own coordinate (10.96 → 15.6), so this is `twist`'s and not a coincidence of the other six numbers.

## The other knobs, and why they moved with it

- **`warpGain` 1.2** (E58: 1.6). Parallel octaves add rather than cancel, so E58's gain folds the planes back through each other and the corners go.
- **`flare` 0** (E58: −0.15). A straight corridor. E58's negative flare opens the vessel outward with depth, which is a funnel and reads as sky rather than as a room.
- **`wander` 0.15, `coil` 0.3** (E58: 0.4, 0.6). Just enough stray in the vessel's axis that the light source is around a corner instead of straight ahead.
- **`depthFade` 0.9** (E58: 0.3). Pulls the far end down so the corridor has somewhere to go. It is the single knob E58 measured as having the *smallest* effect on its own picture; on this one it is what makes the depth read.

## The ramp

Sodium on slate: warm near-white through amber to rust across the first third, then straight into cold blue-grey and black. One warm source and cold stone — which is what makes a plane read as a **wall** rather than as a bright fold. The gradient is a node, so it is sixteen stops in an editor and not a constant in the shader; that is E58's argument, and four documents shipping one gradient would have wasted it.

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

Motion, through the look instrument's own arithmetic at 192×108 with its 120-frame gaps (§V913 — the recorded row *and* the whole minute, because the row samples two seconds and cannot see anything afterwards). The recorded row reads **0.03153**; the minute averages **0.04690** over 29 gaps (min 0.02714, max 0.07042) and the **last** gap reads **0.06291**, twice the row.

So the baseline understates this file, which is §V913 running the other way from E58's. Nothing settles: the two clocks are E58's, untouched, and neither has a fixed point by construction — which is E58's claim about this shader and is not re-asserted here, because four copies of one test is four tests for one fact.

## The chain

```
palette1(ramp) -> alembic1(customWgsl) -> out1(output)
```

`out1` tone-maps with `none`, for E58's reason: `tanh` has already done that job inside the shader.
