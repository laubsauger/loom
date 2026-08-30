# E11 — Gradient Remap

Recolour an image through a palette. A noise field supplies structure, a five-stop Ramp
supplies the colours, and a Lookup reads each pixel's **brightness as a position along the
gradient** — so luminance becomes hue.

## Graph

```
noise1(noise, perlin2d) ──► lookup1.source ─┐
ramp1(ramp, 5 stops) ─────► lookup1.lookup ─┴─► lookup1(lookup) ─► out1(output)
```

| Node | Type | Doing |
| --- | --- | --- |
| `noise1` | `noise` | `perlin2d`, `period: 0.9`, mono — broad soft areas, so a hue has room to read |
| `ramp1` | `ramp` | five stops, smooth: indigo → magenta → red → amber → pale highlight |
| `lookup1` | `lookup` | reads `noise1`'s luminance as a position along `ramp1` and returns the colour there |

## What it proves

**Ramp into Lookup is how you recolour something.** It is the standard pairing, and it is
what multi-stop Ramp (T270) was built for. Two colours is the degenerate case — a tinted
greyscale, barely worth wiring. The fifth stop is what turns a gradient into a *palette*,
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
