# E58 — Alembic

A volumetric march through a domain-warped vessel: fibres of light braided around a dark throat, streaming toward you and never arriving. One `customWgsl` pass does all of it, a `ramp` node supplies every colour in it, and the whole picture is one technique — the same technique five times over, which is the point of the file.

## Credit

The technique comes from a family of golfed GLSL pieces by **[@Xor](https://x.com/XorDev)** — *Cauldron*, *Dielectric*, *Archive*, *Coronal* and *Wave*. Four of the five differ only in their distance estimate and their colour term. What they share, spelled out of the golf dialect rather than quoted from it, is a loop that doubles a frequency and displaces the sample point by a sine of a rotated copy of itself:

```
f = k;  repeat n times:  p += sin(rotate(p) * f + phase) / f,  f *= 2
```

an **octave-doubling domain warp**, under a march that accumulates depth from a cheap non-Euclidean estimate and tone-maps the sum with `tanh`.

None of that is ownable: iterated `sin` domain warping, an accumulating pseudo-distance march and `tanh` tone-mapping are each older than any of the five. His particular golfed source *is* his, and none of it is transcribed here — not the expressions, not the colour terms, not the constants. This file is the **instrument** those pictures are made on, written from the technique, and it deliberately does not try to reproduce any of his five frames: chasing an exact picture is precisely what pushes a reimplementation back into copying an expression. The five looks below are five coordinates of *this* shader's parameter space, found by eye in this repository.

## One example, not five, and why

Five near-identical documents would be five catalogue slots for one idea, four copies of the same prose to keep in step, and five thumbnails of the same technique. Worse, it would hide the thing a reader should actually take away, which is that these are **one instrument at five settings**. So the family is one shader whose parameters *are* the axes that separate the golfs — how many octaves, how fast the frequency grows, how far each one pushes, what shape the march accumulates against, where the colour comes from — and the five looks are a table you can type in. Every knob in that table is continuous. There is no preset selector, because a preset selector would have made four of the five looks unreachable by hand, which is the opposite of the point.

## What the march actually is

A sphere trace steps by the distance to the nearest surface and **stops** at a hit. This one marches through and never stops. At every step it takes a cheap estimate `d` of how far the wall is, steps by it, and adds `colour / d` to a running sum. Where the estimate is small the step is small **and** the contribution is large, so the ray lingers and glows exactly where it grazes the surface.

That makes it a density integral rather than a lit solid, and it is why an estimate that is only roughly a distance — `abs(length(p.xy) − radius)`, with no Lipschitz bound anywhere near it — is not merely tolerable but is the whole trick. A wrong distance in a sphere trace is an artefact. Here it is a shape.

Three consequences that read as bugs until you know them:

- **`minStep` is the brightness of the core**, not a quality knob. It is a floor under the step, so it caps `colour / d`.
- **`looseness` divides the estimate.** Larger means smaller steps, more of them near the wall, a softer and brighter fibre — deeper *and* slower.
- **The sum has no upper bound before `tanh`,** which is why it needs one. `tanh` per channel saturates toward white without ever producing the flat clipped plateau a `clamp` would, and that is what keeps a hundred divisions by a number near zero looking like light instead of like an overflow.

## The warp, and the one thing here that is not the family's

The golfs rotate the sample axes with a **swizzle** — `p.zxy` — which is exactly a 120° rotation about the (1, 1, 1) diagonal, and is the only rotation a swizzle can spell. `spin()` does that rotation for any angle, so `twist` is a continuous knob whose value 2.0944 (2π⁄3) *is* the swizzle the technique is normally written with.

That is an axis the family never had, and it is not decoration: at `twist` 0 the octaves stack on the same axes and the fold turns **architectural** — flat planes, corners, a corridor — while near 2π⁄3 it is isotropic fibre. Everything between is a sheared weave nobody gets to see when the rotation is a letter permutation. Two of the five looks below live at low `twist`, which is the argument for the knob.

Amplitude is `warpGain / f` against frequency `f` — the 1/f the golfs get for free by writing `sin(p*d)/d` with the same `d` on both sides — so `lacunarity` 2 with `warpGain` 1 is the classic doubling, and `lacunarity` 1.25 is a much denser stack that has to be paid for with fewer octaves.

## The colour term is a node

Every one of the five golfs ends with a colour expression frozen into its source. That is exactly T880's complaint about burying a picture in a custom shader: the art direction is in the code, so there is nothing to turn.

This shader carries **no palette at all**. It samples its connected texture as a one-dimensional lookup, and the thing connected is a `ramp` — sixteen stops, a gradient editor, live. The colour term of this family is a control surface in the graph. What is left in the shader is only *where* in that gradient a sample lands: `paletteAxis` is the direction hue runs in through the warped volume (the family's `p.y`, made into an axis you can point), `paletteScale` how many times the ramp repeats along it, `paletteBias` where it starts. The read ping-pongs rather than wrapping, so a gradient may repeat as often as you like and never draw the seam a `fract` would leave where its two ends meet.

The claims measure this as an identity rather than an impression: **feed the shader a flat grey gradient and every pixel comes back grey, to the byte** — 0 of 57 600 pixels carry any hue, because nothing else in the accumulation is coloured. Luminance is not in the lookup either; the accumulation supplies that, and `tanh` whitens whatever burns hardest, which is why the fibres' cores go pale while their skirts keep the ramp's colour.

## Five looks

Every row is a set of overrides on `alembic1`, on the shipped ramp, at the shipped everything-else. **The claims file parses this table out of this document**, renders all four, and asserts each is far from the shipped picture *and* from every other row — and it refuses a row that names a parameter `alembic1` does not have. So the table is a gate rather than a promise, and a typo here reddens the suite instead of misleading a reader.

| look | what it is | overrides |
| --- | --- | --- |
| **Throat** | as shipped: a corona of gold and magenta fibre around a dark eye | — |
| **Vault** | the fold goes architectural — flat planes, corners, a cavern lit from around a bend | `twist 0.5, warpGain 1.2, flare 0, wander 0.15, coil 0.3, exposure 0.014, depthFade 0.9` |
| **Corona** | the vessel opens and its axis corkscrews wide: a filament storm, no throat | `flare 0, wander 1.1, coil 1.4, looseness 5, exposure 0.012, depthFade 0.15, radius 1.4` |
| **Skein** | a dense 1.25 octave stack: long silky ribbons instead of fibre | `lacunarity 1.25, octaves 9, baseFreq 1.6, warpGain 1, exposure 0.02` |
| **Rake** | a narrow flared funnel with depth driven hard into the phase: combed golden rays | `radius 0.9, flare 0.28, wander 0, coil 0, drift 2.4, exposure 0.006, looseness 4` |

## Cost

Dawn/Metal, whole graph, alternating short runs at two frame counts and keeping the minimum of each cell (T1156's instrument, reused). **The calibration is E13 Prism**: if a block does not reproduce E13's recorded 2.8 ms at 720p, that block was measuring the machine and not the file, and this one is the only block of the evening that did.

| example | 1280×720 |
| --- | --- |
| **E13 Prism** (the datum) | **2.81 ms** (recorded 2.8) |
| E57 Forest | 3.67 ms (recorded 3.3) |
| **E58 Alembic** (this file) | **8.38 ms** |
| E55 Reactor | 13.5 ms (T1156's figure; not re-measured here) |

So this file is 3.0× E13 and 2.3× E57 at the resolution it ships at, and it sits between Forest and Reactor. E57's row reads 11% over its recorded value even in the good block, which means there was still a little contention and 8.38 is an **upper bound** rather than a cost.

**1080p could not be measured in a calibrated window.** Every attempt ran against a peer session's twelve-worker suite at load averages between 4 and 39, and E13 came back anywhere from 3.9 to 29 ms against its recorded 3.6. The lowest reading this file produced at 1080p was 20.7 ms in a block where E13 read 4.05 — so ~20 ms is a bound, not a number, and the honest expectation is around 2.25× the 720p figure, because almost everything here is per-pixel.

The two levers are `steps` and `octaves`, and the marching cost is the product of them. Measured as ratios inside one alternating block (absolutes from that block are not trustworthy, the ratios are): `steps` 72 → 40 takes 30% off the frame, `octaves` 6 → 4 takes 21%. Both sub-linear, because the ray setup and the palette read are per-pixel constants that neither touches. The *Skein* look below, at nine octaves, is the dearest coordinate in the table — about 1.3× the shipped one.

## Two bugs this file had, both worth knowing if you write one

**`tanh` overflows.** It is commonly evaluated as (e^2x − 1)/(e^2x + 1), and f32 `exp` overflows past 2x ≈ 88, so a large enough argument returns Inf/Inf — a NaN, and a **black** pixel. The claim that caught it is the one that says raising `exposure` may not darken any pixel: at sixteen times the shipped gain, six channels went from 255 to 0, which is the brightest pixels in the picture inverted. The argument is clamped at 16 now, where `tanh` is already 1 to well inside f32, so the clamp changes not one byte at any usable exposure and removes a cliff at the top of a knob's range.

**A vessel that travels seals shut.** The warp is sampled in a world that slides past the eye — that is what makes the fibres stream toward you and grow — but the vessel itself is measured in **eye-relative** coordinates, by subtracting the same slide back off. Both halves matter. A warp that did not slide would be a still picture that merely wobbles; a vessel that slid would have its `flare` term grow without limit until the throat closed and the file went dark some minutes in, which nobody would find in a thirty-second look.

## The motion

There are **two clocks**: `travel` slides the world past the eye, `flow` turns the fold's phase. Neither has a fixed point by construction — there is nothing for either to settle into — and `drift` is a shear on march depth rather than a third clock, while the dither is a hash of the pixel. So with `travel` and `flow` both at zero the file is *exactly* frozen: two frames a minute apart are the same bytes.

Measured through the look instrument's own arithmetic, over the whole minute rather than only its recorded two-second row (V913): the row reads 0.06073, the minute averages 0.05654 over 29 gaps (min 0.04734, max 0.07235) and the **last** gap reads 0.06259 — above the row.

And per frame, **per clock**, which is the number that matters here:

| | f59→60 | f1799→1800 | f3599→3600 |
| --- | --- | --- | --- |
| shipped | 2.473e-2 | 2.142e-2 | 2.525e-2 |
| the march alone (`flow` 0) | 2.254e-2 | 2.034e-2 | 2.311e-2 |
| the fold alone (`travel` 0) | 1.651e-2 | 1.520e-2 | 1.443e-2 |
| both cut | 0 | 0 | 0 |

The first draft of that claim measured the shipped file's pace at the end of the minute against its pace at the start, and its own red-verify killed it: an exponential ease that settles the march after four seconds **passed** the assertion, because the fold's clock kept the pixels changing at the same rate. A pace a second clock can carry is a claim about the file, not about the thing it names (V923). Each clock is now measured with the other one cut.

## The knobs are the shader's own struct

There is no project-level publish surface in this build (T1143), so the top level is `alembic1`'s own parameter page: every field of `struct Params` reflects into a named, typed control with the shader's trailing comment as its description (T880, T1053). Twenty-three of them, in four groups — the fold (`octaves`, `baseFreq`, `lacunarity`, `warpGain`, `twist`, `flow`, `drift`), the vessel (`radius`, `flare`, `squash`, `wander`, `coil`), the march (`steps`, `looseness`, `minStep`, `travel`, `lens`) and the light (`exposure`, `depthFade`, `paletteAxis`, `paletteScale`, `paletteBias`, `grain`).

Every one of them moves the picture, and that was measured rather than assumed: perturbing each by 30% on its own, the *smallest* effect in the file is `depthFade`, which still changes 78% of the frame by more than a quantisation step. The largest single change is not a knob at all — it is replacing the ramp with flat grey.

## The chain

```
palette1(ramp) -> alembic1(customWgsl) -> out1(output)
```

`out1` tone-maps with `none` on purpose: `tanh` has already done that job inside the shader, and a filmic curve on top would be tone-mapping a tone-mapped image.

## Reproducibility

`frameU.absTime` is the only clock. The fold's phase is wrapped into one turn before use — `sin` is exactly 2π-periodic, so it changes nothing about the picture and everything about the arithmetic, since an unwrapped `t × flow` is an f32 whose spacing eventually grows coarser than the finest octave's period. The dither is a hash of the **pixel** and nothing else, so it is grain that holds still while the picture moves through it, never flicker. The same second of the march is the same frame on every device and every replay.
