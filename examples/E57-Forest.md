# E57 — Forest

A misty, moonlit, faintly hostile wood that you are walking through forever. One `customWgsl` pass raymarches an infinite procedural forest — thickets and clearings, a mist that pools on the ground, broken snags standing out of it, **god rays cutting between the trunks with their shadows in them**, and a full moon you never reach — and a second pass throws the near field out of focus. Two slow audio lanes move the air and the moon underneath all of it. It is built to sit behind somebody's web page, so the frame budget shaped every decision in it before the picture did.

T1170 deepened it on the owner's reading that the first version was "a little bit lame, a little bit repetitive" and wanted depth of field: a density **field** instead of a constant, broken stems, a ground that rolls, a near-field defocus and a real gait.

**T1170b built the god rays and put audio on it**, on the owner's reading that the file needed "volumetric lights, god rays coming from the moon towards the camera, and shadows being cast into the fog by the trees... audio reactive in a way where it's not becoming flickery and weird". The first thing that pass did was measure what was already there, and the answer reframed the job — see below. What each change cost, and what was refused instead, is here too; every number is a delta against a control rendered in the same run.

## The budget came first, and it is not a made-up number

A hero background competes with a page's layout, fonts and scripts, so cheap is a requirement. The reference is E13 Prism — the one example in this catalogue that actually did this job in the wild — with E55 Reactor measured beside it as a calibration (it agrees with the number T1150 recorded independently, so the instrument is measuring what it claims to).

| example | 1920×1080 | 1280×720 |
| --- | --- | --- |
| E46 Lantern (one 2D SDF pass) | 1.6 ms | — |
| **E13 Prism** (the in-the-wild datum) | **3.6 ms** | 2.8 ms |
| **E57 Forest** (T1156, ships at 720) | 6.6 ms | **3.3 ms** |
| E55 Reactor (the other raymarcher) | 24.3 ms | 13.5 ms |

Dawn/Metal, whole graph, on an idle machine. Getting those numbers took three attempts at the instrument: a paired difference is worthless while another session runs a twelve-worker suite (readings came back negative, and E13 read anywhere from 3.0 to 44 ms), so every configuration is alternated through short runs at two frame counts and the minimum of each is kept.

**And that table is a record, not a reading.** The same instrument on the same machine reported this file at 3.53 and 5.51 ms in two runs an hour apart, and E13 at 3.11 and 4.38; another track measured E57 at 3.67 the same week. Two *identical* control configurations came back 0.84 ms apart in one twelve-round run. So T1170 measured nothing in absolutes — every figure below is a **delta against the T1156 file alternated through the same run**, which is the only kind of number that survives this machine. Widening the two frame counts from 16/48 to 32/192 was worth more than tripling the rounds: the difference the estimate is built on goes from about 130 ms of GPU to 640 ms, against the same setup noise.

### What T1170 cost, against a same-run control

Two independent eight-round runs, every configuration alternated, minimum of each kept, the T1156 file measured beside them each time. They agree to a few hundredths:

| configuration (1280×720) | run A | run B |
| --- | --- | --- |
| T1156 file — the control | 4.00 | 4.10 |
| **this file** | **4.29** | **4.29** |
| this file with the defocus pass removed | 4.03 | 4.03 |
| this file, density field and swell off, density matched to the field's own mean | 4.72 | — |
| E13 Prism, same run | 2.73 | 2.63 |

So the deepening costs **about +0.25 ms**, six percent of the frame, and **the defocus pass is essentially all of it** (+0.26). The density field, the snags, the ground swell and the gait together come to zero within the instrument's own noise — and against the same code with an even field at the same mean density they *save* 0.43 ms, because a clearing walks the same cells with nothing in them to march. That is the prediction the design was made on, and it held.

**The budget the file ships against still holds.** It is not "cheaper than E13 at the same size" — it never was — it is that E57's 720p frame is cheaper than the 1080p frame E13 ran behind a real page. Measured in one run: E57 at 720 is 4.29 ms against E13 at 1080 at 5.45 ms, a 21% margin.

### ⚑ What T1170b cost, and the margin above is now spent

