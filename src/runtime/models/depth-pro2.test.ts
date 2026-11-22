import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  DEPTH_PRO2_BOX,
  DEPTH_PRO2_BOXES,
  depthPro2FocalPixels,
  depthPro2ToInverse,
  noDepthPro2Result,
  occOf,
  packDepthPro2Input,
} from "./depth-runner.ts";
import { createWorkerCore, MODEL_PLANS, type InferenceSessionLike } from "./inference-worker-core.ts";
import type { InferenceRequest, InferenceResponse } from "./inference-protocol.ts";
import { signatureFor } from "./model-signatures.ts";

/**
 * T1816b — Depth Pro 2 through the inference worker.
 *
 * Each case pins a way this model goes wrong while still producing a plausible picture:
 * a focal length that ignores the letterbox scales every metre; a first frame fed RVM's
 * [1,1,1,1] zeros is refused by a static graph; a cache that is not handed back by name
 * turns the streaming build into a single-frame one with no error at all; a cache left on
 * the device after use leaks ~30 MB a frame until the GPU runs out.
 */

const { width: BOX_W, height: BOX_H } = DEPTH_PRO2_BOX;
const BOX_TEXELS = BOX_W * BOX_H;

describe("the 640×480 box, both directions", () => {
  it("is the box the recorded signature declares", () => {
    for (const id of ["depthpro2-s-stream4-fp32", "depthpro2-s-stream4-fp16", "depthpro2-s-fp32", "depthpro2-b-fp16"]) {
      expect(signatureFor(id)!.input.shape.slice(-2).map(Number)).toEqual([BOX_H, BOX_W]);
    }
  });

  it("letterboxes by the box's own aspect: wider fills x, taller fills y, square-box rule unchanged", () => {
    expect(occOf(1920, 1080, 4 / 3)).toEqual([1, (4 / 3) / (16 / 9)]);
    expect(occOf(480, 640, 4 / 3)).toEqual([0.75 / (4 / 3), 1]);
    expect(occOf(640, 480, 4 / 3)).toEqual([1, 1]);
    // boxAspect 1 is the T974 expression exactly, so the square nodes did not move.
    expect(occOf(1920, 1080)).toEqual([1, 1080 / 1920]);
    expect(occOf(1080, 1920)).toEqual([1080 / 1920, 1]);
  });

  it("packs raw sRGB-encoded [0,1] planar RGB — the graph normalises, the reference reads display bytes", () => {
    const texels = new Float32Array(BOX_TEXELS * 4);
    texels.set([0.5, 0, 1, 1], 0); // first texel, linear
    texels.set([2, -1, 0.0031308, 1], 4); // out of range clamps; the OETF's knee
    const packed = packDepthPro2Input(texels);
    expect(packed.length).toBe(3 * BOX_TEXELS);
    // sRGB OETF of linear 0.5 — what a camera file holds for that light.
    expect(packed[0]).toBeCloseTo(1.055 * Math.pow(0.5, 1 / 2.4) - 0.055, 6);
    expect([packed[BOX_TEXELS], packed[2 * BOX_TEXELS]]).toEqual([0, 1]);
    expect([packed[1], packed[BOX_TEXELS + 1]]).toEqual([1, 0]);
    expect(packed[2 * BOX_TEXELS + 1]).toBeCloseTo(12.92 * 0.0031308, 6);
  });

  it("refuses a buffer that is not the box, rather than reading a square into it", () => {
    expect(() => packDepthPro2Input(new Float32Array(518 * 518 * 4))).toThrow(/640×480/);
  });

  it("reads back ONLY the occupied band, as inverse metres, with the sky at 0", () => {
    // A 16:9 picture occupies a 640×360 band; the 60-row bars above and below hold 1 m of
    // replicated edge that must never reach the output.
    const metres = new Float32Array(BOX_TEXELS).fill(1);
    for (let y = 60; y < 420; y += 1) {
      for (let x = 0; x < BOX_W; x += 1) metres[y * BOX_W + x] = x < BOX_W / 2 ? 2 : Number.POSITIVE_INFINITY;
    }
    const floats = new Float32Array(depthPro2ToInverse(metres, 16, 9).buffer);
    for (let y = 0; y < 9; y += 1) {
      expect(Array.from(floats.subarray(y * 16, y * 16 + 8))).toEqual(new Array(8).fill(0.5));
      expect(Array.from(floats.subarray(y * 16 + 8, y * 16 + 16))).toEqual(new Array(8).fill(0));
    }
  });

  it("publishes no distance for a NaN or non-positive sample", () => {
    const metres = new Float32Array(BOX_TEXELS).fill(Number.NaN);
    metres.fill(-3, 0, BOX_TEXELS / 2);
    expect(new Float32Array(depthPro2ToInverse(metres, 4, 3).buffer).every((v) => v === 0)).toBe(true);
  });

  it("marks no-result as -1, an inverse distance the encoder never produces", () => {
    expect(Array.from(new Float32Array(noDepthPro2Result(3, 2).buffer))).toEqual(new Array(6).fill(-1));
  });
});

