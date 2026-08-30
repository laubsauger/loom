import type { NodeDefinition, CompiledNodeDescription } from "../../domain/types/node-definition.ts";
import type { EffectPassDescriptor } from "../../runtime/backend/plan.ts";
import { RGBA_TEXTURE } from "./common-ports.ts";
import { missingCompileResource, readCompileInputs } from "./compile-context.ts";
import { CHANNEL_OPTIONS, readEnumIndex, readNumber } from "./parameter-readers.ts";
import {
  ADD_FRAGMENT_WGSL,
  ATOP_FRAGMENT_WGSL,
  CROSS_FRAGMENT_WGSL,
  INSIDE_FRAGMENT_WGSL,
  OUTSIDE_FRAGMENT_WGSL,
  UNDER_FRAGMENT_WGSL,
  XOR_FRAGMENT_WGSL,
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
 * ALPHA is straight (non-premultiplied) throughout, matching TD. (An earlier note here
 * justified that by "TD's separate Premultiply TOP"; a catalogue survey of all 149 TOPs
 * found no such operator — TD exposes premultiply/unpremultiply as Math TOP operations,
 * "Multiply RGB by Alpha" and "Divide RGB by Alpha". The convention is still right; the
 * evidence cited for it was not. Ours is the Premultiply node, T281.) Over does coverage-aware
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
  under: UNDER_FRAGMENT_WGSL,
  inside: INSIDE_FRAGMENT_WGSL,
  outside: OUTSIDE_FRAGMENT_WGSL,
  atop: ATOP_FRAGMENT_WGSL,
  xor: XOR_FRAGMENT_WGSL,
  add: ADD_FRAGMENT_WGSL,
  multiply: MULTIPLY_FRAGMENT_WGSL,
  screen: SCREEN_FRAGMENT_WGSL,
  difference: DIFFERENCE_FRAGMENT_WGSL,
} as const;

type BlendType = keyof typeof BLEND_SHADERS;

/**
 * The operation menu for the Composite node. Order is presentation only — the shader is
 * chosen by NAME, so reordering this list cannot silently repoint an existing project at a
 * different blend the way an index-based enum would.
 */
const BLEND_OPTIONS = [
  { value: "over", label: "Over" },
  { value: "under", label: "Under" },
  { value: "inside", label: "Inside" },
  { value: "outside", label: "Outside" },
  { value: "atop", label: "Atop" },
  { value: "xor", label: "Xor" },
  { value: "add", label: "Add" },
  { value: "multiply", label: "Multiply" },
  { value: "screen", label: "Screen" },
  { value: "difference", label: "Difference" },
] as const;

/*
 * The Porter-Duff operators (T282) are MENU-ONLY: no `under` node, no `atop` node.
 *
 * The named nodes exist because a graph reading `Multiply` says what it does at a glance,
 * and that argument only holds for operations people recognise on sight. "Xor" and
 * "Outside" are not in that category — someone reaching for them already knows they want a
 * compositing algebra and is choosing deliberately, which is what the menu is for. Adding
 * six more nodes to the library would cost every user browsing time to serve the few who
 * want them.
 */

function readBlend(params: Record<string, unknown>, fallback: BlendType): BlendType {
  const value = params["operation"];
  return typeof value === "string" && value in BLEND_SHADERS ? (value as BlendType) : fallback;
}

/**
 * Builds one two-input blend node — either with its operation fixed, or with the operation
 * chosen by a parameter (§T232).
 *
 * WHY BOTH EXIST, since TD ships both and the reasons differ. The named nodes are for
 * READABILITY: a graph reading `Multiply` says what it does at a glance, where `Composite`
 * makes you open it. When you know the operation, the named node is better documentation
 * than a parameter. `Composite` is for FLEXIBILITY: change the blend without rewiring, and
 * drive the operation by expression (§V107), which no fixed node can do.
 *
 * §V140 is what makes shipping both safe: there is ONE implementation of the blend maths.
 * `BLEND_SHADERS` is the single source; a named node binds a fixed key and Composite reads
 * one from a parameter. Two copies would mean Over-inside-Composite and the Over node
 * drifting apart, with only one of them getting the next bug fix.
 */
function blendNode(
  type: string,
  title: string,
  description: string,
  /** `null` = the node's `operation` parameter chooses (Composite). */
  fixed: BlendType | null,
): NodeDefinition {
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
      ...(fixed === null
        ? {
            operation: {
              // §V141: this selects the SHADER, so it recompiles rather than branching per
              // pixel on a value that changes approximately never. Leaving it a uniform
              // would also quietly weaken §V5 — the uniform-only fast path only means
              // anything while structural changes are classified as structural.
              type: "enum" as const,
              label: "Operation",
              default: "over",
              options: [...BLEND_OPTIONS],
              compileTime: true,
              description: "Which blend to apply. Same maths as the named nodes (§V140).",
            },
          }
        : {}),
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
      // The pass id carries the operation so that changing it produces a different
      // structure key: a Composite switched from Over to Add is new contents, never a
      // carry-over of the old picture.
      const blend = fixed ?? readBlend(parameters, "over");
      const pass: EffectPassDescriptor = {
        kind: "effect",
        id: `${nodeId}:${blend}`,
        shader: BLEND_SHADERS[blend],
        target,
        textures: [
          { binding: "frontTexture", resourceId: front.resource },
          { binding: "backTexture", resourceId: back.resource },
        ],
        samplers: [{ binding: "inputSampler", resourceId: front.sampler }],
        uniformBinding: "params",
        uniforms: { opacity: readNumber(parameters, "opacity", 1) },
        nodeId,
        label: fixed === null ? `${title} (${blend})` : title,
      };
      return { passes: [pass] };
    },
  };
}

