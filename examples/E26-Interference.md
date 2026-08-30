# E26 — Interference

Fine concentric rings, and a second copy of the same rings 16% larger and drifting
slowly across them. What you actually look at is neither: enormous spiral rosettes and
hyperbolic fans, dozens of times larger than any ring and moving far slower than
anything in the graph, sweeping through the frame and recomposing themselves
completely every few seconds.

There is no shader in this file, no simulation, no state and no temporal boundary. Nine
nodes and two oscillators running at 0.05 Hz.

## Graph

```
rings1(circle: distance) ─► gain1(level) ─► wrap1(limit: zigzag) ─┬───────► beat1.in1
                                                                  │
                                       warp1(transform) ◄─────────┘
                                             │  t.x ┄ driftx1, t.y ┄ drifty1
                                             └────────────────────────────► beat1.in2

beat1(difference) ─► tint1(lookup) ◄─ palette1(ramp, 5 stops) ─► out1
```

| Node | Type | Doing |
| --- | --- | --- |
| `rings1` | `circle` | `distance` mode — the signed distance from the centre, in red, unclamped, over the whole frame |
| `gain1` | `level` | the ring COUNT: `whitelevel` 0.007 is a gain of ~143 |
| `wrap1` | `limit` | `zigzag` folds that ramp into a continuous triangle wave — the rings |
| `warp1` | `transform` | the same rings, 16% larger, drifting; `t.x`/`t.y` driven |
| `beat1` | `difference` | the two readings, subtracted. This is the entire effect |
| `palette1` → `tint1` | `ramp` → `lookup` | indigo through teal to a warm highlight, indexed on RED |
| `driftx1`, `drifty1` | `lfo` | 0.05 Hz and 0.031 Hz — incommensurate on purpose |

## What it proves

**One generator, two readings, and the picture is the difference between them (§V6).**
`wrap1` is compiled as a single pass and consumed twice — once directly, once through a
Transform — so the ring field costs one render and the output is a comparison of it
against a moved copy of itself. Every other example in the set demonstrates fan-out as a
footnote about cost. Here it is the mechanism: delete one of the two edges and there is
no image at all.

**Emergence, and it is measured rather than asserted.** Set the Transform to identity —
scale 1, no drift — and the two branches become the same image, so the difference is zero
everywhere and the frame is exactly one colour. Measured on Dawn: the rgb-sum spread
across all 921,600 pixels is 0.00000. So every visible structure in the shipped frame
belongs to neither input. That control is in the gate, because "this is interference" is
a claim that a picture of rings would also satisfy at a glance.

**Rings from a distance field, not from a radial gradient.** Ramp's radial coordinate is
`clamp(length(uv - 0.5) * 2, 0, 1)`: it saturates at radius 0.5, so a periodic radial ramp
is flat in the corners — on a 16:9 frame, a fifth of the image. Circle's `distance` mode
publishes an unclamped, aspect-corrected signed distance across the whole frame instead.
Level then scales it (how many rings) and Limit folds it (the rings themselves). Three
small nodes, each doing one legible thing, and the chain reads as what it is: *how far
from the centre, wrapped*.

**Zigzag, not loop, and it is the anti-aliasing.** `loop` gives a sawtooth with a
discontinuity on every ring, and at an ~18px pitch those edges crawl and shimmer under the
drift. `zigzag` is `abs(fract(v/2) * 2 − 1)`: continuous everywhere, so the fine structure
resolves cleanly. This was the risk the pitch flagged as the one that decides whether the
example is good or is a screen door, and the triangle wave is the answer to it.

## The thing that would have made this a black frame

**Concentric rings are rotationally symmetric about their own centre.** The obvious way to
build a moiré is to rotate one copy against the other — and rotating a set of concentric
circles about its own centre produces the identical image, so the difference would be
exactly zero. Every wire connected, every pass running, nothing on screen.

What breaks the symmetry is a **translation** — which gives hyperbolic fringes with foci at
the two centres — and a **scale difference**, which gives concentric beat rings, one every
`1/(s−1) ≈ 6` rings. Both are present; the rotation is pinned at zero by test, with that
reasoning attached, so nobody "improves" this file by animating the angle.

## Why 1.16 and 0.05, specifically

They are one constraint, not two taste calls. A Transform at scale `s` reads the region
`0.5 ± 0.5/s`, and the drift shifts that window by up to its amplitude. At `s = 1.10` with a
drift of 0.07 the window ran 2.5% past the edge, and `extend: "mirror"` showed as a hard
mirrored band crawling along whichever edge the drift was pushing toward — visible in the
first render, invisible to every assertion in this file. `0.5/1.16 + 0.05 = 0.481` leaves a
~2% margin on all four edges, so the extend mode is never reached and the frame is clean
corner to corner.

## No tone map, deliberately

The peak channel value in a shipped frame is 0.9995 — nothing here exceeds 1.0, so there is
nothing for a curve to roll off and Reinhard or Filmic would only make the image darker.
The Output stays on `none`. Stated because the opposite instinct is reasonable: this is a
bright, additive-looking image, and it is not an over-range one.

## Regression signatures

- **A smooth gradient with no rings** → `wrap1`'s mode fell back to `clamp`, the
  parameter's own default. Everything still compiles.
- **A flat single-colour frame** → the Transform went to identity, or `beat1.in2` was
  rewired to something that is not `warp1`. This is the failure the control catches.
- **The image is dimmer and the contrast is gone, but it is still a moiré** → `tint1`
  went back to indexing `luminance`. The chain carries its value in red with green and
  blue at zero, so a luminance index reads the beat at 0.2126× strength.
- **A hard band crawling along one edge** → the drift amplitude or the scale changed and
  the Transform is sampling outside its input again.
- **The pattern loops every twenty seconds** → the two drift rates became equal, so the
  offset traces a closed ellipse instead of a Lissajous figure that does not close.
- **Fine rings shimmer and crawl** → `zigzag` became `loop`.

## Look pass

Rendered on Dawn at 1280×720 and inspected at frames 0, 60, 300 and 600 (§V383).

Frame 0 opens on a symmetric cardioid of rings — clean, centred, immediately legible as a
picture rather than as a test pattern, which is what §V363 asks of a file the moment it
opens. By frame 300 the composition is a large off-centre spiral; by 600 it is a different
one again. The first pass found the mirror seam described above, which no test would have
caught; the second pass is clean edge to edge. Verdict: **ships.**
