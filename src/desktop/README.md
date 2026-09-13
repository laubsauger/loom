# Loom development app in Electron

The maintained desktop host for the **actual node editor** lives in `src/desktop`;
native implementations/build tooling live in `src/devices/native`, and independent
smoke fixtures live in `src/desktop/testing`. Normal startup has no dependency on
`experiments/`, enforced by `pnpm desktop:check`. It reuses the browser application,
Vite configuration, COOP/COEP headers and runtime without changing graph fidelity.
Native Person Mask inference is integrated on Apple Silicon. This is still a
development host, not a packaged desktop distribution or Windows inference build.

## Run on this development Mac

Requires Node.js 22.12+, the repository's pnpm version, Xcode with the macOS SDK,
and Apple Silicon for native Syphon support. From the repository root:

```sh
pnpm desktop:dev
```

For the compiled production renderer (without React development overhead):

```sh
pnpm desktop:preview
```

This builds the editor and both native capture pages into an owned temporary
directory and serves those compiled assets, not the source development server.
The build is removed after exit; the same persistent desktop profile is retained.
It is a local preview, not an installer or signed distribution. Do not run it
alongside `desktop:dev`: they deliberately own the same port/profile.
Ctrl-C during compilation waits for the current build operation to finish,
then removes its temporary assets without launching Electron. During app use,
the launcher waits for its child to exit before retiring native worker services.

The launcher owns `http://127.0.0.1:5187/` and refuses an occupied port. It does not
attach to another agent's server. Close all app/pane windows to stop Electron and
its Vite server; Ctrl-C also stops the owned child. Local project/preferences
storage is separate from Chrome, inside this worktree's ignored
`.cache/electron-dev` profile. That profile is persistent; do not delete it if you
need projects stored there. Export important work before treating this cache as
disposable. The server remains loopback-only.

The exact Electron prerelease is pinned in `package.json` and `pnpm-lock.yaml`.
Run `pnpm install --frozen-lockfile` first; Electron's official package installer
downloads its runtime on first use, requiring network access. The Syphon build
downloads checksum-pinned upstream source and caches its verified framework by
source/toolchain identity. No binary, SDK, private cache or build output belongs
in Git. Upstream license notices are retained beside the framework.

An explicit executable argument remains available for deliberate comparisons:
`pnpm desktop:dev /absolute/path/to/Electron`. No automatic version fallback.
Python Vision workers launch on demand for native Person Mask nodes, not at app
startup. `LOOM_NATIVE_PYTHON=/absolute/path/to/python3 pnpm desktop:dev` selects
Python explicitly; otherwise the launcher resolves `python3`. Requires Python
3.11+; no Python packages or model downloads are installed automatically.

## Verification

```sh
pnpm desktop:check
pnpm desktop:test
pnpm desktop:test --production
node src/desktop/testing/renderer-startup-smoke.mjs
```

The production smoke builds its fixtures as explicit entry modules and exercises
the same native tests against compiled assets. Ordinary `desktop:preview` does
not include those fixture entries. `--production` also combines with the native
Vision test environment below and with `--startup` or `--self-input`.
The separate startup smoke interrupts a real build and asserts empty owned
temporary storage afterward; it does not launch a GPU application.

Normal launches use `entry.cjs`; `main.cjs` owns pre-ready native/profile/sandbox
setup and explicit one-shot window startup. Automation uses a separate test entry
that starts windows only after Playwright's debugger handshake. This avoids the
missing startup hook in its explicit-executable path without applying its default
loader's extra Chromium flags or patching Electron APIs. A direct compiled launch
is checked separately so the automation boundary cannot hide broken normal startup.

For native startup diagnosis, `pnpm desktop:test --startup` runs the real output,
two-frame offline export, independent input, five viewer acquisitions and reload checks, then exits without
the multi-stream measurements or self-input suite. It requires the Mac native addons.

The automated test uses its own server on port 5188 and a fresh OS temporary
profile. It opens the starter graph and asserts visible, nonuniform compositor
pixels; an Apple/Metal WebGPU adapter; cross-origin isolation; and a worker
writing through a real SharedArrayBuffer that the page observes via Atomics.
It also checks renderer Node access is absent, sandbox/context isolation are on,
same-origin blank pane windows work, and external popup requests are blocked.
It closes Electron and its server afterward. It is a correctness smoke test,
not an FPS benchmark, model inference test or complete pane-interaction suite.
Native verification also reopens the nested-input viewer output five times before
reload and checks actual producer animation ticks while the editor is hidden;
repeated publication of a cached bitmap alone does not satisfy that check.

## Version and API evidence

