import { describe, expect, it } from "vitest";
import { type FloatMap } from "./float-map.ts";
import { decodeDepthExr, encodeDepthExr } from "./depth-exr.ts";
import { beginMaskStroke, depthRecipeOf, makePreparedMap, paintMaskStroke, preparedMetadata, rasterizeFloatMap, withDepthRecipe,
  letterboxOccupancy, type PreparedDepthMetadataV2, type PreparedMapMetadataV1 } from "./prepared-map.ts";
import { DEFAULT_DEPTH_PRO2_RECIPE, DEFAULT_DEPTH_REFINEMENT, DEFAULT_PHOTO_DEPTH_RECIPE } from "../../domain/media/photo-depth-recipe.ts";
import { depthImageEnvelope } from "./depth-image-envelope.ts";

function input(kind: "depth" | "mask" = "depth", width = 6, height = 6): Omit<PreparedMapMetadataV1, "version" | "range"> {
  return {
    kind, source: { sha256: "a".repeat(64), width, height },
    model: { id: "test-model-v1", url: "https://models.example/model.onnx" },
    inputSide: 6, registration: kind === "depth" ? "letterbox" : "stretch",
  };
}

function withMetadata(map: FloatMap, patch: Record<string, unknown>): FloatMap {
  return { ...map, metadata: { preparation: { ...map.metadata!.preparation as Record<string, unknown>, ...patch } } };
}

