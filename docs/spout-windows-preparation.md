# Spout: preparation on Mac, proof on Windows

T1334 implementation checklist, checked 2026-09-13. **Graph preparation is
implemented; the Windows native adapter is not.** Registered Spout In/Out use the
ordinary compiler, native input/output hooks, source inspector, demand and
offline-render policies. Dedicated optional Spout bridge slots never substitute
Syphon/NDI; current desktop preloads expose neither slot. The source inspector and
runtime report the unimplemented adapter explicitly. E74 is a disabled-publication
preparation example marked Desktop only / Windows / Not implemented.

Mac tests exercise graph and ownership contracts with injected adapters; they cannot
certify DirectX sharing, SpoutCam, or a Windows build. No SDK is vendored or installed.

## Work split

| Slice | Meaningful on Mac | Windows acceptance still required |
| --- | --- | --- |
| Separate Spout In / Out definitions | Serialization, compiler, demand, previews, source-selection tests | Actual source discovery and publication |
| App integration | Injected frame transport, root/nested components, loaded projects, deletion and export quiescence | Real Out→In loopback, resize and restart |
| Desktop lifetime plumbing | Mock import/send/release ordering, bounded leases, navigation and failure tests | D3D resource lifetime and GPU completion |
| Technical example | Author/generate after real node registration; reference preview remains usable without input | Independent sender/receiver walkthrough |
| Native adapter and packaging | Review source and specify ABI/build inputs | Compile/load against pinned Electron, real GPU tests |
| SpoutCam | Document separate, user-installed consumer | Actual camera selection and OS consent |

Graph-side preparation is a coherent slice, not disconnected registry
entries. Until the native proof passes, label Spout unavailable on Mac/browser and
unimplemented on Windows; OS detection alone must never advertise support. Existing
T1334 rollout gate remains: do not present unproven transport nodes as ready.

## Current API evidence and traps

- Electron's current experimental `sharedTexture` accepts process-local Windows
  `ntHandle` buffers. Its RGBA/BGRA/RGBA16F output handles have **no keyed mutex**;
  NV12 differs. A Spout shared handle cannot simply be relabelled `ntHandle`.
  [Handle contract](https://www.electronjs.org/docs/latest/api/structures/shared-texture-handle).
- Keep imported storage valid until `allReferencesReleased`, not merely until
  `sendSharedTexture` resolves. Retain the existing bounded lease model and explicit
  quarantine for uncertain import failures.
  [Import lifecycle](https://www.electronjs.org/docs/latest/api/shared-texture).
- Spout's current DirectX11 sender copies into its shared texture and flushes under
  its access guard. `SendTexture` can return true without copying when access is
  unavailable: that boolean alone is not a delivered-frame counter. Exact receiver
  naming avoids the SDK's active-sender selection; sender naming can auto-increment
  collisions. Loom must expose the actual identity or reject collisions, never
  report a different name as published.
  [Maintainer implementation](https://github.com/leadedge/Spout2/blob/master/SPOUTSDK/SpoutDirectX/SpoutDX/SpoutDX.cpp).

Recheck the pinned Electron headers and pin a reviewed Spout revision when building.
Public source review is not a redistribution/signing decision. Do not update the
working Mac runtime merely to prepare Windows code.

## First native proof: before app rollout

1. Use an explicit external SDK path and a Windows-only native build target. Keep
   the Mac build unchanged. Record Electron/SDK/compiler/GPU/driver versions and
   graphics adapter identity in the probe report.
2. **Out:** obtain the selected output renderer's BGRA8 NT handle, open it on the
   matching D3D adapter, publish with Spout. Establish when GPU reading has finished
   before releasing Electron's paint texture. A queued copy or `Flush` alone is
   not a completion proof. Count successful publication separately from attempts.
3. **In:** select an exact publisher, acquire through Spout's synchronization, and
   copy into a bounded, owned NT-shareable texture if required for immutable frame
   lifetime. Prove producer completion before Chromium import and defer texture
   reuse/handle closure until Chromium's final release callback. Do not hold the
   publisher's access lock for an arbitrary renderer lifetime.
4. Verify independent animated frame IDs, SDR ramps, channel order, alpha and
   orientation at 1920×1080. Then app Out→In, resize, source exit/restart, reload,
   deletion, renderer failure and pending shutdown. Reject unsupported adapter or
   format combinations explicitly; no CPU readback/codec fallback.
5. Run 1/2/4 streams and resource endurance using the native-video plan's matrix.
   Account for every GPU copy; target no CPU pixel round trip, not an unproven
   end-to-end zero-copy claim. SpoutCam is a later, separately installed consumer.

## Existing code to extend, not duplicate

- `src/nodes/definitions/syphon-in.ts`, `syphon-out.ts`, `index.ts`: shape precedent;
  proposed Spout In uses exact source name, Out uses publisher name and enabled.
- `src/devices/native-input.ts`, `native-output.ts`, `src/app/use-native-inputs.ts`,
  `use-native-outputs.ts`: transport selection and app ownership. Audit their
  consumers for binary Syphon/NDI assumptions when adding a third transport.
- `src/domain/render/side-effects.ts`, `emission-pumps.ts`, `reproducibility.ts`:
  demand and offline-render behavior, including nodes inside components.
- `src/desktop/native-input.cjs`, `native-output.cjs`: currently hardcode IOSurface
  import/publication. Introduce an explicit platform-native boundary with the
  actual Windows adapter; do not route Spout through the current Syphon branch.
- `src/desktop/preload.cjs`, `main.cjs`, `run.mjs`: bridge exposure, capability
  reporting, and platform build selection. Actual native build currently targets
  Apple Silicon. Keep local Spout separate from NDI network permission.
- `src/examples/runtime-requirements.ts`, `capabilities.ts`: Desktop only + Windows
  badges and video/device tags when node types exist. Do not classify NDI as
  Windows-ready until its Windows adapter is also proven.
- `src/examples/documents/native-video.ts`: reuse the reference/output/return
  teaching layout for a generated Spout loopback example. Do not invent a source
  identity or claim a reference thumbnail proves live reception.

Mac verification for an implementation slice: scoped node/app/desktop tests,
`pnpm test:gates`, `pnpm typecheck`, lint and build; focused browser tests for changed
interaction. Injected tests must identify themselves as contract tests. Windows
build and real sender/receiver results remain separate acceptance records.
