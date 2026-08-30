# E8 — Slit Scan

Per-pixel time. Every **row** of the output shows a different moment of the input's
history — the classic slit-scan smear, made of nothing but a ring and a gradient.

## Graph

```
noise1(noise, perlin4d) ─► slitscan1.input ─┐
ramp1(ramp, vertical) ──► slitscan1.map  ───┴─► slitscan1(slitScan) ─► out1(output)
```

| Node | Type | Doing |
| --- | --- | --- |
| `noise1` | `noise` | `perlin4d`, `speed: 0.8` — a field that visibly evolves |
| `ramp1` | `ramp` | vertical black→white: the TOP row says "now", the bottom says "1.6 s ago" |
| `slitscan1` | `slitScan` | records 48 frames of history; each pixel reads the frame its map value names |

## What it proves

**Time can be a per-pixel quantity.** Cache reads ONE moment for the whole frame; here
the map's red channel picks the moment per fragment. The history binds as a single
`texture_2d_array` and the fragment shader indexes layers — a binding a fixed tap
cannot express, which is why T321 exists as its own task.

**The ring fills honestly (§V229).** For the first ~1.6 seconds the smear GROWS: a
displacement reaching deeper than the ring has recorded clamps to the oldest real
frame, never to an unwritten layer. If you see black bands on load, that clamp broke.

**The memory is the parameter (§V228).** 48 frames at 720p rgba16float ≈ 169 MiB, plus
one full-frame copy per frame to archive the newest slice — both stated on the
`frames` knob, not discovered by profiling.

## What breaks here first

The ring's copy-on-rotate order (V276: archive at frame entry, never mid-encode — the
writing frame has not submitted yet), the whole-array binding and its per-frame head
uniforms, and the §V229 clamp. A regression in any of them turns the smear into a
frozen frame, a one-frame-late echo, or a black flash — all of which this file makes
visible in the first two seconds.
