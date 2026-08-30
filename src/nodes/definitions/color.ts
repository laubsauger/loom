import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { CHANNEL_OPTIONS, readEnumIndex, readNumber } from "./parameter-readers.ts";
import {
  LIMIT_FRAGMENT_WGSL,
  HSV_FRAGMENT_WGSL,
  LEVEL_FRAGMENT_WGSL,
  LOOKUP_FRAGMENT_WGSL,
  THRESHOLD_FRAGMENT_WGSL,
} from "../shaders/color.wgsl.ts";

/**
 * Colour operators: Level, HSV, Threshold, Lookup (T40).
 *
 * COLOUR SPACE (§V56/§V57) — the assumption every node here makes, stated once:
 *
 *   the input is LINEAR working-space light, and every control is applied to those linear
 *   values. Nothing decodes, nothing encodes, nothing tone-maps. Encoding happens at the
 *   output/display node and nowhere else.
 *
 * That is a behavioural claim, not a disclaimer. "Gamma 2.2" here shapes linear values; it
 * is not an sRGB encode. "Brightness 2" doubles light, which looks different from doubling
 * an 8-bit encoded value the way a compositor with an sRGB working format would. Both
 * conventions are defensible; mixing them inside one catalogue is not, so all four nodes
 * make the same one.
 *
 * WHAT THESE NODES NEED FROM THE PORT TYPE (T83, §V57): `texture2d` has no `space` field
 * yet, so these assumptions live in prose. When it lands:
 *   - Level and HSV want `space: "linear"` on both ports, and a `data` input should be a
 *     diagnostic — hue-rotating a displacement field is a mistake, not a style.
 *   - Threshold consumes colour and produces a MASK, which is `data`.
 *   - Lookup consumes `source` as `data` (an index) and `lookup` as colour, and its output
 *     carries the LOOKUP's space, not the source's. It is the one node here whose two
 *     inputs genuinely differ, which is why its format policy inherits from `lookup` while
 *     its resolution inherits from `source`.
 *
 * The "which channel drives this?" parameter is called `channel`, not `source`: `source` is
 * the reserved key that marks a node's shader text as user-authorable
 * (`SHADER_SOURCE_PARAMETER`), and reusing it — even for an enum, which today's `type ===
 * "string"` guards happen to reject — would put a landmine under a guard that has no
 * reason to stay that specific.
 */

const THRESHOLD_COMPARE_OPTIONS = [
  { value: "greater", label: "Greater Than" },
  { value: "less", label: "Less Than" },
] as const;

/**
 * Level — TD's Level TOP.
 *
 * Applied in a fixed, documented order: black/white level remap, invert, gamma, contrast
 * about mid-grey, brightness, then opacity on alpha. Alpha is otherwise untouched:
 * brightening an image must not change what it covers.
 */
export const levelNode: NodeDefinition = {
  type: "level",
  version: 1,
  title: "Level",
  category: "color",
  description:
    "Black/white level, invert, gamma, contrast, brightness and opacity, applied to linear values. TD Level TOP.",
  inputs: [
    { id: "input", label: "Input", type: RGBA_TEXTURE, description: "Linear-space colour." },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE, description: "Linear-space colour." }],
  parameters: {
    blacklevel: { type: "number", label: "Black Level", default: 0, min: -1, max: 2 },
    whitelevel: { type: "number", label: "White Level", default: 1, min: -1, max: 4 },
    invert: {
      type: "number",
      label: "Invert",
      default: 0,
      min: 0,
      max: 1,
      description: "Blends towards the inverted image, as in TD, rather than a hard switch.",
    },
    gamma1: { type: "number", label: "Gamma", default: 1, min: 0.01, max: 8 },
    contrast: { type: "number", label: "Contrast", default: 1, min: 0, max: 8 },
    brightness: { type: "number", label: "Brightness", default: 1, min: 0, max: 8 },
    opacity: {
      type: "number",
      label: "Opacity",
      default: 1,
      min: 0,
      max: 1,
      description: "Multiplies alpha only — coverage, not brightness.",
    },
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
      id: `${nodeId}:level`,
      shader: LEVEL_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        blacklevel: readNumber(parameters, "blacklevel", 0),
        whitelevel: readNumber(parameters, "whitelevel", 1),
        brightness: readNumber(parameters, "brightness", 1),
        gamma1: readNumber(parameters, "gamma1", 1),
        contrast: readNumber(parameters, "contrast", 1),
        opacity: readNumber(parameters, "opacity", 1),
        invert: readNumber(parameters, "invert", 0),
      },
      nodeId,
      label: "Level",
    };
    return { passes: [pass] };
  },
};