describe("prepared maps", () => {
  it("keeps native signed float32 bits through preparation, raw sampling and reopening", () => {
    const values = new Float32Array([-0, 1, 1 + 2 ** -23, 1 + 2 ** -22, 2 ** -149, -17.75]);
    const bits = new Uint32Array(values.buffer).slice();
    const map = makePreparedMap(values, 3, 2, { ...input(), registration: "stretch" });
    const reopened = decodeDepthExr(encodeDepthExr(map));
    expect(new Uint32Array(map.values.buffer)).toEqual(bits);
    expect(new Uint32Array(reopened.values.buffer)).toEqual(bits);
    expect(new Uint32Array(rasterizeFloatMap(reopened, "raw", 3, 2).buffer)).toEqual(bits);
    expect(preparedMetadata(reopened)).toEqual(preparedMetadata(map));
    expect(map.values).not.toBe(values);
    values.fill(99);
    expect(new Uint32Array(map.values.buffer)).toEqual(bits);
  });

  it.each(["wide", "tall"] as const)("registers asymmetric %s depth without padding affecting its range or interpolation", (orientation) => {
    const values = new Float32Array(36);
    for (let y = 0; y < 6; y += 1) {
      for (let x = 0; x < 6; x += 1) {
        const across = orientation === "wide" ? x : y;
        const band = orientation === "wide" ? y : x;
        values[y * 6 + x] = band === 0 ? -1000 : band === 5 ? 1000 : across + 10 * band;
      }
    }
    const map = makePreparedMap(values, 6, 6, input("depth", orientation === "wide" ? 4 : 2, orientation === "wide" ? 2 : 4));
    expect(preparedMetadata(map).range).toEqual({ low: 10, high: 45 });
    const samples = rasterizeFloatMap(map, "depth", orientation === "wide" ? 3 : 2, orientation === "wide" ? 2 : 3);
    const expected = orientation === "wide" ? [8, 10, 12, 23, 25, 27] : [8, 23, 10, 25, 12, 27];
    samples.forEach((sample, index) => expect(sample).toBeCloseTo(expected[index]! / 35, 6));
    expect(map.values).toEqual(values);
  });

  it("clamps bilinear sampling to occupied texels instead of bleeding letterbox artefacts", () => {
    const values = new Float32Array(36).fill(900);
    values.set([10, 12, 14, 16, 18, 20], 12);
    values.set([20, 22, 24, 26, 28, 30], 18);
    const map = makePreparedMap(values, 6, 6, input("depth", 3, 1));
    expect(preparedMetadata(map).range).toEqual({ low: 10, high: 30 });
    const samples = rasterizeFloatMap(map, "depth", 30, 30);
    expect(samples[0]).toBe(0);
    expect(samples[samples.length - 1]).toBe(1);
    expect(Math.min(...samples)).toBe(0);
    expect(Math.max(...samples)).toBe(1);
    const center = rasterizeFloatMap(map, "depth", 3, 1);
    expect([...center]).toEqual([Math.fround(0.3), 0.5, Math.fround(0.7)]);
  });

  it("treats flat depth as the mathematical midpoint without altering the base map", () => {
    const map = makePreparedMap(new Float32Array(4).fill(234.5), 2, 2, input());
    expect(preparedMetadata(map).range).toEqual({ low: 234.5, high: 234.5 });
    expect(rasterizeFloatMap(map, "depth", 3, 4)).toEqual(new Float32Array(12).fill(0.5));
    expect(map.values).toEqual(new Float32Array(4).fill(234.5));
  });

  it("bilinearly resamples raw values and mask confidence without color conversion or normalization", () => {
    const raw = { width: 2, height: 2, values: new Float32Array([-10, 2, 4, 16]) };
    expect([...rasterizeFloatMap(raw, "raw", 1, 1)]).toEqual([3]);
    const mask = makePreparedMap(new Float32Array([0.1, 0.2, 0.3, 0.4]), 2, 2, input("mask"));
    expect(preparedMetadata(mask).range).toEqual({ low: 0, high: 1 });
    expect(rasterizeFloatMap(mask, "mask", 1, 1)[0]).toBeCloseTo(0.25, 7);
    expect(rasterizeFloatMap(mask, "mask", 2, 2)).toEqual(mask.values);
  });

  it("paints a continuous native mask stroke while preserving untouched confidence and provenance", () => {
    const base = new Float32Array(35).fill(0.123456789);
    base[0] = -0;
    const mask = makePreparedMap(base, 7, 5, input("mask", 70, 50));
    const depth = makePreparedMap(new Float32Array([7, 8, 9, 10]), 2, 2, input());
    const depthBits = new Uint32Array(depth.values.buffer).slice();
    const painted = paintMaskStroke(mask, { x: 1, y: 2 }, { x: 5, y: 2 }, 0.6, 1);
    for (let y = 0; y < 5; y += 1) {
      for (let x = 0; x < 7; x += 1) {
        expect(Object.is(painted.values[y * 7 + x], y === 2 && x >= 1 && x <= 5 ? 1 : base[y * 7 + x])).toBe(true);
      }
    }
    expect(mask.values).toEqual(base);
    expect(preparedMetadata(painted)).toEqual(preparedMetadata(mask));
    expect(new Uint32Array(depth.values.buffer)).toEqual(depthBits);
    const erased = paintMaskStroke(painted, { x: 3, y: 2 }, { x: 3, y: 2 }, 0.5, 0);
    expect(erased.values[17]).toBe(0);
    expect(painted.values[17]).toBe(1);
    expect(erased.values[16]).toBe(1);
    expect(decodeDepthExr(encodeDepthExr(erased)).values).toEqual(erased.values);
  });

  it("owns one continuous gesture without altering undo snapshots and seals it on completion", () => {
    const original = makePreparedMap(new Float32Array(49).fill(0.123456789), 7, 7, input("mask"));
    const originalBits = new Uint32Array(original.values.buffer).slice();
    const stroke = beginMaskStroke(original);
    const draft = stroke.paint({ x: 1, y: 1 }, { x: 5, y: 1 }, 0.6, 1);
    const continued = stroke.paint({ x: 5, y: 1 }, { x: 5, y: 5 }, 0.6, 0);
    expect(continued.values).toBe(draft.values);
    expect(new Uint32Array(original.values.buffer)).toEqual(originalBits);
    const finished = stroke.finish();
    expect(finished.values[8]).toBe(1);
    expect(finished.values[40]).toBe(0);
    expect(Object.is(finished.values[48], original.values[48])).toBe(true);
    expect(decodeDepthExr(encodeDepthExr(finished)).values).toEqual(finished.values);
    expect(() => stroke.paint({ x: 0, y: 0 }, { x: 0, y: 0 }, 1, 0)).toThrow(/already finished/);
    expect(() => stroke.finish()).toThrow(/already finished/);
    const next = beginMaskStroke(finished);
    next.paint({ x: 1, y: 1 }, { x: 1, y: 1 }, 0.6, 0);
    expect(finished.values[8]).toBe(1);
  });

  it("clips brushes to the map and fills diagonal strokes without gaps", () => {
    const mask = makePreparedMap(new Float32Array(25), 5, 5, input("mask"));
    const painted = paintMaskStroke(mask, { x: -2, y: -2 }, { x: 6, y: 6 }, 0.2, 1);
    expect([...painted.values]).toEqual([
      1, 0, 0, 0, 0,
      0, 1, 0, 0, 0,
      0, 0, 1, 0, 0,
      0, 0, 0, 1, 0,
      0, 0, 0, 0, 1,
    ]);
  });

  it.each([
    { version: 2 }, { kind: "picture" }, { registration: "auto" }, { extra: true },
    { source: { sha256: "unknown", width: 1, height: 1 } },
    { source: { sha256: "a".repeat(64), width: 0, height: 1 } },
    { source: { sha256: "a".repeat(64), width: 1, height: 1, crop: [] } },
    { model: { id: "", url: "model" } }, { model: { id: "model" } },
    { inputSide: 0 }, { inputSide: 1.5 }, { range: { low: NaN, high: 1 } },
    { range: { low: 2, high: 1 } }, { range: { low: 0, high: Infinity } },
  ])("rejects malformed provenance %j", (patch) => {
    const map = makePreparedMap(new Float32Array([1]), 1, 1, input());
    expect(() => preparedMetadata(withMetadata(map, patch))).toThrow(/Invalid prepared map/);
  });

  it("rejects absent provenance, mismatched interpretations and invalid prepared masks", () => {
    const raw = { width: 1, height: 1, values: new Float32Array([1]) };
    const depth = makePreparedMap(raw.values, 1, 1, input());
    expect(() => preparedMetadata(raw)).toThrow(/preparation metadata/);
    expect(() => rasterizeFloatMap(raw, "depth", 1, 1)).toThrow(/preparation metadata/);
    expect(() => rasterizeFloatMap(depth, "mask", 1, 1)).toThrow(/does not match/);
    expect(() => paintMaskStroke(depth, { x: 0, y: 0 }, { x: 0, y: 0 }, 1, 1)).toThrow(/prepared mask/);
    expect(() => makePreparedMap(new Float32Array([-0.1]), 1, 1, input("mask"))).toThrow(/probabilities/);
    expect(() => makePreparedMap(new Float32Array([1.1]), 1, 1, input("mask"))).toThrow(/probabilities/);
    expect(() => makePreparedMap(raw.values, 1, 1, { ...input("mask"), registration: "letterbox" })).toThrow(/mask registration/);
    const mask = makePreparedMap(raw.values, 1, 1, input("mask"));
    expect(() => preparedMetadata(withMetadata(mask, { range: { low: 0.1, high: 1 } }))).toThrow(/mask range/);
  });

  it("rejects nonfinite samples, invalid dimensions and bands too narrow to represent", () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      expect(() => makePreparedMap(new Float32Array([value]), 1, 1, input())).toThrow(/finite/);
    }
    expect(() => makePreparedMap(new Float32Array([1]), 0, 1, input())).toThrow(/positive integer/);
    expect(() => makePreparedMap(new Float32Array([1]), 2, 1, input())).toThrow(/sample count/);
    expect(() => makePreparedMap(new Float32Array([1]), 8001, 8000, input())).toThrow(/dimensions/);
    expect(() => makePreparedMap(new Float32Array(4), 2, 2, input("depth", 1000, 1))).toThrow(/no native samples/);
    const map = makePreparedMap(new Float32Array([1]), 1, 1, input());
    expect(() => rasterizeFloatMap(map, "raw", 0, 1)).toThrow(/positive integer/);
    expect(() => rasterizeFloatMap({ ...map, values: new Float32Array([NaN]) }, "raw", 1, 1)).toThrow(/finite/);
  });

  it.each([0, -1, NaN, Infinity])("rejects invalid brush radius %s", (radius) => {
    const map = makePreparedMap(new Float32Array([0.5]), 1, 1, input("mask"));
    expect(() => paintMaskStroke(map, { x: 0, y: 0 }, { x: 0, y: 0 }, radius, 1)).toThrow(/brush|finite/);
    expect(map.values[0]).toBe(0.5);
  });

  it("rejects nonfinite brush coordinates, overflow and invalid paint values", () => {
    const map = makePreparedMap(new Float32Array([0.5]), 1, 1, input("mask"));
    expect(() => paintMaskStroke(map, { x: NaN, y: 0 }, { x: 0, y: 0 }, 1, 1)).toThrow(/finite/);
    expect(() => paintMaskStroke(map, { x: -Number.MAX_VALUE, y: 0 }, { x: Number.MAX_VALUE, y: 0 }, 1, 1)).toThrow(/brush length/);
    expect(() => paintMaskStroke(map, { x: 0, y: 0 }, { x: 0, y: 0 }, 1, 0.5 as 0)).toThrow(/brush value/);
    expect(map.values[0]).toBe(0.5);
  });
});

