import { PHOTO_DEPTH_MODELS, PHOTO_MASK, PHOTO_FACADE } from "@runtime/models/model-catalogue.ts";
import { supportsPhotoDepthSize, supportsPhotoMaskSize } from "@domain/media/preparation-sizes.ts";
import { createModelAcquisition, progressText, type ModelDescriptor } from "@runtime/models/model-acquisition.ts";
import { cacheModelStore } from "@runtime/models/cache-model-store.ts";
import { createWorkerRunner, type WorkerRunTarget } from "@runtime/models/worker-runner.ts";
import type { WorkerLike } from "@runtime/models/inference-protocol.ts";
import { decodeSrgb, inverseMetres, occOf } from "@runtime/models/depth-runner.ts";
import { makePreparedMap, withDepthRecipe, preparedMetadata, depthRecipeOf, rasterizeFloatMap } from "@runtime/media/prepared-map.ts";
import { refineFacadeMask, type FacadeMaskSettings } from "@runtime/media/facade-mask.ts";
import type { FloatMap } from "@runtime/media/float-map.ts";
import { encodePreparedMap, PREPARED_MAP_EXTENSION, PREPARED_MAP_MIME_TYPE } from "@runtime/media/prepared-map-file.ts";
import { photoDepthRecipeSchema, photoDepthInputSize, MARIGOLD_BUNDLE_ID, depthInferenceKey, depthRefinementSize, type PhotoDepthRecipe } from "@domain/media/photo-depth-recipe.ts";
import { refineBrowserPhotoDepth } from "@runtime/backend/photo-depth-refinement.ts";
import type { WorkerRunner } from "@runtime/models/worker-runner.ts";
import { PHOTO_DEPTH_PRO2_FILES, photoDepthPro2Descriptor, photoDepthUnavailableReason } from "@runtime/models/photo-depth-models.ts";
import { hasNativePreparation, probeNativePreparation, runNativePreparation } from "@devices/native-preparation.ts";
import { encodeDepthImage, DEPTH_IMAGE_FORMATS, type DepthImageFormat } from "@runtime/media/depth-image.ts";
import { preparedMapFilename } from "@runtime/media/prepared-map-name.ts";
import { focalLength35FromJpeg } from "@runtime/media/exif-focal.ts";
import { retainedFiles, type RetainedFileHandle } from "@ui/files/retained-files.ts";
import bundledFacadeUrl from "../runtime/models/assets/topformer-ade20k.onnx?url";

export interface PreparationPhoto {
  readonly bitmap: ImageBitmap;
  readonly sha256: string;
  readonly name: string;
  /** T1817b: the JPEG's 35 mm equivalent focal length, when it records one (Depth Pro 2's field of view). */
  readonly focalLength35?: number;
}

export type PhotoPreparationRequest =
  | { readonly kind: "depth"; readonly photo: PreparationPhoto; readonly recipe: PhotoDepthRecipe }
  | { readonly kind: "mask"; readonly photo: PreparationPhoto; readonly inputSide: number; readonly facade?: FacadeMaskSettings };

export interface PreparationProgress {
  readonly phase: "preparing" | "downloading" | "processing" | "finishing" | "saving";
  readonly message: string;
  /** Only byte transfers have measurable completion; inference stays indeterminate. */
  readonly fraction?: number;
}

export async function decodePreparationPhoto(url: string, name: string, signal: AbortSignal): Promise<PreparationPhoto> {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`The photo could not be opened (${response.status}).`);
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const bitmap = await createImageBitmap(new Blob([bytes]));
  if (signal.aborted) { bitmap.close(); throw signal.reason; }
  const focalLength35 = focalLength35FromJpeg(new Uint8Array(bytes));
  return { bitmap, sha256: [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join(""), name,
    ...(focalLength35 === undefined ? {} : { focalLength35 }) };
}

/**
 * Only colour photographs use canvas decoding. Inferred depth never passes through it.
 *
 * `width × height` is the model's box: square for Depth Anything, 4:3 or 16:9 for Depth Pro
 * 2 (T1817b), and the letterbox fits the photo into THAT aspect. `linear` decodes the
 * canvas's display bytes for a model whose packer encodes them again (Depth Pro 2's, which
 * the live node feeds from the linear working space); alpha is never decoded.
 */
