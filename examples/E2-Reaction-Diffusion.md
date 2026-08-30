# E2 — Reaction-Diffusion

A Gray-Scott simulation running entirely as render feedback: no compute pass, no storage
buffer, no CPU. The state lives in one texture, one frame is one simulation step, and the
whole thing is three nodes.

## Graph

```
state(feedback) ─► kernel(customWgsl, Gray-Scott) ─► out(output)
     ╰┄┄┄┄┄┄┄┄┄┄┄┄ state.source: "kernel1" ┄┄┄┄┄┄┄┄╯
```

The dashed line is not an edge. Since T350 (§V285) a Feedback **names** the node it
records, so `edges` is a DAG and nothing is wired into `state.in`; the kernel's single
output is presented, and `state` replays it next frame because it names it.

| Node | Type | Doing |
| --- | --- | --- |
| `state` | `feedback` | the simulation state. `persistence: 1` — a pure one-frame delay. Pinned to 512×512 rgba16float. |
| `kernel` | `customWgsl` | one Gray-Scott step: 9-point Laplacian, reaction, clamp |
| `out` | `output` | presents U/V directly as red/green |

**This shape is forced, not chosen.** `customWgsl` is single-input by manifest, so a
one-texture simulation has exactly one legal form: the pair carries the state, the kernel
reads the previous frame and writes the next one, and the same output is also presented.
There is nowhere else for the state to live.

## What it proves

- **Iterative simulation via render feedback.** One frame is one step, by construction. That
  is also what makes pause/step/reset work with nothing added to the graph: pausing the
  transport pauses the simulation, stepping advances it exactly one iteration.
- **§V45 — seeded init.** The initial condition is an integer hash of a constant seed
  carried in the shader source. Not a noise texture, not a frame counter, not anything
  ambient: the same seed produces the same start on any device.
- **Reset.** The Feedback node's `clearColor` is transparent black and the kernel treats
  `alpha < 0.5` as "history is gone" and answers with the seeded initial condition instead
  of a step. So reset *is* re-seed, and it is the same code path on frame 0 as on the frame
  after a reset, a resize, a format change or device loss — the whole of the manifest's
  `resetOn` list, for free.
- **§V51 — the rgba16float precision path.** Gray-Scott increments are around 1e-3 per step.
  rgba8unorm cannot represent them; the simulation would freeze on the first frame. The
  format override on `state` says so explicitly rather than hoping the project setting is
  right.
- **A legal cycle through a single-input node** (§V4, §V22), same as E1.

## What to look at

- **The format and resolution overrides on `state`.** Both `state` and `kernel` inherit from
  their input, and their inputs are each other — the inheritance has no ground to stand on.
  Pinning them at one named point is what breaks the cycle. This is the case where an
  override is load-bearing rather than a preference.
- **The kernel declares no uniform block.** The CustomWGSL node's `compile()` sets no
  `uniformBinding` and no `sharedBinding`, so a `params` block in the source would be bound
  to nothing on a real device. The kernel reads its grid spacing from
  `textureDimensions(inputTexture)` for exactly that reason. This is the trap the v1 custom
  WGSL contract sets for anyone who copies the default source and starts adding uniforms.
- **`FEED` and `KILL`.** 0.0545 / 0.062 sits in the mitosis band, which keeps dividing.
  Small changes here are the difference between coral, mitosis, worms and a dead plate.
- **Every `textureSample` is at the top level.** The re-seed branch is a `select` over
  already-sampled values, not an `if` around a sample — WGSL forbids sampling in non-uniform
  control flow.

## What is not verified here

The WGSL is not compiled by anything in CI. The mock device creates a shader module without
parsing it, so a syntax error in this kernel would surface on a real GPU, not in the suite.
What the gate does check is that the plan is buildable, the bindings match the contract, and
the seeded-init and reset markers are present in the source.

## Verified by

`src/examples/runner.test.ts`, `src/examples/temporal.test.ts`,
`src/examples/concepts.test.ts` (single-input shape, binding contract, seeded init, format).
