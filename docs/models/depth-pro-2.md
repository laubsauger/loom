# Depth Pro 2 on the live Depth node and in photo preparation (T1816b, T1817b)

Verified 2026-11-21 on one machine: Apple M3 Max, macOS, Chromium 151 (Playwright, new headless, real Metal adapter), ONNX Runtime Web 1.29.0.

## Artifacts

Loom uses an **unofficial** ONNX conversion. Apple publishes Depth Pro 2 as safetensors and Core ML, not ONNX. The conversion was made by the uploader of `christianengel/DepthPro2-S-ONNX` and `-B-ONNX` with the Apache-2.0 exporter [protortyp/depthpro2-onnx](https://github.com/protortyp/depthpro2-onnx). Its sources are `apple/DepthPro2-S@30e6471` and `apple/DepthPro2-B@281dc98`.

| Option | File | Revision | Bytes | SHA-256 |
| --- | --- | --- | ---: | --- |
| S streaming FP32 | `onnx/model_stream4.onnx` | `feb41e6075fd295590ea47619c039aef59cfb929` | 97,931,001 | `9228dff05c888754dd24c67487ecd90ce3b2f8587119b9fe6723d012351e4e45` |
| S streaming FP16 | `onnx/model_stream4_fp16.onnx` | `feb41e6075fd295590ea47619c039aef59cfb929` | 50,586,135 | `62c32407c4ad6061936363ee77b0d04041c7362b52f9766fbfeb1770784577ed` |
| S FP32 | `onnx/model.onnx` | `feb41e6075fd295590ea47619c039aef59cfb929` | 98,538,392 | `862865578e43f5b212f003400f61ce6a18ebef40e3fe1961b2c47e41cc0f5f2f` |
| B FP16 | `onnx/model_fp16.onnx` (B repo) | `ff8dceef904da6e026011760bc162bede72bbf61` | 199,273,471 | `47ed2c85dd4e79c66a24be1ee4e42cfb4ff41f7702a62d57175a8b663f0876fa` |

Each build also exists with a 16:9 box (672×384), from the converter's `onnx/384x672/` folder at the same revisions:

| Option, 672×384 | Bytes | SHA-256 |
| --- | ---: | --- |
| S streaming FP32 | 97,832,697 | `22d09a28b697ad669bebc6e628d9d7948ebc99c478e92943994c8a54ecc67da3` |
| S streaming FP16 | 50,487,831 | `7bc313c35ef669d8cf6b1b5468a1498ab80ef8687ea597e6fc7b3f57210c7281` |
| S FP32 | 98,341,784 | `2d47b8aebc593c0046ef25559014e81934e9f51b899d9814ddb9fc0c0136c855` |
| B FP16 | 199,076,863 | `37397d52796861e3a144d62baddbe0b38926048d118fc02fcdabaeb99186ab6a` |

Lengths and hashes were checked against downloaded bytes. The acquisition path refuses anything else.

The node's **Model Input** picks the box. A box is a separate file, because the graphs are static. A 16:9 picture fills 75 % of 640×480, so a quarter of the model's work goes on bars; it fills 98 % of 672×384, which is also 16 % fewer pixels. The default stays 640×480, so a node saved before the choice existed keeps the file it downloaded. The node's info popup shows the picture size, the model box and the share of it the picture fills, and the output size.

A 640×360 box exists only in Apple's Core ML packages (T1818b). In the browser it would need an ONNX export Loom does not have.

## Licence: research use only

Apple Machine Learning Research Model is licensed under the Apple Machine Learning Research Model License Agreement. The weights may be used "exclusively for Research Purposes", defined as "non-commercial scientific research and academic development activities". The definition excludes "any commercial exploitation, product development". A conversion is a Model Derivative under the same licence.

Loom does not bundle or redistribute these weights. They are fetched on the user's machine on first use, with consent. Every option label and the Model description say "research only". No default selects them. Client or commercial work needs rights that this licence does not grant.

## Contract, read from the files

`model-signatures.ts` records the extracted signatures. The graphs are static at 480×640. They take `pixel_values` as raw RGB in [0,1]; ImageNet normalisation is inside the graph. They also take `f_px`, the horizontal focal length in pixels of that 640×480 input. They return `depth_meters` as z-depth in metres, with +inf for the sky.

The streaming builds add 13 cache tensors (`past_*` in, `present_*` out): fp16 in the FP16 build, fp32 in the FP32 one, with the same names. Each call handles one frame and attends to the previous three. The first frame gets zeros.

How Loom feeds the model:

- **Letterbox.** The picture is fitted into the 4:3 box. `letterboxRectPreprocessWgsl` does this; the twin rule is `occOf(w, h, 4/3)`.
- **Colour.** The worker re-encodes the linear working space to sRGB. The reference reads display bytes.
- **Focal length.** `f_px` comes from the node's horizontal Field of View and the letterbox: `(640 · occX / 2) / tan(fov / 2)`.
- **Stream cache.** On WebGPU the cache stays on the device (`preferredOutputLocation: "gpu-buffer"`). It goes back in by name, and each spent cache is disposed.
- **Output.** The worker publishes inverse metres, with the sky at 0. Near, Far, Near Is Bright, Output Range and Publish (range or metres) are uniforms on the result pass, so a steady model is never re-normalised per frame.

## Measurements

These are agreement and timing measurements on this machine, not accuracy measurements. No ground truth was available.

| Build | WebGPU warm, 480×640 | ORT-web wasm in Node |
| --- | ---: | ---: |
| S FP32 | 84 ms | 733 ms |
| S FP16 | 75 ms | not measured |
| S streaming FP32 (cache on GPU) | 118 ms | not measured |
| S streaming FP16 (cache on GPU) | 102 ms (107–109 ms through the shipped worker) | 78 s (no native fp16 on CPU) |
| B FP16 | 184 ms | not measured |

In the 672×384 box (same day, WebGPU, warm): S streaming FP32 96 ms, S streaming FP16 83 ms, S FP32 69 ms, B FP16 152 ms.

- **WebGPU vs CPU.** S FP32 on WebGPU matched wasm to about 1e-6 relative on the same input.
- **FP16 vs FP32.** On real street frames, S FP16's median abs-rel against S FP32 was 2.5–7.9 % per frame. The converter's CUDA figure is 0.08 %, so FP16 on this WebGPU path is less faithful than on CUDA.
- **Steadiness.** On a real sequence panned 4 px a frame, frame-to-frame change (mean abs-rel) was 0.055–0.114 for streaming FP32, 0.059–0.230 for streaming FP16 and 0.19–0.75 for single-frame S FP32.
- **Streaming FP32 is the faithful stream.** With an empty cache, its first frame equals single-frame S FP32 exactly; the FP16 stream's first frame is already 5.3 % off. By the twelfth frame the two streams' median distances were 67 m (FP32) and 55 m (FP16).
- **Plausibility.** Through the shipped worker, a decoded street-crossing frame read nearest 8–10 m and furthest 278–770 m.

## Photo preparation (T1817b)

Photo preparation offers the two single-frame builds, S FP32 and B FP16, each in both boxes. A photo has no previous frame, so the streaming builds would only carry an empty cache.

- **Recipe.** Version 3: model, backend (WebGPU or CPU), box (`inputSide` 640 or 672, the box's long edge), field of view in degrees, and refinement. The field of view is part of the inference identity: a map prepared at 60° is out of date at 75°.
- **Field of view.** A JPEG's EXIF `FocalLengthIn35mmFilm` (tag 0xA405) suggests one, as the horizontal angle of a 35 mm equivalent lens by diagonal equivalence. A photo without that tag (HEIC, PNG, or a JPEG that omits it) gets 60° until the person sets it.
- **Input.** The photo is drawn into the box through a 2D canvas and letterboxed into the box's aspect. The canvas gives display-referred bytes. The worker's packer sRGB-encodes, because the live node feeds it linear light, so photo preparation decodes first and the model sees the photo's own bytes.
- **Output.** The worker returns `depth_meters` at the box's resolution. Preparation stores 1/metres sample for sample, with the sky, NaN and non-positive samples at 0, as a new depth semantics, `inverse-metric`. The prepared map's band, range and resampling use the box's own aspect. The bars stay in the file but out of the range.
- **Refinement.** The guided filter runs on the normalized view. That normalization is affine, so the refined map is mapped back through the native range and is inverse metres again.
- **Backends.** S runs on WebGPU or the CPU. B is refused on the CPU: it has no native half floats there, and S's FP16 stream took 78 s a frame.

Measured 2026-11-22 through the shipped preparer and worker on WebGPU (`depth-pro2.spec.ts`), on a 1280 × 720 street frame in the 672 × 384 box. The nearest surface read 20.4 m at 40° and 8.8 m at 80°. Every pixel's ratio between the two runs was 2.305407 (5th–95th percentile spread 4e-7), which is tan 40° / tan 20°. The model scales its metres by the focal length and by nothing else.

## Core ML in the desktop app (T1818b)

The live Depth node also offers Apple's own Core ML builds, `apple/DepthPro2-coreml@4e607a6`: S (52.95 MB) and B (197.36 MB), each a streaming model with a 4-frame window. These run only in the Loom desktop app, on Apple Silicon with macOS 15 or later. A browser lists them but marks them disabled, with the reason. A document already set to one opens in a browser with a notice that it runs only in the desktop app.

- **Acquisition.** Each package is three files, pinned with their lengths and SHA-256 in `src/devices/native/depth-model-manifest.json`. The desktop service downloads them only after the person presses Download in the node's notice, verifies each file, and compiles the package once. Compiling also opens all five functions, so a package that compiles but cannot run is refused at that point.
- **Input.** Each package has five input boxes, one function each: 640×360, 854×480 (Apple's default), 896×512, 1138×640 and 1280×720. The node's preprocess letterboxes the picture into the chosen box and sRGB-encodes it, because Core ML is fed display values with no worker in between. The bytes reach the service through the same capture as the native Person Mask.
- **Output.** Core ML returns `inverse_depth`, normalized by the focal length: metres = f_px / (W · inverse_depth). The service un-letterboxes it to the node's size by `occOf`'s rule and returns it as an rgbaf16 surface. The node's result pass multiplies it by W / f_px = 2 · tan(fov / 2) / occX to get inverse metres, then applies Near, Far and Publish as for the browser builds.
- **State.** One `MLState` per session, kept across frames. A new session, or a reset, starts a new stream.

Measured 2026-11-22 on the M3 Max, GPU (`.cpuAndGPU`), median ms per frame. The machine was shared, so expect ±15 %:

| Box | S, bare Core ML | S, through the service | B, bare Core ML | B, through the service |
| --- | ---: | ---: | ---: | ---: |
| 640×360 | 37 | 35 | 80 | 57 |
| 854×480 | 48 | 47 | 134 | 111 |
| 896×512 | 53 | 55 | 148 | not run |
| 1138×640 | 114 | 108 | 298 | not run |
| 1280×720 | 187 | 166 | 450 | not run |

`.all` (letting Core ML use the Neural Engine) was slower: 44 and 86 ms for S at the two smaller boxes. `.cpuAndNeuralEngine` refuses a package's named functions. Two sessions running at once put S at 854×480 at about 62–74 ms each. The bare WebGPU path's fastest live build, S streaming FP16 at 672×384, measured 83 ms.

Photo preparation on Core ML (§T1828b) and MLX streaming (§T1819b) are separate rows and are not implemented here.
