import { ImageSegmenter } from "@mediapipe/tasks-vision";
/*
 * T1088 — the wasm, from OUR OWN ORIGIN, and this is not a preference.
 *
 * Every MediaPipe example resolves its fileset from a CDN. This app serves
 * `Cross-Origin-Embedder-Policy: require-corp` (vite.config.ts, and T1048's service
 * worker on the hosted build), under which a cross-origin subresource must arrive with
 * CORS or CORP or it is blocked outright. So a CDN fileset is not a slower option here,
 * it is a broken one. `?url` makes vite emit these two files as ordinary hashed assets of
 * this build, which is same-origin by construction and needs no header from anybody.
 *
 * The SIMD build is named explicitly rather than feature-detected via
 * `FilesetResolver.forVisionTasks`, which would need a DIRECTORY and vite emits files.
 * The cost is the no-SIMD fallback, and it is not a real cost: this module is only ever
 * reached from a page that already has WebGPU, and no engine ships WebGPU without wasm
 * SIMD. If that stops being true the failure is loud — the loader throws and the seam
 * reports it per node — rather than a silently slower matte.
 */
import wasmLoaderPath from "@mediapipe/tasks-vision/vision_wasm_internal.js?url";
import wasmBinaryPath from "@mediapipe/tasks-vision/vision_wasm_internal.wasm?url";

import type { MatteSegmenter } from "./mediapipe-matte.ts";

/**
 * The delegates, in the order they are tried (muse-eeg-web's `['gpu','cpu']` ladder).
 *
 * Measured on this machine at 512²: GPU 3.71 ms against CPU 6.18 ms for the inference,
 * 6.05 ms against 6.87 ms delivered. So the ladder is worth having but the floor is not a
 * cliff — a machine that falls to CPU loses about 14% of the delivered figure, not an
 * order of magnitude, and still beats every ONNX matte on this page.
 */
const DELEGATES = ["GPU", "CPU"] as const;

/**
 * Opens a real MediaPipe segmenter over already-downloaded model bytes.
 *
 * The bytes arrive from `createModelAcquisition` rather than from `modelAssetPath`, which
 * would have MediaPipe do its own fetch: routing the download through the app's one
 * acquisition path is what gives this artefact the same consent prompt, progress, hash
 * check, failure surface and cache every other model has (T1088's ruling).
 */
export async function openTasksVisionSegmenter(modelBytes: Uint8Array): Promise<MatteSegmenter> {
  const fileset = { wasmLoaderPath, wasmBinaryPath };
  const refusals: string[] = [];

  for (const delegate of DELEGATES) {
    let segmenter: ImageSegmenter;
    try {
      segmenter = await ImageSegmenter.createFromOptions(fileset, {
        baseOptions: { modelAssetBuffer: modelBytes, delegate },
        /*
         * IMAGE, not VIDEO, and the reason is §V44's spirit rather than a quality finding.
         * VIDEO mode requires a monotonically increasing timestamp per frame, and this
         * seam has no clock to give it — inference runs at its own cadence, off the frame
         * loop, and fabricating a counter to satisfy an API would be inventing a
         * timebase. The model carries no recurrent state (unlike MATTE_RVM, whose whole
         * character is temporal), so the two modes agree: measured 2026-09-03 on one
         * frame, one delegate, the IMAGE and VIDEO masks were BIT-IDENTICAL — max |Δ|
         * exactly 0 across all 262144 values, not merely small.
         */
        runningMode: "IMAGE",
        /*
         * The SOFT mask, not the category mask. The category mask is a per-pixel class
         * index — 0 or 1 — and this node publishes an alpha matte, so taking the hard
         * label would throw away the only gradient the model produces. It is a thin
         * gradient: measured, 2.23% of pixels land strictly between 0.1 and 0.9. It is
         * still more than the category mask's none, and `matteToFloats` carries it as
         * float all the way to the texture (T959's rule — no byte rounding in between).
         */
        outputConfidenceMasks: true,
        outputCategoryMask: false,
      });
    } catch (error) {
      refusals.push(`${delegate}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    return {
      delegate: `mediapipe-${delegate.toLowerCase()}`,
      segment(image) {
        let mask: Float32Array | null = null;
        segmenter.segment(image, (result) => {
          const first = result.confidenceMasks?.[0];
          if (first === undefined) return;
          /* COPIED inside the callback, deliberately: MediaPipe documents the result's
             lifetime as the callback's, and the array it hands back is backed by wasm
             memory it is free to reuse. Returning the view would work until the frame it
             did not. */
          mask = first.getAsFloat32Array().slice();
        });
        if (mask === null) {
          throw new Error("MediaPipe returned no confidence mask for the matte input");
        }
        return mask;
      },
      close() {
        segmenter.close();
      },
    };
  }

  throw new Error(`MediaPipe could not open a segmenter — ${refusals.join("; ")}`);
}