describe("versioned depth preparation recipes", () => {
  function native() {
    const values = new Float32Array([-0, 1 + 2 ** -23, 2 ** -149, -17.75]);
    return makePreparedMap(values, 2, 2, { ...input("depth", 2, 2), inputSide: 518, registration: "stretch",
      model: { id: DEFAULT_PHOTO_DEPTH_RECIPE.modelId, url: "https://models.example/pinned/model.onnx" } });
  }
  const parent = { sha256: "b".repeat(64), width: 518, height: 518 };
  const refinedRecipe = { ...DEFAULT_PHOTO_DEPTH_RECIPE, refinement: { ...DEFAULT_DEPTH_REFINEMENT } };

  it("attaches and reopens a native recipe without changing any stored scalar bits", () => {
    const legacy = native(), original = encodeDepthExr(legacy);
    const attached = withDepthRecipe(legacy, DEFAULT_PHOTO_DEPTH_RECIPE);
    const bits = new Uint32Array(legacy.values.buffer).slice();
    expect(preparedMetadata(attached)).toMatchObject({ version: 2, semantics: "inverse-relative", stage: "native", parent: null,
      recipe: DEFAULT_PHOTO_DEPTH_RECIPE, range: preparedMetadata(legacy).range });
    const reopened = decodeDepthExr(encodeDepthExr(attached));
    expect(depthRecipeOf(reopened)).toEqual(DEFAULT_PHOTO_DEPTH_RECIPE);
    expect(preparedMetadata(reopened)).toEqual(preparedMetadata(attached));
    expect(new Uint32Array(reopened.values.buffer)).toEqual(bits);
    expect(new Uint32Array(rasterizeFloatMap(reopened, "raw", 2, 2).buffer)).toEqual(bits);
    expect(encodeDepthExr(legacy)).toEqual(original);
  });

  it("reads strict version-one depth as its explicit legacy WASM recipe without rewriting metadata", () => {
    const legacy = native(), before = encodeDepthExr(legacy);
    const reopened = decodeDepthExr(before);
    expect(preparedMetadata(reopened).version).toBe(1);
    expect(depthRecipeOf(reopened)).toEqual(DEFAULT_PHOTO_DEPTH_RECIPE);
    expect(encodeDepthExr(reopened)).toEqual(before);
    expect(() => preparedMetadata(withMetadata(legacy, { recipe: DEFAULT_PHOTO_DEPTH_RECIPE }))).toThrow(/exactly/);
    const mask = makePreparedMap(new Float32Array([1]), 1, 1, input("mask"));
    expect(() => depthRecipeOf(mask)).toThrow(/depth map/);
    expect(() => withDepthRecipe(mask, DEFAULT_PHOTO_DEPTH_RECIPE)).toThrow(/depth map/);
  });

  it.each([
    { recipe: { ...DEFAULT_PHOTO_DEPTH_RECIPE, version: 2 } },
    { recipe: { ...DEFAULT_PHOTO_DEPTH_RECIPE, unexpected: true } },
    { recipe: { ...DEFAULT_PHOTO_DEPTH_RECIPE, modelId: "another-model" } },
    { recipe: { ...DEFAULT_PHOTO_DEPTH_RECIPE, inputSide: 1036 } },
    { recipe: refinedRecipe }, { parent }, { stage: "unknown" },
    { stage: "refined" }, { semantics: "metric" },
    { kind: "mask", range: { low: 0, high: 1 } },
  ])("refuses mismatched native recipe or stage provenance: %j", patch => {
    const map = withDepthRecipe(native(), DEFAULT_PHOTO_DEPTH_RECIPE);
    expect(() => preparedMetadata(withMetadata(map, patch))).toThrow(/Invalid prepared map/);
  });

  it.each([
    { registration: "letterbox" }, { parent: null },
    { parent: { ...parent, sha256: "missing" } }, { parent: { ...parent, width: 0 } },
    { parent: { ...parent, height: 1.5 } }, { parent: { ...parent, path: "parent.loom.exr" } },
    { recipe: DEFAULT_PHOTO_DEPTH_RECIPE }, { stage: "native" },
  ])("refuses incomplete refined parent or registration: %j", patch => {
    const map = withDepthRecipe(native(), refinedRecipe, parent);
    expect(() => preparedMetadata(withMetadata(map, patch))).toThrow(/Invalid prepared map/);
  });

  it("retains refined registration, parent and recipe while normalizing only the working depth copy", () => {
    const map = makePreparedMap(new Float32Array([-2, 0, 2]), 3, 1, { ...input("depth", 3, 1), inputSide: 518,
      registration: "stretch", model: { id: DEFAULT_PHOTO_DEPTH_RECIPE.modelId, url: "https://models.example/pinned/model.onnx" } });
    const refined = withDepthRecipe(map, refinedRecipe, parent);
    const original = encodeDepthExr(refined);
    expect([...rasterizeFloatMap(refined, "depth", 3, 1)]).toEqual([0, 0.5, 1]);
    expect([...rasterizeFloatMap(refined, "raw", 3, 1)]).toEqual([-2, 0, 2]);
    const reopened = decodeDepthExr(original);
    expect(preparedMetadata(reopened)).toMatchObject({ version: 2, stage: "refined", parent, recipe: refinedRecipe, registration: "stretch" });
    expect(encodeDepthExr(refined)).toEqual(original);
  });
  it("rejects a refined payload whose dimensions misrepresent its recorded target", () => {
    const map = withDepthRecipe(native(), refinedRecipe, parent);
    expect(() => preparedMetadata({ ...map, width: 1, height: 4 })).toThrow(/refined dimensions/);
    expect(() => withDepthRecipe(native(), { ...refinedRecipe, refinement: { ...DEFAULT_DEPTH_REFINEMENT, target: "4096" } }, parent)).toThrow(/refined dimensions/);
  });

  it.each(["relative-linear", "relative-log"] as const)("adapts future %s depth direction only in the working copy", semantics => {
    const map = makePreparedMap(new Float32Array([10, 20, 30]), 3, 1, { ...input(), inputSide: 518,
      registration: "stretch", model: { id: DEFAULT_PHOTO_DEPTH_RECIPE.modelId, url: "https://models.example/pinned/model.onnx" } });
    const prepared = withDepthRecipe(map, DEFAULT_PHOTO_DEPTH_RECIPE, null, semantics);
    const original = encodeDepthExr(prepared);
    expect([...rasterizeFloatMap(prepared, "depth", 3, 1)]).toEqual([1, 0.5, 0]);
    expect([...rasterizeFloatMap(prepared, "raw", 3, 1)]).toEqual([10, 20, 30]);
    const reopened = decodeDepthExr(original);
    expect((preparedMetadata(reopened) as PreparedDepthMetadataV2).semantics).toBe(semantics);
    expect(encodeDepthExr(prepared)).toEqual(original);
  });
});

