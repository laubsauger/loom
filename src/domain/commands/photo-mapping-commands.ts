import { z } from "zod";
import { supportsPhotoDepthSize } from "../media/preparation-sizes.ts";
import { photoDepthRecipeSchema, depthRecipeParameters, type PhotoDepthRecipe } from "../media/photo-depth-recipe.ts";
import { imageFramingSchema, imageFramingParameters, type ImageFraming } from "../media/image-framing.ts";
import { depthRangeSchema, type DepthRangeSettings } from "../media/depth-range.ts";
import { SHADER_DEPTH_RANGE, SHADER_DEPTH_LIGHT, SHADER_DEPTH_CONTOURS, SHADER_DEPTH_SLICE } from "../media/photo-mapping-modules.ts";
import { PHOTO_DEPTH_CARVE_KERNEL, PHOTO_DEPTH_PAINT_KERNEL } from "../media/depth-point-kernels.ts";
import { kindOf } from "../graph/node-kinds.ts";
import type { RuntimeDiagnostic } from "../types/diagnostics.ts";
import type { Revision } from "../types/ids.ts";
import type { GraphPatchOperation, GraphPatchResult, TempId } from "../types/patch.ts";
import type { StoredParameter } from "../types/parameters.ts";
import { applyGraphPatch } from "./apply-patch.ts";
import type { LoomBus } from "./bus.ts";

export interface PhotoMappingCreateInput {
  photo: string;
  depth?: string;
  nativeDepth?: string;
  depthRecipe?: PhotoDepthRecipe;
  mask?: string;
  width: number;
  height: number;
  shader: string;
  effect?: number;
  inputSide?: number;
  previz?: boolean;
  previewPhoto?: string;
  previewFit?: "fit" | "fill" | "stretch";
  previewFraming?: ImageFraming;
  previewOpacity?: number;
  depthRange?: DepthRangeSettings;
  patternShader?: string;
  testPattern?: boolean;
  video?: string;
}

declare module "../types/commands.ts" {
  interface CommandMap {
    "photoMapping.create": { input: PhotoMappingCreateInput; output: GraphPatchResult };
  }
}

const rejection = (_input: unknown, diagnostics: RuntimeDiagnostic[], revision: Revision): GraphPatchResult => ({
  status: "rejected", revision, appliedOperations: 0, diagnostics, createdIds: {},
});

