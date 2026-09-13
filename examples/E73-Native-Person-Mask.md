# E73 — Native Person Mask

An Apple Silicon desktop recipe for native person segmentation: select a camera,
send its picture to the Python-owned Apple Vision worker through GPU surfaces,
and multiply the returned mask into the original image.

## Setup and use

1. Follow the [desktop setup](../src/desktop/README.md). Native Vision requires
   macOS on Apple Silicon, the native build toolchain and Python 3.11 or newer.
   To choose Python explicitly:

   ```sh
   LOOM_NATIVE_PYTHON=/absolute/path/to/python3 pnpm desktop:dev
   ```

   No model download or automatic Python-package installation is needed.
2. Open the example. **source1** starts at index **0**, an animated calibration
   texture containing no person. An empty mask is expected and **does not prove
   person detection works**. **reference1** displays the selected source.
3. Change **source1** Index to **1** for **camera1**, and approve camera access
   when prompted. Review permissions in Settings. A visible webcam preview can
   also demand access; opening the file is not consent.
4. **mask1** explicitly saves Transport as **Native GPU (Electron)**. Select
   **person1** in the viewer and stand in view. Inspect `mask1` for the
   white-where-person mask; `key1` applies that mask to the original image.

`calibration1 / camera1 → source1 → mask1 → key1 → person1`, with
`source1 → key1` and `source1 → reference1` as the original-image branches.
Replace the selected source with a Movie File In node for your own footage.
No personal media, camera identifier or downloaded fixture ships.

## Expectations and limits

The project stays 1280 × 720 with ordinary-color RGBA SDR 8-bit storage; `mask1`
explicitly keeps RGBA16F because its values are measurements. Person Mask retains
its existing fixed 512-square model preprocessing policy. Min interval is 0.1
timeline seconds; 0 requests work as quickly as results return, not a promised
frame rate. Apple's model results can differ by OS and hardware.

Native transport avoids CPU image readback and video codecs between Loom and the
worker. Preprocessing, model execution, GPU synchronization and sampling still
cost time. It never silently switches to the device-helper byte transport.

The file loads in hosted-browser/headless use, but those do not run this native
provider. An unavailable-provider diagnostic and neutral mask are not successful
segmentation. Thumbnails show the calibration reference only. Live camera and
native inference results require a real desktop session to verify.
