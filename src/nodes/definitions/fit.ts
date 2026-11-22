import type { CompiledNodeDescription, NodeDefinition } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { ARITHMETIC_TEXTURE, RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs, type NodeCompileInputs } from "./compile-context.ts";
import {
  DEGREES_TO_RADIANS,
  TRANSFORM_ORDER_OPTIONS,
  readColor,
  readEnumIndex,
  readNumber,
  readVector,
  type Params,
} from "./parameter-readers.ts";
import { FIT_FRAGMENT_WGSL } from "../shaders/fit.wgsl.ts";

/**
 * Fit and Resolution — TD's Fit TOP and Resolution TOP (T1824b, T1825b).
 *
 * ## The output size is the Common page's, as in TouchDesigner
 *
 * Both TD operators take their output size from the Common page, and so do these: the
 * size is the node's `NodeResolutionOverride` (Use Input, Eighth … 8X, Fit Resolution,
 * Limit Resolution, Custom), resolved by the compiler at compile time (§V21, §V50) and
 * clamped to the project limit (§V24). Neither node carries width/height parameters of its
 * own: that would be a second answer to "how big is this node", beside the one every other
 * node has. What each node adds is what TD puts on its own page: Fit's placement, and the
 * filtering both use to get there.
 *
 * The defaults differ because the jobs do. A Fit puts any input into the PROJECT frame,
 * which is what dropping one on a camera or a movie is for. A Resolution halves its input
 * (TD's Half preset), so the node does something the moment it is wired.
 *
 * ## Two nodes, one pass
 *
 * Resolution is Fit at Fill: same shader, same uniforms, the placement fixed. It stays its
 * own type because it is a different thing to look for (TD has both, and the owner named
 * both), and because its default size is the input's, scaled, not the project's.
 *
 * COLOUR (§V56): both move and filter values, never transform them, so the output carries
 * the input's space and format (`formatPolicy` inherit), and the input accepts data
 * (`ARITHMETIC_TEXTURE`): a depth map or a float map stays data, at its own precision.
 */

/**
 * Colour or data. A depth map, a UV field or a Float Map In resizes as readily as a picture,
 * and nothing here converts it: the format is the input's and r32float is read unfiltered.
 */
const INPUT_DESCRIPTION = "Linear colour or numerical data; data keeps its format and meaning.";

export const FIT_MODE_OPTIONS = [
  { value: "fill", label: "Fill" },
  { value: "fithorz", label: "Fit Horizontal" },
  { value: "fitvert", label: "Fit Vertical" },
  { value: "fitbest", label: "Fit Best" },
  { value: "fitoutside", label: "Fit Outside" },
  { value: "nativeres", label: "Native Resolution" },
] as const;

const JUSTIFY_H_OPTIONS = [
  { value: "left", label: "Left" },
  { value: "center", label: "Center" },
  { value: "right", label: "Right" },
] as const;

/** TD's order, bottom first: its y runs up. */
const JUSTIFY_V_OPTIONS = [
  { value: "bottom", label: "Bottom" },
  { value: "center", label: "Center" },
  { value: "top", label: "Top" },
] as const;

/**
 * What fills the output where the placed input does not reach. The shader's codes are the
 * Extend codes every other geometry filter uses (`EXTEND_OPTIONS`: hold 0, repeat 1,
 * mirror 2) plus 3 for the background colour, which is TD's Fit behaviour and the default.
 */
const FIT_EXTEND_OPTIONS = [
  { value: "background", label: "Background Color" },
  { value: "hold", label: "Hold Edge" },
  { value: "repeat", label: "Repeat" },
  { value: "mirror", label: "Mirror" },
] as const;
const FIT_EXTEND_CODES: readonly number[] = [3, 0, 1, 2];

/** TD's Input Smoothness, with an area average where TD offers mipmaps (T1825b says why). */
export const SMOOTHING_OPTIONS = [
  { value: "nearest", label: "Nearest Pixel" },
  { value: "linear", label: "Interpolate Pixels" },
  { value: "average", label: "Average Pixels" },
] as const;

const SMOOTHING_DESCRIPTION =
  "How input pixels become output pixels. Nearest Pixel takes the one under each output pixel, exactly, with hard edges when scaling up. Interpolate Pixels blends the four nearest. Average Pixels does the same when scaling up and, when scaling down, averages every input pixel each output pixel covers, weighted by how much of it is covered (TD's High Quality Resize; up to 16 input pixels per output pixel on each axis, evenly spaced ones beyond that), so fine detail does not alias or sparkle.";

