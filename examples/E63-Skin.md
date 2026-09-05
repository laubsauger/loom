# E63 — Skin

Three tubes made of the same points, told three different things about themselves. On the left the points are just drawn; in the middle they are spanned into a surface with the seam left open; on the right the same points are spanned with the seam closed. Nothing moves between the panels. Only the **connectivity claim** changes.

## Why this file exists

The owner asked for a **skin** operator — *"seems like we're still missing skin and extrude point operators to actually get from a texture to a surface"* — and skin already shipped. `pointTopology` authors the connectivity claim on a pointset edge, `geometry` in `mode: "surface"` spans whatever grid the edge claims, and texture → points → surface has worked since T302.

The census says why it could not be found. Surface mode appears in **seven** examples; `pointTopology` appears in **one** (E20 Gooeyball, where it is a single node inside a five-node chain about deformation). The piece that makes the chain legible was demonstrated once, so the person who commissioned the project went looking for a node he already owned. That is T728's *"fourteen node types in exactly one example"* with a bill attached, and this file is the reply. Its subject is the claim, not the picture.

## The chain

```
field1(noise) -> fold1(mirror) -> hide1(pointsFromTexture) -+-> standA1(pointKernel) -> dots1(geometry)
                                                            +-> standB1(pointKernel) -> open1(geometry)
                                                            +-> standC1(pointKernel) -> seam1(pointTopology) -> closed1(geometry)
shot1(render) -> plate1(over) -> out1(output)
fold1(mirror) -> bed1(lookup) -> plate1(over)
```

`hide1` reads the field on a 96×96 lattice — one point per cell, its brightness pushing it out of the plane — and that one pointset feeds three kernels that differ only in where they stand. Each rolls the sheet into a tube: `u` runs the circumference, `v` runs the height, and the sampled height becomes **radius**, so the picture pushes the skin out from inside. Identical geometry three times over.

## What each panel is told

| panel | what the consumer is told | what you see |
| --- | --- | --- |
| **left**, `dots1` | `mode: "points"` — the claim is ignored entirely | a lattice of camera-facing billboards. You can see the far wall of the tube through the near one, because nothing spans anything: **35,187 interior pixels show the backdrop through it**, spread over 244 columns |
| **centre**, `open1` | `mode: "surface"` on the grid the **generator** published | a skin — and a slit. `pointsFromTexture` emits one point per lattice cell, so it already knows the adjacency and says `grid:96x96` on the edge; **a surface here needs no extra node at all**. The seam is open, so the cell between column 95 and column 0 is missing: **997 interior pixels in an eight-pixel-wide band**, and nothing else |
| **right**, `closed1` | the same points through `seam1`, one `pointTopology` whose only job is `wrapU: true` | a closed tube. The seam cell exists and the skin is shut: **exactly zero interior pixels show the backdrop**. The points never moved; only the claim changed |

Measured on Dawn at 1280×720, and a "see-through" pixel is an exact one: the render's background is fully transparent and `over` with a transparent front is the identity on its back layer, so a pixel where nothing was drawn is **byte-identical** to the backdrop rendered alone. No threshold on darkness is involved.

## Where the topology node is, and where it deliberately is not

`standB1` goes **straight** into `open1`. Putting a redundant `pointTopology` there — grid, `wrapU: false`, exactly what the edge already carries — would have made the two surface panels differ by one flag and read tidier, and it would have taught the wrong thing: that a surface needs a claim node. It does not. The lattice is free from any generator that emits one point per cell. **The seam is the part you have to author**, and the graph should say which is which.

The tests hold that to the letter: `pointTopology` with `wrapU: false` renders **byte-identical** to no `pointTopology` at all — zero pixels differ. The node writes nothing, owns no buffer and emits no pass; its whole effect is the flag.

And the claim that carries the file: **cut `seam1` out of the graph and the frame changes** — 12,984 pixels — **and changes nothing else**. Every differing pixel lies between x = 951 and x = 992, inside the right panel's own [807, 1069]. A version of this node that quietly moved a point, or that reached a neighbour, fails on the containment rather than on the count.

## The trap: `wrapU` asserts adjacency, it does not make your data periodic

This is the one thing about `pointTopology` that is harder than its description implies, and it cost a rebuild.

`wrapU` says column 95 is next to column 0. It says nothing about the **field**. `pointsFromTexture` reads a flat lattice, so with a plain noise those two columns sample two unrelated parts of the picture, the seam cell bridges a cliff, and the closed tube renders with a dark vertical crevice down its front — which looks exactly like the hole the flag was supposed to close. The first build of this file had it, and it read as a bug in surface mode.

`fold1` is the fix and it is one node: a Mirror about the field's own centre, so `u = 0` and `u = 1` read the same texel. Asserted where the mechanism is, at the two texels the lattice's first and last columns actually read — `floor(((col + 0.5) / cols) × width)`, the shader's own arithmetic, texels **6** and **1273** of a 1280-wide field. Folded, they are equal byte for byte on every row. Raw, they differ by up to 16/255. The left–right symmetry the fold puts into the backdrop is the picture telling you it is there.

## The surface is honest here because the field is smooth