describe("f_px from a horizontal field of view", () => {
  it("is (picture width in box pixels / 2) / tan(fov / 2)", () => {
    // Landscape: the picture spans the whole 640.
    expect(depthPro2FocalPixels(90, 1280, 720)).toBeCloseTo(320, 9);
    // Portrait 3:4 fills the height, so it is 360 box pixels wide — and metres would be
    // 1.78x too far if the letterbox were ignored here.
    expect(depthPro2FocalPixels(90, 480, 640)).toBeCloseTo(180, 9);
    expect(depthPro2FocalPixels(60, 640, 480)).toBeCloseTo(320 / Math.tan(Math.PI / 6), 9);
  });
});

/** A fake ORT tensor that can say where it lives and whether it was released. */
interface FakeTensor {
  readonly type: string;
  readonly data?: unknown;
  readonly dims?: readonly number[];
  readonly location?: string;
  dispose?: () => void;
  readonly tag?: string;
}

const STREAM = "depthpro2-s-stream4-fp16";
const CACHE_INPUTS = signatureFor(STREAM)!.inputs.filter((name) => name.startsWith("past_"));

function streamCore() {
  const posted: InferenceResponse[] = [];
  const feedsSeen: Record<string, unknown>[] = [];
  const released: string[] = [];
  let frame = 0;
  const session: InferenceSessionLike = {
    inputNames: signatureFor(STREAM)!.inputs,
    outputNames: signatureFor(STREAM)!.outputs,
    // The real artefact declares fp16 caches; a few shapes are enough to prove they are read.
    inputMetadata: signatureFor(STREAM)!.inputs.map((name) => ({
      name,
      type: name.startsWith("past_") ? "float16" : "float32",
      shape: name === "past_filled" ? [4] : name.startsWith("past_prefixes") ? [4, 5, 384] : name.startsWith("past_") ? [1, 6, 4800, 64] : [1],
    })),
    run: async (feeds) => {
      feedsSeen.push(feeds);
      frame += 1;
      const outputs: Record<string, { data: Float32Array; dims?: readonly number[] }> = {
        depth_meters: { data: new Float32Array(BOX_TEXELS).fill(2), dims: [1, BOX_H, BOX_W] },
      };
      for (const name of CACHE_INPUTS) {
        const present = `present_${name.slice("past_".length)}`;
        const tensor: FakeTensor & { data: Float32Array } = {
          type: "float16", data: new Float32Array(0), location: "gpu-buffer", tag: `${present}@${frame}`,
        };
        tensor.dispose = () => released.push(tensor.tag!);
        outputs[present] = tensor;
      }
      return outputs;
    },
  };
  const createSession = vi.fn<(weights: ArrayBuffer, provider: string, placement?: { gpuOutputs: readonly string[] }) => Promise<InferenceSessionLike>>(
    async () => session,
  );
  const core = createWorkerCore({
    isolated: true,
    createSession,
    createTensor: (type, data, dims) => ({ type, data, dims }),
    post: (response) => { posted.push(response); },
  });
  let requestId = 0;
  const run = async (nodeId: string, overrides: Partial<Extract<InferenceRequest, { kind: "run" }>> = {}) => {
    await core.handle({
      kind: "run", requestId: ++requestId, sessionKey: `${STREAM}@webgpu`, nodeId, nodeType: "depth",
      texels: new Float32Array(BOX_TEXELS * 4).buffer, width: 8, height: 6, side: BOX_W,
      sourceWidth: 1280, sourceHeight: 720, modelId: STREAM, ratio: 0, smoothing: 1, fieldOfView: 90,
      ...overrides,
    });
  };
  const load = (provider: string) =>
    core.handle({ kind: "load", sessionKey: `${STREAM}@webgpu`, modelId: STREAM, weights: new ArrayBuffer(4), providers: [provider] });
  return { posted, feedsSeen, released, createSession, run, load, core };
}

