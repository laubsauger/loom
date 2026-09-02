import { describe, expect, it } from "vitest";
import { createWorkerCore, type InferenceSessionLike } from "./inference-worker-core.ts";
import { createWorkerRunner } from "./worker-runner.ts";
import { createInferenceSources } from "../execution/inference-sources.ts";
import { POSE_KEYPOINT_COUNT } from "./pose-runner.ts";
import {
  sessionKeyFor,
  type InferenceRequest,
  type InferenceResponse,
  type WorkerLike,
} from "./inference-protocol.ts";

/**
 * The inference worker (T382), on both sides of the boundary.
 *
 * Justified by a measurement, not a hunch: Depth Anything at 518² takes 2599 ms under wasm
 * on one thread, and ORT falls back to one thread unless the page is cross-origin isolated,
 * which we are not. A 16.7 ms frame cannot share that. Pose at 18 ms would never have
 * justified it alone.
 */

/** A worker whose delivery THIS TEST decides — no threads, no timing luck. */
function fakeWorker() {
  const sent: InferenceRequest[] = [];
  const transfers: Transferable[][] = [];
  let listener: ((event: { data: InferenceResponse }) => void) | null = null;
  let onError: (() => void) | null = null;
  return {
    sent,
    transfers,
    deliver(message: InferenceResponse) {
      listener?.({ data: message });
    },
    crash() {
      onError?.();
    },
    worker: {
      postMessage: (message: InferenceRequest, transfer?: Transferable[]) => {
        sent.push(message);
        transfers.push(transfer ?? []);
      },
      addEventListener: (type: string, handler: unknown) => {
        if (type === "message") listener = handler as typeof listener;
        else onError = handler as typeof onError;
      },
      terminate: () => undefined,
    } satisfies WorkerLike as WorkerLike,
  };
}

const PROVIDERS = ["wasm"] as const;
const target = {
  modelId: "m",
  nodeType: "depth" as const,
  width: 2,
  sourceWidth: 2,
  sourceHeight: 2,
  height: 2,
  side: 2,
  providers: PROVIDERS,
};
const runnerOver = (fake: ReturnType<typeof fakeWorker>) =>
  createWorkerRunner({
    worker: fake.worker,
    describe: () => target,
    weightsFor: async () => new ArrayBuffer(8),
  });

