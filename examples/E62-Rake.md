# E62 — Rake

The same instrument as [E58 Alembic](./E58-Alembic.md) with marching depth driven hard into the fold's phase: a narrow flared funnel, combed into straight golden rays that all point at the same place.

## This file defers to E58

One `customWgsl` node runs the *same shader module* E58 ships — imported, not copied — so the technique, the credit, what the march actually is, why `tanh` is a shoulder rather than a clip, and the argument for the colour term being a `ramp` node all live in **[E58 Alembic](./E58-Alembic.md)**. Read that first. What follows is only what this coordinate does differently.

## Credit

The technique belongs to a family of golfed GLSL pieces by **[@Xor](https://x.com/XorDev)** — *Cauldron*, *Dielectric*, *Archive*, *Coronal* and *Wave*. None of his source is transcribed, here or in E58, and this is not an attempt at any of his frames: *Rake* is a coordinate of **this** shader's own parameter space, found by eye in this repository. E58 carries the long version of that argument, and the crediting line ships inside the WGSL itself.

## `drift` is depth entering the phase

The fold turns on a phase, and two things feed it: `flow`, which is time, and `drift`, which is **how much of the march's own depth goes in**. E58 runs `drift` at 1, where it is a gentle shear that gives the fibres a wake. Here it is 2.4, and it is the dominant term: the fold now turns over faster along a ray than it does across the frame, so every structure is drawn out along its own depth — and a direction in depth, projected onto the screen, is a line through the vanishing point. That is a comb.

Measured as the alignment it predicts: the share of the frame's gradient energy that runs **across** the rays from the frame centre, which is what streaks lying *along* them produce. This file reads **0.600**; with `drift` cut to zero and nothing else touched it reads **0.532**, and the sweep between them is monotone (0.532, 0.545, 0.548, 0.561, 0.600 at `drift` 0, 0.5, 1, 1.6, 2.4).

The control is what makes that a claim about this document. **The same knob on E58's own coordinate moves the alignment the other way** — 0.539 at `drift` 0, 0.515 at 1, 0.520 at 2.4 — so the comb is not something `drift` does to any picture. It is what `drift` does to *this* vessel.

## The vessel is there to let the comb be seen

- **`wander` 0, `coil` 0** (E58: 0.4, 0.6). The vessel's axis sits exactly on the ray's, so there is one vanishing point for the rays to point at rather than a wandering axis with no centre.
- **`flare` 0.28** (E58: −0.15). Positive, so the tube *closes* with depth into a narrow funnel where E58's opens outward.
- **`radius` 0.9** (E58: 2). The wall comes close.
- **`looseness` 4** (E58: 3). Softens the step, so the rays are combed rather than ridged.
- **`exposure` 0.0035** (E58: 0.02). An axisymmetric funnel puts far more of the frame near the wall at once than E58's wandering throat does; at E58's gain the whole picture sits on the `tanh` shoulder and the combing is lost in white.

## The ramp

Deliberately narrow: warm white, straw, amber, umber, near-black — one hue and its values, where every other file in the family swings through several. That is a decision the claim forces. What this document asserts is a **direction**, and a gradient that crossed hues would have the eye reading colour boundaries as structure. One hue, and every line you see is the comb.

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

Motion, through the look instrument's own arithmetic at 192×108 with its 120-frame gaps (§V913 — the recorded row *and* the whole minute). The recorded row reads **0.11484**; the minute averages **0.08026** over 29 gaps (min 0.02691, max 0.16535) and the last gap reads 0.04195.

⚑ The per-frame pace sampled at three instants — 5.83e-2, 2.72e-2, 1.86e-2 at the start, middle and end of the minute — *looks* like a decay and is not one, which is the exact mistake §V923 exists to catch. The full series of 29 gaps runs 0.115, 0.097, 0.027, 0.054, 0.091 … 0.160, 0.165 … 0.103, 0.097, 0.100, 0.042: the maximum is at 34 seconds and the minimum at 6. It swings by a factor of six and trends nowhere. Nothing here can settle by construction — the vessel is measured in eye-relative coordinates, so no term grows with the clock — and the series is what says so rather than the argument.

## The chain

```
palette1(ramp) -> alembic1(customWgsl) -> out1(output)
```

`out1` tone-maps with `none`, for E58's reason: `tanh` has already done that job inside the shader.
