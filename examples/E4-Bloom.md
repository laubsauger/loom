# E4 — Bloom

The standard bloom chain — isolate the highlights, blur them, add them back — built on an
**8-bit project** so that the per-node format override has something to prove.

## Graph

```
source(noise) ─► hot(level) ─┬─► bright(threshold) ─► glow(blur) ─► combine.in1
                             └──────────────────────────────────► combine.in2
                                                                   combine(add) ─► output
```

| Node | Type | Format | Doing |
| --- | --- | --- | --- |
| `source` | `noise` | `rgba8unorm` (project) | the field |
| `hot` | `level` | **`rgba16float`** | pushes highlights past 1.0 |
| `bright` | `threshold` | **`rgba16float`** | keeps luminance above 0.9 |
| `glow` | `blur` | **`rgba16float`** | 36px |
| `combine` | `add` | **`rgba16float`** | glow over source, 0.85 opacity |

## What it proves

- **§V51 — a per-node format override is instance state, applied at compile.** The project
  working format is `rgba8unorm`; four nodes override to `rgba16float`. Delete those four
  overrides and the bloom flattens: `hot` clips at 1.0 in its own target, `bright` finds
  nothing above 0.9, and the glow disappears. That is a one-line experiment and it is the
  example's whole point. The gate asserts both directions — with the overrides the branch is
  `rgba16float`, without them it collapses to `rgba8unorm`.
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
- **`hot.whitelevel` is 0.72.** Below 1.0, which is what pushes values above 1.0 — the Level
  node's white point is a remap, not a clamp. This is the node that makes the image HDR;
  everything after it only has to avoid throwing that away.
- **`combine.opacity`.** Scales the *front* layer (the glow) before the add. Bloom intensity
  lives here, not in the blur.
- **`source` stays 8-bit.** Deliberately: the precision is needed from the point values go
  over range, not before it. An override on every node would render the same and would
  teach the wrong lesson.

## Verified by

`src/examples/runner.test.ts`, `src/examples/concepts.test.ts` (per-node formats, the
collapse-without-overrides control case, one pass for the fanned-out source, two distinct
resources into the composite).
