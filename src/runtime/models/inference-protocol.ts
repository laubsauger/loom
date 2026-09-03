/**
 * What crosses the worker boundary (T382).
 *
 * ## Why the whole pipeline goes across, not just the model call
 *
 * The obvious split — pack on the main thread, run in the worker, encode on the main
 * thread — leaves the two loops that touch every pixel exactly where they hurt. Depth's
 * packer walks 518x518 and its encoder walks the node's full output; both are plain
 * JavaScript on the frame loop's thread. So the request carries RAW TEXELS and the reply
 * carries FINISHED RGBA, and packing, inference and encoding all happen over there.
 *
 * ## Both buffers are transferable and both are transferred
 *
 * A 518x518 vec4f input is 4.3 MB and a 1080p depth map is 8.3 MB. Structured-cloning
 * those per inference would hand back a good part of what the worker saves. They move by
 * TRANSFER, which is why every payload here is an ArrayBuffer rather than a typed array
 * view: a transferred buffer is neutered on the sending side, and the sender must be the
 * only one holding it.
 */

/** The model kinds the worker knows how to pack and encode for. */
export type InferenceNodeType = "depth" | "pose" | "matte";

/**
 * WHICH SESSION, and it is NOT the model id (§T965's backend picker).
 *
 * Two Depth nodes can hold the same weights and want different execution providers — one
 * pinned to the CPU because a WebGPU driver misbehaves, one on the default ladder. A cache
 * keyed by model alone would silently hand the second node the first node's session and
 * the backend parameter would be a control that does nothing (§V146's family, one layer
 * down). So the key is the model AND the ladder it was asked to try, built by
 * `sessionKeyFor`, and every load/loaded pair carries it instead of the bare model id.
 */
export function sessionKeyFor(modelId: string, providers: readonly string[]): string {
  return `${modelId}@${providers.join("+")}`;
}

export type InferenceRequest =
  /**
   * Hand the worker a model's weights, once per session key. It builds the session and
   * keeps it, so a second node on the same model AND ladder pays nothing and no weights
   * cross again.
   */
  | {
      readonly kind: "load";
      readonly sessionKey: string;
      readonly weights: ArrayBuffer;
      /**
       * The execution providers to try, IN ORDER. The worker tries them ONE AT A TIME so
       * it can report which one actually produced a session — §T715/§V672: report what it
       * GOT by measuring, never what it ASKED for.
       */
      readonly providers: readonly string[];
    }
  | {
      readonly kind: "run";
      readonly requestId: number;
      readonly sessionKey: string;
      readonly nodeType: InferenceNodeType;
      /** Raw `vec4f` texels straight from the readback. Transferred. */
      readonly texels: ArrayBuffer;
      /** The node's output size, for the encoder. For pose that is the fixed 17×1 map. */
      readonly width: number;
      readonly height: number;
      readonly side: number;
      /**
       * T992 — the PICTURE's size, distinct from the output's. Depth and matte never
       * needed it because their output inherits the source, so width/height carried the
       * aspect for free; pose's output is the 17×1 keypoint map and the source aspect
       * never reached its encoder — which is why pose squeezed long after depth
       * letterboxed (the un-letterbox is the letterbox's other half, and it happens at
       * ENCODE). Every encoder may read it; pose must.
       */
      readonly sourceWidth: number;
      readonly sourceHeight: number;
      /**
       * T1040 — WHICH ARTEFACT, and it is not derivable from `nodeType` any more.
       *
       * Up to RVM every node type had exactly one IO shape, so the worker's table was
       * keyed by `nodeType` and two MODNet builds shared a row. RVM is a matte too, and
       * takes six inputs and returns six outputs. Its plan — the packer, the picture's
       * NAME, the recurrent feedback, the scalar inputs — is per MODEL, so the model has
       * to travel. `sessionKey` already contains it, but only by string concatenation:
       * parsing an id back out of a key is the kind of derivation that is right until
       * someone puts an `@` in a model id.
       */
      readonly modelId: string;
      /**
       * RVM's `downsample_ratio` (§V827's per-artefact knob), or 0 for a model with no
       * such input. It is the node's cost dial: RVM's encoder runs at `side × ratio` and
       * measured 61 ms at 128 px against 724 ms at 512 px, wasm, one thread.
       *
       * It is carried per RUN rather than per load because it is not session identity —
       * but it DOES change the shape of the recurrent state, so the worker drops a stash
       * whose ratio no longer matches rather than feeding tensors the model would refuse.
       */
      readonly ratio: number;
      /**
       * The temporal EMA's blend toward the new frame; 1 disables it (§T957, §V827).
       *
       * Per-run, and a PARAMETER rather than the constant it used to be: the right value
       * is a property of the MODEL. MODNet is per-frame and flickers, so it wants
       * smoothing; RVM carries its own temporal state and stacking an average on top of a
       * recurrent network double-counts the past. The default comes from the worker's
       * plan table, so "what does this model want" has one answer.
       */
      readonly smoothing: number;
    };

export type InferenceResponse =
  | {
      readonly kind: "loaded";
      readonly sessionKey: string;
      /**
       * The provider that ACTUALLY built the session — the one whose attempt returned,
       * not the one at the head of the list. This is the only honest answer to "what is it
       * running on", and it is measured rather than echoed.
       */
      readonly backend: string;
      /** Wall time the successful attempt took, ms. Telemetry only; never a render clock. */
      readonly millis: number;
      /** T1041 — the worker's own `crossOriginIsolated`; see the result message's field. */
      readonly isolated: boolean;
    }
  | {
      readonly kind: "result";
      readonly requestId: number;
      readonly bytes: ArrayBuffer;
      /** The provider this result came off. Same measurement, carried per run. */
      readonly backend: string;
      /** Wall time this inference took, ms. Telemetry only; never a render clock. */
      readonly millis: number;
      /**
       * T1041 — whether the worker ran cross-origin ISOLATED, measured in the worker
       * itself (`globalThis.crossOriginIsolated`), never assumed from config. Without
       * isolation there is no SharedArrayBuffer and wasm inference runs on ONE thread
       * (measured: MODNet 512² 1030 ms vs 250 ms on 14 cores). GitHub Pages serves no
       * COOP/COEP headers, so a hosted document lands in the slow regime while dev is
       * in the fast one — a fact the node must SAY (§V827) rather than leave as "the
       * same model is mysteriously 4× slower in prod".
       */
      readonly isolated: boolean;
    }
  /**
   * A failure is a MESSAGE, never a thrown worker error.
   *
   * An uncaught throw inside a worker surfaces as an `error` event with no request id, so
   * the caller cannot tell which inference died and every pending one hangs. §V469's shape
   * at a thread boundary: the refusal has to travel, and it has to say what it belongs to.
   */
  | { readonly kind: "error"; readonly requestId: number | null; readonly message: string };

/** The slice of `Worker` this code uses. Narrow, so a test needs no threads. */
export interface WorkerLike {
  postMessage(message: InferenceRequest, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: InferenceResponse }) => void): void;
  addEventListener(type: "error", listener: (event: unknown) => void): void;
  terminate(): void;
}
