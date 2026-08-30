import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import {
  CHANNEL_OPTIONS,
  EXTEND_OPTIONS,
  readEnumIndex,
  readFlag,
  readNumber,
  readVector,
} from "./parameter-readers.ts";
import {
  CONVOLVE_FRAGMENT_WGSL,
  EDGE_FRAGMENT_WGSL,
  BLUR_FRAGMENT_WGSL,
  DISPLACE_FRAGMENT_WGSL,
  REMAP_FRAGMENT_WGSL,
} from "../shaders/filters.wgsl.ts";

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

/** Node-local name for the horizontal leg's intermediate; the compiler namespaces it. */
export const BLUR_SCRATCH_KEY = "h";

/**
 * Taps per side, per pass. 64 makes a 129-tap axis at the widest, so a full-size blur is
 * 258 taps against the old shader's fixed 81 — but the old 81 covered a 2D grid, and this
 * covers two axes properly. Below the cap the tap count follows the size, so the common
 * case is CHEAPER than before (size 8 is 2 x 25 taps).
 */
const BLUR_MAX_TAPS_PER_SIDE = 64;

/**
 * The kernel the two passes share, resolved on the CPU at compile time.
 *
 * Deriving `taps` and `stride` here rather than in WGSL keeps a size change a UNIFORM
 * write (§V5) while still letting the loop bound follow the size — the shader reads both
 * out of its uniform block and never recompiles.
 *
 * `sigma = size / 2` is unchanged from the single-pass version, so an existing project
 * blurs by the same amount. What changed is the truncation: the old kernel stopped at
 * 2 sigma with a spacing of sigma/2, this one runs to 3 sigma with a spacing of at most
 * one pixel. A box keeps its literal meaning — a flat kernel over exactly +/- size.
 */
function blurKernel(size: number, filterIndex: number): { taps: number; stride: number } {
  const radius = Math.max(size, 0);
  // `sigma` is not passed across: the shader derives it from `size` by the same relation,
  // so there is one definition of "how wide is a Gaussian of this size", not two.
  const sigma = Math.max(radius * 0.5, 1e-4);
  const span = filterIndex === 0 ? sigma * 3 : radius;
  const taps = Math.min(Math.ceil(span), BLUR_MAX_TAPS_PER_SIDE);
  return { taps, stride: taps > 0 ? span / taps : 0 };
}

/**
 * Blur — TD's Blur TOP, as a two-pass separable Gaussian or box (T40, T147).
 *
 * SCRATCH (§V8). The horizontal pass renders into a node-private intermediate declared as
 * `scratch: [{ key: "h" }]` and materialized by the COMPILER at
 * `scratchResourceId(nodeId, "h")`, sized and formatted like this node's own output. The
 * node never allocates: it names a resource and the compiler creates it outside the frame
 * loop, which is the whole reason the request is declarative. The vertical pass samples
 * that intermediate and writes the real output.
 *
 * HONEST RADIUS. Taps per side are capped at 64, and the span sampled is 3 sigma
 * (Gaussian) or the declared radius (box), so the taps sit at most one pixel apart — the
 * kernel is fully sampled — up to a filter size of 42 for the Gaussian and 64 for the box.
 * Above that the spacing widens as span/64 and the result is an approximation, degrading
 * from a 129-tap-per-axis baseline. The previous single-pass shader degraded from a 9-tap
 * one and said nothing about it, which is the defect this replaces.
 */