/** Builds a regular editable projection network as one atomic, undoable graph patch. */
export function registerPhotoMappingCommands(bus: LoomBus, options: { refresh?: boolean } = {}): void {
  const exists = bus.hasCommand("photoMapping.create");
  if (exists && !options.refresh) return;
  const register = exists ? bus.replaceCommand.bind(bus) : bus.registerCommand.bind(bus);
  register({
    name: "photoMapping.create",
    inSession: "definition",
    description: "Create an editable photo-mapping network from a photo, saved float32 depth and an optional mask asset.",
    inputSchema: z.object({
      photo: z.string().trim().min(1), depth: z.string().trim().min(1).optional(), mask: z.string().trim().min(1).optional(),
      nativeDepth: z.string().trim().min(1).optional(), depthRecipe: photoDepthRecipeSchema.optional(),
      width: z.number().int().positive(), height: z.number().int().positive(),
      shader: z.string().trim().min(1), effect: z.number().finite().optional(),
      inputSide: z.number().int().positive().optional(),
      previz: z.boolean().optional(),
      previewPhoto: z.string().trim().min(1).optional(),
      previewFit: z.enum(["fit", "fill", "stretch"]).optional(),
      previewFraming: imageFramingSchema.optional(),
      previewOpacity: z.number().finite().min(0).max(1).optional(),
      depthRange: depthRangeSchema.optional(), patternShader: z.string().trim().min(1).optional(),
      testPattern: z.boolean().optional(), video: z.string().trim().min(1).optional(),
    }).strict().refine(input => input.inputSide === undefined ||
      (input.depthRecipe !== undefined && input.depthRecipe.version !== 1 ? input.inputSide === input.depthRecipe.inputSide : supportsPhotoDepthSize(input.inputSide)), {
      message: "Unsupported depth input size.", path: ["inputSide"],
    }).refine(input => input.previewPhoto === undefined || input.previz !== false, {
      message: "A preview photo requires reference-photo previz.", path: ["previewPhoto"],
    }).refine(input => input.previewFraming === undefined || (input.previewPhoto !== undefined && input.previz !== false), {
      message: "Preview framing requires a preview photo with reference-photo previz.", path: ["previewFraming"],
    }).refine(input => input.depth !== undefined || (input.nativeDepth === undefined && input.depthRecipe === undefined), {
      message: "Native depth and depth recipes require an assigned depth map.", path: ["depth"],
    }).refine(input => input.testPattern !== true || input.patternShader !== undefined, {
      message: "Test pattern requires its calibration shader.", path: ["patternShader"],
    }).refine(input => input.depthRecipe?.refinement == null || input.nativeDepth !== undefined, {
      message: "Refined depth requires its saved native parent.", path: ["nativeDepth"],
    }).refine(input => input.depthRecipe === undefined || input.inputSide === undefined || input.depthRecipe.inputSide === input.inputSide, {
      message: "Depth recipe and input size must agree.", path: ["inputSide"],
    }),
    handler: (input, context) => {
      // Source identity and preparation metadata keep the original photograph dimensions.
      // Only the graph's working textures are fitted to the project's resolution limit.
      const maxResolution = context.store.getSettings().limits.maxResolution;
      const scale = Math.min(1, maxResolution / Math.max(input.width, input.height));
      const width = Math.max(1, Math.round(input.width * scale));
      const height = Math.max(1, Math.round(input.height * scale));

      const previz = input.previz ?? true;
      const pattern = input.patternShader !== undefined;
      const modular = input.effect !== undefined && input.effect >= 10 && input.effect <= 13 && Number.isInteger(input.effect);
      const cloud = input.effect === 13;
      const effectColumn = modular ? (cloud ? 7 : 4) : 1;
      const coverageColumn = effectColumn + (pattern ? 2 : 1);
      const video = input.video !== undefined || input.effect === 9;
      const specs: { ref: TempId; type: string; role: string; column: number; row: number; parameters: Record<string, StoredParameter> }[] = [
        { ref: "$photo", type: "movieFileIn", role: "surface", column: 0, row: 0, parameters: { file: input.photo } },
        { ref: "$depth", type: "floatMapIn", role: "depth", column: 0, row: 1,
          parameters: { file: input.depth ?? "", photo: input.photo, interpretation: "depth", inputSide: String(input.inputSide ?? 518),
            ...(input.depth === undefined ? { emptySource: "constant", emptyValue: 0.5 } : {}),
            ...(input.depthRecipe === undefined ? {} : depthRecipeParameters(input.depthRecipe)),
            ...(input.nativeDepth === undefined ? {} : { nativeMap: input.nativeDepth }) } },
        { ref: "$mask", type: "floatMapIn", role: "mask", column: 0, row: 2,
          parameters: { file: input.mask ?? "", photo: input.photo, interpretation: "mask", inputSide: "518",
            ...(input.mask === undefined ? { emptySource: "constant", emptyValue: 1 } : {}) } },
      ];
      if (modular) {
        specs.push({ ref: "$range", type: "customWgslMulti", role: "depth_range", column: 1, row: 0,
          parameters: { source: SHADER_DEPTH_RANGE, low: input.depthRange?.low ?? 0, high: input.depthRange?.high ?? 1 } });
        if (cloud) {
          // The near/far values are relative display units, not recovered metric distance.
          const cols = width >= height ? 768 : Math.max(2, Math.round(768 * width / height));
          const rows = height >= width ? 768 : Math.max(2, Math.round(768 * height / width));
          const capacity = cols * rows;
          const attributes = JSON.stringify([
            { name: "position", type: "vec3f", semantic: "position", default: [0, 0, 0] },
            { name: "tint", type: "vec4f", semantic: "color", qualifier: "color", default: [1, 1, 1, 1] },
            { name: "depthN", type: "f32", default: [0] },
          ]);
          specs.push(
            { ref: "$points", type: "pointGrid", role: "photo_samples", column: 1, row: 1,
              parameters: { count: capacity, cols, rows, sizeX: 2, sizeY: 2 } },
            { ref: "$carve", type: "pointKernel", role: "relative_depth", column: 2, row: 0,
              parameters: { capacity, seed: 7, attributes, kernel: PHOTO_DEPTH_CARVE_KERNEL,
                unproject: 1, fov: 55, inverseDepth: 1, near: 1.5, far: 3.5, displace: 1 } },
            { ref: "$photoCoverage", type: "mask", role: "photo_coverage", column: 2, row: 1,
              parameters: { channel: "red", apply: "alpha" } },
            { ref: "$paint", type: "pointKernel", role: "photo_colour", column: 3, row: 0,
              parameters: { capacity, seed: 7, attributes, kernel: PHOTO_DEPTH_PAINT_KERNEL, heat: 0, gain: 1 } },
            { ref: "$material", type: "materialUnlit", role: "photo_white", column: 3, row: 1,
              parameters: { color: [1, 1, 1, 1] } },
            { ref: "$cloudGeometry", type: "geometry", role: "photo_points", column: 4, row: 0,
              parameters: { mode: "points", material: "@ref:$material", spherical: false, soft: 1, blend: "opaque",
                scale: { mode: "map", bindings: { static: { kind: "static", value: 0.004 },
                  map: { kind: "map", attribute: "tint", channel: "w" } } },
                tint: { mode: "map", bindings: { static: { kind: "static", value: [1, 1, 1, 1] },
                  map: { kind: "map", attribute: "tint" } } } } },
            { ref: "$camera", type: "camera", role: "photo_orbit", column: 5, row: 1,
              parameters: { eye: [0, 0, 2.5], lookAt: [0, 0, 0], fov: 55, near: 0.1, far: 20 } },
            { ref: "$render", type: "render", role: "photo_cloud", column: 6, row: 0,
              parameters: { scenes: "@ref:$cloudGeometry", camera: "@ref:$camera", lights: "",
                ambientColor: [0, 0, 0, 1], ambientIntensity: 0, background: [0, 0, 0, 1] } },
            { ref: "$motion", type: "lfo", role: "photo_orbit", column: 4, row: 1,
              parameters: { shape: "sine", frequency: 0.03, amplitude: 0.45, offset: 0, phase: 0 } },
          );
        } else {
          specs.push(
            { ref: "$module", type: "customWgslMulti", role: input.effect === 10 ? "grazing_light" : input.effect === 11 ? "contours" : "depth_slice",
              column: 2, row: 0, parameters: { source: input.effect === 10 ? SHADER_DEPTH_LIGHT : input.effect === 11 ? SHADER_DEPTH_CONTOURS : SHADER_DEPTH_SLICE } },
            { ref: "$multiply", type: "multiply", role: "photo_look", column: 3, row: 0, parameters: {} },
            { ref: "$motion", type: "lfo", role: "photo_motion", column: 2, row: 2,
              parameters: { shape: "sine", frequency: input.effect === 10 ? 0.04 : 0.03,
                amplitude: input.effect === 10 ? 0.8 : input.effect === 11 ? 0.5 : 0.45,
                offset: input.effect === 12 ? 0.5 : 0, phase: 0 } },
          );
          if (input.effect !== 12) specs.push({ ref: "$tint", type: "solid", role: "projection_tint", column: 3, row: 2,
            parameters: { color: input.effect === 10 ? [1, 0.97, 0.9, 1] : [1, 0.88, 0.65, 1] } });
        }
        specs.push({ ref: "$effect", type: "level", role: "photo_grade", column: effectColumn, row: 0,
          parameters: { brightness: cloud ? 1.5 : 1, contrast: 1 } });
      } else {
        specs.push({ ref: "$effect", type: "customWgslMulti", role: "relief", column: effectColumn, row: 0,
          parameters: { source: input.shader, mode: input.effect ?? 0,
            ...(input.depthRange === undefined ? {} : { depthLow: input.depthRange.low, depthHigh: input.depthRange.high }) } });
      }
      specs.push(
        { ref: "$coverage", type: "mask", role: "surface", column: coverageColumn, row: 0, parameters: { channel: "red", apply: "colour" } },
        { ref: "$grid", type: "gridWarp", role: "surface", column: coverageColumn + 1, row: 0, parameters: {} },
        { ref: "$corner", type: "cornerPin", role: "surface", column: coverageColumn + 2, row: 0, parameters: {} },
        { ref: "$window", type: "window", role: "projector", column: coverageColumn + 3, row: 0, parameters: {} },
      );
      if (pattern) specs.push(
        { ref: "$pattern", type: "customWgsl", role: "calibration", column: effectColumn, row: 3, parameters: { source: input.patternShader! } },
        { ref: "$testSwitch", type: "switch", role: "calibration", column: effectColumn + 1, row: 0, parameters: { index: input.testPattern === true ? 1 : 0 } },
      );
      if (video) specs.push({ ref: "$video", type: "movieFileIn", role: "content", column: 0, row: 3, parameters: { file: input.video ?? "" } });
      if (previz) specs.push(
        // Grade the reference RGB while preserving alpha; Screen opacity controls only
        // the effect's preview strength and leaves the projector branch alone.
        { ref: "$reference", type: "level", role: "reference", column: modular ? effectColumn : 1, row: 1, parameters: { brightness: cloud ? 0 : 0.65 } },
        { ref: "$previz", type: "screen", role: "preview", column: modular ? effectColumn + 1 : 2, row: 1, parameters: { opacity: input.previewOpacity ?? 0.35 } },
      );
      if (input.previewPhoto !== undefined) specs.push({ ref: "$previewPhoto", type: "movieFileIn", role: "preview", column: 1, row: 2,
        parameters: { file: input.previewPhoto, imageFit: input.previewFit ?? "stretch",
          ...(input.previewFraming === undefined ? {} : imageFramingParameters(input.previewFraming)) } });
      specs.push({ ref: "$output", type: "output", role: previz ? "preview" : "mapping", column: modular ? effectColumn + 2 : 3, row: 1, parameters: {} });
      const kinds: string[] = [];
      for (const spec of specs) {
        const definition = context.registry.get(spec.type);
        if (definition === undefined) {
          const missing: RuntimeDiagnostic[] = [{ severity: "error", code: "photoMapping.node.unavailable",
            message: `Photo mapping requires the registered node type "${spec.type}".` }];
          return { status: "rejected", revision: context.graph.revision, diagnostics: missing,
            output: rejection(input, missing, context.graph.revision) };
        }
        kinds.push(kindOf(definition));
      }
      const nodes = Object.values(context.graph.nodes);
      const names = new Set(nodes.flatMap(node => node.label === undefined ? [] : [node.label]));
      const groupNames = new Set(Object.values(context.graph.groups).map(group => group.label));
      let suffix = 1;
      while (specs.some((spec, index) => names.has(`${kinds[index]}_${spec.role}${suffix}`)) || groupNames.has(`Photo mapping ${suffix}`)) suffix++;
      const right = Math.max(0, ...nodes.map(node => node.position.x + (node.size?.width ?? 220)),
        ...Object.values(context.graph.groups).map(group => group.bounds.x + group.bounds.width));
      const origin = nodes.length === 0 && Object.keys(context.graph.groups).length === 0 ? 0 : right + 80;
      const labels = new Map(specs.map((spec, index) => [spec.ref, `${kinds[index]}_${spec.role}${suffix}`]));
      for (const spec of specs) {
        for (const [key, value] of Object.entries(spec.parameters)) {
          if ((key === "material" || key === "scenes" || key === "camera") && typeof value === "string" && value.startsWith("@ref:")) {
            const label = labels.get(value.slice(5) as TempId);
            if (label === undefined) throw new Error(`Unresolved photo mapping reference ${value}.`);
            spec.parameters[key] = label;
          }
        }
      }
      if (modular) {
        const motion = `op('${labels.get("$motion")!}').chan.value`;
        const target = specs.find(spec => spec.ref === (cloud ? "$camera" : "$module"))!;
        const parameter = cloud ? "eye.x" : input.effect === 10 ? "direction.x" : input.effect === 11 ? "offset" : "center";
        target.parameters[parameter] = { mode: "expression", bindings: {
          static: { kind: "static", value: cloud ? 0 : input.effect === 10 ? 0.8 : input.effect === 11 ? 0 : 0.5 },
          expression: { kind: "expression", source: motion },
        } };
      }
      const operations: GraphPatchOperation[] = specs.flatMap((spec, index): GraphPatchOperation[] => [
        { op: "addNode", ref: spec.ref, type: spec.type, label: `${kinds[index]}_${spec.role}${suffix}`,
          position: { x: origin + spec.column * 260, y: spec.row * 300 }, parameters: spec.parameters },
        { op: "setNodeSize", nodeId: spec.ref, size: { width: 220, height: 220 } },
        ...(index < 3 || spec.ref === "$previewPhoto" || spec.ref === "$video" || spec.ref === "$range" || spec.ref === "$render" ? [{ op: "setNodeResolution" as const, nodeId: spec.ref,
          resolution: { mode: "fixed" as const, width, height } }] : []),
      ]);
      const connect = (source: TempId, target: TempId, portId: string, order?: number): void => {
        operations.push({ op: "connect", source: { nodeId: source, portId: "out" }, target: { nodeId: target, portId },
          ...(order === undefined ? {} : { order }) });
      };
      connect("$photo", "$depth", "picture");
      connect("$photo", "$mask", "picture");
      if (modular) {
        operations.push({ op: "setNodeFormat", nodeId: "$range", format: { mode: "fixed", format: "r32float" } });
        connect("$photo", "$range", "input");
        connect("$depth", "$range", "more", 0);
        if (cloud) {
          connect("$points", "$carve", "in");
          connect("$range", "$carve", "field");
          connect("$photo", "$photoCoverage", "input");
          connect("$mask", "$photoCoverage", "mask");
          connect("$carve", "$paint", "in");
          connect("$photoCoverage", "$paint", "field");
          connect("$paint", "$cloudGeometry", "points");
          connect("$render", "$effect", "input");
        } else {
          connect("$photo", "$module", "input");
          connect("$range", "$module", "more", 0);
          connect("$module", "$multiply", "in1");
          connect(input.effect === 12 ? "$photo" : "$tint", "$multiply", "in2", 0);
          connect("$multiply", "$effect", "input");
        }
      } else {
        connect(input.effect === 9 ? "$video" : "$photo", "$effect", "input");
        connect("$depth", "$effect", "more", 0);
        connect("$mask", "$effect", "more", 1);
      }
      if (pattern) {
        // Custom WGSL retains its required picture socket even for a UV-only generator.
        connect("$photo", "$pattern", "input");
        connect("$effect", "$testSwitch", "inputs", 0);
        connect("$pattern", "$testSwitch", "inputs", 1);
      }
      connect(pattern ? "$testSwitch" : "$effect", "$coverage", "input");
      connect("$mask", "$coverage", "mask");
      connect("$coverage", "$grid", "input");
      connect("$grid", "$corner", "input");
      connect("$corner", "$window", "input");
      if (previz) {
        connect(input.previewPhoto === undefined ? "$photo" : "$previewPhoto", "$reference", "input");
        connect("$coverage", "$previz", "in1");
        connect("$reference", "$previz", "in2");
        connect("$previz", "$output", "input");
      } else {
        connect("$corner", "$output", "input");
      }
      operations.push({ op: "addGroup", ref: "$group", label: `Photo mapping ${suffix}`,
        bounds: { x: origin - 20, y: -40, width: Math.max(...specs.map(spec => spec.column)) * 260 + 260, height: Math.max(...specs.map(spec => spec.row)) * 300 + 280 }, members: specs.map(spec => spec.ref) });
      const result = applyGraphPatch({ baseRevision: context.graph.revision, label: "Create photo mapping", operations }, context);
      if (scale === 1 || (result.status !== "applied" && result.status !== "validated")) return result;
      const diagnostics: RuntimeDiagnostic[] = [...(result.diagnostics ?? []), {
        severity: "warning", code: "photoMapping.resolution.fitted",
        message: `Photo mapping output fitted from ${input.width} × ${input.height} to ${width} × ${height} pixels to stay within the project's ${maxResolution}-pixel resolution limit. The full photograph and saved map references are preserved.`,
      }];
      return { ...result, diagnostics, output: { ...result.output, diagnostics } };
    },
    rejectionOutput: rejection,
  });
}
