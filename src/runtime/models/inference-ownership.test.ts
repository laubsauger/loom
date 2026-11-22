import { describe, expect, it, vi } from "vitest";
import { createWorkerCore, MODEL_PLANS, type InferenceSessionLike } from "./inference-worker-core.ts";
import type { InferenceResponse, WorkerLike } from "./inference-protocol.ts";
import { createWorkerRunner } from "./worker-runner.ts";
import { DEPTH_ACCURATE, MATTE_RVM } from "./model-catalogue.ts";

/** Exercise the real runner/protocol/core together without model weights or a GPU. */
function harness(modelId: string, smoothing: number, session: InferenceSessionLike) {
  let deliver: ((event: { data: InferenceResponse }) => void) | undefined;
  const transferredResults: ArrayBuffer[] = [];
  const createSession = vi.fn(async () => session);
  const core = createWorkerCore({
    isolated: true,
    createSession,
    createTensor: (type, data, dims) => ({ type, data, dims }),
    post: (data, transfer) => {
      if (!deliver) throw new Error("Worker listener not installed");
      if (data.kind === "result") transferredResults.push(data.bytes);
      deliver({ data: structuredClone(data, transfer === undefined ? {} : { transfer }) });
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
  return { createSession, runner, target, transferredResults,
    run: (nodeId: string) => runner.run(nodeId, new ArrayBuffer(target.side ** 2 * 16)) };
}

describe("temporal inference state belongs to a node, not shared model weights", () => {
  it("retires deleted history but preserves an unused surviving node and shared weights", async () => {
    const fed: number[] = [];
    let frame = 0;
    const test = harness(MATTE_RVM.id, 1, {
      inputNames: ["src"], outputNames: ["pha", "r1o", "r2o", "r3o", "r4o"],
      run: async feeds => {
        fed.push((feeds.r1i as { data: Float32Array }).data[0]!);
        const state = { data: new Float32Array([++frame]) };
        return { pha: { data: new Float32Array(4) }, r1o: state, r2o: state, r3o: state, r4o: state };
      },
    });
    try {
      await test.run("a");
      await test.run("b");
      test.runner.retainNodes(["b"]);
      // b is still in the graph, although it did not run during this reconciliation.
      await test.run("b");
      await test.run("a"); // newly created node with a previously used opaque ID
      expect(fed).toEqual([0, 0, 2, 0]);
      expect(test.createSession).toHaveBeenCalledTimes(1);
    } finally { test.runner.dispose(); }
  });

  it("does not resurrect deleted history when an old inference completes after recreation", async () => {
    let completeOld!: (outputs: Awaited<ReturnType<InferenceSessionLike["run"]>>) => void;
    let started!: () => void;
    const running = new Promise<void>(resolve => { started = resolve; });
    const feedsSeen: number[] = [];
    let calls = 0;
    const outputs = (value: number) => {
      const state = { data: new Float32Array([value]) };
      return { pha: { data: new Float32Array(4) }, r1o: state, r2o: state, r3o: state, r4o: state };
    };
    const test = harness(MATTE_RVM.id, 1, {
      inputNames: ["src"], outputNames: ["pha", "r1o", "r2o", "r3o", "r4o"],
      run: async feeds => {
        feedsSeen.push((feeds.r1i as { data: Float32Array }).data[0]!);
        if (++calls === 1) {
          started();
          return new Promise(resolve => { completeOld = resolve; });
        }
        return outputs(calls);
      },
    });
    try {
      const old = test.run("a");
      const rejected = old.then(() => "unexpected success", error => String(error));
      await running;
      test.runner.retainNodes([]);
      expect(await rejected).toContain("retired");
      await test.run("a");
      completeOld(outputs(99));
      await Promise.resolve();
      await Promise.resolve();
      await test.run("a");
      expect(feedsSeen).toEqual([0, 0, 2]);
      expect(test.createSession).toHaveBeenCalledTimes(1);
    } finally { test.runner.dispose(); }
  });

  it("retires smoothing history as well as recurrence", async () => {
    let frame = 0;
    const test = harness("modnet-photographic", 0.5, {
      inputNames: ["input"], outputNames: ["output"],
      run: async () => ({ output: { data: new Float32Array(4).fill(frame++) } }),
    });
    try {
      await test.run("a");
      test.runner.retainNodes([]);
      const result = await test.run("a");
      expect([...new Float32Array(result.buffer)]).toEqual([1, 1, 1, 1]);
    } finally { test.runner.dispose(); }
  });

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

describe("inference results own transferable storage", () => {
  it("packs TopFormer with ImageNet RGB normalization and refuses non-native input sizes", () => {
    const plan = MODEL_PLANS["topformer-ade20k"]!;
    const texels = new Float32Array([0, 0.5, 1, 1]);
    expect(plan.tensorType).toBe("float32");
    expect(plan.pack(texels, 1)).toEqual(new Float32Array([
      (0 - 0.485) / 0.229, (0.5 - 0.456) / 0.224, (1 - 0.406) / 0.225,
    ]));
    expect(plan.dims(512)).toEqual([1, 3, 512, 512]);
    for (const side of [2, 256, 1024]) expect(() => plan.dims(side)).toThrow(/TopFormer requires a 512-square input/);
  });

  it("sums ADE20K architecture confidence while excluding sky, window and door probabilities", () => {
    const plan = MODEL_PLANS["topformer-ade20k"]!;
    const logits = new Float32Array(150 * 4).fill(-1000);
    // Fractional confidence proves the decoder sums softmax probabilities rather
    // than taking an argmax. Include all five retained architecture classes.
    logits[0 * 4] = Math.log(2);
    logits[1 * 4] = Math.log(3);
    logits[2 * 4] = Math.log(5);
    logits[25 * 4 + 1] = Math.log(2);
    logits[42 * 4 + 1] = Math.log(3);
    logits[8 * 4 + 1] = Math.log(5);
    logits[148 * 4 + 2] = Math.log(3);
    logits[14 * 4 + 2] = Math.log(7);
    logits[2 * 4 + 3] = Math.log(2);
    logits[8 * 4 + 3] = Math.log(3);
    logits[14 * 4 + 3] = Math.log(5);
    const before = logits.slice();
    const probabilities = plan.decodeOutput!(logits);
    expect([...probabilities]).toEqual([0.5, 0.5, new Float32Array([0.3])[0], 0]);
    expect(probabilities.buffer).not.toBe(logits.buffer);
    expect(logits).toEqual(before);
  });

  it("keeps stable native TopFormer confidence and transfers no model-owned storage", async () => {
    const storage = new Float32Array(150 * 4 + 2).fill(-1000);
    const output = storage.subarray(1, 150 * 4 + 1);
    // Extreme finite logits must never overflow exp or turn the mask into NaNs.
    for (const [pixel, label] of [0, 148, 2, 14].entries()) output[label * 4 + pixel] = 1000;
    const before = storage.slice();
    const feedsSeen: number[][] = [];
    const test = harness("topformer-ade20k", 1, {
      inputNames: ["input"], outputNames: ["output"],
      run: async feeds => {
        feedsSeen.push([...(feeds.input as { dims: readonly number[] }).dims]);
        return { output: { data: output, dims: [1, 150, 2, 2] } };
      },
    });
    test.target.side = 512;
    try {
      const captured = await test.runner.runRaw("mask1", new Float32Array(512 ** 2 * 4).buffer);
      const encoded = new Float32Array(captured.bytes.buffer, captured.bytes.byteOffset, captured.bytes.byteLength / 4);
      expect([...encoded]).toEqual([1, 1, 0, 0]);
      expect(captured.raw.values).toEqual(encoded);
      expect([captured.raw.width, captured.raw.height]).toEqual([2, 2]);
      expect(encoded.buffer.byteLength).toBe(16);
      expect(captured.raw.values.buffer.byteLength).toBe(16);
      expect(encoded.buffer).not.toBe(captured.raw.values.buffer);
      expect(encoded.buffer).not.toBe(output.buffer);
      expect(captured.raw.values.buffer).not.toBe(output.buffer);
      const next = await test.run("mask1");
      expect(new Float32Array(next.buffer)).toEqual(encoded);
      expect(feedsSeen).toEqual([[1, 3, 512, 512], [1, 3, 512, 512]]);
      expect(test.createSession).toHaveBeenCalledTimes(1);
      expect(test.transferredResults.every(buffer => buffer.byteLength === 0)).toBe(true);
      captured.raw.values.fill(0);
      expect(new Float32Array(next.buffer)).toEqual(encoded);
      expect(storage).toEqual(before);
    } finally { test.runner.dispose(); }
  });

  it.each([0, 149, 151])("rejects an invalid TopFormer logit plane length (%s)", length => {
    expect(() => MODEL_PLANS["topformer-ade20k"]!.decodeOutput!(new Float32Array(length)))
      .toThrow(/TopFormer requires 150 non-empty ADE20K logit planes/);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects non-finite TopFormer logits (%s) before publishing a mask", async value => {
    const output = new Float32Array(150 * 4);
    output[149 * 4 + 1] = value;
    const test = harness("topformer-ade20k", 1, {
      inputNames: ["input"], outputNames: ["output"],
      run: async () => ({ output: { data: output, dims: [1, 150, 2, 2] } }),
    });
    test.target.side = 512;
    try {
      await expect(test.runner.runRaw("mask1", new Float32Array(512 ** 2 * 4).buffer))
        .rejects.toThrow(/TopFormer returned a non-finite logit at sample 597/);
      expect(test.transferredResults).toHaveLength(0);
      expect(output.byteLength).toBe(150 * 4 * 4);
      expect(output[149 * 4 + 1]).toBe(value);
    } finally { test.runner.dispose(); }
  });

  it("rejects a mismatched TopFormer worker input before executing the model", async () => {
    const run = vi.fn(async () => ({ output: { data: new Float32Array(150 * 4), dims: [1, 150, 2, 2] } }));
    const test = harness("topformer-ade20k", 1, {
      inputNames: ["input"], outputNames: ["output"], run,
    });
    try {
      await expect(test.run("mask1")).rejects.toThrow(/TopFormer requires a 512-square input; received 2/);
      expect(run).not.toHaveBeenCalled();
      expect(test.transferredResults).toHaveLength(0);
    } finally { test.runner.dispose(); }
  });

  it("packs BiRefNet input with ImageNet RGB normalization and dynamic dimensions", () => {
    const plan = MODEL_PLANS["birefnet-lite-dynamic"]!;
    const packed = plan.pack(new Float32Array([
      0, 0.5, 1, 0.25, 1, 0.25, 0, 1,
      0.5, 1, 0.25, 0, 0.25, 0, 0.5, 0.5,
    ]), 2);
    expect(plan.tensorType).toBe("float32");
    expect(packed).toBeInstanceOf(Float32Array);
    expect(packed).toEqual(new Float32Array([
      (0 - 0.485) / 0.229, (1 - 0.485) / 0.229, (0.5 - 0.485) / 0.229, (0.25 - 0.485) / 0.229,
      (0.5 - 0.456) / 0.224, (0.25 - 0.456) / 0.224, (1 - 0.456) / 0.224, (0 - 0.456) / 0.224,
      (1 - 0.406) / 0.225, (0 - 0.406) / 0.225, (0.25 - 0.406) / 0.225, (0.5 - 0.406) / 0.225,
    ]));
    for (const side of [1024, 1536]) expect(plan.dims(side)).toEqual([1, 3, side, side]);
  });

  it("decodes BiRefNet logits once for encoded and native float32 masks without modifying the model tensor", async () => {
    const storage = new Float32Array([42, -Math.log(9), 0, Math.log(9), -100, 100, 1, 43]);
    const output = storage.subarray(1, 7);
    const before = storage.slice();
    const feedsSeen: number[][] = [];
    const test = harness("birefnet-lite-dynamic", 1, {
      inputNames: ["input_image"], outputNames: ["output_image"],
      run: async feeds => {
        feedsSeen.push([...(feeds.input_image as { dims: readonly number[] }).dims]);
        return { output_image: { data: output, dims: [1, 1, 2, 3] } };
      },
    });
    try {
      const captured = await test.runner.runRaw("mask1", new Float32Array(16).buffer);
      const encoded = new Float32Array(captured.bytes.buffer, captured.bytes.byteOffset, captured.bytes.byteLength / 4);
      expect(encoded[0]).toBeCloseTo(0.1, 7);
      expect(encoded[1]).toBe(0.5);
      expect(encoded[2]).toBeCloseTo(0.9, 7);
      expect(encoded[3]).toBe(new Float32Array([1 / (1 + Math.exp(100))])[0]);
      expect(encoded[4]).toBe(1);
      expect(encoded[5]).toBeCloseTo(1 / (1 + Math.exp(-1)), 7);
      expect(captured.raw.values).toEqual(encoded);
      expect([captured.raw.width, captured.raw.height]).toEqual([3, 2]);
      expect(encoded.buffer.byteLength).toBe(6 * 4);
      expect(captured.raw.values.buffer.byteLength).toBe(6 * 4);
      expect(encoded.buffer).not.toBe(captured.raw.values.buffer);
      expect(encoded.buffer).not.toBe(output.buffer);
      expect(captured.raw.values.buffer).not.toBe(output.buffer);
      expect(storage).toEqual(before);
      // Reusing the same native tensor must not apply sigmoid to previous probabilities.
      test.target.side = 4;
      const next = await test.run("mask1");
      expect(new Float32Array(next.buffer)).toEqual(encoded);
      expect(feedsSeen).toEqual([[1, 3, 2, 2], [1, 3, 4, 4]]);
      expect(test.createSession).toHaveBeenCalledTimes(1);
      expect(test.transferredResults.every(buffer => buffer.byteLength === 0)).toBe(true);
      captured.raw.values.fill(0);
      expect(new Float32Array(next.buffer)).toEqual(encoded);
      expect(storage).toEqual(before);
    } finally { test.runner.dispose(); }
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("rejects non-finite BiRefNet logits (%s) before publishing a mask", async value => {
    const output = new Float32Array([0, value, 0, 0]);
    const test = harness("birefnet-lite-dynamic", 1, {
      inputNames: ["input_image"], outputNames: ["output_image"],
      run: async () => ({ output_image: { data: output, dims: [1, 1, 2, 2] } }),
    });
    try {
      await expect(test.runner.runRaw("mask1", new Float32Array(16).buffer)).rejects.toThrow(/BiRefNet returned a non-finite logit at sample 1/);
      expect(test.transferredResults).toHaveLength(0);
      expect(output.byteLength).toBe(16);
      expect(output[1]).toBe(value);
    } finally { test.runner.dispose(); }
  });

  it("preserves native ORMBG probabilities without applying BiRefNet decoding", async () => {
    const output = new Float32Array([0.1, 0.5, 0.9, 1]);
    const test = harness("ormbg-quantized", 1, {
      inputNames: ["input"], outputNames: ["alphas"],
      run: async () => ({ alphas: { data: output, dims: [1, 1, 2, 2] } }),
    });
    try {
      const captured = await test.runner.runRaw("mask1", new Float32Array(16).buffer);
      expect(captured.raw.values).toEqual(output);
      expect(new Float32Array(captured.bytes.buffer)).toEqual(output);
      expect(output.byteLength).toBe(16);
    } finally { test.runner.dispose(); }
  });

  it("transfers independent native float32 depth without detaching the model tensor", async () => {
    const output = new Float32Array([-3.125, -17.5, 40, 99.75]);
    const transfers: Transferable[][] = [];
    const results: Extract<InferenceResponse, { kind: "result" }>[] = [];
    let deliver: ((event: { data: InferenceResponse }) => void) | undefined;
    const core = createWorkerCore({
      isolated: true,
      createSession: async () => ({ inputNames: ["pixel_values"], outputNames: ["predicted_depth"],
        run: async () => ({ predicted_depth: { data: output, dims: [1, 2, 2] } }) }),
      createTensor: () => ({}),
      post: (data, transfer) => {
        if (deliver === undefined) throw new Error("Worker listener not installed");
        if (data.kind === "result") { results.push(data); transfers.push(transfer ?? []); }
        deliver({ data: structuredClone(data, transfer === undefined ? {} : { transfer }) });
      },
    });
    const runner = createWorkerRunner({
      worker: { postMessage: request => { void core.handle(request); },
        addEventListener: (type: string, listener: unknown) => { if (type === "message") deliver = listener as typeof deliver; },
        terminate: () => undefined },
      describe: () => ({ modelId: DEPTH_ACCURATE.id, nodeType: "depth", width: 4, height: 2,
        side: 2, sourceWidth: 4, sourceHeight: 2, providers: ["wasm"], ratio: 0, smoothing: 1 }),
      weightsFor: async () => new ArrayBuffer(4),
    });
    try {
      const captured = await runner.runRaw("depth1", new Float32Array(16).buffer);
      expect([...captured.raw.values]).toEqual([-3.125, -17.5, 40, 99.75]);
      expect([captured.raw.width, captured.raw.height]).toEqual([2, 2]);
      expect(output.byteLength).toBe(16);
      expect([...output]).toEqual([...captured.raw.values]);
      expect(results[0]!.raw!.bytes.byteLength).toBe(0);
      expect(results[0]!.bytes.byteLength).toBe(0);
      expect(transfers[0]).toEqual([results[0]!.bytes, results[0]!.raw!.bytes]);
      // A later ordinary run reuses that same model-owned tensor and sends no raw copy.
      const ordinary = await runner.run("depth1", new Float32Array(16).buffer);
      expect(ordinary.byteLength).toBe(4 * 2 * 4);
      expect(results[1]!.raw).toBeUndefined();
      expect(transfers[1]).toEqual([results[1]!.bytes]);
      expect(output.byteLength).toBe(16);
      captured.raw.values.fill(0);
      expect([...output]).toEqual([-3.125, -17.5, 40, 99.75]);
    } finally { runner.dispose(); }
  });

  it("rejects an aliased encoder before smoothing changes model output or retained history", async () => {
    const model = "modnet-photographic";
    const encode = vi.spyOn(MODEL_PLANS[model]!, "encode");
    const outputs = [new Float32Array(4), new Float32Array(4).fill(1), new Float32Array(4).fill(1)];
    let frame = 0;
    const test = harness(model, 0.5, {
      inputNames: ["input"], outputNames: ["output"],
      run: async () => ({ output: { data: outputs[frame++]! } }),
    });
    try {
      await test.run("a");
      encode.mockImplementationOnce(output => new Uint8Array(output.buffer));
      await expect(test.run("a")).rejects.toThrow(/must return an owned exact ArrayBuffer/);
      expect([...outputs[1]!]).toEqual([1, 1, 1, 1]);
      const next = await test.run("a");
      expect([...new Float32Array(next.buffer)]).toEqual([0.5, 0.5, 0.5, 0.5]);
      expect(test.transferredResults).toHaveLength(2);
    } finally {
      test.runner.dispose();
      encode.mockRestore();
    }
  });

  it("transfers the encoder's buffer directly while retaining independent smoothing history", async () => {
    const encode = vi.spyOn(MODEL_PLANS["modnet-photographic"]!, "encode");
    let frame = 0;
    const test = harness("modnet-photographic", 0.5, {
      inputNames: ["input"], outputNames: ["output"],
      run: async () => ({ output: { data: new Float32Array(4).fill(frame++ % 2) } }),
    });
    try {
      const first = await test.run("a");
      const second = await test.run("a");
      const third = await test.run("a");
      expect([...new Float32Array(first.buffer)]).toEqual([0, 0, 0, 0]);
      expect([...new Float32Array(second.buffer)]).toEqual([0.5, 0.5, 0.5, 0.5]);
      expect([...new Float32Array(third.buffer)]).toEqual([0.25, 0.25, 0.25, 0.25]);
      for (let i = 0; i < 3; i += 1) {
        const encoded = encode.mock.results[i]!.value as Uint8Array;
        expect(test.transferredResults[i]).toBe(encoded.buffer);
        expect(encoded.byteLength).toBe(0);
      }
    } finally {
      test.runner.dispose();
      encode.mockRestore();
    }
  });

  it.each(["offset", "aliased"])("refuses an encoder's %s result instead of detaching unrelated storage", async (kind) => {
    const output = new Float32Array(4).fill(0.5);
    const bytes = kind === "offset" ? new Uint8Array(new ArrayBuffer(20), 4, 16) : new Uint8Array(output.buffer);
    const encode = vi.spyOn(MODEL_PLANS["modnet-photographic"]!, "encode").mockReturnValue(bytes);
    const test = harness("modnet-photographic", 1, {
      inputNames: ["input"], outputNames: ["output"],
      run: async () => ({ output: { data: output } }),
    });
    try {
      await expect(test.run("a")).rejects.toThrow(/must return an owned exact ArrayBuffer/);
      expect(output.byteLength).toBe(16);
      expect(test.transferredResults).toHaveLength(0);
    } finally {
      test.runner.dispose();
      encode.mockRestore();
    }
  });

  it.each(Object.entries(MODEL_PLANS))("%s encodes a fresh exact buffer without retaining or detaching model output", (_modelId, plan) => {
    // T1816b: Depth Pro 2's encoder refuses any length but its own static box, by design.
    const box = plan.picture === "depth_meters" ? plan.dims(0) : undefined;
    const length = box === undefined ? 51 : box[2]! * box[3]!;
    const output = Float32Array.from({ length }, (_, i) => (i % 4) / 3);
    const before = output.slice();
    const first = plan.encode(output, 2, 2, 2, 2, 2);
    const second = plan.encode(output, 2, 2, 2, 2, 2);
    expect(first.byteOffset).toBe(0);
    expect(first.byteLength).toBe(first.buffer.byteLength);
    expect(first.buffer).toBeInstanceOf(ArrayBuffer);
    expect(first.buffer).not.toBe(output.buffer);
    expect(first.buffer).not.toBe(second.buffer);
    const received = structuredClone(first, { transfer: [first.buffer] });
    expect(first.byteLength).toBe(0);
    expect(received).toEqual(second);
    expect(output).toEqual(before);
    output.fill(0);
    expect(received).toEqual(second);
  });
});