E27 Relief argues the other side of this and is right to: it draws its heightfield as **points**, because a displaced surface is brutally sensitive to the ratio between mesh and field — coarser and a narrow feature falls between two vertices and spikes, finer and every vertex inside one texel shares a height and the surface steps. Both failures are real. Neither happens here, for one reason: the field is band-limited noise whose features are many lattice cells wide, so neighbouring points sample nearly the same height and the skin stays a skin. Put a `checker` in `field1` and it shreds, and that is not a bug in surface mode.

The displacement is **radial**, which is the other half of why it survives: pushing a point out along the tube's own normal moves it toward or away from the axis and never sideways past its grid neighbours, so cells stretch but never fold. At the shipped `relief` the radius runs 0.19 to 0.81 about a rest of 0.5 and never reaches the axis.

## Ninety-six columns, and the number is chosen for the seam

One missing cell in 96 is a gap about eight pixels wide through the centre panel at 1280, and one missing cell in 256 is not a gap anybody sees. The lattice is sized so that **the thing the file is about is visible**, and the cell aspect falls out roughly square at this radius and height (0.033 around against 0.025 up).

## Motion: two clocks, and each one is cut on its own

The 4D noise moves under the skin, so the relief crawls and the tubes are never the same shape twice. The rim light's **direction** turns — two LFOs in quadrature, biased so the light stays mostly behind the tubes — because a relief is invisible under a light that faces it and a raking light is the only thing that shows a bump. It is directional rather than a point light on purpose, so all three panels are lit identically and the comparison is not contaminated by which tube is nearer the lamp.

Both are structural: a free-running clock and a free-running orbit, with nothing to settle into. Measured through the look instrument's own arithmetic (mean |Δ| linear luma over its own 120-frame gap) across the whole minute rather than only its recorded two-second row:

| arm | mean | min | max | last gap |
| --- | --- | --- | --- | --- |
| shipped | 0.02727 | 0.02037 | 0.03748 | **0.02605** |
| field clock cut | 0.00833 | 0.00362 | 0.01887 | 0.00699 |
| light clock cut | 0.02481 | 0.02017 | 0.02892 | 0.02398 |
| both cut | **0.00000** | 0.00000 | 0.00000 | 0.00000 |

The recorded row reads 0.02473 and the last gap of the minute reads 0.02605 — **above** it, so the file is still moving at the end. Cutting either clock alone leaves the other plainly visible; cutting both leaves a frame that does not change by one byte. That decomposition is the point of doing it this way: a bare "frames differ" claim would have passed over a frozen light because the noise kept going, and over a frozen field because the light kept turning.

Both drive lanes change value on **100% of frames** with a **longest hold of zero**. Their retained values — what a host with no value graph resolves to — sit inside the driven range and near the middle of it: `rim1.direction.x` retains 0.38, above 61.7% of the driven values, and `direction.z` retains 0.45, above 53.2%. The still that produces is a lit picture, not a silhouette.

## Cost

Dawn/Metal, whole graph including the composite. Measured the way T1156 had to learn to measure it: a paired two-point difference is worthless while other sessions share the GPU, so every configuration is **alternated** through short runs at two frame counts, many times, and the **minimum** of each cell is kept — a contended run can only be slower. E13 Prism is run beside it every time as the calibration, and the table states what E13 read so you can see how much to trust the row.

| example | 1920×1080 | 1280×720 |
| --- | --- | --- |
| **E63 Skin** (this file, ships at 720) | ~4.0 ms | **2.2 ms** |
| E13 Prism (the in-the-wild datum) | 3.6 ms | 2.8 ms |
| E57 Forest | 6.6 ms | 3.3 ms |
| E55 Reactor | 24.3 ms | 13.5 ms |

At 720 the number is solid: across four alternating runs E13 read between 2.59 and 3.48 against its recorded 2.8, E63 read between 2.13 and 2.68, and the **ratio** held at 0.74–0.82 every time. In the two runs where E13 landed within 7% of its own record, E63 read 2.13 both times. At 1080 the machine never got quiet enough for a flat number — E13 came in 12–28% over its record — and the ratio moved between 0.97 and 1.24, so the row says "about four milliseconds" rather than pretending to two figures.

The shape of it: E63 is cheaper than E13 at 720 and about level with it at 1080, which is the same story T1156 told about E57. E13's cost is mostly **fixed** — 33 nodes, six geometries, four point kernels — and this file's is mostly **per-pixel**: three point kernels over 9,216 points each is nothing, and the frame is a scene pass over two surfaces of about 18,000 triangles and a cloud of 9,216 billboards, resolved through MSAA 4×.

**Ambient occlusion was tried and refused, on its own numbers.** At radius 0.22 it changed 1.02% of the pixels by **at most one display step** — a tube is convex and has no crease deep enough for it to find — while costing 0.39 ms of 2.52 at 720p and about 1.4 ms at 1080p. It moved the look baseline not at all, in either direction, at any decimal the instrument records. A knob that does nothing must not exist (§V146), so it does not. MSAA stays: the seam is eight pixels wide and it is the subject of the file.

## Reproducibility

`absTime` through the noise's own `speed` and two LFOs are the only clocks in the file, and every value in it is authored. The same second is the same frame on every device and every replay.
