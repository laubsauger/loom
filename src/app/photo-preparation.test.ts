// @vitest-environment jsdom
import { createHash, webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEPTH_ACCURATE, DEPTH_PRO2_B, DEPTH_PRO2_S, DEPTH_PRO2_WIDE, PHOTO_DEPTH_MODELS, PHOTO_DEPTH_LARGE_FP16, PHOTO_DEPTH_LARGE_Q4F16, PHOTO_FACADE, PHOTO_MASK } from "@runtime/models/model-catalogue.ts";
import type { WorkerRunner, WorkerRunnerOptions } from "@runtime/models/worker-runner.ts";
import type { createModelAcquisition } from "@runtime/models/model-acquisition.ts";
import { decodeDepthExr } from "@runtime/media/depth-exr.ts";
import { encodePreparedMap } from "@runtime/media/prepared-map-file.ts";
import { FACADE_MASK_DEFAULTS, facadeMaskSettings } from "@runtime/media/facade-mask.ts";
import { depthRecipeOf, preparedMetadata, rasterizeFloatMap } from "@runtime/media/prepared-map.ts";
import { DEFAULT_DEPTH_PRO2_RECIPE, DEFAULT_DEPTH_REFINEMENT, DEFAULT_MARIGOLD_RECIPE, DEFAULT_PHOTO_DEPTH_RECIPE, MARIGOLD_BUNDLE_ID, type PhotoDepthRecipe } from "@domain/media/photo-depth-recipe.ts";
import { decodeSrgb } from "@runtime/models/depth-runner.ts";
import type { NativePreparationCapability, NativePreparationRequest } from "@devices/native-preparation.ts";
import { createFileReference, parseFileReference } from "@domain/media/file-reference.ts";
import { createPhotoPreparer, decodePreparationPhoto, savePreparedMap, type PreparationPhoto } from "./photo-preparation.ts";
import { PHOTO_DEPTH_PRO2_FILES } from "@runtime/models/photo-depth-models.ts";

const mocks = vi.hoisted(() => ({ acquisition: vi.fn(), acquire: vi.fn(), cancel: vi.fn(), cache: vi.fn(), runner: vi.fn(), remember: vi.fn(), refine: vi.fn() }));
vi.mock("@runtime/backend/photo-depth-refinement.ts", () => ({ refineBrowserPhotoDepth: mocks.refine }));
vi.mock("@runtime/models/cache-model-store.ts", () => ({ cacheModelStore: mocks.cache }));
vi.mock("@runtime/models/model-acquisition.ts", async importOriginal => ({
  ...await importOriginal<typeof import("@runtime/models/model-acquisition.ts")>(), createModelAcquisition: mocks.acquisition,
}));
vi.mock("@runtime/models/worker-runner.ts", () => ({ createWorkerRunner: mocks.runner }));
vi.mock("@ui/files/retained-files.ts", () => ({ retainedFiles: () => ({ remember: mocks.remember }) }));

function photograph(): PreparationPhoto {
  return { bitmap: { width: 4, height: 2, close: vi.fn() } as unknown as ImageBitmap, sha256: "a".repeat(64), name: "sculpture.png" };
}

function depthRequest(inputSide = 266, photo = photograph(), recipe: Partial<Extract<PhotoDepthRecipe, { version: 1 }>> = {}) {
  return { kind: "depth" as const, photo, recipe: { ...DEFAULT_PHOTO_DEPTH_RECIPE, inputSide, ...recipe } };
}

function rawResult() {
  const values = new Float32Array(16);
  for (let index = 0; index < values.length; index++) values[index] = index - 3.125;
  values[5] = 1 + 2 ** -23;
  values[6] = -0;
  return { bytes: new Uint8Array([255]), raw: { width: 4, height: 4, values } };
}

function runnerWith(result = rawResult()) {
  let options!: WorkerRunnerOptions;
  const runner = {
    run: vi.fn(),
    runRaw: vi.fn(async (nodeId: string, bytes: ArrayBuffer) => {
      const target = options.describe(nodeId);
      if (target === undefined) throw new Error("Missing preparation target");
      expect(bytes.byteLength).toBe(target.width * target.height * 16);
      await options.weightsFor(target.modelId);
      return result;
    }),
    retainNodes: vi.fn(), dispose: vi.fn(),
  };
  mocks.runner.mockImplementation((received: WorkerRunnerOptions) => { options = received; return runner satisfies WorkerRunner; });
  return { runner, options: () => options };
}

function nativeBridge() {
  let request!: NativePreparationRequest;
  const valuesFor = () => {
    const values = new Float32Array(request.width * request.height).fill(0.25);
    values[5] = 1 + 2 ** -23;
    values[6] = -0;
    values[7] = -0.125;
    return values;
  };
  const resultFor = () => ({ width: request.width, height: request.height,
    values: valuesFor().buffer, semantics: "relative-log" as const });
  const bridge = {
    probe: vi.fn<() => Promise<NativePreparationCapability>>(async () => ({ available: true, cached: false,
      bundleId: MARIGOLD_BUNDLE_ID, bytes: 15_326_640_856, backend: "mlx", inputSides: [512, 768, 1024] })),
    start: vi.fn(async (value: NativePreparationRequest) => { request = value; return "native-job"; }),
    status: vi.fn<(_id: string) => Promise<unknown>>(async () => ({ kind: "complete", result: resultFor() })),
    cancel: vi.fn<(_id: string) => Promise<void>>(async () => {}),
    close: vi.fn<(_id: string) => Promise<void>>(async () => {}),
  };
  (window as Window & { loomDesktop?: unknown }).loomDesktop = { preparation: bridge };
  return { bridge, valuesFor, resultFor };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(complete => { resolve = complete; });
  return { promise, resolve };
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal("Worker", class { terminate() {} });
  mocks.cache.mockReturnValue({});
  mocks.acquire.mockResolvedValue(new ArrayBuffer(8));
  mocks.acquisition.mockReturnValue({ acquire: mocks.acquire, cancel: mocks.cancel });
  mocks.remember.mockResolvedValue(createFileReference("saved-map", "binary", "depth.loom.exr"));
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
    drawImage: vi.fn(),
    getImageData: (_x: number, _y: number, width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4).fill(128) }),
  })) as unknown as typeof HTMLCanvasElement.prototype.getContext);
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllGlobals();
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
  delete (window as Window & { loomDesktop?: unknown }).loomDesktop;
});

