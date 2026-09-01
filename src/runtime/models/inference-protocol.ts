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
export type InferenceNodeType = "depth" | "pose";

export type InferenceRequest =
  /**
   * Hand the worker a model's weights, once. It builds the session and keeps it, so a
   * second node using the same model pays nothing and no weights cross again.
   */
  | { readonly kind: "load"; readonly modelId: string; readonly weights: ArrayBuffer }
  | {
      readonly kind: "run";
      readonly requestId: number;
      readonly modelId: string;
      readonly nodeType: InferenceNodeType;
      /** Raw `vec4f` texels straight from the readback. Transferred. */
      readonly texels: ArrayBuffer;
      /** The node's output size, for the encoder. Ignored by pose, which is fixed. */
      readonly width: number;
      readonly height: number;
      readonly side: number;
    };

export type InferenceResponse =
  | { readonly kind: "loaded"; readonly modelId: string }
  | { readonly kind: "result"; readonly requestId: number; readonly bytes: ArrayBuffer }
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
