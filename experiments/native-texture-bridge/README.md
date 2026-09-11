# Native texture import and output proofs — macOS / Apple Silicon

An isolated, runnable experiment, initially tracked by **SPEC T1249**. No app dependencies,
compiler, device bridge, or example defaults are changed. T1331 additionally fixes
the backend source-replacement cache, as documented below. This proves
synthetic texture transport from a separate Python process, **not model inference
or a production desktop wrapper**.

## Selected-output export (T1337)

```bash
node experiments/native-texture-bridge/export-run.mjs "$PWD/.cache/electron-v45.0.0-alpha.5/runtime/Electron.app/Contents/MacOS/Electron"
node --test experiments/native-texture-bridge/export-main.test.cjs experiments/native-texture-bridge/main.test.cjs
```

Separate, bounded output-only probe; no Python service or SDK needed. Runner
builds a tiny N-API oracle in an OS temporary directory, owns Vite on loopback
5190, starts a sandboxed Electron renderer with a temporary profile, then closes
Electron and Vite. Temporary build/profile files remain for inspection. It does
not touch the desktop app profile or install a driver.

The actual browser backend compiles two full-HD SDR targets, uses `present` and
`setOutput` to select A → B → A into a dedicated canvas, and Electron emits an
offscreen shared GPU texture. Native code borrows its local IOSurface pointer
only while the paint lease is held, validates BGRA8 storage and dimensions,
locks it for read-only inspection, checks four interior sample points, unlocks,
and returns tiny sample results. Every paint lease is released; unmatched stale
frames do not advance the test. Missing handles, unsupported layouts and timeouts
fail explicitly. CPU reads here are the test oracle, not a proposed video path.

2026-09-10, Electron **45.0.0-alpha.5**, PID **54776**: exit 0, three verified
selections and three lease releases at **1920×1080**. Metadata: BGRA8, bt709
primaries, sRGB transfer, RGB matrix, full range. Native samples preserve red/blue
selection, the top/bottom pattern, and linear 0.5 → encoded byte **188**.
Five harness tests pass (four export tests plus existing import terminal-failure
regression); typecheck, lint, 103 gates and build pass, with existing lint/bundle
warnings. Initial harness runs exposed initialization/structured-clone mistakes;
the runner now explicitly awaits module initialization and returns a cloneable
readiness value. Those failed runs were not native export failures.

