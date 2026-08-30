# E9 — Particle Fountain

A population that **changes count on the GPU**. One pinned emitter births two particles
a frame; everyone else flies ballistically and dies leaving the frame. Nothing you see
existed at frame zero except the emitter.

## Graph

```
fountain1(pointKernelAdvanced) ─► renderpoints1(renderPoints) ─► out1(output)
```

| Node | Type | Doing |
| --- | --- | --- |
| `fountain1` | `pointKernelAdvanced` | kernel: gravity + kill at the frame edge; slot 0 is the emitter (`spawnCount = 2`); a **spawn hook** launches each child on its own random cone |
| `renderpoints1` | `renderPoints` | additive sprites, drawn **indirectly** — the instance count lives in a GPU buffer |

## What it proves

**Kill and spawn are one deterministic machine.** Deaths compact by prefix-scan (never
atomics, §V74), births append through a second scan over the same generated passes,
ids come from a monotone GPU cursor — so the same seed is the same fountain, frame for
frame, on every machine. Frame zero kills all but the emitter: the entire visible
population grew from births, which is the strongest possible demo of the lifecycle.

**The count never touches the CPU.** The live total sits in a counts buffer; the draw
converts it to indirect arguments on the GPU. Pause the graph and read
`fountain1`'s points with `read_points` — the census you get is the one the GPU drew.

**Children inherit, then diverge (§V73).** The hook receives each newborn as its
parent's copy and sets a launch velocity from `pointRand(id, …)` — distinct ids,
distinct draws. Delete the hook and the fountain collapses into a single column of
identical copies, which is exactly what the concept test guards against.

## What breaks here first

The spawn tail (second scan, copy passes, identity, finalize), the newborn-range guard
on the hook, and the counted indirect draw. Regressions read as: a fountain that
freezes at the first frame's census, doubles endlessly (dropped-birth accounting), or
sprays identical particles (hook or identity gone).
