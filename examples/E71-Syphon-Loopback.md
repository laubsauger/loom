# E71 — Syphon Loopback

A macOS desktop recipe: publish an animated 1920 × 1080 texture through Syphon,
then receive the same publisher into a separate branch. Local and returned outputs
remain separate so a running generator cannot masquerade as a working connection.

## Setup and use

1. Start the Apple Silicon desktop app with `pnpm desktop:dev`. See the
   [desktop setup](../src/desktop/README.md) for toolchain and first-build requirements.
2. Open this example. `signal1` feeds `send1`, named **Loom E71 Syphon**.
   Accept the native-video consent request when prompted.
3. Select `receive1`, refresh its source list and choose that live publisher.
   The saved source is empty: discovery UUIDs belong to your running publisher,
   not to an example file.
4. Compare viewer outputs **reference1** (local) and **returned1** (received).
   Both should animate. The `send1` preview alone proves only its local input.

`signal1 → send1`, `signal1 → reference1`, `receive1 → returned1`.
Copy either branch into your project; give additional publishers distinct names.
Choose another app's publisher to use this as an external-input recipe.

## Expectations and limits

The project uses the ordinary-color RGBA SDR 8-bit working format at full HD.
Syphon publishes full-input-resolution SDR video, not an HDR/data-texture round
trip. The returned branch adopts source size. GPU sharing avoids video codecs,
but presentation and synchronization still cost time. This is a functional
loopback, not a latency or bit-identical color test.

Stop publishing to see a stale/disconnected diagnostic. After restarting Syphon,
refresh and select the publisher's new discovery identity. Before selection,
an empty received branch is expected.

Hosted-browser and headless use can render the local reference, not native video.
Offline renders suppress publication. Thumbnails show the reference only, never
proof of a live connection. Spout is a separate Windows transport, not implied here.
