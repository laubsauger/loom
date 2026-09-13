# E72 — NDI Loopback

A desktop network-video recipe: publish an animated 1920 × 1080 texture through
NDI and receive it back. Separate local and returned outputs make this a useful
copy-paste base for senders, receivers and checking an actual round trip.

## Setup and use

1. On the current Apple Silicon development path, supply an independently
   obtained, approved NDI SDK installation outside this repository:

   ```sh
   LOOM_NDI_SDK='/absolute/path/to/NDI SDK for Apple' pnpm desktop:dev
   ```

   See the [desktop setup](../src/desktop/README.md) for requirements. This example
   includes no SDK, installer or permission to redistribute either.
2. Open the example and approve local-network access when requested. macOS may
   require its own local-network permission. Settings shows Loom permissions.
3. `send1` publishes **Loom E72 NDI**. Select `receive1`, refresh discovery and
   choose that exact live source; the displayed name includes the sender machine.
   No machine-specific source name is saved in the shipped file.
4. Compare viewer outputs **reference1** and **returned1**. Both should animate;
   only the latter proves reception. `send1` previews its local input.

`signal1 → send1`, `signal1 → reference1`, `receive1 → returned1`.
Choose an external sender to reuse the input branch. Give copied output nodes
distinct publisher names. Another NDI app can receive the publication, subject to
discovery, firewall and network configuration.

## Expectations and limits

The project uses RGBA SDR 8-bit working storage at full HD. NDI publishes SDR at
full source size and uses CPU processing, staging and lossy encoding on the
default development path. It is **not** zero-copy GPU tensor transport or an
image-exact/end-to-end latency benchmark.

Turn `send1` Publish off: the received image becomes stale with a diagnostic.
Turn it back on with the same identity: NDI can reconnect the existing receiver.
Rename the publisher and you must explicitly select the new source.

Hosted-browser/headless use renders the local reference, not an NDI connection.
Offline renders suppress publication. Thumbnails show the reference only. This
recipe documents the implemented Mac path; it does not certify Windows or
cross-machine interoperability before those platforms are tested.
