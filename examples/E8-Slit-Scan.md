# E8 — Slit Scan

Per-pixel time. A disc travels a path, and every **row** of the output shows it at a
different moment, so its history is drawn as a ribbon.

The ribbon's shape *is* the path — the classic slit-scan smear, made of nothing but a ring
and a gradient.

## Graph

```
swingx(lfo) ─┬─► body1.center.x
swingy(lfo) ─┴─► body1.center.y
body1(circle) ─┬─► slitscan1.input ─┐
               │                    ├─► slitscan1(slitScan) ─┐
ramp1(ramp, vertical) ─► .map ──────┘                        ├─► now(add) ─► out1(output)
               └─────────────────────────────────────────────┘
```

| Node | Type | Doing |
| --- | --- | --- |
| `swingx`, `swingy` | `lfo` | 0.62 Hz and 0.4 Hz — the disc's two coordinates |
| `body1` | `circle` | a soft warm disc on deep blue: the subject |
| `ramp1` | `ramp` | vertical black→white: the TOP row says "now", the bottom says "0.8 s ago" |
| `slitscan1` | `slitScan` | records 48 frames of history; each pixel reads the frame its map value names |
| `now` | `add` | the present, composited back over its own past |

## Why the subject is a disc and not noise (T518)

The owner's report was *"slit scan example is barely visible what it even does. not good
enough"*, and the cause is §V427 exactly. A slit scan reveals the **history of something
that has identity**. Noise is smooth at every scale, so smearing it produces more
smoothness: what shipped lived entirely between 0.35 and 0.61 in linear — a pastel wash
with no edge in it anywhere — and there was nothing in the picture for the smear to be a
smear *of*.

A disc on a path has identity. Its history draws a ribbon, and the per-row time
quantisation shows up as a visible **staircase** along the ribbon's edge. That staircase is
the node's mechanism made literal, and it is the thing the old file could not show.

The LFO frequencies are set against the ring's depth rather than by feel: 48 frames at
60fps is 0.8 s of history, and 0.62 Hz puts about half a swing inside that window — the
longest ribbon that still reads as a single gesture.

### `now`, and the black first frame

Compositing the live source back over the scan is a composition choice — you see the
subject *and* the trail it is leaving — and it also fixes a real defect. Before the ring
has archived anything there is no oldest frame for §V229's clamp to hold, so frame 0
rendered **completely black**. A gallery thumbnail is usually frame 0.

## What it proves

**Time can be a per-pixel quantity.** Cache reads ONE moment for the whole frame; here
the map's red channel picks the moment per fragment. The history binds as a single
`texture_2d_array` and the fragment shader indexes layers — a binding a fixed tap
cannot express, which is why T321 exists as its own task.

**The ring fills honestly (§V229).** For the first ~0.8 seconds the smear GROWS: a
displacement reaching deeper than the ring has recorded clamps to the oldest real
frame, never to an unwritten layer. If you see black bands on load, that clamp broke.

The depth in SECONDS is `frames / fps`, and this file sets no `fps`, so it runs at the
project default of 60: 48 frames is **0.8 s**, not 1.6. (The `previewFps: 30` in the
settings is the preview thumbnail's rate and has nothing to do with the ring.)

**The memory is the parameter (§V228).** The node's own formula is
`W × H × bytesPerPixel × (frames + 1)` — the history layers plus the write target. At
this file's 1280×720 and the project's rgba16float that is **≈345 MiB**, a third of the
1 GiB memory budget in the same settings block. Plus one full-frame copy per frame to
archive the newest slice. Both are stated on the `frames` knob, not discovered by
profiling.

## What breaks here first

The ring's copy-on-rotate order (V276: archive at frame entry, never mid-encode — the
writing frame has not submitted yet), the whole-array binding and its per-frame head
uniforms, and the §V229 clamp. A regression in any of them turns the smear into a
frozen frame, a one-frame-late echo, or a black flash.

What actually catches each of those is worth naming, because "visible in the first two
seconds" only helps someone who is looking:

| Symptom | What catches it |
| --- | --- |
| a fixed tap instead of per-pixel time | `concepts.test.ts` — the `history` binding is `array: true` with no `tap` |
| a ring too shallow to demonstrate anything | `concepts.test.ts` — `frames` is 48 |
| wrong rotate order, wrong head, broken §V229 clamp | `slit-scan.gpu.test.ts` on Dawn — every column reads exactly the frame its map value names |

Nothing gates the numbers above (0.8 s, ≈345 MiB); they are arithmetic over `frames`,
the project fps and the working format, and they were both wrong by a factor of two
until T366 checked them against the node.
