import { matteToFloats } from "./matte-runner.ts";

/**
 * T1088 — the MediaPipe matte runner: the SECOND inference runtime, behind the same seam.
 *
 * ## Why this is not a fourth row in the worker's model table
 *
 * `createSession(weights, provider)` takes an ONNX ArrayBuffer plus a provider string and
 * returns named tensors. MediaPipe has none of that shape: its artefact is TFLite, its
 * runtime is its own wasm build with its own GPU delegate, and its result is a mask
 * object rather than a tensor. Forcing it through the ORT signature would mean lying in
 * both directions. So it rides one level up, at `createInferenceSources`' `run` — the
 * seam Apple Vision already rides (`use-vision-bridge.ts`, T1029), which is the existing
 * precedent for a non-ONNX producer and the reason this is a small file.
 *
 * ## What this module deliberately does NOT contain
 *
 * The `@mediapipe/tasks-vision` import and the `?url` wasm paths live in
 * `mediapipe-segmenter.ts`, and the segmenter arrives here as an INJECTED interface. Two
 * reasons, both load-bearing: this file stays importable by the headless project (a
 * `?url` specifier is a vite feature and resolves to nothing under node), and the
 * conversion below — the part with arithmetic in it — is gated on exact values rather
 * than behind a browser.
 *
 * ## The letterbox is not re-derived here
 *
 * `matteToFloats` is imported from the ORT runner rather than reimplemented, and that is
 * the point: the GPU preprocess writes the SAME letterboxed square for every matte model
 * (`letterboxPreprocessWgsl`), so the undo must be the same function or the two runtimes
 * would place their mattes differently on the picture from one code path to the other.
 */

/**
 * The slice of an image segmenter this runner needs.
 *
 * Injected rather than imported so the arithmetic above it is testable in node, and
 * narrow on purpose: a runner that could reach the whole `ImageSegmenter` would grow
 * options that belong to the segmenter's own module.
 */
export interface MatteSegmenter {
  /**
   * Which delegate actually opened — never what was requested (§V672's rule, the same
   * one that makes the ORT path report the api onnxruntime really built with). The
   * ladder falls to CPU on a machine whose WebGL delegate refuses, and that costs a
   * measured 14% of the delivered figure, so a node that fell has to be able to say so.
   */
  readonly delegate: string;
  /**
   * One confidence value per pixel of the fed square, row-major, in [0, 1].
   *
   * Length is exactly `side * side`. MediaPipe works at 256² internally and upsamples to
   * whatever it was fed, so this is the fed square's size and carries no more detail than
   * 256² held — measured flat at 3.7 ms for every side, which is why the node never
   * offers a size knob for this model.
   */
  segment(image: OffscreenCanvas): Float32Array;
  close(): void;
}

export interface MediaPipeMatteRunner {
  /**
   * One inference. `input` is the preprocess buffer — `side * side` vec4f in the LINEAR
   * working space — and the result is r32float bytes at the node's output size, the same
   * encoding every matte model publishes.
   */
  run(input: ArrayBuffer, outWidth: number, outHeight: number): Promise<Uint8Array>;
  dispose(): void;
}

/**
 * The preprocess buffer → the RGBA8 square the segmenter is fed.
 *
 * ⚠ NO TRANSFER FUNCTION IS APPLIED, and that is measured rather than lazy. Pictures
 * reach this node in LINEAR light, so the square is about a stop and a half darker than
 * the display-referred frames MediaPipe was trained on — the same fact that makes
 * MATTE_FAST collapse on a dim picture. Measured 2026-09-03 on one frame at 512², linear
 * feed against the sRGB-encoded feed of the same frame: mean level 0.332 against 0.557,
 * and yet coverage 0.1576 against 0.1549 with IoU 0.9713 and mean |Δ| 0.0050. This model
 * is robust to the transfer where the quantized MODNet is not.
 *
 * So the transfer is NOT applied, for a reason beyond the small number: every other matte
 * model is fed this buffer raw, and encoding it for one of them would make the node's
 * input treatment depend on which model is selected.
 *
 * ⚑ T1091 ANSWERED THE CROSS-CUTTING HALF and the ruling stands here unchanged: measured
 * across all four matte models on seven frames, feeding display-referred light is NOT
 * materially better, and the one model it does move is moved by LEVEL rather than by the
 * transfer (§V857). The argument, the table and what it costs live at the seam where the
 * input is actually prepared — `letterboxPreprocessWgsl` in `nodes/definitions/
 * inference-node.ts` — because that is the one place an answer could be applied for the
 * whole path. ⚠ THIS BLOCK'S OWN ONE-FRAME NUMBER IS THE CAUTIONARY HALF: IoU 0.9713 was
 * true of that portrait and the same model reads 0.675 on a harder frame.
 */