/**
 * HSV — TD's HSV Adjust TOP.
 *
 * Converts LINEAR RGB to HSV and back (§V56). A hue rotation here is therefore not
 * numerically identical to the same rotation performed in an encoded 8-bit working space;
 * it is consistent with every other node in this catalogue, which matters more.
 */
export const hsvNode: NodeDefinition = {
  type: "hsv",
  version: 1,
  title: "HSV",
  category: "color",
  description: "Hue offset, saturation and value, in linear RGB. TD HSV Adjust TOP.",
  inputs: [
    { id: "input", label: "Input", type: RGBA_TEXTURE, description: "Linear-space colour." },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE, description: "Linear-space colour." }],
  parameters: {
    hueoffset: { type: "number", label: "Hue Offset", default: 0, min: -180, max: 180, unit: "degrees" },
    saturation: { type: "number", label: "Saturation", default: 1, min: 0, max: 4 },
    value: { type: "number", label: "Value", default: 1, min: 0, max: 4 },
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
      id: `${nodeId}:hsv`,
      shader: HSV_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        // Degrees in the UI (TD's unit), turns in the shader (HSV's unit).
        hueoffset: readNumber(parameters, "hueoffset", 0) / 360,
        saturation: readNumber(parameters, "saturation", 1),
        value: readNumber(parameters, "value", 1),
      },
      nodeId,
      label: "HSV",
    };
    return { passes: [pass] };
  },
};

/**
 * Threshold — TD's Threshold TOP.
 *
 * Produces a MASK: the same value in rgb and alpha, so it drives Mask or composites as a
 * matte with no channel shuffling in between. The output is therefore DATA in §V56 terms
 * even though it is shaped like a colour — noted on the port and worth a `space: "data"`
 * declaration once the port type has one.
 */
export const thresholdNode: NodeDefinition = {
  type: "threshold",
  version: 1,
  title: "Threshold",
  category: "color",
  description: "Turns a channel into a soft-edged mask. TD Threshold TOP.",
  inputs: [
    { id: "input", label: "Input", type: RGBA_TEXTURE, description: "Linear-space colour." },
  ],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: RGBA_TEXTURE,
      description: "DATA: a mask, written to rgb and alpha alike.",
    },
  ],
  parameters: {
    threshold: { type: "number", label: "Threshold", default: 0.5, min: -1, max: 2 },
    softness: {
      type: "number",
      label: "Softness",
      default: 0.01,
      min: 0,
      max: 1,
      description: "Width of the transition. 0 gives a hard, aliased edge.",
    },
    channel: { type: "enum", label: "Source", default: "luminance", options: [...CHANNEL_OPTIONS] },
    compare: {
      type: "enum",
      label: "Compare",
      default: "greater",
      options: [...THRESHOLD_COMPARE_OPTIONS],
    },
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
      id: `${nodeId}:threshold`,
      shader: THRESHOLD_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        threshold: readNumber(parameters, "threshold", 0.5),
        softness: readNumber(parameters, "softness", 0.01),
        channel: readEnumIndex(parameters, "channel", CHANNEL_OPTIONS, "luminance"),
        compare: readEnumIndex(parameters, "compare", THRESHOLD_COMPARE_OPTIONS, "greater"),
      },
      nodeId,
      label: "Threshold",
    };
    return { passes: [pass] };
  },
};

/**
 * Lookup (Colorize) — TD's Lookup TOP.
 *
 * Reads one channel of `source` as a position along `lookup` and returns the colour it
 * finds there. Pair it with Ramp and it is a colouriser; pair it with a hand-built palette
 * and it is a LUT.
 *
 * The two inputs are NOT interchangeable, and the policies say so out loud:
 *   - resolution inherits `source`, because the source is the image whose shape survives;
 *   - format inherits `lookup`, because the output pixels ARE the lookup's pixels, and
 *     their colour space belongs to the palette rather than to the index.
 * That split is the most opinionated thing in this file, and it is what makes a Lookup fed
 * by an encoded palette still produce an encoded image rather than quietly claiming linear.
 *
 * `lookup` is required rather than optional: TD's Lookup TOP needs its lookup image too,
 * and a "colorize with two colour parameters" fallback would be a different node wearing
 * this one's name.
 */
