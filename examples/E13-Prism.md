# E13 — Prism

The showcase. A swarm of individually coloured sparks behind a lens of glass, refracted
three times at three refractive indices and reassembled channel by channel, with the lens
following your pointer and breathing on an LFO.

Every other example here demonstrates *one* mechanism. This one exists because someone who
has read twelve single-mechanism files still has not seen them in one frame, and "in one
frame" is the actual product claim.

## Graph

```
swarm1(pointKernel) ─► sparks1(renderPoints) ─► roll1(transform) ─► field1.in1
backdrop1(ramp) ──────────────────────────────────────────────────► field1.in2
field1(over) ─┬─► bendR1(displace) ─┐
              ├─► bendG1(displace) ─┴─► fuse1(reorder) ─┐
              └─► bendB1(displace) ────────────────────┴─► prism1(reorder) ─► out1
lens1(circle) ─► normals1(slope) ─► the `disp` input of all three

mouse1 ─► follow1(lag) ┄drives┄► lens1.center.x/.y
pulse1(lfo, square) ─► ease1(lag) ┄drives┄► lens1.radius.x/.y
roll1.r = "time * 7 % 360"                              an expression
sparks1.color ← `tint`, sparks1.sizePixels ← `pscale`   the map mode
```

| Node | Type | Doing |
| --- | --- | --- |
| `swarm1` | `pointKernel` | 2400 points on a woven, breathing band; writes `tint` (a spectral wheel) and `pscale` |
| `sparks1` | `renderPoints` | additive sprites, **colour and size both mapped to attributes** (T364) |
| `roll1` | `transform` | rolls the light field, angle from an expression |
| `backdrop1` | `ramp` | a dark radial field — dispersion needs colour everywhere, not just on the sparks |
| `lens1` | `circle` | a soft **dome**, not a disc: `softness` past the radius. Centre and radius both driven |
| `normals1` | `slope` | `mode: normal` — the dome's gradient becomes the lens's normal field |
| `bendR1/G1/B1` | `displace` | one scene, three refractive indices: −0.75, −1.05, −1.4 |
| `fuse1`, `prism1` | `reorder` | red from R, green from G, blue from B |
| `mouse1 → follow1` | value graph | the pointer, smoothed — the glass has weight |
| `pulse1 → ease1` | value graph | a square wave through a one-pole smoother: an ease |

## What it proves

**Dispersion, out of nodes that were not built for it.** There is no per-channel Displace
and none is needed. Refract the same scene three times at three strengths, then take red
from the first, green from the second and blue from the third through two Reorders. Blue
bends furthest, as it does through glass. One scene and one normal field feed all three
refractions, so §V6 renders each of them once — the cost of the effect is three samples of
an image that already exists.

**Per-point colour is why there is a spectrum to bend (T364, §V313).** `sparks1` maps its
whole `color` compound onto the kernel's `tint` attribute and its `sizePixels` onto
`pscale`, so 2400 sprites carry 2400 colours and 2400 sizes. With *both* mapped the sprite
pass's params struct would be empty — WGSL refuses an empty struct — so the uniform block
disappears entirely and the draw carries no uniforms at all. A uniform-coloured swarm
disperses into grey fringes; a spectral one disperses into a spectrum.

Those values are **linear** by declaration: a point attribute is data (§V56/§V57), nothing
display-decodes it, and the kernel's cosine palette writes linear light directly. The
attribute is `color`-qualified (§T287), which is what a colour-space operation would convert
and what a spatial transform must leave alone.

**Three ways to move a parameter, doing three different jobs.**

*The value graph (§V179), twice, and both times it is the canonical chain.*
`mouse1 → follow1(Lag) → lens1.center` gives the glass weight: the pointer is the target,
the Lag is the mass. `pulse1(LFO) → ease1(Lag) → lens1.radius` breathes it. The LFO is a
**square** wave on purpose — a square through a one-pole smoother *is* an ease, so the Lag's
contribution is visible rather than theoretical. Delete `ease1` and the lens snaps between
two sizes like a shutter. That is the entire argument for having a Lag node, and it is why
the concept test counts distinct radii instead of checking that a wire exists.

*An expression (§V71) rolls the light field.* `time * 7 % 360` is written where it is read
— no node, no channel, no wire — and the `%` is load-bearing: Transform's `r` is clamped to
±360 by its manifest, so the wrap belongs in the expression. Being honest about the scope:
the v1 grammar is arithmetic only, so an LFO with a saw shape could produce this same ramp.
What the expression buys here is locality, not reach.

*A kernel (§V45) animates the swarm.* `ctx.time` arrives through the same frame contract
everything else uses, and the kernel is **stateless** — position and colour are functions of
the slot index and the clock — so frame N is the same picture whether it was replayed from
zero or arrived at live.

## What breaks here first

**The Reorder channel selectors.** Leave `fuse1.outg` at its `in1g` default and every pass
still runs, the picture is still a refracted scene, and it is the red path three times over
with *no colour separation anywhere*. That is the failure that looks like success, so the
concept test follows each output channel back to the resource it actually comes from rather
than reading the node names.

**Equal weights.** Three refractions at the same strength compile, render, and produce a
refracted scene with no spectrum in it. The test asserts they are ordered, not merely
present.

**The map, silently falling back.** If `color` stopped being mapped, the uniform block
returns and 2400 identical sprites are drawn. The concept test asserts the *absence* of the
uniform block, with a control that forces the static colour back and watches the block
reappear — otherwise the absence could be a property of draw passes in general.

**The mapped attribute's name and type.** A vec4f is required for the compound head, and
the attribute must exist on the incoming pointset. Both refusals are by name (§V288), which
is the right behaviour and is one to hit while building rather than in the gate.

**The lens being a disc.** `softness` past the radius is what makes the Circle a smooth
dome; a hard disc's gradient is a ring one pixel wide and refracts almost nothing. Slope's
`strength` is at the manifest's maximum for the same reason — the dome's slope is one unit
of luminance across 0.6 uv, which is gentle.

## Where the seams still show

Stated rather than hidden, because a showcase is exactly where the temptation is to route
around a rough edge:

- **A point kernel cannot read the pointer.** `PointCtx` carries `index`, `count`, `time`,
  `delta` and `frameIndex` — no pointer. So the mouse cannot pull on the swarm itself, and
  the most obviously playable thing this composition wants is not expressible today. The
  mouse drives the lens instead, which is a good use and a smaller one.
- **The expression grammar is arithmetic only.** No `sin`, no `clamp`, no `min`. With `%`
  you can build a sawtooth and a wrap, and that is the ceiling; anything with a shape wants
  an LFO node. That is a real v1 boundary, not a gap in this file.
- **Per-point colour is on `renderPoints`, not `renderInstances`.** So the swarm is 2D
  additive sprites rather than lit 3D primitives with a camera. Both together — thousands of
  individually coloured lit solids — is not available yet, and it is the obvious next thing
  to want after looking at this.
