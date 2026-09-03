# E3 — Animated Noise Field

4D noise, evolving in time, warping itself. Two nodes of substance and one wire that goes
two places.

## Graph

```
field(noise, perlin4d) ─┬─► shape(level) ─► warp.source ─► warp(displace) ─► output
                        └────────────────► warp.disp
```

| Node | Type | Doing |
| --- | --- | --- |
| `field` | `noise` | `type: perlin4d`, `speed: 0.35`, 3 harmonics |
| `shape` | `level` | pushes contrast so the field reads as structure, not fog |
| `warp` | `displace` | displaces the shaped field by the raw field |

## What it proves

- **§V44 — time arrives as `FrameEvaluationInput`, never from a clock.** The Noise node's
  pass binds the shared frame block (`sharedBinding: "frameU"`) and its shader advances the
  fourth dimension as `t4d + absTime * speed` — the ABSOLUTE clock, free-running per
  §V436/T497, so a bounded timeline's wrap does not snap the field back (and a live seek
  does not rewind it, §T1098). Nothing in a node can reach `Date.now`, `performance.now`
  or `requestAnimationFrame` — it is lint-enforced across `src/nodes/**` — and offline the
  two clocks agree until a wrap, so the same `frameIndex` produces the same frame whether
  it came from the live scheduler, a timeline playhead, or an offline fixed-step render.
  That seam is why an offline renderer can exist without rewriting every node.
- **§V6 — a fan-out renders once.** `field` has two consumers and contributes exactly one
  pass; both consumers bind the same texture. If this ever became two passes, every
  generator in every project would silently double in cost, and the two copies could
  disagree.
- **4D noise as the TD animation idiom.** In TouchDesigner you animate a Noise TOP by
  driving Translate 4D, not by scrolling the 2D field. Scrolling slides features across the
  frame; the fourth dimension makes them *evolve in place*. That is the difference this
  example is here to show, and `speed` is the temporary seam standing in for a parameter
  expression until the resolver can bind time itself (§V61).

## What to look at

- **`field.speed`.** At `0` — TD's default — the Noise TOP is a still image. This example
  would compile, render, and prove nothing. The gate asserts it is non-zero.
- **`field.type`.** Switch it to `perlin2d` and the animation stops dead: only the 4D types
  read `t4d`. The pass keeps binding the frame block, so nothing errors; it just freezes.
  This is the quiet failure the parameter names are worth learning.
- **The self-displacement.** `field` drives both the image and the warp, which is the
  cheapest way to make 4D noise stop looking like 4D noise. No single Noise node can produce
  this, however many harmonics you give it.
- **`warp.offset` is `[0.5, 0.5]`.** The Noise output is a 0..1 field, so 0.5 means "no
  displacement". For a signed field it would be 0. Getting this wrong shifts the entire
  image by a constant and looks like a broken transform.

## Verified by

`src/examples/runner.test.ts`, `src/examples/concepts.test.ts` (frame-block binding, the
`perlin4d` type index, non-zero `speed`, one pass for two consumers sharing one texture).