describe("the main thread's half", () => {
  it("loads a model once however many nodes ask", async () => {
    const fake = fakeWorker();
    const runner = runnerOver(fake);
    const a = runner.run("n1", new ArrayBuffer(4));
    const b = runner.run("n2", new ArrayBuffer(4));
    await Promise.resolve();
    fake.deliver({ kind: "loaded", sessionKey: sessionKeyFor("m", PROVIDERS), backend: "wasm", millis: 1 });
    await Promise.resolve();
    await Promise.resolve();

    expect(fake.sent.filter((m) => m.kind === "load")).toHaveLength(1);
    fake.deliver({ kind: "result", requestId: 1, bytes: new ArrayBuffer(3), backend: "wasm", millis: 1 });
    fake.deliver({ kind: "result", requestId: 2, bytes: new ArrayBuffer(3), backend: "wasm", millis: 1 });
    expect((await a).length).toBe(3);
    expect((await b).length).toBe(3);
  });

  /**
   * THE ONE §T747 RESTS ON. A runner that resolved on "the next result to arrive" keeps
   * every ordering gate green while pairing frames with the wrong inference — and a
   * message boundary is exactly where that becomes invisible (§V737). So results are
   * delivered OUT OF ORDER here and each request must still get its own.
   */
  it("resolves each request with ITS result, not the next one to arrive", async () => {
    const fake = fakeWorker();
    const runner = runnerOver(fake);
    const first = runner.run("n1", new ArrayBuffer(4));
    await Promise.resolve();
    fake.deliver({ kind: "loaded", sessionKey: sessionKeyFor("m", PROVIDERS), backend: "wasm", millis: 1 });
    await Promise.resolve();
    await Promise.resolve();
    const second = runner.run("n2", new ArrayBuffer(4));
    await Promise.resolve();
    await Promise.resolve();

    const runs = fake.sent.filter((m) => m.kind === "run");
    expect(runs).toHaveLength(2);

    // Second answers FIRST, and carries a distinguishable payload.
    fake.deliver({ kind: "result", requestId: 2, bytes: new Uint8Array([2, 2]).buffer, backend: "wasm", millis: 1 });
    fake.deliver({ kind: "result", requestId: 1, bytes: new Uint8Array([1]).buffer, backend: "wasm", millis: 1 });

    expect([...(await first)]).toEqual([1]);
    expect([...(await second)]).toEqual([2, 2]);
  });

  it("transfers the payload rather than cloning it", async () => {
    // A 518² vec4f input is 4.3 MB and a 1080p depth map 8.3 MB. Cloning per inference
    // gives back a good part of what the worker saves.
    const fake = fakeWorker();
    const runner = runnerOver(fake);
    const texels = new ArrayBuffer(4);
    void runner.run("n1", texels);
    await Promise.resolve();
    fake.deliver({ kind: "loaded", sessionKey: sessionKeyFor("m", PROVIDERS), backend: "wasm", millis: 1 });
    await Promise.resolve();
    await Promise.resolve();
    const runIndex = fake.sent.findIndex((m) => m.kind === "run");
    expect(fake.transfers[runIndex]).toContain(texels);
  });

  it("fails the request that died, naming it, rather than hanging every other one", async () => {
    const fake = fakeWorker();
    const runner = runnerOver(fake);
    const a = runner.run("n1", new ArrayBuffer(4));
    await Promise.resolve();
    fake.deliver({ kind: "loaded", sessionKey: sessionKeyFor("m", PROVIDERS), backend: "wasm", millis: 1 });
    await Promise.resolve();
    await Promise.resolve();
    const b = runner.run("n2", new ArrayBuffer(4));
    await Promise.resolve();
    await Promise.resolve();

    fake.deliver({ kind: "error", requestId: 1, message: "model exploded" });
    fake.deliver({ kind: "result", requestId: 2, bytes: new ArrayBuffer(1), backend: "wasm", millis: 1 });

    await expect(a).rejects.toThrow("model exploded");
    expect((await b).length).toBe(1);
  });

  it("fails everything outstanding when the thread dies, instead of blocking a take forever", async () => {
    const fake = fakeWorker();
    const runner = runnerOver(fake);
    const a = runner.run("n1", new ArrayBuffer(4));
    await Promise.resolve();
    fake.deliver({ kind: "loaded", sessionKey: sessionKeyFor("m", PROVIDERS), backend: "wasm", millis: 1 });
    await Promise.resolve();
    await Promise.resolve();
    fake.crash();
    await expect(a).rejects.toThrow("stopped");
  });

  it("lets a failed load be retried rather than remembering it as done", async () => {
    let attempts = 0;
    const fake = fakeWorker();
    const runner = createWorkerRunner({
      worker: fake.worker,
      describe: () => target,
      weightsFor: async () => {
        attempts += 1;
        if (attempts === 1) return undefined;
        return new ArrayBuffer(8);
      },
    });
    await expect(runner.run("n1", new ArrayBuffer(4))).rejects.toThrow("not available");
    const second = runner.run("n1", new ArrayBuffer(4));
    await Promise.resolve();
    fake.deliver({ kind: "loaded", sessionKey: sessionKeyFor("m", PROVIDERS), backend: "wasm", millis: 1 });
    await Promise.resolve();
    await Promise.resolve();
    fake.deliver({ kind: "result", requestId: 1, bytes: new ArrayBuffer(2), backend: "wasm", millis: 1 });
    expect((await second).length).toBe(2);
    expect(attempts).toBe(2);
  });
});

