import {
  sessionKeyFor,
  type InferenceNodeType,
  type InferenceRequest,
  type InferenceResponse,
  type WorkerLike,
} from "./inference-protocol.ts";

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
  /** T992: the PICTURE's dims — pose's encoder un-letterboxes its joints against these. */
  readonly sourceWidth: number;
  readonly sourceHeight: number;
  /**
   * The execution providers this node asks the worker to try, in order (§T965's backend
   * parameter). Part of the SESSION IDENTITY, not just a hint: two nodes on the same
   * weights with different ladders get different sessions, or the second node's choice
   * would be a control that silently does nothing.
   */
  readonly providers: readonly string[];
  /**
   * T1040 — RVM's `downsample_ratio`, or 0 for a model with no scalar input.
   *
   * The node's cost dial: RVM's encoder runs at `side × ratio`, measured 61 ms at 128 px
   * against 724 ms at 512 px (wasm, one thread, 512² letterbox). Not part of session
   * identity — the same session serves any ratio — but it does resize the recurrent
   * state, which the worker handles by dropping a stash whose ratio moved.
   */
  readonly ratio: number;
  /** The temporal EMA's blend toward the new frame; 1 disables it (§T957's alpha). */
  readonly smoothing: number;
}

/** What a completed run turned out to have used. Measured, never echoed (§V672). */
export interface InferenceMeasurement {
  /** The execution provider that actually produced the session. */
  readonly backend: string;
  /** Wall time the inference took, ms. Telemetry only. */
  readonly millis: number;
  /** T1041 — the worker's own `crossOriginIsolated`. False = wasm ran single-threaded. */
  readonly isolated: boolean;
}

export interface WorkerRunnerOptions {
  readonly worker: WorkerLike;
  /** What a node needs from the worker. `undefined` if it is not a model node. */
  describe(nodeId: string): WorkerRunTarget | undefined;
  /** The acquired weights. Called once per model; `undefined` means not available. */
  weightsFor(modelId: string): Promise<ArrayBuffer | undefined>;
  /**
   * Called with each completed run's measurement, so the node can REPORT what it ran on.
   *
   * A callback rather than a widened `run` return, because `InferenceRunner` — the seam
   * both fill policies share — is deliberately "bytes in, bytes out": threading telemetry
   * through it would put a reporting concern in the middle of the reproducibility path.
   */
  onMeasured?(nodeId: string, measurement: InferenceMeasurement): void;
}

export interface WorkerRunner {
  run(nodeId: string, texels: ArrayBuffer): Promise<Uint8Array>;
  dispose(): void;
}

export function createWorkerRunner(options: WorkerRunnerOptions): WorkerRunner {
  let nextId = 1;
  const pending = new Map<
    number,
    { nodeId: string; resolve(bytes: Uint8Array): void; reject(error: Error): void }
  >();
  const loads = new Map<string, Promise<void>>();
  const loadWaiters = new Map<string, { resolve(): void; reject(error: Error): void }>();

  options.worker.addEventListener("message", (event: { data: InferenceResponse }) => {
    const message = event.data;
    if (message.kind === "loaded") {
      loadWaiters.get(message.sessionKey)?.resolve();
      loadWaiters.delete(message.sessionKey);
      return;
    }
    if (message.kind === "result") {
      const waiter = pending.get(message.requestId);
      pending.delete(message.requestId);
      if (waiter !== undefined) {
        options.onMeasured?.(waiter.nodeId, {
          backend: message.backend,
          millis: message.millis,
          isolated: message.isolated,
        });
      }
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

  const ensureLoaded = (modelId: string, sessionKey: string, providers: readonly string[]): Promise<void> => {
    const existing = loads.get(sessionKey);
    if (existing !== undefined) return existing;
    const started = (async () => {
      const weights = await options.weightsFor(modelId);
      if (weights === undefined) throw new Error(`${modelId} is not available`);
      const settled = new Promise<void>((resolve, reject) => {
        loadWaiters.set(sessionKey, { resolve, reject });
      });
      const request: InferenceRequest = { kind: "load", sessionKey, modelId, weights, providers };
      options.worker.postMessage(request, [weights]);
      await settled;
    })();
    loads.set(sessionKey, started);
    // A failed load must not be remembered as done, or every later run fails with a stale
    // rejection and a retry can never happen.
    void started.catch(() => loads.delete(sessionKey));
    return started;
  };

  return {
    async run(nodeId, texels) {
      const target = options.describe(nodeId);
      if (target === undefined) throw new Error(`no inference target for "${nodeId}"`);
      const sessionKey = sessionKeyFor(target.modelId, target.providers);
      await ensureLoaded(target.modelId, sessionKey, target.providers);
      const requestId = nextId++;
      const settled = new Promise<Uint8Array>((resolve, reject) => {
        pending.set(requestId, { nodeId, resolve, reject });
      });
      const request: InferenceRequest = {
        kind: "run",
        requestId,
        sessionKey,
        nodeType: target.nodeType,
        texels,
        width: target.width,
        height: target.height,
        side: target.side,
        sourceWidth: target.sourceWidth,
        sourceHeight: target.sourceHeight,
        // T1040: the worker's plan table is keyed by MODEL, not node type — two matte
        // artefacts no longer share an IO shape.
        modelId: target.modelId,
        ratio: target.ratio,
        smoothing: target.smoothing,
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
