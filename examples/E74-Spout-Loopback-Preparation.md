# E74 — Spout Loopback Preparation

A graph-preparation recipe for future Windows Spout input/output. **The native
Spout transport is not implemented on any shipping host.** This example teaches
the registered node contracts and portable wiring; it cannot send or receive
Spout video today, including on Windows.

## What can be tested on a Mac now

Open the example and inspect the two independent branches:

`signal1 → send1`, `signal1 → reference1`, `receive1 → returned1`.

What `signal1` sends is a **reference chart**, not a texture chosen for looks: a
black-and-white checkerboard tinted by a four-stop colour sweep, with a marker
crossing the frame. Each part answers a question the round trip poses — the checker
shows resampling as moiré on its edges, the sweep shows orientation and channel
order, and the marker shows liveness and, if the return lags, how far behind it is.
Comparing two panes of noise, which is what this used to send, answers none of them.

**reference1** shows the local animated 1920 × 1080 texture using ordinary-color
RGBA SDR 8-bit storage. Copy either branch into a graph to prepare its layout and
parameters. **send1** starts with Publish off. **receive1** has no selected source;
the example contains no fabricated machine-specific sender identity.

The library marks this file **Desktop only**, **Windows**, **Not implemented**.
Enabling Publish does not install a native adapter or make sharing work. An
unsupported-transport diagnostic is expected, not a reason to try another format
or lower resolution. **returned1** cannot show received video yet.

## Future Windows verification

Once a real Windows adapter is implemented and qualified, the intended workflow
is to publish **Loom E74 Spout**, select its exact discovered sender in `receive1`,
then compare **reference1** against **returned1**. Actual pixels, synchronization,
adapter compatibility and teardown still require a Windows GPU test machine.
This document is a preparation checklist, not proof those steps currently work.

SpoutCam is a separate virtual-camera integration; no filter, driver, SDK or
installer is included or installed by this example. No Windows capability is
inferred from Syphon working on macOS.

## Browser, offline and thumbnail limits

The hosted browser and headless renderer can render the **local reference only**.
The generated thumbnail is that synthetic reference, not a screenshot of Spout
sharing. Passing graph load/compile/render tests does not establish a native
round trip or end-to-end zero-copy transport.
