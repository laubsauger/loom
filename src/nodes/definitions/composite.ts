import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { CHANNEL_OPTIONS, readEnumIndex, readNumber } from "./parameter-readers.ts";
import {
  ADD_FRAGMENT_WGSL,
  DIFFERENCE_FRAGMENT_WGSL,
  MASK_FRAGMENT_WGSL,
  MULTIPLY_FRAGMENT_WGSL,
  OVER_FRAGMENT_WGSL,
  SCREEN_FRAGMENT_WGSL,
} from "../shaders/composite.wgsl.ts";

/**
 * Compositing: Over, Add, Multiply, Screen, Difference, and Mask (T40).
 *
 * INPUT ORDER follows TD: input 1 goes OVER input 2. `in1` is the front/foreground layer,
 * `in2` the back. The ports are labelled that way so the wiring is not a coin flip, and
 * every node in the family uses the same order — including the arithmetic ones, where it
 * only matters for Difference (and for `opacity`, which always scales the front).
 *
 * ALPHA is straight (non-premultiplied) throughout, matching TD, whose separate Premultiply
 * TOP only makes sense if the default is not premultiplied. Over does coverage-aware
 * source-over; the arithmetic operators work per channel across RGBA, as TD's Composite
 * TOP does, so adding two images adds their alpha too.
 *
 * COLOUR (§V56): every operator combines LINEAR working-space values. Both inputs are
 * assumed to be in the SAME space — the compiler already warns when a node mixes an
 * encoded input with a linear one, and this family is the main place that warning fires.
 * Resolution and format inherit `in1`, the primary input: a composite has to pick one, and
 * the front layer is the one the user is placing.
 */

const BLEND_SHADERS = {
  over: OVER_FRAGMENT_WGSL,
  add: ADD_FRAGMENT_WGSL,
  multiply: MULTIPLY_FRAGMENT_WGSL,
  screen: SCREEN_FRAGMENT_WGSL,
  difference: DIFFERENCE_FRAGMENT_WGSL,
} as const;

type BlendType = keyof typeof BLEND_SHADERS;

/**
 * Builds one two-input blend node.
 *
 * Five node definitions from one factory rather than five near-identical files: they share
 * their ports, their policies, their alpha convention and their `opacity` parameter, and
 * differ only in which shader they name. Each is still a separate `NodeDefinition` with its
 * own type string, title and shader text — nothing is decided at runtime.
 */
function blendNode(type: BlendType, title: string, description: string): NodeDefinition {
  return {
    type,
    version: 1,
    title,
    category: "composite",
    description,
    inputs: [
      {
        id: "in1",
        label: "Front",
        type: RGBA_TEXTURE,
        description: "Placed over input 2. Resolution and format come from here.",
      },
      { id: "in2", label: "Back", type: RGBA_TEXTURE, description: "The layer underneath." },
    ],
    outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
    parameters: {
      opacity: {
        type: "number",
        label: "Opacity",
        default: 1,
        min: 0,
        max: 1,
        description: "Scales the front layer before the operation.",
      },
    },
    resolutionPolicy: { kind: "inherit", input: "in1" },
    formatPolicy: { kind: "inherit", input: "in1" },
    compile(context): CompiledNodeDescription {
      const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
      const target = outputs["out"];
      const front = inputs["in1"];
      const back = inputs["in2"];
      if (target === undefined || front === undefined || back === undefined) {
        const what =
          target === undefined
            ? 'output port "out"'
            : front === undefined
              ? 'input port "in1"'
              : 'input port "in2"';
        return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
      }
      const pass: EffectPassDescriptor = {
        kind: "effect",
        id: `${nodeId}:${type}`,
        shader: BLEND_SHADERS[type],
        target,
        textures: [
          { binding: "frontTexture", resourceId: front.resource },
          { binding: "backTexture", resourceId: back.resource },
        ],
        samplers: [{ binding: "inputSampler", resourceId: front.sampler }],
        uniformBinding: "params",
        uniforms: { opacity: readNumber(parameters, "opacity", 1) },
        nodeId,
        label: title,
      };
      return { passes: [pass] };
    },
  };
}

export const overNode = blendNode(
  "over",
  "Over",
  "Composites input 1 over input 2 using its alpha. TD Over TOP.",
);
export const addNode = blendNode("add", "Add", "Adds the two inputs channel by channel. TD Add TOP.");
export const multiplyNode = blendNode(
  "multiply",
  "Multiply",
  "Multiplies the two inputs channel by channel. TD Multiply TOP.",
);
export const screenNode = blendNode(
  "screen",
  "Screen",
  "Inverse-multiplies the two inputs: 1 - (1-a)(1-b). TD Composite TOP, screen operation.",
);
export const differenceNode = blendNode(
  "difference",
  "Difference",
  "Absolute difference between the two inputs. TD Composite TOP, difference operation.",
);

/**
 * Mask — multiply an image's coverage by a mask.
 *
 * COLOUR (§V56/§V57): `mask` is DATA — a coverage value, not light. One of its channels
 * multiplies the source's ALPHA and nothing else, which is what masking means under a
 * straight-alpha convention and keeps the colour valid where coverage is partial. When
 * `texture2d.space` lands, `mask` wants `space: "data"` while `input` stays colour.
 *
 * TD's nearest equivalent is the Matte TOP; the name here follows the brief's vocabulary.
 */
export const maskNode: NodeDefinition = {
  type: "mask",
  version: 1,
  title: "Mask",
  category: "composite",
  description: "Multiplies the source's alpha by a channel of the mask input. TD Matte TOP.",
  inputs: [
    { id: "input", label: "Input", type: RGBA_TEXTURE, description: "The image being masked." },
    {
      id: "mask",
      label: "Mask",
      type: RGBA_TEXTURE,
      description: "DATA, not colour: coverage. Never colour-convert this (§V56).",
    },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    channel: {
      type: "enum",
      label: "Mask Source",
      default: "luminance",
      options: [...CHANNEL_OPTIONS],
    },
    invert: { type: "number", label: "Invert", default: 0, min: 0, max: 1 },
  },
  resolutionPolicy: { kind: "inherit", input: "input" },
  formatPolicy: { kind: "inherit", input: "input" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const source = inputs["input"];
    const mask = inputs["mask"];
    if (target === undefined || source === undefined || mask === undefined) {
      const what =
        target === undefined
          ? 'output port "out"'
          : source === undefined
            ? 'input port "input"'
            : 'input port "mask"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:mask`,
      shader: MASK_FRAGMENT_WGSL,
      target,
      textures: [
        { binding: "inputTexture", resourceId: source.resource },
        { binding: "maskTexture", resourceId: mask.resource },
      ],
      samplers: [{ binding: "inputSampler", resourceId: source.sampler }],
      uniformBinding: "params",
      uniforms: {
        channel: readEnumIndex(parameters, "channel", CHANNEL_OPTIONS, "luminance"),
        invert: readNumber(parameters, "invert", 0),
      },
      nodeId,
      label: "Mask",
    };
    return { passes: [pass] };
  },
};

/** The compositing group, in library order. */
export const compositeNodes: readonly NodeDefinition[] = [
  overNode,
  addNode,
  multiplyNode,
  screenNode,
  differenceNode,
  maskNode,
];