export const blurNode: NodeDefinition = {
  type: "blur",
  version: 1,
  title: "Blur",
  category: "filter",
  description:
    "Gaussian or box blur, size in pixels. Two-pass separable; fully sampled to size 42 (Gaussian) / 64 (box).",
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
      description:
        "Kernel radius in pixels of the input. Fully sampled to 42 (Gaussian) / 64 (box); wider blurs approximate.",
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

    const ftype = readEnumIndex(parameters, "filter", BLUR_FILTER_OPTIONS, "gaussian");
    const size = readNumber(parameters, "size", 8);
    const { taps, stride } = blurKernel(size, ftype);
    const extend = readEnumIndex(parameters, "extend", EXTEND_OPTIONS, "hold");
    // Key order matches the WGSL struct's field order, as everywhere else in the catalogue.
    const shared = { texel: [1 / resolution[0], 1 / resolution[1]] };
    const rest = { size, stride, taps, ftype, extend };
    const scratch = scratchResourceId(nodeId, BLUR_SCRATCH_KEY);

    const horizontal: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:blur-h`,
      shader: BLUR_FRAGMENT_WGSL,
      target: scratch,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: { ...shared, dir: [1, 0], ...rest },
      nodeId,
      label: "Blur H",
    };
    const vertical: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:blur-v`,
      shader: BLUR_FRAGMENT_WGSL,
      target,
      // The scratch the pass above just wrote. Node-private: no port exposes it, so
      // nothing downstream can reference it.
      textures: [{ binding: "inputTexture", resourceId: scratch }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: { ...shared, dir: [0, 1], ...rest },
      nodeId,
      label: "Blur V",
    };
    return { passes: [horizontal, vertical], scratch: [{ key: BLUR_SCRATCH_KEY }] };
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

/**
 * Remap — absolute UV lookup (T279). TD's Remap TOP.
 *
 * Displace's sibling, and the one difference is the point of the node: Displace ADDS the
 * field to the pixel's own coordinate, Remap USES it as the coordinate. That makes this the
 * first node in the catalogue that can consume the UV generator's output — until now `uv`
 * produced coordinates nothing could read — and with it, a hand-painted or computed warp
 * field is an ordinary texture rather than a Custom WGSL node.
 *
 * SHAPE AND PIXELS COME FROM DIFFERENT INPUTS, which is the same split Lookup makes and
 * for the same reason. `map` is the index image: there is one lookup per one of ITS pixels,
 * so the output has its resolution. `source` is what is being read: the output's pixels are
 * literally the source's pixels, so the output has its format and its colour space. A 4K
 * source remapped through a 256-square field is a 256-square image, and that is the
 * operation, not a downscale that snuck in.
 *
 * COLOUR (§V56/§V57): `map` is DATA — positions, never light. Colour-converting it would
 * move every sample somewhere else. `source` is whatever it was and comes out unchanged.
 */
export const remapNode: NodeDefinition = {
  type: "remap",
  version: 1,
  title: "Remap",
  category: "filter",
  description:
    "Samples the source at coordinates read from a UV map — absolute position, not an offset. TD Remap TOP.",
  inputs: [
    {
      id: "source",
      label: "Source",
      type: RGBA_TEXTURE,
      description: "The image being sampled. Its format and colour space are the output's.",
    },
    {
      id: "map",
      label: "UV Map",
      type: RGBA_TEXTURE,
      description:
        "DATA, not colour: absolute uv coordinates. Its resolution is the output's. Never colour-convert this (§V56).",
    },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    sourcex: {
      type: "enum",
      label: "Horizontal Source",
      default: "red",
      options: [...CHANNEL_OPTIONS],
      description: "Which channel of the map carries u.",
    },
    sourcey: {
      type: "enum",
      label: "Vertical Source",
      default: "green",
      options: [...CHANNEL_OPTIONS],
      description: "Which channel of the map carries v.",
    },
    flipu: { type: "boolean", label: "Flip U", default: false },
    flipv: {
      type: "boolean",
      label: "Flip V",
      default: false,
      description:
        "For a map authored with v = 0 at the BOTTOM. Our UV generator's default needs no flip.",
    },
    extend: {
      type: "enum",
      label: "Extend",
      default: "hold",
      options: [...EXTEND_OPTIONS],
      description: "What a coordinate outside 0..1 reads. Common here: the field is absolute.",
    },
  },
  // The map is the index image, so its shape is the output's; the source is what gets read,
  // so its pixels — and their format — are the output's. Same split as Lookup (§V57).
  resolutionPolicy: { kind: "inherit", input: "map" },
  formatPolicy: { kind: "inherit", input: "source" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["source"];
    const field = inputs["map"];
    if (target === undefined || source === undefined || field === undefined) {
      const what =
        target === undefined
          ? 'output port "out"'
          : source === undefined
            ? 'input port "source"'
            : 'input port "map"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:remap`,
      shader: REMAP_FRAGMENT_WGSL,
      target,
      textures: [
        { binding: "inputTexture", resourceId: source.resource },
        { binding: "mapTexture", resourceId: field.resource },
      ],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        flip: [readFlag(parameters, "flipu", false), readFlag(parameters, "flipv", false)],
        sourcex: readEnumIndex(parameters, "sourcex", CHANNEL_OPTIONS, "red"),
        sourcey: readEnumIndex(parameters, "sourcey", CHANNEL_OPTIONS, "green"),
        extend: readEnumIndex(parameters, "extend", EXTEND_OPTIONS, "hold"),
      },
      nodeId,
      label: "Remap",
    };
    return { passes: [pass] };
  },
};

