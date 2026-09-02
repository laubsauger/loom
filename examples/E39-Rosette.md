# E39 — Rosette

A mandala built out of a video signal: rings and petals wheeling around a still centre.
Underneath it is one image being read in polar coordinates.

The petal count answers the kick, the depth breathes on the snare, and the whole figure
turns once every twenty-seven seconds. It is not a kaleidoscope and not a tunnel — the
polar read is the oldest trick in live visuals, and the one this catalogue could always do
and had never shown.

**It opens playing its own performer, and your footage is one number away.**

## Graph

```
stand1(noise, perlin4d) ─┐ order 0
                         ├─► pick1(switch, index 0) ──────────────► warp1.source
clip1(movieFileIn) ──────┘ order 1                                      ▲
                                                                        │
ang1(ramp, circular) ─► angfix1(transform) ─┐                           │
    phase ┄ spin1, period ┄ petal1          ├─► field1(reorder) ────────┘ warp1.map
rad1(circle, distance) ─► depth1(level) ────┘   r = theta, g = rho
                              gamma ┄ deep1

warp1(remap, extend mirror) ─► paint1(lookup) ◄─ palette1(ramp)
                                    │  scale ┄ hue1
                                    ├──────────────► burn1(add) ─► trim1(level) ─► out1
                                    └─► halo1(blur) ─► haze1(level) ─┘

beat1(audioPattern) ─► smooth1(valueLag) ─┬─► petalg1 ─► petalb1 ─► petal1(valueLimit)
                                          ├─► deepg1 ─► deepb1 ─► deep1(valueLimit)
                                          └─► hueg1 ─► hueb1 ─► hue1(valueLimit)
spin1(lfo, saw 0.037 Hz)
```

## A polar warp is not a node

The brief that produced this file called log-polar "probably the single most versatile
missing primitive" in the catalogue. It is not missing, and finding that out took one
render rather than one node.

Remap takes a uv **field** and samples its source at whatever coordinates that field
carries. So a warp is never a question of which warps we implemented — it is a question of
who builds the field, and four existing nodes build this one:

| what | node | why that one |
| --- | --- | --- |
| theta | `ramp` type `circular` | its coordinate is already `atan2(dy, dx)` normalised to 0..1 |
| rho | `circle` mode `distance` | unclamped, aspect-aware, linear in radius |
| pack | `reorder` | red from one input, green from the other — the only node that can |
| apply | `remap` | the field **is** the coordinate, not an offset |

Nothing here is special-cased to "polar". Swap the two generators and the same four nodes
build any coordinate map you can draw.

## Three details that are load-bearing, all of them measured

**Aspect.** `ramp(circular)` computes its `atan2` in **uv** space, so on a 16:9 frame the
rays come out elliptically spaced and the figure squashes. `angfix1` samples the ramp
through a transform scaled by `1/aspect` with `aspectcorrect` off, which works out to
`atan2(dv, du * aspect)` — the angle in **pixel** space. One node, and it is the difference
between a rosette and an ellipse.

**Radius comes from Circle, not from `ramp(radial)`.** The radial ramp is
`clamp(length(uv - 0.5) * 2, 0, 1)`. Everything outside the inscribed circle — all four
corners, about a fifth of a 16:9 frame — pins to a single flat value and renders as dead
blocks. Rendered side by side, that is not subtle. Circle's distance mode emits
`k * (rNorm - 1)` with `k = min(0.5/aspect, 0.5)`, so `level(blacklevel = -k,
whitelevel = 0)` recovers normalised radius **exactly**, unclamped, and `gamma1` then curves
it into depth.

**Extend is `mirror`, not `repeat`.** Rho runs past 1 toward the corners and has to come
back somehow. Repeat *fracts* it, which is a discontinuity, and it showed as a stair-stepped
arc wherever the map crossed 1.0. Mirror folds instead of jumping, so the rings reflect and
there is no seam to see. That rho can exceed 1 at all is the `rgba16float` working format
doing its job — in an 8-bit format the field would have clipped and the outer rings would
not exist.

## Not a tunnel, deliberately

E1 already puts a transform inside a feedback loop, and E29 already scales one past 1.0 to
fall down a corridor. A third tunnel would teach nothing. This is the *other* thing the
polar map is for: repetition **around** the circle rather than travel **into** it. That is
why the driven parameter is the ramp's `period` — how many times the source wraps the
angular axis — and not a scale.

## What the audio actually does

Three gain-and-bias pairs, each mapping one band to one property with its own scale and
offset, and each ending in a `valueLimit` that states the range out loud:

- **low → `ang1.period`**, clamped 3..11. The kick multiplies the petals.
- **lowMid → `depth1.gamma1`**, clamped 0.6..4.5. The snare pushes the rings out from the
  centre and lets them fall back.
- **highMid → `paint1.scale`**, clamped 0.45..1.9. The hats slide the whole picture along
  the palette, so the colour breathes with the top end rather than sitting still.

`smooth1` is a `valueLag` at 0.09 s between the analysis and all three, so none of them
jitters on a single frame's noise. `spin1` is a free-running saw at 0.037 Hz — one turn
every twenty-seven seconds, on the absolute clock, so a timeline lap cannot snap it.

Swap `beat1` for an `audioFileIn` and point it at a track; the three pairs are already
scaled for the analyser's decibel domain, which is what the pattern node publishes in.

## The understudy

`pick1` opens on branch 0, a four-dimensional noise with a real `speed`, and `clip1` is
still in the graph, still in the plan, and still compiled on a real device by
`examples.gpu.test.ts`. Set `pick1.index` to 1 and drop a file into `clip1` and it is your
footage — the polar field does not care what it is sampling. A `webcam` wired as branch 2
works the same way, and E27 is the file that established the pattern.

Before this example and E40, **no example in the set used `movieFileIn` at all**, so its
shader had never been compiled by the one integration gate we have — the same hole that let
`webcam` ship dead for months.

## The palette had to be balanced by light, not by numbers

`palette1` is seven stops from near-black blue through indigo, teal and violet to rose, gold
and white. The first version of it looked balanced as authored numbers and played back as
red over black.

Ramp stops are declared in **display** space and decode to linear, which costs a dark cool
colour most of its luminance while a bright warm one barely moves: `[0.05, 0.36, 0.55]`
lands at linear `[0.004, 0.106, 0.267]` and simply reads as black next to a gold that stays
bright. The cool half is lifted until it carries comparable **light**, which is not the same
as comparable numbers.

## And the bloom nearly took the picture with it

`haze1` used to be a Level with `blacklevel: 0.68`, the obvious way to say "bloom only the
highlights". It is a trap. A positive black level is a **subtraction**, the working format
is float, and nothing clamps: every pixel below 0.68 — nearly all of them — went negative,
as far as −2.1, and `burn1` then *subtracted* the bloom everywhere it was not blooming.
Measured at the liveness probe size, `paint1` spanned 0.545 and `burn1` came out at 0.115.

`gamma1` is the threshold that cannot go negative: `signedPow(c, 1/gamma)` with gamma below
one crushes the midtones and keeps the highlights, and the same picture then measures 0.970.
Every bloom already in the catalogue uses `blacklevel` 0 or 0.01, which is why none of them
had hit this.

## Numbers

Look baseline (§V643), measured by the liveness instrument at 192×108 and updated in the
same commit as any look-changing edit — see `src/examples/look-baselines.json` for the
current row rather than trusting a number copied into prose.
