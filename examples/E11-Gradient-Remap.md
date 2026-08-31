# E11 — Gradient Remap

Recolour an image through a palette. A drifting noise field supplies structure, a six-stop
cyclic Ramp supplies the colours, and a Lookup reads each pixel's **brightness as a
position along the gradient** — so luminance becomes hue, and the whole palette walks past
the field while you watch.

## Graph

```
noise1(noise, perlin4d) ──► lookup1.source ─┐
ramp1(ramp, 6 stops) ─────► lookup1.lookup ─┴─► lookup1(lookup) ─► out1(output)
   phase ← abstime                              offset -0.86, scale 2.6
```

| Node | Type | Doing |
| --- | --- | --- |
| `noise1` | `noise` | `perlin4d`, `period: 0.9`, `speed: 0.08`, mono — broad soft areas, so a hue has room to read |
| `ramp1` | `ramp` | six cyclic stops, smooth: indigo → violet → magenta → amber → teal → indigo, scrolling |
| `lookup1` | `lookup` | reads `noise1`'s luminance as a position along `ramp1` and returns the colour there |

## `offset` and `scale` — the fix for a palette you cannot see (T518 / T523)

At the shipped `offset: 0`, `scale: 1` the index was the field's **raw** luminance, and a
fractal noise does not span 0..1. Measured, this field runs from about **0.34 to 0.70**
with its median at 0.50 — so the lookup only ever read the middle third of the gradient.
The deep end and the pale end were never rendered at all.

An example whose entire subject is a multi-stop palette was showing two of its stops and
hiding the rest, and no assertion on this page could notice: every stop was present in the
document, every stop decoded correctly, and the picture was still wrong.

`index = luminance * scale + offset`. Solving that line through (0.34 → 0.03) and
(0.70 → 0.97) gives a slope of **2.6** and an intercept of **−0.86**, which are the two
numbers in the file. The tails clamp, which is what the Ramp's hold-outside-range behaviour
is for.

## Why the stops are cyclic, and why the phase moves

`ramp1.phase` reads `abstime`, so the palette walks past the field rather than the field
walking past the palette. Two reasons, and only one of them is that it looks good:

- It is the **proof** that all six stops decoded. You do not check one swatch and assume
  the rest (§V196's whole point) — you watch each one arrive.
- The last colour **equals the first**. `phase` scrolls a ramp by
  `fract((coord + phase) / period)`, so a palette whose ends disagree jumps every time the
  scroll wraps. Cyclic, it runs forever.

The field drifts too, at `speed: 0.08` — much slower than the palette. If the two moved at
similar rates they would beat against each other and the picture would read as noise.

## What it proves

**Ramp into Lookup is how you recolour something.** It is the standard pairing, and it is
what multi-stop Ramp (T270) was built for. Two colours is the degenerate case — a tinted
greyscale, barely worth wiring. The extra stops are what turn a gradient into a *palette*,
and this file is where that capability is actually exercised rather than described.

**The two inputs are not interchangeable, and the manifest says so.** Resolution inherits
`source` (the image whose shape survives); format inherits `lookup` (the output pixels
*are* the palette's pixels, so their colour space belongs to the palette, not to the
index). That split is the most opinionated thing in the Lookup node, and swapping the two
edges here would produce a palette-shaped image at the palette's resolution — visibly
wrong, not subtly wrong.

**A colour list decodes per entry (§V196).** The stops are stored in display space,
because that is what a colour picker hands over, and the resolver decodes each entry on
the way to the shader. The gradient you see is the proof that all five were decoded, not
just the first.

## What breaks here first

**The stop list.** §V196 exists because a list hides a colour bug: the eye checks one
swatch and assumes the rest, so a decode applied to entry zero and skipped for the others
looks *almost* right. Here it is a wrong palette. A skipped decode leaves the midtones too
bright and washes the hue out of them; a double decode drives them muddy and dark; a
dropped entry collapses two segments into one long fade and the image loses a colour it
had yesterday. All three are legible at a glance, which is the point of shipping this as a
picture rather than as a unit test.

**The uniform packing.** The stops compile to a flat table of sixteen `vec4f` plus a count
(T270), not a LUT texture. An off-by-one in that packing shifts every colour one stop
along — the gradient still renders, still looks like a gradient, and is wrong everywhere.

**The channel read.** `lookup1` indexes on luminance. If the source were read as colour
rather than as data, or the channel selector regressed, the remap would follow one
primary instead of brightness and the palette would land in the wrong places.
