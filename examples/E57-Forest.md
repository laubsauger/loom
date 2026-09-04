# E57 — Forest

A misty, moonlit, faintly hostile wood that you are walking through forever. One `customWgsl` pass raymarches an infinite procedural forest, a mist that pools on the ground, light shafts between the trunks and a full moon you never reach — and it is built to sit behind somebody's web page, so the frame budget shaped every decision in it before the picture did.

## The budget came first, and it is not a made-up number

A hero background competes with a page's layout, fonts and scripts, so cheap is a requirement. The reference is E13 Prism — the one example in this catalogue that actually did this job in the wild — with E55 Reactor measured beside it as a calibration (it agrees with the number T1150 recorded independently, so the instrument is measuring what it claims to).

| example | 1920×1080 | 1280×720 |
| --- | --- | --- |
| E46 Lantern (one 2D SDF pass) | 1.6 ms | — |
| **E13 Prism** (the in-the-wild datum) | **3.6 ms** | 2.8 ms |
| **E57 Forest** (this file, ships at 720) | 6.6 ms | **3.3 ms** |
| E55 Reactor (the other raymarcher) | 24.3 ms | 13.5 ms |

Dawn/Metal, whole graph, on an idle machine. Getting those numbers took three attempts at the instrument: a paired difference is worthless while another session runs a twelve-worker suite (readings came back negative, and E13 read anywhere from 3.0 to 44 ms), so every configuration is alternated through short runs at two frame counts and the minimum of each is kept.

**And the honest reading of that table, because the ratio is not one number.** E13's cost is mostly fixed — 33 nodes, six geometries, four point kernels — and only about 1.5 ms of its 3.6 is per-pixel. This file is the opposite: almost all per-pixel. So at 1080p it costs 1.8× E13, at 720p 1.19×, and *per pixel* it is about four times dearer. What the table licenses is the **frame**, not the pixel: at 1280×720 this file's frame is cheaper than the frame E13 shipped and ran behind a real page, which is the comparison the budget was set in. It ships at 720 for that reason, and because a hero background is legitimately rendered at a fraction of viewport size — a volumetric is low-frequency, so the upscale is invisible on fog. 1080p is available and costs 6.6 ms.

Where the 6.6 goes: shafts 0.25 ms, branches 1.7, and the rest is the grid walk and the trunks. Raising `fog` from 0.03 to 0.09 takes the frame to 5.9 without touching a quality knob, because the reach is solved from the fog.

## Walking forever is free, because the world repeats

One tree per cell of an infinite grid on the ground plane. Whether a cell has a tree at all, and its height, radius, lean, branch phase and its offset within the cell, are a hash of the **cell index** — so the camera translates through it and the forest is different every metre, with no loop point, no seam and no wrap. That is the whole "infinitely walking forward" claim, and it costs one tree.

The eye's position is rebased onto its own cell each frame, so every ray marches near the origin in `f32` while the hash still reads an exact integer cell index. Without that the march loses its epsilon after a few minutes of walking.

## The geometry is a grid walk, not a sphere trace

A forest of vertical trunks is the worst case for sphere tracing: the distance to the nearest trunk axis is small everywhere, so a marcher crawls through empty air. Instead the ray walks the grid cell by cell and pays one quadratic per cell — the tree's bounding cylinder. That is exact rather than approximate, because a tree's bound is clamped to fit **inside its own cell**: a tree can never be hit from a neighbouring cell, so the walk's cell order is hit order and the first bound it actually enters is the first thing it can hit. `branchSpread` and `lean` therefore saturate against the cell; the knob that grows a tree past that is `spacing`.

One bound was not enough. Branches have to fit inside the full bound, which fills most of a cell, so a near-horizontal ray enters it four times in five and the walk culls almost nothing — measured, not guessed: the first draft ran at eleven milliseconds and an **empty** grid ran at twelve, which is the shape of a cull that is not culling. What separates a cheap ray from a dear one is height. Branches start a third of the way up; the eye is at 1.7 m and the walk is level, so through the whole lower half of the frame the ray is under every branch in the wood. Those rays take a **stem bound** a fifth as wide, a trunk-only distance field, and never build a branch table at all.

## The trees, and the foliage that is not here

A trunk is three tapered capsules with a lean that grows toward the top and one sine of swelling up the stem, so the silhouette is a tree and not a ruled cone. Branches are whorled on the golden angle, biased up the stem, each bending once upward and off its own azimuth — a straight spoke reads as a diagram. Radius and height vary widely per tree, from saplings to old thick ones, because a stand of identical poles is exactly what reads as procedural.

There is **no foliage, and that is a decision**. Three crown forms were built and all three were refused on the picture: a dented ellipsoid read as a mushroom cap on a pole, a capsule cone read as a lollipop (its distance carries a hemispherical foot), and a proper flat-footed cone with tiered branches read as a lampshade. Through this much mist the crown is the *only* part of a tree that would be read as a shape, so a crown that reads as a manufactured object is worse than no crown at all. Bare crooked trees in fog are the stronger picture and the cheaper one, and the branches crowd toward the top, which is what a bare crown is.

## The fog is the budget, and it performs the culling it licenses

