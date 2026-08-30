# Examples

These are not demos. Each file here is an executable specification (§C "example projects",
§V88, §V89): a real `.loom.json`, loaded through the same loader a user's file goes
through, compiled by the same compiler, and stepped by the same backend.

An example that stops loading, stops compiling cleanly, or stops rendering deterministically
is a **release blocker**, not a docs chore. When one fails, exactly one of three things has
happened:

1. the file format regressed,
2. a node manifest changed incompatibly, or
3. the compiler broke.

| File | Proves |
| --- | --- |
| [E1 Feedback Echo](./E1-Feedback-Echo.md) | explicit temporal boundary, fade + transform inside a loop, stable ping-pong (§V4, §V22) |
| [E2 Reaction-Diffusion](./E2-Reaction-Diffusion.md) | iterative simulation through render feedback, seeded init, reset, rgba16float precision (§V45, §V51) |
| [E3 Animated Noise Field](./E3-Animated-Noise-Field.md) | time via `FrameEvaluationInput` and never a clock, fan-out rendered once (§V44, §V6) |
| [E4 Bloom](./E4-Bloom.md) | multi-branch converge, HDR intermediate through a per-node format override (§V51, §V6) |
| [E5 Kaleidoscope](./E5-Kaleidoscope.md) | extend modes, per-node resolution override, cheap chain at high resolution (§V50) |
| [E6 Displacement Stack](./E6-Displacement-Stack.md) | `data` vs `linear` space discipline; a displacement field is never colour-converted (§V56, §V57) |
| [E7 LFO Dissolve](./E7-LFO-Dissolve.md) | a parameter animated through `driven` mode; channel liveness without edges (§V143, §V173b) |
| [E8 Slit Scan](./E8-Slit-Scan.md) | per-pixel time from a 48-frame ring bound as one texture array (T321, §V229) |
| [E9 Particle Fountain](./E9-Particle-Fountain.md) | GPU-side kill and spawn, deterministic compaction, indirect draw off a live count (§V74, T322/T323) |
| [E10 Instanced Torus](./E10-Instanced-Torus.md) | lit 3D primitives on generated points via the edge payload; a driven component spins it (§V197, §V198, §V113) |

## Running them

The gate lives in `src/examples/` and runs with the rest of the suite:

```
pnpm test           # everything
npx vitest run src/examples
```

It discovers the directory. Dropping a new `.loom.json` in here is the entire registration
step — there is no list to add it to.

- `runner.test.ts` — the §V89 gate: loads, compiles, reads the plan, replays a fixed frame
  sequence twice, and builds every plan on `vgpu/mock`.
- `temporal.test.ts` — §V22 for every example that closes a loop.
- `concepts.test.ts` — the specific claim each example's doc makes.
- `sync.test.ts` — these files are byte-identical to what the app's own save path writes.
- `component-sync.test.ts` — the same for `components/`, plus the §V89 gate on each.

## `components/` — the starter component set

`components/` holds the shipped components (T190, §V94): FeedbackEcho, Bloom,
Kaleidoscope, DisplacementStack, MediaGrade. They are a **different library with a
different verb** — you *instantiate* a component, you *open* an example (§V93) — which is
why they sit in a subdirectory: `listExamples` and the browser's example glob both read
this directory non-recursively, so a component can never appear as a project to open.

Each file is a whole project: the definition under `componentLibrary`, plus a graph that
instantiates it between a source and an Output, so the shipped component comes with a
working demonstration of itself.

§V94 says a shipped component must be the same `GraphComponentDefinition` a user's own save
produces. So these are not constructed. `src/examples/starter-components.ts` drives the
real authoring commands — `component.saveSelection` over a selection in a real document,
then `component.publishParameter` inside a component session — and the result is saved
through `buildProjectFile`. Four of the five are authored out of the examples above,
because E1's echo loop and E4's threshold-blur-add already *are* the structures the
components are meant to be.

`component-sync.test.ts` regenerates the set and compares byte for byte, then loads,
installs and compiles every file the way §V89 gates an example.

## Editing an example

Do not hand-edit the JSON. Edit `src/examples/documents.ts` and regenerate:

```
node --experimental-strip-types src/examples/build-examples.ts
```

The files are written by `buildProjectFile`, the app's real save path, so a shipped example
can never be a shape the app would not itself produce. `sync.test.ts` fails if the two drift.

The same command regenerates `components/`; edit `src/examples/starter-components.ts` for
those.

## What the gate cannot check

There is no GPU in CI. "Renders deterministically" here means:

- the same bytes compile to a byte-identical plan every time;
- the shared frame block — the only route time takes into a shader — is a pure function of
  the frame index and the project seed;
- the real backend can construct every resource, shader module and pipeline the plan names,
  and stepping a fixed frame sequence issues an identical command trace twice.

It does **not** mean pixels. The mock device executes no shaders, so a readback returns
zeroes; comparing those images would be a test that looks like it verifies rendering and
does not. Pixel-level parity between browser and headless is the Dawn track's gate (§V47),
and WGSL in these files is not compiled by any validator here — a shader error in an
example would surface on a real device, not in this suite.
