# E9 — Particle Fountain

A population that **changes count on the GPU**. One pinned emitter births two particles
a frame; everyone else flies ballistically and dies leaving the frame. Nothing you see
existed at frame zero except the emitter.

**Move the mouse through the spray.** The cursor pushes particles aside — the kernel
reads the pointer directly, so this is the particle system reacting to you rather than a
parameter being animated near it.

## Graph

```
fountain1(pointKernelAdvanced) ─► renderpoints1(renderPoints) ─► out1(output)
```

| Node | Type | Doing |
| --- | --- | --- |
| `fountain1` | `pointKernelAdvanced` | kernel: gravity, a **cursor push**, kill at the frame edge; slot 0 is the emitter (`spawnCount = 2`); a **spawn hook** launches each child on its own random cone |
| `renderpoints1` | `renderPoints` | additive sprites, drawn **indirectly** — the instance count lives in a GPU buffer |

## What it proves

**Kill and spawn are one deterministic machine.** Deaths compact by prefix-scan (never
atomics, §V74), births append through a second scan over the same generated passes,
ids come from a monotone GPU cursor — so the same seed is the same fountain, frame for
frame, on every machine. Frame zero kills all but the emitter: the entire visible
population grew from births, which is the strongest possible demo of the lifecycle.

The pointer does not weaken that, and it is worth being exact about what it does change.
Nothing here reads a wall clock and no draw is scheduling-dependent (§V45, §V74), so the
determinism claim stands as stated: identical inputs, identical frames, on any machine.
The fountain is now a function of the **pointer stream** as well as the seed — a replay
that feeds the same pointer reproduces the same frames; a live run with a moving mouse
does not reproduce a still one. E12 pays exactly the same price for its stirring force.

**The count never touches the CPU.** The live total sits in a counts buffer; the draw
converts it to indirect arguments on the GPU. Pause the graph and read
`fountain1`'s points with `read_points` — the census you get is the one the GPU drew.

**The kernel can read the pointer (T367, §V182).** `ctx.pointer` carries the same four
numbers the value graph's Mouse node publishes and every fragment shader reads — viewer-
normalised, `v` running down (§V236) — so the cursor means the same place in a compute
kernel as it does in a shader and in a driven parameter. Before T367 `PointCtx` had
`index`, `count`, `time`, `delta` and `frameIndex` and nothing else, and "the swarm
follows the mouse" was not expressible at all. The single conversion from that uv into
this graph's clip space is written in the kernel, once, and it is written there because a
kernel cannot see the camera or the framing that will draw it.

The push is a **Gaussian**, not a radius with an edge. A cutoff makes particles jump at an
invisible boundary and reads as a bug; a falloff that fades reads as air being pushed. It
costs the same one `exp`.

It also costs the other examples nothing. A kernel that never names `ctx.pointer` compiles
to the text it compiled to before the member existed — same uniform block, same `PointCtx`,
same constructor (§V309) — so E1 and E13 did not silently recompile when this file grew a
cursor.

**Children inherit, then diverge (§V73).** The hook receives each newborn as its
parent's copy and sets a launch velocity from `pointRand(id, …)` — distinct ids,
distinct draws. Delete the hook and the fountain collapses into a single column of
identical copies, which is exactly what the concept test guards against.

## What breaks here first

The spawn tail (second scan, copy passes, identity, finalize), the newborn-range guard
on the hook, and the counted indirect draw. Regressions read as: a fountain that
freezes at the first frame's census, doubles endlessly (dropped-birth accounting), or
sprays identical particles (hook or identity gone).

The cursor push adds one more: a spray that ignores the mouse. That is the §V182 failure
class — a pointer arriving at the kernel scaled, flipped or frozen while every shader sees
the right one, so each half looks correct alone. `point-pointer.gpu.test.ts` compares the
kernel's `ctx.pointer` against the shared frame block's in the same frame, on exact values,
for that reason.
