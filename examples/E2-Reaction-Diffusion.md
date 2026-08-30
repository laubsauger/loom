# E2 — Reaction-Diffusion

Two chemicals, one feeding on the other, on a plate whose chemistry is not the same
everywhere. Colonies grow into worms here and dividing spots there, the boundary between
them drifts as the field animates, and the whole thing keeps evolving instead of settling.

## Graph

```
broad1(noise, perlin4d) ─► warp1.source ─┐
detail1(noise, perlin4d) ► warp1.disp ───┴─► warp1(displace) ─► shape1(level) ─► pack1.in2
state1(feedback, substeps 20) ─► rd1(customWgsl) ─► pack1(reorder) ─► state1
     ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ source: "pack1" ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯   (a reference, T350)
rd1 ─► tint1(lookup) ◄─ palette1(ramp, 5 stops) ─► out1(output)
                tint1.offset ← lfo1
```

| Node | Type | Doing |
| --- | --- | --- |
| `broad1` | `noise` | `perlin4d`, period 0.55, `speed 0.05` — the large-scale layout of the chemistry |
| `detail1` | `noise` | `perlin4d`, period 0.13, `speed 0.09` — the field that *warps* the first one |
| `warp1` | `displace` | drags `broad1` around by `detail1`, so the two fields interfere |
| `shape1` | `level` | stretches and hardens the distribution into distinct regions |
| `state1` | `feedback` | the simulation state, 512×512 rgba16float, **`substeps: 20`** |
| `rd1` | `customWgsl` | the Gray-Scott step: a nine-tap Laplacian and two rate equations |
| `pack1` | `reorder` | U and V from the kernel, the chemistry coordinate into blue, alpha kept |
| `palette1` | `ramp` | five stops, smooth: deep navy → teal → green → amber → cream |
| `tint1` | `lookup` | reads V as a position along the palette; `offset` driven by `lfo1` |
| `lfo1` | `lfo` | 0.05 Hz, ±0.06 — slides every pixel along the gradient together |

## What it proves

**Substeps are what make a simulation watchable (T387).** A feedback loop used to advance
exactly once per displayed frame, and Gray-Scott needs tens of iterations per visible frame
to develop. No parameter in the product could buy them, so "reaction-diffusion is too slow"
was a fact about the architecture, not a setting anyone had got wrong. `substeps: 20` on
the Feedback node iterates the loop — the kernel, the pack, the write and the swap — twenty
times inside one frame, allocating nothing: the same passes, the same pipelines, the same
ping-pong pair. Measured on Dawn at frame 300: 161,907 pixels covered against 28,028 at one
substep.

**Spatially varying feed/kill is the difference between a pattern and a picture.** A single
pair of compile-time `FEED`/`KILL` constants is the same chemistry in every pixel, and the
same chemistry everywhere grows the same thing everywhere — a handsome, dead, uniform maze.
Here the kernel reads a 0..1 coordinate out of the state texture's blue channel and walks a
line across the (feed, kill) plane with it, so one region runs a labyrinth chemistry while
its neighbour runs a spot-division chemistry and the two grow into each other. Forced flat
at the two ends of that band, the same file produces 149,410 covered pixels at one end and
10,500 at the other: they are not variations of one creature.

**The graph is the algorithm.** Same lesson as E12, where advection turned out to be a
Displace node. Only the Laplacian and the rate equations are WGSL; the animated fields are
Noise nodes, their interaction is a Displace, the shaping is a Level, the packing is a
Reorder, and the colour is a Ramp and a Lookup. You can change how this looks without
opening a shader, which is the entire difference between a compositor and a shader toy.

**A concentration is data, not light.** V is a number that lives around 0..0.4, and showing
it in the green channel is showing a number. It goes through a five-stop Ramp and a Lookup
instead — E11's pairing — and the LFO on `tint1.offset` slides every pixel along that
gradient at once, so the colour breathes while the chemistry carries on regardless.

**The Reorder is load-bearing, and it is the least obvious node here.** The CustomWGSL
contract is one texture in, one out, so the kernel cannot be handed a second map. The map
travels *inside* the state texture: red and green are the chemicals, blue is the chemistry
coordinate for the next step, and alpha stays the kernel's, because alpha is the
"history exists" flag a reset clears. One node, and it is why this shape works without
changing the node contract.

## What breaks here first

**The blue channel.** If `pack1.outb` stops reading input 2's luminance — a swapped
selector, a rewired input, a Reorder dropped from the chain — the kernel reads zero
everywhere, runs one chemistry, and produces a perfectly beautiful uniform maze. Nothing
errors. The concept test measures per-region feature density for exactly this reason.

**The alpha channel.** `pack1.outa` must stay `in1a`. Alpha below 0.5 means "the pair was
cleared, re-seed"; writing anything else there either re-seeds the plate every frame (a
static fizz) or never seeds it at all (an empty screen after a reset).

**`substeps`.** At 1 this file is the thing that was reported as too slow. At 20 it costs
twenty times the loop's GPU work in the same frame, and the node's timing row says so —
that is deliberate, because the cost is the feature.

**The precision pin.** Gray-Scott increments are around 1e-3 per step, which rgba8unorm
cannot represent at all; the simulation freezes on the first frame. The chemistry
coordinate rides in the same texture, so at 8 bits it would also quantise to 256
chemistries. Both Feedback overrides are load-bearing: a cycle has nowhere to inherit
resolution or format *from*, because every node in it inherits from its input and their
inputs are each other.

**The band's endpoints.** They are chosen so that both ends stay alive. A band with a dead
end grows a still patch, which reads as a bug rather than as a design.
