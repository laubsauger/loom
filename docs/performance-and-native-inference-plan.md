# Performance and native inference plan

Investigation and implementation record: 2026-09-10. Original baseline HEAD: `cbdba66`, with the existing working-tree changes present. Later task sections record implementations and their separate evidence; original baseline measurements are not measurements of the final tree. This is not a claim of TouchDesigner parity. macOS / Apple Silicon is the first native target; Windows must offer the same product capabilities, with platform-specific models and accelerators allowed.

## Recommended direction

Implementation follow-up (SPEC T1249–T1253, T1300 onward): the isolated [Mac native-texture proof](../experiments/native-texture-bridge/README.md) carries synthetic Metal output from a separate Python 3.14.6 process through XPC IOSurface capability transfer, Electron 43.3.0, and sandboxed WebGPU. Twenty-four color/float frames, distinct peer PIDs, producer release acknowledgments, and temporary-service cleanup passed; ownership and producer/consumer/renderer-exit tests passed too. **T1317 GPU-process-loss gate fails reproducibly:** device loss and explicit renderer reference release arrive, but the final Electron release callback does not. The prototype fails closed, never acknowledges reuse, and verifies service cleanup on teardown. Fresh sessions pass afterward; neither safe in-session recovery nor the cause of the earlier startup stall is proven. Real model integration, browser GPU-input export, strict zero-copy internals, throughput and Windows remain unproven.

Application-side work now includes corrected sRGB presentation, linear sampled-space metadata, sRGB8 defaults for new projects, explicit float numerical paths, optimized Noise, and four audited SDR examples plus two starters. Their resolution and required numerical precision are preserved. The [example audit](example-precision-audit.md) covers 58 examples and ten starters; it is not a blanket migration. T1315's frozen-production Alembic comparison was rejected because reference workloads drifted; lower allocation bytes are proven, a format speedup is not. T1316's Alembic rewrite was rejected for excessive image differences. Windows parity and worker scheduling remain separate follow-ups.

Improve the browser runtime and prototype an Electron native-texture adapter as separate, measurable workstreams. The wrapper addresses process supervision and native frame exchange. Graph scalability also requires cheaper editor updates, incremental compilation, deliberate texture formats, and bounded execution demand.

Priorities:

1. Establish usable production CPU/GPU measurements and a format comparison.
2. Make correctly encoded 8-bit SDR processing the proposed normal path, retaining explicit float choices and required data precision.
3. Remove document-wide UI updates, hidden-panel work, repeated preview construction, and full animated recompilation.
4. Prove native texture transport on Mac, then the same transport contract on Windows, before committing to a larger desktop architecture.
5. Move the frame runtime to one worker and add bounded inference scheduling where measurements justify it.
6. Add finer cooking and resource reuse only against workloads that demonstrate the benefit.

`SPEC.md` currently commits to a browser core with a later desktop adapter and explicitly scopes out resource aliasing and pass fusion. A desktop adapter fits that boundary. Later aliasing/fusion work and revised color semantics need explicit SPEC updates as implementation tasks. All document mutations must continue through `src/domain/commands`; native device services remain under `src/devices`, independent of MCP.

## Evidence from this tree

### GPU timing attribution labels — T1302, 2026-09-10

Implemented without changing GPU measurements or scheduling. Node overlays visibly
name GPU spans and possible overlap; their proportional bars explicitly compare the
displayed overlays' smoothed span sum, not graph execution time. Offscreen nodes do
not participate in that denominator. Performance tables distinguish individual
pass spans from node/category span sums; node info carries the same caveat. Agent
metrics help describes frame extent and no longer claims that every null means
missing device support. No schema, renderer, format, resolution, or shader changed.

Two regressions were verified failing before the patch: overlapping 8 ms spans
were labelled as 50% shares of the graph, and the performance pane did not qualify
span sums separately from frame extent. The patched tests retain the exact timing
numbers, unavailable states, and leaf-only update behavior.