Two clean blocks, alternated, minimum of each cell kept, and both of §V929's references landing on their records inside them (E13 at 720 read 2.71 against a record of 2.63–2.73; E13 at 1080 read 5.83 against 5.45). Two identical controls in each block agreed to 1.7% and 1.4%, which is the block's own error bar measured from the inside (§V933).

| configuration (1280×720 unless stated) | block A | block B |
| --- | --- | --- |
| the T1170 file — the control | 4.71 / 4.79 | 4.34 / 4.40 |
| **this file** | **5.93 / 5.72** | **5.56** |
| this file with `shafts` at 0 | — | 3.86 |
| this file with `fog` at 0.05 | — | 5.28 |
| E13 Prism at 720, same run | 2.71 | — |
| **E13 Prism at 1080, same run** | **5.83** | — |

So the god rays cost **about +1.2 ms, a fifth of the frame**, and the volumetric block as a whole now costs **1.70 ms of a 5.56 ms frame — 31%**, where at T1156 it was 0.25 ms. That is the honest headline: the shadow walk is not a refinement of the old probe, it is several times its cost.

**And the budget is therefore at its line rather than inside it.** E57 at 720 reads 5.72 to 5.93 against E13 at 1080 at 5.83 — level, within the block's own 2%. The 21% margin T1170 recorded is gone. Nobody should read that as "it still holds comfortably": it holds, and there is nothing left.

⚑ **The same file measured `live` twice in one block, in slot 2 and slot 6, and got 5.93 and 5.72** — a 3.7% difference on nothing at all, which is §V933's positional bias showing up again and the reason both readings are printed rather than averaged into one.

**What to trade, if a page needs the margin back**, measured rather than guessed:

| lever | saving | what it costs the picture |
| --- | --- | --- |
| `shafts` to 0 | **−1.70 ms (31%)** | the whole volumetric: no shafts, no shadows, and the frame collapses to near-black — this is an all-or-nothing switch, not a dial |
| `blur` to 0 | −0.26 ms | the near-field defocus (measured at T1170) |
| `fog` 0.03 → 0.05 | −0.28 ms | nothing but more haze; the reach is solved from the fog |
| render smaller | proportional | almost all of this file is per-pixel |

The one lever that is *not* on that list is a shorter shadow walk. It is the obvious candidate — `SHADOW_REACH` in the shader sets how far a trunk can cast — and it was attempted and the block came back with two identical controls 18% apart, which §V929 says to throw away rather than quote. **It is unmeasured, so it is not a finding.**

⚑ **And one correction the tighter instrument forced.** At 16/48 frames this file's 720p ratio to E13 read 1.19×; at 32/192 the control reads 1.56×. The difference is not the file, it is the estimator — E13's cost is mostly *fixed* setup, and the narrower difference was leaving more of that setup in the per-frame number. The 1.19 in the table above is therefore an artefact of how it was measured, and the honest statement of the same budget is the frame comparison in the paragraph above, which does not depend on the ratio at all.

1080p was measured once per configuration rather than twice, so it is a reading and not a table: E57 8.83, the T1156 control 9.38, E13 5.45. Taken at face value the deepened file is *cheaper* at 1080p than the one it replaces, which is what one would expect if the clearings save more where there are more pixels to save them on — but one sample is one sample, and it is quoted here as a bound, not a finding.

**And the honest reading of that table, because the ratio is not one number.** E13's cost is mostly fixed — 33 nodes, six geometries, four point kernels — and only about 1.5 ms of its 3.6 is per-pixel. This file is the opposite: almost all per-pixel. So at 1080p it costs 1.8× E13, at 720p 1.19×, and *per pixel* it is about four times dearer. What the table licenses is the **frame**, not the pixel: at 1280×720 this file's frame is cheaper than the frame E13 shipped and ran behind a real page, which is the comparison the budget was set in. It ships at 720 for that reason, and because a hero background is legitimately rendered at a fraction of viewport size — a volumetric is low-frequency, so the upscale is invisible on fog. 1080p is available and costs 6.6 ms.

Where the 6.6 goes: shafts 0.25 ms, branches 1.7, and the rest is the grid walk and the trunks. Raising `fog` from 0.03 to 0.09 takes the frame to 5.9 without touching a quality knob, because the reach is solved from the fog.