describe("photo preparation sessions", () => {
  it("runs Marigold through the real renderer bridge with rectangular RGBA and preserved native float32 log-depth", async () => {
    const native = nativeBridge();
    const worker = vi.fn(function () { throw new Error("Native preparation must not create a browser worker"); });
    vi.stubGlobal("Worker", worker);
    const progress = vi.fn();
    const preparer = createPhotoPreparer(progress);
    expect(native.bridge.probe).not.toHaveBeenCalled();
    expect(native.bridge.start).not.toHaveBeenCalled();
    const photo = photograph();
    const map = await preparer.run({ kind: "depth", photo, recipe: DEFAULT_MARIGOLD_RECIPE });
    expect(native.bridge.probe).toHaveBeenCalledTimes(1);
    expect(native.bridge.start).toHaveBeenCalledWith({ modelId: DEFAULT_MARIGOLD_RECIPE.modelId,
      inputSide: 512, seed: 2025, width: 512, height: 256, rgba: expect.any(ArrayBuffer) });
    const request = native.bridge.start.mock.calls[0]![0];
    expect(new Uint8Array(request.rgba)).toEqual(new Uint8Array(512 * 256 * 4).fill(128));
    expect([map.width, map.height]).toEqual([512, 256]);
    expect(new Uint32Array(map.values.buffer)).toEqual(new Uint32Array(native.valuesFor().buffer));
    expect(Object.is(map.values[6], -0)).toBe(true);
    expect(preparedMetadata(map)).toMatchObject({ version: 2, kind: "depth", stage: "native", parent: null,
      registration: "stretch", semantics: "relative-log", inputSide: 512,
      source: { sha256: photo.sha256, width: 4, height: 2 },
      model: { id: DEFAULT_MARIGOLD_RECIPE.modelId, url: `loom:model-bundle/${MARIGOLD_BUNDLE_ID}` },
      recipe: DEFAULT_MARIGOLD_RECIPE });
    expect(depthRecipeOf(map)).toEqual(DEFAULT_MARIGOLD_RECIPE);
    const reopened = decodeDepthExr(encodePreparedMap(map));
    expect(new Uint32Array(reopened.values.buffer)).toEqual(new Uint32Array(map.values.buffer));
    expect(preparedMetadata(reopened)).toEqual(preparedMetadata(map));
    expect(native.bridge.close).toHaveBeenCalledWith("native-job");
    expect(native.bridge.cancel).not.toHaveBeenCalled();
    expect(worker).not.toHaveBeenCalled();
    expect(mocks.runner).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(progress).toHaveBeenLastCalledWith({ phase: "finishing", message: "Marigold finished · native log-depth float32 preserved" });
    preparer.dispose();
  });

  it("permits native preparation without a browser model cache and explicitly refuses browser inference", async () => {
    mocks.cache.mockReturnValue(null);
    const { bridge } = nativeBridge();
    const preparer = createPhotoPreparer(() => {});
    expect(mocks.acquisition).not.toHaveBeenCalled();
    const map = await preparer.run({ kind: "depth", photo: photograph(), recipe: DEFAULT_MARIGOLD_RECIPE });
    expect(preparedMetadata(map)).toMatchObject({ semantics: "relative-log", registration: "stretch" });
    await expect(preparer.run(depthRequest())).rejects.toThrow("Browser model caching is unavailable");
    expect(bridge.start).toHaveBeenCalledTimes(1);
    expect(mocks.runner).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    preparer.dispose();
  });

  it("reports the native capability refusal before starting a job or acquiring browser weights", async () => {
    const { bridge } = nativeBridge();
    bridge.probe.mockResolvedValue({ available: false, reason: "Install the trusted Marigold worker first." });
    const preparer = createPhotoPreparer(() => {});
    await expect(preparer.run({ kind: "depth", photo: photograph(), recipe: DEFAULT_MARIGOLD_RECIPE }))
      .rejects.toThrow("Install the trusted Marigold worker first.");
    expect(bridge.start).not.toHaveBeenCalled();
    expect(bridge.status).not.toHaveBeenCalled();
    expect(bridge.cancel).not.toHaveBeenCalled();
    expect(bridge.close).not.toHaveBeenCalled();
    expect(mocks.runner).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    preparer.dispose();
  });

  it("waits for native retirement after cancellation and discards a late complete result before allowing retry", async () => {
    const native = nativeBridge(), status = deferred<unknown>(), retired = deferred<void>();
    native.bridge.status.mockReturnValueOnce(status.promise);
    native.bridge.cancel.mockReturnValueOnce(retired.promise);
    const progress = vi.fn();
    const preparer = createPhotoPreparer(progress);
    const request = { kind: "depth" as const, photo: photograph(), recipe: DEFAULT_MARIGOLD_RECIPE };
    const pending = preparer.run(request);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await vi.waitFor(() => expect(native.bridge.status).toHaveBeenCalledWith("native-job"));
    preparer.cancel();
    await vi.waitFor(() => expect(native.bridge.cancel).toHaveBeenCalledWith("native-job"));
    expect(native.bridge.close).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    await expect(preparer.run(request)).rejects.toThrow("already running");
    status.resolve({ kind: "complete", result: native.resultFor() });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(progress).not.toHaveBeenCalled();
    retired.resolve();
    await rejected;
    expect(native.bridge.close).toHaveBeenCalledWith("native-job");
    expect(progress).not.toHaveBeenCalled();
    expect(mocks.runner).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    const map = await preparer.run(request);
    expect(preparedMetadata(map)).toMatchObject({ stage: "native", semantics: "relative-log" });
    expect(native.bridge.start).toHaveBeenCalledTimes(2);
    expect(native.bridge.close).toHaveBeenCalledTimes(2);
    preparer.dispose();
  });

  it("acquires no weights before explicit run, preserving native raw depth precision", async () => {
    const fake = runnerWith();
    const progress = vi.fn();
    const preparer = createPhotoPreparer(progress);
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(progress).not.toHaveBeenCalled();
    expect(mocks.runner).not.toHaveBeenCalled();
    const map = await preparer.run(depthRequest());
    expect(mocks.acquire).toHaveBeenCalledWith(DEPTH_ACCURATE);
    expect([map.width, map.height]).toEqual([4, 4]);
    expect(new Uint32Array(map.values.buffer)).toEqual(new Uint32Array(rawResult().raw.values.buffer));
    expect(preparedMetadata(map)).toMatchObject({ version: 2, kind: "depth", inputSide: 266, registration: "letterbox", model: { id: DEPTH_ACCURATE.id },
      recipe: depthRequest().recipe, stage: "native", parent: null, semantics: "inverse-relative" });
    const nodeId = fake.runner.runRaw.mock.calls[0]![0];
    expect(fake.options().describe(nodeId)).toBeUndefined();
    expect(fake.runner.retainNodes).toHaveBeenCalledWith([]);
    expect(fake.runner.dispose).toHaveBeenCalledTimes(1);
    expect(fake.runner.run).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith({ phase: "preparing", message: "Preparing depth input…" });
    preparer.dispose();
  });

  it.each([100, undefined, 0])("reports actual download bytes with total %s and leaves inference indeterminate", async total => {
    const fake = runnerWith();
    const progress = vi.fn();
    const preparer = createPhotoPreparer(progress);
    const acquisition = mocks.acquisition.mock.calls[0]![0] as Parameters<typeof createModelAcquisition>[0];
    mocks.acquire.mockImplementationOnce(async () => {
      acquisition.onStateChange!(DEPTH_ACCURATE.id, { kind: "downloading", received: 50, total });
      return new ArrayBuffer(8);
    });
    const originalRun = fake.runner.runRaw.getMockImplementation()!;
    fake.runner.runRaw.mockImplementation(async (id, bytes) => {
      const result = await originalRun(id, bytes);
      fake.options().onMeasured!(id, { backend: "wasm", millis: 1500.4, isolated: false });
      return result;
    });
    await preparer.run(depthRequest());
    const updates = progress.mock.calls.map(([update]) => update);
    const download = updates.find(update => update.phase === "downloading");
    expect(download.message).toContain("50 B");
    if (total === 100) expect(download.fraction).toBe(0.5);
    else expect(download).not.toHaveProperty("fraction");
    expect(updates.slice(-2)).toEqual([
      { phase: "processing", message: "Running the model on your photo…" },
      { phase: "finishing", message: "wasm · 1500 ms · preparing float32 output" },
    ]);
    expect(updates.filter(update => update.phase !== "downloading").every(update => !("fraction" in update))).toBe(true);
    expect(progress).toHaveBeenLastCalledWith({ phase: "finishing", message: "wasm · 1500 ms · preparing float32 output" });
    preparer.dispose();
  });

  it("opens cached weights and resumes processing without inventing a percentage", async () => {
    runnerWith();
    const progress = vi.fn();
    const preparer = createPhotoPreparer(progress);
    await preparer.run(depthRequest());
    expect(progress.mock.calls.map(([update]) => update)).toEqual([
      { phase: "preparing", message: "Preparing depth input…" },
      { phase: "processing", message: "Processing depth · 266 × 266" },
      { phase: "preparing", message: "Opening the model cache…" },
      { phase: "processing", message: "Running the model on your photo…" },
    ]);
    preparer.dispose();
  });

  it.each([1036, 1288])("requests native depth detail at %i without changing output precision or dimensions", async side => {
    const result = rawResult();
    const fake = runnerWith(result);
    let requestedTarget: ReturnType<WorkerRunnerOptions["describe"]>;
    const originalRun = fake.runner.runRaw.getMockImplementation()!;
    fake.runner.runRaw.mockImplementation(async (id, bytes) => { requestedTarget = fake.options().describe(id); return originalRun(id, bytes); });
    const preparer = createPhotoPreparer(() => {});
    const map = await preparer.run(depthRequest(side));
    expect(requestedTarget).toMatchObject({ modelId: DEPTH_ACCURATE.id, nodeType: "depth", side, width: side, height: side, providers: ["wasm"], smoothing: 1 });
    expect(mocks.acquire).toHaveBeenCalledWith(DEPTH_ACCURATE);
    expect([map.width, map.height]).toEqual([result.raw.width, result.raw.height]);
    expect(new Uint32Array(map.values.buffer)).toEqual(new Uint32Array(result.raw.values.buffer));
    expect(preparedMetadata(map)).toMatchObject({ kind: "depth", inputSide: side, registration: "letterbox" });
    preparer.dispose();
  });

  it("uses explicitly chosen independent mask detail at 1024 with stretch registration", async () => {
    const fake = runnerWith({ bytes: new Uint8Array(), raw: { width: 2, height: 1, values: new Float32Array([0.1234567, 0.9876543]) } });
    let requestedTarget: ReturnType<WorkerRunnerOptions["describe"]>;
    const originalRun = fake.runner.runRaw.getMockImplementation()!;
    fake.runner.runRaw.mockImplementation(async (id, bytes) => { requestedTarget = fake.options().describe(id); return originalRun(id, bytes); });
    const preparer = createPhotoPreparer(() => {});
    const map = await preparer.run({ kind: "mask", photo: photograph(), inputSide: 1024 });
    expect(mocks.acquire).toHaveBeenCalledWith(PHOTO_MASK);
    expect(requestedTarget).toMatchObject({ modelId: PHOTO_MASK.id, nodeType: "matte", side: 1024, width: 1024, height: 1024, providers: ["wasm"], smoothing: 1 });
    expect(preparedMetadata(map)).toMatchObject({ kind: "mask", inputSide: 1024, registration: "stretch", range: { low: 0, high: 1 } });
    expect(map.values).toEqual(new Float32Array([0.1234567, 0.9876543]));
    preparer.dispose();
  });

  it("requests 1536 mask detail independently of depth detail and preserves native output", async () => {
    const values = new Float32Array([0.1234567, 0.9876543, 2 ** -24, 1 - 2 ** -24, -0, 0.5]);
    const fake = runnerWith({ bytes: new Uint8Array(), raw: { width: 3, height: 2, values } });
    let requestedTarget: ReturnType<WorkerRunnerOptions["describe"]>;
    const originalRun = fake.runner.runRaw.getMockImplementation()!;
    fake.runner.runRaw.mockImplementation(async (id, bytes) => { requestedTarget = fake.options().describe(id); return originalRun(id, bytes); });
    const preparer = createPhotoPreparer(() => {});
    const map = await preparer.run({ kind: "mask", photo: photograph(), inputSide: 1536 });
    expect(requestedTarget).toMatchObject({ modelId: PHOTO_MASK.id, nodeType: "matte", side: 1536, width: 1536, height: 1536, providers: ["wasm"], smoothing: 1 });
    expect(mocks.acquire).toHaveBeenCalledWith(PHOTO_MASK);
    expect([map.width, map.height]).toEqual([3, 2]);
    expect(new Uint32Array(map.values.buffer)).toEqual(new Uint32Array(values.buffer));
    expect(preparedMetadata(map)).toMatchObject({ kind: "mask", inputSide: 1536, registration: "stretch", range: { low: 0, high: 1 } });
    preparer.dispose();
  });

  it("refuses unsupported mask sizes before acquiring weights or invoking inference", async () => {
    const fake = runnerWith();
    const preparer = createPhotoPreparer(() => {});
    await expect(preparer.run({ kind: "mask", photo: photograph(), inputSide: 1288 })).rejects.toThrow("Unsupported mask input size");
    expect(fake.runner.runRaw).not.toHaveBeenCalled();
    expect(fake.runner.run).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    preparer.dispose();
  });

  it.each([1024, 1536])("refines the native facade envelope to %i while recording the fixed 512 model input", async detailSide => {
    const values = new Float32Array(64 * 64).fill(0.8123456);
    const fake = runnerWith({ bytes: new Uint8Array(), raw: { width: 64, height: 64, values } });
    let requestedTarget: ReturnType<WorkerRunnerOptions["describe"]>;
    const originalRun = fake.runner.runRaw.getMockImplementation()!;
    fake.runner.runRaw.mockImplementation(async (id, bytes) => { requestedTarget = fake.options().describe(id); return originalRun(id, bytes); });
    const preparer = createPhotoPreparer(() => {});
    const reference = photograph();
    const settings = { darkCutoff: 0.031, feather: 0.021, excludeBlueGlass: false };
    const map = await preparer.run({ kind: "mask", photo: reference, inputSide: detailSide, facade: settings });
    expect(mocks.acquire).toHaveBeenCalledWith(PHOTO_FACADE);
    expect(requestedTarget).toMatchObject({ modelId: PHOTO_FACADE.id, nodeType: "matte", side: 512,
      width: 512, height: 512, sourceWidth: 4, sourceHeight: 2, providers: ["wasm"], smoothing: 1 });
    expect([map.width, map.height, map.values.length]).toEqual([detailSide, detailSide, detailSide * detailSide]);
    expect(map.values).toBeInstanceOf(Float32Array);
    expect(map.values[0]).toBe(values[0]);
    expect(values).toEqual(new Float32Array(64 * 64).fill(0.8123456));
    expect(preparedMetadata(map)).toMatchObject({ kind: "mask", inputSide: 512, registration: "stretch",
      source: { sha256: reference.sha256, width: 4, height: 2 }, model: { id: "facade-surfaces-v1", url: PHOTO_FACADE.url } });
    const reopened = decodeDepthExr(encodePreparedMap(map));
    expect(facadeMaskSettings(reopened)).toEqual({ version: 1, detailSide,
      envelopeWidth: 64, envelopeHeight: 64, ...settings });
    expect(new Uint32Array(reopened.values.buffer)).toEqual(new Uint32Array(map.values.buffer));
    expect(preparedMetadata(reopened)).toEqual(preparedMetadata(map));
    preparer.dispose();
  });

  it("rejects a facade recipe used for depth before acquiring or running a model", async () => {
    const fake = runnerWith();
    const preparer = createPhotoPreparer(() => {});
    await expect(preparer.run({ ...depthRequest(), facade: FACADE_MASK_DEFAULTS } as Parameters<typeof preparer.run>[0])).rejects.toThrow("Facade settings apply only to masks");
    expect(fake.runner.runRaw).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    preparer.dispose();
  });

  it("rejects invalid facade refinement settings without publishing a substitute map", async () => {
    const fake = runnerWith({ bytes: new Uint8Array(), raw: { width: 64, height: 64, values: new Float32Array(64 * 64).fill(1) } });
    const preparer = createPhotoPreparer(() => {});
    await expect(preparer.run({ kind: "mask", photo: photograph(), inputSide: 1024, facade: { ...FACADE_MASK_DEFAULTS, darkCutoff: NaN } }))
      .rejects.toThrow("Invalid facade mask: darkCutoff");
    expect(fake.runner.retainNodes).toHaveBeenCalledWith([]);
    preparer.dispose();
  });

  it("refuses unsupported sizes before acquiring weights and unavailable caching", async () => {
    const fake = runnerWith();
    const preparer = createPhotoPreparer(() => {});
    await expect(preparer.run(depthRequest(500))).rejects.toThrow("Unsupported photo depth input size");
    expect(fake.runner.runRaw).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    preparer.dispose();
    mocks.cache.mockReturnValue(null);
    expect(() => createPhotoPreparer(() => {})).toThrow("Model caching is unavailable");
  });

  it("disposes workers and cancels acquisitions; late results cannot become usable maps", async () => {
    const fake = runnerWith();
    let finish!: (result: ReturnType<typeof rawResult>) => void;
    fake.runner.runRaw.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const preparer = createPhotoPreparer(() => {});
    const pending = preparer.run(depthRequest());
    const rejected = expect(pending).rejects.toThrow("Photo preparation was closed");
    preparer.dispose();
    finish(rawResult());
    await rejected;
    expect(fake.runner.dispose).toHaveBeenCalledTimes(1);
    // T1817b: Depth Pro 2's four photo files are acquisitions too, and a close cancels them.
    expect(mocks.cancel.mock.calls.map(call => call[0])).toEqual([...PHOTO_DEPTH_MODELS.map(model => model.id),
      ...PHOTO_DEPTH_PRO2_FILES.map(model => model.id), PHOTO_MASK.id, PHOTO_FACADE.id]);
    await expect(preparer.run(depthRequest())).rejects.toThrow("Photo preparation was closed");
  });

  it("reports inference failures without publishing a substitute map", async () => {
    const fake = runnerWith();
    fake.runner.runRaw.mockRejectedValue(new Error("model failed"));
    const preparer = createPhotoPreparer(() => {});
    await expect(preparer.run(depthRequest())).rejects.toThrow("model failed");
    expect(fake.runner.retainNodes).toHaveBeenCalledWith([]);
    preparer.dispose();
  });

  it.each([PHOTO_DEPTH_LARGE_Q4F16, PHOTO_DEPTH_LARGE_FP16])("runs selected $label using its pinned descriptor and explicit provider", async descriptor => {
    vi.stubGlobal("navigator", { gpu: {} });
    const fake = runnerWith();
    const preparer = createPhotoPreparer(() => {});
    let target: ReturnType<WorkerRunnerOptions["describe"]>;
    const run = fake.runner.runRaw.getMockImplementation()!;
    fake.runner.runRaw.mockImplementation(async (id, bytes) => { target = fake.options().describe(id); return run(id, bytes); });
    const request = depthRequest(518, photograph(), { modelId: descriptor.id, backend: "webgpu" });
    const result = await preparer.run(request);
    expect(mocks.acquire).toHaveBeenCalledWith(descriptor);
    expect(descriptor.url).toMatch(/\/resolve\/[a-f0-9]{40}\/onnx\/model_/);
    expect(descriptor.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(target).toMatchObject({ modelId: descriptor.id, side: 518, providers: ["webgpu"], smoothing: 1 });
    expect(depthRecipeOf(result)).toEqual(request.recipe);
    expect(preparedMetadata(result).model).toEqual({ id: descriptor.id, url: descriptor.url });
    expect(fake.runner.dispose).toHaveBeenCalledTimes(1);
    preparer.dispose();
  });

  it("refuses unvalidated Large CPU sizes or unavailable models before creating a worker or acquiring weights", async () => {
    runnerWith();
    const preparer = createPhotoPreparer(() => {});
    await expect(preparer.run(depthRequest(1036, photograph(), { modelId: PHOTO_DEPTH_LARGE_Q4F16.id }))).rejects.toThrow(/has not been validated/);
    await expect(preparer.run(depthRequest(518, photograph(), { modelId: "unknown-model" }))).rejects.toThrow(/not available for preparation/);
    expect(mocks.runner).not.toHaveBeenCalled(); expect(mocks.acquire).not.toHaveBeenCalled();
    preparer.dispose();
  });

  it("releases each inference session before the next explicitly chosen model runs", async () => {
    const fake = runnerWith();
    const preparer = createPhotoPreparer(() => {});
    const first = await preparer.run(depthRequest(518, photograph(), { modelId: PHOTO_DEPTH_LARGE_FP16.id }));
    expect(fake.runner.dispose).toHaveBeenCalledTimes(1);
    const second = await preparer.run(depthRequest());
    expect(mocks.runner).toHaveBeenCalledTimes(2); expect(fake.runner.dispose).toHaveBeenCalledTimes(2);
    expect(mocks.acquire.mock.calls.map(([descriptor]) => descriptor.id)).toEqual([PHOTO_DEPTH_LARGE_FP16.id, DEPTH_ACCURATE.id]);
    expect(preparedMetadata(first).model.id).toBe(PHOTO_DEPTH_LARGE_FP16.id);
    expect(preparedMetadata(second).model.id).toBe(DEPTH_ACCURATE.id);
    preparer.dispose();
    expect(fake.runner.dispose).toHaveBeenCalledTimes(2);
  });

  it("cancels one job, refuses its late result and permits a subsequent explicit run", async () => {
    const fake = runnerWith();
    let finish!: (result: ReturnType<typeof rawResult>) => void;
    fake.runner.runRaw.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const preparer = createPhotoPreparer(() => {});
    const pending = preparer.run(depthRequest());
    const canceled = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    preparer.cancel();
    await expect(preparer.run(depthRequest())).rejects.toThrow(/already running/);
    finish(rawResult()); await canceled;
    expect(fake.runner.dispose).toHaveBeenCalledTimes(1);
    const next = await preparer.run(depthRequest());
    expect(preparedMetadata(next)).toMatchObject({ stage: "native" });
    expect(fake.runner.dispose).toHaveBeenCalledTimes(2);
    preparer.dispose();
  });

  it("refines a registered working copy without reinference, records native parent identity and saves the complete recipe", async () => {
    const fake = runnerWith();
    const progress = vi.fn();
    const preparer = createPhotoPreparer(progress);
    const reference = photograph();
    const request = depthRequest(266, reference);
    const native = await preparer.run(request);
    const originalBits = new Uint32Array(native.values.buffer).slice();
    const nativeBytes = encodePreparedMap(native);
    const expectedParent = { sha256: createHash("sha256").update(nativeBytes).digest("hex"), width: native.width, height: native.height };
    const recipe = { ...request.recipe, refinement: { ...DEFAULT_DEPTH_REFINEMENT } };
    mocks.refine.mockImplementationOnce(async (input, guide, target, settings, options) => {
      expect(input).toEqual({ width: 4, height: 2, values: rasterizeFloatMap(native, "depth", 4, 2) });
      expect(input.values).not.toBe(native.values);
      expect(guide).toEqual({ width: 4, height: 2, rgba: new Uint8Array(32).fill(128) });
      expect(target).toEqual({ width: 4, height: 2 }); expect(settings).toEqual(recipe.refinement);
      expect(options.signal.aborted).toBe(false);
      options.onStage(1, 1, 4, 2);
      return Float32Array.from({ length: 8 }, (_, index) => index / 7);
    });
    const refined = await preparer.refine(reference, native, recipe, 16384);
    expect(fake.runner.runRaw).toHaveBeenCalledTimes(1); expect(mocks.acquire).toHaveBeenCalledTimes(1);
    expect(new Uint32Array(native.values.buffer)).toEqual(originalBits);
    expect(encodePreparedMap(native)).toEqual(nativeBytes);
    expect(preparedMetadata(refined)).toMatchObject({ version: 2, stage: "refined", parent: expectedParent,
      recipe, registration: "stretch", semantics: "inverse-relative", source: preparedMetadata(native).source });
    expect(progress).toHaveBeenCalledWith({ phase: "processing", message: "Guided depth refinement · pass 1 of 1 · 4 × 2" });
    let written!: Uint8Array;
    const writable = { write: vi.fn(async (bytes: Uint8Array) => { written = bytes.slice(); }), close: vi.fn(), abort: vi.fn() };
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = vi.fn(async () => ({ name: "refined.loom.exr", createWritable: async () => writable }));
    await savePreparedMap(refined, "refined");
    const reopened = decodeDepthExr(written);
    expect(depthRecipeOf(reopened)).toEqual(recipe); expect(preparedMetadata(reopened)).toMatchObject({ parent: expectedParent });
    expect(new Uint32Array(reopened.values.buffer)).toEqual(new Uint32Array(refined.values.buffer));
    preparer.dispose();
  });

  it("retains the verified saved file's exact identity for refinement instead of hashing re-encoded metadata", async () => {
    runnerWith();
    const preparer = createPhotoPreparer(() => {}), reference = photograph(), request = depthRequest(266, reference);
    const native = await preparer.run(request), recipe = { ...request.recipe, refinement: { ...DEFAULT_DEPTH_REFINEMENT } };
    const canonical = encodePreparedMap(native), originalView = new DataView(canonical.buffer);
    // A different EXR exporter may add an ordinary informational header attribute.
    // It changes the file identity without changing depth samples or Loom provenance.
    let headerEnd = 8;
    while (canonical[headerEnd] !== 0) {
      headerEnd = canonical.indexOf(0, headerEnd) + 1;
      headerEnd = canonical.indexOf(0, headerEnd) + 1;
      const length = originalView.getInt32(headerEnd, true);
      headerEnd += 4 + length;
    }
    const names = new TextEncoder().encode("externalSoftware\0string\0"), value = new TextEncoder().encode("Independent depth exporter");
    const extra = new Uint8Array(names.length + 4 + value.length);
    extra.set(names); new DataView(extra.buffer).setInt32(names.length, value.length, true); extra.set(value, names.length + 4);
    const savedBytes = new Uint8Array(canonical.length + extra.length), savedView = new DataView(savedBytes.buffer);
    savedBytes.set(canonical.subarray(0, headerEnd)); savedBytes.set(extra, headerEnd); savedBytes.set(canonical.subarray(headerEnd), headerEnd + extra.length);
    const table = headerEnd + 1;
    for (let row = 0; row < native.height; row++) {
      savedView.setBigUint64(table + extra.length + row * 8, originalView.getBigUint64(table + row * 8, true) + BigInt(extra.length), true);
    }
    const savedNative = decodeDepthExr(savedBytes);
    const digest = createHash("sha256").update(savedBytes).digest("hex");
    expect(digest).not.toBe(createHash("sha256").update(encodePreparedMap(savedNative)).digest("hex"));
    mocks.refine.mockResolvedValueOnce(new Float32Array(8).fill(0.5));
    const refined = await preparer.refine(reference, savedNative, recipe, 16384, digest);
    expect(preparedMetadata(refined)).toMatchObject({ parent: { sha256: digest, width: 4, height: 4 } });
    expect(new Uint32Array(savedNative.values.buffer)).toEqual(new Uint32Array(native.values.buffer));
    const reopened = decodeDepthExr(encodePreparedMap(refined));
    expect(preparedMetadata(reopened)).toMatchObject({ parent: { sha256: digest } });
    preparer.dispose();
  });

  it("refuses malformed saved native identities before GPU refinement without changing the native prediction", async () => {
    runnerWith();
    const preparer = createPhotoPreparer(() => {}), reference = photograph(), request = depthRequest(266, reference);
    const native = await preparer.run(request), original = encodePreparedMap(native);
    const recipe = { ...request.recipe, refinement: { ...DEFAULT_DEPTH_REFINEMENT } };
    for (const digest of ["", "unknown", "a".repeat(63), "A".repeat(64)]) {
      await expect(preparer.refine(reference, native, recipe, 16384, digest)).rejects.toThrow(/lowercase SHA-256/);
    }
    expect(mocks.refine).not.toHaveBeenCalled();
    expect(encodePreparedMap(native)).toEqual(original);
    preparer.dispose();
  });

  it("refines a tiny reference to a genuine 2K float32 asset that validates, saves and reopens", async () => {
    const fake = runnerWith(), preparer = createPhotoPreparer(() => {}), reference = photograph();
    const nativeRequest = depthRequest(266, reference), native = await preparer.run(nativeRequest), original = encodePreparedMap(native);
    const recipe = { ...nativeRequest.recipe, refinement: { ...DEFAULT_DEPTH_REFINEMENT, target: "2048" as const } };
    const refinedValues = new Float32Array(2048 * 1024).fill(0.5);
    refinedValues[0] = -0; refinedValues[1] = 0.5 + 2 ** -24; refinedValues[2] = 2 ** -149; refinedValues[refinedValues.length - 1] = 1;
    mocks.refine.mockImplementationOnce(async (input, guide, target) => {
      expect([input.width, input.height]).toEqual([4, 2]);
      expect([guide.width, guide.height, guide.rgba.byteLength]).toEqual([2048, 1024, 2048 * 1024 * 4]);
      expect(target).toEqual({ width: 2048, height: 1024 });
      return refinedValues;
    });
    const refined = await preparer.refine(reference, native, recipe, 4096);
    expect([refined.width, refined.height]).toEqual([2048, 1024]);
    expect(preparedMetadata(refined)).toMatchObject({ stage: "refined", recipe, source: { width: 4, height: 2 },
      registration: "stretch", parent: { width: 4, height: 4 } });
    let written!: Uint8Array;
    const writable = { write: vi.fn(async (bytes: Uint8Array) => { written = bytes.slice(); }), close: vi.fn(), abort: vi.fn() };
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = vi.fn(async () => ({ name: "upscaled.loom.exr", createWritable: async () => writable }));
    await savePreparedMap(refined, "upscaled");
    const reopened = decodeDepthExr(written);
    expect([reopened.width, reopened.height]).toEqual([2048, 1024]);
    expect(preparedMetadata(reopened)).toEqual(preparedMetadata(refined));
    for (const index of [0, 1, 2, 12345, refinedValues.length - 1]) {
      expect(new Uint32Array(reopened.values.buffer)[index]).toBe(new Uint32Array(refinedValues.buffer)[index]);
    }
    expect(encodePreparedMap(native)).toEqual(original);
    expect(fake.runner.runRaw).toHaveBeenCalledOnce(); expect(mocks.refine).toHaveBeenCalledOnce();
    expect(writable.abort).not.toHaveBeenCalled();
    preparer.dispose();
  });

  it("refuses mismatched native photo, inference recipe, inactive refinement or a refined parent before GPU work", async () => {
    runnerWith();
    const preparer = createPhotoPreparer(() => {});
    const reference = photograph(), request = depthRequest(266, reference);
    const native = await preparer.run(request);
    const recipe = { ...request.recipe, refinement: { ...DEFAULT_DEPTH_REFINEMENT } };
    await expect(preparer.refine({ ...reference, sha256: "b".repeat(64) }, native, recipe, 16384)).rejects.toThrow(/different photo/);
    await expect(preparer.refine({ ...reference, bitmap: { ...reference.bitmap, width: 8 } as ImageBitmap }, native, recipe, 16384)).rejects.toThrow(/different photo/);
    for (const change of [{ modelId: PHOTO_DEPTH_LARGE_Q4F16.id }, { inputSide: 518 }, { backend: "webgpu" as const }]) {
      await expect(preparer.refine(reference, native, { ...recipe, ...change }, 16384)).rejects.toThrow(/differs from the selected/);
    }
    await expect(preparer.refine(reference, native, request.recipe, 16384)).rejects.toThrow(/not selected/);
    await expect(preparer.refine(reference, native, recipe, 2)).rejects.toThrow(/output edge/);
    expect(mocks.refine).not.toHaveBeenCalled();
    mocks.refine.mockResolvedValue(new Float32Array(8).fill(0.5));
    const refined = await preparer.refine(reference, native, recipe, 16384);
    await expect(preparer.refine(reference, refined, recipe, 16384)).rejects.toThrow(/native depth prediction/);
    expect(mocks.refine).toHaveBeenCalledTimes(1);
    preparer.dispose();
  });

  it("keeps native depth unchanged after refinement failure or cancellation and can explicitly retry", async () => {
    runnerWith();
    const preparer = createPhotoPreparer(() => {});
    const reference = photograph(), request = depthRequest(266, reference);
    const native = await preparer.run(request), original = encodePreparedMap(native);
    const recipe = { ...request.recipe, refinement: { ...DEFAULT_DEPTH_REFINEMENT } };
    mocks.refine.mockRejectedValueOnce(new Error("device lost"));
    await expect(preparer.refine(reference, native, recipe, 16384)).rejects.toThrow(/device lost/);
    expect(encodePreparedMap(native)).toEqual(original);
    let finish!: (result: Float32Array) => void;
    mocks.refine.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const pending = preparer.refine(reference, native, recipe, 16384);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => expect(mocks.refine).toHaveBeenCalledTimes(2));
    preparer.cancel(); finish(new Float32Array(8).fill(0.5)); await rejected;
    expect(encodePreparedMap(native)).toEqual(original);
    mocks.refine.mockResolvedValueOnce(new Float32Array(8).fill(0.5));
    const retried = await preparer.refine(reference, native, recipe, 16384);
    expect(preparedMetadata(retried)).toMatchObject({ stage: "refined" });
    expect(encodePreparedMap(native)).toEqual(original);
    preparer.dispose();
  });
});

