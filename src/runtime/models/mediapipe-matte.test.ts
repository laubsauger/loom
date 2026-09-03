import { describe, expect, it } from "vitest";

import {
  createMediaPipeMatteRunner,
  matteTexelsToRgba,
  type MatteSegmenter,
} from "./mediapipe-matte.ts";
import {
  isMediaPipeMatte,
  MATTE_ACCURATE,
  MATTE_FAST,
  MATTE_MEDIAPIPE,
  MATTE_MODELS,
  MATTE_RVM,
} from "./model-catalogue.ts";

/**
 * T1088. What these gates are for, in one line each: the PARTITION (a matte node must be
 * executed by exactly one runtime), and the CONVERSION (the bytes the consumer reads back
 * from the runner, asserted as values rather than as "it called the segmenter").
 */

/** A canvas stand-in: node has no OffscreenCanvas, and the runner only needs 2d. */
function fakeCanvas(side: number): OffscreenCanvas {
  let stored: Uint8ClampedArray = new Uint8ClampedArray(side * side * 4);
  const context = {
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: (image: { data: Uint8ClampedArray }) => {
      stored = image.data;
    },
  };
  return {
    width: side,
    height: side,
    getContext: () => context,
    /** Test-only reach-in, so a gate can assert what the segmenter was actually fed. */
    get __fed(): Uint8ClampedArray {
      return stored;
    },
  } as unknown as OffscreenCanvas;
}

function segmenterReturning(mask: Float32Array, seen?: (image: OffscreenCanvas) => void): MatteSegmenter {
  return {
    delegate: "mediapipe-test",
    segment: (image) => {
      seen?.(image);
      return mask;
    },
    close: () => {},
  };
}

describe("the matte runtime partition (T1088)", () => {
  /**
   * The load-bearing one. Two runtimes now execute matte nodes, and the tracking loop
   * asks this single predicate which. If the two sides overlapped, a node would be run by
   * both and two producers would race to fill one media source; if they left a gap, a
   * node would compile, allocate and publish its identity matte forever. Neither failure
   * shows up as an exception — both look like a matte that is merely wrong — so the
   * partition is asserted over the whole catalogue rather than spot-checked.
   */
  it("routes every model in MATTE_MODELS to exactly one runtime", () => {
    const mediapipe = MATTE_MODELS.filter((model) => isMediaPipeMatte(model.id));
    const onnx = MATTE_MODELS.filter((model) => !isMediaPipeMatte(model.id));

    expect(mediapipe.map((model) => model.id)).toEqual([MATTE_MEDIAPIPE.id]);
    expect(onnx.map((model) => model.id)).toEqual([MATTE_ACCURATE.id, MATTE_FAST.id, MATTE_RVM.id]);
    // Disjoint and exhaustive, stated as the arithmetic rather than trusted from the two
    // lists above: a model added to the catalogue and to neither side fails here.
    expect(mediapipe.length + onnx.length).toBe(MATTE_MODELS.length);
  });

  /**
   * The ONNX runner would accept these bytes and produce something — a .tflite fed to
   * onnxruntime fails at session creation, not at the seam — so the guard that keeps it
   * from being asked is this id, and an id typo would silently route MediaPipe's artefact
   * into the worker. Pin it.
   */
  it("identifies the MediaPipe artefact by the id the catalogue actually ships", () => {
    expect(isMediaPipeMatte(MATTE_MEDIAPIPE.id)).toBe(true);
    expect(isMediaPipeMatte(MATTE_ACCURATE.id)).toBe(false);
    expect(isMediaPipeMatte("mediapipe-selfie-segmenter ")).toBe(false);
  });

  /**
   * §V858's provenance half, and it is not decoration: this URL is the one row in the
   * catalogue that is NOT revision-pinned — Google publishes only `/latest/` — so the
   * hash is the entire pin. A row that lost it would still download and still work, right
   * up until upstream republished.
   */
  it("pins the mutable MediaPipe URL by hash and byte count", () => {
    expect(MATTE_MEDIAPIPE.sha256).toBe(
      "191ac9529ae506ee0beefa6b2c945a172dab9d07d1e802a290a4e4038226658b",
    );
    expect(MATTE_MEDIAPIPE.bytes).toBe(249_537);
    expect(MATTE_MEDIAPIPE.license).toBe("Apache-2.0");
  });
});