function photoTexels(photo: PreparationPhoto, width: number, height: number, letterbox: boolean, linear = false): Float32Array {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) throw new Error("Photo preparation requires a 2D canvas.");
  context.drawImage(photo.bitmap, 0, 0, width, height);
  const rgba = context.getImageData(0, 0, width, height).data;
  const [occX, occY] = letterbox ? occOf(photo.bitmap.width, photo.bitmap.height, width / height) : [1, 1];
  const texels = new Float32Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sx = Math.max(0, Math.min(width - 1, Math.floor((((x + 0.5) / width - 0.5) / occX + 0.5) * width)));
      const sy = Math.max(0, Math.min(height - 1, Math.floor((((y + 0.5) / height - 0.5) / occY + 0.5) * height)));
      const source = 4 * (sy * width + sx);
      const target = 4 * (y * width + x);
      for (let channel = 0; channel < 4; channel++) {
        const display = rgba[source + channel]! / 255;
        texels[target + channel] = linear && channel < 3 ? decodeSrgb(display) : display;
      }
    }
  }
  return texels;
}

/** One explicit preparation session, reusing the model cache, protocol and worker core. */
export function createPhotoPreparer(onProgress: (progress: PreparationProgress) => void) {
  const store = cacheModelStore();
  if (store === null && !hasNativePreparation()) throw new Error("Model caching is unavailable in this browser context.");
  const descriptors = new Map<string, ModelDescriptor>([...PHOTO_DEPTH_MODELS, ...PHOTO_DEPTH_PRO2_FILES, PHOTO_MASK, PHOTO_FACADE].map(model => [model.id, model]));
  const acquisition = store === null ? null : createModelAcquisition({
    store,
    // TopFormer's upstream download rejects browser Fetch Metadata. This exact,
    // hash-verified asset is served with Loom, not selected after a failed request.
    fetch: (url, options) => fetch(options.descriptor.id === PHOTO_FACADE.id ? bundledFacadeUrl : url, { signal: options.signal }),
    onStateChange: (id, state) => {
      if (state.kind === "downloading") onProgress({ phase: "downloading",
        message: `${descriptors.get(id)!.label} · ${progressText(state.received, state.total)}`,
        ...(state.total !== undefined && state.total > 0 ? { fraction: Math.min(1, state.received / state.total) } : {}) });
      else if (state.kind === "failed") onProgress({ phase: "preparing", message: state.reason });
    },
  });
  const targets = new Map<string, WorkerRunTarget>();
  let runner: WorkerRunner | null = null;
  let active: AbortController | null = null;
  let disposed = false;
  const begin = () => {
    if (disposed) throw new Error("Photo preparation was closed.");
    if (active !== null) throw new Error("Photo preparation is already running.");
    active = new AbortController();
    return active;
  };
  const retire = () => {
    runner?.retainNodes([]);
    runner?.dispose();
    runner = null;
    targets.clear();
    active = null;
  };
  const openRunner = (models: NonNullable<typeof acquisition>, abort: AbortController): WorkerRunner => {
    const worker = new Worker(new URL("../runtime/models/inference.worker.ts", import.meta.url), { type: "module" }) as unknown as WorkerLike;
    return createWorkerRunner({ worker, describe: id => targets.get(id), weightsFor: async id => {
      onProgress({ phase: "preparing", message: "Opening the model cache…" });
      const weights = await models.acquire(descriptors.get(id)!);
      abort.signal.throwIfAborted();
      if (weights !== undefined) onProgress({ phase: "processing", message: "Running the model on your photo…" });
      return weights;
    }, onMeasured: (_id, measurement) => onProgress({ phase: "finishing",
      message: `${measurement.backend} · ${Math.round(measurement.millis)} ms · preparing float32 output` }) });
  };
  /**
   * T1817b — Depth Pro 2 on a photo. The model's box (4:3 or 16:9) with the photo
   * letterboxed into it, the recipe's field of view as its focal length, and its metres kept
   * as inverse metres at the box's own resolution: the first prepared depth with a unit.
   * The map's `model.id` is the model the recipe names; its `url` is the file the box chose.
   */
  const runDepthPro2 = async (photo: PreparationPhoto, recipe: Extract<PhotoDepthRecipe, { version: 3 }>, abort: AbortController): Promise<FloatMap> => {
    if (acquisition === null) throw new Error("Browser model caching is unavailable in this context.");
    const descriptor = photoDepthPro2Descriptor(recipe);
    const box = photoDepthInputSize(recipe, photo.bitmap.width, photo.bitmap.height);
    const nodeId = crypto.randomUUID();
    targets.set(nodeId, { modelId: descriptor.id, nodeType: "depth", width: box.width, height: box.height, side: box.width,
      sourceWidth: photo.bitmap.width, sourceHeight: photo.bitmap.height, providers: [recipe.backend], ratio: 0, smoothing: 1,
      fieldOfView: recipe.fieldOfView });
    runner = openRunner(acquisition, abort);
    onProgress({ phase: "preparing", message: "Preparing depth input…" });
    const texels = photoTexels(photo, box.width, box.height, true, true);
    onProgress({ phase: "processing", message: `Processing depth · ${box.width} × ${box.height} · ${recipe.fieldOfView}° field of view` });
    const { raw } = await runner.runRaw(nodeId, texels.buffer as ArrayBuffer);
    abort.signal.throwIfAborted();
    if (raw.width !== box.width || raw.height !== box.height) {
      throw new Error(`Depth Pro 2 returned ${raw.width} × ${raw.height} for a ${box.width} × ${box.height} box.`);
    }
    const map = makePreparedMap(inverseMetres(raw.values), raw.width, raw.height, { kind: "depth",
      source: { sha256: photo.sha256, width: photo.bitmap.width, height: photo.bitmap.height },
      model: { id: recipe.modelId, url: descriptor.url }, inputSide: recipe.inputSide, registration: "letterbox" });
    return withDepthRecipe(map, { ...recipe, refinement: null }, null, "inverse-metric");
  };
  return {
    async run(request: PhotoPreparationRequest): Promise<FloatMap> {
      const abort = begin();
      try {
        const { kind, photo } = request;
        if (kind === "depth" && "facade" in request) throw new Error("Facade settings apply only to masks.");
        const recipe = kind === "depth" ? photoDepthRecipeSchema.parse(request.recipe) : null;
        if (recipe?.version === 2) {
          const capability = await probeNativePreparation();
          abort.signal.throwIfAborted();
          const reason = photoDepthUnavailableReason(recipe, globalThis.navigator?.gpu !== undefined, capability);
          if (reason !== null) throw new Error(reason);
          const { width, height } = photoDepthInputSize(recipe, photo.bitmap.width, photo.bitmap.height);
          const canvas = document.createElement("canvas");
          canvas.width = width; canvas.height = height;
          const context = canvas.getContext("2d", { willReadFrequently: true });
          if (context === null) throw new Error("Native photo preparation requires a 2D canvas.");
          context.drawImage(photo.bitmap, 0, 0, width, height);
          const rgba = new Uint8Array(context.getImageData(0, 0, width, height).data).buffer;
          const result = await runNativePreparation({ modelId: recipe.modelId, inputSide: recipe.inputSide,
            seed: recipe.seed, width, height, rgba }, progress => onProgress({
              phase: progress.phase === "downloading" ? "downloading" : progress.phase === "loading" ? "preparing" : "processing",
              message: progress.message, ...(progress.fraction === undefined ? {} : { fraction: progress.fraction }),
            }), abort.signal);
          abort.signal.throwIfAborted();
          const map = makePreparedMap(new Float32Array(result.values), result.width, result.height, { kind: "depth",
            source: { sha256: photo.sha256, width: photo.bitmap.width, height: photo.bitmap.height },
            model: { id: recipe.modelId, url: `loom:model-bundle/${MARIGOLD_BUNDLE_ID}` }, inputSide: recipe.inputSide, registration: "stretch" });
          onProgress({ phase: "finishing", message: "Marigold finished · native log-depth float32 preserved" });
          return withDepthRecipe(map, { ...recipe, refinement: null }, null, result.semantics);
        }
        if (acquisition === null) throw new Error("Browser model caching is unavailable in this context.");
        if (recipe !== null) {
          const reason = photoDepthUnavailableReason(recipe, globalThis.navigator?.gpu !== undefined);
          if (reason !== null) throw new Error(reason);
        }
        const facade = request.kind === "mask" ? request.facade : undefined;
        if (recipe?.version === 3) return await runDepthPro2(photo, recipe, abort);
        const descriptor = recipe !== null ? PHOTO_DEPTH_MODELS.find(model => model.id === recipe.modelId)
          : facade === undefined ? PHOTO_MASK : PHOTO_FACADE;
        if (descriptor === undefined) throw new Error(`The selected photo depth model is unavailable: ${recipe!.modelId}.`);
        const detailSide = recipe?.inputSide ?? (request as Extract<PhotoPreparationRequest, { kind: "mask" }>).inputSide;
        if (kind === "depth" ? !supportsPhotoDepthSize(detailSide) : !supportsPhotoMaskSize(detailSide)) {
          throw new Error(`Unsupported ${kind} input size.`);
        }
        const side = facade === undefined ? detailSide : 512;
        const nodeId = crypto.randomUUID();
        targets.set(nodeId, { modelId: descriptor.id, nodeType: kind === "depth" ? "depth" : "matte",
          width: side, height: side, side, sourceWidth: photo.bitmap.width, sourceHeight: photo.bitmap.height,
          providers: [recipe?.backend ?? "wasm"], ratio: 0, smoothing: 1 });
        runner = openRunner(acquisition, abort);
        onProgress({ phase: "preparing", message: `Preparing ${kind} input…` });
        const texels = photoTexels(photo, side, side, kind === "depth");
        onProgress({ phase: "processing", message: `Processing ${kind} · ${side} × ${side}` });
        const { raw } = await runner.runRaw(nodeId, texels.buffer as ArrayBuffer);
        abort.signal.throwIfAborted();
        const map = makePreparedMap(raw.values, raw.width, raw.height, { kind,
          source: { sha256: photo.sha256, width: photo.bitmap.width, height: photo.bitmap.height },
          model: { id: descriptor.id, url: descriptor.url }, inputSide: side,
          registration: kind === "depth" ? "letterbox" : "stretch" });
        if (recipe !== null) return withDepthRecipe(map, { ...recipe, refinement: null });
        if (facade === undefined) return map;
        onProgress({ phase: "finishing", message: "Refining walls, openings and reflective glass…" });
        return refineFacadeMask(map, { width: detailSide, height: detailSide,
          texels: photoTexels(photo, detailSide, detailSide, false) }, facade);
      } catch (error) {
        if (error instanceof AggregateError) throw error;
        abort.signal.throwIfAborted();
        throw error;
      } finally { retire(); }
    },
    async refine(photo: PreparationPhoto, native: FloatMap, recipe: PhotoDepthRecipe, maxLongEdge: number, savedNativeSha256?: string): Promise<FloatMap> {
      const abort = begin();
      try {
        const metadata = preparedMetadata(native);
        if (metadata.kind !== "depth" || (metadata.version === 2 && metadata.stage !== "native")) throw new Error("Refinement requires the saved native depth prediction.");
        if (metadata.source.sha256 !== photo.sha256 || metadata.source.width !== photo.bitmap.width || metadata.source.height !== photo.bitmap.height) throw new Error("Native depth belongs to a different photo.");
        if (depthInferenceKey(depthRecipeOf(native)) !== depthInferenceKey(recipe)) throw new Error("Native depth differs from the selected model, size or backend. Run depth again.");
        const target = depthRefinementSize(recipe, photo.bitmap.width, photo.bitmap.height, maxLongEdge);
        const scale = Math.min(1, Math.max(native.width, native.height) / Math.max(photo.bitmap.width, photo.bitmap.height));
        const input = { width: Math.max(1, Math.round(photo.bitmap.width * scale)), height: Math.max(1, Math.round(photo.bitmap.height * scale)) };
        const values = rasterizeFloatMap(native, "depth", input.width, input.height);
        const canvas = document.createElement("canvas");
        canvas.width = target.width; canvas.height = target.height;
        const context = canvas.getContext("2d", { willReadFrequently: true });
        if (context === null) throw new Error("Photo refinement requires a 2D canvas.");
        context.drawImage(photo.bitmap, 0, 0, target.width, target.height);
        const rgba = new Uint8Array(context.getImageData(0, 0, target.width, target.height).data.buffer);
        if (savedNativeSha256 !== undefined && !/^[a-f0-9]{64}$/.test(savedNativeSha256)) throw new Error("Saved native depth identity must be a lowercase SHA-256 digest.");
        const nativeSha256 = savedNativeSha256 ?? [...new Uint8Array(await crypto.subtle.digest("SHA-256", encodePreparedMap(native).buffer as ArrayBuffer))].map(value => value.toString(16).padStart(2, "0")).join("");
        abort.signal.throwIfAborted();
        const refined = await refineBrowserPhotoDepth({ ...input, values }, { ...target, rgba }, target, recipe.refinement!, {
          signal: abort.signal,
          onStage: (stage, total, width, height) => onProgress({ phase: "processing", message: `Guided depth refinement · pass ${stage} of ${total} · ${width} × ${height}` }),
        });
        abort.signal.throwIfAborted();
        /* T1817b: a metric native keeps its unit through refinement. The guided filter ran on
           the normalized view, and that normalization is affine, so mapping back through the
           native range gives 1/metres again rather than a relative 0..1 map. */
        const metric = metadata.version === 2 && metadata.semantics === "inverse-metric";
        const { low, high } = metadata.range;
        const samples = metric ? refined.map(value => low + value * (high - low)) : refined;
        const map = makePreparedMap(samples, target.width, target.height, { kind: "depth", source: metadata.source,
          model: metadata.model, inputSide: metadata.inputSide, registration: "stretch" });
        const registered = metric ? map : { ...map, metadata: { preparation: { ...preparedMetadata(map), range: { low: 0, high: 1 } } } };
        return withDepthRecipe(registered, recipe, { sha256: nativeSha256,
          width: native.width, height: native.height }, metric ? "inverse-metric" : undefined);
      } catch (error) { abort.signal.throwIfAborted(); throw error; }
      finally { retire(); }
    },
    cancel() {
      active?.abort(new DOMException("Photo preparation cancelled.", "AbortError"));
      runner?.dispose(); runner = null;
      for (const descriptor of descriptors.values()) acquisition?.cancel(descriptor.id);
    },
    dispose() {
      disposed = true;
      active?.abort(new Error("Photo preparation was closed."));
      runner?.dispose(); runner = null;
      for (const descriptor of descriptors.values()) acquisition?.cancel(descriptor.id);
    },
  };
}