describe("photo decoding", () => {
  it("hashes the actual source bytes and retains its bitmap", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const bitmap = { width: 4, height: 2, close: vi.fn() };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.buffer })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
    const controller = new AbortController();
    const result = await decodePreparationPhoto("/photo", "object.png", controller.signal);
    expect(result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.bitmap).toBe(bitmap);
    expect(bitmap.close).not.toHaveBeenCalled();
  });

  it("closes a bitmap completed after cancellation and refuses HTTP failures", async () => {
    const bitmap = { close: vi.fn() };
    const controller = new AbortController();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(1) })));
    vi.stubGlobal("createImageBitmap", vi.fn(async () => { controller.abort(new Error("cancelled")); return bitmap; }));
    await expect(decodePreparationPhoto("/photo", "object.png", controller.signal)).rejects.toThrow("cancelled");
    expect(bitmap.close).toHaveBeenCalledTimes(1);
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    await expect(decodePreparationPhoto("/missing", "missing.png", new AbortController().signal)).rejects.toThrow("404");
  });
});

describe("saved prepared maps", () => {
  it("writes real float32 bytes before retaining the durable file identity", async () => {
    let written!: Uint8Array;
    const writable = { write: vi.fn(async (bytes: Uint8Array) => { written = bytes.slice(); }), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    const handle = { name: "depth.loom.exr", createWritable: vi.fn(async () => writable), getFile: async () => new File([written.buffer as ArrayBuffer], "depth.loom.exr") };
    const picker = vi.fn(async (options: { types: readonly { accept: Record<string, readonly string[]> }[] }) => {
      // Match the File System Access suffix rules so this mock cannot accept a
      // filter the browser would reject before showing the save dialog.
      for (const type of options.types) {
        for (const extensions of Object.values(type.accept)) {
          for (const extension of extensions) {
            if (!extension.startsWith(".") || extension.endsWith(".") || extension.length > 16 || !/^[A-Za-z0-9+.]+$/.test(extension)) {
              throw new TypeError(`Failed to execute 'showSaveFilePicker' on 'Window': Extension '${extension}' contains invalid characters.`);
            }
          }
        }
      }
      return handle;
    });
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = picker;
    const map = rawResult().raw;
    const progress = vi.fn();
    const uri = await savePreparedMap(map, "depth", progress);
    expect(picker).toHaveBeenCalledWith({ suggestedName: `depth-data-4x4-${createHash("sha256").update(written).digest("hex").slice(0, 12)}.loom.exr`, types: [{ description: "Loom OpenEXR float32 map", accept: { "image/x-exr": [".exr"] } }] });
    expect(new Uint32Array(decodeDepthExr(written).values.buffer)).toEqual(new Uint32Array(map.values.buffer));
    expect(mocks.remember).toHaveBeenCalledWith(handle, "binary");
    expect(writable.close.mock.invocationCallOrder[0]!).toBeLessThan(mocks.remember.mock.invocationCallOrder[0]!);
    expect(parseFileReference(uri)?.source.kind).toBe("fileHandle");
    expect(uri).not.toContain("blob:");
    expect(writable.abort).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledTimes(1);
    expect(progress).toHaveBeenCalledWith({ phase: "saving", message: "Writing the float32 map…" });
    expect(picker.mock.invocationCallOrder[0]!).toBeLessThan(progress.mock.invocationCallOrder[0]!);
    expect(progress.mock.invocationCallOrder[0]!).toBeLessThan(writable.write.mock.invocationCallOrder[0]!);
  });

  it("reports no write progress while choosing a location or after save cancellation", async () => {
    let cancel!: (error: unknown) => void;
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = vi.fn(() => new Promise((_resolve, reject) => { cancel = reject; }));
    const progress = vi.fn();
    const pending = savePreparedMap(rawResult().raw, "depth", progress);
    const rejected = expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(progress).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(cancel).toBeTypeOf("function"));
    cancel(new DOMException("cancelled", "AbortError"));
    await rejected;
    expect(progress).not.toHaveBeenCalled();
    expect(mocks.remember).not.toHaveBeenCalled();
  });

  it("refuses unsupported saving and aborts write failures without retaining a handle", async () => {
    await expect(savePreparedMap(rawResult().raw, "depth")).rejects.toThrow("File System Access");
    const writable = { write: vi.fn(async () => { throw new Error("disk full"); }), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
    (window as unknown as { showSaveFilePicker: unknown }).showSaveFilePicker = vi.fn(async () => ({ createWritable: async () => writable }));
    await expect(savePreparedMap(rawResult().raw, "depth")).rejects.toThrow("disk full");
    expect(writable.abort).toHaveBeenCalledTimes(1);
    expect(writable.close).not.toHaveBeenCalled();
    expect(mocks.remember).not.toHaveBeenCalled();
  });
});

/**
 * T1817b — DEPTH PRO 2 ON A PHOTO. What differs from Depth Anything, each pinned where a
 * wrong answer would still produce a plausible map: the model's own non-square box with
 * the photo letterboxed into THAT aspect, the recipe's field of view reaching the worker,
 * the canvas's display bytes decoded for a packer that encodes, and metres kept as inverse
 * metres with the letterbox bars out of the range.
 */
describe("Depth Pro 2 photo preparation (T1817b)", () => {
  /** A 4:3 box holding a 2:1 photo: the band is rows 80–399 (occ 2/3), not the square rule's 120–359. */
  function metresResult(width = 640, height = 480) {
    const values = new Float32Array(width * height).fill(4);
    for (let x = 0; x < width; x++) { values[x] = 0.01; values[(height - 1) * width + x] = 0.01; } // bars: 100 /m
    values[100 * width + 10] = 2; // inside the 4:3 band, outside the square rule's
    values[240 * width + 320] = Infinity; // sky
    values[241 * width + 320] = Number.NaN;
    return { bytes: new Uint8Array([1]), raw: { width, height, values } };
  }
  // The default recipe asks for WebGPU; jsdom has none, so these say there is one.
  beforeEach(() => { vi.stubGlobal("navigator", { gpu: {} }); });
  const request = (recipe: Partial<Extract<PhotoDepthRecipe, { version: 3 }>> = {}) =>
    ({ kind: "depth" as const, photo: photograph(), recipe: { ...DEFAULT_DEPTH_PRO2_RECIPE, fieldOfView: 75, ...recipe } });

  it("runs the box's own file at the recipe's field of view, and saves inverse metres with the bars out of range", async () => {
    // Canvas rows carry their own index (halved, to fit a byte), so the letterbox is readable.
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation((() => ({
      drawImage: vi.fn(),
      getImageData: (_x: number, _y: number, width: number, height: number) => ({
        data: Uint8ClampedArray.from({ length: width * height * 4 }, (_, index) => index % 4 === 3 ? 128 : Math.floor(Math.floor(index / 4 / width) / 2)) }),
    })) as unknown as typeof HTMLCanvasElement.prototype.getContext);
    const fake = runnerWith(metresResult());
    let texels!: Float32Array;
    const recorded = fake.runner.runRaw.getMockImplementation()!;
    fake.runner.runRaw.mockImplementation(async (id, bytes) => { texels = new Float32Array(bytes.slice(0)); return recorded(id, bytes); });
    const preparer = createPhotoPreparer(() => {});
    const map = await preparer.run(request());
    const nodeId = fake.runner.runRaw.mock.calls[0]![0];
    expect(mocks.acquire).toHaveBeenCalledWith(DEPTH_PRO2_S);
    // The run's target, read back the way the worker runner reads it (it is retired after).
    const target = fake.options().describe;
    expect(target(nodeId)).toBeUndefined();
    expect(mocks.runner).toHaveBeenCalledTimes(1);
    expect(texels.length).toBe(640 * 480 * 4);
    // Row 300 of a 4:3 box samples canvas row 330 (occ 2/3); the square rule would give 361.
    // Decoded, because the packer encodes again; alpha is coverage and stays as read.
    expect(texels[(300 * 640) * 4]).toBe(Math.fround(decodeSrgb(165 / 255)));
    expect(texels[(300 * 640) * 4 + 3]).toBe(Math.fround(128 / 255));
    expect([map.width, map.height]).toEqual([640, 480]);
    expect(map.values[240 * 640 + 320]).toBe(0); // sky: no distance
    expect(map.values[241 * 640 + 320]).toBe(0);
    expect(map.values[100 * 640 + 10]).toBe(0.5);
    expect(map.values[300 * 640]).toBe(0.25);
    expect(map.values[0]).toBe(100); // the bar is kept as the model said it…
    expect(preparedMetadata(map)).toMatchObject({ version: 2, kind: "depth", stage: "native", parent: null,
      semantics: "inverse-metric", registration: "letterbox", inputSide: 640,
      model: { id: "depthpro2-s-fp32", url: DEPTH_PRO2_S.url },
      // …but is not in the range: low is the sky's 0, high the 2 m sample, not the bar's 100.
      range: { low: 0, high: 0.5 }, recipe: { ...DEFAULT_DEPTH_PRO2_RECIPE, fieldOfView: 75 } });
    const reopened = decodeDepthExr(encodePreparedMap(map));
    expect(preparedMetadata(reopened)).toEqual(preparedMetadata(map));
    expect(new Uint32Array(reopened.values.buffer)).toEqual(new Uint32Array(map.values.buffer));
    preparer.dispose();
  });

  it("hands the worker the photo's size and the field of view, and the 16:9 box its own file", async () => {
    const fake = runnerWith(metresResult(672, 384));
    let seen: ReturnType<WorkerRunnerOptions["describe"]>;
    const recorded = fake.runner.runRaw.getMockImplementation()!;
    fake.runner.runRaw.mockImplementation(async (id, bytes) => { seen = fake.options().describe(id); return recorded(id, bytes); });
    const preparer = createPhotoPreparer(() => {});
    const map = await preparer.run(request({ modelId: "depthpro2-b-fp16", inputSide: 672 }));
    expect(seen).toMatchObject({ modelId: DEPTH_PRO2_WIDE[DEPTH_PRO2_B.id]!.id, nodeType: "depth", width: 672, height: 384,
      sourceWidth: 4, sourceHeight: 2, providers: ["webgpu"], fieldOfView: 75 });
    expect(mocks.acquire).toHaveBeenCalledWith(DEPTH_PRO2_WIDE[DEPTH_PRO2_B.id]);
    expect(preparedMetadata(map)).toMatchObject({ inputSide: 672, model: { id: "depthpro2-b-fp16", url: DEPTH_PRO2_WIDE[DEPTH_PRO2_B.id]!.url } });
    preparer.dispose();
  });

  it("refuses B on the CPU, and a box Depth Pro 2 has no file for, before a worker or a download", async () => {
    runnerWith(metresResult());
    const preparer = createPhotoPreparer(() => {});
    await expect(preparer.run(request({ modelId: "depthpro2-b-fp16", backend: "wasm" }))).rejects.toThrow(/half-precision/);
    await expect(preparer.run({ ...request(), recipe: { ...request().recipe, inputSide: 518 } as never })).rejects.toThrow();
    expect(mocks.runner).not.toHaveBeenCalled();
    expect(mocks.acquire).not.toHaveBeenCalled();
    preparer.dispose();
  });

  it("refines a metric map back into inverse metres instead of a relative 0..1 map", async () => {
    runnerWith(metresResult());
    const preparer = createPhotoPreparer(() => {});
    const reference = photograph();
    const native = await preparer.run({ ...request(), photo: reference });
    const recipe = { ...request().recipe, refinement: { ...DEFAULT_DEPTH_REFINEMENT } };
    mocks.refine.mockImplementationOnce(async () => Float32Array.from([0, 0.25, 0.5, 1, 1, 0.5, 0.25, 0]));
    const refined = await preparer.refine(reference, native, recipe, 16384);
    // Native range 0..0.5 /m: the filter's normalized 0.25 is 0.125 /m again.
    expect([...refined.values]).toEqual([0, 0.125, 0.25, 0.5, 0.5, 0.25, 0.125, 0]);
    expect(preparedMetadata(refined)).toMatchObject({ stage: "refined", semantics: "inverse-metric", range: { low: 0, high: 0.5 }, recipe });
    preparer.dispose();
  });

  it("reads a JPEG's 35 mm equivalent focal length when decoding the photo, and nothing from a PNG", async () => {
    const tiff = new Uint8Array(40);
    const view = new DataView(tiff.buffer);
    view.setUint16(0, 0x4949); view.setUint16(2, 42, true); view.setUint32(4, 8, true);
    view.setUint16(8, 1, true); view.setUint16(10, 0x8769, true); view.setUint16(12, 4, true); view.setUint32(14, 1, true); view.setUint32(18, 26, true);
    view.setUint16(26, 1, true); view.setUint16(28, 0xa405, true); view.setUint16(30, 3, true); view.setUint32(32, 1, true); view.setUint16(36, 24, true);
    const app1Length = 2 + 6 + tiff.length;
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe1, app1Length >> 8, app1Length & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff, 0xff, 0xd9]);
    vi.stubGlobal("createImageBitmap", vi.fn(async () => ({ width: 4, height: 2, close: vi.fn() })));
    for (const [bytes, expected] of [[jpeg, 24], [new Uint8Array([0x89, 0x50, 0x4e, 0x47]), undefined]] as const) {
      vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, arrayBuffer: async () => bytes.slice().buffer })));
      const photo = await decodePreparationPhoto("/photo", "photo", new AbortController().signal);
      expect(photo.focalLength35).toBe(expected);
    }
  });
});
