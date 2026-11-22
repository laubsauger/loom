import { PHOTO_DEPTH_INPUT_SIDES } from "../../domain/media/preparation-sizes.ts";
import { DEPTH_PRO2_PHOTO_SIDES, MARIGOLD_INPUT_SIDES, MARIGOLD_MODEL_ID, isDepthPro2PhotoModel, type PhotoDepthRecipe } from "../../domain/media/photo-depth-recipe.ts";
import { DEPTH_PRO2_B, DEPTH_PRO2_S, DEPTH_PRO2_WIDE, PHOTO_DEPTH_MODELS, PHOTO_DEPTH_LARGE_FP16, PHOTO_DEPTH_LARGE_Q4F16 } from "./model-catalogue.ts";
import type { ModelDescriptor } from "./model-acquisition.ts";

/**
 * T1817b — the Depth Pro 2 builds photo preparation offers: the two SINGLE-FRAME ones. A
 * photo has no previous frame, so a stream build would only carry an empty cache. Each
 * has a 4:3 and a 16:9 file; the recipe's box picks one.
 */
export const PHOTO_DEPTH_PRO2_MODELS: readonly ModelDescriptor[] = [DEPTH_PRO2_S, DEPTH_PRO2_B];

/** Every file a Depth Pro 2 photo recipe can name, for acquisition and its progress labels. */
export const PHOTO_DEPTH_PRO2_FILES: readonly ModelDescriptor[] = PHOTO_DEPTH_PRO2_MODELS.flatMap(model => [model, DEPTH_PRO2_WIDE[model.id]!]);

/** The file a Depth Pro 2 recipe runs: the 4:3 build at 640, the 16:9 build at 672. */
export function photoDepthPro2Descriptor(recipe: Extract<PhotoDepthRecipe, { version: 3 }>): ModelDescriptor {
  const base = PHOTO_DEPTH_PRO2_MODELS.find(model => model.id === recipe.modelId);
  if (base === undefined) throw new Error(`Depth Pro 2 has no photo build named ${recipe.modelId}.`);
  return recipe.inputSide === 640 ? base : DEPTH_PRO2_WIDE[base.id]!;
}

/** Large GPU sizes passed the shipped worker on M3 Max / Chrome 151, 2026-10-09.
 * CPU proof is deliberately limited to 266/518; no automatic provider substitution. */
export function photoDepthSidesFor(modelId: string, backend: PhotoDepthRecipe["backend"]): readonly number[] {
  if (modelId === MARIGOLD_MODEL_ID) return backend === "mlx" ? MARIGOLD_INPUT_SIDES : [];
  // B is FP16: the CPU has no native half floats, and S's FP16 stream took 78 s a frame there.
  if (isDepthPro2PhotoModel(modelId)) return backend === "webgpu" || (backend === "wasm" && modelId === DEPTH_PRO2_S.id) ? DEPTH_PRO2_PHOTO_SIDES : [];
  if (backend === "mlx" || !PHOTO_DEPTH_MODELS.some(model => model.id === modelId)) return [];
  const large = modelId === PHOTO_DEPTH_LARGE_FP16.id || modelId === PHOTO_DEPTH_LARGE_Q4F16.id;
  return large && backend === "wasm" ? [266, 518] : PHOTO_DEPTH_INPUT_SIDES;
}

export function photoDepthUnavailableReason(recipe: PhotoDepthRecipe, webgpuAvailable: boolean, native?: { available: boolean; reason?: string; inputSides?: readonly number[] }): string | null {
  if (recipe.modelId === MARIGOLD_MODEL_ID) {
    if (native?.available !== true) return native?.reason ?? "Marigold V2 preparation requires Desktop on macOS with Apple Silicon.";
    if (native.inputSides !== undefined && !native.inputSides.includes(recipe.inputSide)) return "Restart the desktop app to enable this Marigold size. The running native process reports an older preparation capability.";
    return null;
  }
  if (recipe.version === 3) {
    if (recipe.backend === "webgpu" && !webgpuAvailable) return "WebGPU inference is unavailable in this browser. Depth Pro 2 S also runs on the CPU; B needs WebGPU.";
    if (recipe.backend === "wasm" && recipe.modelId !== DEPTH_PRO2_S.id) return "Depth Pro 2 B is a half-precision build, which takes minutes on the CPU. Choose GPU (WebGPU), or S on the CPU.";
    if (!photoDepthSidesFor(recipe.modelId, recipe.backend).includes(recipe.inputSide)) return "Depth Pro 2 takes a 640 × 480 or a 672 × 384 box.";
    return null;
  }
  if (!PHOTO_DEPTH_MODELS.some(model => model.id === recipe.modelId)) return "This saved map's model is not available for preparation. You can still reuse its verified map.";
  if (recipe.backend === "webgpu" && !webgpuAvailable) return "WebGPU inference is unavailable in this browser. Choose CPU explicitly or open Loom in a WebGPU-capable host.";
  if (!photoDepthSidesFor(recipe.modelId, recipe.backend).includes(recipe.inputSide)) return "This model, backend and input size combination has not been validated. Choose a supported input size.";
  return null;
}