This proves a **dedicated presentation-surface route**, not direct export of an
arbitrary WebGPU texture. No editor UI is captured. Existing-app cross-window
attachment, independent Metal/Syphon consumption, actual copy count, alpha/HDR
fidelity, sustained 60 fps, multi-output resource bounds and Windows still need
proof. The lab's synchronous oracle must not become the runtime frame path.
Current API evidence: [offscreen rendering](https://www.electronjs.org/docs/latest/tutorial/offscreen-rendering),
[shared texture ownership](https://www.electronjs.org/docs/latest/api/structures/offscreen-shared-texture),
[matching 45-alpha preferences](https://github.com/electron/electron/blob/v45.0.0-alpha.5/docs/api/structures/web-preferences.md).

## What it proves

Python loads `producer.dylib` through ctypes. Metal compute in that **Python
process** writes an IOSurface-backed texture. XPC transfers an IOSurface capability
to Electron main, where `IOSurfaceLookupFromXPCObject` obtains a process-local
reference. Electron's managed shared-texture API transfers access to a sandboxed renderer.
The renderer creates a VideoFrame, imports it into WebGPU, samples into RGBA16F,
and reads back every pixel for a correctness assertion. No CPU pixel buffer,
base64 transport, or video encoder is used to transfer the source frame in this
experiment. The final GPU readback is the test oracle, not the transport.

Only one frame is outstanding. Native writes finish before publication. The next
surface is allocated only after both the pixel result and Electron's
`allReferencesReleased` callback arrive, followed by an explicit XPC release
acknowledgment from Python. Renderer VideoFrames and imported
references are explicitly released. Failure or a 60-second timeout exits nonzero;
there is no CPU transport fallback. Surfaces are reallocated between frames, not
pooled. A bounded reusable pool and asynchronous producer fences remain later work.

The process-local IOSurface pointer stays in Electron main. **Never send this
pointer to Python or reinterpret a pointer from another process.** XPC carries
the native capability, not pointer bytes or a global surface ID. The client
checks the XPC peer PID and effective UID, and checks that the producer PID is
distinct and stable. A per-run token and single authenticated owner restrict the
prototype service. These are local test protections, not a production code-signing
or hostile-peer security review.

## Run

### Owner testing / readiness (2026-09-10)

**This probe is separate from the [maintained desktop host](../../src/desktop/README.md).**
The app shell now opens the node editor in Electron, but native textures are not
integrated into its graph. This probe opens a small automated test window,
not the node editor. On this development
Mac, the following command passed with 24 frames, 24 producer acknowledgments,
24 reference-release callbacks, exit 0 and verified service removal:

```sh
node experiments/native-texture-bridge/run.mjs \
  /private/tmp/shaderloom-electron-proof-am3ojQ/Electron.app/Contents/MacOS/Electron \
  /opt/homebrew/bin/python3 pixels
```

The Electron binary is temporary: check that this path still exists before testing
later. If it has been removed, supply an explicit compatible Electron binary using
the generic command below. No Electron app launcher is installed in this project.
The verified run took about 1.5 seconds, but earlier launches crashed, stalled or
exited slowly; this run does not establish startup reliability.

The `gpu-loss` fault test is **known failing**: device loss arrives, but the required
`allReferencesReleased` callback does not. It must time out and fail rather than
acknowledge unsafe surface reuse. Do not treat it as a passing recovery test.

Before a native-inference app-level trial, remaining work includes reliable startup and GPU-loss
teardown, renderer/backend integration, real inference models, browser-generated
input transport, bounded reusable surface pools and multi-model throughput tests.
Windows GPU transport and capability parity still require a separate implementation
and real Windows hardware validation. This probe does not prove those features.

### Prerequisites and generic command

Requirements: Apple Silicon Mac, Xcode Command Line Tools, a Node installation
with sibling `include/node/node_api.h`, an explicit Python 3 interpreter, and an Electron app
with the managed `sharedTexture` API. Tested with Electron **43.3.0**, using an
existing local cached binary, not a new production dependency recommendation.

```sh
node experiments/native-texture-bridge/run.mjs /absolute/path/to/Electron.app/Contents/MacOS/Electron /absolute/path/to/python3
```

The runner compiles the Objective-C++ N-API addon and producer dylib with `clang++`; no node-gyp,
npm install, root package changes, or Python packages are required. Build output
and isolated Electron user data go into a new OS temporary directory. The runner
registers a randomly named `com.loom.texture-proof.<uuid>` service in the current
GUI user domain using `launchctl bootstrap`. Python starts on its XPC request.
No file is installed under LaunchAgents/LaunchDaemons, no root service is created,
and no global preferences change. After the child exits, the runner uses
`launchctl bootout` on that exact service and verifies it no longer exists.
The startup log prints the exact cleanup command in case the runner itself is
forcibly killed: SIGKILL or host loss cannot execute JavaScript cleanup. Normal
Ctrl-C/SIGTERM kills the test child and continues service cleanup. A small
local window opens and exits after the test. On a restricted coding-agent host,
running a headed native GPU app may require execution outside its filesystem
sandbox; the **Electron renderer remains sandboxed** with context isolation and
Node integration disabled. Do not disable Electron's sandbox to get a pass.

For the default pixel check, exit 0 means both format probes passed in sandboxed
renderers, producer release acknowledgments completed, and service removal was
verified. Electron exit 2 reports a numeric/sandbox assertion failure; the runner
surfaces any unexpected child status as its own nonzero failure. The runner has an additional 90-second hard process
timeout (SIGKILL, reported as failure). `NATIVE_TEXTURE_PROOF_RESULT` prints the
runtime, adapter, errors and release count as JSON.

The runner also prints start/end timestamps, the Electron PID, exit status and
termination signal. A signal is a failure even if a previous pixel result was
printed; use the PID/timestamp to correlate macOS crash reports.

Three explicit failure/ownership checks reuse the same service runner without
launching Electron (the N-API consumer runs under Node):

```sh
node experiments/native-texture-bridge/run.mjs /absolute/path/to/Electron /absolute/path/to/python3 protocol
node experiments/native-texture-bridge/run.mjs /absolute/path/to/Electron /absolute/path/to/python3 consumer-exit
node experiments/native-texture-bridge/run.mjs /absolute/path/to/Electron /absolute/path/to/python3 producer-loss
```

`protocol` rejects out-of-order preparation, double release, preparation while a
surface remains outstanding, and premature disposal, then completes 24 release
handshakes. These invalid calls exercise the consumer guard, not a hostile XPC
message fuzzer. `consumer-exit` deliberately exits with code 17 while one surface
is outstanding; the runner expects that code and verifies that Python reports
zero acknowledgments, destroys its surface, and exits incomplete. Both checks
also verify service removal.

`producer-loss` kills the verified Python producer PID while a surface is outstanding.
The consumer marks XPC interruption terminal, cancels the connection, and rejects
release/new-frame requests. A new session is required; automatic XPC reconnection
must not silently substitute a fresh producer. The runner verifies exactly one
producer launch and removes the service.

The `renderer-loss` mode uses Electron. It kills the verified renderer PID while
preload retains a VideoFrame and imported reference, then requires both the
`render-process-gone` event and `allReferencesReleased` before acknowledging one
producer release. The session ends incomplete. This tests renderer-held references,
not a GPU-process crash or a crash during in-flight GPU work.

`gpu-loss` submits one shared frame to WebGPU, identifies this Electron instance's
single GPU child through `app.getAppMetrics()`, and kills only that PID. It requires
the GPU death event, device loss, and `allReferencesReleased` before acknowledging
the producer. The renderer explicitly closes its VideoFrame and imported reference
after device loss. Submission does not establish that hardware execution still
overlaps the kill. Run it with the same command above, ending in `gpu-loss`.

**Known failing gate (T1317):** two runs on Electron 43.3.0 observed GPU death and
device loss but never `allReferencesReleased`. The second also logged successful
explicit renderer reference release. Both timed out and exited 1, with zero
producer acknowledgments, incomplete producer exit, and verified service removal.
Do not convert this to a pass or acknowledge/reuse a surface merely because the
device was lost. The internal Electron/Chromium cause is not established; this
blocks an in-session reuse/recovery contract based solely on that callback.

Source inspection narrows the next investigation: Electron 43.3.0's native
`SetupReleaseSyncTokenCallback` registers the release closure through
`ContextSupport::SignalSyncToken`. That dependence on GPU synchronization is
consistent with the observed loss-path gap, but does not establish which
Electron/Chromium lifetime stage failed. See the
[version-pinned implementation](https://github.com/electron/electron/blob/v43.3.0/shell/common/api/electron_api_shared_texture.cc#L297-L310).
No upstream patch or release bypass has been applied.

**T1326 ownership localization:** an instrumented GPU-loss run (main 29933,
GPU 29934, Python 29937) confirmed main-side `sendSharedTexture` settlement and
explicit release before GPU death. Renderer explicit release followed device loss,
but the final callback arrived only during timeout-driven application teardown.
Electron logged a dangling renderer reference being released. This narrows the
blocker to the cross-process release path; it does not identify the exact native
sync-token or WebGPU lifetime failure.

That run exposed a bug in this test harness: a release callback reentering during
`app.exit(1)` could call `app.exit(0)` and acknowledge the producer after failure.
The failure latch now makes timeout terminal. A deterministic regression reproduces
the old `[1, 0]` exit sequence and asserts a single exit 1 and zero acknowledgments:

```sh
node --test experiments/native-texture-bridge/main.test.cjs
```

The separate `gpu-loss-renderer-teardown` diagnostic terminates only the verified
test renderer after device loss and explicit reference release. Main 30153,
renderer 30157, Python 30190 received the final callback after renderer termination,
acknowledged one surface and exited 0 with service cleanup. This is **terminal
renderer teardown**, not in-session recovery, pool reuse or a production restart
policy. The original `gpu-loss` gate must still fail unless its own acceptance
conditions complete before timeout. Run this diagnostic with the normal command,
replacing `pixels` with `gpu-loss-renderer-teardown`.

After the failure-latch fix, the original GPU-loss run (main 30789, Python 30800)
timed out with exit 1, zero producer acknowledgments and verified service removal.
The pixel control (main 31082, Python 31090) passed all 24 frames/releases, exited 0
in about 1.5 seconds and removed its service. No application code, model settings,
resolution, Electron dependency or sandbox policy changed in this investigation.

`early-release` closes renderer VideoFrame/imported references immediately after
WebGPU submission, before awaiting readback. This exercises submitted-work
retention instead of keeping JavaScript references alive until pixel verification
finishes. On 2026-09-10, main PID 98624 and Python PID 98631 passed all 24 frames,
24 early releases, and 24 producer acknowledgments, with the same maximum error
0.00016276041666662966 and verified service removal. This does not establish
hardware execution overlap with a crash or safe pool reuse after device loss.

The following normal control (main 99472, Python 99489) also passed all pixels,
exited 0 without a signal, and verified service removal, but took 70 seconds from
runner start to child exit. Its pixel result appeared before the delayed exit;
the process exited before an approved stack sample could capture it. This is a
lifecycle-latency observation, not a diagnosed deadlock or startup fix.

## Recorded result — 2026-09-10

### Current prerelease retest (T1328)

Per owner request, fetched the newest published prerelease,
[Electron 45.0.0-alpha.5](https://github.com/electron/electron/releases/tag/v45.0.0-alpha.5),
from the official release and verified its Apple Silicon archive SHA-256
`d9c40bdfa1973d896712e2d01bbc5efa66cdef606c3c71d8eefb31fe07f6ad9d`.
This runs Chromium 155.0.8038.2. Current official documentation still marks
[sharedTexture import/send/receive experimental](https://www.electronjs.org/docs/latest/api/shared-texture).
The 43.3.0 observations below are historical controls, not a claim about latest support.

Use the current downloaded binary for new tests:

```sh
node experiments/native-texture-bridge/run.mjs \
  "$PWD/.cache/electron-v45.0.0-alpha.5/runtime/Electron.app/Contents/MacOS/Electron" \
  /opt/homebrew/bin/python3 pixels
```

Normal pixels (main/Python 34463/34512) and early release (35344/35353) each
passed 24 frames, 24 producer acknowledgments, signed/above-one float assertions,
exit 0 and service removal. Maximum channel error remained 0.00016276041666662966.
The unchanged GPU-loss gate (main/GPU/Python 35209/35210/35216) still reached
device loss and explicit renderer release without the final callback. It timed
out with exit 1, zero acknowledgments and verified service removal. The newer
release does not resolve this measured in-session recovery blocker.

The terminal renderer-teardown diagnostic also passed on this version
(main/Python 36528/36534): one callback-backed acknowledgment, exit 0 and service
removal after the probe renderer was killed. This remains distinct from recovery
with the renderer alive.

### Existing backend GPU-copy API proof (T1330)

The backend's registered-media path already calls `copyExternalImageToTexture`
with a VideoFrame-compatible source. The new `copy-frame` mode tests that exact
API shape against Python-produced IOSurfaces, rather than assuming the earlier
`importExternalTexture` shader probe establishes the behavior of a different API.
`copy-frame-early-release` additionally closes the renderer VideoFrame/imported
reference immediately after submission, before waiting for test readback.

On Electron 45.0.0-alpha.5, both modes passed all 24 frames and GPU-aware release
acknowledgments: main/Python 41960/41964 and 42544/42548. Signed float samples
`[-0.25, 0.125, 0.5, 2]` survived and maximum channel error remained
0.00016276041666662966. Early mode reported 24 early releases. The original
importExternalTexture control (42758/42767) also passed. All three exited 0 and
verified service removal. Replace `pixels` in the command above with either mode.

This supports reusing the existing media upload boundary with **one GPU copy**
into graph-owned storage; it does not establish strict zero-copy. Tests cover
64×64, opaque, sRGB-tagged BGRA8 and RGBA16F sources into RGBA16F destinations.
They do not prove full-resolution throughput, arbitrary color spaces/alpha,
different destination formats, Windows, or app-level frame lifecycle integration.
Numerical graph inputs still need explicit float allocation to preserve these values.
The actual backend module is not executed by this isolated API probe.

### Actual backend and source replacement (T1331)

`backend-frame` starts an owned Vite server on loopback port 5189 and loads a
separate probe page importing the real `browserGpuHost` and `createVgpuBackend`.
The plan registers a native VideoFrame, uploads it through registered media,
samples it into an RGBA16F graph target, and checks `backend.readOutput` pixels.
Readback remains a test oracle. Every frame closes renderer references immediately
after render submission; rendering the same frame ID again must not reuse that
closed VideoFrame. The test also exercises replacement source counters starting
at zero, stale unregister closures, and retained output after unregistering.

This found a real backend bug: frame IDs were compared without producer identity,
so replacement sources restarting at zero kept the old image. The first native
run (main/Python 47171/47210) completed ownership handshakes but failed pixel
assertions, exit 2. A real-GPU unit regression reproduced old red instead of new
blue. Registration lifetime tokens now accompany the last uploaded frame ID;
they do not retain old producer/frame payloads. Re-registering the same source
still skips unchanged frames.

After the fix, main/Python 49167/49172 passed 24 native frames, 24 early releases,
24 producer acknowledgments and signed float samples `[-0.25,0.125,0.5,2]`, with
maximum error 0.00016276041666662966. Exit 0 and service removal were verified.
The loopback Vite server is closed afterward, including failed-run paths.
Run the normal command with final argument `backend-frame`.

This is the actual backend, but still an isolated 64×64 synthetic-source test.
There is no native-input graph node, inference model or throughput claim yet.

### Actual app Syphon output (T1338–T1343, 2026-09-10)

`pnpm desktop:test /absolute/path/to/Electron` now loads a command-authored test
project through the real project-open UI, publishes its selected output, and
checks it with an independent native Syphon client. Electron 45.0.0-alpha.5 /
Chromium 155.0.8038.2 passed A/B/A selection with 1280×720 → 1920×1080 → 1280×720
resizing. Three receiver frames per selection had exact red/blue top corners and
`[0,128,0,255]` bottom corners. This checks orientation and the SDR midtone as well
as discovery and frame delivery. All nine frames reported GPU drain. The starter
project also passed a separate nonblank-frame run.

The production-facing test path is the existing backend's extra local
OffscreenCanvas presentation, `transferToImageBitmap()`, a direct MessagePort to
a main-created offscreen output renderer, then Electron's shared IOSurface and
the native Syphon publisher. The graph is not evaluated a second time. The
SharedWorker only introduces the ports; it never receives image payloads.

Two rejected approaches are recorded, not retained as fallbacks: VideoFrame is
not exposed to SharedWorker, and Chromium's VideoFrame attachment is locked to
its agent cluster, so direct delivery to this separate renderer fails with
`messageerror`. Cross-process OffscreenCanvas ownership previously caused a
Chromium invalid-client-ID termination. GPU-backed ImageBitmap has an explicit
accelerated serialization path in the
[exact Chromium version](https://github.com/chromium/chromium/blob/155.0.8038.2/third_party/blink/renderer/core/messaging/blink_transferable_message_mojom_traits.cc).
That path clones the GPU image before exporting it: this is **not strict
zero-copy**. No codec or application CPU pixel buffer is used by the transport;
the independent receiver's small readback is a test oracle. Total copy cost and
sustained throughput remain to be profiled.

The viewer's development control is a compact SDR toggle; counters live only in
its tooltip. A real 320px toolbar check passed at 21px height with no overlap or
overflow. The remaining product integration is separate graph In/Out nodes,
native input delivery, platform parity and packaging—not proof already supplied
by this viewer control.

Storage fix: pinned Syphon builds are reused after artifact integrity checks;
compiler intermediates are discarded. Desktop smoke/export temporary profiles
and native addons are removed after their processes finish, including failed
runs. The persistent `.cache/electron-dev` profile is never part of that cleanup.

### Historical 43.3.0 process runs

**Separate-process result:** Python 3.14.6, producer PID 30200, Electron main PID
30156, 24 frames and 24 producer release acknowledgments. Electron exited 0 with
no termination signal; Python reported `released=24 finished=1`; the temporary
service was removed and absence verified. The same numeric error/float samples
below passed. Protocol and consumer-exit checks also passed with service cleanup.

Additional fault checks passed: producer-loss (Python PID 36006, consumer 35998)
failed closed without restarting Python; renderer-loss (Electron PID 36103,
Python 36107) released the held surface after renderer termination and reported
`released=1 finished=0`. Both temporary services were removed and absence verified.

GPU-loss failure evidence: main/GPU/Python PIDs 94176/94179/94182 and
95495/95496/95503, started at 18:18:38 and 18:20:12 UTC. Both reached device loss;
the second reached `renderer-references-explicitly-released`. Neither reached
`references-released`. Python reported `released=0 finished=0` on teardown.
Ownership protocol, consumer-exit, and producer-loss were rerun afterward and
passed with cleanup (consumer PIDs 95970, 96101, 96329 respectively).

**Earlier in-process experiment history (before the Python/XPC extension):**

Launch caveat: the first attempt under the coding-agent execution sandbox
aborted at 14:29:09 +0100 (PID 13477). The macOS report shows `SIGABRT` in
`___RegisterApplication_block_invoke` / `NSApplication` initialization, with no
`surface.node` image loaded. The later approved unsandboxed host launch produced
the result below and returned exit 0, while keeping the Electron renderer
sandboxed. The startup crash is real and is not a texture correctness pass.

A subsequent launch at 14:31:59 +0100 (PID 16373) timed out without producing any
pixel result. Its `app.exit(1)` and the original runner's SIGTERM timeout did not
terminate it; it was explicitly killed after a read-only stack sample. This
revealed a harness defect: the timeout now uses SIGKILL and reports termination
explicitly. The stack sample showed the AppKit event loop, not a texture operation,
but the exact earlier stall location was not captured. Stage diagnostics were
added. Four consecutive launches thereafter exited 0 without a termination
signal, each verifying all 24 frames; the first was PID 17915 at 14:34:13 +0100,
followed by three sequential runs at 14:34:40–43. No further Electron crash report
appeared during this check. **Texture import correctness is demonstrated; the
intermittent startup stall's cause is not proven or fixed.**

One relevant upstream mechanism is macOS's post-crash window-restoration prompt,
which can prevent `app.whenReady()` from resolving in Electron test runs.
[Electron's investigation](https://github.com/electron/electron/pull/51488).
That is a hypothesis for this stall, not a confirmed local diagnosis. No global
preferences were changed and no prompt-suppression workaround was installed.

**Current separate-process result JSON:**

```json
{
  "electron": "43.3.0",
  "chromium": "150.0.7871.212",
  "platform": "darwin",
  "arch": "arm64",
  "frames": 24,
  "producerPid": 30200,
  "consumerPid": 30156,
  "producerReleaseAcks": 24,
  "allReferencesReleased": 24,
  "sandboxed": true,
  "colorMaxError": 0.00016276041666662966,
  "floatMaxError": 0.00016276041666662966,
  "floatSamples": [-0.25, 0.125, 0.5, 2],
  "adapter": { "vendor": "apple", "architecture": "metal-3", "device": "", "description": "" }
}
```

Twelve 64×64 BGRA8 frames and twelve RGBA16F frames pass, with per-frame changing
patterns to detect stale frames, channel swaps and row errors. Every channel of
every pixel is compared. Tolerances are 0.01 for BGRA8 and 0.005 for RGBA16F;
most observed error is the destination half-float representation of thirds.
The float probe includes negative and above-one values to detect clamping.

The declared source and WebGPU destination color spaces are both sRGB, testing
identity numeric sampling. This does **not** validate the app's proposed linear
shader / sRGB storage contract, general HDR color management, or arbitrary data
textures. It establishes that these signed/high values survive this specific
RGBA16F import on this runtime. Single-channel R32F is not a documented format
of this Electron API; full-precision model data needs a separate contract/proof.

## What remains unproven

- Real model frameworks writing into shareable surfaces inside Python. This
  ctypes helper runs synthetic Metal compute, not PyTorch/Core ML/ONNX inference.
  Recovery in a new session after producer loss and failure during hardware
  in-flight work still need fault tests. GPU-process loss now has a reproducible
  failing reference-release gate, described above; no safe reuse claim follows.
- Browser-generated WebGPU input reaching native inference without a readback.
  Importing native output does not give JavaScript an export handle for arbitrary
  browser GPU textures.
- Sustained multi-model throughput, 1080p/4K, texture pooling, cancellation,
  producer/consumer overlap and slow-consumer drop policy. This serial test
  deliberately waits for producer completion and performs verification readback.
- Strict zero-copy inside Chromium/Dawn/Metal. API-level shared import does not
  establish the absence of internal GPU copies or color conversions. GPU tracing
  and bandwidth measurements must precede that claim.
- Windows: reproduce the same color/data/lifetime assertions with a D3D shared
  NT handle duplicated into the correct process and explicit producer completion.
  Feature parity remains an acceptance requirement, not a result of this Mac run.
- Model frameworks, accelerator interoperability and actual model precision.

These are the next gates before choosing a production desktop/native adapter.
The [larger plan](../../docs/performance-and-native-inference-plan.md) covers
app-side performance work independently of this transport experiment.

## Repository checks

T1317/T1318 follow-up: experiment JavaScript lint and `pnpm typecheck` passed.
`pnpm test:gates` returned 102 passes and one unrelated E67 Fins declared-default
failure while that example was being authored. Native checks above are the direct
proof for these isolated experiment changes; the GPU-loss mode intentionally
remains a failing acceptance gate, not a skipped or expected-success test.

Experiment JavaScript lint passed, native compilation succeeded, and the real
GPU probe supplied the focused rendering check. The Python/XPC extension also
passed `pnpm typecheck` and `pnpm test:gates` (103 tests in 13 files).
The earlier shared lint run failed on eight shader-comment backtick diagnostics
in the concurrently edited `gray-scott.wgsl.ts`; this experiment did not edit it. The
root build/full/headless/browser suites were not rerun for this isolated lab:
they do not exercise its external Electron runtime or native addon. Application
integration will require the full affected-surface validation ladder.

## API references

- [Electron managed shared textures](https://www.electronjs.org/docs/latest/api/shared-texture): import, transfer, reference release and experimental status.
- [Import texture descriptor](https://www.electronjs.org/docs/latest/api/structures/shared-texture-import-texture-info): BGRA/RGBA16F and color-space descriptors.
- [Native handle descriptor](https://www.electronjs.org/docs/latest/api/structures/shared-texture-handle): process-local IOSurfaceRef / Windows NT handle buffers.
- [Electron 43.3.0 managed preload fixture](https://github.com/electron/electron/blob/v43.3.0/spec/fixtures/api/shared-texture/managed/preload.js): sandbox/context bridge pattern used by the tested release.
- [Apple IOSurface](https://developer.apple.com/documentation/iosurface): native shared surface ownership and access.
- [IOSurfaceCreateXPCObject](https://developer.apple.com/documentation/iosurface/iosurfacecreatexpcobject(_:)): export the surface capability for XPC transport.
- [XPC Mach service connection](https://developer.apple.com/documentation/xpc/xpc_connection_create_mach_service(_:_:_:)): requires an advertised launchd service, rather than ad-hoc named registration.

Do not treat rolling API documentation as a substitute for rerunning this proof
when updating Electron.
