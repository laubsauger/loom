# E51 — Chorus

One stream, played back at nine different moments at once. A wall of tiles, each holding
the same performer a fraction of a second apart, graded into one colour so the nine read
as a single picture rather than nine pictures.

`wall1` is `component:timeGrid@1` from the starter set. The example feeds it a texture and
turns eight knobs; the chain inside — repeat the frame into a grid, give every cell its own
delay out of a one-second history, tint the result — is the component's own business.

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
| Rate | 1 Hz | Sweep and Shots only. |
| Seed | 7 | Deals the cells for Random and Shots. |
| Colour | amber | The duotone the wall is graded into. |
| Blend | 0.42 | Master dissolve for that grade. 0 is the untinted wall, exactly. |

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

## What does not move, and why

Blend and Colour are static here. The first draft drove Blend from a clock so the grade
would breathe, and that turned out to be undeliverable: the compiler resolves a component
instance's published page with no resolution context — no node reader and no frame — and
the flattening is then memoized on the document revision. A channel read on a published
knob warns and falls back; a clock expression silently evaluates to zero. Measured, frames
30, 150 and 260 of a frozen world came back byte-identical. **A component's parameter page
cannot be animated today.** That is reported against the compiler track, and nothing here
works around it, because a dead expression in a shipped example is a lie about the feature.

The wall itself is very much alive: the two bodies travel, so every cell's content changes
and the cascade rolls with them.

## What this example is a gate for

- Tile into Slit Scan with a per-cell map, which is where the per-cell delay either works
  or silently collapses to one warp.
- A library component whose whole interface is a texture in, a texture out, and eight
  numbers — the second example to instance one, and the first whose component is a
  *performance instrument* rather than a converter.
- The uniform-only grid change, asserted on the plan rather than on the picture.
- Slit Scan's `frames - 1` arithmetic, asserted exactly: at a 4 x 4 grid on a 61-frame ring,
  cell *k* shows the frame exactly *4k* back, checked against a Uniform-mode render of the
  same graph at that frame, byte for byte.
