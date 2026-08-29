# `src/tests/headless/` — what these suites need to run

These four files (`dawn-render`, `headless-parity`, `mock-commands`, plus the shared
harness) are the only place the offline-render architecture is actually executed rather
than asserted. Two of them need a real GPU.

## Why they fail instead of skipping

`dawn-render.test.ts` and `headless-parity.test.ts` call `requireDawn()`, which **throws
with the verbatim `vgpu/node` init error** when Dawn cannot start. That is deliberate.

A machine where Dawn is unavailable has not verified the headless path, and §V45 (seeded
determinism) and §V47 (offscreen rendering with no surface) go back to being statements of
intent on that machine. A suite that skips into a green tick reports the opposite. So the
failure is the honest signal, and the error text tells whoever sees it exactly what is
missing.

The consequence — and this is the part CI has to decide about — is that **a runner without
a GPU turns this suite red**, not yellow.

## T162 — what a GPU-capable runner needs

`vgpu/node` loads `@vgpu/adapter-node`, which wraps the `webgpu` npm package: prebuilt
**Dawn** native binaries, one per platform/arch. There is no browser involved and no
display server, so the requirements are smaller than the usual "GPU CI" ask.

**Verified working here:** macOS 26.3 / Apple Silicon, Dawn on the Metal backend, adapter
reported as `Metal driver on macOS Version 26.3.1`. No flags, no environment variables, no
`sudo`. Total wall time for both Dawn suites is under a second once the device is up;
device creation itself costs ~1.2s once per process.

**What a runner needs:**

- **A real GPU or a software rasteriser Dawn can bind.** Dawn picks Metal on macOS, Vulkan
  or D3D12 elsewhere. On a headless Linux runner with no GPU, install Mesa's Vulkan
  software driver (`mesa-vulkan-drivers` / `lavapipe`) — Dawn will bind it and the suites
  pass, just slower. `libvulkan1` and `vulkan-tools` are worth having so `vulkaninfo` can
  answer "is there an ICD at all?" before the test run does.
- **No display server.** There is no window, no swap chain and no `navigator.gpu`; a
  headless container is fine. Do not add `xvfb` on this account.
- **`pnpm install` must not skip optional/platform binaries.** The Dawn `.node` binary
  arrives as a platform-specific package. A `--ignore-scripts` or cross-platform lockfile
  restore is the most likely way this breaks, and it fails at `init()` with a module-load
  error rather than at install time.
- **Nothing GPU-specific for the rest of the suite.** `mock-commands.test.ts` and every
  other project test run on `vgpu/mock` and need no hardware.

**A cheap pre-flight** for a runner, before deciding whether to run these suites:

```js
// node -e, from the repo root
const { init } = await import("vgpu/node");
const gpu = await init();
console.log(gpu.adapter.name);
gpu.dispose();
```

Anything that prints an adapter name will pass these suites.

**If a GPU runner is genuinely not available**, the decision belongs to whoever owns CI,
and it should be an explicit `--exclude` of these two files with the reason recorded — not
a skip added inside them. Moving the skip into the test files loses the distinction between
"verified" and "not checked here", which is the whole point of the current behaviour.

## Tolerances

Stated with their reasoning in `pixel-compare.ts`. In short: `0` for same-device
comparisons (there is no float budget to spend), one 8-bit quantum for cross-implementation
comparisons, `2^-10` for the same argument in `rgba16float`. There is deliberately no
"percentage of pixels allowed to differ" knob.

## Known gap

Real-browser-WebGPU vs Dawn is not executed — see the `it.todo` at the bottom of
`headless-parity.test.ts`, which names the blocker and the exact remaining step.
