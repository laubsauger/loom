# E6 — Displacement Stack

A checkerboard displaced by a field that is built up over three nodes. The point is not the
warp; it is that the field arrives at `displace.disp` as **the numbers the Noise node
produced**, with nothing converted along the way.

## Graph

```
plate(checker) ────────────────────────────► warp.source ─► warp(displace) ─► output
field(noise) ─► shape(level) ─► place(transform) ─► warp.disp
```

| Node | Type | Doing |
| --- | --- | --- |
| `plate` | `checker` | the image being displaced |
| `field` | `noise` | simplex2d, 2 harmonics — the raw field |
| `shape` | `level` | remaps the field's usable range |
| `place` | `transform` | rotates and scales the field relative to the plate |
| `warp` | `displace` | `weight [0.08, 0.05]`, `offset [0.5, 0.5]`, x←red, y←green |

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
- **`shape` before `place`, not after.** Level remaps values; Transform moves them. Shaping
  after placing would shape the *resampled* field, including its edge behaviour, which is
  how a displacement stack picks up seams nobody can find.
- **`place.extend` is `mirror`.** Whatever the field does outside 0..1 becomes the
  displacement at the border of the plate, so the extend mode is a visible parameter of the
  warp, not a detail.

## Verified by

`src/examples/runner.test.ts`, `src/examples/concepts.test.ts` (one space across the stack
and no mismatch diagnostics; the encoded-branch control case; the `r32float` `data` case).
