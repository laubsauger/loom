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
clip1(movieFileIn) ──────────────────────┴─► pick1(switch) ─► flare1(level) ─┬─► wall1.in1
                                                                             ├─► key1(threshold) ─┐
                                                                             └─► cut1(matte) ─────┴─► mpick1(switch) ─► wall1.in2
wall1 ─► out1(output)

music1(audioPattern) ─┐ order 0
track1(audioFileIn) ──┴─► source1(valueSwitch) ─┬─► env1(valueLag) ─┐
                                                └─► snap1(valueLag) ┴─► the two drives below

pathx1(lfo) ─► swoopa1(valueLag) ┄drives┄► orb1.center.x
pathy1(lfo) ─► swoopb1(valueLag) ┄drives┄► orb1.center.y
matex1(lfo) ┄drives┄► mate1.center.x
env1(valueLag) ┄drives┄► orb1.radius.x
snap1(valueLag) ┄drives┄► flare1.brightness
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
| Columns / Rows | 5 / 6 | The grid (1-16 each), and the centre the Churn swings about. |
| Churn | 5 | How far the wall re-cuts itself, on two sample-and-hold clocks. |
| Span | 90 | History depth in frames. 90 is 1.5 s; the cost is stated at the knob. |
| Spread | 1 | How much of the Span the wall distributes across its cells. |
| Mode | 1 | Which distribution deals the delays. |
| Rate | 2 Hz | The wall's clock — sweep speed, shot cuts, and the damage's burst periods. |
| Seed | 7 | Deals which moment each cell holds and which of them break. |
| Glitch | 0.4 | How much damage: tears, snow and dropouts, in bursts. |
| Chroma | 0.55 | The aberration front that travels across the wall and passes. |
| Crush | 1.5 | Contrast, applied before the palette, so it changes which colours are reachable. |
| Colour | warm white | A master tint over the palette. White is a true identity. |
| Blend | 0.82 | Master dissolve for the recolorizer. 0 is the raw wall, damage and all. |

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

> the ring runs at **half** the internal resolution, so it is 256 x 144 x 8 B x (Span + 1)
> — **17.44 MiB** at Span 61 (1.02 s), **25.31 MiB** at the shipped Span 90 (1.5 s), and
> **34.03 MiB** at the 120-frame ceiling (2.0 s).

Full resolution would be four times that for detail no cell is big enough to show: at a
4 x 5 wall a cell is 128 px wide and its history is 64. The cost of that trade is stated
rather than hidden — the record pass averages two source texels per ring texel, and at a
cell boundary those two belong to different cells, so exactly 2 px at each cell edge carry
a trace of the neighbouring moment.

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

## The damage is a vocabulary, not an effect

Three kinds, on six independent burst trains, at most one per cell per frame:

- **Tear** — bands of a cell shove sideways with an RGB fringe riding the same
  displacement, wrapped so it never crosses a seam.
- **Snow** — grain riding the picture's own colour, in a few scanline bands rather than
  over the whole cell, and lasting 3-4 frames.
- **Dropout** — the cell is multiplied by its own matte, so the background falls away and
  the subject is left floating. This is the one that changes what the cell is a picture
  *of*, which is why it is the rarest.

**They come in bursts.** Each event is a pulse on its own co-prime frame period — 17, 23
and 31 frames for tears, 13 and 19 for snow, 47 for dropouts — with a per-cell phase
hashed from the cell index, so the wall never pulses in unison. A tear lives 2–3 *frames*
and its bands re-deal on every one of them. An earlier build held one event for a whole
tick, which was sparse and deterministic and read as slow; the difference is the envelope,
not the randomness. `time-grid-claims.gpu.test.ts` asserts it directly: over twelve
consecutive frames the set of broken cells must take at least six distinct values, which
the held-for-a-tick design returns *one* for.

**At most one per cell per frame**, by an if/else chain. At 6×6 a cell is a couple of
thousand pixels and a tear under snow is mud; the variety is in *which* cells and *which*
kind.

**The snow rides the picture, it does not replace it** — and getting there took three
repairs, each of which measured the frame before touching a number.