interface WritableHandle extends RetainedFileHandle {
  createWritable(): Promise<{ write(bytes: Uint8Array): Promise<void>; close(): Promise<void>; abort(): Promise<void> }>;
}

/** Save real external bytes and retain their handle; session object URLs are never persisted. */
export async function savePreparedMap(map: FloatMap, name: string, onProgress?: (progress: PreparationProgress) => void): Promise<string> {
  const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<WritableHandle> }).showSaveFilePicker;
  if (picker === undefined) throw new Error("Saving reusable maps requires File System Access in this browser.");
  const bytes = encodePreparedMap(map);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  const fingerprint = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  const handle = await picker.call(window, { suggestedName: preparedMapFilename(map, name, fingerprint),
    types: [{ description: "Loom OpenEXR float32 map", accept: { [PREPARED_MAP_MIME_TYPE]: [".exr"] } }] });
  onProgress?.({ phase: "saving", message: "Writing the float32 map…" });
  const writable = await handle.createWritable();
  try { await writable.write(bytes); await writable.close(); }
  catch (error) { await writable.abort(); throw error; }
  return retainedFiles().remember(handle, "binary");
}

/** Interchange exports are separate from the reusable float32 preparation artifact. */
export async function exportDepthImage(map: FloatMap, name: string, format: DepthImageFormat): Promise<void> {
  if (preparedMetadata(map).kind !== "depth") throw new Error("Depth image export requires a prepared depth map.");
  const descriptor = DEPTH_IMAGE_FORMATS.find(item => item.id === format);
  if (descriptor === undefined) throw new Error("Unsupported depth image format.");
  const bytes = encodeDepthImage(map, format);
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  const fingerprint = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, "0")).join("");
  const filename = preparedMapFilename(map, name, fingerprint).slice(0, -PREPARED_MAP_EXTENSION.length) + `-${format}${descriptor.extension}`;
  const picker = (window as unknown as { showSaveFilePicker?: (options: unknown) => Promise<WritableHandle> }).showSaveFilePicker;
  if (picker === undefined) {
    const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: descriptor.mime }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename;
    document.body.append(anchor); anchor.click(); anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    return;
  }
  const handle = await picker.call(window, { suggestedName: filename,
    types: [{ description: descriptor.label, accept: { [descriptor.mime]: [descriptor.extension] } }] });
  const writable = await handle.createWritable();
  try { await writable.write(bytes); await writable.close(); }
  catch (error) { await writable.abort(); throw error; }
}
