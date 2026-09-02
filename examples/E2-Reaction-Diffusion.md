# E2 — Reaction-Diffusion

Two chemicals, one feeding on the other, on a plate whose chemistry is not the same
everywhere. Colonies grow into worms here and dividing spots there.

The boundary between them drifts as the field animates, and the whole thing keeps evolving
instead of settling.

## Graph

```
broad1(noise, perlin4d) ─► warp1.source ─┐
detail1(noise, perlin4d) ► warp1.disp ───┴─► warp1(displace) ─► shape1(level) ─► pack1.in2
swell1(noise, perlin4d) ────────────────────────────► flow1.disp
state(feedback, substeps 20) ─► flow1(displace) ─► rd1(customWgsl) ─► pack1(reorder) ─► state
     ╰┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄ source: "pack1" ┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄╯   (a reference, T350)
rd1 ─► tint1(lookup) ◄─ palette1(ramp, 5 stops) ─► out(output)
                tint1.offset ← lfo1
```

| Node | Type | Doing |
| --- | --- | --- |
| `broad1` | `noise` | `perlin4d`, period 0.55, `speed 0.05` — the large-scale layout of the chemistry |
| `detail1` | `noise` | `perlin4d`, period 0.13, `speed 0.09` — the field that *warps* the first one |
| `warp1` | `displace` | drags `broad1` around by `detail1`, so the two fields interfere |
| `shape1` | `level` | stretches and hardens the distribution into distinct regions |
| `swell1` | `noise` | `perlin4d`, period 0.55, `speed 0.035`, **`mono: false`** — the flow field, two channels |
| `flow1` | `displace` | advects the state along `swell1` on its way into the kernel, weight 0.00035 |
| `state` | `feedback` | the simulation state, 512×512 rgba16float, **`substeps: 20`** |
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

**To break a pattern, move the medium — do not rotate the pattern (T734, §V626).** The
owner's report was that this example "becomes a static field of sorts and is missing a
secondary layer". It never literally froze. The *composition* died, and that is a different
fault with a different fix. Measured on the file this replaces, tile CV over a 16×16 grid of
32px tiles fell **0.695 at frame 60 → 0.271 at frame 300 → 0.137 at frame 600**, then sat
between 0.099 and 0.177 for the next fifty seconds: the plate filled the screen evenly and
stopped composing. Frame-pair motion at frame 1800 was 0.018 of full scale.

The cause is in the band. Gray-Scott's spot lattice is stable *because its substrate is
stationary* — the spots sit in a fixed chemistry and have nowhere to go. So the fix is not
to make the pattern move, it is to make the ground move underneath it. `flow1` is a Displace
between the Feedback and the kernel, driven by `swell1`, a slow two-channel noise. The state
slides; the chemistry map does not, because `pack1` repaints blue from the map chain *after*
the reaction. Advection through a static parameter field shears a lattice apart. A rigid
rotation in the same slot would turn the lattice and leave it a lattice — E24 shipped
exactly that for two hundred tasks, and T734 replaced it with this same node.

With it, at frames 600/1800/3000: dark fraction 35.4/42.2/43.2%, motion 0.201/0.190/0.214,
tile CV **0.422/0.434/0.368**. The composition is still there at fifty seconds.

Two details are load-bearing and both fail silently:

- **`swell1.mono` is `false`.** A mono field hands every texel the same offset in x and y,
  which translates the picture instead of shearing it. Flipping that one flag costs 45% of
  the moved-pixel count and a third of the feature spread.
- **The weight is a density knob with an optimum, not a ceiling.** Dark fraction rises
  monotonically with it, but motion *peaks* near 0.00025 and falls above ~0.0005, because
  past that the flow removes the material that was doing the moving.

**A travelling front was built, measured and rejected here — read this before adding one.**
E32 solved the same complaint with two things: advection *and* weather, an LFO-driven ramp
multiplied into the chemistry map so a region walks down the band and back. Weather is the
obvious second layer, it is what the owner asked for in as many words, and on this example
it makes the picture worse. Built as `season1`(lfo, saw 0.0125 Hz) → `front1`(radial ramp,
dip to 0.55) → `weather1`(multiply) between `shape1` and `pack1.in2`, and measured against
advection alone across one full 80-second lap of its own clock:

| | tile CV, lap mean | dark, lap mean swing | motion, lap mean |
| --- | --- | --- | --- |
| advection alone | **0.353** | 20.8 pts | 0.213 |
| advection + front | 0.277 | 21.1 pts | 0.226 |

It costs 22% of the composition to buy 6% of the motion, and **the slow swing it was added
for is identical without it** — the advection already produces one that size. The mechanism
says why, and it is the band: a multiply walks the chemistry coordinate *down*, and down is
the **dense labyrinth** end. The front does not walk a region out of the lattice into
interesting territory; it walks it into the most screen-filling regime there is, which is
the owner's complaint in the direction of the complaint. E24 rejected weather independently
on the same numbers — three times the spots, finer and flatter. Any future weather here has
to push *up*, toward the sparse end, and the window is narrow because above 0.90 is dead.

The reason this was not caught earlier is worth more than the result: the front and the
advection were designed together and measured together, and *jointly* they beat the shipped
file comfortably. Weather was never measured against advection alone, because advection
alone was not a candidate. Two changes that arrive together must each be measured against
the other alone (§V709).

**A window refit was also tried and rejected, for the opposite reason.** `shape1`'s window
is 0.28…0.72 — 0.44 wide against a `warp1` p10..p90 of 0.131–0.189, so the levels are 2.5–3.5×
wider than the signal in them and 3.6–12.9% of every frame sits in the dead corner above
0.90. Narrowing the window to fit the signal does remove the dead corner, exactly as
intended, and it costs the composition: dark falls to 9.3–20.6% and tile CV stays at
0.052–0.098. **The high tail is this example's only negative space.** Advection is what
turns those patches from a still dead corner into a moving boundary, which is why the fix
was to move the state rather than to retune the map.

**The band, measured rather than inherited (§V554).** E2 and E24 share `GRAY_SCOTT_WGSL`
verbatim, so one band serves both. Driving it with a 0..1 ramp for 2400 steps at 20 substeps,
512×512:

| chemistry | regime |
| --- | --- |
| 0.00–0.30 | dense labyrinth (coverage 51% → 42%) |
| 0.30–0.55 | open labyrinth, worms |
| **0.55–0.85** | **regular spot lattice** (blob-area CV 0.85 → 0.27) |
| 0.85–0.90 | dying |
| **> 0.90** | **dead** (coverage 0.0%, motion 0.0000) |

**Motion falls monotonically across it** — 0.0085 at 0.2, 0.0037 at 0.83, 0.0000 above 0.90.
So the lattice band *is* where the picture goes still, and the owner's two complaints —
"regular dots" and "static" — are one cause, not two. An earlier record of this band claimed
labyrinth end to end with no spot regime and no dead corner anywhere; that was wrong, and it
is the reason a fix aimed at the map rather than at the medium looked reasonable for so long.

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

**And `flow1` is inside that loop**, which is both why it works and what it costs: twenty
extra Displace passes per displayed frame, not one. It has to be inside — advecting once per
displayed frame while the reaction runs twenty times would let the pattern re-settle between
nudges — but the price is real and belongs in the same sentence as the mechanism. The
concept test asserts the loop body as an ordered list (`flow`, `rd`, `pack`, `state`, `swap`)
so that moving it out, or in, is a decision someone makes on purpose.

**The advection weight.** At 0 this is a wire that renders a plausible picture and advects
nothing: every structural assertion still passes, the look baseline still goes green, and the
composition is back to the fault this example was rebuilt to fix. That is the shape §V147
warns about, so it is gated on pixels at frame 900 against a zero-weight control — feature
spread 257.7 against 106.2, and 149,582 pixels moved against 3,268.

**The precision pin.** Gray-Scott increments are around 1e-3 per step, which rgba8unorm
cannot represent at all; the simulation freezes on the first frame. The chemistry
coordinate rides in the same texture, so at 8 bits it would also quantise to 256
chemistries. Both Feedback overrides are load-bearing: a cycle has nowhere to inherit
resolution or format *from*, because every node in it inherits from its input and their
inputs are each other.

**The band's endpoints.** They are chosen so that both ends stay alive. A band with a dead
end grows a still patch, which reads as a bug rather than as a design.
