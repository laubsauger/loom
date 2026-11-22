import type { NodeDefinition } from "../../domain/types/node-definition.ts";
import { DEFAULT_DEPTH_PRO2_FIELD_OF_VIEW, DEPTH_PRO2_PHOTO_SIDES, depthPro2BoxLabel, MARIGOLD_MODEL_ID, MARIGOLD_BUNDLE_ID, isDepthPro2PhotoModel } from "../../domain/media/photo-depth-recipe.ts";
import { PHOTO_DEPTH_INPUT_SIDES } from "../../domain/media/preparation-sizes.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { wgsl } from "../../runtime/backend/wgsl.ts";
import { DATA_TEXTURE, RGBA_TEXTURE } from "./common-ports.ts";
import { PHOTO_DEPTH_MODELS } from "../../runtime/models/model-catalogue.ts";
import { PHOTO_DEPTH_PRO2_MODELS, photoDepthSidesFor } from "../../runtime/models/photo-depth-models.ts";
import { storedStaticValue } from "../../domain/parameters/slots.ts";
import type { StoredParameter, EnumParameter, ParameterSchema } from "../../domain/types/parameters.ts";
import { readCompileInputs } from "./compile-context.ts";

export const FLOAT_MAP_TEXTURE_KEY = "floatMap";

/** Shared identity for the numerical-image loader and its external texture. */
export function floatMapSourceIdFor(nodeId: string): string {
  return `${nodeId}:floatMap`;
}

// The loader resolves the image to the output dimensions before upload. Pixel coordinates
// read the corresponding sample exactly; neither colour transfer nor filtering applies.
const FLOAT_MAP_BLIT_WGSL = wgsl`@group(0) @binding(0) var floatMapTexture: texture_2d<f32>;

@fragment
fn fs(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let value = textureLoad(floatMapTexture, vec2i(position.xy), 0).r;
  return vec4f(value, 0.0, 0.0, 1.0);
}`;

const FLOAT_MAP_CONSTANT_WGSL = wgsl`struct Params {
  emptyValue: f32,
};
@group(0) @binding(0) var<uniform> params: Params;

@fragment
fn fs() -> @location(0) vec4f {
  return vec4f(params.emptyValue, 0.0, 0.0, 1.0);
}`;