On 2026-09-10 the official Electron release listing identified
[45.0.0-alpha.5](https://github.com/electron/electron/releases/tag/v45.0.0-alpha.5)
as the newest published prerelease. The Apple Silicon archive was downloaded from
that release and verified against the release asset SHA-256:
`d9c40bdfa1973d896712e2d01bbc5efa66cdef606c3c71d8eefb31fe07f6ad9d`.
The app smoke test passed on that binary, as well as the earlier 43.3.0 control.
Do not infer future release support from these version-specific results.

SharedArrayBuffer is established JavaScript shared memory, not the experimental
Electron texture API. Current Electron docs still mark
[`sharedTexture` import/send/receive](https://www.electronjs.org/docs/latest/api/shared-texture)
experimental. SAB does not automatically map Python memory or share a GPU texture.
The separate [native transport probe](../../experiments/native-texture-bridge/README.md) measures
that different path and its release/failure behavior.

## Deliberate limits

- Promotion validation passed four consecutive full desktop runs, followed by the
  final three-reload/one-close loopback check and retained export oracle. Two earlier
  runs stalled before the first native frame; their cause was not established.
  Subsequent passes are bounded regression evidence, not a claim that this
  intermittent startup observation is diagnosed or that endurance is certified.

- A later compiled-renderer rerun received 45 correct full-HD frames and then
  reached the unchanged 15-second receiver deadline. The diagnostic rerun passed;
  the cause of that publication stall remains unproven. Separately, a Playwright
  attachment timeout led to the explicit test startup boundary above: protocol
  traces confirm the missing-hook error is gone, and direct startup plus full
  Syphon and native Vision suites pass afterward. This does not establish that
  the separate publication stall is fixed. Failures now capture active output
  session/canvas counters and window visibility/painting state, without extra UI.

- The narrow native-video preload exposes owner-scoped output operations and
  input list/open/poll/close with a frame-consumer callback. No raw handles or IPC
  are exposed. No renderer Node access, disabled sandbox, disabled web security,
  arbitrary native process access or automatic crash restart.
- File System Access requests from the owned app origin now show explicit consent
  with the exact file path and read/write operation. Deny is the default; directories,
  protected OS paths and malformed requests are rejected. Navigating or closing the
  page rejects pending consent, so a late answer cannot grant a new document access.
  This uses Electron's current fileSystem permission handler, not a renderer Node API.
  Permission lifecycle tests and the app smoke pass; the native file picker and full
  project save/open round trip still need a manual check on this Mac.
- Camera and microphone request Loom consent on first node use, followed by macOS
  consent when needed. Loaded projects, examples and nested components use the same
  capture path. Deny is the default; concurrent requests are coalesced/serialized.
  App choices last for the current page document; reloading resets them. macOS
  choices persist independently. Cancelled navigation preserves completed choices;
  committed navigation retires them and stale prompt answers cannot grant access.
- Settings → Permissions shows camera, microphone, speaker-selection and NDI network status,
  separating App decisions from OS access. It refreshes on consent changes and app
  focus; Open System Settings opens macOS settings without changing permissions.
  Speaker selection means selecting an output device, not ordinary default playback;
  the broker supports it, but no speaker-selection node integration exists yet.
  Other unimplemented permissions remain denied and logged.
- Run `LOOM_DESKTOP_MEDIA_CONSENT_TEST=1 pnpm desktop:test --production` for the
  scoped fake-device consent proof. Test-only dialog/OS responders exercise the real
  Electron permission handlers without accessing physical devices or changing OS
  grants. Physical camera/microphone and actual macOS prompts still need manual proof.
- Only named blank `loom-*` popouts are allowed. External navigation/windows are
  blocked rather than forwarded to the OS shell.
- No packaged-origin/CSP/signing/updater design, production security audit,
  or production-qualified native video interoperability yet.
- Launcher code is platform-neutral, but only macOS Apple Silicon has been run.
  Windows capability parity still requires real Windows validation and transport.

The sandbox/navigation baseline follows
[Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).
Development HTTP/HMR and explicit denied permissions are not a production policy.

## NDI development proof (T1335)

NDI development has a separate bounded SDK gate:
`pnpm desktop:ndi-test --sdk /absolute/path/to/approved/SDK`.
It publishes synthetic full-HD frames between independent processes and checks
decoded identity/pixels and shutdown. SDK files remain external; this command does
not enable app capabilities or bundle a runtime. See
[the native I/O plan](../../docs/native-video-io-plan.md#local-ndi-transport-proof-t1335)
for results, copy boundaries and remaining integration gates.

The Mac app's development NDI In/Out capabilities are explicitly enabled with
`LOOM_NDI_SDK=/absolute/path/to/approved/SDK pnpm desktop:dev`.
Add **NDI In** and select an exact source in its inspector. Discovery and receiving
ask for Loom local-network consent on first use; macOS can ask independently.
There is no discovery at app startup. App choices reset on reload, and Settings
shows their status without claiming to know the OS local-network grant.
The decoded path is SDR BGRA8: SDK CPU decode → owned IOSurface row copy → Chromium
shared texture → existing graph backend. This is not end-to-end zero-copy NDI.
**NDI Out** publishes its connected graph resource at full input resolution as SDR,
with first-use network consent. It reuses the existing output channel and offscreen
host; it does not evaluate a second graph. Native workers copy BGRA IOSurface rows
into two reusable staging buffers per publisher and use standard SDK async send.
Resize and stop drain the SDK before retiring those buffers. Loom limits publisher
names to 128 UTF8 bytes and each transport to four app output sessions.
Reserved publisher characters (`\ / : * ? " < > |`) are rejected before consent
or native publication: the SDK would otherwise replace them with spaces and alter
the advertised identity. See the [NDI sender contract](https://docs.ndi.video/all/developing-with-ndi/sdk/ndi-send).
An offline NDI input retains one bounded SDK receiver, not a GPU-frame lease;
its last image is marked stale. The SDK reconnects to the exact selected source
when it returns, without reloading the graph or asking for consent again.
Deleting the node or leaving the document still retires the receiver. Malformed
frames and import failures remain explicit terminal errors, not reconnect attempts.
This uses the [SDK receiver contract](https://docs.ndi.video/all/developing-with-ndi/sdk/ndi-recv), not a Loom retry loop.
Compiled-app regression passes exact-name restart on the same twice-nested graph
session with a visibly changed barcode, plus the full NDI and Syphon 1/2/4-stream
pixel/lifecycle suites. Both native output modes pass the reserved-name and
single-worker ownership contracts; staged remains the default.
NDI nominal metadata is 60 fps; actual publication follows live rendering. Offline
renders suspend network publication, like other external-output nodes.
Windows integration and cross-machine interoperability remain unverified.

Run `LOOM_NDI_SDK=/absolute/path/to/approved/SDK LOOM_DESKTOP_NDI_TEST=1 pnpm desktop:test --production`
for the synthetic-source app integration smoke. It checks denied/allowed consent,
full-HD decoded barcode pixels through Chromium and the backend, loaded root/nested
graphs with fresh-document consent, source disappearance/restart on the same
nested-graph session, and reload cleanup.
It also runs graph NDI Out→In loopback, independent 120-frame receivers for 1/2/4
concurrent publishers of one shared full-HD source, live
1080p→720p→1080p resizing, stable source identity and staging-allocation retirement.
It is a correctness test, not a sustained throughput benchmark.

Add `LOOM_DESKTOP_NDI_RECEIVE_SECONDS=60` to that command for continuous independent
receiving at each 1/2/4-publisher topology (integer 1–600 seconds). The default
remains 120 unique frames. Longer runs still require the initial 120 unique frames
within 15 seconds, and reject a 15-second unique-frame stall. Every captured frame
uses the same full-HD pixel/GPU oracle. Reports include unique fps, repeats/skips,
observed inter-arrival p50/p95, stable native staging and process-memory endpoints.
Inter-arrival includes test-oracle work: it is not capture-to-consumer latency or
an isolated codec benchmark. Endpoint memory alone does not establish leak freedom.

The staged four-stream **600-second** CPU-pixel run on 2026-09-13 passed at
58.18–58.39 unique fps per stream, zero repeats or pixel failures, and
1,029–1,163 skipped source IDs per stream. Inter-arrival p95 was 22.54–22.79 ms.
Eight Loom staging buffers stayed at 66,355,200 bytes (63.3 MiB), with no new
staging allocation during the window; all publishers/staging drained afterward.
This is four publishers of one shared animated full-HD source, not four independent
heavy graphs, a cross-machine test, or guaranteed 60 fps capacity.
Process memory was not flat: Browser working set rose about 44.7 MiB, GPU process
67.6 MiB, editor 28.8 MiB, and each active output renderer about 8.5–8.8 MiB.
Those two endpoints cannot distinguish caches/warm-up from continued growth;
only the explicitly counted Loom staging allocation is proven fixed here.

For a separate measurement of that oracle's overhead, additionally set
`LOOM_DESKTOP_NDI_CPU_MEASUREMENT=1`. The independent receiver still decodes and
checks every full-HD barcode/color/timecode, but omits its extra IOSurface/Metal
roundtrip. Reports explicitly carry `cpuMeasurement: true` and zero GPU samples.
This does not replace the default GPU correctness gate or change app rendering;
the loaded app In/Out and its Chromium/backend checks still run. Compare sequential
runs without overlapping validation jobs; host activity can still confound them.
Use `LOOM_DESKTOP_NDI_STREAM_COUNT=4` to target just one topology (1, 2 or 4);
omitting it retains the complete matrix. Publication-window logs retain native
copied/dropped/busy state and Electron CPU/memory snapshots even when a receiver
fails, before shutdown removes those owners. Native staging counts exclude SDK
codec allocations; Electron memory snapshots exclude independent receiver processes.
Native `publicationTiming` contains successful-completion samples and cumulative
nanoseconds for worker queue, setup, surface lock, CPU row copy, surface unlock, SDK submission,
other worker work and main-thread completion delivery. Their sum equals `totalNs`;
use before/after deltas divided by `samples` for window means. These are elapsed
stage times, not CPU utilization or network latency. The SDK submission can wait
for its previous async buffer; pending/failed jobs are not completed timing samples.
Output-renderer received-frame/presentation counters are captured separately from
native paint/publication counts, so loss before native publication is not blamed
on the SDK. The initial deadline is checked again after completing frame 120;
`first120Ms` makes that boundary visible in each receiver report.

Experimental comparison only: `LOOM_NDI_OUTPUT_MODE=direct` compiles a synchronous
SDK sender that reads the original readonly-locked BGRA IOSurface on a native
worker, retaining the GPU lease until send and unlock complete. It allocates no
Loom staging buffers, but the SDK still performs CPU processing/codec/network work.
`staged` remains the default; no runtime failure switches between modes. Reports
include the compiled mode. Qualify pixels, resizing, retirement and throughput
before promoting a candidate. The CPU ownership contract accepts
`--output-mode direct` (or `staged`) to validate both builds.

Current decision: staged remains default. Direct passed the full GPU/lifecycle
matrix but measured ~58.3 unique fps per stream in a 60-second four-publisher run;
the staged run immediately afterward measured ~60.0. Direct removes 63.3MiB of
Loom-owned staging for four 1080p publishers, not the SDK's internal allocations.
See the I/O plan for the preceding slower runs and host-load confounding.

`pnpm desktop:ndi-contract --sdk /absolute/path/to/approved/SDK` runs the small
CPU-only native ownership regression with one worker thread: four publishers,
immediate stop, repeated-stop Promise identity, capacity refusal and zero remaining
staging bytes. Its 4×4 fixture tests ownership only; the app video proof stays full HD.

## Native output optimization (T1345)

The viewer's compact SDR toggle publishes the selected output through Syphon on
this Mac. Diagnostics stay in its tooltip. It uses the existing graph backend;
it does not evaluate a second graph. Output remains full-resolution SDR BGRA8.

The output renderer now adopts transferred ImageBitmaps with `bitmaprenderer`,
removing its second WebGPU device and explicit swapchain copy. Native publication
reuses one Metal command queue rather than creating a queue per frame. Paint
leases remain held until native GPU completion; only one publication per output
is in flight. Resize tests wait for completed native publication, not merely DOM
canvas dimensions.

On the pinned Electron build, an independent Syphon receiver verified 126 frames
over 720p → 1080p → 720p, including 120 at 1080p, with exact sampled SDR colors and
orientation. The 1080p renderer handler measured approximately 0.011 ms/frame
versus 0.039 ms before this change. These are JavaScript handler timings, **not**
GPU/compositor timings or an app-wide speedup. A subsequent correctness rerun
overlapping the guardrail suite measured 0.019 ms/frame; timing is workload-sensitive
and these samples are not an isolated throughput benchmark. The test also asserts
one native queue creation throughout the run.

This is not strict zero-copy. Chromium's accelerated ImageBitmap serialization
clones the image; its macOS compositor may additionally copy images lacking
scanout-compatible usage. Stock Syphon publication copies into its shared surface.
Removing the explicit application copy does not prove removal of every internal
copy. Relevant source for the exact tested Chromium revision:

- [Accelerated ImageBitmap serialization](https://github.com/chromium/chromium/blob/155.0.8038.2/third_party/blink/renderer/core/messaging/blink_transferable_message_mojom_traits.cc)
- [Bitmap compositor ownership and macOS scanout](https://github.com/chromium/chromium/blob/155.0.8038.2/third_party/blink/renderer/modules/canvas/imagebitmap/image_bitmap_rendering_context.cc)
- [Syphon Metal publication](https://github.com/Syphon/Syphon-Framework/blob/71351d4b484cd2d1917867f7846a5cdca724552d/SyphonMetalServer.m)

Syphon In (including nested components), Syphon Out and the viewer output are testable now.
Add **Syphon Out**, connect a texture and set a unique **Publisher name** in the inspector.
Its **Publish** toggle stops/starts that output. It presents the input at its existing size
as SDR; it adds no graph rendering pass. Source/size changes reuse the publisher session.
The existing four-output desktop cap includes the viewer toggle; duplicate publisher names
are rejected explicitly. Offline range rendering awaits graph-output GPU drainage before
evaluating its first frame; graph publishers resume when the live session returns.

The independent receiver verified twelve exact-sampled 1920×1080 frames from the graph node
named `Loom graph smoke`, and document replacement retired its window. Scoped tests cover
two-output independent retirement, resize reuse, bounded transfer and offline preflight.
Long-duration multi-stream certification, Windows transport and packaged distribution
remain unfinished; native Person Mask is integrated below. The viewer toggle is not a graph emission node, but now
joins offline-export preflight: all viewer publishers stop and drain before the first
offline frame, including pending opens and publishers from closed panes. A failed native
release refuses the take. Viewer output stays off afterward; restart it with the SDR
toggle when returning to live output. New viewer publication is refused during a take.
Graph-node publishers retain their existing automatic live-session resumption.

## Full-HD output scaling sample (T1349, 2026-09-11)

To add continuous independent reception to the full compiled-renderer smoke:

```sh
LOOM_DESKTOP_OUTPUT_RECEIVE_SECONDS=60 pnpm desktop:test --production
```

The duration is explicit and bounded to 1–600 seconds **per 1/2/4-output case**;
it cannot combine with startup-only, self-input-only or Vision smoke scopes.
Each receiver acquires real full-HD Syphon textures and completes five sampled
pixel readbacks per frame. It checks those samples stay unchanged against the
static fixture, retains only first/last frame evidence, and reports consumed
frames/s, p50/p95 inter-consumption spacing, and start/end peak RSS. Electron
memory and publisher counts are sampled separately over the reception window.
This includes oracle readback overhead; it does not measure animated-frame
freshness, capture-to-consumer latency or a pure GPU-only receiver. All bounded
receiver processes settle before graph retirement, including on test failure.

Compiled-renderer measurement on this Mac, 60 seconds of active reception per
case (static shared source, including the oracle's readbacks):

| Active receivers | Received frames/s each | p95 frame spacing | Maximum receiver peak-RSS increase |
| --- | --- | --- | --- |
| 1 | 60.00 | 19.76 ms | 0.42 MiB |
| 2 | 60.02 / 60.02 | 19.44–19.46 ms | 0.38 MiB |
| 4 | 59.19–59.30 | 23.87–24.37 ms | 0.38 MiB |

All sampled pixels matched on every consumed frame, all receivers drained, and
publisher busy drops were zero within each reception window. Receiver peak RSS
remained ~21–22 MiB. These are bounded observations from this machine, not a
cross-platform guarantee, a paired idle-control benchmark or ten-minute
multi-stream endurance certification. p95 spacing is **not latency**; the oracle
also polls at roughly 5 ms intervals.

The subsequent **600-second-per-case** run also completed, including self-input
and resize checks afterward:

| Active receivers | Received frames/s each | p95 frame spacing | Publisher busy drops each |
| --- | --- | --- | --- |
| 1 | 59.66 | 22.15 ms | 3 |
| 2 | 59.65–59.66 | 20.11–20.13 ms | 1 / 1 |
| 4 | 59.56–59.66 | 22.05–22.77 ms | 0 / 0 / 1 / 1 |

All sampled pixels remained stable and every receiver drained its GPU work.
Receiver peak-RSS increases were at most 1.10 MiB per ten-minute window.
These are static-source endurance results, not unique animated-frame rates or
latency measurements. The full smoke now separately decodes a 24-bit absolute
frame barcode at 1080p, with ten-second visible, hidden and restored editor
phases for 1/2/4 simultaneous outputs. That oracle reads 24 pixels per received frame and distinguishes repeats,
skipped IDs and unique frames; it does not measure capture-to-consumer latency.

The first single-output run measured 60.04 / 60.04 / 60.06 unique frames/s across
those phases, with zero skipped IDs and one repeat in the restored phase. Although
the native editor window was hidden, Chromium reported its document as visible;
the test did not change background throttling. No scheduling fix is inferred from
that passing observation.

The subsequent full 1/2/4 run passed all 21 receiver windows (ten seconds each):

| Animated outputs | Visible unique frames/s each | Hidden | Restored |
| --- | --- | --- | --- |
| 1 | 58.76 | 58.69 | 58.71 |
| 2 | 59.66–59.88 | 59.61–59.72 | 59.59–59.78 |
| 4 | 58.75–59.82 | 57.77–59.20 | 58.61–60.00 |

Each window contained 0–2 repeated publications and 1–23 skipped absolute IDs;
none froze or regressed. All shared one animated source, so this isolates
transport scaling rather than four independent shader/model workloads. Sampling
overhead and competing system activity remain possible costs. The smoke reports
publisher/drop counters alongside these measurements; skipped source IDs alone
cannot identify which upstream stage missed a frame. It verifies freshness and
ownership, not a universal minimum FPS on arbitrary hardware.

The final counter-instrumented regression also passed all 21 animated windows,
static-duration reception and the full lifecycle suite. Its rates varied under
uncontrolled system activity: an end-of-run process snapshot showed active Blender,
Chrome, Metal compilation and another Vitest worker. Those results prove the
counter/cleanup paths, not idle-machine performance or a product regression.
Across visible/hidden/restored phases, unique rates were 56.76–59.78 (one output),
57.28–59.56 (two), and 45.40–58.53 (four), with respectively 3–16, 2–12 and
10–102 publisher busy drops per ten-second window. This variability is retained
in the evidence, not removed by retrying until a faster sample passes.

Electron 45.0.0-alpha.5 / Chromium 155 / Apple Metal. Each row uses one shared static
1920×1080 source and distinct Syphon Out publishers. Ten one-second sampling intervals;
independent receivers validate pixels before timing, then exit. These are completed
publisher operations, not measurements of distinct animated frames or receiver latency.

| Outputs | Publications/s per output | Aggregate/s | Native busy drops |
| --- | --- | --- | --- |
| 1 | 58.60 | 58.60 | 0 |
| 2 | 59.30, 59.50 | 118.80 | 0 |
| 4 | 58.66, 58.56, 58.56, 58.76 | 234.54 | 0 |

Four-output sample: 10.041 seconds; lowest individual one-second rate 55.57/s.
The logical RGBA8 payload represented by 234.54 full-HD publications/s is about
1.95 GB/s (decimal), **not measured memory-bus bandwidth**; internal copies add traffic.
The pinned Syphon Metal implementation still performs its publication blit without
receivers, but this run excludes subscriber notifications/consumption during timing.
No obvious publisher-side scaling bottleneck appeared up to the current four-output cap.
This is one short, non-exclusive development-machine sample, not an endurance or
multi-model benchmark. Full native smoke now includes the 1/2/4 comparison and logs
`LOOM_MULTI_OUTPUT_MEASUREMENT`; all fixture windows retire on project replacement.

## Native input bridge (T1346)

The Mac launcher now builds and loads both native addons into the same owned
temporary directory. `loomDesktop.input` exposes discovery by exact source UUID,
`open(uuid, async (frame, metadata) => { ... })`, `poll(session)` and
`close(session)`. Receiver registration precedes any polling. The callback must
finish consuming the VideoFrame before its promise resolves; the preload then
closes that frame and releases its Electron import. Callback failures surface on
poll, rather than becoming silent no-signal. Retaining a callback blocks subsequent
native acquisition instead of accumulating images.

The native lease is released only by Electron's `allReferencesReleased`, never by
send completion. Main-process sessions remain owner/frame/origin-scoped and bounded,
including closed sessions with outstanding references. Closing during consumption
does not invalidate the held frame. This follows the
[API contract for the tested version](https://github.com/electron/electron/blob/v45.0.0-alpha.5/docs/api/shared-texture.md).

The desktop smoke now additionally verifies three 1080p frames through
app output → Syphon → native input → Electron VideoFrame → actual `createVgpuBackend`
external texture/render pass. Sampled blue/green pixels, orientation and dimensions
pass exactly. Test-only backend readback supplies the oracle; transport itself
does not use those bytes. The round-trip backend is isolated for verification,
not a second runtime proposed for production graph ingestion. The 27 main/preload
lifecycle tests cover ownership, close races, consumer errors and release ordering.

This bridge proof is not a sustained multi-stream benchmark or arbitrary-publisher
coherence proof. The native input's
owned surface adds a GPU copy and protects against later producer writes, but does
not establish synchronization against an independent producer writing during that
copy. That interoperability gate remains open.

## Syphon In node (T1347)

### Same-app graph round trip (T1349)

Run `pnpm desktop:test <Electron executable> --self-input` for the focused proof.
It opens an authored project, connects Syphon In to the app's own named Syphon Out
through the normal source picker, and checks 1080p → 720p → 1080p with unchanged
publisher UUID. The receiver is a separate graph branch, not a dependency cycle.
Three display samples per size match the direct source exactly; three raw full-HD
frames also pass exact sampled-color checks. Display screenshots have the same
color shift on both direct and received views; raw transport samples do not.
Syphon Out's tile must report live, using its input texture without an added graph
pass. Reload must retire the publisher window AND drain all main input records;
the focused smoke rejects input lifecycle errors on stderr. Both native directions
retire at committed navigation. Documents that used native inputs first block
unload, stop consumers, release renderer-held frames/imports and await confirmed
main-process GPU drainage before resuming reload or close. This keeps the renderer
IPC context alive for Electron's final-reference acknowledgement. Pending opens
and locally forgotten sessions cannot skip that barrier. A 15-second drainage
failure leaves the document open with an explicit error; it never force-releases
an IOSurface. Pagehide remains a final renderer cleanup boundary.
Retired in-flight operations return explicit `closed`; live input errors and GPU
release failures still reject. Startup now waits for the output renderer's first
graph bitmap before starting offscreen painting/publication: an empty window is
not a discoverable Syphon source. The one-time handshake is restricted to that
output's main frame; it adds no per-frame IPC. The focused `--self-input` smoke now
runs three complete startup/resize/reload cycles in one process, followed by a
fourth live session closed through the normal BrowserWindow close operation.
All three reloads pass exact pixel checks and zero retained main input records;
the close retires both windows and exits without unload failures or pending
input leases at shutdown.
This is a bounded regression check, not endurance certification.
The viewer selector now includes uncompiled ordinary preview outputs; selection
requests materialization through the existing preview-interest scheduler, rather
than requiring the node's tile to be visible first. Listing nodes alone does not
cook them, and explicit preview-off remains respected. Combined desktop validation
now passes project switching, nested input, live input/output reload, 1/2/4
publishers and the final self-loop/resize/drain sequence. Pixel assertions tolerate
a canvas being replaced during resize within the same 15-second deadline; they
still require exact direct/received equality.
This is not a latency,
animated-frame freshness, or sustained active-multistream benchmark.

Add **Syphon In** in the node library and select a publisher in the inspector's
Source picker. The picker only discovers; the demanded graph owns the session.
It saves the exact discovery UUID, not a native handle. A restarted publisher gets
a new UUID and requires explicit re-selection; no arbitrary replacement is chosen.
Browser-only mode reports that the macOS desktop capability is required.

The node adopts incoming dimensions through `node.setResolution`, including inside
nested components. Internal sizes are stored as relative-path resolution overrides
on the owning instance, never written into the shared definition. Two linked
instances can therefore receive different dimensions. Flattening applies those
overrides before compilation; save/load, undo, clearing and dry-run are covered.

The app holds one cloned VideoFrame until the existing backend synchronously
submits its image copy, then closes that clone at the microtask boundary. Pausing
holds at most one pending frame and suspends further IPC polling until consumption.
Pruning, deletion and document replacement unregister and close the owned source.
Source errors report stale retained pixels; live inputs are declared non-reproducible
for offline-render warnings. No second graph runtime is created for the node.

The real desktop test loads a command-authored project with two nested component
levels, selects the native node,
asserts its resolved 1920×1080 size and compares its displayed pixel against an
equivalent graph-generated color control from an independent native publisher.
Both display `[73,31,16,255]` for source `[73,31,17,255]`: the one-code blue difference
also occurs without native transport. The test asserts exact agreement with that
control, not a widened tolerance; locating the existing graph/display difference is
separate unfinished work. Source ownership, inspector selection, pruning and
document-replacement tests are scoped to their files; do not run the full test suite.

## Native Person Mask

In the Electron app, connect **Person Mask** and select **Transport → Native GPU
(Electron)**. The browser's Device helper mode remains available as an explicit
choice; a failed native session never switches transports automatically.

The graph's existing 512-square letterbox preprocessing is unchanged. GPU packing
preserves the helper's exact RGBA8 clamp/round values, including alpha, inside an
opaque RGB capture. Python receives an IOSurface capability over XPC, runs Apple
Vision, and returns a GPU-expanded RGBA16F mask. Electron imports it into the
existing graph media registry. Image pixels do not pass through JavaScript CPU
readback, base64, WebRTC or a codec in this native path. Copies and format passes
still exist on the GPU; **this is not a strict zero-copy claim**. Vision's internal
copies and chosen accelerator are not characterized.

One pending frame/result per node, at most eight sessions including retirement.
Realtime honors Min interval. Offline export drains live work and resets model
history before the take, then starts independent models together and waits for
all submitted models per frame, including on failure; it preserves the existing export
contract's deterministic **one-frame inference lag**, without double-stepping
temporal nodes. Pruning, deletion, project replacement and navigation retire the
worker/history. A timeout with uncertain ownership reserves its resources and
reports failure rather than reusing memory unsafely.

Scoped graph + actual editor UI + two-frame export + reload proof:

```sh
LOOM_DESKTOP_VISION_PHOTO=/absolute/path/to/person.jpg \
LOOM_NATIVE_PYTHON=/absolute/path/to/python3 pnpm desktop:test
```

This explicit fixture mode replaces the regular Syphon smoke scenarios. It checks
1920×1080 person/blank/person results, successive frames in one session, two
independent model workers with opposite/swapped inputs, every
preprocessed input byte through the capture renderer, and unchanged backend
readback counters during inference. Only the test oracle reads pixels. It uses
a generated test camera, not the user's camera, and removes its owned temporary
profile/build/services after Electron exits. It does not benchmark inference
throughput, prove every native IOSurface input byte independently, or certify GPU
loss, long-run memory or Windows parity.

Add `LOOM_DESKTOP_VISION_SOAK_SECONDS=600` to sample sustained frame progress,
Python RSS, Electron process memory and renderer heap for ten minutes. It then
bypasses the model for a sixty-second source-only control, records a diagnostic
garbage collection, resumes inference, and checks export/reload. Forced GC is
test-only, never an application memory-management policy. Samples are
observational memory evidence, not a leak-proof allocator audit.
Add `LOOM_DESKTOP_VISION_MEMORY_PROFILE=1` to that soak for sampled native and
JavaScript allocation stacks before/after bypass and diagnostic GC. Profiling
changes cost; do not use that run to claim throughput without profiling overhead.

An earlier unprofiled 600-second run completed 9,613 results with one worker
(~49–53 MiB RSS). The initial CPU mask now releases after the first result,
saving 15.82 MiB per 1080p node. Editor RSS nevertheless rose from ~560 to
822 MiB and continued rising after native sessions retired. Investigation found
304,117 retained React development timing records in a subsequent run; clearing
that test history plus diagnostic GC reduced the browser's tracked non-JS heap
from ~51 to ~9 MiB. The follow-up completed 10,181 results in 600 seconds with
zero retained timing entries: editor RSS ~571→545 MiB (60-second warm-up:
~536→545 MiB, versus ~551→822 MiB before the fix). Worker RSS remained
~49–54 MiB. The following minute with inference retired stayed ~545–546 MiB;
export, resumption and reload also passed. These are separate observed runs,
not a controlled throughput benchmark or proof against every possible leak.

Development bootstrap now retires User Timing name groups owned exclusively by
React's component/scheduler tracks. It preserves unknown/custom records and
same-name collisions; it does not monkeypatch timing APIs or force GC. Recorded
DevTools traces survive (real Chromium gate), but retrospective `getEntries()`
and later `buffered:true` observers no longer see retired React history. Colliding
custom names are intentionally retained, so this is not a universal timing-buffer
bound. HMR disconnects the observer; normal document ownership survives BFCache.
The production bundle excludes this code. React enables these tracks by default
in development, not production. [React performance-track documentation](https://react.dev/reference/dev-tools/react-performance-tracks).

### Why the native path helps

For one 1080p Person Mask at 10 inferences/s (the default interval), theoretical
application-controlled traffic is:

| Cost | Browser + device helper | Native GPU transport |
| --- | --- | --- |
| Model-input CPU readback | 4 MiB/run, 40 MiB/s | None |
| Expanded mask CPU upload | 7.91 MiB/run, 79.1 MiB/s | None |
| Loopback image serialization | ~1.33 MiB input/run, plus mask/JSON | Capabilities + small metadata |
| Codec encode/decode | None in this helper path | None |
| GPU format/copy work | Preprocess + upload | Opaque pack/unpack + float mask import/copy |
| Extra models | Repeat CPU transfers/serialization | Independent bounded GPU sessions; model/GPU contention remains |

Thus about **119 MiB/s per model** of explicit CPU↔GPU image transfers disappears
at that cadence, before counting serialization and CPU mask expansion. This is
arithmetic, not measured system-memory bandwidth or a promised FPS/latency gain.
Native RGBA16F output itself is 15.82 MiB/frame of GPU-resident data, so memory
traffic has not vanished. Compared with a proposed WebRTC bridge, native also
avoids codec work and buffering; the existing Person Mask helper did not use
WebRTC, so no codec saving is attributed to that baseline.

## Native Vision provider proof

`src/devices/native/vision-surface.{h,mm}` supplies the real Apple Vision person
matte stage to a separate Python process through a narrow native ABI. It uses the
existing helper's balanced revision-1, OneComponent8 request, wraps a BGRA8 input
IOSurface directly, and GPU-packs the mask into a linear RGBA16F IOSurface. No
CPU image upload, readback, base64, or codec transport exists in this provider.
Vision's internal copies and accelerator selection are not established by this
test. RGBA16F is the tested float-transport shape, not a claim that the model
produces more than eight bits of mask precision.

Run the scoped real-model proof on Apple Silicon with Xcode tools and Python
3.11 or newer. Supply an absolute path to a clear person photograph yourself;
the runner does not download fixtures or install Python packages:

```bash
node src/desktop/testing/vision-surface-smoke.mjs /opt/homebrew/bin/python3 /absolute/path/to/person.jpg
```

The runner builds into an owned temporary directory and removes it afterward.
A test-only oracle checks every packed pixel against Vision's own mask, plus a
generated empty image. It requires a nonempty person result and an empty negative
control, checks result ownership/failure cases and verifies that the normal
library does not export the readback oracle. The tested positive control was
[MediaPipe pose.jpg](https://storage.googleapis.com/mediapipe-assets/pose.jpg),
SHA-256 `c8a830ed683c0276d713dd5aeda28f415f10cd6291972084a40d0d8b934ed62b`.
It produced a 512×384 mask with 6.96% foreground; the empty control produced none.
A warm model-plus-packing call measured about 16 ms in the final local run.
This is not a throughput benchmark or app end-to-end latency measurement.

Session calls belong to their creating thread. Input producer writes must finish
before inference; result writes finish before the provider returns. Only one
result can be held, and its consumer GPU reads must finish before release.
Reset clears temporal history and, like destruction, refuses a held result.
Never serialize these process-local pointers: cross-process work needs IOSurface
capability transfer and explicit lease acknowledgments. A serial dispatch queue
alone does not guarantee this provider's thread affinity.

### Real-model input/result IPC

Add `--transport` to the command above to run the real Vision provider in a
separate Python-owned XPC service. The test client exports its input IOSurface,
the worker wraps that input and infers, and the client imports the returned
result IOSurface. Surface IDs agree on both sides of each transfer; every result
pixel matches a separate local Vision reference with matching temporal resets.
Pixel readback and blocking client requests exist only in the standalone oracle,
not the service or provider. This test does not run Electron.

`src/devices/native/vision-service.{py,mm}` enforces same-UID/per-run-token access,
one owning connection, ordered requests and one held result. `infer` returns only
after all input reads and result writes have completed; `release` is valid only
after consumer reads finish. Reset/finish refuse held results. Owner disconnect
terminates the session and discards its storage without reuse or reconnection.
The service's main CFRunLoop keeps Vision calls on the Python main thread; it
does not execute on Electron's main thread.

The test also checks bad credentials, a second owner, missing/malformed input
capabilities, unsupported format, unknown operations, out-of-order release,
double release, held-result infer/reset/finish, and disconnect without release.
The runner registers an isolated random launchd service for each scenario,
verifies worker exit, removes the exact service, waits for confirmed removal,
then deletes its owned temporary build. Failed service removal preserves the
build and reports its name/path rather than deleting beneath a live service.
No implicit downloads or persistent services are created.

### Asynchronous Electron client

`--async-client` runs the preceding checks plus the main-process N-API client in
the repository's pinned Electron runtime, with an owned temporary profile:

```bash
node src/desktop/testing/vision-surface-smoke.mjs /opt/homebrew/bin/python3 /absolute/path/to/person.jpg --async-client
```

`src/devices/native/vision-client.mm` uses asynchronous XPC replies and Node-API
thread-safe callbacks, with no blocking IPC, waiting libuv worker or image
readback. Actual Electron 45.0.0-alpha.5 checks verify full result pixels while
main-thread timers advance during each inference. This is a responsiveness
proof, not an end-to-end latency or multistream throughput benchmark.

Main-process API:

| Operation | Ownership rule |
| --- | --- |
| `open(service, token)` | Returns a local session ID; cap eight, including quarantined sessions. |
| `infer(id, inputHandle)` | Requires finished producer writes. Retains input until an authenticated completion; resolves with provider-owned RGBA16F result handle/dimensions/sequence/PID. |
| `release(id, sequence)` | Call only after consumer GPU reads finish. Rejects stale result callbacks; retains result until release acknowledgment. |
| `reset(id)` | Clears model history; refuses pending work or a held result. |
| `close(id)` | Finishes and removes an idle, fully released session. |
| `disconnect(id)` | Cancels an empty session; refuses pending work or retained input/result leases. |

Handles stay in trusted Electron main code; never send them through renderer IPC.
Async errors distinguish `VISION_REQUEST_REFUSED` (authenticated completed
request) from `VISION_COMPLETION_UNCERTAIN` (timeout/loss/malformed completion).
The latter terminates the connection and retains uncertain surfaces and session
capacity. Neither a timeout nor a later reply may authorize upstream reuse or
replace Electron's `allReferencesReleased` callback. No automatic reconnect or
force-release recovery exists; uncertain sessions currently require process
shutdown. This limitation must remain visible in app integration.

The timeout test briefly stops only its authenticated Python worker, verifies
that Electron timers continue throughout the 15-second timeout and that close/
disconnect cannot discard the uncertain input, then resumes the worker and
verifies service removal. The ordinary case also checks rejected concurrent
requests, bad credentials, malformed local handles and the session cap.

The app integration described above now uses this client for graph input capture,
GPU-aware result import/acknowledgments, node wiring, on-demand worker ownership,
and document/reset cleanup. The standalone client probe tests the transport in
isolation; the separate graph/UI smoke proves the integrated Person Mask path.
Windows model/transport parity remains unimplemented.