The march's reach is **solved from the fog**, not authored — the distance at which transmittance falls to 7%, past which a tree changes its pixel by less than a display step against this haze. So raising `fog` runs fewer cells and the frame gets *cheaper*, measured above. Beyond `spacing × 3.4` a tree drops its branches; beyond `spacing × 1.1` its branches straighten from two capsules to one.

Both fog layers thin with height: `fog` is the plain haze and `mist` is the extra that pools on the ground over `fogHeight` metres, so trunk feet dissolve and the upper stems float clear. Both integrals are analytic along a straight ray, so the unstructured half of the fog costs two exponentials rather than a march. The altitude profile is also what makes the moon visible at all — a haze with no profile is as thick straight up as along the ground, and the first draft's sky was solid fog with no moon in it.

## The money shot: shafts

The moon's in-scatter splits in two. The **unshadowed** part integrates to exactly `1 − transmittance`, because the density and the extinction are the same function, so it is free — that is the wash of light toward the moon. The **shadowed** part is the only thing a shaft actually is, and it is the only thing marched: seven samples importance-sampled by transmittance so they crowd where light survives, each shadowed by one *stochastic* probe toward the moon that tests the trunk column only — no branches, no distance field. A fixed pair of probe distances costs twice as much and sees a fixed pair of slices of the light path; one probe at a distance that differs per sample, integrated over the seven, sees the whole path for half the price. The columns are deliberately much wider and softer than the trunks, because a trunk-width shadow at this sample count is invisible structure — and a fog lit through wide occluders is a darker fog, which is most of the mood.

Skipping the march where the forward lobe is small was tried and **refused**: the term dropped is six thousandths of a linear unit, which is thirty percent of the level in the *dark* quarter of the frame, so the gate's own cone printed a huge circular arc across the lower left. No still showed it; a static-pixel mask over fourteen seconds of walking did, because a walking scene cannot have a smooth curve that never moves.

## Text goes on top

The hero requirement nobody states until it is wrong. The moon sits upper-right (`moonAzimuth`, `moonHeight`) and `quiet` opens a bank of haze lower-left at `quietAt` of `quietSize`, settling the picture toward the far-field fog colour it was already converging to — so trunks dissolve there rather than sitting behind a rectangle. The claims measure it: raising `quiet` lowers the local contrast inside the zone and leaves the rest of the frame alone, and the zone is quieter than the frame it sits in.

Its falloff is long on purpose. A shorter one drew a visible dark ellipse, which is precisely the rectangle-over-the-top the term exists to avoid.

## The motion budget belongs entirely to the walk

`absTime × walkSpeed` is a free-running translation with no fixed point **by construction** — there is nothing for it to settle into — and the sway, the bob and the cloud drift are offsets on the same clock. No envelope, no LFO, nothing that rests. Anybody adding a second motion source later is fighting the walk.

Measured through the look instrument's own arithmetic, over the whole minute rather than only its recorded two-second row: the row reads 0.0210, the minute averages 0.0255 over 29 gaps (min 0.0184, max 0.0346) and the *last* gap reads 0.0225 — above the row. Per frame the pace is 8.577e-4 at the start and 9.155e-4 at the end of the minute, 107% of where it opened; with the walk cut it reads 5.010e-7.

The camera never turns, and that is load-bearing twice: the per-pixel sky direction is constant, which is what makes the screen-space cloud veil on `veil1` correct here rather than a cheat; and the moon and the quiet zone hold still, which is what a headline needs.

There are no driven parameters and that is also a decision. A hero background has no audio and no pointer, so a drive lane would be a lane that never fires; every value in the file is its own retained value.

## Using it behind a page

It ships at 1280×720, which is the frame the budget above is defended at, and it is meant to be scaled up to the viewport rather than re-rendered at it. If you do want it at 1920×1080 it costs 6.6 ms. The two levers, in order: `shafts` to 0, then `fog` up — and `fog` is the unusual one, because it buys the frame time back by *making the picture foggier*, not by making it worse.

## The knobs are the shader's own struct

There is no project-level publish surface in this build (T1143), so the top level is `forest1`'s own parameter page. Every field of `struct Params` reflects into a named, typed control with the shader's trailing comment as its description: the walk (`walkSpeed`, `sway`, `bob`, `eyeHeight`, `pitch`, `lens`), the grid (`spacing`, `density`), the tree (`treeHeight`, `heightVary`, `trunkWidth`, `lean`, `branches`, `branchSpread`, `branchRise`, `gnarl`, `barkColor`, `groundColor`), the air (`fog`, `mist`, `fogHeight`, `fogColor`, `shafts`, `skyColor`, `cloud`), the moon (`moonSize`, `moonHeight`, `moonAzimuth`, `moonColor`, `moonGain`, `ambient`) and the composition (`quiet`, `quietAt`, `quietSize`, `vignette`, `exposure`).

## The chain

```
veil1(noise) -> forest1(customWgsl) -> out1(output)
```

## Reproducibility

`frameU.absTime` is the only clock in the file, and every random decision is a hash of a cell index — so the same second of the walk is the same forest on every device and every replay. The volumetric dither is a hash of the pixel, fixed across frames: grain, never flicker.