export function matteTexelsToRgba(texels: Float32Array, side: number): Uint8ClampedArray {
  const pixels = side * side;
  const out = new Uint8ClampedArray(pixels * 4);
  for (let at = 0; at < pixels; at += 1) {
    const base = at * 4;
    for (let channel = 0; channel < 3; channel += 1) {
      out[base + channel] = Math.round((texels[base + channel] ?? 0) * 255);
    }
    out[base + 3] = 255;
  }
  return out;
}

/**
 * Builds the runner. `openSegmenter` is awaited ONCE, lazily, on the first run and its
 * result reused — a segmenter carries a wasm instance and a GL context, so constructing
 * one per frame would cost far more than the inference it wraps.
 *
 * A failed open is not cached as a permanent refusal: the seam already serves the
 * identity matte and surfaces the failure per node, and a model download that failed once
 * (a captive portal, a dropped connection) must be retryable without reloading the tab.
 */
export function createMediaPipeMatteRunner(options: {
  readonly side: number;
  readonly openSegmenter: () => Promise<MatteSegmenter>;
  /** Injected so this module needs no DOM global (§V63) and node tests can supply one. */
  readonly createCanvas?: (width: number, height: number) => OffscreenCanvas;
}): MediaPipeMatteRunner {
  const { side, openSegmenter } = options;
  const makeCanvas = options.createCanvas ?? ((w: number, h: number) => new OffscreenCanvas(w, h));

  let segmenter: MatteSegmenter | null = null;
  let opening: Promise<MatteSegmenter> | null = null;
  let canvas: OffscreenCanvas | null = null;

  const ready = async (): Promise<MatteSegmenter> => {
    if (segmenter !== null) return segmenter;
    if (opening === null) {
      opening = openSegmenter().then(
        (opened) => {
          segmenter = opened;
          opening = null;
          return opened;
        },
        (error: unknown) => {
          opening = null;
          throw error;
        },
      );
    }
    return opening;
  };

  return {
    async run(input, outWidth, outHeight) {
      const active = await ready();
      const texels = new Float32Array(input);
      const expected = side * side * 4;
      if (texels.length !== expected) {
        /* Loud, because the alternative is a silently mis-shaped matte. The preprocess
           and this runner both read the node's side from the same definition, so a
           mismatch means they have drifted and no picture is the honest outcome. */
        throw new Error(
          `matte input is ${texels.length} floats, expected ${expected} (${side}x${side} vec4f)`,
        );
      }
      if (canvas === null) canvas = makeCanvas(side, side);
      const context = canvas.getContext("2d");
      if (context === null) throw new Error("no 2d context for the matte input square");
      const image = context.createImageData(side, side);
      image.data.set(matteTexelsToRgba(texels, side));
      context.putImageData(image, 0, 0);

      const mask = active.segment(canvas);
      if (mask.length !== side * side) {
        throw new Error(`segmenter returned ${mask.length} values, expected ${side * side}`);
      }
      return matteToFloats(mask, side, outWidth, outHeight);
    },
    dispose() {
      segmenter?.close();
      segmenter = null;
      opening = null;
      canvas = null;
    },
  };
}