## Walking forever is free, because the world repeats

One tree per cell of an infinite grid on the ground plane. Whether a cell has a tree at all, and its height, radius, lean, branch phase and its offset within the cell, are a hash of the **cell index** — so the camera translates through it and the forest is different every metre, with no loop point, no seam and no wrap. That is the whole "infinitely walking forward" claim, and it costs one tree.

## The density is a field, and that was the whole of "repetitive"

Every tree already differed — height, radius, lean, branch phase, offset — and it did not help. At a **constant** per-cell probability the stand is a regular lattice however varied the individuals are, and through fog the trunks reduce to an evenly spaced rhythm of verticals: a picket fence. Per-tree variation cannot fix a problem that is about the *density*.

So `clumping` makes the share of cells that carry a stem a low-frequency value noise over the cell index — thickets you cannot see into, clearings you can see across — and it is the contrast between them the eye reads as depth. The claims measure it as **dispersion across a walk**: twelve frames over half a minute vary from each other 1.74× more than with the field off, and 2.10× more than with the field off *and* the density thinned to the clumped field's own mean share, so "more variance" cannot be "fewer trees".

Both ends of it were wrong first and both were found by looking. At a clump period of eighteen metres against a reach of twenty-six the camera walks **into** a clearing and stays there — frame 900 of that draft was an empty grey wash with two trunks at the edge, which is worse than the lattice it replaced. Thirteen metres keeps two clumps in shot. And a clearing has to be thin rather than **bare**: the floor is 0.42 of the density, because a hole with nothing at all in it stops reading as a wood and starts reading as the end of the geometry.

**The gate is binary and a pure function of the cell index.** Multiplying a smooth field into a tree's height or radius instead would make a marginal cell's tree rise out of the ground as the field shifted; reading the field off the eye-relative position rather than the absolute cell index would make it change every time the camera crossed a cell wall. Either one is a tree that grows while you watch.

## The ground rolls, for the price of a noise already paid

Everything stood on one flat plane, so every trunk met the mist at the same altitude and the eye read a dead horizontal floor line across the frame. `relief` rides the trunk feet and the eye on the **stand field itself** — free, because the cell has already paid for it — so a thick stand sits in a hollow and a clearing stands on the rise, and the eye goes down with them and comes up again.

The eye takes a quarter of that swell, centred, against a floor, and all three were found the hard way: at `relief` 1.8 the eye took the full one-sided swell, dropped to a tenth of a metre and then **below** the ground plane, and the plane printed a hard horizontal edge straight across the lower third of the frame — precisely the dead floor line the term exists to remove, drawn much darker.

**The ground plane itself does not roll, and that is a refusal.** Intersecting a height field needs a march where a plane needs one divide, and the ground is never seen: `mist` pools over `fogHeight` metres and the floor of every frame in this file is haze. Marching a surface to render something invisible is the exact trade the rest of the file exists to refuse. What the swell buys is what is actually visible — trunk feet meeting the mist at different heights, a stand dipping together rather than each tree differing on its own, and the eye's own rise and fall.

The eye's position is rebased onto its own cell each frame, so every ray marches near the origin in `f32` while the hash still reads an exact integer cell index. Without that the march loses its epsilon after a few minutes of walking.

## The geometry is a grid walk, not a sphere trace

A forest of vertical trunks is the worst case for sphere tracing: the distance to the nearest trunk axis is small everywhere, so a marcher crawls through empty air. Instead the ray walks the grid cell by cell and pays one quadratic per cell — the tree's bounding cylinder. That is exact rather than approximate, because a tree's bound is clamped to fit **inside its own cell**: a tree can never be hit from a neighbouring cell, so the walk's cell order is hit order and the first bound it actually enters is the first thing it can hit. `branchSpread` and `lean` therefore saturate against the cell; the knob that grows a tree past that is `spacing`.

One bound was not enough. Branches have to fit inside the full bound, which fills most of a cell, so a near-horizontal ray enters it four times in five and the walk culls almost nothing — measured, not guessed: the first draft ran at eleven milliseconds and an **empty** grid ran at twelve, which is the shape of a cull that is not culling. What separates a cheap ray from a dear one is height. Branches start a third of the way up; the eye is at 1.7 m and the walk is level, so through the whole lower half of the frame the ray is under every branch in the wood. Those rays take a **stem bound** a fifth as wide, a trunk-only distance field, and never build a branch table at all.