describe("the streaming build's cache", () => {
  it("asks WebGPU to keep every present_* on the device — and asks nothing of the CPU provider", async () => {
    const gpu = streamCore();
    await gpu.load("webgpu");
    expect(gpu.createSession.mock.calls[0]![2]?.gpuOutputs.slice().sort()).toEqual(
      CACHE_INPUTS.map((name) => `present_${name.slice(5)}`).sort(),
    );
    const cpu = streamCore();
    await cpu.load("wasm");
    expect(cpu.createSession.mock.calls[0]![2]).toBeUndefined();
  });

  it("feeds the first frame zeros in the type and shape the artefact declares, plus f_px", async () => {
    const test = streamCore();
    await test.load("webgpu");
    await test.run("depth1");
    const first = test.feedsSeen[0]! as Record<string, FakeTensor>;
    expect(first["past_filled"]).toMatchObject({ type: "float16", dims: [4] });
    expect((first["past_filled"]!.data as Uint16Array)).toEqual(new Uint16Array(4));
    expect(first["past_keys_5"]).toMatchObject({ type: "float16", dims: [1, 6, 4800, 64] });
    expect((first["past_keys_5"]!.data as Uint16Array).length).toBe(6 * 4800 * 64);
    // 1280×720 fills the box's width; 90° → 320 px.
    expect(Array.from(first["f_px"]!.data as Float32Array)).toEqual([320]);
    expect(test.posted.at(-1)?.kind).toBe("result");
  });

  it("hands each present_* back as next frame's past_*, by name, and releases the spent one", async () => {
    const test = streamCore();
    await test.load("webgpu");
    await test.run("depth1");
    expect(test.released).toEqual([]);
    await test.run("depth1");
    const second = test.feedsSeen[1]! as Record<string, FakeTensor>;
    for (const name of CACHE_INPUTS) {
      expect(second[name]?.tag).toBe(`present_${name.slice(5)}@1`);
    }
    // Frame 1's cache went in to frame 2 and is now spent: released, all thirteen.
    expect(test.released.slice().sort()).toEqual(CACHE_INPUTS.map((name) => `present_${name.slice(5)}@1`).sort());
  });

  it("keeps one node's cache out of another's", async () => {
    const test = streamCore();
    await test.load("webgpu");
    await test.run("depth1");
    await test.run("depth2");
    const other = test.feedsSeen[1]! as Record<string, FakeTensor>;
    expect(other["past_keys_5"]?.tag).toBeUndefined();
    expect((other["past_keys_5"]!.data as Uint16Array).length).toBe(6 * 4800 * 64);
  });

  it("releases a deleted node's held cache", async () => {
    const test = streamCore();
    await test.load("webgpu");
    await test.run("depth1");
    await test.core.handle({ kind: "forget", nodeIds: ["depth1"] });
    expect(test.released).toHaveLength(CACHE_INPUTS.length);
  });

  it("publishes inverse metres at the node's size, from the box's band", async () => {
    const test = streamCore();
    await test.load("webgpu");
    await test.run("depth1");
    const result = test.posted.at(-1) as Extract<InferenceResponse, { kind: "result" }>;
    expect(Array.from(new Float32Array(result.bytes))).toEqual(new Array(8 * 6).fill(0.5));
  });
});

