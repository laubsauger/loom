# E6 — Displacement Stack

A checkerboard melting under a field built up over three nodes. The field arrives at
`displace.disp` as **the numbers the Noise node produced**, with nothing converted along
the way.

The point is not the warp; it is that unconverted arrival.

## Graph

```
plate(checker) ────────────────────────────► warp.source ─► warp(displace) ─► output
field(noise, perlin4d) ─► shape(level) ─► place(transform) ─► warp.disp
      speed 0.1                              r ← abstime
```

| Node | Type | Doing |
| --- | --- | --- |
| `plate` | `checker` | the image being displaced |
| `field` | `noise` | perlin4d, 2 harmonics, `speed 0.1` — the raw field, evolving |
| `shape` | `level` | remaps the field's usable range |
| `place` | `transform` | scales the field and turns it at 4°/s relative to the plate |
| `warp` | `displace` | `weight [0.18, 0.13]`, `offset [0.5, 0.5]`, x←red, y←green |

## Two motions, because the branch has two jobs (T518)

The field was `simplex2d`, which has no time axis — `speed` advances a noise field's
*fourth* dimension — so the plate was frozen: mean |Δ| of exactly 0.00 between rendered
frames. It is `perlin4d` now.

But there are deliberately **two** things moving, and they are the argument for the stack
being a stack. The field **evolves** (that is `field.speed`, and `shape` decides what range
of it is usable) and it is separately **placed** (that is `place.r`, which decides where it
lands over the plate). Watching those two independently is the clearest statement of why
shaping and placing are different nodes.

`place.r` reads `abstime`, the absolute clock, so the rotation carries through a timeline
loop instead of snapping back.

## What it proves

- **§V56 / §V57 — space discipline down a stack.** The working space is linear. Every node
  in the displacement branch inherits its format from its input, so the branch holds one
  space from `field` to `warp.disp` and nothing along it decodes, encodes or tone-maps. A
  displacement field is coordinates, not light; converting it would move every pixel by the
  wrong amount, and it would not look like an error, it would look like a slightly different
  warp.
- **The compiler names a mismatch, it never converts silently.** The control case is in the
  gate: force `place` to `rgba8unorm-srgb` and the compiler reports a
  `colorSpaceMismatch` on `warp`, naming the conversion node to insert. Without that control
  the "no mismatch" assertion would also pass on a build where the check was simply broken.
- **A `data` input beside a colour one is normal.** Also in the gate: with `field` overridden
  to `r32float` the whole branch resolves to `space: "data"`, the mismatch check exempts it
  entirely, and `warp`'s own output stays `linear` because Displace inherits from `source`.

## What this example deliberately does not do

**It does not flag the field as `data`.** §V56 says a texture carrying non-colour data is
flagged `data` and bypasses every conversion, and the compiler derives that flag from the
format — `r32float` is the only format in the catalogue that produces it. But the plan binds
**one shared sampler, created with linear filtering, to every texture**, and `r32float` is
not filterable on WebGPU without the optional `float32-filterable` feature, which a baseline
Tier B device is not required to have. An example built that way would not render.

So the shipped file takes the renderable path — an all-linear branch that converts nothing —
and the `data` path is covered as a compile-only case in `concepts.test.ts` beside it. Making
`data` shippable needs the plan to carry per-resource sampler filtering, or the space flag to
come from the port type rather than from the format. Until then this is the honest version.

## What to look at

- **`warp.offset` is `[0.5, 0.5]`** because the Noise output is a 0..1 field, so 0.5 is "no
  displacement". For a signed field it would be 0. Together with `sourcex`/`sourcey` these
  three parameters are the entire contract between the two branches; leaving them at their
  defaults happens to work here and would not if the field were signed.
- **`shape`'s window is 0.33–0.67, and its midpoint is the part that matters.** A 4D
  perlin's usable range is narrower than a 2D simplex's, so the old 0.2–0.8 window gave a
  visibly weaker warp on the new field at the same weight. The window narrowed and the
  **centre stayed at 0.5** — because `warp.offset` above is 0.5 and means "no
  displacement", and that contract survives only while the shaping stays centred.
- **`shape` before `place`, not after.** Level remaps values; Transform moves them. Shaping
  after placing would shape the *resampled* field, including its edge behaviour, which is
  how a displacement stack picks up seams nobody can find.
- **`place.extend` is `mirror`.** Whatever the field does outside 0..1 becomes the
  displacement at the border of the plate, so the extend mode is a visible parameter of the
  warp, not a detail.

## Verified by

`src/examples/runner.test.ts`, `src/examples/concepts.test.ts` (one space across the stack
and no mismatch diagnostics; the encoded-branch control case; the `r32float` `data` case).
