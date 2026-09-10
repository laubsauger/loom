# Native texture import proof — macOS / Apple Silicon

An isolated, runnable experiment, tracked by **SPEC T1249**. No app dependencies,
compiler, backend, device bridge, or example defaults are changed. This proves
synthetic texture transport from a separate Python process, **not model inference
or a production desktop wrapper**.

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
