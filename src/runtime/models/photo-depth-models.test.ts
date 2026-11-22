import { describe, expect, it } from "vitest";
import { DEFAULT_DEPTH_PRO2_RECIPE, DEPTH_PRO2_PHOTO_BOXES, DEPTH_PRO2_PHOTO_MODEL_IDS } from "../../domain/media/photo-depth-recipe.ts";
import { DEPTH_PRO2_B, DEPTH_PRO2_S, DEPTH_PRO2_WIDE } from "./model-catalogue.ts";
import { PHOTO_DEPTH_PRO2_MODELS, photoDepthPro2Descriptor, photoDepthUnavailableReason } from "./photo-depth-models.ts";
import { signatureFor } from "./model-signatures.ts";

/**
 * T1817b: which Depth Pro 2 file a photo recipe runs, and when it may run at all. The
 * domain names the models by id because it cannot import the catalogue; this pins the two
 * lists together and the box each file was exported at.
 */
describe("Depth Pro 2 for photo preparation (T1817b)", () => {
  it("names the catalogue's single-frame builds, and each box's file was exported at that box", () => {
    expect(PHOTO_DEPTH_PRO2_MODELS.map(model => model.id)).toEqual([...DEPTH_PRO2_PHOTO_MODEL_IDS]);
    for (const modelId of DEPTH_PRO2_PHOTO_MODEL_IDS) {
      for (const inputSide of [640, 672] as const) {
        const descriptor = photoDepthPro2Descriptor({ ...DEFAULT_DEPTH_PRO2_RECIPE, modelId, inputSide });
        const { width, height } = DEPTH_PRO2_PHOTO_BOXES[inputSide];
        expect(signatureFor(descriptor.id)?.input, descriptor.id).toMatchObject({ name: "pixel_values" });
        expect(signatureFor(descriptor.id)?.input.shape, descriptor.id)
          .toEqual(["1", "3", String(height), String(width)]);
      }
    }
    expect(photoDepthPro2Descriptor({ ...DEFAULT_DEPTH_PRO2_RECIPE, inputSide: 672 })).toBe(DEPTH_PRO2_WIDE[DEPTH_PRO2_S.id]);
    expect(photoDepthPro2Descriptor({ ...DEFAULT_DEPTH_PRO2_RECIPE, modelId: "depthpro2-b-fp16" })).toBe(DEPTH_PRO2_B);
  });

  it("says why it cannot run: no WebGPU, or B on the CPU; and runs S anywhere", () => {
    const recipe = DEFAULT_DEPTH_PRO2_RECIPE;
    expect(photoDepthUnavailableReason(recipe, true)).toBeNull();
    expect(photoDepthUnavailableReason(recipe, false)).toMatch(/WebGPU inference is unavailable/);
    expect(photoDepthUnavailableReason({ ...recipe, backend: "wasm" }, false)).toBeNull();
    expect(photoDepthUnavailableReason({ ...recipe, modelId: "depthpro2-b-fp16", backend: "wasm" }, true)).toMatch(/half-precision/);
  });
});