describe("the worker's half", () => {
  function fakeSession(output: Float32Array): InferenceSessionLike {
    return {
      inputNames: ["pixel_values"],
      outputNames: ["out"],
      run: async () => ({ out: { data: output } }),
    };
  }

  function core(output: Float32Array) {
    const posted: InferenceResponse[] = [];
    const created: unknown[] = [];
    return {
      posted,
      created,
      instance: createWorkerCore({
        createSession: async () => fakeSession(output),
        createTensor: (type, data, dims) => {
          created.push({ type, length: data.length, dims });
          return {};
        },
        post: (response) => posted.push(response),
      }),
    };
  }

  it("packs DEPTH as planar float32 and returns an encoded picture", async () => {
    const c = core(new Float32Array([0, 1, 2, 3]));
    await c.instance.handle({ kind: "load", sessionKey: "m@wasm", weights: new ArrayBuffer(4), providers: ["wasm"] });
    await c.instance.handle({
      kind: "run", requestId: 7, sessionKey: "m@wasm", nodeType: "depth",
      texels: new Float32Array(2 * 2 * 4).buffer, width: 2, height: 2, side: 2, sourceWidth: 2, sourceHeight: 2,
    });
    expect(c.created[0]).toEqual({ type: "float32", length: 3 * 4, dims: [1, 3, 2, 2] });
    const result = c.posted.find((m) => m.kind === "result");
    expect(result?.kind === "result" && result.bytes.byteLength).toBe(2 * 2 * 4);
  });

  it("packs POSE as uint8 x4 NHWC — the model's signature, not its card (§B148)", async () => {
    const c = core(new Float32Array(POSE_KEYPOINT_COUNT * 3));
    await c.instance.handle({ kind: "load", sessionKey: "m@wasm", weights: new ArrayBuffer(4), providers: ["wasm"] });
    await c.instance.handle({
      kind: "run", requestId: 1, sessionKey: "m@wasm", nodeType: "pose",
      texels: new Float32Array(2 * 2 * 4).buffer, width: 0, height: 0, side: 2, sourceWidth: 2, sourceHeight: 2,
    });
    expect(c.created[0]).toEqual({ type: "uint8", length: 2 * 2 * 4, dims: [1, 2, 2, 4] });
    const result = c.posted.find((m) => m.kind === "result");
    expect(result?.kind === "result" && result.bytes.byteLength).toBe(POSE_KEYPOINT_COUNT * 8);
  });

  it("answers a run with no session as an ERROR carrying the request id", async () => {
    // Not a thrown worker crash: an uncaught throw arrives with no id, so the caller
    // cannot tell which inference died and every pending one hangs (§V469 at a boundary).
    const c = core(new Float32Array(4));
    await c.instance.handle({
      kind: "run", requestId: 42, sessionKey: "absent@wasm", nodeType: "depth",
      texels: new ArrayBuffer(64), width: 2, height: 2, side: 2, sourceWidth: 2, sourceHeight: 2,
    });
    expect(c.posted).toEqual([
      { kind: "error", requestId: 42, message: 'no session for "absent@wasm" — send a load before a run' },
    ]);
  });

  it("keeps ONE session per model AND ladder however many runs arrive", async () => {
    let built = 0;
    const instance = createWorkerCore({
      createSession: async () => {
        built += 1;
        return fakeSession(new Float32Array(4));
      },
      createTensor: () => ({}),
      post: () => undefined,
    });
    await instance.handle({ kind: "load", sessionKey: "m@wasm", weights: new ArrayBuffer(4), providers: ["wasm"] });
    await instance.handle({ kind: "load", sessionKey: "m@wasm", weights: new ArrayBuffer(4), providers: ["wasm"] });
    expect(built).toBe(1);
  });

  /**
   * T965 — WHAT IT RAN ON, MEASURED RATHER THAN ECHOED (§T715, §V672).
   *
   * The owner asked to see and pick the backend. The trap is that ORT will happily take
   * `["webgpu", "wasm"]`, fall back inside itself, and hand back a session that cannot say
   * which half of the ladder built it — so a readout would confidently print WebGPU while
   * the CPU did the work. That is not a smaller version of §B171, it IS §B171: a surface
   * naming what was asked for while something else happened.
   *
   * So the ladder is walked OUT HERE, one provider per attempt, and the provider that
   * returns is the one reported. This asserts it by making the first rung fail.
   */
  it("reports the provider that ANSWERED, not the one at the head of the ladder", async () => {
    const posted: InferenceResponse[] = [];
    const asked: string[] = [];
    const instance = createWorkerCore({
      createSession: async (_weights, provider) => {
        asked.push(provider);
        if (provider === "webgpu") throw new Error("no adapter");
        return fakeSession(new Float32Array(4));
      },
      createTensor: () => ({}),
      post: (response) => posted.push(response),
      now: () => 0,
    });
    await instance.handle({
      kind: "load",
      sessionKey: "m@webgpu+wasm",
      weights: new ArrayBuffer(4),
      providers: ["webgpu", "wasm"],
    });
    expect(asked).toEqual(["webgpu", "wasm"]);
    const loaded = posted.find((m) => m.kind === "loaded");
    expect(loaded?.kind === "loaded" && loaded.backend).toBe("wasm");
  });

  it("carries the measured backend and duration on every RESULT", async () => {
    const posted: InferenceResponse[] = [];
    let clock = 0;
    const instance = createWorkerCore({
      createSession: async () => fakeSession(new Float32Array([0, 1, 2, 3])),
      createTensor: () => ({}),
      post: (response) => posted.push(response),
      // Two reads per timed span; the run's is the second pair.
      now: () => (clock += 5),
    });
    await instance.handle({
      kind: "load", sessionKey: "m@wasm", weights: new ArrayBuffer(4), providers: ["wasm"],
    });
    await instance.handle({
      kind: "run", requestId: 1, sessionKey: "m@wasm", nodeType: "depth",
      texels: new Float32Array(2 * 2 * 4).buffer, width: 2, height: 2, side: 2, sourceWidth: 2, sourceHeight: 2,
    });
    const result = posted.find((m) => m.kind === "result");
    expect(result?.kind === "result" && result.backend).toBe("wasm");
    expect(result?.kind === "result" && result.millis).toBe(5);
  });

  it("PINS when pinned: one provider, one attempt, and a refusal that names it", async () => {
    // A pinned provider that quietly fell through to the CPU would have removed the
    // choice by hiding it, which is the failure the provider table exists to prevent.
    const posted: InferenceResponse[] = [];
    const asked: string[] = [];
    const instance = createWorkerCore({
      createSession: async (_weights, provider) => {
        asked.push(provider);
        throw new Error("no adapter");
      },
      createTensor: () => ({}),
      post: (response) => posted.push(response),
    });
    await instance.handle({
      kind: "load", sessionKey: "m@webgpu", weights: new ArrayBuffer(4), providers: ["webgpu"],
    });
    expect(asked).toEqual(["webgpu"]);
    const error = posted.find((m) => m.kind === "error");
    expect(error?.kind === "error" && error.message).toContain("[webgpu]");
    expect(error?.kind === "error" && error.message).toContain("no adapter");
  });

  it("§B171 — rewrites a wasm-load failure into the CAUSE before it leaves the thread", async () => {
    // The message the owner needed. It has to be applied HERE, at the boundary, because
    // this is the last point that sees the runtime's own wording.
    const posted: InferenceResponse[] = [];
    const instance = createWorkerCore({
      createSession: async () => {
        throw new Error(
          "CompileError: WebAssembly.instantiate(): expected magic word 00 61 73 6d, found 3c 21 64 6f @+0",
        );
      },
      createTensor: () => ({}),
      post: (response) => posted.push(response),
    });
    await instance.handle({
      kind: "load", sessionKey: "m@wasm", weights: new ArrayBuffer(4), providers: ["wasm"],
    });
    const error = posted.find((m) => m.kind === "error");
    expect(error?.kind === "error" && error.message).toContain("HTML");
    expect(error?.kind === "error" && error.message).toContain("wasmPaths");
  });

  it("does NOT remember a failed load as done, so a retry can succeed", async () => {
    // The rejected promise used to stay in the session cache, so every later attempt
    // replayed the same stale rejection and no retry could ever work.
    let attempts = 0;
    const posted: InferenceResponse[] = [];
    const instance = createWorkerCore({
      createSession: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient");
        return fakeSession(new Float32Array(4));
      },
      createTensor: () => ({}),
      post: (response) => posted.push(response),
    });
    const load = {
      kind: "load" as const, sessionKey: "m@wasm", weights: new ArrayBuffer(4), providers: ["wasm"],
    };
    await instance.handle(load);
    await instance.handle(load);
    expect(attempts).toBe(2);
    expect(posted.some((m) => m.kind === "loaded")).toBe(true);
  });

  it("keeps SEPARATE sessions for the same model on different ladders", async () => {
    // Two Depth nodes, same weights, different Backend parameters. A cache keyed by model
    // alone would hand the second node the first node's session and its picker would be a
    // control that silently does nothing.
    const asked: string[] = [];
    const instance = createWorkerCore({
      createSession: async (_weights, provider) => {
        asked.push(provider);
        return fakeSession(new Float32Array(4));
      },
      createTensor: () => ({}),
      post: () => undefined,
    });
    await instance.handle({
      kind: "load", sessionKey: "m@wasm", weights: new ArrayBuffer(4), providers: ["wasm"],
    });
    await instance.handle({
      kind: "load", sessionKey: "m@webgpu", weights: new ArrayBuffer(4), providers: ["webgpu"],
    });
    expect(asked).toEqual(["wasm", "webgpu"]);
  });

  it("reports a model that throws as an error message, not a dead thread", async () => {
    const posted: InferenceResponse[] = [];
    const instance = createWorkerCore({
      createSession: async () => ({
        inputNames: ["x"], outputNames: ["y"],
        run: async () => { throw new Error("kernel refused"); },
      }),
      createTensor: () => ({}),
      post: (response) => posted.push(response),
    });
    await instance.handle({ kind: "load", sessionKey: "m@wasm", weights: new ArrayBuffer(4), providers: ["wasm"] });
    await instance.handle({
      kind: "run", requestId: 3, sessionKey: "m@wasm", nodeType: "depth",
      texels: new ArrayBuffer(64), width: 2, height: 2, side: 2, sourceWidth: 2, sourceHeight: 2,
    });
    expect(posted.at(-1)).toEqual({ kind: "error", requestId: 3, message: "kernel refused" });
  });
});

