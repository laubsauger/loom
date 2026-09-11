# Native video I/O for Electron

Research checked 2026-09-10. T1332–T1336 proposal; no SDK installed, license accepted, driver registered, or working node claimed. This plan deliberately separates documented SDK behavior from proposed Loom behavior and unmeasured transport paths.

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
- `src/desktop/README.md`: maintained desktop host integrates Syphon In/Out on Apple Silicon through the existing graph/backend. Camera/microphone permissions remain denied; Spout/NDI and native Python inference are separate unfinished work. The synthetic texture probe is not an installed inference service.

Proposed integration: serializable node definitions → ordinary compiler resources → app adapter's demanded subscriptions → native device sessions → `MediaSource` image handoff → backend GPU copy. Keep direct `vgpu` access inside `src/runtime/backend`, Electron imports outside domain/compiler, and configuration changes inside domain commands. Reuse the T1331 backend proof before adding a second ingestion mechanism.

**Output is a separate feasibility gate.** Electron offscreen shared-texture paint exposes a Chromium-rendered surface, not arbitrary graph GPU textures. It could support a dedicated graph-output surface, but would add rendering/window lifecycle and potentially color/alpha conversion. Do not capture the editor UI and call it node output. [Electron paint/shared-texture contract](https://www.electronjs.org/docs/latest/api/web-contents).

T1337 now proves the narrow dedicated-surface route: actual backend `present`/`setOutput` selects A/B/A at 1920×1080 in an isolated output-only renderer; a native IOSurface oracle verifies BGRA8 pixels, orientation and sRGB midpoint through Electron's shared handle. No editor capture or bitmap transport. This is not yet an existing-app cross-window attachment, independent native GPU consumer, Syphon publication, measured copy count or sustained throughput result. Native CPU inspection is test-only. [Probe and command](../experiments/native-texture-bridge/README.md#selected-output-export-t1337).

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

Spout is BSD-2-Clause: preserve notices/conditions in source and binary distributions. Syphon's source uses equivalent simplified BSD conditions. Review the exact acquired trees and bundled notices before packaging. [Spout license](https://raw.githubusercontent.com/leadedge/Spout2/master/LICENSE), [Syphon license in source](https://github.com/Syphon/Syphon-Framework/blob/main/SyphonMetalServer.m).

SpoutCam's root listing does not establish a complete redistribution license for its filter, DirectShow base classes and binaries. Interoperate with a user-installed copy first; do not infer its bundle's terms from Spout's license. Audit individual files before any redistribution or installer work. [SpoutCam source tree](https://github.com/leadedge/SpoutCam).

NDI SDK is royalty-free **subject to current agreement and exclusions**, not open source. Its agreement is in the SDK download; the owner must review/approve acquisition and terms. Public requirements include nearby NDI links, trademark attribution, app-local runtime distribution, third-party notices, and no redistribution of NDI Tools. Advanced SDK and codec rights need separate review; this research did not accept any agreement. [Current licensing requirements](https://docs.ndi.video/all/developing-with-ndi/sdk/licensing).

NDI® is a registered trademark of Vizrt NDI AB.

macOS camera publication uses a Core Media I/O camera extension, available since macOS 12.3: a bundled system extension with signing, App Group/System Extension capabilities and user activation. This is separate from Electron's webcam permission prompt and requires a packaging/signing test track. No legacy camera plug-in workaround. [Apple camera-extension guide](https://developer.apple.com/documentation/CoreMediaIO/creating-a-camera-extension-with-core-media-i-o).

Network discovery/publication requires deliberate LAN scope and OS permissions; do not widen the existing loopback helper control socket. Show selected source and outgoing sender name/active state. No disabling firewalls, automatic camera filter registration or silent native SDK discovery from arbitrary system paths.

## Phased tasks and acceptance

Tracked in SPEC: T1332 research is complete; T1333–T1336 are pending implementation, not completed features.

| Task | Deliverable | Gate / dependency |
| --- | --- | --- |
| T1332 | Current SDK research and Electron-only scope/ownership contract | This document; source-backed distinctions, copy/lifetime risks and acquisition blockers |
| T1333 | Mac Syphon In/Out native probes, then separate graph nodes | T1331 input proof plus selected-node export proof; real independent sender/receiver; no CPU pixel traffic; explicit copy count |
| T1334 | Windows Spout In/Out parity and SpoutCam interoperability | Real Windows GPU/device testing, handle/sync proof, user-installed camera consumer; no bundled filter license assumption |
| T1335 | Mac/Windows NDI In/Out | Owner-approved SDK acquisition/license review; standard-SDK baseline, explicit staging/codec costs; two-machine interoperability |
| T1336 | Desktop virtual-camera and distribution completion | Windows camera permission round trip; macOS signed camera extension; SDK notices, OS consent, startup/crash teardown and platform capability parity |

For each transport, acceptance includes 1920×1080 at source cadence, 1/2/4 concurrent streams, 60-second warmed paired runs with idle controls, p50/p95 render and delivery time, capture-to-consumer latency, repeats/drops, CPU/GPU load, transfer bytes and 10-minute bounded resource counts. Also test dynamic resize, source restart, duplicate sender names, delete/recreate, document swap and consumer/renderer/GPU failure. Measure before declaring GPU- or codec-limited; no 640×360 workaround. Color tests include known SDR ramps, channel order, alpha edge and orientation; float transport claims additionally require signed and >1 samples, not just pictures that look correct.

Mocks prove scheduling and ownership, native probes prove interoperability, full graph/browser tests prove the actual user path. Each stage must name which of these passed. Stop a node rollout at an unproven transport boundary rather than adding a silent CPU or codec fallback.
