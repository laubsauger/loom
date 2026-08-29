# E7 — LFO Dissolve

The animation stack end to end. The only example where the thing that moves is a
**parameter** rather than a shader's own clock.

## Graph

```
noise1(noise, perlin4d) ─► cross1.in1 ─┐
checker1(checker) ───────► cross1.in2 ─┴─► cross1(cross) ─► out1(output)

lfo1(lfo) ┄┄drives┄┄► cross1.cross
```

| Node | Type | Doing |
| --- | --- | --- |
| `noise1` | `noise` | `type: perlin4d`, `speed: 0.4` — a field that evolves in time |
| `checker1` | `checker` | a static pattern to dissolve against |
| `cross1` | `cross` | dissolves in1 → in2; its factor is **driven**, not typed |
| `lfo1` | `lfo` | sine at 0.25 Hz, amplitude 0.5, offset 0.5 → sweeps 0…1 every four seconds |

The dashed line is not an edge. `lfo1` has no ports at all; `cross1.cross` is in `driven`
mode naming the channel `lfo1`, and the resolver looks that up by **node name** in the
document. Nothing in the compiled plan knows the LFO exists.

## What it proves

**A parameter can move without a shader knowing.** Every other animated example moves
because a shader reads `frameU.time`. Here the shader is handed a different number each
frame and is otherwise unaware — which is what makes `driven` mode worth having, because
it works on parameters no shader would ever have thought to animate.

**Determinism survives the detour.** The LFO reads `FrameEvaluationInput` like everything
else (§V143), so an offline render and the live preview produce identical frames. An LFO
that read a wall clock would make this file unreproducible and nothing would say so.

**Liveness is not reachability along edges.** `lfo1` connects to nothing. It is alive only
because a parameter names it, and edge-based reachability calls that dead — which is
exactly what happened: writing this example is how B20 was found, with a working LFO
reporting as pruned and wearing a warning badge. §V173b is the rule that came out of it,
and this file is its regression test. If channel liveness breaks again, this example fails
before a user finds it.

## Things to try

- Set `cross1.cross` back to **static** and watch the dissolve stop — the mode is the
  animation.
- Change `lfo1`'s shape to `square` for a hard cut instead of a dissolve, or to
  `noise` (sample-and-hold) for a stutter.
- Point a second parameter at the same `lfo1` channel. One source, many consumers, no
  extra wiring — the reason channels are addressed by name.