export const overNode = blendNode(
  "over",
  "Over",
  "Composites input 1 over input 2 using its alpha. TD Over TOP.",
  "over",
);
export const addNode = blendNode(
  "add",
  "Add",
  "Adds the two inputs channel by channel. TD Add TOP.",
  "add",
);
export const multiplyNode = blendNode(
  "multiply",
  "Multiply",
  "Multiplies the two inputs channel by channel. TD Multiply TOP.",
  "multiply",
);
export const screenNode = blendNode(
  "screen",
  "Screen",
  "Inverse-multiplies the two inputs: 1 - (1-a)(1-b). TD Composite TOP, screen operation.",
  "screen",
);
export const differenceNode = blendNode(
  "difference",
  "Difference",
  "Absolute difference between the two inputs. TD Composite TOP, difference operation.",
  "difference",
);

/** TD Composite TOP: the same blends, chosen by a parameter instead of by node type. */
export const compositeNode = blendNode(
  "composite",
  "Composite",
  "Blends two inputs with a selectable operation. TD Composite TOP.",
  null,
);

/**
 * Cross — dissolve between two inputs (T234). TD's Cross TOP.
 *
 * Not an entry in Composite's operation menu, deliberately. Every operation in that menu is
 * a fixed function of two pixels; Cross is a function of two pixels AND a factor, and the
 * factor is the whole point — it is what you drive to dissolve one chain into another. In
 * the menu it would need a control none of its neighbours have, and the control would be
 * the reason you picked it.
 *
 * Resolution and format inherit `in1` like the rest of the family, so a Cross does not
 * change size halfway through a dissolve.
 */
export const crossNode: NodeDefinition = {
  type: "cross",
  version: 1,
  title: "Cross",
  category: "composite",
  description: "Dissolves between two inputs by a factor. TD Cross TOP.",
  inputs: [
    {
      id: "in1",
      label: "Input 1",
      type: RGBA_TEXTURE,
      description: "Shown at Cross 0. Resolution and format come from here.",
    },
    { id: "in2", label: "Input 2", type: RGBA_TEXTURE, description: "Shown at Cross 1." },
  ],
  outputs: [{ id: "out", label: "Out", type: RGBA_TEXTURE }],
  parameters: {
    cross: {
      type: "number",
      label: "Cross",
      default: 0.5,
      min: 0,
      max: 1,
      description: "0 is input 1, 1 is input 2. Drive this to dissolve.",
    },
  },
  resolutionPolicy: { kind: "inherit", input: "in1" },
  formatPolicy: { kind: "inherit", input: "in1" },
  compile(context): CompiledNodeDescription {
    const { nodeId, outputs, inputs, parameters } = readCompileInputs(context);
    const target = outputs["out"];
    const first = inputs["in1"];
    const second = inputs["in2"];
    if (target === undefined || first === undefined || second === undefined) {
      const what =
        target === undefined
          ? 'output port "out"'
          : first === undefined
            ? 'input port "in1"'
            : 'input port "in2"';
      return { passes: [], diagnostics: [missingCompileResource(nodeId, what)] };
    }
    const pass: EffectPassDescriptor = {
      kind: "effect",
      id: `${nodeId}:cross`,
      shader: CROSS_FRAGMENT_WGSL,
      target,
      textures: [
        { binding: "frontTexture", resourceId: first.resource },
        { binding: "backTexture", resourceId: second.resource },
      ],
      samplers: [{ binding: "inputSampler", resourceId: first.sampler }],
      uniformBinding: "params",
      uniforms: { cross: readNumber(parameters, "cross", 0.5) },
      nodeId,
      label: "Cross",
    };
    return { passes: [pass] };
  },
};

/**
 * Mask — multiply an image's coverage by a mask.
 *
 * COLOUR (§V56/§V57): `mask` is DATA — a coverage value, not light. One of its channels
 * multiplies the source's ALPHA and nothing else, which is what masking means under a
 * straight-alpha convention and keeps the colour valid where coverage is partial. When
 * `texture2d.space` lands, `mask` wants `space: "data"` while `input` stays colour.
 *
 * TD's nearest equivalent is the Matte TOP, but it is NOT the same operator — TD's Matte
 * is a three-input over-with-matte, where this is a two-input alpha multiply. Called Mask
 * because that is what it does and what the brief calls it.
 */
export const maskNode: NodeDefinition = {
  type: "mask",
  version: 1,
  title: "Mask",
  category: "composite",
  description: "Multiplies the source's alpha by a channel of the mask input.",
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
  compositeNode,
  crossNode,
  overNode,
  addNode,
  multiplyNode,
  screenNode,
  differenceNode,
  maskNode,
];
