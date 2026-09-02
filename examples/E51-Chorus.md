# E51 — Chorus

One stream, played back at nine different moments at once. A wall of tiles, each holding
the same performer a fraction of a second apart, a few of them tearing, all of them on one
evolving palette so the nine read as a single picture rather than nine pictures.

`wall1` is `component:timeGrid@1` from the starter set. The example feeds it a texture and
turns eight knobs; the chain inside — repeat the frame into a grid, give every cell its own
delay out of a one-second history, break the loud cells, put the result on a palette — is
the component's own business.

## The composition is stock nodes, and that is the point

There is no "video wall" node, and none was written. The wall is Tile followed by Slit
Scan:

- **Tile** repeats the picture into a grid of cells. Its `repeat` is a plain vector
  uniform, so the grid is a number you can drag.
- **Slit Scan** owns a rolling history and reads a *different moment per pixel*, steered
  by a displacement map — red channel 0 is now, 1 is as far back as the ring holds.

Feed that map a value that is flat within a cell and different between cells, and the two
compose into a video wall. One small fragment shader produces that map; nothing else was
needed.

**The order is load-bearing.** Tile first, so the history records the already-tiled frame
and each cell region has its own layers to pick from. Scan first and the grid repeats one
warped picture — every cell identical, which is the failure that looks like it works.

```
bed1(noise, perlin4d) ─┐
orb1(circle) ──────────┤
mate1(circle) ─────────┴─► stand1(add) ──┐ order 0
cam1(webcam) ────────────────────────────┤ order 1
clip1(movieFileIn) ──────────────────────┴─► pick1(switch) ─► wall1 ─► out1(output)
pathx1(lfo) pathy1(lfo) ┄drives┄► orb1.center
matex1(lfo) matey1(lfo) ┄drives┄► mate1.center
beat1(audioPattern) ┄low┄► orb1.radius
```

## The source is a port, not a node

`pick1` picks what the wall is made of. Index 0 (shipped) is a deterministic understudy:
two soft bodies on four incommensurate LFOs over a dark noise field, so every gate and the
gallery card see a real wall. Index 1 is `cam1`, the **webcam** — flip it and the wall is
nine moments of your own face, which is what this example is actually for. Index 2 takes a
clip; drop a file on `clip1` and it plays.

The component cannot tell the three apart. It takes a texture, so nothing inside it changes
when you switch — which is the whole reason the source lives outside the boundary.

The understudy is two bodies rather than one on purpose. A single travelling disc gives
every cell the same *pose* at a different place, which reads as polka dots; two bodies give
each cell a different *configuration* — near, crossing, far apart — and a configuration is
what a viewer reads as "a different moment".

## The performance page

Eight knobs reach the parent, and nothing else does:

| Knob | Shipped | What it does |
| --- | --- | --- |
| Grid | 3 x 3 | Columns and rows. Uniform-only — see below. |
| Spread | 1 | How much of the held second the wall spans. 0 puts every cell on the live frame. |
| Mode | 1 | Which distribution deals the delays. |
| Rate | 2 Hz | The wall's clock: Sweep speed, Shots cuts, and how often the tear re-deals. |
| Seed | 7 | Deals the cells — which moment each holds, and which of them tear. |
| Glitch | 0.4 | How many cells tear per tick, and how hard. 0 is byte-identical passthrough. |
| Colour | warm white | A master tint over the palette. White is a true identity. |
| Blend | 0.7 | Master dissolve for the recolorizer. 0 is the raw wall, tear and all. |

**Grid is one vector, not two numbers,** and that is a limitation rather than a taste: a
component publishes a knob onto a whole parameter, and Tile's grid is one vector. Its two
fields *are* columns and rows.

### The five modes

0. **Uniform** — one moment everywhere. The wall is the plain tiling.
1. **Ordered** *(shipped)* — the cascade. Delays rise in reading order, so the wall shows
   nine points along the performer's path at once, oldest at the bottom right.
2. **Random** — every cell its own moment, held. Seeded, so it is a look and not noise: the
   same seed is the same wall on every machine and every replay.
3. **Sweep** — the freeze that wanders through. Each cell's delay ramps, so it looks one
   frame further back every frame; at Rate 1.0 on a 60 fps document that is *exactly* one
   ring-frame per rendered frame and the cell holds still while the world moves on. Cells
   are offset in phase, so they snap back to live as a rolling wave. Below 1.0 the held
   frame plays in slow motion; above it, backwards.
4. **Shots** — four angles of one scene. Cells are dealt to four groups, each group holds
   one rung of the delay ladder, and the ladder rotates one rung per Rate tick — so the
   whole wall re-cuts at once and then holds.

## Turning the grid mid-show costs nothing

Columns and rows are uniform values on both consumers, so re-partitioning the wall writes
two uniforms and rebuilds nothing. The history keeps its layers, its contents and its
address — go from a 3 x 3 to a 6 x 6 between phrases and the wall re-forms on the next
frame instead of going black while 70 MiB is reallocated.