export const lookupNode: NodeDefinition = {
  type: "lookup",
  version: 1,
  title: "Lookup",
  category: "color",
  description: "Remaps a channel of the source through a lookup image (pair with Ramp). TD Lookup TOP.",
  inputs: [
    {
      id: "source",
      label: "Source",
      type: RGBA_TEXTURE,
      description: "Read as DATA: one channel is an index into the lookup, never colour-converted.",
    },
    {
      id: "lookup",
      label: "Lookup",
      type: RGBA_TEXTURE,
      description: "The palette. Its colour space becomes the output's.",
    },
  ],
  outputs: [
    {
      id: "out",
      label: "Out",
      type: RGBA_TEXTURE,
      description: "Colour, in the LOOKUP input's space.",
    },
  ],
  parameters: {
    channel: { type: "enum", label: "Source", default: "luminance", options: [...CHANNEL_OPTIONS] },
    row: {
      type: "number",
      label: "Row",
      default: 0.5,
      min: 0,
      max: 1,
      description: "Which row of the lookup image to read, for a palette with several ramps.",
    },
    offset: { type: "number", label: "Offset", default: 0, min: -1, max: 1 },
    scale: { type: "number", label: "Scale", default: 1, min: -4, max: 4 },
  },
  resolutionPolicy: { kind: "inherit", input: "source" },
  formatPolicy: { kind: "inherit", input: "lookup" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["source"];
    const lookup = inputs["lookup"];
    if (target === undefined || source === undefined || lookup === undefined) {
      const what =
        target === undefined
          ? 'output port "out"'
          : source === undefined
            ? 'input port "source"'
            : 'input port "lookup"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:lookup`,
      shader: LOOKUP_FRAGMENT_WGSL,
      target,
      textures: [
        { binding: "inputTexture", resourceId: source.resource },
        { binding: "lookupTexture", resourceId: lookup.resource },
      ],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        channel: readEnumIndex(parameters, "channel", CHANNEL_OPTIONS, "luminance"),
        row: readNumber(parameters, "row", 0.5),
        offset: readNumber(parameters, "offset", 0),
        scale: readNumber(parameters, "scale", 1),
      },
      nodeId,
      label: "Lookup",
    };
    return { passes: [pass] };
  },
};

/** The colour group, in library order. */
/** How a value outside the range is dealt with. Order is the index the shader switches on. */
const LIMIT_MODE_OPTIONS = [
  { value: "clamp", label: "Clamp" },
  { value: "loop", label: "Loop" },
  { value: "zigzag", label: "Zigzag" },
  { value: "quantize", label: "Quantize" },
] as const;

/**
 * Limit — bound a value, or step it (T283). TD's Limit TOP.
 *
 * The four modes differ in what happens to the EXCESS: clamp discards it, loop wraps it,
 * zigzag reflects it, quantize keeps it in range and coarsens it. Quantize is the one people
 * arrive for without knowing its name, because stepping a colour channel is posterisation.
 *
 * Alpha is untouched: limiting coverage is a different intent from limiting colour, and
 * quantizing alpha turns a soft edge into a stair, which is never what someone posterising
 * an image asked for.
 */
export const limitNode: NodeDefinition = {
  type: "limit",
  version: 1,
  title: "Limit",
  category: "color",
  description: "Clamps, loops, zigzags or quantizes channel values. TD Limit TOP.",
  inputs: [
    { id: "input", label: "Input", type: RGBA_TEXTURE, description: "Linear-space colour." },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    mode: { type: "enum", label: "Mode", default: "clamp", options: [...LIMIT_MODE_OPTIONS] },
    low: { type: "number", label: "Minimum", default: 0, min: -4, max: 4 },
    high: { type: "number", label: "Maximum", default: 1, min: -4, max: 4 },
    steps: {
      type: "number",
      label: "Steps",
      default: 4,
      min: 2,
      max: 256,
      description: "Quantize mode only. Levels, not step size — 8 means eight of them.",
    },
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
      id: `${nodeId}:limit`,
      shader: LIMIT_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        mode: readEnumIndex(parameters, "mode", LIMIT_MODE_OPTIONS, "clamp"),
        low: readNumber(parameters, "low", 0),
        high: readNumber(parameters, "high", 1),
        steps: readNumber(parameters, "steps", 4),
      },
      nodeId,
      label: "Limit",
    };
    return { passes: [pass] };
  },
};

export const colorNodes: readonly NodeDefinition[] = [
  levelNode,
  hsvNode,
  thresholdNode,
  limitNode,
  lookupNode,
];