It was a full-swing grain mixed toward white, which clipped. It was then a *monochrome*
multiplicative modulation, which stopped clipping and still read "too bright and out of
place". Measured, the culprit was not the grain at all: a hidden `mix(base, step(0.35,
base), 0.25)` lifted every mid-tone by up to +0.10 before any noise existed, taking a
cell's mean from 0.685 to 0.732. Crushing was never snow's job — `Crush` is a published
knob with a `level` node behind it — so it was deleted rather than reduced.

The second half was the desaturation. Writing luminance into all three channels made the
cell a *grey patch*, which is the "out of place", and it also made it measure brighter for
a reason no level could fix: the sink's transfer is concave, so luma-of-encoded is not
encode-of-luma, and a monochrome cell at **identical linear luminance** reads 0.704 against
a colour cell's 0.685. The picture was not brighter; it had stopped being the picture. So
the grain now rides the colour instead of replacing it.

And it was **one frame long**. The second snow train ran at `life - 1`, so at a lifetime of
2 it was a single-frame flash — which reads as a *pop*, not as texture. The tears were
given 2-3 frames for exactly this reason and the static never got the same treatment; it
runs 3-4 frames now, with its share dropped from 0.35 to 0.18 so the duty cycle barely
moves.

What is left is symmetric multiplicative modulation with its weight falling to zero in the
highlights, so its expected shift in linear luminance is **zero by construction** — and
that is what the gate asserts, over every kind of damage, in linear light.

§V853 was the standing suspect throughout and the measurement cleared it: chroma across a
snowing cell after the palette went 0.546 → 0.540, *down*. The lookup was not amplifying
grain into a dimension it lacked.

**The audio hook is here.** A cell's own brightness scales its chance of being dealt in, so
with a source that responds to the music the damage chases the beat across the wall — and
every cell holds a different moment, so one kick arrives in each cell at a different time.

## The chromatic sweep

A colour front travels across the wall and passes, once every ~7.7 s at Rate 1, wrapping at
the edge so it never stops — the owner's "goes through". It is the one *global* degradation,
so it is what ties the cells together rather than separating them, and it has its own knob
so it can run across a clean wall or a broken one. Its fringe is displaced cell-locally, so
it never smears one moment into its neighbour.

## Aspect: every grid, not just the square ones

Tile repeats the source into the *same* frame, so a cell measures `W/cols` by `H/rows` and
its aspect is `(W/H) x (rows/cols)`. That equals the source's aspect **if and only if rows
equals cols**. Every non-square grid was stretching the picture to fill a slot of the wrong
shape, and the rendered aspect *was* `rows/cols`, exactly. Measured on a true screen circle
through this component, before the fix:

| grid | 3x3 | 4x2 | 2x4 | 8x12 | 4x5 |
| --- | --- | --- | --- | --- | --- |
| rendered aspect | 1.000 | 0.500 | 2.000 | 1.333 | 1.200 |

The wall shipped 4x5. It went unseen because the grid was square for the whole of the
component's first life — and it was about to get much worse, because Churn drives the grid
through its most non-square states on purpose.

The fix is a **fit inside the cell**, not a change to the grid (§V118: *letterbox the
output inside the surface, centred — never stretched*). It is a pre-scale of the source
before Tile, which works because the distortion depends only on `cols/rows` and is
therefore identical for every cell: scale by `(sx, sy)` and a feature lands at
`(sx/sy) x (rows/cols)`, so `sx/sy = cols/rows` restores it exactly.

**Crop, not letterbox**, and deliberately. Bars between every cell would fragment the grid
and eat the density the effect lives on — a wall of faces wants faces, not mattes. And crop
keeps both scale factors at or above 1, so nothing ever samples outside the source: there
are **no bar regions**, which means the delay map's cell identity still matches the visible
content everywhere and §V849 has nothing to catch. A letterbox would have put pixels
belonging to no picture inside cells the map addresses by index.

The internal resolution pin is `fit`, not `fixed`, for the same reason one layer up: a hard
512x288 would force 16:9 on whatever arrives, so a 4:3 camera or a portrait clip would be
stretched before the wall had done anything at all.

The gate is **non-square only** — 4x4 is deliberately absent, because a square-grid test
cannot fail here.

## The wall re-cuts itself

`Churn` sweeps rows and columns. On this instrument that is not a layout change: every cell
holds a different moment, so changing the count **redistributes which moments are on
screen**. It is a re-cut, and it is cheap — `tile.repeat` is a plain uniform and so is every
shader's grid, so a sweep recompiles nothing and reallocates nothing.

Two sample-and-hold oscillators at unrelated slow rates (16 s and 24 s) *hold* a grid and
then jump, so the wall rests and then strikes rather than wobbling. Rows and columns move
independently, so it goes non-square — 1 × 1 to 10 × 11 and back. `repeat`'s `range: "floor"` lands
every value on an integer, so the jump is a hard re-cut rather than a smear; that snap is
the effect and is not smoothed away.

**Both axes run 1 to 16, and 1 is a setting rather than a floor to avoid.** A 1 × 1 wall is
the whole frame at a single delay — the grid *collapsing to one image* — and swept down
from ten and back it is a gesture. An earlier build clamped the floor at 2 because a hold
parked the wall at 2 × 2, where four copies of a sparse frame is not a wall; that objection
does not reach 1, where one copy of the frame is simply a picture. Turn Churn up rather
than Rate: the range is what makes this dynamic, the clock is what would make it hectic.

## The recolorizer

Ramp into Lookup, which is the standard way to put a whole wall on one palette. Luminance
is the index, so every cell's brightness becomes a hue and a dozen independently-lit
moments land in one colour world. The ramp's **phase walks on the free-running clock**, so
the palette rotates through the wall over about 23 seconds.

**Blues, purples and reds. No yellows** — the warm band is removed rather than compressed,
because dodging part of a palette is not the same as not having it. No stop reaches 1.0
either, so the grade has headroom left before the transfer.

The palette is *cyclic* — its first and last stops are the same colour — because phase
wraps the gradient's axis and a palette that did not close would sweep a hard seam across
the wall once a cycle. The index is compressed into 0.08..0.78 to stay clear of that wrap
and to stop a soft body being painted as concentric rainbow rings.

**A `limit` guard clamps to 0..1 before the palette**, and it is one node fixing two
things at once. Everything upstream can exceed 1 — the parent lights the source, `Crush`
multiplies contrast — and a Lookup *indexes* by luminance, so an over-1 pixel walks off the
end of the palette onto its dark closing stop: the brightest thing in the frame rendered as
the darkest colour, which is where the teal cores came from. The dry side had the same
problem one step later, where it simply clipped.

`Colour` is a master tint over the palette, defaulting to white so it has a true identity
and its whole range to move in.

## Audio: wired, switch-ready, and driving two different things

`source1` is a `valueSwitch` — E24's shape, and it has to be a switch rather than a wire:
two audio sources landing on one value port *merge*, and both publish the same channel
names, so the later edge would win and the other source would vanish with the graph still
looking right. A `valueSwitch` is exclusive by construction.

- **Index 0 (shipped)** is `music1`, an Audio Pattern at 124 bpm. It stays the default:
  a shipped example must not open a device, and every gate has to see the same performance
  twice.
- **Index 1** is `track1`, an Audio File In with an empty File waiting. Drop a track on it,
  flip the index, and everything downstream follows because everything downstream reads
  `source1`.
- **A microphone is deliberately absent.** An unselected *texture* `switch` branch is NOT
  pruned — measured on this very graph: `cut1` and `cam1` both emit passes while sitting on
  index 1 — and a shipped `audioIn` opens the device on load. To add one, drop an Audio In
  beside `track1` and wire it to `source1.in3`; the value switch will keep it silent until
  you select it, but the device opens regardless, so it is yours to add and not ours to
  ship.

Two envelopes off that one source, because the piece has two timescales:

- `env1` (110 ms) carries the **low** band to the body's **radius** — the kick as a swell.
  The wall's cascade then turns one kick into a wave rolling across the grid.
- `snap1` (35 ms) carries the **high** band to `flare1.brightness` — the hats, kept
  transient. And that is how the audio reaches the *damage*: the vocabulary arms a cell in
  proportion to that cell's own brightness, so lifting the source on a transient makes more
  of the wall break. No channel crosses the component boundary.

Both are enveloped off the band's own floor. Audio Pattern's `low` rests at 0.713 and peaks
at 0.975, so a raw drive would be a body that never shrinks.

### The knobs that cannot be driven yet

A component's *published* parameters cannot be animated at all today: the compiler resolves
an instance's page with no node reader and no frame, and the flattening is memoized on the
document revision. So `Glitch`, `Chroma`, `Churn` and `Blend` are static here even though
every one of them wants a hand on it. That is filed and being fixed; when it lands, those
four become the obvious audio targets and nothing in this document has to change except the
slots. Everything that *does* move inside the wall — the burst trains, the sweep, the
palette phase, the churn — is driven from **inside** the component, where an internal node
is flattened into the parent graph and resolved with the frame like any other.

## Rest, then strike

The source used to wobble continuously on four sine LFOs. It does not any more: the lead
body is on **sample-and-hold plus a Lag**, so it is still for several seconds and then
swoops somewhere. The second body keeps a slow sine, and dropping it would have been a
mistake — a wall whose source is perfectly still shows the *same* frame in every cell,
because a dozen different moments of a still picture are one picture. So the composition is
a calm continuous element for the cells to differ by, and a striking one to watch.

## What this example is a gate for

- Tile into Slit Scan with a per-cell map, which is where the per-cell delay either works
  or silently collapses to one warp.
- A per-cell effect that is deterministic from a seed: the same seed is the same wall
  twice, a different seed is a different wall, and at Glitch 0 the seed is inert
  byte-for-byte.
- Aspect preserved at NON-SQUARE grids, which is the case the rest of this file's claims
  were all blind to — every one of them ran at 4x4, the one shape where the fault does not
  show.
- Damage that comes in BURSTS rather than held states — asserted across consecutive frames,
  which is the only place an envelope is visible.
- A degradation that cannot reach the clip, asserted as a property (no pixel is pushed onto
  the sink's ceiling) rather than as a level.
- Damage that never BRIGHTENS a cell, asserted in linear light over every kind at once —
  the gate the "too bright" reports should have had, and the one that would have caught a
  silhouette lift hiding inside a noise function.
- An internal component parameter animating on the free-running clock, which is the
  standing evidence for the half of the component model that *does* work.
- A library component whose whole interface is a texture in, a texture out, and eight
  numbers — the second example to instance one, and the first whose component is a
  *performance instrument* rather than a converter.
- The uniform-only grid change, asserted on the plan rather than on the picture.
- Slit Scan's `frames - 1` arithmetic, asserted exactly: at a 4 x 4 grid on a 61-frame ring,
  cell *k* shows the frame exactly *4k* back, checked against a Uniform-mode render of the
  same graph at that frame, byte for byte.
