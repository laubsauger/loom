# Depth Pro 2 on the live Depth node (T1816b)

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

Native Core ML (T1818b) and MLX streaming (T1819b) are separate rows and are not implemented here.
