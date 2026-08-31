# E9 — Ember

A fire front. Sixteen vents along the floor of the frame breathe out of phase, and
everything above them is an ember that **was born, is cooling, and will die**. The whole
point lifecycle, running as weather: births and deaths happen thousands of times a second
on the GPU and the count never touches the CPU.

**Move the mouse through it.** The cursor is a gust — it shoves embers out of the draught
and they fall back into it.

## Graph

```
                     ┌─► bed1   (renderPoints, cold, no predicate) ─┐
fire1 ──────────────►├─► body1  (renderPoints, heat > 0.22) ────────┴─► stack1(add) ─┐
(pointKernelAdvanced)└─► spark1 (renderPoints, heat > 0.62) ──────────────► fuse1(add)◄┘
                                                                             │
        ┌────────────────────────────────────────────────────────────────────┤
        ▼                                                                    ▼
   halo1(blur) ─► halolvl1(level) ─────────────────────────────────► burn1(add)
                                                                             │
                                              loop1(feedback) ─► mix1(screen)◄┘
                                                     ▲                │
                                                     └── ash1(null) ◄─┘ ─► out1(output)
```

| Node | Type | Doing |
| --- | --- | --- |
| `fire1` | `pointKernelAdvanced` | vents spawn 1–3 embers a frame each; a curl-field draught, buoyancy, drag and a **cursor gust** move them; they die when they run cold or leave the frame. A **spawn hook** gives every newborn its own launch |
| `bed1` `body1` `spark1` | `renderPoints` | three additive draws over the **same** cloud, split by a group predicate on heat |
| `halo1` `halolvl1` `burn1` | `blur` `level` `add` | the glow, one job per stage |
| `loop1` `mix1` `ash1` | `feedback` `screen` `null` | a short trail, closed on the final picture |

## What it proves

**Kill and spawn are one deterministic machine.** Deaths compact by prefix-scan (never
atomics, §V74), births append through a second scan over the same generated passes, and
ids come from a monotone GPU cursor — so the same seed is the same fire, frame for frame,
on every machine. The live total sits in a counts buffer and the draw turns it into
indirect arguments on the GPU; pause and read `fire1`'s points with `read_points` and the
census you get is the one the GPU drew.

**One source, three readings, and the split is the lifecycle.** `bed1`, `body1` and
`spark1` differ only in a group predicate, a colour and a size:

| | predicate | colour | reads as |
| --- | --- | --- | --- |
| `bed1` | `p.velocity.z < 0.34` | cold blue, largest | the smoke the fire makes of itself |
| `body1` | `p.velocity.z > 0.22` | orange | the burning column |
| `spark1` | `p.velocity.z > 0.62` | white-gold, smallest | the newest sparks only |

The draws are additive and stacked, so a fresh ember carries a small white core inside an
orange middle — a black-body gradient **per particle**, out of selection alone, with no
per-point colour attribute anywhere. As it cools it drops out of `spark1`, then out of
`body1`, and ends as one dim blue dot in the haze. Watching a single ember fall down that
table is watching it die. Structure comes from selection, not from more nodes.

**Heat rides in `velocity.z`, and the binding budget is why.** A lifecycle kernel spends
2·(n−1)+2 storage bindings for n attributes including flags, and baseline WebGPU
guarantees 8 per compute stage — so the default schema (position, velocity, id, flags)
lands exactly at the limit and a fifth attribute busts it, silently. The simulation is 2D,
so `velocity.z` is free and heat lives there. The kernel writes the number the draws
select on; that is the whole idea, and here it is an arithmetic constraint rather than a
flourish.

**A curl field, because a simulation is not noise.** The draught is the curl of a moving
scalar field, and the curl of anything is divergence-free: it can shear the plume, fold it
and shed eddies off it, and it can never squeeze it into a knot. The embers do not follow
it — they are accelerated by it against their own drag, so what you see is the field
integrated through inertia, which is the thing octaves of noise cannot give you. Buoyancy
is proportional to heat, so an ember stops rising as it cools; that is why the column
leans over and comes apart near the top instead of leaving the frame as a bar.

**The seeding signal is `ctx.firstRun`, not frame zero.** A kernel needs to know when its
storage is fresh, and until T510 there was no honest way to ask. `ctx.frameIndex == 0`
means two things — "my buffers were just cleared" **and** "the timeline lapped to the in
point" — and one token carrying two meanings is why the file that used to live here reset
every time the timeline looped. `ctx.firstRun` means only the first. A seek or a document
load clears the buffers and the fire is rebuilt; a lap keeps them and the simulation is
meant to carry straight through.

That seed is also a **warm start**: seven thousand embers, each given a birth and then run
forward by its own age through the same integration, so frame 0 is a state this simulation
genuinely reaches rather than a scatter that the first second has to clear away. A gallery
thumbnail is frame 0. The seeded generation is entirely replaced by births within about
four seconds.

**The kernel can read the pointer.** `ctx.pointer` carries the same four numbers the value
graph's Mouse node publishes and every fragment shader reads — viewer-normalised, `v`
running down — so the cursor means the same place in a compute kernel as it does in a
shader and in a driven parameter. The single conversion from that uv into this graph's
clip space is written in the kernel, once, because a kernel cannot see the framing that
will draw it. The push is a **Gaussian**, not a radius with an edge: a cutoff makes embers
jump at an invisible boundary and reads as a bug, while a falloff that fades reads as air.

It costs the other examples nothing. A kernel that never names `ctx.pointer` compiles to
the text it compiled to before the member existed — same uniform block, same `PointCtx`,
same constructor — and the same is true of `ctx.firstRun`.

**Children inherit, then diverge.** The hook receives each newborn as a copy of its vent
and draws its lean, its speed and its heat from `pointRand(id, …)`. Delete the hook and
every ember born in a frame is the same ember: sixteen hard lines instead of a fire.

## Known: a lap still disturbs the population

The kernel's own seeding guard is correct, and the machinery around it is not yet. Four
generated lifecycle passes — the kernel's live-count guard, the dead-tail clear, and the
two spawn-id passes — still infer "my storage is fresh" from `frameIndex == 0`, so at a
timeline lap the guard opens to the full capacity and the dead tail is resurrected.
Measured on a 64-point synthetic kernel that reads no clock at all: 12 live before the
lap, 64 after, and it does not come back down. The old frame-zero seed guard was hiding
this by killing the resurrected tail on the same frame it appeared. Naming the signal in
the kernel is one half; teaching the lifecycle passes the same signal is the other, and
it is filed rather than quietly lived with.

Everything else about the seeding is measured and correct: a fresh open and a seek both
re-seed to about seven thousand embers, and the steady state settles near six and a half
thousand.

## What breaks here first

The spawn tail (second scan, copy passes, identity, finalize), the newborn-range guard on
the hook, and the counted indirect draw. Regressions read as: a fire that freezes at frame
zero's census, doubles endlessly (dropped-birth accounting), or emits identical embers.

The cursor gust adds one more: a fire that ignores the mouse. That is the failure class
where a pointer arrives at the kernel scaled, flipped or frozen while every shader sees
the right one, so each half looks correct alone. `point-pointer.gpu.test.ts` compares the
kernel's `ctx.pointer` against the shared frame block's in the same frame, on exact
values, for that reason.
