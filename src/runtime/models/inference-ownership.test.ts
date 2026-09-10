import { describe, expect, it, vi } from "vitest";
import { createWorkerCore, type InferenceSessionLike } from "./inference-worker-core.ts";
import type { InferenceResponse, WorkerLike } from "./inference-protocol.ts";
import { createWorkerRunner } from "./worker-runner.ts";
import { MATTE_RVM } from "./model-catalogue.ts";

/** Exercise the real runner/protocol/core together without model weights or a GPU. */
function harness(modelId: string, smoothing: number, session: InferenceSessionLike) {
  let deliver: ((event: { data: InferenceResponse }) => void) | undefined;
  const createSession = vi.fn(async () => session);
  const core = createWorkerCore({
    isolated: true,
    createSession,
    createTensor: (type, data, dims) => ({ type, data, dims }),
    post: (data) => {
      if (!deliver) throw new Error("Worker listener not installed");
      deliver({ data });
    },
  });
  const worker: WorkerLike = {
    postMessage: (request) => { void core.handle(request); },
    addEventListener: (type: string, listener: unknown) => {
      if (type === "message") deliver = listener as typeof deliver;
    },
    terminate: () => undefined,
  };
  const target = { modelId, nodeType: "matte" as const, width: 2, height: 2,
    side: 2, sourceWidth: 2, sourceHeight: 2, providers: ["wasm"], ratio: 0.5, smoothing };
  const runner = createWorkerRunner({
    worker,
    describe: () => target,
    weightsFor: async () => new ArrayBuffer(4),
  });
  return { createSession, runner, target,
    run: (nodeId: string) => runner.run(nodeId, new ArrayBuffer(target.side ** 2 * 16)) };
}

describe("temporal inference state belongs to a node, not shared model weights", () => {
  it("restarts recurrence when the same node changes input size without changing ratio", async () => {
    const fed: number[] = [];
    let frame = 0;
    const test = harness(MATTE_RVM.id, 1, {
      inputNames: ["src", "r1i", "r2i", "r3i", "r4i", "downsample_ratio"],
      outputNames: ["pha", "r1o", "r2o", "r3o", "r4o"],
      run: async (feeds) => {
        const side = (feeds.src as { dims: number[] }).dims[2]!;
        fed.push((feeds.r1i as { data: Float32Array }).data[0]!);
        const state = { data: new Float32Array([++frame]) };
        return { pha: { data: new Float32Array(side ** 2).fill(0.5) },
          r1o: state, r2o: state, r3o: state, r4o: state };
      },
    });
    try {
      await test.run("node-a");
      test.target.side = 4;
      await test.run("node-a");
      await test.run("node-a");
      expect(fed).toEqual([0, 0, 2]);
      expect(test.createSession).toHaveBeenCalledTimes(1);
    } finally { test.runner.dispose(); }
  });

  it("shares one RVM session without feeding another node's recurrent tensors", async () => {
    const fed: number[] = [];
    let frame = 0;
    const test = harness(MATTE_RVM.id, 1, {
      inputNames: ["src", "r1i", "r2i", "r3i", "r4i", "downsample_ratio"],
      outputNames: ["pha", "r1o", "r2o", "r3o", "r4o"],
      run: async (feeds) => {
        fed.push((feeds.r1i as { data: Float32Array }).data[0]!);
        const state = { data: new Float32Array([++frame]) };
        return { pha: { data: new Float32Array(4).fill(0.5) },
          r1o: state, r2o: state, r3o: state, r4o: state };
      },
    });
    try {
      for (const nodeId of ["node-a", "node-b", "node-a", "node-b"]) await test.run(nodeId);
      expect(test.createSession).toHaveBeenCalledTimes(1);
      expect(fed).toEqual([0, 0, 1, 2]);
    } finally { test.runner.dispose(); }
  });

  it("does not blend a new node's MODNet matte with another node's previous image", async () => {
    let frame = 0;
    const test = harness("modnet-photographic", 0.5, {
      inputNames: ["input"], outputNames: ["output"],
      run: async () => ({ output: { data: new Float32Array(4).fill(frame++ % 2) } }),
    });
    try {
      await test.run("node-a");
      const second = await test.run("node-b");
      expect(test.createSession).toHaveBeenCalledTimes(1);
      expect([...new Float32Array(second.buffer, second.byteOffset, second.byteLength / 4)])
        .toEqual([1, 1, 1, 1]);
      const third = await test.run("node-a");
      expect([...new Float32Array(third.buffer, third.byteOffset, third.byteLength / 4)])
        .toEqual([0, 0, 0, 0]);
    } finally { test.runner.dispose(); }
  });
});
