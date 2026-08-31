# E12 — Fluid

A velocity field carrying a dye. Point at it and it stirs: the pointer sits in the eye of
a vortex, the flow drags the ink around, and the ink shows you where the flow went.

Since T661, "point at it and it stirs" is a gate rather than a hope: the headless
harness can now feed a scripted pointer through the same seam the app's events use, and
`pointer-replay.gpu.test.ts` drives a cursor across this file and pins the ink to it —
before that seam existed, every offline render of this example was a still fluid that
passed everything.

Deliberately not another reaction-diffusion. E2 is a chemistry and **blooms** — its pattern
is generated where the pattern is. A fluid **flows**, because the pattern is *carried*, and
that difference is structural rather than cosmetic: this file has **two** temporal states
where E2 has one.

## Graph

```
vel1(feedback) ─► stir1(customWgsl) ─► advect1.disp                 the VELOCITY loop
     ╰┄┄┄┄┄┄┄┄┄┄ source: "stir1" ┄┄┄┄┄╯                             (a reference, T350)
dye1(feedback) ─► advect1(displace) ─► diffuse1(blur) ─► inject1.in2
ink1(circle, centre ← mouse1) ──────────────────────────► inject1.in1
inject1(over) ─► out1(output)                                       the DYE loop
     ╰┄┄┄┄┄┄┄┄┄┄ dye1.source: "inject1" ┄╯
```

Neither loop is *wired* back: since T350 (§V285) a Feedback **names** the node it records,
so `edges` stays a DAG and the relationship shows as a dashed reference line rather than a
back-edge nobody could read.

| Node | Type | Doing |
| --- | --- | --- |
| `vel1` | `feedback` | the velocity state (`source: "stir1"`), pinned 640×640 rgba16float, `persistence: 1` |
| `stir1` | `customWgsl` | self-advects the velocity, diffuses it, and adds a vortex at the pointer |
| `dye1` | `feedback` | the dye state (`source: "inject1"`), `persistence: 0.985` — the fade is the node's own |
| `advect1` | `displace` | **the advection**: `weight: [-1, -1]`, `offset: [0, 0]` — sample upstream |
| `diffuse1` | `blur` | the dye's own diffusion, one and a bit pixels of it |
| `ink1` | `circle` | the ink source, `center.x`/`center.y` driven by `mouse1` |
| `inject1` | `over` | ink over the advected dye; the result is both the output and next frame's state |
| `mouse1` | `mouse` | the pointer as channels — no edges, addressed by name (§V173b) |

## What it proves

**Advection is a Displace node.** Backward semi-Lagrangian advection — "the dye here now
came from one step upstream" — is exactly `uv + shift * weight` with a negative weight,
which is Displace's entire shader. Diffusion is a Blur. The fade is `persistence`. Only the
velocity field's self-advection and the stirring force needed WGSL, and that is one node.
Written as a single kernel the graph would show nothing; written this way the graph *is*
the explanation.

**Two states, and the coupling between them is one edge.** The velocity is a state, the dye
is a state, and the only thing connecting them is that one is the coordinate the other is
sampled at. That is what makes it a fluid rather than a chemistry, and it is the shape a
reader should take away.

**One pointer, two readers (§V182, §V236).** The stirring vortex lives in the shader and
reads `frameU.pointer` from the shared frame block. The ink blob lives on the CPU and its
`center` is driven by the Mouse node. Neither is a DOM listener: both are the coordinate
the viewer published for this frame, in the same 0..1 v-down convention, so the ink lands
in the eye of the vortex by construction rather than by tuning.

**A cycle needs a ground, and only one of these two loops lacks one (§V50/§V51).** A cycle
breaks resolution and format *inheritance*, because the chain has nowhere to inherit from —
that is why E2 pins its Feedback node. Here the dye loop is grounded through the ink
generator (`over` inherits `in1`, and a generator takes the project's settings), so only
the velocity loop states what it needs. rgba16float there is not decoration: a per-step
displacement of 0.005 uv has no representation in rgba8unorm at all.

## What breaks here first

**The sign of `advect1.weight`.** Positive weight samples *downstream* — the unstable
forward scheme. It does not crash and it does not go black: the dye still flows, and over a
minute it tears itself apart. This is the parameter the concept test pins, rather than the
presence of the Displace node.

**`advect1.offset`.** The field is *signed*, so zero means "no motion". At Displace's 0.5
default the whole frame slides diagonally for ever, which looks deliberate.

**Which texture is on which Displace input.** Swap `source` and `disp` and the dye becomes
a coordinate field displacing the velocity — still a picture, still moving, no longer a
fluid.

**The two readers agreeing.** A Mouse node that flipped v "for TD parity", or clamped, or
reported pixels, would put the ink somewhere the vortex is not. Each half looks correct
when tested alone; §V182 exists because that is exactly how the failure hides.

**The unit.** The velocity is stored as a displacement **per step**, not per second, so the
kernel advects itself with `uv - here` and Displace's weight is exactly −1. Storing metres
per second would force the frame duration into `weight`, which is a compile-time uniform —
a fixed 1/60 baked into a parameter and silently wrong at any other rate. E2 made the same
choice for the same reason: one frame advanced is one simulation step.

## The one pixel assertion in the suite

Everything above is structural — which resource is on which input, what a uniform holds —
and all of it would still be true of a fluid that does not move. So `examples.gpu.test.ts`
runs this file on Dawn for five seconds with the pointer parked in the middle and counts
how much of the frame the dye reaches, once with `stir1.amount` at 1 and once at 0.

Measured: **4,612 pixels against 147,757** of 409,600. The flow, not the Blur, is what
spreads the ink, and a regression in advection, in the velocity field, or in the pointer's
route into the kernel collapses the first number onto the second while still compiling,
still rendering, and still showing a blob.

The field itself settles near **0.0033 uv per step** — about two pixels a frame at 640, or
one revolution every couple of seconds near the eye of the vortex.

## Playing with it

- `stir1.amount` is the stir strength, live on a uniform write. Turn it to zero and watch
  the flow coast to a stop: that is `DAMPING` and the wall term doing their jobs.
- `diffuse1.size` is the fluid's viscosity as far as the dye is concerned. Push it past
  three and the ink stops holding filaments.
- `dye1.persistence` at 1 makes the dye permanent — the frame fills and never clears, which
  is a good way to see the flow field's whole history at once.
