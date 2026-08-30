# E1 — Feedback Echo

A bright disc leaves a rotating, shrinking, decaying trail behind it. The trail is not a
buffer the renderer keeps for you; it is a **cycle in the graph**, and this example exists
to show what makes such a cycle legal.

## Graph

```
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
| `source` | `circle` | the disc, on a transparent background so it composites |
| `over` | `over` | disc over last frame's decayed echo |
| `echo` | `feedback` | the temporal boundary; `persistence` 0.94 fades toward transparent |
| `drift` | `transform` | rotates 3.5° and scales 0.985 per frame, `extend: zero` |
| `soften` | `blur` | 2.5px, so the trail smears as it ages |
| `decay` | `level` | `blacklevel` 0.015 — crushes the dimmest survivors to nothing |

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

## What to look at

- `echo.persistence`. At `1` the loop is a pure one-frame delay and the trail never dies —
  it fills the frame and stays. At `0` there is no trail at all. The interesting range is
  narrow, and it is where every feedback look lives.
- `drift.extend`. It is `zero` on purpose: `hold` would smear the edge pixel outward
  forever and the frame would silently fill with the last colour at its border.
- The pass order in the compiled plan. `echo`'s swap is the **last** pass, after
  `out:present`. That ordering is the invariant, not an implementation detail.

## Verified by

`src/examples/runner.test.ts` (the gate), `src/examples/temporal.test.ts` (§V22 structure,
swap ordering, history across an unrelated edit), `src/examples/concepts.test.ts` (the fade
and the loop's contents).
