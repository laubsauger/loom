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
| [E2 Reaction-Diffusion](./E2-Reaction-Diffusion.md) | the algorithm as a GRAPH: animated noise into a spatially varying feed/kill map, 20 substeps per frame, colour through a Ramp (T387, T388) |
| [E3 Animated Noise Field](./E3-Animated-Noise-Field.md) | time via `FrameEvaluationInput` and never a clock, fan-out rendered once (§V44, §V6) |
| [E4 Bloom](./E4-Bloom.md) | multi-branch converge, HDR intermediate through a per-node format override (§V51, §V6) |
| [E5 Kaleidoscope](./E5-Kaleidoscope.md) | extend modes, per-node resolution override, cheap chain at high resolution (§V50) |
| [E6 Displacement Stack](./E6-Displacement-Stack.md) | `data` vs `linear` space discipline; a displacement field is never colour-converted (§V56, §V57) |
| [E7 LFO Dissolve](./E7-LFO-Dissolve.md) | a parameter animated through `driven` mode; channel liveness without edges (§V143, §V173b) |
| [E8 Slit Scan](./E8-Slit-Scan.md) | per-pixel time from a 48-frame ring bound as one texture array (T321, §V229) |
| [E9 Particle Fountain](./E9-Particle-Fountain.md) | GPU-side kill and spawn, deterministic compaction, indirect draw off a live count (§V74, T322/T323) |
| [E10 Instanced Torus](./E10-Instanced-Torus.md) | lit 3D primitives on generated points via the edge payload; a driven component tumbles each primitive in place (§V197, §V198, §V113) |
| [E11 Gradient Remap](./E11-Gradient-Remap.md) | Ramp into Lookup: a multi-stop palette remapping an image by luminance; per-entry colour decode (T270, §V196) |
| [E12 Fluid](./E12-Fluid.md) | two temporal states — a velocity field carrying a dye; advection as a Displace; the pointer stirs both halves (§V182, §V236) |
| [E13 Prism](./E13-Prism.md) | the showcase: dispersion through three refractions, per-point colour, LFO → Lag, Mouse → Lag, an expression (T364, §V179, §V71) |
| [E16 Murmuration](./E16-Murmuration.md) | the SOP-chain showcase: generator → flock kernel → pointer kernel → instances; mixed §V197 ownership, by-reference tint across a node, draw-time group cull (T401, T333) |
| [E20 Gooeyball](./E20-Gooeyball.md) | the 2D→3D crossing: animated noise → per-point attribute → displacement along the normal → a closed surface whose seam is a topology claim (T417, T301/T302) |
| [E24 Audio Reaction-Diffusion](./E24-Audio-Reaction-Diffusion.md) | the capstone: audio-driven substeps (the beat makes the chemistry FASTER), safe-bounded feed/kill, a genuinely temporal RGB delay off three cache taps, wind inside the loop (T425, T414, T437) |
| [E25 Stage](./E25-Stage.md) | the multi-stage render: scene A filmed by an orbiting camera becomes a MATERIAL MAP on scene B's screen, filmed again to the output — a virtual screen inside a scene, everything driven (T444, T377, T428) |
| [E26 Interference](./E26-Interference.md) | one ring field read TWICE and subtracted from itself: nine nodes, no WGSL, no state, and a moiré whose structure is in neither input (§V6, T475) |
| [E27 Relief](./E27-Relief.md) | a picture LIFTED into geometry: 96,000 unlit points at 3D heights with per-point colour in the scene pipeline, and the UNDERSTUDY pattern — a synthetic performer plays on open while `webcam` stays in the plan and gets compiled (§V411, §V363, T478) |

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
- `examples.gpu.test.ts` — every example built on **Dawn**: the one place the WGSL an
  example ships is actually compiled. See "What the gate cannot check" below.

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
does not. Pixel-level parity between browser and headless is the Dawn track's gate (§V47).

The WGSL an example ships **is** compiled, but only since `examples.gpu.test.ts` (T362):
before that, E2's Gray-Scott kernel had shipped for a week without any validator ever
looking at it, because the mock host does not compile shaders. That test builds every
example's plan on Dawn — which reflects each module, resolves every binding by name and
creates the pipelines — and steps six frames. Running the same file on both hosts is
§V280's rule: the mock proves the plan is constructible, Dawn proves the shaders are real,
and neither finds the other's bugs.

It checks **one** pixel property, deliberately, and only for E12: with the stirring force on
the dye reaches thirty-two times more of the frame than with it off. "It flows" is a claim
about pixels, and every other assertion in the suite is one a motionless fluid would also
satisfy (§V147, B15). There is still no reference-image comparison anywhere.