## The trees, and the foliage that is not here

A trunk is three tapered capsules with a lean that grows toward the top and one sine of swelling up the stem, so the silhouette is a tree and not a ruled cone. Branches are whorled on the golden angle, biased up the stem, each bending once upward and off its own azimuth — a straight spoke reads as a diagram. Radius and height vary widely per tree, from saplings to old thick ones, because a stand of identical poles is exactly what reads as procedural.

### The short stems are broken, not young — and the owner found the first version

A share of the cells carry a stem a fifth to a half the height, because otherwise every vertical in the frame runs off the top of it and the picture has exactly one scale in it. The first draft made those **saplings**: a mature tree at a quarter scale, same proportions, same branch pattern from a third of the way up, same silhouette. The owner watched it and said the trees were growing. They were — a quarter-size copy of the tree beside it is exactly the picture of a tree that has not finished growing, and nothing was animating at all.

The fix was a change of **form**, not of number. A snag keeps the full trunk radius of the tree it was — a snag is the *bottom* of a big tree — carries no branches, and ends **blunt** where it snapped instead of tapering to a point. Three differences, none of them scale, and a dead wood suits this picture better than a nursery did. It is also the cheapest stem in the file: no branch table is ever built for one.

There is **no foliage, and that is a decision**. Three crown forms were built and all three were refused on the picture: a dented ellipsoid read as a mushroom cap on a pole, a capsule cone read as a lollipop (its distance carries a hemispherical foot), and a proper flat-footed cone with tiered branches read as a lampshade. Through this much mist the crown is the *only* part of a tree that would be read as a shape, so a crown that reads as a manufactured object is worse than no crown at all. Bare crooked trees in fog are the stronger picture and the cheaper one, and the branches crowd toward the top, which is what a bare crown is.

## The fog is the budget, and it performs the culling it licenses

The march's reach is **solved from the fog**, not authored — the distance at which transmittance falls to 7%, past which a tree changes its pixel by less than a display step against this haze. So raising `fog` runs fewer cells and the frame gets *cheaper*, measured above. Beyond `spacing × 3.4` a tree drops its branches; beyond `spacing × 1.1` its branches straighten from two capsules to one.

Both fog layers thin with height: `fog` is the plain haze and `mist` is the extra that pools on the ground over `fogHeight` metres, so trunk feet dissolve and the upper stems float clear. Both integrals are analytic along a straight ray, so the unstructured half of the fog costs two exponentials rather than a march. The altitude profile is also what makes the moon visible at all — a haze with no profile is as thick straight up as along the ground, and the first draft's sky was solid fog with no moon in it.

## The money shot: god rays — and the measurement that reframed the ask

The moon's in-scatter splits in two. The **unshadowed** part integrates to exactly `1 − transmittance`, because the density and the extinction are the same function, so it is free — that is the wash of light toward the moon. The **shadowed** part is the only thing a shaft actually is, and it is the only thing marched: seven samples importance-sampled by transmittance so they crowd where light survives, each carrying a short shadow walk toward the moon that tests the trunk column only — no branches, no distance field.

### ⚑ The shafts were never missing. The *shadow* was.

The ask read as a missing feature, and the first thing T1170b did was measure the one that had shipped. Turning `shafts` from its value to 0 moves the frame's mean luma from **0.288 to 0.041**: that one block is essentially the whole illumination of the picture. And the occlusion was not missing either — a shadow probe toward the moon had been in the file since T1156. What was missing was its **amplitude**. Replacing the shadow term with a constant 1.0 changed the frame by a mean of **1.5 to 3.1 of 255**, with a maximum of 24 to 37: about one percent of a frame the surrounding term supplies a hundred percent of. Amplified fourteen times, the difference had exactly the right *shape* — vertical slabs radiating from the moon — sitting inside per-pixel noise of the same size.

