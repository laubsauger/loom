# Kernels inside the frame (§T1707b)

Status: approved by the owner and built, 2026-10-14; committed `3cc42f53`. See "As built" at the end.

## The question

Should Loom encode its kernels (`dispatch` passes) into the frame's own command
encoder through vgpu 0.6.0's `Frame.computePass`, instead of calling
`Compute.dispatch`, which builds and submits its own command buffer?

Recommendation: yes. One frame, plan order, on both render paths, with a small
patch that puts a GPU timer on `computePass` and drops three larger patch themes.

## Loom today

There is one place that runs a kernel, `encodeDispatch`
(`src/runtime/backend/vgpu/vgpu-backend.ts`). It calls `Compute.dispatch`,
which submits at once. Render passes submit when the frame closes. So inside
one frame every kernel runs before every render pass (B19, §V168). The two
render paths deal with that differently:

- **Live loop** (an open frame, `encode` from `runFrame`): no workaround. A
  kernel that reads a texture rendered earlier in the plan sees the previous
  frame's texture. The comment there calls this one frame of latency and cites
  §V144, but §V144 is about Analyze's CPU readback, which stays one frame late
  by contract whatever happens here. The kernel lag is a separate fact.
- **Direct render** (`render()` with no open frame: export, offline render, and
  every Dawn test that calls `render()`): `encodeSegmented` splits the plan into several
  vgpu frames, one per run of render passes before a kernel. Plan order holds.
  It costs an extra frame object and submit for every split.

So the same project renders a different picture live and on export whenever a
kernel reads a texture rendered earlier in the frame. That breaks the spirit of
§V47 (one project, one picture on both paths). In the 80 shipped examples, 25
have such a read: E14, E20, E27, E30, E32, E34, E38, E41, E42, E44, E45, E47,
E48, E51, E52, E53, E54, E63, E64, E73, E80, E86, E87, E88. Most are the
TOP→POP bridge (`textureToAttribute`), depth sampling, model input packing and
meters.

Three patch themes exist only because a kernel is outside the frame:
`Frame.attachExternalSpan` (T1247), its retraction (T1295), and
`Compute.dispatch(…, { timer, frame })` (T1247).

## TouchDesigner and Notch