/** The neighbourhood-filter group, in library order. */
/**
 * Edge — Sobel gradient magnitude (T241). TD's Edge TOP.
 *
 * Per channel rather than on luminance: run it on a mask and you get that mask's boundary,
 * which a luminance-only version would have collapsed away. Alpha passes through untouched,
 * because under straight alpha the edges of COVERAGE are a different question from the
 * edges of colour, and differentiating it would make every opaque image come back fully
 * transparent.
 */
export const edgeNode: NodeDefinition = {
  type: "edge",
  version: 1,
  title: "Edge",
  category: "filter",
  description: "Sobel edge detection, per channel. TD Edge TOP.",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    strength: {
      type: "number",
      label: "Strength",
      default: 1,
      min: 0,
      max: 10,
      description: "Scales the gradient magnitude. Edges are often faint at 1.",
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
      id: `${nodeId}:edge`,
      shader: EDGE_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      // Key order matches the WGSL struct's field order, as everywhere else here.
      uniforms: {
        texel: [1 / resolution[0], 1 / resolution[1]],
        strength: readNumber(parameters, "strength", 1),
        extend: readEnumIndex(parameters, "extend", EXTEND_OPTIONS, "hold"),
      },
      nodeId,
      label: "Edge",
    };
    return { passes: [pass] };
  },
};

/**
 * Convolve — an arbitrary 3x3 kernel (T241). TD's Convolve TOP.
 *
 * The kernel is three vec3 ROWS rather than nine scalars, so the inspector shows it as a
 * 3x3 grid — the only layout in which a kernel is readable at all. Nine separately-named
 * numbers would be identical to the compiler and unusable to a person.
 *
 * The identity kernel is the default. A Convolve you have just dropped should do nothing
 * visible until you type something into it; defaulting to a blur or an emboss would make
 * the node appear to be broken in the other direction.
 */
export const convolveNode: NodeDefinition = {
  type: "convolve",
  version: 1,
  title: "Convolve",
  category: "filter",
  description: "Applies an arbitrary 3x3 kernel. TD Convolve TOP.",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    row0: { type: "vector", size: 3, label: "Row 1", default: [0, 0, 0], description: "Top row." },
    row1: { type: "vector", size: 3, label: "Row 2", default: [0, 1, 0], description: "Middle row." },
    row2: { type: "vector", size: 3, label: "Row 3", default: [0, 0, 0], description: "Bottom row." },
    normalize: {
      type: "boolean",
      label: "Normalize",
      default: true,
      description: "Divides by the kernel sum, holding brightness. Ignored when the sum is 0.",
    },
    bias: {
      type: "number",
      label: "Bias",
      default: 0,
      min: -1,
      max: 1,
      description: "Added after. A zero-sum kernel needs ~0.5 here to show negative results.",
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
      id: `${nodeId}:convolve`,
      shader: CONVOLVE_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        texel: [1 / resolution[0], 1 / resolution[1]],
        row0: readVector(parameters, "row0", [0, 0, 0]),
        row1: readVector(parameters, "row1", [0, 1, 0]),
        row2: readVector(parameters, "row2", [0, 0, 0]),
        normalize: readFlag(parameters, "normalize", true),
        bias: readNumber(parameters, "bias", 0),
        extend: readEnumIndex(parameters, "extend", EXTEND_OPTIONS, "hold"),
      },
      nodeId,
      label: "Convolve",
    };
    return { passes: [pass] };
  },
};

export const filterNodes: readonly NodeDefinition[] = [
  blurNode,
  edgeNode,
  convolveNode,
  displaceNode,
  remapNode,
];