describe("the 16:9 box", () => {
  const WIDE = DEPTH_PRO2_BOXES["672x384"];

  it("is the box each 16:9 file declares, under the same names as its 4:3 build", () => {
    for (const id of ["depthpro2-s-stream4-fp32", "depthpro2-s-stream4-fp16", "depthpro2-s-fp32", "depthpro2-b-fp16"]) {
      const wide = signatureFor(`${id}-672x384`)!;
      expect(wide.input.shape.slice(-2).map(Number)).toEqual([WIDE.height, WIDE.width]);
      expect([wide.inputs, wide.outputs]).toEqual([signatureFor(id)!.inputs, signatureFor(id)!.outputs]);
    }
  });

  it("packs, focuses and reads back in 672×384 — a 16:9 picture nearly fills it", () => {
    const plan = MODEL_PLANS["depthpro2-s-stream4-fp32-672x384"]!;
    expect(plan.dims(0)).toEqual([1, 3, 384, 672]);
    expect(() => plan.pack(new Float32Array(640 * 480 * 4), 0)).toThrow(/672×384/);
    expect(plan.pack(new Float32Array(672 * 384 * 4), 0).length).toBe(3 * 672 * 384);
    // 1920×1080 is wider than 672×384 (1.778 > 1.75): it spans all 672 columns.
    expect(plan.focal!.pixels(90, 1920, 1080)).toBeCloseTo(336, 9);
    expect(occOf(1920, 1080, 672 / 384)).toEqual([1, (672 / 384) / (1920 / 1080)]);
    // The same picture in the 4:3 box leaves a quarter of it as bars.
    expect(occOf(1920, 1080, 4 / 3)[1]).toBeCloseTo(0.75, 9);
    const metres = new Float32Array(672 * 384).fill(4);
    expect(Array.from(new Float32Array(plan.encode(metres, 4, 2, 0, 4, 2).buffer))).toEqual(new Array(8).fill(0.25));
  });
});

describe("the FP32 stream", () => {
  it("is the same cache loop under the same names — only the cache type differs", () => {
    expect(MODEL_PLANS["depthpro2-s-stream4-fp32"]?.feedback).toEqual(MODEL_PLANS[STREAM]?.feedback);
    expect(signatureFor("depthpro2-s-stream4-fp32")!.inputs).toEqual(signatureFor(STREAM)!.inputs);
    expect(signatureFor("depthpro2-s-stream4-fp32")!.outputs).toEqual(signatureFor(STREAM)!.outputs);
  });

  it("gets float32 zeros where the file declares float32", async () => {
    const id = "depthpro2-s-stream4-fp32";
    const fed: Record<string, { type: string; data: unknown; dims: readonly number[] }>[] = [];
    const core = createWorkerCore({
      isolated: true,
      createSession: async () => ({
        inputNames: signatureFor(id)!.inputs,
        outputNames: signatureFor(id)!.outputs,
        inputMetadata: signatureFor(id)!.inputs.map((name) => ({
          name, type: "float32",
          shape: name === "past_filled" ? [4] : name.startsWith("past_prefixes") ? [4, 5, 384] : name.startsWith("past_") ? [1, 6, 4800, 64] : [1],
        })),
        run: async (feeds) => {
          fed.push(feeds as never);
          const outputs: Record<string, { data: Float32Array }> = { depth_meters: { data: new Float32Array(BOX_TEXELS).fill(1) } };
          for (const name of signatureFor(id)!.outputs.slice(1)) outputs[name] = { data: new Float32Array(1) };
          return outputs;
        },
      }),
      createTensor: (type, data, dims) => ({ type, data, dims }),
      post: () => undefined,
    });
    await core.handle({ kind: "load", sessionKey: "k", modelId: id, weights: new ArrayBuffer(4), providers: ["wasm"] });
    await core.handle({
      kind: "run", requestId: 1, sessionKey: "k", nodeId: "depth1", nodeType: "depth",
      texels: new Float32Array(BOX_TEXELS * 4).buffer, width: 4, height: 3, side: BOX_W,
      sourceWidth: 640, sourceHeight: 480, modelId: id, ratio: 0, smoothing: 1, fieldOfView: 60,
    });
    expect(fed).toHaveLength(1);
    const keys = fed[0]!["past_keys_5"]!;
    expect(keys.type).toBe("float32");
    expect(keys.dims).toEqual([1, 6, 4800, 64]);
    expect(keys.data).toBeInstanceOf(Float32Array);
    expect((keys.data as Float32Array).length).toBe(6 * 4800 * 64);
    expect((fed[0]!["past_filled"]!.data as Float32Array)).toEqual(new Float32Array(4));
  });
});

