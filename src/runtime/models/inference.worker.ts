/**
 * The inference thread (T382). A shim — every decision lives in `inference-worker-core`,
 * which is testable without starting a thread.
 *
 * `onnxruntime-web` is imported here rather than on the main thread, so the runtime and
 * its embedded wasm land in the WORKER's chunk: a document with no model node never loads
 * either, and §V585's "a disconnected model node costs zero" survives the move.
 */
import { createWorkerCore } from "./inference-worker-core.ts";
import type { InferenceRequest, InferenceResponse } from "./inference-protocol.ts";

const scope = self as unknown as {
  postMessage(message: InferenceResponse, transfer?: Transferable[]): void;
  addEventListener(type: "message", listener: (event: { data: InferenceRequest }) => void): void;
};

/**
 * The runtime module, held after the first load.
 *
 * `createTensor` is synchronous by contract — the core calls it mid-run — so the module
 * has to be resolved by then. It always is: a tensor is only ever built after a session
 * exists, and building a session is what loads this.
 */
let runtime: typeof import("onnxruntime-web") | undefined;

const core = createWorkerCore({
  createSession: async (weights) => {
    runtime ??= await import("onnxruntime-web");
    // The ladder, in the worker: WebGPU where the thread has it, wasm everywhere else.
    // What gets REPORTED is whichever produced a result, never what was asked for (§V672).
    return (await runtime.InferenceSession.create(new Uint8Array(weights), {
      executionProviders: ["webgpu", "wasm"],
    })) as never;
  },
  createTensor: (type, data, dims) => {
    if (runtime === undefined) throw new Error("onnxruntime is not loaded");
    return new runtime.Tensor(type as never, data as never, dims as number[]);
  },
  post: (response, transfer) => {
    scope.postMessage(response, transfer);
  },
});

scope.addEventListener("message", (event) => {
  void core.handle(event.data);
});