const FLOAT_MAP_PARAMETERS: ParameterSchema = {
    file: {
      type: "asset", label: "Float map", kind: "binary", group: "File", compileTime: true,
      description: "Saved .loom.exr or numerical 16-bit PNG/TIFF/single-channel float EXR asset. Its numerical samples and preparation metadata are loaded without an image decoder or sRGB conversion.",
    },
    emptySource: {
      type: "enum", label: "Unassigned map", group: "File", default: "error", compileTime: true,
      options: [{ value: "error", label: "Require a file" }, { value: "constant", label: "Use constant until assigned" }],
      description: "Only an unassigned file can produce the explicit constant. A specified missing or corrupt file still reports its normal loading error.",
    },
    emptyValue: {
      type: "number", label: "Unassigned value", group: "File", default: 0.5, min: 0, max: 1, range: "soft", step: 0.01,
      description: "Finite numerical value produced only while the file is unassigned and Unassigned map is Constant. Assigning a file always loads its actual samples.",
      inactiveWhen: values => values["emptySource"] === "constant" && (values["file"] === undefined || values["file"] === "") ? null : "Applies only to an unassigned constant map.",
    },
    nativeMap: {
      type: "asset", label: "Native depth", kind: "binary", group: "Preparation",
      description: "Original float32 prediction retained separately from a refined depth map. A missing parent prevents refining again, but does not prevent the saved final map from rendering.",
      inactiveWhen: values => values["interpretation"] === "depth" ? null : "Native prediction applies only to prepared depth.",
    },
    depthModel: {
      type: "enum", label: "Depth model", group: "Preparation", default: "depth-anything-v2-small",
      options: [...[...PHOTO_DEPTH_MODELS, ...PHOTO_DEPTH_PRO2_MODELS].map(model => ({ value: model.id, label: `${model.label} (${(model.bytes / 1024 / 1024).toFixed(1)} MB)` })), { value: MARIGOLD_MODEL_ID, label: "Marigold V2 · mixed Q4/Q8 · Desktop" }, { value: "imported-depth", label: "Imported depth image" }],
      description: "Model for the next explicit preparation. Switching models marks an existing result out of date; it never starts inference. Depth Pro 2 is metric: it saves inverse metres (1/m, 0 for the sky) and its weights are licensed for research use only, not commercial or client work.",
      inactiveWhen: values => values["interpretation"] === "depth" ? null : "Model choice applies only to prepared depth.",
    },
    depthBackend: {
      type: "enum", label: "Depth backend", group: "Preparation", default: "wasm",
      options: [{ value: "wasm", label: "CPU (WASM)" }, { value: "webgpu", label: "GPU (WebGPU)" }, { value: "mlx", label: "Apple GPU (MLX)" }],
      description: "Explicit inference provider. A failed GPU run is reported without retrying on the CPU.",
      inactiveWhen: values => values["interpretation"] === "depth" ? null : "Backend choice applies only to prepared depth.",
    },
    depthFieldOfView: {
      type: "number", label: "Field of view", group: "Preparation", default: DEFAULT_DEPTH_PRO2_FIELD_OF_VIEW, min: 1, max: 170, range: "soft", step: 0.1, unit: "degrees",
      description: "Horizontal field of view of the reference photo, in degrees. Depth Pro 2 turns it into the focal length its metres are scaled by: a wider view reads nearer. Photo preparation fills it from the photo's 35 mm equivalent focal length when the file records one.",
      inactiveWhen: values => values["interpretation"] === "depth" && isDepthPro2PhotoModel(values["depthModel"]) ? null : "Field of view applies only to Depth Pro 2.",
    },
    depthSeed: {
      type: "number", label: "Depth seed", group: "Preparation", default: 2025, min: 0, max: 4294967295, step: 1,
      description: "Reproducible Marigold noise seed for the next explicit run. Changing it invalidates native depth and dependent refinement.",
      inactiveWhen: values => values["interpretation"] === "depth" && values["depthModel"] === MARIGOLD_MODEL_ID ? null : "Seed applies only to Marigold.",
    },
    depthBundle: {
      type: "enum", label: "Depth bundle", group: "Preparation", default: MARIGOLD_BUNDLE_ID,
      options: [{ value: MARIGOLD_BUNDLE_ID, label: "V2 Log stage 2 · MLX mixed Q4/Q8" }],
      description: "Pinned local model bundle used to prepare this artifact; rendering saved maps does not need the bundle.",
      inactiveWhen: values => values["interpretation"] === "depth" && values["depthModel"] === MARIGOLD_MODEL_ID ? null : "Bundle applies only to Marigold.",
    },
    refinementTarget: {
      type: "enum", label: "Refined output", group: "Preparation", default: "off",
      options: [{ value: "off", label: "Native prediction" }, { value: "source", label: "Source photo size" },
        { value: "2048", label: "2K long edge" }, { value: "4096", label: "4K long edge" }],
      description: "RGB-guided derived depth size for the next explicit refinement. Upscaling does not create a new native model prediction.",
      inactiveWhen: values => values["interpretation"] === "depth" ? null : "Refinement applies only to depth.",
    },
    refineRadius: {
      type: "number", label: "Refinement radius", group: "Preparation", default: 2, min: 1, max: 4, step: 1,
      description: "Neighborhood radius in each progressive refinement pass, measured in stage pixels.",
      inactiveWhen: values => values["interpretation"] === "depth" && values["refinementTarget"] !== "off" ? null : "Select a refined output first.",
    },
    refineSpatialSigma: {
      type: "number", label: "Refinement smoothing", group: "Preparation", default: 2, min: 0.25, max: 8, step: 0.25,
      description: "Spatial sigma for each depth refinement pass. Larger values smooth a wider neighborhood.",
      inactiveWhen: values => values["interpretation"] === "depth" && values["refinementTarget"] !== "off" ? null : "Select a refined output first.",
    },
    refineColorSigma: {
      type: "number", label: "Refinement edge sensitivity", group: "Preparation", default: 0.1, min: 0.005, max: 1, step: 0.005,
      description: "RGB guidance sigma. Lower values separate photograph edges more strongly; shadows and paint are not necessarily geometry.",
      inactiveWhen: values => values["interpretation"] === "depth" && values["refinementTarget"] !== "off" ? null : "Select a refined output first.",
    },
    interpretation: {
      type: "enum", label: "Interpretation", group: "Preparation", default: "raw",
      options: [
        { value: "raw", label: "Raw values" },
        { value: "depth", label: "Depth" },
        { value: "mask", label: "Mask" },
      ],
      description: "Raw exposes saved numerical values unchanged. Depth applies the saved depth normalization during loading. Mask exposes coverage. Interpretation does not rerun inference or modify the saved base samples.",
    },
    photo: {
      type: "asset", label: "Reference photo", kind: "image", group: "Preparation",
      description: "Source photo used only when Prepare / rerun is requested. Changing the photo does not regenerate or overwrite the saved map automatically.",
      inactiveWhen: values => values["interpretation"] === "depth" || values["interpretation"] === "mask" ? null : "Raw values load an existing map without photo preparation.",
    },
    inputSide: {
      type: "enum", label: "Depth input size", group: "Preparation", default: "518",
      options: [...PHOTO_DEPTH_INPUT_SIDES.map(side => ({ value: String(side), label: side === 518 ? "518 px (model export size)" : `${side} px` })),
        ...DEPTH_PRO2_PHOTO_SIDES.map(side => ({ value: String(side), label: depthPro2BoxLabel(side) }))],
      description: "Depth model input side for the next explicit preparation run. Depth Anything's choices are multiples of its 14-pixel patch size; Depth Pro 2 takes one of two fixed boxes. Higher resolution increases inference work; the saved base samples remain float32.",
      inactiveWhen: values => values["interpretation"] === "depth" ? null : "Input size applies only when preparing depth.",
    },
    prepare: {
      type: "pulse", label: "Prepare / rerun…", group: "Preparation",
      fires: "photoMapping.prepare", input: { nodeIds: ["$node"] },
      description: "Explicitly prepares this map from the reference photo and saves the result. Rerunning depth leaves separately prepared or hand-corrected masks unchanged. Loading a saved map never triggers this action.",
      inactiveWhen: values => values["interpretation"] === "depth" || values["interpretation"] === "mask" ? null : "Select Depth or Mask to prepare a photo-derived map.",
    },
};