So the diagnosis was neither "add shafts" nor "turn them up". **One stochastic point probe is a Bernoulli draw**: its expectation is the shadowed fraction, which is small, and its variance is the largest a bounded estimator can have. Every way of deepening it deepened the grain in exact proportion — four stratified taps and a wide column gave unmistakable structure and *tripled* the grain in a flat patch of fog, 0.0109 to 0.0326.

### The shadow stopped being sampled at all

The moon never moves, so the shadow of a trunk is a fixed cylinder, and "is this point in shadow" is a question about the **distance from the light ray to a trunk axis** — an analytic quantity, not one to be sampled. The shader now walks the grid along the moon's own XZ direction (the same Amanatides–Woo the view ray uses; the setup is cheap because the direction is a frame constant) and takes the perpendicular distance to each trunk it passes. Deterministic, so it carries no noise of its own; deeper, because full extinction at the core costs nothing now; and sharper, so what the eye gets is the alternation of lit and unlit slabs that a god ray actually is.

Three things were found by **looking** and none by arithmetic:

- A **binary height test** — "does the ray clear the trunk top" — printed a hard horizontal edge across the upper right. A boolean over a continuous quantity is a step. It is now the stem's own taper, which is both smooth and the truth about the object.
- The far end of a fixed-cell-count walk **pops a shadow into existence** as the camera moves, because the distance a fixed number of cells reaches depends on where in its first cell the walk began. The occlusion fades to zero before the shortest walk the count can produce, so a cell can only ever join contributing nothing.
- The columns had to be **narrow enough to leave gaps**. At thirteen and four trunk radii every direction found an occluder and the picture went uniformly dark rather than striped. Seven and two and a half leaves lit lanes between the shadows, which is the whole effect.

The shadowed term's coefficient went 0.95 to 1.95 to put the *lit* fog back where it was, so what the change buys is contrast rather than darkness — the same trade `clumping` made between thickets and clearings, one term further in. Across five frames spread over forty seconds the frame's mean now swings **0.214 to 0.406** where the T1170 file swung 0.286 to 0.306: a fivefold wider swing about nearly the same average, which is the light coming and going as you walk.

**Measured as a claim**, on the pixels where the wood draws *nothing* (byte-identical with the volumetric switched off, so no trunk silhouette can contaminate it): the shaft term is **0.3205 with a wood standing against 0.4117 with an empty grid** — the trees take 22% of the light out of the fog — and its boxed curvature is **1289 against 634**, so the wood roughly doubles the structure in it. Both are red-verified by making the shadow return a constant.

### And the dither split in two

The march's entry dither and the volumetric's sample offset had shared one hash, and they want opposite distributions. The march dithers a silhouette by a hundredth of a metre and wants an uncorrelated hash. The shaft loop offsets *one stratified sequence per pixel*, so a white-noise offset makes neighbours disagree at random and the residual is salt-and-pepper; interleaved gradient noise spreads the offsets evenly over a small neighbourhood and the residual is a fine even weave. Same picture, **0.0326 against 0.0191**.

Seven shaft samples is now the file's expensive number, and cutting it was tried and refused: five instead of seven takes the frame from +23.5% to +21% and the grain from 0.0191 to 0.0303 — nearly triple the shipped file's 0.0109.

Skipping the march where the forward lobe is small was tried and **refused** at T1156: the term dropped is six thousandths of a linear unit, which is thirty percent of the level in the *dark* quarter of the frame, so the gate's own cone printed a huge circular arc across the lower left. No still showed it; a static-pixel mask over fourteen seconds of walking did, because a walking scene cannot have a smooth curve that never moves.

## The audio: his constraint was the specification

*"Audio reactive in a way where it's not becoming flickery and weird — something interesting that happens with the sound, maybe some dimming."* The second half of that sentence rules out the obvious build. An envelope on a luminance term strobes, and T1190 measured exactly that on E56 the day before. So **nothing here drives a per-frame brightness.** Two lanes, both on quantities with mass, both slower than a bar:

| parameter | what it is | chain | range |
| --- | --- | --- | --- |
| `mist` | the density of the air | `air1` (1.2 s) → `airRank1` (18 s) → `airSmooth1` (0.6 s) | 0.155 … 0.285 |
| `moonGain` | the moon's own output — the gain everything else is measured against | `dim1` (3 s) → `dimRank1` (40 s) → `dimSmooth1` (1 s) | 0.85 … 1.22 |