/**
 * T1817b — DEPTH PRO 2'S MAPS: a non-square letterbox, and the first depth with a unit.
 *
 * A 4:3 box holding a 16:9 photo (1920 × 1080): the photo covers the full width and 3/4 of
 * the height, rows 60–419 of 480. The square rule every Depth Anything map uses would put
 * the band at rows 105–374 and read the bars as depth.
 */
describe("Depth Pro 2 prepared maps (T1817b)", () => {
  const source = { sha256: "b".repeat(64), width: 1920, height: 1080 };
  function nativeMetric(fill: (x: number, y: number) => number = () => 0.25): FloatMap {
    const values = Float32Array.from({ length: 640 * 480 }, (_, index) => fill(index % 640, Math.floor(index / 640)));
    const map = makePreparedMap(values, 640, 480, { kind: "depth", source,
      model: { id: "depthpro2-s-fp32", url: "https://models.example/model.onnx" }, inputSide: 640, registration: "letterbox" });
    return withDepthRecipe(map, DEFAULT_DEPTH_PRO2_RECIPE, null, "inverse-metric");
  }

  it("finds the photo's band in the box's own aspect, so the bars stay out of the range", () => {
    // Bars at 10 /m; the band 0.1 /m at its top row (60) and 0.5 /m below it.
    const map = nativeMetric((_x, y) => y < 60 || y > 419 ? 10 : y === 60 ? 0.1 : 0.5);
    expect(letterboxOccupancy(map, preparedMetadata(map))).toEqual([1, 0.75]);
    expect(preparedMetadata(map).range).toEqual({ low: Math.fround(0.1), high: 0.5 });
    // Depth Anything's square box is the same rule at aspect 1: 16:9 in a square fills 9/16.
    const square = makePreparedMap(new Float32Array(36), 6, 6, { ...input(), source });
    expect(letterboxOccupancy(square, preparedMetadata(square))).toEqual([1, 1080 / 1920]);
  });

  it("samples the band, never a bar, when resampled into the photo's frame", () => {
    const map = nativeMetric((_x, y) => y < 60 || y > 419 ? 10 : 0.1 + 0.4 * (y - 60) / 359);
    const raw = rasterizeFloatMap(map, "raw", 640, 480);
    expect(raw[0]).toBe(map.values[0]); // raw at native size is the samples as saved
    const depth = rasterizeFloatMap(map, "depth", 16, 9);
    // A sampled bar would read (10 − 0.1) / 0.4 ≈ 25 in the normalized view.
    expect(Math.min(...depth)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...depth)).toBeLessThanOrEqual(1);
  });

  it("reads inverse metres as nearer-is-higher, as Depth Anything's maps read, and exports them unflipped", () => {
    const map = nativeMetric((x) => (x < 320 ? 0.5 : 0.1));
    const [left, right] = rasterizeFloatMap(map, "depth", 2, 1);
    expect([left, right]).toEqual([1, 0]);
    expect(depthImageEnvelope(map, "unorm16").inverse).toBe(false);
  });

  it("refuses a metric map that is not Depth Pro 2's, a Depth Pro 2 map that is not metric, a wrong box or a negative 1/m", () => {
    const map = nativeMetric();
    expect(() => preparedMetadata(withMetadata(map, { semantics: "inverse-relative" }))).toThrow(/metric depth semantics/);
    expect(() => preparedMetadata(withMetadata(map, { recipe: { ...DEFAULT_PHOTO_DEPTH_RECIPE, modelId: "depthpro2-s-fp32", inputSide: 518 }, inputSide: 518 }))).toThrow(/metric depth semantics/);
    const stretched = makePreparedMap(new Float32Array(640 * 480).fill(0.25), 640, 480, { kind: "depth", source,
      model: { id: "depthpro2-s-fp32", url: "x" }, inputSide: 640, registration: "stretch" });
    expect(() => withDepthRecipe(stretched, DEFAULT_DEPTH_PRO2_RECIPE, null, "inverse-metric")).toThrow(/letterbox registration/);
    const small = makePreparedMap(new Float32Array(640 * 360).fill(0.25), 640, 360, { kind: "depth", source,
      model: { id: "depthpro2-s-fp32", url: "x" }, inputSide: 640, registration: "letterbox" });
    expect(() => withDepthRecipe(small, DEFAULT_DEPTH_PRO2_RECIPE, null, "inverse-metric")).toThrow(/dimensions/);
    const negative = makePreparedMap(new Float32Array(640 * 480).fill(-0.25), 640, 480, { kind: "depth", source,
      model: { id: "depthpro2-s-fp32", url: "x" }, inputSide: 640, registration: "letterbox" });
    expect(() => withDepthRecipe(negative, DEFAULT_DEPTH_PRO2_RECIPE, null, "inverse-metric")).toThrow(/cannot be negative/);
    expect(() => withDepthRecipe(negative, { ...DEFAULT_PHOTO_DEPTH_RECIPE, inputSide: 640 } as never)).toThrow();
  });

  it("keeps its unit and recipe through the .loom.exr file", () => {
    const map = nativeMetric();
    const reopened = decodeDepthExr(encodeDepthExr(map));
    expect(preparedMetadata(reopened)).toEqual(preparedMetadata(map));
    expect(preparedMetadata(reopened)).toMatchObject({ semantics: "inverse-metric", recipe: DEFAULT_DEPTH_PRO2_RECIPE });
  });
});
