import type { InferenceNodeType, InferenceRequest, InferenceResponse, WorkerLike } from "./inference-protocol.ts";

/**
 * The main thread's half of the inference worker (T382).
 *
 * ## Why this exists at all, with the number
 *
 * Measured 2026-09-01 on an M3 Max, `onnxruntime-web` under wasm: Depth Anything at 518²
 * takes **2599 ms** on one thread. ORT falls back to one thread unless the page is
 * cross-origin isolated and we are not, so that is the figure that applies. A frame's
 * budget is 16.7 ms. Sharing a thread with that is not a hitch to be tuned away, it is
 * structurally impossible, and no device makes it possible — even eight wasm threads
 * leave 414 ms. Pose at 18 ms would never have justified this on its own.
 *
 * ## What it promises about ORDER, which §T747 depends on
 *
 * `run` resolves when THAT request's result comes back, keyed by id, never on the next
 * message to arrive. The export path awaits it per frame to keep a take's inference lag at
 * exactly one frame; a runner that resolved on any result would keep that gate green while
 * silently pairing frames with the wrong inference — which is the failure a message
 * boundary makes easy to hide (§V737).
 */

export interface WorkerRunTarget {
  readonly modelId: string;
  readonly nodeType: InferenceNodeType;
  readonly width: number;
  readonly height: number;
  readonly side: number;
}

export interface WorkerRunnerOptions {
  readonly worker: WorkerLike;
  /** What a node needs from the worker. `undefined` if it is not a model node. */
  describe(nodeId: string): WorkerRunTarget | undefined;
  /** The acquired weights. Called once per model; `undefined` means not available. */
  weightsFor(modelId: string): Promise<ArrayBuffer | undefined>;
}

export interface WorkerRunner {
  run(nodeId: string, texels: ArrayBuffer): Promise<Uint8Array>;
  dispose(): void;
}

export function createWorkerRunner(options: WorkerRunnerOptions): WorkerRunner {
  let nextId = 1;
  const pending = new Map<number, { resolve(bytes: Uint8Array): void; reject(error: Error): void }>();
  const loads = new Map<string, Promise<void>>();
  const loadWaiters = new Map<string, { resolve(): void; reject(error: Error): void }>();

  options.worker.addEventListener("message", (event: { data: InferenceResponse }) => {
    const message = event.data;
    if (message.kind === "loaded") {
      loadWaiters.get(message.modelId)?.resolve();
      loadWaiters.delete(message.modelId);
      return;
    }
    if (message.kind === "result") {
      const waiter = pending.get(message.requestId);
      pending.delete(message.requestId);
      waiter?.resolve(new Uint8Array(message.bytes));
      return;
    }
    // An error carrying a request id belongs to that inference; one without belongs to a
    // load, and failing the load rather than hanging is the point of carrying the id.
    const error = new Error(message.message);
    if (message.requestId === null) {
      for (const [, waiter] of loadWaiters) waiter.reject(error);
      loadWaiters.clear();
      return;
    }
    const waiter = pending.get(message.requestId);
    pending.delete(message.requestId);
    waiter?.reject(error);
  });

  options.worker.addEventListener("error", () => {
    // The thread died. Everything outstanding must fail rather than hang forever — a take
    // blocked on a dead worker would never finish and would say nothing about why.
    const dead = new Error("the inference worker stopped");
    for (const [, waiter] of pending) waiter.reject(dead);
    pending.clear();
    for (const [, waiter] of loadWaiters) waiter.reject(dead);
    loadWaiters.clear();
  });

  const ensureLoaded = (modelId: string): Promise<void> => {
    const existing = loads.get(modelId);
    if (existing !== undefined) return existing;
    const started = (async () => {
      const weights = await options.weightsFor(modelId);
      if (weights === undefined) throw new Error(`${modelId} is not available`);
      const settled = new Promise<void>((resolve, reject) => {
        loadWaiters.set(modelId, { resolve, reject });
      });
      const request: InferenceRequest = { kind: "load", modelId, weights };
      options.worker.postMessage(request, [weights]);
      await settled;
    })();
    loads.set(modelId, started);
    // A failed load must not be remembered as done, or every later run fails with a stale
    // rejection and a retry can never happen.
    void started.catch(() => loads.delete(modelId));
    return started;
  };

  return {
    async run(nodeId, texels) {
      const target = options.describe(nodeId);
      if (target === undefined) throw new Error(`no inference target for "${nodeId}"`);
      await ensureLoaded(target.modelId);
      const requestId = nextId++;
      const settled = new Promise<Uint8Array>((resolve, reject) => {
        pending.set(requestId, { resolve, reject });
      });
      const request: InferenceRequest = {
        kind: "run",
        requestId,
        modelId: target.modelId,
        nodeType: target.nodeType,
        texels,
        width: target.width,
        height: target.height,
        side: target.side,
      };
      options.worker.postMessage(request, [texels]);
      return settled;
    },
    dispose() {
      options.worker.terminate();
      const gone = new Error("the inference worker was disposed");
      for (const [, waiter] of pending) waiter.reject(gone);
      pending.clear();
    },
  };
}
