# Native video I/O for Electron

Research checked 2026-09-10; implementation status updated 2026-09-13. Mac Syphon In/Out and native Person Mask are integrated and exercised in development and compiled Electron renderers. NDI local development terms are owner-approved; Mac NDI In/Out passes full-HD graph loopback, loaded root/nested input graphs and short independent 1/2/4-stream receiver proofs. Sustained/cross-machine performance qualification, Windows Spout/NDI and virtual-camera distribution remain pending; no SDK redistribution or camera driver registration authorized. This plan separates documented SDK behavior, passed Loom proofs and still-unmeasured transport paths.

## Product scope

Ship separate input and output nodes. Recommended catalogue: **Syphon / Spout In**, **Syphon / Spout Out**, **NDI® In**, **NDI Out**. Local texture nodes use the platform's named protocol, not an automatic fallback between transports. SpoutCam interoperability belongs to Spout Out plus the existing Webcam input, not a fictional second GPU-sharing protocol.

TouchDesigner likewise separates local texture In/Out from network NDI In/Out, and treats virtual cameras as device inputs. This is the useful workflow precedent; its older hardware restrictions and firewall advice are not requirements for our implementation. [Local texture input](https://docs.derivative.ca/Syphon_Spout_In_TOP), [NDI output](https://docs.derivative.ca/NDI_Out_TOP), [live-source workflow](https://learn.derivative.ca/courses/100-fundamentals/lessons/102-tops-working-with-images/topic/live-sources/).

SPEC §C now records an Electron-only native-video-I/O track: local texture In/Out and NDI In/Out on macOS/Windows, SpoutCam interoperability on Windows, macOS virtual-camera capability as a separate delivery gate. Browser-only deployment remains supported; core graph/compiler must not assume Electron. General capture expansion and native plugin ABI remain excluded. The owner requested these capabilities; this document does not silently widen browser permissions or authorize driver installation.

| Capability | macOS / Apple Silicon | Windows | Browser / headless without adapter |
| --- | --- | --- | --- |
| Local texture In/Out | Syphon Metal | Spout DirectX | Explicit unavailable diagnostic; project still loads |
| NDI In/Out | Native NDI SDK | Native NDI SDK | Same diagnostic; injected recorded frames for tests |
| Read virtual camera | Existing Webcam, with camera consent | Existing Webcam can select installed SpoutCam, with consent | Existing webcam support where permitted |
| Publish virtual camera | Separate signed Core Media I/O camera extension | Spout Out consumed by user-installed SpoutCam | Not available |

Parity means both platforms can exchange local textures, network video and eventually virtual-camera video; it does not mean identical APIs, drivers or installation requirements. macOS camera publication is not fulfilled by shipping Windows SpoutCam support.

## Current official API evidence

- **Spout:** Windows GPU sharing with DirectX 9/11/12 and OpenGL. Use DirectX for the Windows proof, not an extra OpenGL context. The current master update log identifies SDK 2.007.017; pin an exact revision when acquiring it, rather than calling a branch immutable. [SDK](https://github.com/leadedge/Spout2), [update log](https://raw.githubusercontent.com/leadedge/Spout2/master/UPDATES.md).
- **SpoutCam:** a virtual webcam that receives Spout, currently a DirectX 11 / DirectShow implementation. Its source describes separately registered 32/64-bit filters. Receiving its camera feed is a camera capture path, not direct Spout reception; publishing to Spout does not install or enable a camera. [Maintainer repository](https://github.com/leadedge/SpoutCam).
- **Syphon:** macOS IOSurface-based sharing with Metal support. Importantly, the official Metal server's `publishFrameTexture` copies or renders into its BGRA8 shared surface and publishes after command-buffer completion. Thus the project's broad “zero copy” description must not become an end-to-end Loom performance claim. Baseline BGRA8; do not promise float output through this stock server API. [Framework description](https://github.com/Syphon/syphon.github.io/blob/master/index.markdown), [actual Metal server](https://github.com/Syphon/Syphon-Framework/blob/main/SyphonMetalServer.m).
- **NDI:** directly fetched release notes now list **6.3.2, 2026-04-13**; search snippets still returned 6.3.1. High Bandwidth uses SpeedHQ compression; HX is another codec family. It is not an uncompressed numerical tensor channel. [Current release notes](https://docs.ndi.video/all/developing-with-ndi/sdk/release-notes), [codec overview](https://docs.ndi.video/all/getting-started/white-paper/encoding-and-decoding).
- **Electron:** import/send/receive `sharedTexture` remains experimental. Imported native storage must remain valid until `allReferencesReleased`, not merely until send resolves. Handles are process-local: Windows NT HANDLE or macOS IOSurfaceRef; serialized pointer bytes are not cross-process ownership transfer. Advertised import formats include BGRA/RGBA8 and RGBA16F, but that list is not proof of compatibility with a particular producer's synchronization or layout. [API](https://www.electronjs.org/docs/latest/api/shared-texture), [handles](https://www.electronjs.org/docs/latest/api/structures/shared-texture-handle), [formats](https://www.electronjs.org/docs/latest/api/structures/shared-texture-import-texture-info).

Use the exact experimental Electron binary selected and tested by the desktop track, currently recorded as 45.0.0-alpha.5 in [the local app README](../src/desktop/README.md). Recheck the official release and matching headers before implementation; no automatic runtime downgrade. SharedArrayBuffer is CPU shared memory, not this experimental GPU API and not an automatic Python-memory mapping.

## Reuse and missing boundaries

Read directly in this repository:

- `src/nodes/definitions/media.ts`: pure compile-time external scratch texture plus blit, keyed by `mediaSourceIdFor(nodeId)`. Its current scratch is fixed SDR sRGB; do not reuse that assumption for arbitrary native formats.
- `src/runtime/backend/backend-types.ts`: `registerMediaSource`, pull-based `MediaSource.currentFrame()`, monotonically changing `frameId`, either bytes or image. Unchanged IDs avoid repeat uploads. `ended` currently retains last pixels.
- `src/app/use-media-sources.ts`, `src/app/media-sources.ts`: established app-side media ownership locations (paths located; implementation must be read fully before edits).
- `src/devices/device-hub.ts`: local device-service lifecycle, distinct from MCP. Keep native transport/session ownership in `src/devices`; do not route pixels through the loopback JSON readings stream or introduce an agent dependency.
- `src/nodes/definitions/output.ts`: existing sink precedent. New enabled video outputs must participate in graph demand, including when no preview is visible.
- `src/desktop/README.md`: maintained desktop host integrates Syphon In/Out and an explicit native Person Mask transport on Apple Silicon through the existing graph/backend. Person Mask launches owned Python/Vision workers on demand; real 1080p graph/UI, two-worker swapped-input, export and retirement proofs pass in development and compiled builds. React development timing-history growth was identified and bounded in a follow-up ten-minute run; no universal leak-freedom or Windows inference parity claim. Camera/microphone now request first-use consent; Settings separates App/OS permission status. Physical-device consent still needs manual proof. Mac NDI In/Out is integrated behind external SDK opt-in; sustained/cross-machine NDI and Windows/Spout remain unverified. See that README for setup, copy accounting and current validation boundaries.

Proposed integration: serializable node definitions → ordinary compiler resources → app adapter's demanded subscriptions → native device sessions → `MediaSource` image handoff → backend GPU copy. Keep direct `vgpu` access inside `src/runtime/backend`, Electron imports outside domain/compiler, and configuration changes inside domain commands. Reuse the T1331 backend proof before adding a second ingestion mechanism.

**Output is a separate feasibility gate.** Electron offscreen shared-texture paint exposes a Chromium-rendered surface, not arbitrary graph GPU textures. It could support a dedicated graph-output surface, but would add rendering/window lifecycle and potentially color/alpha conversion. Do not capture the editor UI and call it node output. [Electron paint/shared-texture contract](https://www.electronjs.org/docs/latest/api/web-contents).

T1337 originally proved the narrow dedicated-surface route: actual backend `present`/`setOutput` selects A/B/A at 1920×1080 in an isolated output-only renderer; a native IOSurface oracle verifies BGRA8 pixels, orientation and sRGB midpoint through Electron's shared handle. T1349 subsequently integrated existing-app attachment, graph output, independent Syphon reception and same-app loopback. Compiled-renderer checks also pass those paths, nested sizing, export and reload. Four shared-source full-HD publishers reached ~60 publications/s each in ten-second publisher-only measurements; this is not receiver latency or a long-duration throughput certificate. Native CPU inspection is test-only. [Original probe](../experiments/native-texture-bridge/README.md#selected-output-export-t1337), [current integration and copy accounting](../src/desktop/README.md).

## Proposed transport contracts

| Path | Initial engineering hypothesis, not measured copy count | Required proof |
| --- | --- | --- |
| Syphon In | Receive native image; acquire stable owned surface if publisher can overwrite; Electron import; backend GPU copy | Producer-update race, surface ownership, orientation and SDR color |
| Spout In | Open producer resource through Spout synchronization; copy into owned NT-shareable texture if required; import; backend copy | Legacy/shared versus NT handle compatibility, adapter identity, fences/mutexes, Windows run |
| Local Out | Selected graph output → proven export surface → native publisher | No CPU readback; enumerate every render/copy, prove outgoing pixels in independent receiver |
| NDI In | SDK receive/decode → owned native staging/upload → backend texture | Count CPU copies and upload, preserve stride/color/alpha; no zero-copy label |
| NDI Out | Selected graph output → explicit staging/readback for standard SDK → encode/network | Readback and codec cost visible, bounded work off rendering thread |
| Virtual camera | Local sender → camera adapter → capture consumer | Negotiated format/FPS, permissions, no assumed alpha or float preservation |

The standard NDI receive API provides frame buffers and format choices, including BGRA and higher-precision YUV forms; its `best`/`fastest` modes can deliver fields. Start with explicitly declared progressive SDR BGRA support, not a hidden conversion of arbitrary HDR/fielded input. Unsupported content gets a diagnostic until a tested conversion is selected. [Receive formats](https://docs.ndi.video/all/developing-with-ndi/sdk/ndi-recv).

NDI asynchronous send keeps using submitted memory until a documented synchronizing operation. Its ordinary async entry can synchronize with the previous submission, so run it on a native service thread. Advanced SDK completion callbacks are separately licensed capability, not a free assumption. Bind against acquired SDK headers: the current standard guide spells the async symbol differently from the Advanced completion page. [Standard send lifetime](https://docs.ndi.video/all/developing-with-ndi/sdk/ndi-send), [Advanced completions](https://docs.ndi.video/all/developing-with-ndi/advanced-sdk/ndi-sdk-review/sending/asynchronous-sending-completions).

Application-owned contract, to test before node rollout:

1. Each connection has an opaque ID plus generation. Frame descriptors carry sequence, dimensions, storage format, color primaries/transfer/range, alpha mode, orientation and capture timestamp. Persist source selection, never native handles or live generation IDs.
2. Keep at most one unsubmitted newest frame per input/output and a fixed, declared number of in-flight leased surfaces. Replace only unsubmitted frames; count drops. A slow peer cannot grow memory or block the renderer. No automatic resolution, bit-depth or frame-rate downgrade.
3. Fence producer writes before consumer reads. Do not hold a third-party publisher's write lock until Electron eventually releases a frame: copy under that lock into an owned leased surface where required, report that GPU copy, then unlock. Native pointer lifetime alone does not prevent pixel overwrite.
4. Release source leases only at the actual consuming API's completion boundary. NDI receive buffers free after native copy completes; asynchronous send buffers remain owned until SDK synchronization; Electron native surfaces remain owned through all-reference release. Closing JS objects is not sufficient evidence.
5. Stop and drain on deletion, document replacement, source selection change and renderer exit. An unused input closes its subscription; a live enabled output remains a sink. Reconnection to the selected source is visible state, never substitution with an arbitrary available sender. Initial no-signal is explicit; existing last-frame retention must be labeled stale.
6. Resize/format change increments generation; retire old frames only after release. GPU loss marks transport failed and stops publication. Existing probe GPU-loss teardown gaps block production readiness; never recycle a possibly referenced texture on timeout.
7. Input timestamps are external observations. Output timing derives from `FrameEvaluationInput`; scheduling clocks stay in adapters. Tests inject recorded frames and timestamps. Live network delivery is not deterministic replay.

## Packaging, permissions and license gates

Owner approved supplied NDI SDKs for local development on 2026-09-13, not redistribution.
The macOS package is signed/notarized by NewTek; inspected version is 6.3.2.0.260413.
Headers, macOS universal runtime and license notices were selectively extracted to
private temporary storage without running the installer. No SDK/runtime is added to
the repository or builds. Windows builds will be tested manually by the owner later.

Spout is BSD-2-Clause: preserve notices/conditions in source and binary distributions. Syphon's source uses equivalent simplified BSD conditions. Review the exact acquired trees and bundled notices before packaging. [Spout license](https://raw.githubusercontent.com/leadedge/Spout2/master/LICENSE), [Syphon license in source](https://github.com/Syphon/Syphon-Framework/blob/main/SyphonMetalServer.m).

SpoutCam's root listing does not establish a complete redistribution license for its filter, DirectShow base classes and binaries. Interoperate with a user-installed copy first; do not infer its bundle's terms from Spout's license. Audit individual files before any redistribution or installer work. [SpoutCam source tree](https://github.com/leadedge/SpoutCam).

NDI SDK is royalty-free **subject to current agreement and exclusions**, not open source. Its agreement is in the SDK download; the owner must review/approve acquisition and terms. Public requirements include nearby NDI links, trademark attribution, app-local runtime distribution, third-party notices, and no redistribution of NDI Tools. Advanced SDK and codec rights need separate review; this research did not accept any agreement. [Current licensing requirements](https://docs.ndi.video/all/developing-with-ndi/sdk/licensing).

NDI® is a registered trademark of Vizrt NDI AB.

### Local NDI transport proof (T1335)

`pnpm desktop:ndi-test --sdk /absolute/path/to/approved/SDK` builds original probe
code into an owned temporary directory, links the selected external macOS runtime,
and removes its binary directory afterward. It neither installs nor copies the SDK.
The synthetic source is discoverable while the test runs; no project/camera data is
published. An independent receiver selects the sender's exact SDK-assigned full name.
The SDK explicitly allows a null address with name-based discovery; its sender
identity does not necessarily include an address. No guessed network URL is used.

The standard API proof uses 1920×1080 progressive BGRA, padded rows, two async sender
buffers and explicit final synchronization. Decoded barcode/timecode, inverted rows,
red/green channel samples and opaque alpha are checked on each frame. Interior RGB
samples tolerate 24/255 for the lossy codec; this is not a graph precision change or
a claim of pixel-identical transport. Seven corrupt controls exercise the oracle.
Capture buffers are freed after inspection; sender buffers live through SDK drainage.
Child watchdogs are bounded, and cancellation stops the owned receiver and drains
the sender. Error-path cleanup waits for both child `close` events, not just `error`.
The receiver now copies decoded rows into one owned BGRA IOSurface, binds it as a
shared Metal texture and verifies 66 GPU-blitted samples per frame. RGB bytes must
match the decoded source exactly; BGRX's unused alpha is explicitly made opaque.
The synchronous GPU wait and readback are test-only. This standalone proof is separate
from the app smoke below.

The opt-in Mac NDI In app slice uses the same native input owner as Syphon, with
separate IPC/session identities and capability detection. SDK initialization,
discovery and receive creation follow first-use local-network consent. Waiting SDK
calls run on native workers; open/close remain tracked across navigation and prompts.
Decoded frames copy into owned IOSurfaces before freeing SDK buffers; Chromium
leases remain held until all references release. The installed SDK's normal
source-change notification is handled explicitly, including initial connection.

The production Electron smoke passed three full-HD decoded barcode frames through
Chromium import and the real backend, then source-size adoption in loaded root and
twice-nested graphs. The project's Output sink intentionally retains project size;
source-view checks select the NDI node. No source resolution or graph precision was
reduced. App permissions coalesce and denied access is explicit; OS network grants
are not inferred. Source disappearance also passed: the last image remains while
receiver and GPU-lease records drain completely. SDK/runtime files stay external.

Mac NDI Out reuses the selected graph output and offscreen publication path. Native
workers copy BGRA IOSurface rows into two persistent buffers per publisher; async
SDK send synchronizes the previous buffer. Resize drains before reallocating, and
stop drains/destroys before acknowledging closure. Steady publication allocates no
new staging buffers. At 1080p that is 16,588,800 staging bytes per publisher, or
66,355,200 bytes for four, excluding SDK codec allocations and Chromium textures.
Output-only documents now participate in the authoritative unload gate too.

The compiled app's NDI Out→In loop passed decoded animated barcodes and live output
previews. Independent receivers each verified 120 unique full-HD frames for 1/2/4
concurrent publishers of one shared shader source. Latest short four-stream run:
~2.06–2.08 seconds including connection per receiver, zero repeats, 2–4 skipped
source-frame IDs. An earlier four-stream run had one ~2.09-second first-frame delay
and 114 skipped IDs; startup variability is retained, not hidden by a retries policy.
These are short correctness windows, not four independent heavy graphs, sustained
capacity, network bitrate, or end-to-end latency measurements. Cross-machine tests
remain outstanding. 1080p→720p→1080p resize preserves publisher identity; every stop
returns publisher/staging counts to zero. One-worker CPU-only native regression
proves immediate publish/stop cannot depend on spare worker-pool capacity.

Output-owner subscriptions are shared per owner, avoiding the duplicate listeners
exposed by concurrent consent/open. Rejected opens still reach their callers while
unload waits for settlement; failed native drains remain explicit and quarantined.
Repeated retirement checks destroyed windows before close, preserving the original
drain error. One broad Syphon regression observed a restored-window disconnection;
two subsequent complete runs passed, so the earlier cause is still unestablished.
The final run after owner-subscription fixes measured ~59.99–60.11 unique fps for
1/2/4 shared-source animated Syphon streams across visible/hidden/restored phases;
self-input, resize, reload and shutdown also passed. This is a local short-run
result, not a guaranteed capacity. Publication failures log their original cause.

Observed independent-process diagnostic run: 120 unique frames, zero repeats/skips,
first frame at ~1.02 s, total ~10.55 s including connection. A preceding run missed
the unchanged 15-second gate with only 103 sender frames. Machine snapshot reported
load average ~79 and 34 running processes; no 60 fps capacity or codec ceiling can
be inferred. The passing run spent ~3.02 s generating 140 synthetic frames and
~8.10 s in SDK send calls (wall time, including SDK pacing/waits and scheduling).
The GPU extension first verified 117 frames before its unchanged 15-second deadline.
The synthetic generator unnecessarily recomputed identical rows: row reuse now has
a byte-exact full-frame/padding reference test. Final GPU run passed 120 unique
frames, zero repeats/skips, ~6.55 s including connection; 66 GPU samples per frame
were exact. Generation for 161 frames took ~0.12 s; GPU oracle wall time was ~1.04 s
across received frames. These are uncontrolled diagnostic timings, not paired speedups.
The selected graph → SDK staging → decoded IOSurface → Chromium app path and
first-use consent/resize gates above now pass. Source restart now preserves the
SDK's reconnecting receiver and reports stale video; the actual compiled app
passes same-session nested-graph restart with a distinct barcode marker visible
after restart, no repeated consent, and complete retirement on document removal.
Remaining gates include broader alpha/color coverage,
quiet-machine paired scaling, broader resource qualification and cross-machine
interoperability. The opt-in continuous
receiver uses the same pixel/GPU oracle and preserves the initial 120-frame gate;
reported inter-arrival gaps include oracle work and are not end-to-end latency.

Ten-minute follow-up (2026-09-13): four staged full-HD publishers passed independent
CPU-pixel receiving for 600 seconds each at 58.18–58.39 unique fps, zero repeats or
pixel errors, and 1,029–1,163 skipped source IDs each. Inter-arrival p95 was
22.54–22.79 ms. Loom staging remained eight buffers / 66,355,200 bytes, no new
staging allocations, and drained afterward. Native successful-publication mean
enqueue-to-completion was 2.30 ms (CPU copy 1.54 ms); async SDK processing can
continue after completion, so this is not end-to-end latency. These shared-source
local results establish bounded Loom staging for this run, not overall leak freedom.

Continuous-run follow-up (2026-09-13): the 60-second full-GPU-oracle matrix passed
with ~28.3 / 37.9–38.3 / 26.1–26.3 unique fps for 1/2/4 shared-source publishers.
No repeats or staging growth; source-frame skips remained substantial. A separate
pixel-only receiver comparison, retaining the app's own GPU checks, measured ~57.9
fps for one and ~23.4–23.5 each for two, then failed four-stream startup with only
89–92 unique frames in 15 seconds. Thus oracle overhead contributes but does not
explain the whole variation. Host load was uncontrolled; these sequential runs
cannot establish a codec ceiling or an optimization speedup. Publisher stage
diagnostics were then added without changing buffering or scheduling. A staged
four-stream run measured ~23.5–23.7 unique fps and ~16.36ms mean native publication:
worker queue 5.41ms, readonly surface lock 0.15ms, CPU row copy 8.20ms, SDK submission
1.35ms, completion delivery 1.23ms. Output renderers received ~49fps but native
publication delivered ~24fps. These are elapsed stage times, not CPU utilization.

An explicit build-time direct-send candidate keeps the source IOSurface retained
and readonly-locked through synchronous SDK submission. It eliminates Loom's row
copy/staging buffers without changing BGRA8 pixels; no runtime fallback is present.
Both native single-worker contracts and the direct candidate's full 1/2/4 GPU pixel,
loopback, resize and retirement matrix pass. Subsequent local 60-second comparisons:

| Four publishers, one shared 1080p source | Unique fps per receiver | Loom staging | Native enqueue→completion mean |
| --- | --- | --- | --- |
| Direct synchronous candidate | 58.31–58.34 | 0 | 5.79ms, including synchronous SDK processing |
| Staged async baseline, repeated afterward | 60.01 | 66,355,200 bytes (63.3MiB) | 1.23ms, excluding still-running async SDK processing |

The direct run had 100–102 skipped source IDs per stream; the repeated staged run
had one each. Neither repeated frames or grew staging allocations. **Staged stays
default.** The direct path is a development-only memory tradeoff, not an established
speed optimization. Native durations have different completion semantics, so they
are not comparable codec latency. The staged row-copy mean itself fell from 8.20ms
to 1.13ms without a copy-algorithm change; the earlier apparent speedup was confounded
by changing host conditions. SDK internal allocations/copies are not counted as Loom
staging, and these runs do not establish cross-machine or sustained capacity limits.

macOS camera publication uses a Core Media I/O camera extension, available since macOS 12.3: a bundled system extension with signing, App Group/System Extension capabilities and user activation. This is separate from Electron's webcam permission prompt and requires a packaging/signing test track. No legacy camera plug-in workaround. [Apple camera-extension guide](https://developer.apple.com/documentation/CoreMediaIO/creating-a-camera-extension-with-core-media-i-o).

Network discovery/publication requires deliberate LAN scope and OS permissions; do not widen the existing loopback helper control socket. Show selected source and outgoing sender name/active state. No disabling firewalls, automatic camera filter registration or silent native SDK discovery from arbitrary system paths.

## Phased tasks and acceptance

Mac-side versus Windows-only Spout preparation is broken down in
[the T1334 implementation checklist](spout-windows-preparation.md). It records
current NT-handle/synchronization pitfalls and concrete reuse points. The
preparation-only registered nodes, app routing and E74 recipe are now implemented;
this is not a working Windows adapter or a passed Spout capability claim.

Tracked in SPEC: T1332 research and T1333's Mac Syphon graph integration are
implemented; the desktop README records the exact passed proofs and outstanding
endurance/GPU-failure boundaries. T1334–T1336 remain pending, not completed features.

| Task | Deliverable | Gate / dependency |
| --- | --- | --- |
| T1332 | Current SDK research and Electron-only scope/ownership contract | This document; source-backed distinctions, copy/lifetime risks and acquisition blockers |
| T1333 | Mac Syphon In/Out native probes, then separate graph nodes | T1331 input proof plus selected-node export proof; real independent sender/receiver; no CPU pixel traffic; explicit copy count |
| T1334 | Windows Spout In/Out parity and SpoutCam interoperability | Real Windows GPU/device testing, handle/sync proof, user-installed camera consumer; no bundled filter license assumption |
| T1335 | Mac/Windows NDI In/Out | Owner-approved SDK acquisition/license review; standard-SDK baseline, explicit staging/codec costs; two-machine interoperability |
| T1336 | Desktop virtual-camera and distribution completion | Windows camera permission round trip; macOS signed camera extension; SDK notices, OS consent, startup/crash teardown and platform capability parity |

For each transport, acceptance includes 1920×1080 at source cadence, 1/2/4 concurrent streams, 60-second warmed paired runs with idle controls, p50/p95 render and delivery time, capture-to-consumer latency, repeats/drops, CPU/GPU load, transfer bytes and 10-minute bounded resource counts. Also test dynamic resize, source restart, duplicate sender names, delete/recreate, document swap and consumer/renderer/GPU failure. Measure before declaring GPU- or codec-limited; no 640×360 workaround. Color tests include known SDR ramps, channel order, alpha edge and orientation; float transport claims additionally require signed and >1 samples, not just pictures that look correct.

Mocks prove scheduling and ownership, native probes prove interoperability, full graph/browser tests prove the actual user path. Each stage must name which of these passed. Stop a node rollout at an unproven transport boundary rather than adding a silent CPU or codec fallback.