const smoothingParameter = (fallback: (typeof SMOOTHING_OPTIONS)[number]["value"]) =>
  ({
    type: "enum",
    label: "Input Smoothness",
    default: fallback,
    options: SMOOTHING_OPTIONS,
    description: SMOOTHING_DESCRIPTION,
  }) as const;

interface Placement {
  readonly fit: number;
  readonly justify: readonly [number, number];
  readonly extend: number;
  readonly background: readonly number[];
  /** T1826b — the placed image's own transform, in output fractions about its centre. */
  readonly transform: {
    readonly t: readonly number[];
    readonly s: readonly number[];
    readonly piv: readonly number[];
    readonly rot: number;
    readonly xord: number;
  };
}

/** No transform: what Resolution always is, and what a fresh Fit is. */
const IDENTITY_TRANSFORM: Placement["transform"] = { t: [0, 0], s: [1, 1], piv: [0, 0], rot: 0, xord: 0 };

function fitPass(read: NodeCompileInputs, key: string, label: string, smoothing: number, placement: Placement): CompiledNodeDescription {
  const { nodeId, outputs, inputs, resolution } = read;
  const target = outputs["out"];
  const source = inputs["input"];
  if (target === undefined || source === undefined) {
    const what = target === undefined ? 'output port "out"' : 'input port "input"';
    return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
  }
  const pass: EffectPassDescriptor = {
    kind: "effect",
    id: `${nodeId}:${key}`,
    shader: FIT_FRAGMENT_WGSL,
    target,
    // Read with textureLoad, filtered in the shader: no sampler (fit.wgsl.ts says why).
    textures: [{ binding: "inputTexture", resourceId: source.resource, sampled: "unfiltered" }],
    uniformBinding: "params",
    uniforms: {
      background: placement.background,
      targetSize: resolution,
      justify: placement.justify,
      fit: placement.fit,
      smoothing,
      extend: placement.extend,
      ...placement.transform,
    },
    nodeId,
    label,
  };
  return { passes: [pass] };
}

/** Justify as a fraction of the slack, top-down: left/top 0, centre 0.5, right/bottom 1. */
function readJustify(parameters: Params): readonly [number, number] {
  const h = readEnumIndex(parameters, "justifyh", JUSTIFY_H_OPTIONS, "center");
  const v = readEnumIndex(parameters, "justifyv", JUSTIFY_V_OPTIONS, "center");
  return [h * 0.5, 1 - v * 0.5];
}

/**
 * Fit — TD's Fit TOP: the input scaled into the output by one of TD's six Fit modes, placed
 * by Justify, the rest filled by the background colour (or an Extend mode).
 *
 * Fit Best keeps all of the input (letterbox or pillarbox), Fit Outside covers all of the
 * output (cropping the overhang), Fit Horizontal / Fit Vertical match one axis, Fill
 * stretches, Native Resolution places the input pixel for pixel, on whole pixels.
 *
 * T1826b — and TD's Fit page Transform: Translate, Rotate, Scale, Pivot and Transform Order
 * move the PLACED image before the crop and the background, so a Fit Outside can be panned
 * across what it would otherwise crop. Same names and signs as Loom's Transform node
 * (`fit.wgsl.ts` says why that is exact). TD's Translate Unit / Pivot Unit menus are not
 * here: Loom's Transform has neither, and both nodes take fractions of the image.
 */
