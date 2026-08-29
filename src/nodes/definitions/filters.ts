import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import {
  CHANNEL_OPTIONS,
  EXTEND_OPTIONS,
  readEnumIndex,
  readNumber,
  readVector,
} from "./parameter-readers.ts";
import { BLUR_FRAGMENT_WGSL, DISPLACE_FRAGMENT_WGSL } from "../shaders/filters.wgsl.ts";

/**
 * Neighbourhood filters: Blur and Displace (T40).
 *
 * Both need to know their own PIXEL size — a blur radius is in pixels and a displacement
 * is compared against one — so both fold `1 / resolution` into a uniform. That size comes
 * from the compile context, resolved once at compile time (§V21); it is never read
 * per-frame and never taken from the shared frame block, whose `resolution` is the
 * presentation surface's rather than this pass's target's.
 */

const BLUR_FILTER_OPTIONS = [
  { value: "gaussian", label: "Gaussian" },
  { value: "box", label: "Box" },
] as const;

/**
 * Blur — TD's Blur TOP, in one pass.
 *
 * A separable Gaussian is two passes with an intermediate target, and a node definition
 * has no way to ask for one: the compiler allocates one resource per materialized output
 * port and the plan IR has no scratch-target kind. So this samples a 9x9 grid whose
 * spacing scales with the filter size — 81 taps at any radius, correct at preview sizes,
 * visibly under-sampled past a few dozen pixels. Stated here rather than discovered later.
 *
 * WHAT WOULD FIX IT (a request, not a workaround): a scratch/intermediate resource a node
 * can declare in its manifest and target from a pass. Blur is the first consumer; every
 * multi-pass filter after it is the second.
 */
export const blurNode: NodeDefinition = {
  type: "blur",
  version: 1,
  title: "Blur",
  category: "filter",
  description: "Gaussian or box blur, size in pixels. Single-pass 9x9 sampling — see the node docs.",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    size: {
      type: "number",
      label: "Filter Size",
      default: 8,
      min: 0,
      max: 128,
      unit: "px",
      description: "Kernel radius in pixels of the input.",
    },
    filter: {
      type: "enum",
      label: "Filter",
      default: "gaussian",
      options: [...BLUR_FILTER_OPTIONS],
    },
    extend: { type: "enum", label: "Extend", default: "hold", options: [...EXTEND_OPTIONS] },
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
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:blur`,
      shader: BLUR_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        texel: [1 / resolution[0], 1 / resolution[1]],
        size: readNumber(parameters, "size", 8),
        ftype: readEnumIndex(parameters, "filter", BLUR_FILTER_OPTIONS, "gaussian"),
        extend: readEnumIndex(parameters, "extend", EXTEND_OPTIONS, "hold"),
      },
      nodeId,
      label: "Blur",
    };
    return { passes: [pass] };
  },
};

/**
 * Displace — TD's Displace TOP.
 *
 * COLOUR (§V56/§V57), and the reason this node is called out in the brief: the `disp`
 * input is DATA, not colour. Two of its channels are read as signed offsets in uv units
 * after `offset` (the value that means "no displacement", 0.5 by default) is subtracted.
 * Colour-converting it would rescale those offsets by a gamma curve and silently change
 * the geometry — the exact class of bug §V56 exists to prevent. Nothing in this node
 * converts either input, and when `texture2d.space` lands (T83) this port must be declared
 * `space: "data"` while `source` stays colour.
 *
 * Resolution and format inherit `source`: the displaced image keeps the shape of the image
 * being displaced, not of the field doing the displacing, which may legitimately be a
 * different size (a low-resolution noise driving a full-resolution image is normal).
 */
export const displaceNode: NodeDefinition = {
  type: "displace",
  version: 1,
  title: "Displace",
  category: "filter",
  description: "Offsets each pixel by a value read from a displacement field. TD Displace TOP.",
  inputs: [
    { id: "source", label: "Source", type: RGBA_TEXTURE, description: "The image being displaced." },
    {
      id: "disp",
      label: "Displace",
      type: RGBA_TEXTURE,
      description: "DATA, not colour: signed uv offsets. Never colour-convert this (§V56).",
    },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    weight: {
      type: "vector",
      size: 2,
      label: "Displace Weight",
      default: [0.1, 0.1],
      min: -2,
      max: 2,
      description: "How far a full-scale value moves a pixel, in uv units.",
    },
    offset: {
      type: "vector",
      size: 2,
      label: "Offset Weight",
      default: [0.5, 0.5],
      min: -1,
      max: 1,
      description: "The field value that means no displacement. 0.5 for a 0..1 field, 0 for a signed one.",
    },
    sourcex: {
      type: "enum",
      label: "Displace Source X",
      default: "red",
      options: [...CHANNEL_OPTIONS],
    },
    sourcey: {
      type: "enum",
      label: "Displace Source Y",
      default: "green",
      options: [...CHANNEL_OPTIONS],
    },
    extend: { type: "enum", label: "Extend", default: "hold", options: [...EXTEND_OPTIONS] },
  },
  resolutionPolicy: { kind: "inherit", input: "source" },
  formatPolicy: { kind: "inherit", input: "source" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["source"];
    const field = inputs["disp"];
    if (target === undefined || source === undefined || field === undefined) {
      const what =
        target === undefined
          ? 'output port "out"'
          : source === undefined
            ? 'input port "source"'
            : 'input port "disp"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:displace`,
      shader: DISPLACE_FRAGMENT_WGSL,
      target,
      textures: [
        { binding: "inputTexture", resourceId: source.resource },
        { binding: "displaceTexture", resourceId: field.resource },
      ],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        weight: readVector(parameters, "weight", [0.1, 0.1]),
        offset: readVector(parameters, "offset", [0.5, 0.5]),
        sourcex: readEnumIndex(parameters, "sourcex", CHANNEL_OPTIONS, "red"),
        sourcey: readEnumIndex(parameters, "sourcey", CHANNEL_OPTIONS, "green"),
        extend: readEnumIndex(parameters, "extend", EXTEND_OPTIONS, "hold"),
      },
      nodeId,
      label: "Displace",
    };
    return { passes: [pass] };
  },
};

/** The neighbourhood-filter group, in library order. */
export const filterNodes: readonly NodeDefinition[] = [blurNode, displaceNode];
