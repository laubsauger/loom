# E61 — Skein

The same instrument as [E58 Alembic](./E58-Alembic.md) with a dense, slow-growing octave stack in place of E58's classic doubling: nine octaves at a lacunarity of 1.25, which come out as long silky ribbons rather than as fibre. The dearest coordinate in the family, and the only one whose cost is above the rest.

## This file defers to E58

One `customWgsl` node runs the *same shader module* E58 ships — imported, not copied — so the technique, the credit, what the march actually is, why `tanh` is a shoulder rather than a clip, and the argument for the colour term being a `ramp` node all live in **[E58 Alembic](./E58-Alembic.md)**. Read that first. What follows is only what this coordinate does differently.

## Credit

The technique belongs to a family of golfed GLSL pieces by **[@Xor](https://x.com/XorDev)** — *Cauldron*, *Dielectric*, *Archive*, *Coronal* and *Wave*. None of his source is transcribed, here or in E58, and this is not an attempt at any of his frames: *Skein* is a coordinate of **this** shader's own parameter space, found by eye in this repository. E58 carries the long version of that argument, and the crediting line ships inside the WGSL itself.

## The stack, and the arithmetic that goes with it

The fold's frequency starts at `baseFreq` and multiplies by `lacunarity` each octave. Two numbers fall out of that and they pull in opposite directions.

The **finest detail** sits at `baseFreq × lacunarity^(octaves−1)`: 3 × 2⁵ = **96** for E58, 1.6 × 1.25⁸ = **9.5** here. Ten times coarser, with half again as many octaves.

The **total displacement** is the sum of `warpGain / f` over the octaves: 1.6 × 0.656 = **1.05** for E58, 1 × 2.705 = **2.71** here. Two and a half times as much warp, from a stack whose terms barely separate in frequency.

That second number is why `warpGain` is 1 rather than E58's 1.6, and it is not a taste knob: at 1.6 the total reaches 4.3, the domain folds back through itself, and the sheets tear into the same fibre this coordinate exists to avoid.

## What the claims measure, and one premise that died

The ribbon is measured as **elongation** — the mean structure-tensor coherence, weighted by local gradient energy, which asks how consistently one direction wins in a small neighbourhood. This file reads **0.547**, the highest of the five looks (Throat 0.351, Snarl 0.382, Rake 0.472, Vault 0.486). Put E58's whole fold back — six octaves, base 3, lacunarity 2, gain 1.6, everything else held — and it falls to **0.339**, below E58's own reading. So the ribbon is this fold's, and the claims file asserts exactly that.

Two things the measurement refused to support, stated because a doc that only reports its wins is not evidence:

- **The coarser top octave is not visible as coarseness.** Ten times lower is real arithmetic, but the frame's horizontal autocorrelation falls below half at a lag of 9 pixels here against 12 with E58's fold — *finer*, not coarser. The dither grain is part of that signal and this instrument cannot separate it.
- **"Nine octaves" is not the cause of the ribbon.** Drop to six and hold everything else and elongation *rises*, to 0.621. Knob by knob, `warpGain` carries most of the effect (0.352 on its own). Nine octaves are what a lacunarity of 1.25 costs to cover any frequency span at all; the ribbon comes from the stack and the gain together, and no single number in it owns the look.

## The ramp

A shot silk: cream through chartreuse into jade and teal. Green because it is the one hue family neither E58 (gold and magenta) nor [E60 Snarl](./E60-Snarl.md) (blue and violet) occupies — and because a broad smooth sheet is where a gradient's *middle* is finally visible. On E58's fibre the ramp reads as edge colour; here it reads across the whole width of a ribbon, which is the best argument in the catalogue for the colour term being a node.

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

The four six-octave files agree to 11% at 720p and to 5.4% at 1080p: **one price**, as predicted. **This file** is the only one that costs more, and it costs the octave ratio — 1.51× at 720p and 1.47× where 9⁄6 is 1.50 — measured directly as well, with E58's own document at nine octaves reading within 2% of Skein's. Read the absolutes with the reference's own offset: the 1080p column is about a quarter high throughout.

Motion, through the look instrument's own arithmetic at 192×108 with its 120-frame gaps (§V913 — the recorded row *and* the whole minute). The recorded row reads **0.25675**, the highest in the family; the minute averages **0.14671** over 29 gaps (min 0.07528, max 0.29574) and the last gap reads 0.14229.

⚠ Read that row as a lively window rather than as this file's pace: it lands near the minute's *maximum* and is 1.75× its mean. That is §V913's warning in the direction nobody expects — a baseline can flatter as easily as it can understate. Nothing settles; the last gap is the mean. The two clocks are E58's, untouched.

## The chain

```
palette1(ramp) -> alembic1(customWgsl) -> out1(output)
```

`out1` tone-maps with `none`, for E58's reason: `tanh` has already done that job inside the shader.