| | Same-frame read of an image by a GPU point operator | How the order is decided |
| --- | --- | --- |
| TouchDesigner | Yes. Cooking is pull-based: "When a node receives a cook request, it requests that all of its inputs cook" ([Cook](https://docs.derivative.ca/Cook)). A POP reading a TOP pulls that TOP first, in the same frame. | Dependency order, per frame ([Terminology](https://docs.derivative.ca/Terminology): the screen draw re-cooks all dependencies). |
| Notch | The manuals describe the Image Affector as driven by a connected video node ([Image Affector](https://manual.notch.one/2026.2/en/docs/reference/nodes/particles/affectors/image-affector/)). They state no latency between the two. | Particle emission runs "per frame in node order" ([Emitters](https://manual.notch.one/0.9.23/en/docs/nodes/particles/emitters/)). |
| Loom today | Live: no, one frame late. Export: yes. | Plan order, but broken live by the separate submit. |
| Loom proposed | Yes, on both paths. | Plan order, one command buffer per frame. |

Neither tool documents a frame of lag between an image and the points that read
it. TouchDesigner's documented model gives none. Loom's live lag is an accident
of the submit, not a design.

## Measured

Dawn on this Mac (`vgpu/node`, Metal), patched vgpu 0.6.0. One trivial kernel
(64 threads over a 16 KB buffer) dispatched K times, then one effect pass.
300 frames after 30 warm-up frames, each frame awaited. CPU is the time spent
encoding and submitting; wall is frame to frame. Second of two rounds:

| K kernels | Today: one submit each | `computePass` per kernel | One `computePass` for all | No kernels |
| --- | --- | --- | --- | --- |
| 5 | 126 µs CPU, 0.52 ms wall | 64 µs, 0.41 ms | 52 µs, 0.40 ms | 25 µs, 0.36 ms |
| 20 | 372 µs, 0.88 ms | 136 µs, 0.49 ms | 92 µs, 0.44 ms | 28 µs, 0.38 ms |
| 80 | 1,455 µs, 2.01 ms | 434 µs, 0.88 ms | 255 µs, 0.84 ms | 25 µs, 0.36 ms |

A kernel costs about 18 µs of CPU today, about 5.5 µs in a pass of its own and
about 3 µs sharing one pass. Dawn in Node has no GPU process, so this is the
smaller half of the browser's cost. In the browser each submit is also a flush
to the GPU process: `docs/sentinel-perf-analysis-2026-10-06.md` (item N3)
measured sentinel-bot at 80 submits a frame, 78 of them single dispatches,
3.6 to 6.3 ms of GPU-process time decoding them and about 1.2 ms of page time
in `submit`. How much of that decode is per flush was never separated.

Example sizes, from the compiled plans: 43 of the 80 examples run kernels; the
median is 5 dispatch passes, the largest are E78 (37), E77 (29) and E79 (22),
before substeps multiply them.

## Proposal

1. **Encode every kernel with `f.computePass`, one compute pass per dispatch
   pass.** A pass of its own keeps one GPU timer span per kernel, as each render
   pass has, so the per-node GPU column is unchanged. Indirect counts go through
   the same `DispatchOptions`. Sharing one pass between consecutive kernels saves
   another 2.5 µs a kernel; it is a later step, only if measured worth it (it
   would merge their timer spans).
2. **Delete `encodeSegmented`.** The direct path encodes the whole plan into one
   frame, as the live loop does. Both paths then run plan order in one command
   buffer.
3. **Patch: a `timer` on `FrameComputePassOptions`.** The same `timestampWrites`
   a `FramePass` takes, on `beginComputePass`. This replaces the
   `attachExternalSpan`, retraction and `dispatch` timing hunks, which are
   larger. Fork PR #6 already holds the reproduction of this gap upstream.
4. **Keep `Compute.dispatch` out of Loom.** Nothing else calls it.

What it changes:

- **Live pictures** of the 25 examples above: the kernel reads this frame's
  texture, as export already does. Moving content shifts by one frame; still
  content does not change after its first frame.
- **Export and Dawn tests:** order unchanged. They already ran plan order. The
  frame count per render drops to one.
- **§V168** holds on both paths, and B19's remaining loop-path caveat closes.
  §V144 is untouched (Analyze's readback stays one frame late, by contract).
- **The comment in `encode`** that cites §V144 for the kernel lag goes.

## Risks to check while building

- **GPU start time.** Today a kernel reaches the GPU while the CPU still encodes
  the rest of the frame. In the frame it waits for the submit at the end. The
  Dawn probe shows a net wall-time gain; the browser A/B (below) decides.
- **Queue writes between kernels.** A `queue.writeBuffer` made between two
  kernels of one frame runs before both once they share the frame's command
  buffer. Stepped kernels already use one uniform block per run
  (`prepareStepSlots`), which is safe. Every other write made while encoding
  must be audited.
- **Partial submit on a throw (T1261).** A kernel encoded before a throw now
  goes out with the partial frame instead of having self-submitted. Same result
  on both paths; `frame-throw.gpu.test.ts` must say so.
- **Model input gates** (`dispatchGates`). They decide at encode time and stamp
  `framesSubmitted + 1`, which is still the frame the kernel runs in.
- **vgpu's aliasing preflight** runs at `encode` either way, so the disjoint
  writable ranges hunk (T1076) still applies.

## Verification

- A Dawn test through the real stack on the LOOP path: a kernel reads a texture
  an effect rendered earlier in the same frame and sees this frame's value (red
  today). Plus the same read on the direct path, so both paths agree (§V47).
- The existing kernel, point and frame-throw GPU tests, unchanged in meaning.
- Browser A/B on the real GPU, current build against the change, alternating
  with a reference pass (as `gpu-timing-reference-pass` requires): sentinel-bot
  and E78, page `submit` time, GPU-process time and frame time.

## Not in this change

- The `nativeObject` error-scope hunk (same §T1707b row) is independent of
  where a kernel is encoded. It stays until upstream reports every cause of a
  failed pipeline under the consumer's label.
- Sharing one compute pass between consecutive kernels (step 1 above): SPEC §T1711b.

## As built (2026-10-14)

- `encodeDispatch` opens one `f.computePass({ label, timer })` per dispatch pass;
  `encodeSegmented` is replaced by `encodeDirect`, one frame per render.
- Patch: `FrameComputePassOptions.timer` added; `attachExternalSpan`, `retractSpan`,
  `Compute.dispatch` timing and `DispatchTiming` removed (17 files, against 18).
- Demanded dispatches (model inputs) read this frame's stamp for a texture rendered before
  them in the plan, on both paths (`stampRenderedTextures` before the gate).
- Queue writes during encode: none found. Stepped kernels bind one uniform block per run;
  everything else that changes between passes is a binding, recorded when it is encoded.
- Red first: `kernel-frame-order.gpu.test.ts`, loop path, sampled zeros before the change.
- Tests changed by cause: `matte-cache-alignment` and `dispatch-demand` (the loop path now
  captures the current source, as the direct path did), `compute-span` and `timing-drops`
  (one frame per render), `execution-schedule` (no segments to cache), `frame-throw`
  (comment), `timer-retract` replaced by `frame-timer-rollback` (a compute pass's timer).
- Browser measurement, below. No in-app A/B: the old encoding is deleted, so the only
  in-app reference is `main` on vgpu 0.5.0, which would mix the upgrade into the figure.

## Measured in the browser (2026-10-14)

Headless Chromium on this Mac's GPU (the `chromium-gpu` launch), cross-origin isolated
for a 5 µs clock, patched vgpu 0.6.0. The same fixture as the Dawn probe: K kernels then
one effect, 30 warm-up and 120 measured frames per trial, each frame awaited, seven
alternating trials, median of the trial means. "Wall" is encode to `frame.done`, so it
includes the GPU process. Source and raw trials:
[`docs/performance/2026-10-14-kernels-in-frame/`](performance/2026-10-14-kernels-in-frame/)
(`build.mjs.txt` bundles `bench.js.txt`, `run.mjs.txt` serves and runs it).

| K kernels | Self-submitted (0.5.0 shape): CPU, wall | In the frame: CPU, wall | No kernels: CPU, wall |
| --- | --- | --- | --- |
| 5 | 71 µs, 0.55 ms | 37 µs, 0.47 ms | 11 µs, 0.39 ms |
| 20 | 231 µs, 1.02 ms | 89 µs, 0.58 ms | 10 µs, 0.39 ms |
| 80 | 972 µs, 3.68 ms | 313 µs, 1.31 ms | 10 µs, 0.41 ms |

A kernel costs about 12 µs of page CPU self-submitted and about 3.8 µs in the frame; the
awaited frame loses about 30 µs per kernel to the separate submits. At sentinel-bot's 78
single-dispatch submits that is about 0.7 ms of page CPU and about 2.3 ms of frame time.
The CPU trials are in `result.json` and do not overlap between the two shapes at any K;
only the medians of the wall figures were kept.