/**
 * §T747's ONE-FRAME GUARANTEE, RE-VERIFIED ACROSS THE THREAD BOUNDARY (§V737, §V701).
 *
 * `settle` used to await a promise resolved on this thread. It now awaits a postMessage
 * round trip, and that is exactly the change that turns a passing async gate into one that
 * passes by luck: a fire-and-forget looks even more correct once there is a message
 * boundary to hide behind, because the work genuinely IS happening somewhere.
 *
 * So this drives the real seam over the real runner with only the worker faked, holds the
 * window open with a TIMER rather than a microtask, and asserts the two operations were
 * genuinely OUTSTANDING TOGETHER — the run dispatched, and settle not yet resolved.
 */
describe("the export's per-frame wait survives the worker boundary", () => {
  it("does not resolve settle until the WORKER has answered that frame", async () => {
    const fake = fakeWorker();
    const runner = createWorkerRunner({
      worker: fake.worker,
      describe: () => target,
      weightsFor: async () => new ArrayBuffer(8),
    });
    const sources = createInferenceSources({
      readBuffer: async () => new ArrayBuffer(2 * 2 * 16),
      run: (nodeId, input) => runner.run(nodeId, input),
    });
    sources.track([
      {
        nodeId: "n1",
        inputResourceId: "r",
        sourceId: "infer:n1",
        fallback: new Uint8Array([128, 128, 128, 255]),
      },
    ]);

    let settled = false;
    const waiting = sources.settle(0).then(() => {
      settled = true;
    });

    // A REAL window, not a microtask — every microtask the chain could hide behind has
    // drained by the time a timer fires.
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.deliver({ kind: "loaded", sessionKey: sessionKeyFor("m", PROVIDERS), backend: "wasm", millis: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Genuinely outstanding together: the run is dispatched and settle has not resolved.
    expect(fake.sent.some((m) => m.kind === "run")).toBe(true);
    expect(settled).toBe(false);

    fake.deliver({ kind: "result", requestId: 1, bytes: new Uint8Array([9, 9, 9, 255]).buffer, backend: "wasm", millis: 1 });
    await waiting;

    expect(settled).toBe(true);
    // And the frame carries the WORKER's bytes, not the identity fallback.
    expect([...(sources.currentFrame("n1")?.bytes ?? [])]).toEqual([9, 9, 9, 255]);
    expect(sources.resultAges(0)).toEqual([{ nodeId: "n1", ageFrames: 0 }]);
  });

  it("does not hang a take when the worker dies mid-frame", async () => {
    // A take blocked on a dead thread would never finish and would say nothing about why.
    const fake = fakeWorker();
    const runner = createWorkerRunner({
      worker: fake.worker,
      describe: () => target,
      weightsFor: async () => new ArrayBuffer(8),
    });
    const sources = createInferenceSources({
      readBuffer: async () => new ArrayBuffer(2 * 2 * 16),
      run: (nodeId, input) => runner.run(nodeId, input),
    });
    sources.track([
      { nodeId: "n1", inputResourceId: "r", sourceId: "infer:n1", fallback: new Uint8Array([1, 2, 3, 4]) },
    ]);

    const waiting = sources.settle(0);
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.deliver({ kind: "loaded", sessionKey: sessionKeyFor("m", PROVIDERS), backend: "wasm", millis: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    fake.crash();

    // Resolves rather than rejecting — §V144: a failed run keeps the previous value, and
    // the take proceeds with the identity rather than dying.
    await waiting;
    expect([...(sources.currentFrame("n1")?.bytes ?? [])]).toEqual([1, 2, 3, 4]);
  });
});
