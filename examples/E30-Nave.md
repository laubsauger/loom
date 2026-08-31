# E30 — Nave

You are inside a cathedral of light and it is moving toward you. Sixty fluted ribs of
glowing points recede to a vanishing point and slide past forever; on the kick the whole
bore **opens** — the tunnel widens by half a radius and settles over the beat — and the
ribs brighten with it. The frame drifts, because a locked-off camera inside a symmetric
tunnel reads as a target rather than as a space.

It fills the corner nothing in the set filled: **E24 is audio and 2D, E25 is 3D and silent,
this is the crossing.**

## Graph

```
beat1(audioPattern 120bpm) ─► swell1(lag 0.11) ─┬─► bgain1 ─► bore1(valueLimit)  ┄ value1
                                                └─► lgain1 ─► lum1(valueLimit)   ┄ value2
palette1(ramp, 6 stops) ──────────────────────────────┐
                                                      ▼
grid1(pointGrid 176×60) ─► bridge1(textureToAttribute) ─► roll1(pointKernel) ─► ribs1(geometry:
                                                                     instances, tint ← sample)
                            glass1(materialUnlit) ────────────────────┘
sway1, rise1 (lfo) ┄ eye1(camera, inside the bore) ─► shot1(render) ─┬─► halo1 ─► haze1 ─┐
                                                                     └───────────────────┴─► burn1 ─► out1
```

| Node | Type | Doing |
| --- | --- | --- |
| `roll1` | `pointKernel` | turns a plane into a tunnel: x goes around the bore, y indexes the rib, `absTime` scrolls it |
| `bridge1` | `textureToAttribute` | reads `palette1` at each point's grid position — the colour is a **gradient in the graph**, not a formula in WGSL |
| `bore1` / `lum1` | `valueLimit` | the two fenced audio channels, into `ctx.value1` / `ctx.value2` (T479): values per frame, never a rebuild |
| `sway1` / `rise1` | `lfo` | free-running camera drift (§V436), so it survives a lap too |

## Every line of this is a decision about which clock

The rib motion is a **position read off a clock** — `fract(rib + t · 0.052)` — which is
exactly the shape that breaks at a loop boundary. On `ctx.time` the whole tunnel would jump
back a third of a rib at every lap, forever, in precisely the setting a VJ example is for.

It reads **`ctx.absTime`** (T489/B97), so the scroll is continuous across a lap and the
example still reproduces offline, because absolute time is frames-since-transport-start and
T467 zeroes it at render (§V44, §V45).

Its neighbours own **different** clocks, and that is §V436 working rather than an
inconsistency:

| | clock | why |
| --- | --- | --- |
| `roll1` | free-running (`absTime`) | the tunnel is "always going"; a lap must not touch it |
| `sway1`, `rise1` | free-running | the same, for the camera drift |
| `beat1` | timeline-anchored | it stands in for a track, so bar one lands on the in point |

## Where the colour lives, and why it is not in the kernel

The obvious way to colour ten thousand points is six lines of cosine palette in WGSL, and it
would look the same. It is a **Ramp** instead, read through `textureToAttribute` at each
point's own grid position — because a gradient you can drag stops around in is worth more in
a node tool than a gradient you have to recompile, and because the whole reason this file
exists is to be opened and messed with. The kernel does only the one thing the ramp cannot:
fade a rib by how far away it ended up.

Since depth is `fract(rib + t)`, reading the palette along the rib index *is* reading it
along depth, rotating slowly — which is why the far end changes colour as the shaft scrolls.

## Two fades, and the near one is not optional

A quad has a fixed **world** size, so a rib three units from the eye draws as a fistful of
blocks; the first build looked like the tunnel was made of postage stamps. And a scrolling
tunnel has to recycle its ribs somewhere, and a recycle is a teleport.

Both are solved by the same term. Depth 0 sits **behind** the camera, so the teleport
happens where nobody is looking, and `smoothstep(2.0, -2.4, z)` fades a rib out as it passes
the eye. It hides the pop and the blockiness at once, and it is also just what atmosphere
does to a real corridor.

## Unlit, and that is not laziness

`materialUnlit` with a per-point tint (T478), no lights, and a wide bloom. The points **are**
the light here. A lambert response on ten thousand tiny quads would only make them grey where
they face away, and the shot is a light source rather than a lit object.

## Regression signatures

- **The tunnel jumps backwards once per timeline lap** → the kernel went back to `ctx.time`.
  This is the whole reason the example is written the way it is.
- **The near ribs are chunky blocks** → the near fade term went, or `ribs1.scale` grew.
- **A ring flashes into existence in the middle of the frame** → the recycle point moved in
  front of the camera; `z` must start behind `eye1`.
- **The bore stops breathing on the kick** → `value1` lost its channel, and the retained
  0.16 is a perfectly plausible static radius, so nothing else looks wrong.
- **One colour everywhere** → `palette1.period` moved off 1; the ramp compresses rather than
  tiles, so anything above 1 collapses the shaft to a single hue.

## Look pass

Rendered on Dawn at 1280×720 and inspected at frames 300 and 700 (§V383), plus at 220px
thumbnail width.

**Correctness.** The ribs scroll continuously, the bore widens on the beat, and the camera
drift keeps the frame from being perfectly symmetric.

**Beauty (§V420).** **Ships**, with one honest reservation: it is the least surprising of
this batch. It is a good tunnel — the scalloped bore is genuinely handsome and it reads at
thumbnail size — but a point tunnel is a shape a lot of people have seen, and E13 and E16
already put points in space. What earns it its place is the corner it fills and the clock
discipline it demonstrates, not novelty. Six builds: the first was postage stamps, the
second a polka-dot field (too few points around the bore), the fifth an experiment with a
tiled palette that made it worse and was reverted.