Both go through `valueNormalize`, which is why there is no floor and no gain to eyeball per track: it maps a channel through its *own* recent distribution, so equal amounts of time map to equal amounts of range and the lane can neither pin nor idle.

### ⚑ But Normalize alone does not buy "not flickery", and that is this pass's sharpest finding

A percentile **flattens** a distribution, and flattening it means **steepening the map wherever the signal is dense** — so a signal that was already smooth going in can come out as a jump. Measured over 3600 frames with the follower only on the input side, `airRank1` moved **20.9% of its own span in one frame**: 1257% a second, and `mist` stepping 0.21 to 0.24 between two frames is a visible lurch in the fog. Lengthening the input lag cannot fix it — the input was not the rough thing, the *map* was. So each lane carries a **second follower after the rank**, which bounds the output's step directly, and it costs about a tenth of the coverage at the tails:

| lane | per twentieth of its own span | max step per frame | mean | longest still |
| --- | --- | --- | --- | --- |
| `airMap1:low` → `mist` | 1.3% … 7.9% | **2.09% of span** (126%/s) | 0.2123 | 1 frame |
| `dimMap1:lowMid` → `moonGain` | 1.6% … 8.4% | **0.78% of span** (47%/s) | 0.9951 | 1 frame |

Before the second follower those steps were 20.9% and 8.6%. Neither lane ever repeats a value on two consecutive frames, so there is no silent run to report at all. The gate asserts the bound *and* re-points each map at its rank directly, so removing the second follower cannot be silent.

⚠ **And the channel on the dimming lane was a measurement, not a taste.** On `:level` the same lane put 18.9% of its run in the bottom twentieth and 0.8% in the nineteenth, because `audioPattern`'s level *rests at its floor* — and a percentile cannot spread a tie. Normalize removes skew; it does not remove ties. `:lowMid` never rests, so its rank comes out nearly flat.

Retained values are the **measured driven means** — 0.212 and 0.995 — not the lane midpoints, because absence is the common case: every headless render, every thumbnail and every first open has no track. Both sit inside the driven range (0.166…0.255 and 0.877…1.176).

⚑ **And the air lane pays part of the god rays' bill**, which is why its floor is a budget number rather than a taste one. `reach` is solved from the fog, so thinner mist is more cells: at `mist` 0.155 the reach is 27.3 m against the T1170 file's 25.8, and at the lane's mean of 0.212 it is 22.2 — about 14% fewer cells than the constant it replaced. The floor sits a hair under the old 0.17 so the *worst* case the drive can reach is within 6% of what was measured before, and everything above it is cheaper.

## The near field, out of focus

The ask was depth of field, and half of it was already here: `fog` attenuates everything with distance, so a far-field blur would duplicate what the fog does and then compete with it for the same pixels — two "this is far away" cues arguing. What fog cannot do is soften something that is too **close**, and a trunk sliding past at arm's length out of focus is the difference between walking through a wood and looking at one. So the circle of confusion is one-sided: zero at `focus` and beyond, opening as a surface comes toward the eye. There is no far knob, and that is deliberate.

It is a second pass rather than lens sampling inside the march. Sampling an aperture means N rays a pixel and N times the DDA; the budget above dies at N = 2. A gather over the finished frame is twelve texture reads within about twenty pixels of each other. `forest1` writes the ray's distance in metres into its **alpha channel** — a `customWgsl` node has one texture in and one out, so the channel the picture does not use is where the geometry the next pass needs has to travel — and `dof1` writes an opaque frame back. A preview tapped off `forest1` rather than the output will show a non-opaque alpha; that is a real consequence of the trick rather than a bug.

**Scatter written as a gather, which is the part that is easy to get wrong.** The naive version reads the centre pixel's depth, picks a radius and averages — which blurs the inside of a near trunk and leaves its silhouette razor sharp, because the background just outside the edge is far away and chooses radius zero. Here every tap is weighted by *its own* circle of confusion against *its own* distance from the centre: a tap reaches this pixel only if its own blur circle is wide enough to get here, so near geometry spreads outward over the background the way a lens does.

