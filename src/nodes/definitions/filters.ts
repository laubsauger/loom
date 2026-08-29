import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { scratchResourceId } from "../../compiler/resources.ts";
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

/** The neighbourhood-filter group, in library order. */
export const filterNodes: readonly NodeDefinition[] = [blurNode, displaceNode];
