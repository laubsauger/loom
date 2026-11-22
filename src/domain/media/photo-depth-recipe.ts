import { z } from "zod";
import { supportsPhotoDepthSize } from "./preparation-sizes.ts";
import { isParameterSlot, storedStaticValue } from "../parameters/slots.ts";
import type { StoredParameter } from "../types/parameters.ts";

const refinementSchema = z.object({
  target: z.enum(["source", "2048", "4096"]),
  radius: z.number().int().min(1).max(4),
  spatialSigma: z.number().finite().positive().max(8),
  colorSigma: z.number().finite().positive().max(1),
}).strict();

export const MARIGOLD_MODEL_ID = "marigold-v2-q4";
export const MARIGOLD_BUNDLE_ID = "marigold-v2-log-stage2-mlx-q4-v1";
export const MARIGOLD_INPUT_SIDES = [512, 768, 1024, 1280, 1536] as const;

/**
 * T1817b — Depth Pro 2 as a photo-depth model: the single-frame builds T1816b verified
 * (S FP32, B FP16). Its graphs are static, so the input is a fixed BOX, not a side: 640×480
 * (4:3) or 672×384 (16:9), one ONNX file each. `inputSide` holds the box's long edge, the
 * same "long edge" reading Marigold's recipe gives it. The ids are the catalogue's
 * (`model-catalogue.ts`); the domain cannot import the runtime, so a test pins the match.
 */
export const DEPTH_PRO2_PHOTO_MODEL_IDS = ["depthpro2-s-fp32", "depthpro2-b-fp16"] as const;
export const DEPTH_PRO2_PHOTO_SIDES = [640, 672] as const;
export const DEPTH_PRO2_PHOTO_BOXES: Readonly<Record<typeof DEPTH_PRO2_PHOTO_SIDES[number], { readonly width: number; readonly height: number }>> = {
  640: { width: 640, height: 480 },
  672: { width: 672, height: 384 },
};
/** Horizontal field of view in degrees when the photo carries no focal length. */
export const DEFAULT_DEPTH_PRO2_FIELD_OF_VIEW = 60;

/** A box by its long edge, as every surface that lists the sizes names it. */
export function depthPro2BoxLabel(side: typeof DEPTH_PRO2_PHOTO_SIDES[number]): string {
  const { width, height } = DEPTH_PRO2_PHOTO_BOXES[side];
  return `${width} × ${height} (${side === 640 ? "4:3" : "16:9"})`;
}

export function isDepthPro2PhotoModel(modelId: unknown): modelId is typeof DEPTH_PRO2_PHOTO_MODEL_IDS[number] {
  return (DEPTH_PRO2_PHOTO_MODEL_IDS as readonly unknown[]).includes(modelId);
}

const browserDepthRecipeSchema = z.object({
  version: z.literal(1),
  modelId: z.string().min(1),
  inputSide: z.number().int().refine(supportsPhotoDepthSize, "Unsupported photo depth input size."),
  backend: z.enum(["wasm", "webgpu"]),
  refinement: refinementSchema.nullable(),
}).strict();

const nativeDepthRecipeSchema = z.object({
  version: z.literal(2),
  modelId: z.literal(MARIGOLD_MODEL_ID),
  backend: z.literal("mlx"),
  inputSide: z.union([z.literal(512), z.literal(768), z.literal(1024), z.literal(1280), z.literal(1536)]),
  seed: z.number().int().min(0).max(0xffffffff),
  bundleId: z.literal(MARIGOLD_BUNDLE_ID),
  refinement: refinementSchema.nullable(),
}).strict();

/**
 * T1817b: the focal length is part of the INFERENCE — Depth Pro 2 takes it as an input and
 * scales every metre by it — so it is recorded with the run, and a different value is a
 * different native map, exactly like a different model or box.
 */
const depthPro2RecipeSchema = z.object({
  version: z.literal(3),
  modelId: z.enum(DEPTH_PRO2_PHOTO_MODEL_IDS),
  backend: z.enum(["wasm", "webgpu"]),
  inputSide: z.union([z.literal(640), z.literal(672)]),
  fieldOfView: z.number().finite().min(1).max(170),
  refinement: refinementSchema.nullable(),
}).strict();