describe("the MediaPipe matte runner (T1088)", () => {
  /**
   * The feed, as values. The preprocess writes LINEAR vec4f and the segmenter is handed
   * RGBA8 of the same numbers with no transfer applied — which is a measured decision
   * (see the module), so a transfer added later has to come past this assertion.
   */
  it("feeds the segmenter the preprocess texels as RGBA8, untransformed", () => {
    const side = 2;
    const texels = new Float32Array([
      1, 0, 0, 1, 0, 1, 0, 1,
      0, 0, 1, 1, 0.5, 0.5, 0.5, 1,
    ]);
    const canvas = fakeCanvas(side);
    let fed: OffscreenCanvas | null = null;
    const runner = createMediaPipeMatteRunner({
      side,
      openSegmenter: async () => segmenterReturning(new Float32Array(side * side), (image) => { fed = image; }),
      createCanvas: () => canvas,
    });

    return runner.run(texels.buffer, 2, 2).then(() => {
      expect(fed).toBe(canvas);
      // 0.5 linear stays 128, NOT the 188 an sRGB encode would produce.
      expect([...(canvas as unknown as { __fed: Uint8ClampedArray }).__fed]).toEqual([
        255, 0, 0, 255, 0, 255, 0, 255,
        0, 0, 255, 255, 128, 128, 128, 255,
      ]);
    });
  });

  /**
   * The bytes the CONSUMER reads back — r32float at the node's output size, which is what
   * the media registry uploads and a pass samples. Asserted as exact floats, and against
   * a square output so the letterbox is the identity and the expected values are readable
   * by hand; `matte-coverage.gpu.test.ts` owns the non-square letterbox arithmetic.
   */
  it("publishes the mask as r32float texels at the output size", async () => {
    const side = 2;
    const mask = new Float32Array([0, 0.25, 0.75, 1]);
    const runner = createMediaPipeMatteRunner({
      side,
      openSegmenter: async () => segmenterReturning(mask),
      createCanvas: () => fakeCanvas(side),
    });

    const out = await runner.run(new Float32Array(side * side * 4).buffer, 2, 2);
    expect(out.byteLength).toBe(2 * 2 * 4);
    expect([...new Float32Array(out.buffer, out.byteOffset, 4)]).toEqual([0, 0.25, 0.75, 1]);
  });

  /**
   * Opening a segmenter costs a wasm instance and a GL context. Reusing it is the whole
   * reason this runner holds state, and "opened once" is invisible in the picture — it
   * would merely be slow — so it is asserted rather than assumed.
   */
  it("opens the segmenter once and reuses it across runs", async () => {
    const side = 2;
    let opens = 0;
    const runner = createMediaPipeMatteRunner({
      side,
      openSegmenter: async () => {
        opens += 1;
        return segmenterReturning(new Float32Array(side * side));
      },
      createCanvas: () => fakeCanvas(side),
    });
    const input = new Float32Array(side * side * 4).buffer;
    await runner.run(input, 2, 2);
    await runner.run(input, 2, 2);
    await runner.run(input, 2, 2);
    expect(opens).toBe(1);
  });

  /**
   * A failed open must stay RETRYABLE. The download this depends on can fail for reasons
   * that clear themselves — a captive portal, a dropped connection — and caching the
   * refusal would make the node dead until the tab reloaded, which is the shape of
   * failure the seam's own fallback exists to avoid.
   */
  it("retries after a failed open rather than latching the failure", async () => {
    const side = 2;
    let attempts = 0;
    const runner = createMediaPipeMatteRunner({
      side,
      openSegmenter: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("wasm did not load");
        return segmenterReturning(new Float32Array(side * side));
      },
      createCanvas: () => fakeCanvas(side),
    });
    const input = new Float32Array(side * side * 4).buffer;
    await expect(runner.run(input, 2, 2)).rejects.toThrow("wasm did not load");
    await expect(runner.run(input, 2, 2)).resolves.toBeInstanceOf(Uint8Array);
    expect(attempts).toBe(2);
  });

  /**
   * The guard is against the CAUSE — preprocess and runner disagreeing about the square —
   * and the legitimate case it could swallow is the ordinary matching one, exercised by
   * every test above. A mis-shaped buffer must not be quietly resized into a plausible,
   * wrongly-placed matte.
   */
  it("refuses an input buffer that is not the declared square", async () => {
    const runner = createMediaPipeMatteRunner({
      side: 4,
      openSegmenter: async () => segmenterReturning(new Float32Array(16)),
      createCanvas: () => fakeCanvas(4),
    });
    await expect(runner.run(new Float32Array(2 * 2 * 4).buffer, 2, 2)).rejects.toThrow(
      "matte input is 16 floats, expected 64",
    );
  });
});

describe("matteTexelsToRgba", () => {
  it("clamps out-of-range texels rather than wrapping them", () => {
    // The working space is linear and unbounded above 1 — a bright highlight or an
    // over-exposed source genuinely lands there, and wrapping would put a white pixel in
    // shadow. Uint8ClampedArray is the mechanism; this asserts the behaviour.
    const out = matteTexelsToRgba(new Float32Array([2, -1, 0.5, 1]), 1);
    expect([...out]).toEqual([255, 0, 128, 255]);
  });
});
