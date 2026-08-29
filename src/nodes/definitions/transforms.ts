import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import {
  DEGREES_TO_RADIANS,
  EXTEND_OPTIONS,
  TRANSFORM_ORDER_OPTIONS,
  readEnumIndex,
  readFlag,
  readNumber,
  readVector,
} from "./parameter-readers.ts";
import {
  CROP_FRAGMENT_WGSL,
  TILE_FRAGMENT_WGSL,
  TRANSFORM_FRAGMENT_WGSL,
} from "../shaders/transforms.wgsl.ts";

/**
 * Geometry filters: Transform, Crop, Tile (T40).
 *
 * All three take one texture in and one out, with `{kind:"inherit", input:"input"}` for
 * both resolution and format: a filter that resized or reformatted its input without being
 * asked would be an invisible conversion, which is exactly what §V13 exists to prevent.
 *
 * COLOUR (§V56): they move pixels, they never change values. Whatever space the input
 * carries, the output carries — no decode, no encode, no channel arithmetic. That holds
 * for a DATA input too, which is why a UV or a distance field can be transformed and still
 * mean what it meant.
 */

/**
 * Transform — TD's Transform TOP.
 *
 * Translate is in fractions of the image, as in TD; rotation happens in a square space so
 * a rotate on a 16:9 image does not shear it. `xord` is TD's Transform Order menu, and the
 * shader applies the INVERSE of the parameters in the reverse of that order, because a
 * fragment shader moves the sample coordinate rather than the image.
 */
export const transformNode: NodeDefinition = {
  type: "transform",
  version: 1,
  title: "Transform",
  category: "filter",
  description: "Translate, rotate, scale and pivot an image, with a choice of extend mode. TD Transform TOP.",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    t: { type: "vector", size: 2, label: "Translate", default: [0, 0], min: -4, max: 4 },
    r: { type: "number", label: "Rotate", default: 0, min: -360, max: 360, unit: "degrees" },
    s: { type: "vector", size: 2, label: "Scale", default: [1, 1], min: -8, max: 8 },
    p: { type: "vector", size: 2, label: "Pivot", default: [0, 0], min: -2, max: 2 },
    xord: {
      type: "enum",
      label: "Transform Order",
      default: "srt",
      options: [...TRANSFORM_ORDER_OPTIONS],
    },
    extend: { type: "enum", label: "Extend", default: "hold", options: [...EXTEND_OPTIONS] },
    aspectcorrect: {
      type: "boolean",
      label: "Aspect Correct",
      default: true,
      description: "Rotate in a square space so a non-square image does not shear.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters, resolution } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const aspect = readFlag(parameters, "aspectcorrect", true) === 1 ? resolution[0] / resolution[1] : 1;
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:transform`,
      shader: TRANSFORM_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        t: readVector(parameters, "t", [0, 0]),
        s: readVector(parameters, "s", [1, 1]),
        piv: readVector(parameters, "p", [0, 0]),
        rot: readNumber(parameters, "r", 0) * DEGREES_TO_RADIANS,
        xord: readEnumIndex(parameters, "xord", TRANSFORM_ORDER_OPTIONS, "srt"),
        extend: readEnumIndex(parameters, "extend", EXTEND_OPTIONS, "hold"),
        aspect,
      },
      nodeId,
      label: "Transform",
    };
    return { passes: [pass] };
  },
};

/**
 * Crop — TD's Crop TOP, keeping the input resolution.
 *
 * TD's Crop resizes its output to the cropped region. `ResolutionPolicy` cannot express a
 * size derived from a parameter value (it offers inherit | fixed | scale | project |
 * custom), so this node keeps the input size and blanks what falls outside the region. The
 * alternative available today — stretching the region back up to full size — would be a
 * zoom wearing a crop's name. If a parameter-derived resolution kind is ever added, this
 * node is its first consumer.
 *
 * Bounds are fractions of the image with y UP (bottom = 0), matching TD's convention.
 */
export const cropNode: NodeDefinition = {
  type: "crop",
  version: 1,
  title: "Crop",
  category: "filter",
  description:
    "Blanks everything outside a rectangular region. Keeps the input resolution (TD's Crop TOP resizes).",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    left: { type: "number", label: "Left", default: 0, min: 0, max: 1 },
    right: { type: "number", label: "Right", default: 1, min: 0, max: 1 },
    bottom: { type: "number", label: "Bottom", default: 0, min: 0, max: 1 },
    top: { type: "number", label: "Top", default: 1, min: 0, max: 1 },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:crop`,
      shader: CROP_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      // Packed as one vec4 rather than four scalars: the shader wants them as two
      // min/max pairs, and a swapped pair (left > right) is then a min/max away from
      // being harmless instead of producing an empty image.
      uniforms: {
        bounds: [
          readNumber(parameters, "left", 0),
          readNumber(parameters, "right", 1),
          readNumber(parameters, "bottom", 0),
          readNumber(parameters, "top", 1),
        ],
      },
      nodeId,
      label: "Crop",
    };
    return { passes: [pass] };
  },
};

/** Tile — TD's Tile TOP: repeat the image, optionally mirroring alternate tiles. */
export const tileNode: NodeDefinition = {
  type: "tile",
  version: 1,
  title: "Tile",
  category: "filter",
  description: "Repeats the image in a grid, with optional mirroring for seamless tiling. TD Tile TOP.",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    repeat: { type: "vector", size: 2, label: "Repeat", default: [2, 2], min: 0.01, max: 64 },
    offset: { type: "vector", size: 2, label: "Offset", default: [0, 0], min: -8, max: 8 },
    mirrorx: { type: "boolean", label: "Mirror X", default: false },
    mirrory: { type: "boolean", label: "Mirror Y", default: false },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    if (target === undefined || source === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "input"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:tile`,
      shader: TILE_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        repeat: readVector(parameters, "repeat", [2, 2]),
        offset: readVector(parameters, "offset", [0, 0]),
        mirror: [readFlag(parameters, "mirrorx", false), readFlag(parameters, "mirrory", false)],
      },
      nodeId,
      label: "Tile",
    };
    return { passes: [pass] };
  },
};

/** The geometry-filter group, in library order. */
export const transformNodes: readonly NodeDefinition[] = [transformNode, cropNode, tileNode];
