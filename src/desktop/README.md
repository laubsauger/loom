# Loom development app in Electron

The maintained desktop host for the **actual node editor** lives in `src/desktop`;
native implementations/build tooling live in `src/devices/native`, and independent
smoke fixtures live in `src/desktop/testing`. Normal startup has no dependency on
`experiments/`, enforced by `pnpm desktop:check`. It reuses the browser application,
Vite configuration, COOP/COEP headers and runtime without changing graph fidelity.
This is not a packaged desktop distribution or native inference integration.

## Run on this development Mac

Requires Node.js 22.12+, the repository's pnpm version, Xcode with the macOS SDK,
and Apple Silicon for native Syphon support. From the repository root:

```sh
pnpm desktop:dev
```

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
The native Python helper is not launched by this command.

## Verification

```sh
pnpm desktop:check
pnpm desktop:test
```

The automated test uses its own server on port 5188 and a fresh OS temporary
profile. It opens the starter graph and asserts visible, nonuniform compositor
pixels; an Apple/Metal WebGPU adapter; cross-origin isolation; and a worker
writing through a real SharedArrayBuffer that the page observes via Atomics.
It also checks renderer Node access is absent, sandbox/context isolation are on,
same-origin blank pane windows work, and external popup requests are blocked.
It closes Electron and its server afterward. It is a correctness smoke test,
not an FPS benchmark, model inference test or complete pane-interaction suite.

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
- Camera/microphone/device and other unimplemented permissions remain denied and
  logged. This is not yet a complete desktop media workflow.
- Only named blank `loom-*` popouts are allowed. External navigation/windows are
  blocked rather than forwarded to the OS shell.
- No packaged-origin/CSP/signing/updater design, production security audit,
  or production-qualified native video interoperability yet.
- Launcher code is platform-neutral, but only macOS Apple Silicon has been run.
  Windows capability parity still requires real Windows validation and transport.

The sandbox/navigation baseline follows
[Electron security guidance](https://www.electronjs.org/docs/latest/tutorial/security).
Development HTTP/HMR and explicit denied permissions are not a production policy.

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
Sustained multi-stream performance, Windows transport, native model integration and packaged
distribution remain unfinished. The separate development viewer toggle is not a graph
emission node and is not covered by the graph-output offline preflight.

## Full-HD output scaling sample (T1349, 2026-09-11)

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