/** Persisted preparation choices; model availability belongs to the inference layer. */
export const photoDepthRecipeSchema = z.discriminatedUnion("version", [browserDepthRecipeSchema, nativeDepthRecipeSchema, depthPro2RecipeSchema]);

export type PhotoDepthRecipe = z.infer<typeof photoDepthRecipeSchema>;

export const DEFAULT_DEPTH_REFINEMENT: NonNullable<PhotoDepthRecipe["refinement"]> = {
  target: "source", radius: 2, spatialSigma: 2, colorSigma: 0.1,
};

export const DEFAULT_PHOTO_DEPTH_RECIPE: Extract<PhotoDepthRecipe, { version: 1 }> = {
  version: 1, modelId: "depth-anything-v2-small", inputSide: 518, backend: "wasm", refinement: null,
};

export const DEFAULT_MARIGOLD_RECIPE: Extract<PhotoDepthRecipe, { version: 2 }> = {
  version: 2, modelId: MARIGOLD_MODEL_ID, backend: "mlx", inputSide: 512,
  seed: 2025, bundleId: MARIGOLD_BUNDLE_ID, refinement: null,
};

/** WebGPU by default: S FP32 is the one Depth Pro 2 build the CPU runs in reasonable time. */
export const DEFAULT_DEPTH_PRO2_RECIPE: Extract<PhotoDepthRecipe, { version: 3 }> = {
  version: 3, modelId: "depthpro2-s-fp32", backend: "webgpu", inputSide: 640,
  fieldOfView: DEFAULT_DEPTH_PRO2_FIELD_OF_VIEW, refinement: null,
};

/** Typed graph fields keep the native parent visible to the existing asset inventory. */
export function depthRecipeParameters(recipe: PhotoDepthRecipe): Record<string, string | number> {
  const parsed = photoDepthRecipeSchema.parse(recipe);
  return {
    depthModel: parsed.modelId, depthBackend: parsed.backend, inputSide: String(parsed.inputSide),
    refinementTarget: parsed.refinement?.target ?? "off",
    refineRadius: parsed.refinement?.radius ?? DEFAULT_DEPTH_REFINEMENT.radius,
    refineSpatialSigma: parsed.refinement?.spatialSigma ?? DEFAULT_DEPTH_REFINEMENT.spatialSigma,
    refineColorSigma: parsed.refinement?.colorSigma ?? DEFAULT_DEPTH_REFINEMENT.colorSigma,
    ...(parsed.version === 2 ? { depthSeed: parsed.seed, depthBundle: parsed.bundleId } : {}),
    ...(parsed.version === 3 ? { depthFieldOfView: parsed.fieldOfView } : {}),
  };
}

/** Absent fields belong to the legacy Small/WASM preparation, never an alternate model. */
export function depthRecipeFromParameters(parameters: Readonly<Record<string, StoredParameter>>): PhotoDepthRecipe {
  const read = (key: string) => {
    const stored = parameters[key];
    if (isParameterSlot(stored) && stored.mode !== "static") throw new Error(`Photo preparation setting ${key} requires static mode. Snapshot its value before preparation.`);
    return storedStaticValue(stored);
  };
  const target = read("refinementTarget") ?? "off";
  const modelId = read("depthModel") ?? DEFAULT_PHOTO_DEPTH_RECIPE.modelId;
  const native = modelId === MARIGOLD_MODEL_ID;
  const metric = isDepthPro2PhotoModel(modelId);
  const defaults = native ? DEFAULT_MARIGOLD_RECIPE : metric ? DEFAULT_DEPTH_PRO2_RECIPE : DEFAULT_PHOTO_DEPTH_RECIPE;
  return photoDepthRecipeSchema.parse({
    version: defaults.version, modelId,
    backend: native ? read("depthBackend") : read("depthBackend") ?? defaults.backend,
    inputSide: Number(read("inputSide") ?? defaults.inputSide),
    ...(native ? { seed: read("depthSeed") ?? DEFAULT_MARIGOLD_RECIPE.seed,
      bundleId: read("depthBundle") ?? MARIGOLD_BUNDLE_ID } : {}),
    ...(metric ? { fieldOfView: read("depthFieldOfView") ?? DEFAULT_DEPTH_PRO2_FIELD_OF_VIEW } : {}),
    refinement: target === "off" ? null : {
      target, radius: read("refineRadius") ?? DEFAULT_DEPTH_REFINEMENT.radius,
      spatialSigma: read("refineSpatialSigma") ?? DEFAULT_DEPTH_REFINEMENT.spatialSigma,
      colorSigma: read("refineColorSigma") ?? DEFAULT_DEPTH_REFINEMENT.colorSigma,
    },
  });
}