That weight leaked, and the arithmetic caught what no still did. The first draft used a band of `k ± 0.34`, whose lower edge is negative for the inner taps — so a tap with a circle of confusion of exactly **zero** still landed with weight 0.10, a permanent low-grade blur over the whole frame, far field included: exactly the "argues with the fog" failure the pass was designed to avoid. With `focus` at 0, where nothing at all may be defocused, 27401 pixels of 57600 still differed from the pass switched off. Scaled by `k` the lower edge cannot go below zero, and `focus` at 0 is now a byte-exact passthrough — which is what the claims assert.

As shipped it changes between 353 and 6434 pixels of 57600 depending on whether a trunk is inside eight metres, and leaves whole-frame contrast within one percent. Set `focus` past the fog's reach and the whole picture collapses to 43% of its contrast, which is how the claims show it is reading depth over the entire range rather than softening a fixed region.

## Text goes on top

The hero requirement nobody states until it is wrong. The moon sits upper-right (`moonAzimuth`, `moonHeight`) and `quiet` opens a bank of haze lower-left at `quietAt` of `quietSize`, settling the picture toward the far-field fog colour it was already converging to — so trunks dissolve there rather than sitting behind a rectangle. The claims measure it: raising `quiet` lowers the local contrast inside the zone and leaves the rest of the frame alone, and the zone is quieter than the frame it sits in.

Its falloff is long on purpose. A shorter one drew a visible dark ellipse, which is precisely the rectangle-over-the-top the term exists to avoid.

⚑ **And `quiet` went from 0.7 to 0.85 at T1170b, because the god rays put contrast back into the corner the headline lives in.** The zone's own gate caught it: the local contrast inside it against the frame around it went from 0.48 to 0.72 of the ratio, past the bound the claim holds it to. The knob was there and the fix was to turn it — but the thing worth recording is that a change to the *lighting* silently degraded a *composition* requirement, and only the measured version of that requirement noticed.

## The motion budget belongs entirely to the walk

`absTime × walkSpeed` is a free-running translation with no fixed point **by construction** — there is nothing for it to settle into — and the wander, the gait, the ground swell and the cloud drift are offsets on the same clock. No envelope, no LFO, nothing that rests. Anybody adding a second motion source later is fighting the walk.

**The gait is derived from the walk rather than added beside it**, which is the only reason it is not that second source. A step is about 0.72 m, so the stride rate is the walk's own speed over that: the body rises twice a stride, once per foot, and rolls sideways once, and the 2:1 relation is the cue. The first version bobbed at a fixed 1.6 rad/s — four cycles a minute, which is breathing, not walking.

**The camera never turns, and that is load-bearing twice**: the per-pixel sky direction is constant, which is what makes the screen-space cloud veil on `veil1` correct here rather than a cheat; and the moon and the quiet zone hold still, which is what a headline needs. Heading drift was refused for exactly that reason. What let the gait and the ground swell in is that both are **translations**, and a translation cannot change a ray direction — which the claims assert to the byte: with no trees and no haze, every pixel above the horizon is identical with them on and off, while the ground below it is not.

Per frame the pace, averaged over four pairs spread across the first sixteen seconds and four across the last fifteen, is 7.977e-4 opening and 7.855e-4 closing — 98% of where it opened after a full minute; with the walk cut the closing figure is 6.130e-7. Averaging is not a nicety: the gait puts a 1.18 Hz oscillation into the per-frame delta and the clumped field puts a thicket-or-a-clearing into each frame, so a *single* pair now reads anywhere from 2.9e-4 to 1.35e-3 on phase and stand alone. The one-pair version of this claim failed at 0.54 of the opening pace, and it was right to — it was measuring one draw, not the pace.

T1170b put two driven lanes on it, and they do not break that — which is the reason they are the parameters they are. Neither drives a position, a rate or a per-frame brightness: one moves the density of the air and the other the moon's own gain, both on followers measured in seconds. The walk is still the only thing that moves the camera, and with no audio at all the file is exactly the picture its retained values describe.