Nothing you can see would tell you whether that is true, which is why
`src/examples/time-grid-claims.gpu.test.ts` asserts it against the plan the backend is
handed: same resources, same passes, same shader text across a 4 x 4 and a 2 x 8, and the
picture changed.

## The cost, stated where it is chosen

Slit Scan's history is `width x height x bytesPerPixel x (frames + 1)`, and it inherits its
size from its input — so a wall fed 1080p and left unpinned would allocate 1.9 GiB. TimeGrid
pins **512 x 288** internally:

> 512 x 288 x 8 B x 62 layers = **69.75 MiB**, holding 61 frames — 1.02 s at 60 fps.

The *span* sets the depth, not the cell count. A ring holds a contiguous run of frames, so
covering one second costs one second of frames however few of them get read. What the cell
count decides is how many of those 61 moments are used, and 61 is enough for every cell of
an 8 x 8 wall to hold one of its own. Past that, cells start sharing moments.

512 x 288 is also honest about what a cell can show: at the shipped 3 x 3 a cell is 170 x 96
and is stretched to a third of the frame, so history kept at full resolution would be
paying fourteen times the memory for detail the wall cannot display.

**Why 61 and not 60.** Slit Scan spends `frames - 1` steps on a displacement of 1. Sixty
steps is one per rendered frame at 60 fps, which is what makes Sweep's Rate 1.0 an exact
freeze rather than a slow drift. At 30 fps the freeze rate is 0.5.

## The tear

A few cells at a time break inside themselves: bands of the cell shove sideways with an RGB
fringe riding the same displacement, wrapped so a tear never crosses a seam — a wall of
failing monitors rather than one broken tiling.

It is **sparse by construction**, and that is a constraint rather than a taste. Glitch on
every cell every frame is static at grid scale, and static carries no information about the
music. So a cell is *dealt in*: on each Rate tick an integer hash of (cell, seed, tick)
decides whether it tears at all, and the same triple picks how hard, how many bands and
which way each band shoves — so a tear **holds for a whole tick** instead of boiling.

The audio hook is here, and it is indirect on purpose: a cell's own **brightness** scales
its chance of being dealt in. Every cell holds a different moment, so one kick arrives in
each cell at a different time — and the tears chase it across the wall.

## The recolorizer

Ramp into Lookup, which is the standard way to put a whole wall on one palette. Luminance
is the index, so every cell's brightness becomes a hue and nine independently-lit moments
land in one colour world. The ramp's **phase walks on the free-running clock**, so the
palette rotates through the wall over about 23 seconds.

The palette is *cyclic* — its first and last stops are the same colour — because phase
wraps the gradient's axis and a palette that did not close would sweep a hard seam across
the wall once a cycle. That has a consequence the first build got wrong: an index reaching
1.0 lands on the closing dark stop, so the brightest thing in the frame rendered *dark* and
every hot core came back as an orange ring. The lookup's `scale` and `offset` now compress
the index into 0.02..0.87, which is E11's problem in reverse — that example had to stretch
its index because a noise field never left the middle third of its gradient.

`Colour` is a master tint over the palette, defaulting to white so it has a true identity
and its whole range to move in.

## Audio: one mapping, and where it had to go

`beat1` is an Audio Pattern — the deterministic fixture, not a live input, because a shipped
example must not open a device and every gate has to see the same performance twice. Its low
band drives the body's **radius**, enveloped: the band rests at 0.71 and peaks near 0.98, so
a raw drive would be a body that never shrinks.

Driving Spread, Rate or Blend from that band is what you would reach for first, and it
cannot be done. The compiler resolves a component instance's published page with no
resolution context — no node reader and no frame — and the flattening is then memoized on
the document revision. A channel read on a published knob warns and falls back to its
retained value; a clock expression silently evaluates to zero. Measured, frames 30, 150 and
260 of a frozen world came back byte-identical. **A component's published parameters cannot
be animated today**, and that is reported against the compiler track rather than worked
around here, because a dead expression in a shipped example is a lie about the feature.

Its *internals* are a different matter and do animate — an internal node is flattened into
the parent graph and resolved with the frame like any other, which is what lets the palette
walk on its own.

So the kick goes on the body, and on this instrument that is the better mapping anyway: the
cascade turns one beat into a wave rolling across the grid, and the tear rides the same
signal for free.

## What this example is a gate for

- Tile into Slit Scan with a per-cell map, which is where the per-cell delay either works
  or silently collapses to one warp.
- A per-cell effect that is deterministic from a seed: the same seed is the same wall
  twice, a different seed is a different wall, and at Glitch 0 the seed is inert
  byte-for-byte.
- An internal component parameter animating on the free-running clock, which is the
  standing evidence for the half of the component model that *does* work.
- A library component whose whole interface is a texture in, a texture out, and eight
  numbers — the second example to instance one, and the first whose component is a
  *performance instrument* rather than a converter.
- The uniform-only grid change, asserted on the plan rather than on the picture.
- Slit Scan's `frames - 1` arithmetic, asserted exactly: at a 4 x 4 grid on a 61-frame ring,
  cell *k* shows the frame exactly *4k* back, checked against a Uniform-mode render of the
  same graph at that frame, byte for byte.