function inferenceFields(recipe: PhotoDepthRecipe) {
  const common = [recipe.version, recipe.modelId, recipe.inputSide, recipe.backend] as const;
  if (recipe.version === 2) return [...common, recipe.seed, recipe.bundleId] as const;
  return recipe.version === 3 ? [...common, recipe.fieldOfView] as const : common;
}

/** Stable identity independent of object insertion order. */
export function depthRecipeKey(recipe: PhotoDepthRecipe): string {
  const parsed = photoDepthRecipeSchema.parse(recipe);
  const refinement = parsed.refinement;
  return JSON.stringify([...inferenceFields(parsed), refinement === null ? null : [
    refinement.target, refinement.radius, refinement.spatialSigma, refinement.colorSigma,
  ]]);
}

/** Refinement changes retain the native inference result. */
export function depthInferenceKey(recipe: PhotoDepthRecipe): string {
  return JSON.stringify(inferenceFields(photoDepthRecipeSchema.parse(recipe)));
}

function positiveDimension(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer.`);
}

/** DAV2 keeps its square input; Depth Pro 2 its fixed box (both letterboxed); native V2 stretches the full frame to aspect-fit dimensions aligned to 16 pixels. */
export function photoDepthInputSize(recipe: PhotoDepthRecipe, sourceWidth: number, sourceHeight: number): { width: number; height: number } {
  const parsed = photoDepthRecipeSchema.parse(recipe);
  positiveDimension(sourceWidth, "Source width");
  positiveDimension(sourceHeight, "Source height");
  if (parsed.version === 1) return { width: parsed.inputSide, height: parsed.inputSide };
  if (parsed.version === 3) return { ...DEPTH_PRO2_PHOTO_BOXES[parsed.inputSide] };
  const sourceEdge = Math.max(sourceWidth, sourceHeight);
  const aligned = (size: number) => Math.max(16, Math.ceil((size / sourceEdge * parsed.inputSide) / 16) * 16);
  return { width: aligned(sourceWidth), height: aligned(sourceHeight) };
}

/** Refuses unavailable output sizes instead of silently resizing a requested target. */
export function depthRefinementSize(recipe: PhotoDepthRecipe, sourceWidth: number, sourceHeight: number,
  maxLongEdge: number): { width: number; height: number } {
  const { refinement } = photoDepthRecipeSchema.parse(recipe);
  if (refinement === null) throw new Error("Depth refinement is not selected.");
  positiveDimension(sourceWidth, "Source width");
  positiveDimension(sourceHeight, "Source height");
  positiveDimension(maxLongEdge, "Maximum output edge");
  const sourceEdge = Math.max(sourceWidth, sourceHeight);
  const targetEdge = refinement.target === "source" ? sourceEdge : Number(refinement.target);
  if (targetEdge > maxLongEdge) throw new Error("Depth refinement target exceeds the supported output edge.");
  const scale = targetEdge / sourceEdge;
  const width = Math.max(1, Math.round(sourceWidth * scale));
  const height = Math.max(1, Math.round(sourceHeight * scale));
  if (width * height > 64_000_000) throw new Error("Depth refinement output exceeds 64 million pixels.");
  return { width, height };
}