Validation: 77 focused tests including the UI-copy guard, six GPU-backed agent
acceptance tests, four browser node-info interaction tests, scoped lint, typecheck,
build and diff whitespace checks pass. Full gates: 101 pass, two failures in
concurrent work (`reactor`'s unset `shutDim` default and unwired `openTerminalDoor`).
Full lint reports 16 escaped-backtick errors in the other session's Gray–Scott
shader. These files were left untouched. Full headless rendering was not rerun
for this presentation-only change; no GPU timings or rendering code changed.

### Alembic 1080p exploratory profile — T1306, 2026-09-10

Coordination note: the orchestrator reserved T1300–T1349 for this session and
renumbered its earlier T1261–T1267 rows to T1300–T1306. Historical references below
retain their original labels; the live SPEC board is authoritative.

Harness: `scratchpad/alembic-performance-probe.ts`; run with the repository alias
hooks and a local Vite server on port 5219. `--formats` compares RGBA16F, RGBA8
UNORM, and RGBA8 sRGB. It opens command-built diagnostic documents through the
normal file chooser. No authored/generated examples or application defaults are
modified. The project keeps its 72 march steps, six warp octaves, palette, and
animation. All cases use always-cook, the examples tab, a 1600×1000 headed
Chromium window, and the shipped 30 Hz preview setting. Preview subtraction uses
the actual per-node preview switch, not CSS hiding.

Each case warms for three seconds, samples the hub for five seconds without
tracing, then captures a separate three-second CPU trace with the existing trace
parser. GPU figures below are frame extents, never summed pass spans. Throughput
uses differences of the hub's cumulative render count; its publication boundary
means a short window can read slightly above the nominal 60 FPS cap. These are
not display presentation counts. Cases repeat in reverse order.

| RGBA16F case | GPU median, forward / reverse | Approximate rendered FPS, forward / reverse |
|---|---:|---:|
| Shipped 720p | 6.42 / 5.96 ms | 60 / 60 |
| Shipped shader at 1080p | 18.68 / 15.14 ms | 51 / 60 |
| 1080p, node previews disabled | 18.61 / 15.20 ms | 51 / 58 |
| 1080p, shader bypass diagnostic | 0.786 / 0.786 ms | 60 / 60 |

The bypass replaces only Alembic's fragment entry with a texture sample while
retaining its graph, full-size targets, bindings and declared parameters. It is
deliberately NOT visually equivalent and must not ship as an optimization.

What this supports:

- Alembic's fragment workload is the leading bottleneck in this three-node graph.
  Removing that workload collapses frame extent while the surrounding app can
  sustain its 60 FPS target. This does not distinguish arithmetic throughput,
  dependent texture latency, occupancy, register pressure or driver scheduling.
- Disabling node previews gives no consistent GPU improvement in either order.
  It is not a useful default workaround for this example.
- The two full-shader 1080p CPU traces occupy only about 360–364 ms of their
  three-second main-thread windows (12%). Compiler attribution has zero samples
  in those windows. These observations argue against sustained main-thread
  saturation; they do not prove the absence of individual stalls. Native/program
  samples and timeline spans overlap and must not be added as exclusive costs.
- The telemetry reports zero performed readbacks. No inference transport or
  video codec participates in this example.

Limits matter: other agents edited live source and ran tests during this session;
Vite recorded HMR updates, and a process snapshot caught an active Vitest worker.
The baseline improved substantially in reverse order. Neither the resolution
ratio nor a hard hardware ceiling is established. Repeat on a frozen source
snapshot with other rendering windows paused and no concurrent GPU tests before
publishing a speedup or claiming compute saturation. The existing historical
Alembic study in its source is not reused as a current baseline.

Next narrow shader investigation: fixed-time, full-resolution paired tests of
loop specialization/unrolling and instruction scheduling, followed by image and
animation comparisons. Preserve march steps, octaves and precision. A successful
microbenchmark must then improve the full-app frame extent. Do not spend effort
on workers as the presumed fix for this particular shader before that evidence.

The owner then identified the project setting as possibly **8-bit RGBA, sRGB**,
so a separate comparison includes all three formats. In its forward pass, all
three sustained approximately 60 rendered FPS:

| 1080p format | Median GPU extent | Planned texture bytes |
|---|---:|---:|
| RGBA16F | 14.615 ms | 49,766,400 |
| RGBA8 UNORM | 13.631 ms | 24,883,200 |
| RGBA8 sRGB | 13.828 ms | 24,883,200 |

Reverse order was less stable: sRGB8 13.959 ms / 58.5 FPS, UNORM8 14.942 ms /
59.5 FPS, float 20.251 ms / 49.4 FPS. A local typecheck overlapped the tail of
that reverse pass, in addition to other sessions' activity. Treat those rows as
contaminated observations, not controlled format-speedup evidence. No averaging
across the two orders can remove that confound.

This supports a memory reduction and suggests useful frame-budget headroom, not
a 2× performance claim or a claim that only sRGB can reach 60 FPS. A prior plain
RGBA8 comparison also read lower than float in both orders (17.37/17.50 versus
18.28/18.35 ms), but under a heavier and changing load. Do not merge those absolute
numbers into one baseline. Raw cases and traces are retained in
`scratchpad/alembic-formats-probe.json` and the corresponding `.trace.json` files.

The sRGB case visibly reports the existing `sinkFormatUndisplayable` compiler
warning. Its source is the output target's hardware sRGB decode during the
viewer blit, documented in `src/domain/color/display.ts` and
`src/compiler/compile.ts`. This run verifies the warning appears; it does not
establish the magnitude or direction of the pixel mismatch. An sRGB performance
win is not evidence of correct preview/viewer/export color. Resolve and test that
contract before making sRGB storage the general default. Plain RGBA8 remains a
separate candidate and still requires precision/appearance validation.

Validation for this diagnostic-only slice: eight resolution/subtraction cases
and six three-format cases completed without page exceptions. Typecheck was
attempted but failed on concurrent `src/editor/menus/schemas.test.ts` edits
(lines 225/233: `MenuEntry.label` is not available on `MenuSeparator`). Those
files were not changed here. No product rendering or format behavior was edited.

### Starter FPS follow-up — T1261, 2026-09-10

The top-bar FPS meter sampled only the latest rendered frame's duration every
100 ms. This aliases the 10/20 ms intervals of a 60 FPS loop on a 100 Hz display:
the meter could report 50 or nearly 100 without either being actual throughput.
Four isolated headed Chromium windows counted approximately 60 rendered frames
per second while the old display's median ranged from 87.6 to 96.1.

The readout now uses the existing frame-clock verdict, which counts all rendered
frames in a trailing 1.5-second window. Red-verified tests reproduce the old 50/100
readings. After the fix, steady browser windows counted 59.9–60.1 FPS and displayed
60; a separate brief dip was reflected in the meter. This is measurement
correctness, not a rendering optimization. The fresh 1280×720 RGBA16F graph still
showed roughly 3–5 ms frame GPU spans. Individual Metal pass spans can overlap and
must not be interpreted as exclusive node execution costs. An isolated Checker
measurement remains necessary before attributing its displayed milliseconds to
the checker shader itself.

### Isolated Checker and format comparison — T1262

An isolated headed Chromium run opened command-built Checker+Output fixtures and
the E6 source through the product's file-open UI. Each case used 1280×720 output,
the examples tab, `always` cook policy, a 2.5-second warmup, and 40 telemetry samples
at 100 ms. The second round reversed case order. The viewer confirmed each format.
These are sampled GPU frame extents, not per-frame traces or exclusive shader times.
The scratch harness is `scratchpad/checker-format-probe.ts`; raw observations are
in `scratchpad/checker-format-probe.json`.

| Graph | Format | Frame GPU median, rounds 1 / 2 | Planned texture bytes |
|---|---|---|---|
| Checker + Output | RGBA16F | 0.066 / 0.131 ms | 14,745,600 |
| Checker + Output | RGBA8 | 0.066 / 0.066 ms | 7,372,800 |
| E6 starter | RGBA16F | 3.539 / 5.505 ms | 44,236,800 |
| E6 starter | RGBA8 | 3.539 / 3.801 ms | 22,118,400 |

All eight windows sustained 59.8–60.1 rendered FPS. The memory reduction is exactly
50% for the planned resources; this is not a measurement of total process memory
or actual bandwidth. The GPU-time controls drift substantially, so these runs do
not establish a reliable format speedup. They do establish that isolated Checker
is much cheaper than its multi-millisecond span inside E6 suggests. Very small
timestamps are quantized; zero samples do not establish zero execution cost.

The existing raw-timestamp investigation in `hub.ts` explains the attribution
problem: Metal stage timing can include overlapped work from other passes.
[Apple documents stage-boundary counter sampling on Apple silicon](https://developer.apple.com/documentation/metal/sampling-gpu-data-into-counter-sample-buffers).
The node overlay still describes a share of graph GPU time, which overstates what
these measurements establish. It should explicitly distinguish pass spans from
exclusive costs; changing a tooltip alone would not validate the cost-ranking bars.

The follow-up `--noise` run retained E6's exact Noise parameters and compared
Noise+Output, a 640×360 Noise override, and that override in the complete starter.
All cases retained RGBA16F and 1280×720 final output. Resolution-inheriting Level
and Transform followed the smaller field; Checker and final output stayed full size.
The same command/serializer/UI path and reversed ordering were used. Results are
in `scratchpad/noise-resolution-probe.json`.

| Graph, RGBA16F throughout | Frame GPU median, rounds 1 / 2 |
|---|---|
| Checker + Output control | 0.066 / 0.066 ms |
| Noise + Output, 1280×720 field | 3.211 / 4.719 ms |
| Noise + Output, 640×360 field | 1.573 / 1.507 ms |
| Complete starter, 1280×720 field | 4.325 / 4.129 ms |
| Complete starter, 640×360 field | 1.704 / 1.638 ms |

The complete starter's GPU medians fell approximately 60% in both orders. Planned
texture bytes fell from 44,236,800 to 27,648,000 while preserving float precision.
This supports evaluating the low-frequency displacement field at lower resolution
as a targeted optimization. It does not prove pixel equivalence: displacement can
amplify interpolation differences, so a pinned-time image comparison must precede
an example change. No shipped example or default was modified by these probes.
The Noise kernel also evaluates the base octave plus `harmon` additional octaves:
E6's value of two means three 4D Perlin evaluations per fragment, not a cached image.

**Owner constraint:** lower resolution, fewer octaves, reduced precision, and other
fidelity reductions require explicit acceptance. The half-resolution probe is not
the default remedy. Full-resolution performance remains the target.

### Full-resolution Noise kernel investigation — T1265

`scratchpad/noise-kernel-probe.ts` uses an isolated same-origin browser page with
no app frame loop. It compiles the shipped Noise shader and diagnostic variants
against identical uniforms, renders full-size RGBA16F targets, and measures one
render-pass timestamp pair. Four rounds alternate forward/reverse variant order,
with 16 draws per case after warmup. Timing draws do not read pixels; separate
correctness draws compare every half-float component at three absolute times.
This isolates kernel/compiler cost; it is not an app FPS or TouchDesigner parity test.

| Variant | 720p GPU median | 1080p GPU median | Output check |
|---|---|---|---|
| Shipped | 1.180 ms | 2.490 ms | Baseline |
| Expand all 16 Perlin corners | 0.655–0.721 ms | 1.442 ms | Small differences |
| Expand two corners per loop iteration | 0.852 ms | 1.835–1.901 ms | Small differences |
| Expand four corners per loop iteration | 0.786 ms | 1.638 ms | Small differences |
| Expand eight corners per loop iteration | 0.655–0.721 ms | 1.507 ms | Small differences |
| Specialize only noise-type switch | 1.114–1.180 ms | 2.490 ms | Identical in tested frames |

The loop expansion retains 16 lattice corners, three octaves, the same gradient
function, seed, resolution, and storage precision. Nevertheless, all expanded-loop
variants fail strict byte equality: fully expanded output differs in 11–22 pixels
at 720p and 33–50 pixels at 1080p across the three tested times. Each changed
component differs by one adjacent half-float representation; RGB are monochrome
duplicates and alpha is unchanged. Compiler-dependent floating-point evaluation
is a plausible cause, not yet a traced compiler diagnosis. No variant was applied
to product code. Approval was requested before pursuing a non-bit-identical change.

The type-only specialization provides little benefit and conflicts with the
current uniform-only type-change contract if implemented naively. The expanded
loop is the stronger candidate, with roughly 40% lower isolated GPU time, but
broader seed/transform/color tests, in-app measurements, and cross-platform proof
remain necessary. These diagnostic uniforms use the same workload shape as E6,
not its exact CPU-hashed seed. Sustained isolated draws also differ from a paced
application workload, so their absolute times must not be substituted for app spans.

### Determinism versus compatibility — headless follow-up

The owner approved pursuing tiny rounding differences with broader validation.
That approval does not relax deterministic replay. The existing headless tests
distinguish exact same-implementation replay (`TOLERANCE_EXACT = 0`) from bounded
cross-implementation comparisons. A changed result relative to an older shader is
not evidence that repeated runs of the new shader vary.

`scratchpad/noise-replay-probe.ts` drives the existing `renderHeadless` harness with
a diagnostic node definition. Baseline and candidate use identical graph IDs and
scheduling; only the shader differs. Nine configurations cover E6 at 720p/1080p,
color, transformed coordinates, seeds, zero/eight extra octaves, HDR parameters,
and unchanged Perlin2D/Simplex3D paths. Each captures frames 0, 3, and 7. Two
independently initialized GPU devices repeat all 27 optimized frames byte-for-byte;
the animated starter also changes between frames, preventing a frozen-output pass.
This establishes local headless repeatability, not cross-vendor bit equality.

End-to-end comparison found an important limit: E6 at 1080p, frame 7, differs from
the old shader in 12 RGB components across four pixels beyond 1/1024 absolute error.
Worst channel difference is 0.0875244 after the displacement chain. The other 26
captured outputs are byte-identical. A tiny field perturbation can move sampling
across a sharp checker edge, so a bound on Noise output alone does not bound the
whole graph. No product change or tolerance weakening was applied.

If an implementation selector is warranted, it should be a persisted/versioned
`optimized` versus `legacy-compatible` choice, not `fast` versus `deterministic`.
Both variants must pass exact local replay. Existing projects must retain their
chosen implementation, and browser/headless rendering must use the same choice.
Defaulting new projects to optimized remains a decision after end-to-end and
browser/headless parity validation; the current evidence does not authorize
silently changing old projects or treating amplified pixel changes as accepted.

### Implementation decision and validation

The owner subsequently clarified that this is unpublished development and old
project compatibility does not justify a legacy path. The fixed 16-corner loop is
therefore expanded directly in `src/nodes/shaders/noise.wgsl.ts`, once at module
initialization. No selector, migration, reduced precision, reduced resolution,
octave reduction, or alternate gradient algorithm is included. The old loop lives
only in a test oracle. Further fidelity reductions still require owner acceptance.

The follow-up browser/headless probe enabled the complete parameter animator.
Both implementations matched their headless counterparts byte-for-byte in all 18
comparisons: three captured frames each of 720p E6, 1080p E6, and an HDR-parameter
case. The earlier 27-frame probe animated Noise but held expression-driven Transform
parameters at their retained values; its four-pixel edge discrepancy is a valid
static-Transform case, not evidence about exact live E6 state or nondeterminism.

The running-app A/B opened the same E6 graph in isolated browser contexts, overriding
only the Noise shader module for the comparison. RGBA16F, 1280×720, always-cook:
legacy/optimized median frame GPU extent was 3.211/2.949 ms in forward order and
3.342/3.015 ms in reverse order, roughly 8–10% lower. Both remained paced near 60 FPS.
These short sampled windows are noisier than the isolated kernel benchmark; the
40% kernel reduction is not a claim of 40% app-wide improvement.

`src/tests/headless/noise-optimization.gpu.test.ts` adds eight durable gates:
all 16 corners in the same order, six raw-Noise configurations at 720p/1080p or
384×216 (color/transforms, zero/eight extra octaves, HDR, seeds), and full-HD animated
displacement replay. Each candidate render repeats exactly on an independent GPU
device. Reference comparisons use a per-component float-rounding bound, never a
percentage of failing pixels; no existing test tolerance was widened. The first
test implementation exposed an output-ID assumption and excessive allocation by
generic typed-array equality; both test defects were corrected, using actual opaque
output IDs and bounded-memory raw-byte comparison.

The optional zero-weight corner skip also measured promising isolated gains with
exact pixels in six initial checks. It is not included in this patch: transformed
fields, dynamic branches, and cross-GPU performance need separate validation.

Final validation of the direct optimization:

- Eight new Noise GPU gates passed; exact replay and rounding use separate assertions.
- Typecheck, production build, scoped lint, and all 103 required guardrail tests passed.
- Five headed-browser presentation/example-parity tests passed, including E3's animated
  Perlin4 field compared against Dawn through the actual app.
- Complete headless run: 8,234 passed, three failed, three skipped, one todo.
  Failures: E2/E24 generated-source sync after the pre-existing Gray-Scott edits,
  and E66's non-static cook-oracle assertion. A controlled E66 rerun produced the
  same single digest with the old loop and optimized shader, proving this failure
  is not introduced by the optimization. The actual auto/always comparison matched.
- Full lint remains blocked by eight pre-existing escaped-backtick comment violations
  in `src/examples/shaders/gray-scott.wgsl.ts`; scoped Noise/readout lint is clean.

No shipped example data was rewritten or tolerance weakened for this optimization.
Cross-vendor Windows GPU validation remains outstanding; local Apple Silicon results
do not establish a Windows speedup or cross-vendor bit identity.

| Finding | Evidence | Implication |
|---|---|---|
| Shared-memory browser prerequisites already exist | `vite.config.ts:47`: COOP/COEP in dev and preview; `src/app/cross-origin-isolation.ts` and `public/coi-sw.js` cover hosted isolation | A wrapper is not needed just to enable SharedArrayBuffer |
| Inference already uses a worker and transfers buffers | `src/app/use-model-inference.ts:514`, `src/runtime/models/worker-runner.ts:189` | Workers are available today; replacing transferred ArrayBuffers with SAB alone does not eliminate GPU readbacks |
| Inference still crosses GPU/CPU boundaries | `src/runtime/execution/inference-sources.ts:465`, `src/runtime/models/inference-worker-core.ts:370`, `src/runtime/models/depth-runner.ts:60` | GPU preprocessing → readback → CPU packing → model → CPU result conversion → texture upload, even when the model's provider is WebGPU |
| Native Vision uses image serialization | `src/app/use-vision-bridge.ts:178`, `src/devices/device-client.ts:157`, `src/devices/vision-host.ts:99` | Base64/JSON WebSocket plus a raw stdio child-process protocol; no video codec, but several copies and conversions |
| Animated parameters invoke a full compile | `src/app/use-graph-compile.ts:460` calls `compileSafely` each animated frame | Existing uniform upload reuse avoids GPU rebuilding, but not the CPU compiler work |
| Preview programs are reconstructed before signature comparison | `src/runtime/previews/system.ts:131` | Cache the structural program and update dynamic uniforms separately |
| Timeline causes layout work | `src/app/timeline-scrubber.tsx:148` writes width and left | Use transforms and skip unchanged writes; verify actual layout reduction |
| Baseline pane elements were rebuilt at the application root | Baseline `src/app/app.tsx:1542` and `:1772`; historical trace in `docs/perf-profile-2026-09-08.md` | Concurrent user work now adds pane memos and moves hover to a ref. Preserve it and reprofile once complete; do not duplicate the fix |
| Cooking already prunes unreachable nodes, but runtime idle gating is whole-plan | `src/compiler/compile.ts:970`, `src/runtime/backend/vgpu/vgpu-backend.ts:1822` | Do not rebuild pruning. Benchmark whether static branches inside animated graphs justify finer gating |
| The displayed GPU total needs validation | `src/runtime/telemetry/hub.ts:339` sums stored pass values, updated independently at line 486; previous report found implausible totals | Carry frame/submission identity and coverage. A sum of latest pass samples is not automatically an elapsed GPU frame |

The September 8 development profile ranked React updates, backend encoding, browser painting/layout, previews, and animated compilation ahead of value-graph evaluation. Those historical percentages are not a production ranking and should not be carried forward as expected savings. Its attribution of pan/zoom commits to document viewport persistence is not supported by the inspected app/editor call sites: normal pan/zoom does not emit a `setViewport` graph patch. Baseline root hover state is a separate concrete render trigger, addressed by the concurrent edit. Do not add viewport debouncing to solve an unproven mutation path.

### Production measurement performed in this investigation

`pnpm build` and `pnpm typecheck` passed. The existing headed Chromium harness completed E24 and chain-200 against `pnpm preview`; E55 and untitled-8 were deliberately excluded. Raw traces and JSON are under `scratchpad/perf/2026-09-10-production/` (gitignored).

Command:

```sh
PERF_FIXTURES=E24,chain-200 PERF_SCENARIOS=A,C,E \
PERF_OUT_DIR=scratchpad/perf/2026-09-10-production \
PERF_SERVER_COMMAND='pnpm preview --port 5211 --strictPort' \
pnpm exec playwright test -c src/tests/e2e/perf/playwright.config.ts
```

Adapter: `apple/metal-3`; Chromium 151.0.7922.34. The harness's emulated Desktop Chrome user-agent says Windows; this was a Mac GPU run, not Windows validation. Display intervals were near 10 ms, not a controlled 60 Hz baseline. A trace frame here is a main-thread rAF task interval, not proof of a new GPU-rendered frame being displayed.

| Scenario | Samples | Busy main thread per trace frame, mean / p95 | Input → next compositor commit, p50 / p95 |
|---|---:|---:|---:|
| E24, 74 nodes, idle, examples tab, pass 1 | 449 frames | 6.17 / 10.54 ms | — |
| E24 idle, performance tab, pass 1 | 434 frames | 6.83 / 10.62 ms | — |
| E24 knob, pass 1 | 467 frames, 120 inputs | 9.78 / 21.20 ms | 15.26 / 16.63 ms |
| E24 knob, pass 2 | 508 frames, 120 inputs | 10.21 / 22.87 ms | 15.85 / 18.05 ms |
| chain-200 idle, examples tab, pass 1 | 483 frames | 5.77 / 8.23 ms | — |
| chain-200 pan/zoom, pass 1 | 399 frames | 13.12 / 29.52 ms | approximately 10 / 24 ms |
| chain-200 pan/zoom, pass 2 | 256 frames | 34.87 / 60.75 ms | approximately 22 / 47 ms |

Limitations: the fixed-work control varied during E24 (expensive-control medians 10.8–14.2 ms), so this is not a controlled speedup comparison with the old report. The two chain gestures differ substantially and require investigation; pass 1 also had two extra pointer moves. Discard chain-200's second performance-tab idle window: it contains 58 pointer moves and 11 wheel events. The other idle windows have no pointer/mouse/wheel/key events. Do not attribute the chain regression to one subsystem from these numbers.

The development-oriented summarizer also fails on production React durations serialized as `null`; its script-URL categories classify the bundled app as `other`. Frame/task/input metrics remain available in raw JSON, but production component timings and source attribution require a profiling build/source maps and a corrected report reader. No summarizer or product code was changed here. GPU time, multi-model throughput, transport copies, Windows behavior, and RGBA8-vs-RGBA16F speedup were not measured.

## Texture formats: adopt the useful part of TouchDesigner's policy

### Frozen production comparison — T1315

A new production build was copied to `/private/tmp/loom-perf-snapshot.sGzea2/dist` and served on its own port, without HMR. Its main bundle SHA-256 was `31095106bfb17322c16ce9cb49c42c3278eb4d0315e807301642536f933c8dd8`. The probe alternated format order and bracketed each order with full-HD Prism and Forest GPU reference graphs. Another test browser was active before the run; it was not stopped. Untraced five-second throughput windows preceded separate three-second CPU traces. This is a new production-tree observation, not a controlled before/after comparison with the earlier development build.

| Alembic 1920×1080 | Order 1 GPU p50 / FPS | Reverse order GPU p50 / FPS | Planned texture bytes |
| --- | ---: | ---: | ---: |
| RGBA16F | 15.008 ms / 59.4 | 22.675 ms / 40.6 | 49,766,400 |
| Linear RGBA8 | 16.384 ms / 54.5 | 18.153 ms / 52.3 | 24,883,200 |
| sRGB RGBA8 | 18.874 ms / 51.5 | 16.974 ms / 55.2 | 24,883,200 |

**Rejected as format-speedup evidence.** First-order references drifted from 3.801 to 4.391 ms (Prism) and 7.078 to 7.602 ms (Forest). Reverse-order references drifted from 3.801 to 4.981 and 7.864 to 10.617 ms. Alembic's p95 spans reached 32–45 ms. These are not stable controls, and the format ranking changes with order. The frozen bundle eliminates HMR contamination, not competing GPU load or changing machine conditions. No automatic “eight-bit is faster” or hardware-saturation conclusion follows.

Main-thread busy time in Alembic's separate traces was approximately 10–18%, again consistent with GPU-side work being the main lead rather than CPU saturation. It does not distinguish our shader's compute demand from competing GPU work. Raw measurements and traces are in `scratchpad/alembic-calibrated-probe.json` and `scratchpad/alembic-calibrated-*.trace.json`; the probe browser and server were stopped. The next controlled speed comparison needs a coordinated GPU window, including other agents' test browsers.

T1316 also tested a scratch-only static expansion of the fold's twelve possible octave steps, guarded by the existing octave count. It retained 1920×1080, all march steps, actual octaves, parameters and RGBA16F. Across all five family presets at times 0–4 seconds, the candidate exceeded the accepted rounding budget: maximum displayed differences were 178 byte levels for Alembic, 66 for Vault, 178 for Snarl, 213 for Skein and 148 for Rake. Some frames changed over a million pixels. It was rejected before performance benchmarking; the shipped shader is unchanged. Different compiler arithmetic amplified through the recursive warp is a plausible explanation, not an established cause. Evidence: `scratchpad/alembic-unroll-probe.ts` and `scratchpad/alembic-unroll-results.json`.

T1311 changes the new-project default from `rgba16float` to `rgba8unorm-srgb` in `src/domain/types/graph.ts`. Existing saved settings remain required and are preserved, without migration or a legacy selector. Ordinary output format propagation already supports explicit overrides, definition policies, input inheritance, and the project setting (`src/compiler/format.ts`). Video ingest uses `rgba8unorm-srgb` and samples that into a working output (`src/nodes/definitions/media.ts`).

The user's proposed 8-bit default is a strong optimization candidate. RGBA8 is 4 bytes/pixel; RGBA16F is 8. These are storage formats; using RGBA8 does not turn shader arithmetic into 8-bit arithmetic.

| Uncompressed texture payload, no mipmaps/MSAA | RGBA8 | RGBA16F |
|---|---:|---:|
| 1920 × 1080 | 7.91 MiB | 15.82 MiB |
| 3840 × 2160 | 31.64 MiB | 63.28 MiB |
| 100 simultaneously resident 1080p targets | 791 MiB | 1,582 MiB |

At 1080p60, one idealized full-image read plus write is 0.995 GB/s with RGBA8 and 1.991 GB/s with RGBA16F. This is byte arithmetic, not measured DRAM traffic: caches, compression, filtering, extra inputs and shader cost affect actual throughput. Halving texture bytes does not promise double frame rate, and does not halve model tensor memory or JavaScript work.

TouchDesigner's documented behavior is more specific than universally using 8-bit. Its traditional default is a color pass-through workflow. In its opt-in `SRGB_LINEAR` workflow, 8-bit RGBA textures use sRGB storage encoding to preserve dark tones while processing in linear light; ACEScg forces 16-bit float. [Derivative color-space workflow](https://derivative.ca/UserGuide/Color_Space_Workflows). TOP filters expose input-format inheritance and explicit format selection. [Function TOP](https://derivative.ca/UserGuide/Function_TOP). Some operations choose stronger precision themselves: Analyze's sum/count modes default to 32-bit float. [Analyze TOP](https://derivative.ca/UserGuide/Analyze_TOP).

Implemented policy, with deferred extensions noted:

- New-project SDR color: 8-bit RGBA with sRGB storage and linear shader values. T1307/T1308 correct the color/presentation contract.
- Ordinary filters: inherit their chosen input's format; expose an explicit precision override.
- HDR, signed color/math, accumulation, and numerical feedback: explicit float storage at the producer and throughout the required chain. Raising precision after clipping cannot recover lost data.
- Depth and pose: RGBA16F graph outputs, with the existing R32F depth inference scratch retained. UV coordinates also explicitly use RGBA16F. Circle and Rectangle remain float in both Fill and Signed Distance modes so switching modes does not silently clip the field. Explicit per-node overrides still win. Other custom numerical/HDR producers need the user's explicit float selection; the compiler does not infer content or promote formats silently.
- Single-channel masks/depth: consider R8/R16F where their numerical requirements permit it, rather than carrying four channels. These are additional format-support tasks; the current graph format union does not expose them.

Do not implement this by changing the one default string alone. T1307/T1308 now distinguish encoded sRGB storage from linear sampled values: final presentation uses a cached non-decoding view of the same texture, while ordinary sampling and preview use the hardware-decoded linear values. The obsolete output warning is removed. No extra texture allocation or copy was added. Tests reproduced grey 54 instead of 127, then verified viewer/preview/export parity, dark and bright values, resize, and both feedback halves. Four actual browser compositor tests pass; 702 compiler/preview/export tests pass. The full headless run after T1307 passed 8,261 tests with five failures in concurrently edited examples/terminal/annotation surfaces; this is not a clean whole-repository gate.

T1309 now protects Depth's final measurement output. T1311 GPU tests retain signed distances through both feedback halves and 1,024 distinct UV coordinates in an eight-bit project. T1310/T1312 compare E5/E6/E7/E11 at five deterministic animation times, preserve resolution, assert compiled precision islands and repeat the candidate byte-identically on another device. Measured allocation savings range from 25% to 50%; maximum displayed differences are one byte level, or two for E5. See [the precision audit](example-precision-audit.md) for failed candidates and complete numbers. This does not migrate the remaining simulation/HDR examples or claim a frame-rate improvement. sRGB views cannot be used as WebGPU storage textures; compute-written color needs a deliberate compatible view/encoding path or a declared float format. [Chromium texture-view usage explanation](https://groups.google.com/a/chromium.org/g/blink-dev/c/-pKliCSI_0I).

Opened projects retain their persisted format settings; no stored document data is rewritten. The numerical-producer policy fixes also apply in existing projects unless a node explicitly overrides its format, so previously clipped signed values can now survive. This is a precision correction, not a claim that every previously quantized project renders identically. Existing document-setting edits still use the command bus. Higher precision remains a visible user choice; there is no silent content-dependent downgrade.

Validation after the implementation: 8,276 headless tests passed. Seven failures were recorded in `scratchpad/perf-headless-validation.json`: concurrently edited E2/E24/E55 generated files, Reactor's default ledger, terminal wiring, the new annotation's render fixture, and a compiler-flatten timeout that passed all 33 tests in isolation. The earlier combined suite passed 9,496 tests but also caught the preview fixture's idle-command assumption; T1313 fixes that test without changing preview behavior. Typecheck and production build pass. Full lint/gates still report concurrent Gray–Scott/Reactor/terminal changes, so the repository is not claimed clean.

T1314 caught a separate development hazard: `node_modules/.vite` contained vgpu 0.3.1 while the installed package was patched 0.4.1. The old prebundle omitted the compatible-view allocation option and made sRGB presentation black. The same four headed compositor tests failed two/four with that cache, passed four/four with an isolated cache, then passed four/four using the normal command after moving Vite's cache into the configuration's own `.vite` directory. Profiling snapshots that share `node_modules` now keep separate prebundles. No cache was deleted and no rendering fallback was added. Existing dev servers should be restarted after installing the patch.

The shipped examples are part of this rollout, as requested by the user. Audit each example and starter component: migrate ordinary SDR color paths to the new defaults, retain explicit float formats on numerical/HDR/feedback paths, and verify the demonstrated behavior and rendered appearance. Update authoring sources under `src/examples/documents/` and regenerate each selected example with `--only`; never hand-edit generated `.loom.json` files. Starter-component generation rewrites the shared generated set, so schedule it after competing example work finishes. This curated update to shipped examples does not reinterpret users' existing saved documents.

Format acceptance: compare float, linear UNORM8, and sRGB-storage8 on a dark ramp, repeated grades, alpha edges, bloom values above 1, and long feedback runs; compare previews, viewer and export. Benchmark simple video/filter chains separately from shader-heavy simulations at 720p, 1080p and 4K. Report allocated bytes, frame GPU duration and CPU submission separately. Use matched format/color settings in the TouchDesigner comparison.

## Three different meanings of shared memory

| Mechanism | What it shares | What it does not provide |
|---|---|---|
| Browser SharedArrayBuffer | CPU bytes between eligible JS workers/contexts | Attachment to arbitrary Python/OS shared-memory allocations; GPU texture sharing |
| Python/OS shared memory | CPU pages across cooperating native processes | Automatic access from a browser renderer; elimination of GPU upload/readback |
| Native shared GPU surfaces | GPU image resources across compatible APIs/processes | Automatic model-tensor compatibility, synchronization, or arbitrary WebGPU texture export |

Browser SAB needs secure-context isolation, already configured here; normal workers do not require SAB. Transferring an ArrayBuffer already avoids a structured-clone payload copy. [MDN shared memory](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/SharedArrayBuffer). Python's shared-memory API is a separate native process facility. [Python shared memory](https://docs.python.org/3/library/multiprocessing.shared_memory.html).

A native extension could map shared CPU pages and expose a managed buffer, but Electron does not automatically make a Python allocation into a renderer SAB. Ordinary IPC should not be treated as zero-copy. For dense model output, prioritize native GPU surfaces; for pose joints or other tiny results, ordinary bounded binary messages are likely sufficient.

## Desktop recommendation and transport proof

Electron is the first candidate because it keeps a bundled Chromium runtime and exposes a native shared-texture import route. Tauri uses the platform's WebView, including WebKit on macOS and WebView2 on Windows, so adopting it would add a different rendering-engine compatibility problem to this work. This is an engineering fit recommendation, not a claim that Electron renders faster. [Tauri WebViews](https://v2.tauri.app/reference/webview-versions/).

Electron's `sharedTexture` API is experimental. It imports platform texture handles, sends imported references to a renderer and exposes a VideoFrame. Mac handles are process-local IOSurface references; Windows handles are process-local NT handles. Transporting the ownership correctly requires native handle transfer, not sending a pointer value in JSON. [Electron API](https://www.electronjs.org/docs/latest/api/shared-texture), [handle types](https://www.electronjs.org/docs/latest/api/structures/shared-texture-handle), [native design](https://github.com/electron/electron/blob/v44.3.0/shell/common/api/shared_texture/README.md).

Proposed native-input path:

```text
Native capture / decode → shared source frame pool
                            ├─ depth provider → result surface
                            ├─ pose provider → compact joints
                            └─ segmentation provider → result surface
                                         ↓
Native bridge → Electron imported VideoFrame → backend adapter → graph
```

The source is captured/decoded once, then shared among models and the compositor. Each model still needs its own declared resize/normalization/tensor packing where those differ. Source sharing removes duplicate transport, not model computation.

WebGPU can sample a VideoFrame using `importExternalTexture`; it yields a GPUExternalTexture, not an ordinary writable GPUTexture. [WebGPU external texture](https://developer.mozilla.org/en-US/docs/Web/API/GPUDevice/importExternalTexture). The present backend's `externalTexture` descriptor is actually an allocated ordinary texture filled by uploads; the name does not imply native import. Adapt at `src/runtime/backend`, with a measured import/conversion pass into ordinary graph textures if necessary. Describe that as a GPU copy, not strict zero-copy. Imported-frame lifetime must extend through GPU use; Electron exposes release tracking. [Imported texture lifecycle](https://www.electronjs.org/docs/latest/api/structures/shared-texture-imported).

Critical limitation: this proves native-source/native-model → app. Arbitrary graph-output → Python → graph is a second problem. Standard browser WebGPU has no general OS-handle export for any GPUTexture, and Electron import does not itself solve that reverse direction. Test both directions early. A native compositor/backend owning the shared allocations may be needed for guaranteed bidirectional GPU residency; a reduced-resolution asynchronous readback can be an explicitly selected mode, not a hidden replacement for the advertised path. Never describe canvas/VideoFrame capture as zero-copy without tracing it.

The first proof uses synthetic surfaces and known numerical ramps before real models. Test BGRA/RGBA color and float data independently: imported video color conversion can corrupt data textures. Electron's image-format list is not a generic R32F tensor-sharing API; validate supported float packing and numerical error. A model producing NumPy/CPU output still incurs upload even if the last transport segment shares a texture.

Keep native code in a narrow bridge and the model process supervised; use a packaged local UI and narrow preload capabilities. Do not require disabling the Chromium sandbox or enabling general Node access in graph/UI code. [Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).

## Equal capabilities on Mac and Windows

| Layer | macOS / Apple Silicon first | Windows acceptance path |
|---|---|---|
| Shared image transport | IOSurface / Metal / CVPixelBuffer adapter | D3D shared texture / NT-handle adapter |
| Model execution candidates | Core ML, Vision where semantically suitable, Python with a native accelerator integration | NVIDIA CUDA/TensorRT where available; evaluate WinML for broader supported hardware |
| Public contract | Same depth/pose/segmentation capabilities, coordinate conventions, output semantics, timing, reset and error behavior | Identical public contract; model weights/provider may differ |
| Proof | Native transport + real model + multi-model stress | Repeat on real Windows hardware before declaring feature parity |

Provider choices are candidates, not promises that every model is supported or that the provider can export its output allocation. Core ML offers selectable compute-unit configurations and has model/operator restrictions. [ORT Core ML](https://onnxruntime.ai/docs/execution-providers/CoreML-ExecutionProvider.html). CUDA supports graphics/external-resource interop, which still needs implementation for the selected resource and synchronization types. [NVIDIA interop](https://docs.nvidia.com/cuda/cuda-programming-guide/04-special-topics/graphics-interop.html). Current ORT guidance prefers WinML for new Windows projects and marks DirectML as sustained engineering; do not hard-code DirectML as the unquestioned long-term default. [ORT Windows guidance](https://onnxruntime.ai/docs/get-started/with-windows.html).

Define capability/provider metadata once: model artifact/version, input shape and normalization, output units/range, joint schema, orientation, alpha semantics, precision, actual accelerator, queue delay, inference time, source frame ID and result age. Relative depth must not silently become metric depth, and person mattes must not masquerade as general semantic segmentation. Cross-model parity means agreed quality/semantic thresholds, not byte-identical neural output or equal speed on unequal hardware. Persist enough provider/model identity for reproducible takes.

Use a broker with one bounded execution lane per suitable device/provider initially. Python processes may host multiple compatible models; spawning one process per graph node duplicates model state and can oversubscribe the accelerator. Add concurrency only when throughput and frame-age measurements improve.

## Worker and scheduling architecture

### Validation follow-up — T1317–T1324

The final focused inference/configuration set passed 196 tests with three optional
real-model tests skipped. Typecheck, production build and scoped lint passed;
the latest standalone guardrail run passed all 103 tests. Full lint still reports
ten shader-comment errors in the concurrently edited Gray–Scott shader.

The first broad headless run lacked native GPU/socket access and is not rendering
evidence. The native-enabled rerun passed 8,337 tests and failed 36 (three skipped,
one todo). All inference ownership/lifecycle and SDR/numerical/presentation checks
passed. Failures included ongoing E24/Forest work and seven checks exposing drift
in our generated SDR artifacts. T1324 regenerated only the four owned examples
and two starters; eight selected example-sync checks plus 89 native GPU/component/
concept checks then passed. This is not a claim that the entire broad suite was
rerun clean afterward. The browser test project passed 1,232 and failed one
unrelated audio-mute expectation concerning the newly added detector settings.
Raw reports are in `scratchpad/perf-worker-headless-native-validation.json` and
`scratchpad/perf-worker-browser-validation.json`.

The native early-release test passed all 24 frames and acknowledgments. GPU-loss
remains a reproducible failing gate, with safe teardown and zero acknowledgments;
one later normal run took 70 seconds despite eventually exiting cleanly. These
experiments do not establish production native recovery or throughput.

### Proposed ownership boundary

One renderer worker should own the frame driver, GPU device, compiled plan, value evaluation, and preview atlas. The React thread owns DOM, gestures and document commands; it sends ordered graph changes and frame inputs, and receives bounded telemetry. Existing `PresentableCanvas` supports the OffscreenCanvas shape (`src/runtime/backend/backend-types.ts:48`). OffscreenCanvas is transferable and usable in workers. [MDN OffscreenCanvas](https://developer.mozilla.org/en-US/docs/Web/API/OffscreenCanvas).

This is a substantive adapter task: transfer viewer/atlas canvases, forward input and resize/visibility, adapt DOM media sources into transferable frame handles, handle pane/popout lifecycle, and preserve pause/step/export semantics. Do not create a worker/device per node. WebGPU resources belong to their device and are not ordinary transferable buffers; message boundaries should carry commands or supported frame handles.

An independent browser optimization is to keep compatible ONNX inputs and outputs on the compositor's GPU device. ORT supports tensors backed by GPUBuffer and GPU-resident outputs. This requires shared device ownership in the same runtime context and provider compatibility; the current separate inference worker and byte-returning runner cannot do it merely by changing session flags. [ORT GPU I/O binding](https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html).

Realtime execution retains the newest completed valid result, with explicit age and dropped-frame counts. Each source/model lane has a bounded pool (start with three slots), readiness/completion signaling, and no overwrite while a consumer or GPU still uses a slot. Use OS synchronization across native processes; browser Atomics are not GPU fences. Add generation IDs for resize, reset, model changes and device recovery so old results cannot publish into a new session. Offline/fixed-step requests retain exact request/frame association and an explicit wait/failure policy.

**T1319 — shared weights, private temporal state:** two deterministic tests through
the real runner/protocol/core reproduced the earlier risk. Alternating RVM nodes
received recurrent markers `[0,1,2,3]` instead of `[0,0,1,2]`; a new MODNet node's
white matte blended with another node's black history to produce 0.5. The run
protocol now requires node identity and both temporal maps use a node/session
tuple. Both regressions pass while asserting that the model session loads only
once. The same-node history and ratio-reset tests remain green. These are fake
model correctness proofs, not neural-quality or multi-model throughput results.

**T1320 — terminal worker admission:** eight tests reproduced requests hanging
after crash/disposal, during weight acquisition, and between load completion and
run dispatch. The runner now records terminal state, registers load waiters before
acquisition, and checks terminal state across the existing await boundaries. A
dead worker rejects work; explicit reset creates a fresh runner. There is no
automatic reconnect or main-thread inference fallback. A stalled download no
longer prevents the caller from observing worker disposal.

**T1322 — input-size invalidation:** RVM's structural Input Size control can change
the input shape without changing its downsample ratio. A third ownership test
reproduced old-size recurrent tensors being reused. The worker now stores and
checks both input side and ratio before reuse; a shape change starts from zero
state and subsequent frames resume recurrence. It does not alter the chosen
input size or load another copy of the model.

Further scheduler gates remain: node removal/model replacement must retire
temporal state and prevent late state writes; concurrent sessions need bounded admission and queue
delay measurements. The current source layer gates outstanding work per node,
but the worker starts each asynchronous request independently. That is not a
global accelerator concurrency budget. Do not multiply workers or model sessions
before measuring this boundary with multiple active nodes.

## Implementation sequence and acceptance gates

| Step | Work | Exit condition |
|---|---|---|
| 1. Measurements | Repair production report reading/source attribution; identify rendered frames and GPU submissions; profile format/resolution/pass-count matrix | CPU busy, render cadence, GPU elapsed time, memory, transfer bytes and result age are separate, trustworthy measurements |
| 2. SDR format policy | Validate sRGB storage with linear processing; preserve explicit float/data paths and persisted projects | Color/alpha/export comparisons pass; measured memory reduction and GPU timing recorded; no inference-output quantization regression |
| 3. Editor cost | Verify the concurrent pane/hover fix; selector-scoped subscriptions, hidden sampler suspension, timeline transforms | Editing one value does not render the node library; hidden panes have no periodic React commits; hover/pan does not invalidate document-independent panes |
| 4. Compiler and previews | Compile structure on structural changes; derive animated/value update program; cache preview structure separately from lens uniforms | Normal animation performs no full topology/structure compilation; unchanged preview requests do not rebuild their program; compare results with full compile |
| 5. Mac native proof, then Windows proof | Synthetic shared surfaces → backend, then one real model, then three; explicitly test reverse graph-output direction | Document every remaining CPU/GPU copy; no codecs/base64 for dense native frames; correct numerical data and bounded resource lifetime on both platforms |
| 6. Worker runtime | Move the existing runtime behind a worker adapter with one GPU owner | Output cadence remains stable during UI gestures; pause/step/reset, preview/popout and offline behavior preserved |
| 7. Scale only where needed | Demand-driven branch caching, compile-time dependency indexes, later resource lifetime reuse | Adding inactive graph structure does not materially increase steady-state execution; temporal/stateful/side-effect behavior matches reference execution |

Steps 2–4 do not depend on the desktop proof. Run that proof alongside them as a separate development track. Steps 5 and 6 must agree on device/frame ownership before integration.

Coordination check after plan approval: SPEC marks T1182 (compiler), T1238/T1239 (UI), T1241 (previews), T1243 (GPU telemetry), and T1237 (reaction-diffusion example work) in progress. The working tree also contains edits to `compiler/compile.ts`, `compiler/index.ts`, `compiler/substeps.ts`, `runtime/backend/plan.ts`, a new `compiler/frame-compile.ts`, and the Gray–Scott shader. Defer format integration, renderer-worker migration, and affected example regeneration until these owners finish their overlapping work. A standalone native-transport proof and read-only example precision inventory can proceed without touching those surfaces. Recheck claims before claiming an implementation task; a clean file alone does not prove it is unowned. Run comparative GPU benchmarks in a coordinated quiet window so concurrent agents' workloads do not contaminate results.

TouchDesigner's useful scaling principle is that a node needs both demand and a reason to cook; visible viewers and output devices create demand. [Derivative cooking model](https://derivative.ca/UserGuide/Cook). Extend this project's existing active-sink pruning rather than implementing an entirely new graph system. Cache branches only with explicit invalidation for values, expressions, media frame IDs, external channels and temporal state. Simulation steps, feedback swaps and device side effects cannot be skipped just because an output image appears unchanged.

Resource lifetime pooling and compatible-operation fusion are later options if measured memory/pass traffic dominates. Pooling must exclude resources still required by previews, temporal history, asynchronous inference or export. Fusion must respect precision boundaries, previews, custom WGSL and numerical behavior. Neither should be an initial rewrite.

Proposed benchmark ladder: 50/200/1,000/5,000 total graph nodes with active nodes and visible previews varied independently; simple chains, fan-out, nested components, static branches, feedback/substeps and multiple inference streams. Compare editor-open and output-only modes. A 1,000-node document with 20 demanded operators is a different workload from 1,000 live full-resolution passes.

Initial product targets to validate on named reference machines: responsive editing of a 1,000-node document with a bounded active set; 1080p60 output while editing; p95 gesture-to-commit below 33 ms; adding disconnected nodes changes steady-state render cost by at most 10%; depth/pose/segmentation together at individually declared model rates with bounded result age; a 30-minute run with stable memory and no queue growth. These are proposed acceptance targets, not current achievements. Final model rates/quality tiers follow the Mac and Windows model benchmarks.

For implementation, use the repository validation ladder: scoped tests, mandatory gates/typecheck, lint/build, GPU/headless coverage for rendering changes and browser tests for interactions. Format/domain/generated-artifact changes require the broader suite. Generate any example changes from their TypeScript sources. This investigation changes documentation only and leaves all existing user edits intact.
