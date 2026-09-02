# E1 — Feedback Echo

A bright disc travels a slow figure and leaves a glowing ribbon of itself behind. The
ribbon is a **cycle in the graph**, not a buffer the renderer keeps for you.

The figure never quite repeats, and this example exists to show what makes such a cycle
legal.

## Graph

```
pathx(lfo) ─┬─► source.center.x
pathy(lfo) ─┴─► source.center.y
source(circle) ───────────────────────────────────────────────────► over.in1
echo(feedback) ─► drift(transform) ─► soften(blur) ─► decay(level) ─► over.in2
over(over) ─► out(output)
     ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄ echo.source: "over1" ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯
```

The dashed line is not an edge. Since T350 (§V285) a Feedback **names** the node it
records — `echo.source` is `"over1"` — so `edges` stays a DAG and nothing is wired into
`echo.in`. That port still exists for legacy documents; the editor only ever writes the
reference, and this file uses the reference. Read the loop as "echo replays over1's last
frame", not as a back-edge you could follow with your finger.

| Node | Type | Doing |
| --- | --- | --- |
| `pathx`, `pathy` | `lfo` | 0.31 Hz and 0.23 Hz — the disc's two coordinates |
| `source` | `circle` | the disc, on a transparent background so it composites |
| `over` | `over` | disc over last frame's decayed echo |
| `echo` | `feedback` | the temporal boundary; `persistence` 0.997 fades toward transparent |
| `drift` | `transform` | rotates 0.25° and scales 0.999 per frame, `extend: zero` |
| `soften` | `blur` | 1.4px, so the ribbon softens as it ages |
| `decay` | `level` | `blacklevel` 0.0015 — crushes the dimmest survivors to nothing |

## What it proves

- **§V4** — the current-frame graph is a DAG, and here it literally is one: the loop
  `over → echo → drift → soften → decay → over` closes through `echo.source`, not through
  an edge. What makes the cycle legal is that the only thing crossing it is `echo.out`,
  which the Feedback manifest declares temporal. Remove the Feedback node and wire the two
  ends together as real edges and the compiler must refuse the graph.
- **§V22** — the temporal output is backed by a **stable ping-pong pair**, allocated once,
  with its swap encoded after every current-frame consumer. Swapping early is the classic
  feedback bug and it does not crash — the loop just reads the half it is currently writing.
- **§V22 / T143** — the pair survives an unrelated structural edit. Adding a live branch
  elsewhere in the graph must not zero the history; that is the difference between a tool
  you can patch while it runs and one you have to restart.
- **Fade and transform inside the loop** — the decay is on the Feedback node's own
  `persistence`, which is what that parameter is for; `drift`, `soften` and `decay` are the
  loop doing real work between the two ends of the delay.

## Why the source moves (T518)

A feedback loop is only as alive as what you feed it. This file used to hold the disc at a
fixed centre, and a fixed source through a fixed loop reaches a **steady state**: rendered
on Dawn, the shipped frames were byte-identical from frame 90 onward, and ninety percent of
the picture was pure black. Nothing was broken. There was simply nothing to watch, and no
test could say so — every assertion on this page passed.

Two LFOs on `source.center` turn the disc into a pen, and the loop becomes the thing that
draws its path, which is what a feedback echo is *for*. The frequencies are **0.31 and
0.23 Hz**, deliberately incommensurate: two related rates would retrace one closed curve
and the piece would loop visibly.

The LFO is free-running — it reads the absolute clock, not the timeline's — so the pen does
not jump when the transport wraps.

Two numbers are tied to each other and worth knowing before you touch either:

- `echo.persistence` 0.997 means the trail decays to 1/e in `1 / (1 - p)` = **333 frames**,
  or 5.5 s at 60fps.
- `pathy` has a **4.3 s** period.

So the ribbon is just long enough to hold a whole figure. At the old 0.94 the trail lived
17 frames, during which the disc moved about one percent of the frame — which is exactly
why it read as a smudge rather than as a path.

## What to look at

- `echo.persistence`. At `1` the loop is a pure one-frame delay and the trail never dies —
  it fills the frame and stays. At `0` there is no trail at all. The interesting range is
  narrow, and it is where every feedback look lives.
- **The first second.** Frame 0 is a lone disc: the loop has not drawn anything yet. That
  is honest rather than a defect, and it is the one thing a feedback example cannot fake.
- `drift.extend`. It is `zero` on purpose: `hold` would smear the edge pixel outward
  forever and the frame would silently fill with the last colour at its border.
- The pass order in the compiled plan. `echo`'s swap is the **last** pass, after
  `out:present`. That ordering is the invariant, not an implementation detail.

## Verified by

`src/examples/runner.test.ts` (the gate), `src/examples/temporal.test.ts` (§V22 structure,
swap ordering, history across an unrelated edit), `src/examples/concepts.test.ts` (the fade
and the loop's contents).