export const floatMapInNode: NodeDefinition = {
  type: "floatMapIn",
  version: 1,
  title: "Float Map In",
  category: "input",
  description: "Loads a saved .loom.exr numerical image as a single-channel 32-bit float texture. Depth, coverage and arbitrary scalar fields retain their precision without colour decoding. Interpretation Raw values passes the saved numbers through unchanged; select Depth or Mask to prepare or explicitly rerun from a reference photo; saved results load independently of inference. While no file is assigned, Unassigned map either requires a file (an error) or outputs a constant. Consumers read the red channel.",
  tags: ["depth", "mask", "data", "photo", "projection", "file"],
  inputs: [{ id: "picture", label: "Reference photo", type: RGBA_TEXTURE, optional: true,
    description: "Connect the source Movie File In so replacing its photo marks prepared maps out of date." }],
  // The existing logical data port is shared with data consumers; its physical texture
  // has only a red channel, declared by formatPolicy rather than a second port family.
  outputs: [{ id: "out", label: "Data", type: DATA_TEXTURE }],
  parameters: FLOAT_MAP_PARAMETERS,
  parametersFor(stored) {
    const model = storedStaticValue(stored["depthModel"] as StoredParameter | undefined) ?? "depth-anything-v2-small";
    const backend = storedStaticValue(stored["depthBackend"] as StoredParameter | undefined) ?? "wasm";
    const native = model === MARIGOLD_MODEL_ID;
    const metric = isDepthPro2PhotoModel(model);
    const sides = model === "imported-depth" ? [518]
      : photoDepthSidesFor(String(model), backend === "mlx" ? "mlx" : backend === "webgpu" ? "webgpu" : "wasm");
    return { ...FLOAT_MAP_PARAMETERS, depthBackend: { ...FLOAT_MAP_PARAMETERS["depthBackend"] as EnumParameter,
      default: native ? "mlx" : metric ? "webgpu" : "wasm", options: (FLOAT_MAP_PARAMETERS["depthBackend"] as EnumParameter).options.filter(option => native ? option.value === "mlx" : option.value !== "mlx"),
    }, inputSide: {
      ...FLOAT_MAP_PARAMETERS["inputSide"] as EnumParameter, default: native ? "512" : metric ? "640" : "518",
      description: native ? "Aspect-fit inference long edge; both dimensions align to 16 pixels with full-frame registration."
        : metric ? "Depth Pro 2's fixed input box. The photo is letterboxed into it: a 16:9 photo fills 75 % of 640 × 480 and 98 % of 672 × 384."
        : (FLOAT_MAP_PARAMETERS["inputSide"] as EnumParameter).description!,
      options: sides.map(side => ({ value: String(side), label: metric ? depthPro2BoxLabel(side as typeof DEPTH_PRO2_PHOTO_SIDES[number]) : `${side} px` })),
    } };
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "fixed", format: "r32float" },
  compile(context) {
    const { nodeId, outputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    if (target === undefined) return { passes: [] };
    if ((parameters["file"] === undefined || parameters["file"] === "") && parameters["emptySource"] === "constant") {
      const emptyValue = parameters["emptyValue"] ?? 0.5;
      if (typeof emptyValue !== "number" || !Number.isFinite(emptyValue)) throw new Error("Float Map In's unassigned value must be finite.");
      return { passes: [{ kind: "effect", id: `${nodeId}:floatMapConstant`, shader: FLOAT_MAP_CONSTANT_WGSL,
        target, uniformBinding: "params", uniforms: { emptyValue }, nodeId }], };
    }
    return {
      passes: [{
        kind: "effect", id: `${nodeId}:floatMap`, shader: FLOAT_MAP_BLIT_WGSL, target,
        textures: [{ binding: "floatMapTexture", resourceId: scratchResourceId(nodeId, FLOAT_MAP_TEXTURE_KEY), sampled: "unfiltered" }],
        nodeId,
      }],
      scratch: [{
        key: FLOAT_MAP_TEXTURE_KEY, kind: "external", sourceId: floatMapSourceIdFor(nodeId), format: "r32float",
      }],
    };
  },
};
