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

## Editing an example

Do not hand-edit the JSON. Edit `src/examples/documents.ts` and regenerate:

```
node --experimental-strip-types src/examples/build-examples.ts
```

The files are written by `buildProjectFile`, the app's real save path, so a shipped example
can never be a shape the app would not itself produce. `sync.test.ts` fails if the two drift.

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