That freeze is now a *three*-clock freeze, and the claims had to say so. "Cut the walk and the picture stops" was already made vacuous once by the cloud veil drifting on its own clock; the audio lanes broke it again, and with the walk cut the picture still moved by 0.00989 — eighteen times the bound — until the two slots were frozen at their retained values as well.

## Using it behind a page

It ships at 1280×720, which is the frame the budget above is defended at, and it is meant to be scaled up to the viewport rather than re-rendered at it. The lever ladder is unchanged but its numbers have moved a long way since T1170: `shafts` to 0 is now worth **1.70 ms, 31% of the frame** (it was 0.25 ms at T1156), `blur` to 0 about 0.26, and `fog` 0.03 → 0.05 about 0.28. `fog` is still the unusual one, because it buys the frame time back by *making the picture foggier* rather than by making it worse — but it is no longer enough on its own to restore the margin T1170b spent.

## The knobs are the shader's own struct

There is no project-level publish surface in this build (T1143), so the top level is `forest1`'s own parameter page. Every field of `struct Params` reflects into a named, typed control with the shader's trailing comment as its description: the walk (`walkSpeed`, `sway`, `bob`, `eyeHeight`, `pitch`, `lens`), the grid (`spacing`, `density`, `clumping`, `relief`, `snags`), the tree (`treeHeight`, `heightVary`, `trunkWidth`, `lean`, `branches`, `branchSpread`, `branchRise`, `gnarl`, `barkColor`, `groundColor`), the air (`fog`, `mist`, `fogHeight`, `fogColor`, `shafts`, `skyColor`, `cloud`), the moon (`moonSize`, `moonHeight`, `moonAzimuth`, `moonColor`, `moonGain`, `ambient`) and the composition (`quiet`, `quietAt`, `quietSize`, `vignette`, `exposure`). `dof1` carries two of its own: `focus`, in metres, and `blur`.

## The chain

```
veil1(noise) -> forest1(customWgsl) -> dof1(customWgsl) -> out1(output)

music1(audioPattern) -+
track1(audioFileIn)  -+-> source1(valueSwitch) -+-> air1(valueLag) -> airRank1(valueNormalize) -> airSmooth1(valueLag) -> airMap1(valueMath) => forest1.mist
                                                +-> dim1(valueLag) -> dimRank1(valueNormalize) -> dimSmooth1(valueLag) -> dimMap1(valueMath) => forest1.moonGain
```

## What was refused

- **Heading drift, and any camera rotation.** The screen-space cloud veil is only correct because the per-pixel sky direction is constant, and a headline needs the moon and the quiet zone to hold still. Gated.
- **A far-field blur.** It duplicates the fog and then competes with it for the same pixels.
- **A rolling ground plane.** A march to render something the mist swallows.
- **Foliage**, again, and for the reasons T1156 refused it three times over. "More" here means more contrast *between places*, not more objects everywhere.
- **Wind in the branches.** The one item on the brief not attempted, and the honest word is *deferred* rather than refused: the branch table is rebuilt on every bound a ray enters, so a time term in it is trig per branch per bound and the budget was already spent. It was never measured, so nobody should quote this as a finding.

T1170b added four more:

- **Driving `walkSpeed`, `bob`, `sway` or the camera from audio.** The gait is *derived* from the walk, so modulating the walk modulates the stride rate, and a stride that speeds and slows with the music is a limp. The motion budget still belongs entirely to the walk.
- **Driving `quiet`, `quietAt` or `exposure`.** The headline's patch has to hold still, and exposure is a per-frame brightness by definition — the exact thing he asked not to have.
- **Fewer shaft samples** to pay for the shadow walk. Five instead of seven takes the frame from +23.5% to +21% and the grain from 0.0191 to 0.0303, nearly triple the shipped file's 0.0109. Two and a half points of frame time for sixty percent more grain.
- **A shorter shadow walk**, which is the obvious way to buy the margin back. Attempted, and the measurement block came back with two identical controls 18% apart — thrown away rather than quoted. It remains *unmeasured*, and therefore not a finding.

## Reproducibility

`frameU.absTime` is the only clock in the file, and every random decision is a hash of a cell index — so the same second of the walk is the same forest on every device and every replay. The volumetric dither is a hash of the pixel, fixed across frames: grain, never flicker.