describe("single-frame builds", () => {
  it("take f_px and no cache", () => {
    for (const id of ["depthpro2-s-fp32", "depthpro2-b-fp16"]) {
      expect(MODEL_PLANS[id]?.focal?.input).toBe("f_px");
      expect(MODEL_PLANS[id]?.feedback).toBeUndefined();
      expect(signatureFor(id)!.inputs).toEqual(["pixel_values", "f_px"]);
    }
  });
});

/**
 * The real artefact, where it is (the same `SHADERLOOM_MODEL_DIR` convention as the
 * signature re-read): one frame of the S FP32 build through the worker core on ORT-web's
 * CPU provider, ~0.7 s. A gradient that brightens downward is a floor receding upward, so
 * the top of the band must read further than the bottom.
 */
const MODEL_DIR = process.env["SHADERLOOM_MODEL_DIR"];
const S_FP32 = MODEL_DIR === undefined ? undefined : join(MODEL_DIR, "depthpro2-s-fp32.onnx");

describe.skipIf(S_FP32 === undefined || !existsSync(S_FP32))("the real S FP32 artefact through the worker core", () => {
  it("returns finite inverse metres, nearer at the bottom of a receding floor", async () => {
    const ort = (await import("onnxruntime-web")).default;
    ort.env.logLevel = "error";
    const posted: InferenceResponse[] = [];
    const core = createWorkerCore({
      isolated: false,
      createSession: async (weights, provider) =>
        (await ort.InferenceSession.create(new Uint8Array(weights), { executionProviders: [provider as "wasm"] })) as never,
      createTensor: (type, data, dims) => new ort.Tensor(type as never, data as never, dims as number[]),
      post: (response) => { posted.push(response); },
    });
    const weights = readFileSync(S_FP32!);
    await core.handle({
      kind: "load", sessionKey: "s@wasm", modelId: "depthpro2-s-fp32",
      weights: weights.buffer.slice(weights.byteOffset, weights.byteOffset + weights.byteLength), providers: ["wasm"],
    });
    const texels = new Float32Array(BOX_TEXELS * 4);
    for (let y = 0; y < BOX_H; y += 1) {
      for (let x = 0; x < BOX_W; x += 1) texels.fill(0.05 + 0.6 * (y / BOX_H) ** 2, (y * BOX_W + x) * 4, (y * BOX_W + x) * 4 + 3);
    }
    await core.handle({
      kind: "run", requestId: 1, sessionKey: "s@wasm", nodeId: "depth1", nodeType: "depth",
      texels: texels.buffer, width: 64, height: 48, side: BOX_W, sourceWidth: 640, sourceHeight: 480,
      modelId: "depthpro2-s-fp32", ratio: 0, smoothing: 1, fieldOfView: 60,
    });
    const result = posted.at(-1);
    expect(result?.kind, JSON.stringify(result)).toBe("result");
    const inverse = new Float32Array((result as Extract<InferenceResponse, { kind: "result" }>).bytes);
    expect(inverse.length).toBe(64 * 48);
    expect(inverse.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
    const rowMean = (y: number) => inverse.subarray(y * 64, y * 64 + 64).reduce((a, b) => a + b, 0) / 64;
    expect(rowMean(46)).toBeGreaterThan(rowMean(1));
  }, 120_000);
});
