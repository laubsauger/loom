# E4 — Bloom

Drifting embers: sparse white-hot cores, each wearing a halo that falls off through amber,
red and violet into black. The standard bloom chain — isolate the highlights, blur them,
add them back — built on an **8-bit project** so that the per-node format override has
something to prove.

## Graph

```
source(noise, perlin4d) ─► hot(level) ─► floor(limit) ─┬─► bright(threshold)
                                                       │        │
                                                       │   glow(blur) ─► tint(lookup) ─┐
                                          palette(ramp) ────────► tint.lookup          │
                                                       │                        combine.in1
                                                       └──────────────────────► combine.in2
                                                                    combine(add) ─► output
```

| Node | Type | Format | Doing |
| --- | --- | --- | --- |
| `source` | `noise` | `rgba8unorm` (project) | `perlin4d`, `speed 0.12` — the field, evolving |
| `hot` | `level` | **`rgba16float`** | window 0.605–0.65: keeps the top ~2%, pushed to ~2.0 |
| `floor` | `limit` | **`rgba16float`** | clamps the level's negative floor to 0 |
| `bright` | `threshold` | **`rgba16float`** | keeps luminance above **1.1** |
| `glow` | `blur` | **`rgba16float`** | 40px |
| `tint` | `lookup` | **`rgba16float`** | the halo's chromatic falloff |
| `palette` | `ramp` | `rgba8unorm` (project) | six stops, crowded into the low end |
| `combine` | `add` | **`rgba16float`** | tinted glow plus the base |

## What it proves

- **§V51 — a per-node format override is instance state, applied at compile.** The project
  working format is `rgba8unorm`; six nodes override to `rgba16float`. Delete those
  overrides and the bloom does not dim, it **disappears**: `hot` clips at 1.0 in its own
  target and `bright` is looking for luminance above **1.1**, which a clipped 1.0 cannot
  reach. That is a one-line experiment and it is the example's whole point. The gate
  asserts both directions — with the overrides the branch is `rgba16float`, without them it
  collapses to `rgba8unorm`.
- **Multi-branch converge.** Two paths leave `hot` and meet at one Add. The compiler orders
  both before the composite and binds two distinct resources into it.
- **§V6 again** — `hot` is the shared half of the chain and is computed once, not once per
  branch. Bloom is the case where that matters: the shared half is the expensive one.

## What to look at

- **Why the override is on four nodes and not one.** A format override affects the node's
  own output target. `hot` producing over-range values into an 8-bit target has already lost
  them; so has `bright` writing its result into one. Every target the over-range values pass
  through has to hold them, which makes "where does the precision have to start" a real
  design question rather than a toggle.
- **`hot`'s window is read off the field, not chosen.** The noise measures p50 0.503,
  p90 0.584, p99 0.651, p999 0.694 in linear. A black point of 0.605 therefore keeps
  roughly the top two percent, and a white point of 0.65 gives them a gain of 22, so the
  survivors land between 1.0 and about 2.0. The Level node's white point is a remap, not a
  clamp: below 1.0 it is what pushes values *above* 1.0.
- **`palette`'s stops are crowded into the bottom of the range.** A blurred mask peaks
  around 0.23 and spends most of its area far below that, so a palette spread evenly over
  0..1 would map the entire visible halo into its first, near-black segment. The positions
  0.02 / 0.06 / 0.12 / 0.22 / 0.4 put violet, red, orange and amber where the pixels are.
- **`source` stays 8-bit.** Deliberately: the precision is needed from the point values go
  over range, not before it. An override on every node would render the same and would
  teach the wrong lesson.
- **`tint` is 16-bit for a different reason from `hot`.** It holds no over-range values at
  all. The halo is a wide, gentle gradient and eight bits band it visibly, so this override
  buys tonal *resolution*, not headroom. Two overrides, two arguments — which is the honest
  version of "where does the precision have to start".

## `floor` — the least obvious node in the file, and the one without which there is no picture

A Level's black point is a **subtraction**. Everything below it maps to a negative number,
and here the floor of the field lands at `(0.34 - 0.605) / 0.045 = -5.9`.

In an 8-bit target those clamp to zero for free. The moment you override to `rgba16float`
to protect the **highlights**, you inherit the **lows** as well — and `add` is
`front + back`, so composing the glow over a field sitting at −5.9 *subtracts* the glow
into oblivion.

Measured on Dawn before this node existed: the composite's 90th-percentile luma was
**0.004** while the glow layer feeding it measured **0.771**. An add that came out darker
than its own input, with every structural assertion in this file green. §V51's format
override has a second consequence, and `floor` is it.

## Why the source is `perlin4d` (T518)

It was `perlin2d`, and `speed` advances a noise field's **fourth** dimension — so a 2D type
has no time axis at all and there was no number anywhere in the product that could have
made this file move. It is not a tuning problem; the source had to change.

`t4d` is `0.37` rather than `0` for a related reason worth knowing whenever you animate a
4D field: zero sits on a **lattice plane**, where the gradient contributions from the *w*
neighbours cancel and the field's amplitude collapses. The first candidate for this file
measured mean 24 at frame 0 against 54 at frame 300 for that reason alone. Off the plane
the distribution is stationary — which matters twice over, because a gallery thumbnail is
usually frame 0.

## Verified by

`src/examples/runner.test.ts`, `src/examples/concepts.test.ts` (per-node formats, the
collapse-without-overrides control case, one pass for the fanned-out source, two distinct
resources into the composite).