export const fitNode: NodeDefinition = {
  type: "fit",
  version: 1,
  title: "Fit",
  category: "filter",
  description:
    "Places the input into an output of another size and shape, keeping its aspect by a Fit mode: whole and letterboxed, covering and cropped, matched on one axis, stretched, or pixel for pixel. The output size is the Common Resolution, the project's by default.",
  tags: ["resize", "aspect", "letterbox", "pillarbox", "contain", "cover", "scale", "resolution"],
  inputs: [{ id: "input", label: "Input", type: ARITHMETIC_TEXTURE, description: INPUT_DESCRIPTION }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    fit: {
      type: "enum",
      label: "Fit",
      default: "fitbest",
      options: FIT_MODE_OPTIONS,
      description:
        "Fill stretches the input to the output. Fit Horizontal and Fit Vertical scale it evenly until its width, or its height, matches. Fit Best scales it evenly until all of it fits, leaving bars. Fit Outside scales it evenly until it covers the output, cropping the overhang. Native Resolution does not scale it: one input pixel is one output pixel.",
    },
    justifyh: {
      type: "enum",
      label: "Justify Horizontal",
      default: "center",
      options: JUSTIFY_H_OPTIONS,
      description: "Where the input sits across the output when the two widths differ.",
    },
    justifyv: {
      type: "enum",
      label: "Justify Vertical",
      default: "center",
      options: JUSTIFY_V_OPTIONS,
      description: "Where the input sits up and down the output when the two heights differ.",
    },
    extend: {
      type: "enum",
      label: "Extend",
      default: "background",
      options: FIT_EXTEND_OPTIONS,
      description:
        "What fills the output where the input does not reach: the Background Color, or the input itself continued past its edges (held, repeated or mirrored).",
    },
    bgcolor: {
      type: "color",
      label: "Background Color",
      default: [0, 0, 0, 0],
      space: "display",
      description: "Fills the output where the input does not reach, when Extend is Background Color. Transparent by default.",
    },
    smoothing: smoothingParameter("linear"),
    xord: {
      type: "enum",
      label: "Transform Order",
      group: "Transform",
      default: "srt",
      options: [...TRANSFORM_ORDER_OPTIONS],
      description: "The order Scale, Rotate and Translate apply to the placed image, as on the Transform node.",
    },
    t: {
      type: "vector",
      size: 2,
      label: "Translate",
      group: "Transform",
      default: [0, 0],
      min: -4,
      max: 4,
      range: "soft",
      description:
        "Moves the placed image, in fractions of the output: 0.5 is half its width (or height). Applied before the crop, so a Fit Outside slides to show what it would crop.",
    },
    r: {
      type: "number",
      label: "Rotate",
      group: "Transform",
      default: 0,
      min: -360,
      max: 360,
      range: "cyclic",
      unit: "degrees",
      description: "Turns the placed image about the Pivot. Output pixels are square, so nothing shears.",
    },
    s: {
      type: "vector",
      size: 2,
      label: "Scale",
      group: "Transform",
      default: [1, 1],
      min: -8,
      max: 8,
      range: "soft",
      description: "Scales the placed image about the Pivot, on top of the Fit mode's own scale. Negative flips it.",
    },
    p: {
      type: "vector",
      size: 2,
      label: "Pivot",
      group: "Transform",
      default: [0, 0],
      min: -2,
      max: 2,
      range: "soft",
      description: "The point Rotate and Scale turn about, in fractions of the output from its centre: [0.5, 0.5] is a corner.",
    },
  },
  resolutionPolicy: { kind: "project" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const read = readCompileInputs(context);
    const { parameters } = read;
    const extend = FIT_EXTEND_CODES[readEnumIndex(parameters, "extend", FIT_EXTEND_OPTIONS, "background")] ?? 3;
    return fitPass(read, "fit", "Fit", readEnumIndex(parameters, "smoothing", SMOOTHING_OPTIONS, "linear"), {
      fit: readEnumIndex(parameters, "fit", FIT_MODE_OPTIONS, "fitbest"),
      justify: readJustify(parameters),
      extend,
      background: readColor(parameters, "bgcolor", [0, 0, 0, 0]),
      transform: {
        t: readVector(parameters, "t", [0, 0]),
        s: readVector(parameters, "s", [1, 1]),
        piv: readVector(parameters, "p", [0, 0]),
        rot: readNumber(parameters, "r", 0) * DEGREES_TO_RADIANS,
        xord: readEnumIndex(parameters, "xord", TRANSFORM_ORDER_OPTIONS, "srt"),
      },
    });
  },
};

const FILL = FIT_MODE_OPTIONS.findIndex((option) => option.value === "fill");

/**
 * Resolution — TD's Resolution TOP: the input resampled to the Common Resolution, which
 * defaults to half the input. Fill, so the whole input reaches every edge; nothing is
 * uncovered, and the edge taps hold.
 */
export const resolutionNode: NodeDefinition = {
  type: "resolution",
  version: 1,
  title: "Resolution",
  category: "filter",
  description:
    "Resamples the input to another resolution, set in Common (Eighth to 8X, Fit, Limit or Custom); half the input by default. Choose how pixels are filtered on the way.",
  tags: ["resize", "scale", "downsample", "upsample", "resample", "half", "pixelate"],
  inputs: [{ id: "input", label: "Input", type: ARITHMETIC_TEXTURE, description: INPUT_DESCRIPTION }],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    smoothing: smoothingParameter("average"),
  },
  resolutionPolicy: { kind: "scale", input: "input", factor: 0.5 },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const read = readCompileInputs(context);
    return fitPass(read, "resolution", "Resolution", readEnumIndex(read.parameters, "smoothing", SMOOTHING_OPTIONS, "average"), {
      fit: FILL,
      justify: [0, 0],
      extend: 0,
      background: [0, 0, 0, 0],
      transform: IDENTITY_TRANSFORM,
    });
  },
};

export const fitNodes: readonly NodeDefinition[] = [fitNode, resolutionNode];
