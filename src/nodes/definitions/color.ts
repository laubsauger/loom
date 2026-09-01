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
  PREMULTIPLY_FRAGMENT_WGSL,
  REORDER_FRAGMENT_WGSL,
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
 * WHAT THESE NODES GOT FROM THE PORT TYPE (T83 landed the field; T768 moved the family):
 *   - Level and HSV stay unannotated (= linear, §V57). Their protection arrived from the
 *     OTHER side: a declared-data OUTPUT (uv, render.depth) now refuses to connect into
 *     them at all (§V13/§V57c) — hue-rotating a displacement field is refused at the
 *     wire, not diagnosed after.
 *   - Threshold's note asked for a `data` output and the wish DISSOLVED rather than
 *     landed (T768): a threshold matte is ALSO a visible b/w image people composite and
 *     view directly, and a data output would refuse both of those uses. It stays linear
 *     and still feeds mask.mask, because a data INPUT accepts any source (§V57c).
 *   - Lookup's `lookup` input is GENUINELY COLOUR — its texels ARE the output colours —
 *     so it deliberately stays out of the data family. The data-shaped thing in Lookup
 *     is the source CHANNEL used as index, which is a parameter, not a port. Its format
 *     policy inherits from `lookup` while its resolution inherits from `source`, the one
 *     node here whose two inputs genuinely differ.
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
    blacklevel: { type: "number", label: "Black Level", default: 0, min: -1, max: 2, range: "soft" },
    whitelevel: { type: "number", label: "White Level", default: 1, min: -1, max: 4, range: "soft" },
    invert: {
      type: "number",
      label: "Invert",
      default: 0,
      min: 0,
      max: 1,
      range: "bounded",
      description: "Blends towards the inverted image, as in TD, rather than a hard switch.",
    },
    gamma1: { type: "number", label: "Gamma", default: 1, min: 0.01, max: 8, range: "floor" },
    contrast: { type: "number", label: "Contrast", default: 1, min: 0, max: 8, range: "floor" },
    brightness: { type: "number", label: "Brightness", default: 1, min: 0, max: 8, range: "floor" },
    opacity: {
      type: "number",
      label: "Opacity",
      default: 1,
      min: 0,
      max: 1,
      range: "bounded",
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
    hueoffset: { type: "number", label: "Hue Offset", default: 0, min: -180, max: 180, range: "cyclic", unit: "degrees" },
    saturation: { type: "number", label: "Saturation", default: 1, min: 0, max: 4, range: "floor" },
    value: { type: "number", label: "Value", default: 1, min: 0, max: 4, range: "floor" },
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
 * matte with no channel shuffling in between. The output is DATA in §V56 terms even
 * though it is shaped like a colour — but T768 deliberately did NOT declare it
 * `space: "data"`: a threshold matte is dual-use, equally a visible b/w image that gets
 * composited and viewed directly, and a data declaration would refuse those wirings
 * (§V13). Under §V57c it feeds mask.mask unconverted anyway, so the declaration would
 * buy nothing and cost the picture use.
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
    threshold: { type: "number", label: "Threshold", default: 0.5, min: -1, max: 2, range: "soft" },
    softness: {
      type: "number",
      label: "Softness",
      default: 0.01,
      min: 0,
      max: 1,
      range: "bounded",
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
      range: "bounded",
      description: "Which row of the lookup image to read, for a palette with several ramps.",
    },
    offset: { type: "number", label: "Offset", default: 0, min: -1, max: 1, range: "soft" },
    scale: { type: "number", label: "Scale", default: 1, min: -4, max: 4, range: "soft" },
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
    low: { type: "number", label: "Minimum", default: 0, min: -4, max: 4, range: "soft" },
    high: { type: "number", label: "Maximum", default: 1, min: -4, max: 4, range: "soft" },
    steps: {
      type: "number",
      label: "Steps",
      default: 4,
      min: 2,
      max: 256,
      range: "bounded",
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

/**
 * Where each output channel's value comes from. Index order is load-bearing: it is what
 * `reorderPick()` in `color.wgsl.ts` switches on, so the two are edited together.
 *
 * One flat list rather than TD's pair of menus (Output Red picks an input, Output Red
 * Channel picks the channel). Four fewer menus for the same information, a channel move in
 * one click, and "one"/"zero" become ordinary entries instead of special cases living in
 * the input menu. Luminance is per input because with two images wired in, "luminance"
 * alone does not name an image.
 */
export const REORDER_SOURCE_OPTIONS = [
  { value: "in1r", label: "Input 1 Red" },
  { value: "in1g", label: "Input 1 Green" },
  { value: "in1b", label: "Input 1 Blue" },
  { value: "in1a", label: "Input 1 Alpha" },
  { value: "in1lum", label: "Input 1 Luminance" },
  { value: "in2r", label: "Input 2 Red" },
  { value: "in2g", label: "Input 2 Green" },
  { value: "in2b", label: "Input 2 Blue" },
  { value: "in2a", label: "Input 2 Alpha" },
  { value: "in2lum", label: "Input 2 Luminance" },
  { value: "one", label: "One" },
  { value: "zero", label: "Zero" },
] as const;

/**
 * Reorder — a two-input channel shuffle (T280). TD's Reorder TOP.
 *
 * A CAPABILITY GAP, not a convenience: nothing in the catalogue could move a value from
 * one channel to another. Level and HSV adjust channels in place, Mask reads one and writes
 * alpha, Threshold writes the same number everywhere. Putting a mask into red, dropping a
 * broken alpha, making an opaque image out of a transparent one, or assembling three
 * separate masks into one RGB image all needed a Custom WGSL node until now — and Slope's
 * normal-map output (T284) is only usable downstream because this exists.
 *
 * The default is the IDENTITY (in1 r,g,b,a straight through). A Reorder you have just
 * dropped in must not change the picture, for the same reason Convolve defaults to the
 * identity kernel: a node that alters the image before you have touched it reads as broken.
 *
 * INPUT 2 IS OPTIONAL, and with nothing wired to it its selectors read input 1. The
 * single-image swizzle is the common case by a wide margin, and requiring a second wire to
 * do it — or refusing to compile until one exists — would tax every use for the sake of the
 * rarer one. A texture binding cannot be left empty, so the alternative was not "no second
 * texture" but "a second texture of something else".
 *
 * COLOUR (§V56): this moves NUMBERS between slots. No curve, no matrix, so it cannot change
 * the space its inputs are in — but it does change what the values mean, which is the point:
 * alpha routed into rgb is coverage being LOOKED at, not light.
 */
export const reorderNode: NodeDefinition = {
  type: "reorder",
  version: 1,
  title: "Reorder",
  category: "color",
  description:
    "Builds each output channel from any channel of either input, or from one or zero. TD Reorder TOP.",
  inputs: [
    {
      id: "in1",
      label: "Input 1",
      type: RGBA_TEXTURE,
      description: "Resolution and format come from here.",
    },
    {
      id: "in2",
      label: "Input 2",
      type: RGBA_TEXTURE,
      optional: true,
      description: "Optional. With nothing wired here, its selectors read input 1.",
    },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    outr: {
      type: "enum",
      label: "Output Red",
      default: "in1r",
      options: [...REORDER_SOURCE_OPTIONS],
    },
    outg: {
      type: "enum",
      label: "Output Green",
      default: "in1g",
      options: [...REORDER_SOURCE_OPTIONS],
    },
    outb: {
      type: "enum",
      label: "Output Blue",
      default: "in1b",
      options: [...REORDER_SOURCE_OPTIONS],
    },
    outa: {
      type: "enum",
      label: "Output Alpha",
      default: "in1a",
      options: [...REORDER_SOURCE_OPTIONS],
    },
  },
  resolutionPolicy: { kind: "inherit", input: "in1" },
  formatPolicy: { kind: "inherit", input: "in1" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const first = inputs["in1"];
    if (target === undefined || first === undefined) {
      const what = target === undefined ? 'output port "out"' : 'input port "in1"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    // Optional port, so the fallback is input 1's own texture rather than a bind that
    // cannot exist. Stated on the port, and asserted in the tests.
    const second = inputs["in2"] ?? first;
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:reorder`,
      shader: REORDER_FRAGMENT_WGSL,
      target,
      textures: [
        { binding: "inputTexture", resourceId: first.resource },
        { binding: "input2Texture", resourceId: second.resource },
      ],
      samplers: [{ binding: "inputSampler", resourceId: first.sampler }],
      uniformBinding: "params",
      uniforms: {
        outr: readEnumIndex(parameters, "outr", REORDER_SOURCE_OPTIONS, "in1r"),
        outg: readEnumIndex(parameters, "outg", REORDER_SOURCE_OPTIONS, "in1g"),
        outb: readEnumIndex(parameters, "outb", REORDER_SOURCE_OPTIONS, "in1b"),
        outa: readEnumIndex(parameters, "outa", REORDER_SOURCE_OPTIONS, "in1a"),
      },
      nodeId,
      label: "Reorder",
    };
    return { passes: [pass] };
  },
};

/** Which way the conversion runs. Index order is what the shader branches on. */
const PREMULTIPLY_MODE_OPTIONS = [
  { value: "premultiply", label: "Premultiply (RGB x Alpha)" },
  { value: "unpremultiply", label: "Unpremultiply (RGB / Alpha)" },
] as const;

/**
 * Premultiply — convert between straight and premultiplied alpha (T281).
 *
 * WHY IT EXISTS. The catalogue is straight-alpha everywhere (§V56), which is the right
 * default and has one sharp edge: every neighbourhood filter breaks on it. Blur a white
 * cutout on a transparent field and the kernel averages in the colour of pixels that are
 * not there, so the shape grows a halo. We took TD's straight-alpha convention without
 * taking its escape hatch, and until now nothing in the catalogue could fix the result.
 * The fix is a sandwich: Premultiply -> Blur -> Unpremultiply.
 *
 * WHERE IT LIVES, and why it is a node here rather than a mode somewhere. TD hangs these
 * off its Math TOP (verified: the Math TOP's Operation menu carries "Multiply RGB by
 * Alpha" and "Divide RGB by Alpha"). We have no Math TOP, and the nearest thing — Level —
 * is a grade node whose whole predictability rests on the rule that colour is light, alpha
 * is coverage, and the two never mix; its `opacity` touches alpha and nothing else. This
 * operation exists precisely to VIOLATE that separation, deliberately, for the length of a
 * filter sandwich. Hiding it inside the node whose contract it contradicts would make both
 * harder to reason about, so it is its own node, named for the word people search for.
 *
 * It is one node with two modes rather than two nodes because the two are inverses used in
 * pairs: seeing both ends of the sandwich named by the same node is what makes an
 * unbalanced one obvious in a graph.
 */
export const premultiplyNode: NodeDefinition = {
  type: "premultiply",
  version: 1,
  title: "Premultiply",
  category: "color",
  description:
    "Multiplies RGB by alpha, or divides it back out. Wrap a blur in the pair to stop a cutout haloing.",
  inputs: [{ id: "input", label: "Input", type: RGBA_TEXTURE }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    mode: {
      type: "enum",
      label: "Mode",
      default: "premultiply",
      options: [...PREMULTIPLY_MODE_OPTIONS],
      description: "Premultiply on the way into a filter, unpremultiply on the way out.",
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
      id: `${nodeId}:premultiply`,
      shader: PREMULTIPLY_FRAGMENT_WGSL,
      target,
      textures: [{ binding: "inputTexture", resourceId: source.resource }],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        mode: readEnumIndex(parameters, "mode", PREMULTIPLY_MODE_OPTIONS, "premultiply"),
      },
      nodeId,
      label: "Premultiply",
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
  reorderNode,
  premultiplyNode,
];
