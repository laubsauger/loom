import { describe, expect, it } from "vitest";
import { PHOTO_DEPTH_INPUT_SIDES } from "./preparation-sizes.ts";
import { DEFAULT_DEPTH_REFINEMENT, DEFAULT_PHOTO_DEPTH_RECIPE, DEFAULT_MARIGOLD_RECIPE,
  MARIGOLD_MODEL_ID, MARIGOLD_BUNDLE_ID, MARIGOLD_INPUT_SIDES, depthInferenceKey, depthRecipeKey,
  depthRefinementSize, photoDepthInputSize, photoDepthRecipeSchema, depthRecipeParameters, depthRecipeFromParameters, type PhotoDepthRecipe,
  DEFAULT_DEPTH_PRO2_RECIPE, DEPTH_PRO2_PHOTO_SIDES } from "./photo-depth-recipe.ts";

const refined = (target: NonNullable<PhotoDepthRecipe["refinement"]>["target"] = "source"): Extract<PhotoDepthRecipe, { version: 1 }> => ({
  ...DEFAULT_PHOTO_DEPTH_RECIPE, refinement: { ...DEFAULT_DEPTH_REFINEMENT, target },
});

describe("photo depth preparation recipe", () => {
  it("round trips graph fields and preserves the explicit legacy defaults", () => {
    const recipe = { ...refined("2048"), modelId: "depth-anything-v2-large-fp16", backend: "webgpu" as const };
    expect(depthRecipeFromParameters(depthRecipeParameters(recipe))).toEqual(recipe);
    expect(depthRecipeFromParameters({ inputSide: "1036" })).toEqual({ ...DEFAULT_PHOTO_DEPTH_RECIPE, inputSide: 1036 });
    expect(depthRecipeFromParameters({})).toEqual(DEFAULT_PHOTO_DEPTH_RECIPE);
    expect(() => depthRecipeFromParameters({ depthBackend: "auto" })).toThrow();
  });
  it("refuses nonstatic preparation settings instead of reading retained static values", () => {
    expect(() => depthRecipeFromParameters({ refinementTarget: "source", refineRadius: { mode: "expression", bindings: { static: { kind: "static", value: 2 } } } })).toThrow(/refineRadius requires static mode/);
  });
  it("accepts existing native input sizes and both explicit backends", () => {
    for (const inputSide of PHOTO_DEPTH_INPUT_SIDES) for (const backend of ["wasm", "webgpu"] as const) {
      expect(photoDepthRecipeSchema.parse({ ...refined(), inputSide, backend }).inputSide).toBe(inputSide);
    }
    expect(photoDepthRecipeSchema.parse(DEFAULT_PHOTO_DEPTH_RECIPE)).toEqual(DEFAULT_PHOTO_DEPTH_RECIPE);
  });

  it.each([
    { version: 2 }, { modelId: "" }, { inputSide: 512 }, { inputSide: 518.5 }, { backend: "auto" },
    { unexpected: true }, { refinement: undefined },
  ])("rejects invalid or extra recipe fields: %j", change => {
    expect(photoDepthRecipeSchema.safeParse({ ...DEFAULT_PHOTO_DEPTH_RECIPE, ...change }).success).toBe(false);
  });

  it.each([
    { target: "8192" }, { radius: 0 }, { radius: 5 }, { radius: 1.5 },
    { spatialSigma: 0 }, { spatialSigma: 9 }, { spatialSigma: Infinity }, { spatialSigma: NaN },
    { colorSigma: 0 }, { colorSigma: 1.01 }, { colorSigma: Infinity }, { unexpected: true },
  ])("rejects invalid or extra refinement fields: %j", change => {
    expect(photoDepthRecipeSchema.safeParse({ ...refined(), refinement: { ...DEFAULT_DEPTH_REFINEMENT, ...change } }).success).toBe(false);
  });

  it("keys every inference choice deterministically regardless of field insertion order", () => {
    const recipe = refined();
    const reordered = { refinement: { colorSigma: 0.1, spatialSigma: 2, radius: 2, target: "source" as const },
      backend: recipe.backend, inputSide: recipe.inputSide, modelId: recipe.modelId, version: recipe.version };
    expect(depthRecipeKey(reordered)).toBe(depthRecipeKey(recipe));
    expect(depthInferenceKey(reordered)).toBe(depthInferenceKey(recipe));
    for (const change of [{ modelId: "depth-anything-v2-large" }, { inputSide: 1036 }, { backend: "webgpu" as const }]) {
      expect(depthRecipeKey({ ...recipe, ...change })).not.toBe(depthRecipeKey(recipe));
      expect(depthInferenceKey({ ...recipe, ...change })).not.toBe(depthInferenceKey(recipe));
    }
  });

  it("keys refinement choices while retaining the native inference identity", () => {
    const recipe = refined();
    const variants: PhotoDepthRecipe[] = [DEFAULT_PHOTO_DEPTH_RECIPE,
      ...[{ target: "2048" as const }, { radius: 3 }, { spatialSigma: 4 }, { colorSigma: 0.2 }].map(change => ({
        ...recipe, refinement: { ...DEFAULT_DEPTH_REFINEMENT, ...change },
      }))];
    for (const variant of variants) {
      expect(depthRecipeKey(variant)).not.toBe(depthRecipeKey(recipe));
      expect(depthInferenceKey(variant)).toBe(depthInferenceKey(recipe));
    }
  });

  it("preserves source resolution and rounded landscape or portrait aspect", () => {
    expect(depthRefinementSize(refined(), 4096, 3072, 16384)).toEqual({ width: 4096, height: 3072 });
    expect(depthRefinementSize(refined("2048"), 6000, 4000, 16384)).toEqual({ width: 2048, height: 1365 });
    expect(depthRefinementSize(refined("4096"), 4000, 6000, 16384)).toEqual({ width: 2731, height: 4096 });
    expect(depthRefinementSize(refined("2048"), 10000, 1, 16384)).toEqual({ width: 2048, height: 1 });
  });

  it("allows refinement above the source resolution while enforcing output edge and pixel limits", () => {
    expect(() => depthRefinementSize(DEFAULT_PHOTO_DEPTH_RECIPE, 4096, 2048, 16384)).toThrow(/not selected/);
    expect(depthRefinementSize(refined("4096"), 2048, 1024, 16384)).toEqual({ width: 4096, height: 2048 });
    expect(() => depthRefinementSize(refined(), 4096, 2048, 2048)).toThrow(/output edge/);
    expect(() => depthRefinementSize(refined("4096"), 6000, 3000, 2048)).toThrow(/output edge/);
    expect(depthRefinementSize(refined(), 8000, 8000, 16384)).toEqual({ width: 8000, height: 8000 });
    expect(() => depthRefinementSize(refined(), 8001, 8000, 16384)).toThrow(/64 million/);
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("rejects invalid dimensions or output limits: %s", dimension => {
    expect(() => depthRefinementSize(refined(), dimension, 2000, 16384)).toThrow(/Source width/);
    expect(() => depthRefinementSize(refined(), 2000, dimension, 16384)).toThrow(/Source height/);
    expect(() => depthRefinementSize(refined(), 2000, 2000, dimension)).toThrow(/Maximum output edge/);
  });

  it("preserves exact legacy recipe keys and ignores inactive native graph fields", () => {
    expect(depthInferenceKey(DEFAULT_PHOTO_DEPTH_RECIPE)).toBe('[1,"depth-anything-v2-small",518,"wasm"]');
    expect(depthRecipeParameters(DEFAULT_PHOTO_DEPTH_RECIPE)).toEqual({ depthModel: "depth-anything-v2-small",
      depthBackend: "wasm", inputSide: "518", refinementTarget: "off", refineRadius: 2,
      refineSpatialSigma: 2, refineColorSigma: 0.1 });
    expect(depthRecipeFromParameters({ depthSeed: 42, depthBundle: MARIGOLD_BUNDLE_ID })).toEqual(DEFAULT_PHOTO_DEPTH_RECIPE);
  });

  it("round trips native recipe seed and bundle through graph parameters", () => {
    for (const inputSide of MARIGOLD_INPUT_SIDES) {
      const recipe = { ...DEFAULT_MARIGOLD_RECIPE, inputSide, seed: 0xffffffff,
        refinement: { ...DEFAULT_DEPTH_REFINEMENT, target: "2048" as const } };
      expect(depthRecipeFromParameters(depthRecipeParameters(recipe))).toEqual(recipe);
      expect(photoDepthRecipeSchema.parse(recipe)).toEqual(recipe);
    }
    expect(depthRecipeFromParameters({ depthModel: MARIGOLD_MODEL_ID, depthBackend: "mlx" })).toEqual(DEFAULT_MARIGOLD_RECIPE);
    expect(() => depthRecipeFromParameters({ depthModel: MARIGOLD_MODEL_ID })).toThrow();
    expect(() => depthRecipeFromParameters({ depthModel: MARIGOLD_MODEL_ID, depthBackend: "wasm" })).toThrow();
    expect(() => depthRecipeFromParameters({ ...depthRecipeParameters(DEFAULT_MARIGOLD_RECIPE), depthBundle: "" })).toThrow();
  });

  it.each([
    { version: 1 }, { modelId: "marigold-v1" }, { backend: "webgpu" }, { inputSide: 518 },
    { inputSide: 2048 }, { seed: undefined }, { seed: -1 }, { seed: 0x100000000 }, { seed: 1.5 },
    { seed: NaN }, { seed: Infinity }, { bundleId: undefined }, { bundleId: "other-revision" }, { extra: true },
  ])("rejects unsupported or incomplete native recipe: %j", change => {
    expect(photoDepthRecipeSchema.safeParse({ ...DEFAULT_MARIGOLD_RECIPE, ...change }).success).toBe(false);
  });

  it("native inference identity includes seed and the pinned bundle", () => {
    const recipe = DEFAULT_MARIGOLD_RECIPE;
    expect(depthInferenceKey(recipe)).toBe(JSON.stringify([2, MARIGOLD_MODEL_ID, 512, "mlx", 2025, MARIGOLD_BUNDLE_ID]));
    for (const change of [{ seed: 42 }, { inputSide: 768 as const }]) {
      expect(depthInferenceKey({ ...recipe, ...change })).not.toBe(depthInferenceKey(recipe));
      expect(depthRecipeKey({ ...recipe, ...change })).not.toBe(depthRecipeKey(recipe));
    }
    const refinedNative = { ...recipe, refinement: DEFAULT_DEPTH_REFINEMENT };
    expect(depthInferenceKey(refinedNative)).toBe(depthInferenceKey(recipe));
    expect(depthRecipeKey(refinedNative)).not.toBe(depthRecipeKey(recipe));
    expect(() => depthInferenceKey({ ...recipe, bundleId: "other-revision" } as unknown as PhotoDepthRecipe)).toThrow();
  });

  it.each(["depthSeed", "depthBundle"])("refuses nonstatic native setting %s", key => {
    expect(() => depthRecipeFromParameters({ ...depthRecipeParameters(DEFAULT_MARIGOLD_RECIPE),
      [key]: { mode: "expression", bindings: { static: { kind: "static", value: 2025 } } } })).toThrow(new RegExp(`${key} requires static mode`));
  });

  it("records native inference rectangles with upward 16-pixel padding", () => {
    expect(photoDepthInputSize(DEFAULT_PHOTO_DEPTH_RECIPE, 6000, 4000)).toEqual({ width: 518, height: 518 });
    expect(photoDepthInputSize(DEFAULT_MARIGOLD_RECIPE, 6000, 4000)).toEqual({ width: 512, height: 352 });
    expect(photoDepthInputSize(DEFAULT_MARIGOLD_RECIPE, 4000, 6000)).toEqual({ width: 352, height: 512 });
    expect(photoDepthInputSize(DEFAULT_MARIGOLD_RECIPE, 2000, 2000)).toEqual({ width: 512, height: 512 });
    expect(photoDepthInputSize({ ...DEFAULT_MARIGOLD_RECIPE, inputSide: 768 }, 6000, 4000)).toEqual({ width: 768, height: 512 });
    expect(photoDepthInputSize({ ...DEFAULT_MARIGOLD_RECIPE, inputSide: 1024 }, 1, 10000)).toEqual({ width: 16, height: 1024 });
    expect(depthRefinementSize({ ...DEFAULT_MARIGOLD_RECIPE, refinement: DEFAULT_DEPTH_REFINEMENT }, 4096, 3072, 16384)).toEqual({ width: 4096, height: 3072 });
  });

  it.each([0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1])("refuses invalid inference source dimensions: %s", dimension => {
    for (const recipe of [DEFAULT_PHOTO_DEPTH_RECIPE, DEFAULT_MARIGOLD_RECIPE]) {
      expect(() => photoDepthInputSize(recipe, dimension, 2000)).toThrow(/Source width/);
      expect(() => photoDepthInputSize(recipe, 2000, dimension)).toThrow(/Source height/);
    }
  });
});

/**
 * T1817b — the Depth Pro 2 recipe. Its field of view is an INFERENCE input (the model
 * scales every metre by the focal length), so it belongs to the native identity: a map
 * prepared at 60° must read out of date once the node says 75°, and refining it must not.
 */
describe("the Depth Pro 2 photo recipe (T1817b)", () => {
  it("round trips through the node's parameters, field of view included, and a bare model id gets its defaults", () => {
    const recipe = { ...DEFAULT_DEPTH_PRO2_RECIPE, modelId: "depthpro2-b-fp16" as const, inputSide: 672 as const, fieldOfView: 82.5,
      refinement: { ...DEFAULT_DEPTH_REFINEMENT, target: "4096" as const } };
    expect(depthRecipeParameters(recipe)).toMatchObject({ depthModel: "depthpro2-b-fp16", inputSide: "672", depthFieldOfView: 82.5 });
    expect(depthRecipeFromParameters(depthRecipeParameters(recipe))).toEqual(recipe);
    expect(depthRecipeFromParameters({ depthModel: "depthpro2-s-fp32" })).toEqual(DEFAULT_DEPTH_PRO2_RECIPE);
    // A Depth Anything node never grows a field of view, and one left on it is not read.
    expect(depthRecipeParameters(DEFAULT_PHOTO_DEPTH_RECIPE)).not.toHaveProperty("depthFieldOfView");
    expect(depthRecipeFromParameters({ depthFieldOfView: 30 })).toEqual(DEFAULT_PHOTO_DEPTH_RECIPE);
  });

  it("keys the field of view as inference, and refinement as refinement only", () => {
    const at = (fieldOfView: number) => ({ ...DEFAULT_DEPTH_PRO2_RECIPE, fieldOfView });
    expect(depthInferenceKey(at(75))).not.toBe(depthInferenceKey(at(60)));
    expect(depthRecipeKey(at(75))).not.toBe(depthRecipeKey(at(60)));
    const refinedRecipe = { ...at(60), refinement: DEFAULT_DEPTH_REFINEMENT };
    expect(depthInferenceKey(refinedRecipe)).toBe(depthInferenceKey(at(60)));
    expect(depthRecipeKey(refinedRecipe)).not.toBe(depthRecipeKey(at(60)));
    // The same model at another box is another file, so another native map.
    expect(depthInferenceKey({ ...at(60), inputSide: 672 })).not.toBe(depthInferenceKey(at(60)));
  });

  it("takes the model's fixed box whatever the photo's shape: the photo is letterboxed into it", () => {
    expect(photoDepthInputSize(DEFAULT_DEPTH_PRO2_RECIPE, 6000, 4000)).toEqual({ width: 640, height: 480 });
    expect(photoDepthInputSize(DEFAULT_DEPTH_PRO2_RECIPE, 4000, 6000)).toEqual({ width: 640, height: 480 });
    expect(photoDepthInputSize({ ...DEFAULT_DEPTH_PRO2_RECIPE, inputSide: 672 }, 1920, 1080)).toEqual({ width: 672, height: 384 });
    expect(DEPTH_PRO2_PHOTO_SIDES).toEqual([640, 672]);
  });

  it.each([
    { inputSide: 518 }, { inputSide: 480 }, { modelId: "depthpro2-s-stream4-fp16" }, { modelId: "depth-anything-v2-small" },
    { backend: "mlx" }, { fieldOfView: 0.5 }, { fieldOfView: 171 }, { fieldOfView: NaN }, { fieldOfView: undefined },
    { seed: 1 }, { version: 1 },
  ])("rejects a Depth Pro 2 recipe it cannot run: %j", change => {
    expect(photoDepthRecipeSchema.safeParse({ ...DEFAULT_DEPTH_PRO2_RECIPE, ...change }).success).toBe(false);
  });
});
